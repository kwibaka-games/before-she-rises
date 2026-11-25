import { randomInt, randomUUID } from 'node:crypto';
import type {
  GameToPlatform,
  PlatformToGame,
  Seat,
} from '../../protocol/protocol.js';
import {
  CARD_DEFS,
  PRESERVATION_THRESHOLD,
  createDeck,
  deckSize,
  isSupportedPlayerCount,
  preservationThreshold,
  startingHandSize,
  toCardView,
  validateDeckKeys,
  type Card,
  type CardKey,
  type CardView,
} from './cards.js';
import { settleGame, type SettlementResult } from './settle.js';
import type {
  IceAction,
  IceActionResult,
  IceMode,
  IcePendingView,
  IcePlayerView,
  IceResultView,
  IceView,
} from './types.js';

const LOG_LIMIT = 160;
/** Every decision (turn action or pending choice) is auto-played after 20s. */
const DEFAULT_DECISION_TIMEOUT_MS = 20_000;

interface PlayerState {
  userId: string;
  name: string;
  seat: number;
  hand: Card[];
  accusations: Card[];
  /** Face-up cards in front of the player (currently only 【感染者】). */
  front: Card[];
  connected: boolean;
}

type Pending =
  | {
      kind: 'choose-card';
      choiceId: string;
      label: string;
      actorId: string;
      purpose: 'health' | 'infection' | 'homebody-preserve';
      from: 'discard' | 'preservation';
    }
  | {
      kind: 'choose-hand-card';
      choiceId: string;
      label: string;
      actorId: string;
      purpose: 'ojou-give' | 'homebody-hand';
      targetId: string;
      /** For homebody-hand: index of the preservation card being swapped out. */
      preserveIndex?: number;
    }
  | {
      kind: 'choose-player';
      choiceId: string;
      label: string;
      actorId: string;
      purpose: 'discipline' | 'monitor' | 'ojou' | 'accusation-destination';
      candidates: string[];
      sourcePlayerId?: string;
      sourceIndex?: number;
    }
  | {
      kind: 'choose-accusation';
      choiceId: string;
      label: string;
      actorId: string;
    }
  | {
      kind: 'simultaneous';
      choiceId: string;
      label: string;
      purpose: 'exchange' | 'news';
      participants: string[];
      partnerId?: string;
      choices: Record<string, string>;
    };

interface MatchState {
  matchId: string;
  mode: IceMode;
  players: PlayerState[];
  preservation: Card[];
  discard: Card[];
  phase: 'waiting' | 'playing' | 'finished';
  started: boolean;
  seq: number;
  turnIndex: number;
  startIndex: number;
  turnCount: number;
  ready: Set<string>;
  pending: Pending | null;
  decisionTimer: NodeJS.Timeout | null;
  decisionToken: number;
  /** Identifies the turn or pending the current timer belongs to. */
  decisionKey: string | null;
  decisionDeadline: number | null;
  /**
   * A private snapshot from the effect that was just resolved. It is shown to
   * its owner only in the immediately following view(s) and dropped on the
   * next action, so it cannot be used as a permanent memory aid.
   */
  peek: { playerId: string; view: IcePendingView } | null;
  log: { ts: number; text: string }[];
  faceUpInfection: { cardId: string; ownerId: string } | null;
  result: SettlementResult | null;
  resultView: IceResultView | null;
  resultSent: boolean;
}

export interface IceMatchOptions {
  matchId: string;
  seats: Seat[];
  /** Test hook: an ordered deck (deal order). Omit for a normal shuffled deck. */
  deck?: CardKey[];
  /** Test hook: deterministic random source in [0, 1). */
  rng?: () => number;
  send: (message: GameToPlatform) => void;
  /** 标准（ice）或混沌（ice-chaos）；默认标准。 */
  mode?: IceMode;
  /** 回合行动超时；0 关闭（测试）。默认 20000。 */
  turnTimeoutMs?: number;
  /** pending 选择超时；0 关闭（测试）。默认 20000。 */
  pendingTimeoutMs?: number;
}

/**
 * One ice game. The worker owns exactly one instance per match.
 *
 * All rule decisions live here; the platform routes opaque views. Hidden
 * information is trimmed in `buildView`, never in the browser.
 */
export class IceMatch {
  private readonly send: (message: GameToPlatform) => void;
  private readonly rng: () => number;
  private readonly turnTimeoutMs: number;
  private readonly pendingTimeoutMs: number;
  private readonly state: MatchState;

  constructor(options: IceMatchOptions) {
    const seats = [...options.seats].sort((a, b) => a.seat - b.seat);
    if (seats.length < 3 || seats.length > 6) {
      throw new Error(`ice needs 3-6 players, got ${seats.length}`);
    }
    if (!isSupportedPlayerCount(seats.length)) {
      throw new Error(`unsupported player count: ${seats.length}`);
    }
    if (new Set(seats.map((seat) => seat.userId)).size !== seats.length) {
      throw new Error('duplicate player in seats');
    }

    this.send = options.send;
    this.rng =
      options.rng ??
      (() => randomInt(0, 2 ** 32) / 2 ** 32);
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS;
    const mode: IceMode = options.mode ?? 'standard';
    if (mode !== 'standard' && mode !== 'chaos') {
      throw new Error(`unknown ice mode: ${String(mode)}`);
    }

    const playerCount = seats.length;
    const deck = this.resolveDeck(playerCount, options.deck);
    const hands: Card[][] = seats.map(() => []);
    deck.forEach((card, index) => {
      hands[index % playerCount]!.push(card);
    });

    const players: PlayerState[] = seats.map((seat, index) => ({
      userId: seat.userId,
      name: seat.name,
      seat: seat.seat,
      hand: hands[index]!,
      accusations: [],
      front: [],
      connected: true,
    }));

    const presidentIndex = players.findIndex((player) =>
      player.hand.some((card) => card.key === 'president'),
    );

    this.state = {
      matchId: options.matchId,
      mode,
      players,
      preservation: [],
      discard: [],
      phase: 'waiting',
      started: false,
      seq: 1,
      turnIndex: presidentIndex >= 0 ? presidentIndex : 0,
      startIndex: presidentIndex >= 0 ? presidentIndex : 0,
      turnCount: 0,
      ready: new Set(),
      pending: null,
      decisionTimer: null,
      decisionToken: 0,
      decisionKey: null,
      decisionDeadline: null,
      peek: null,
      log: [],
      faceUpInfection: null,
      result: null,
      resultView: null,
      resultSent: false,
    };

    this.addLog(
      `已发牌：${playerCount} 人，每人 ${startingHandSize(playerCount)} 张，` +
        `防腐成功需要 ${PRESERVATION_THRESHOLD[playerCount]} 点。等待所有玩家准备…`,
    );
    this.broadcast();
  }

  // ── public API ───────────────────────────────────────────────────────────

  /** The worker forwards protocol messages here. */
  handle(message: PlatformToGame): void {
    switch (message.t) {
      case 'player.ready':
        this.ready(message.playerId);
        return;
      case 'action': {
        // Defence in depth: the platform also rejects stale seq, but an
        // auto-action can race with a client action that was already in
        // flight when the 20s timer fired.
        if (message.seq !== this.state.seq) {
          this.sendError(message.playerId, 'E_STALE', '视图已过期，请等待新的视图');
          return;
        }
        const result = this.act(message.playerId, message.action);
        if (!result.ok) {
          this.sendError(
            message.playerId,
            result.code ?? 'E_ILLEGAL',
            result.error ?? '动作被拒绝',
          );
        }
        return;
      }
      case 'player.connection':
        this.setConnected(message.playerId, message.connected);
        return;
      case 'match.abort':
        this.abort();
        return;
      default:
        return;
    }
  }

  ready(playerId: string): void {
    const player = this.playerById(playerId);
    if (!player) return;
    if (this.state.started || this.state.phase !== 'waiting') return;
    if (this.state.ready.has(playerId)) return;
    this.state.ready.add(playerId);
    if (this.state.ready.size < this.state.players.length) return;

    this.state.started = true;
    this.state.phase = 'playing';
    this.state.seq += 1;
    this.state.turnIndex = this.state.startIndex;
    this.state.turnCount = 1;
    const president = this.state.players[this.state.startIndex]!;
    this.addLog(`游戏开始。${president.name} 持有【学生会长】，先手。`);
    this.send({ v: 1, t: 'match.started', matchId: this.state.matchId });
    this.beginTurn();
    this.commit();
  }

  act(playerId: string, action: unknown): IceActionResult {
    if (this.state.phase === 'finished') {
      return this.fail('E_GAME_OVER', '对局已结束');
    }
    if (!this.state.started || this.state.phase !== 'playing') {
      return this.fail('E_NOT_STARTED', '对局尚未开始');
    }
    const player = this.playerById(playerId);
    if (!player) return this.fail('E_PLAYER', '你不是本局玩家');
    if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
      return this.fail('E_ILLEGAL', '无效的动作');
    }
    const typed = action as IceAction;

    const previousPeek = this.state.peek;
    this.state.peek = null;
    const result = this.state.pending
      ? this.handlePending(player, this.state.pending, typed)
      : this.handleTurn(player, typed);
    if (!result.ok) {
      this.state.peek = previousPeek;
      return result;
    }

    this.state.seq += 1;
    this.commit();
    return { ok: true };
  }

  setConnected(playerId: string, connected: boolean): void {
    const player = this.playerById(playerId);
    if (!player) return;
    player.connected = connected;
    // Same seq: this is not a game action, but all viewers should see the dot.
    this.broadcast();
  }

  abort(): void {
    this.clearDecisionTimer();
    this.state.pending = null;
    this.state.peek = null;
  }

  // ── setup helpers ────────────────────────────────────────────────────────

  private resolveDeck(playerCount: number, requested?: CardKey[]): Card[] {
    const pool = createDeck(playerCount);
    let ordered: Card[];
    if (requested) {
      validateDeckKeys(requested, playerCount);
      const pools = new Map<CardKey, Card[]>();
      for (const card of pool) {
        const list = pools.get(card.key) ?? [];
        list.push(card);
        pools.set(card.key, list);
      }
      ordered = requested.map((key) => {
        const list = pools.get(key);
        const card = list?.shift();
        if (!card) throw new Error(`deck exhausted for ${key}`);
        return card;
      });
    } else {
      ordered = [...pool];
      this.shuffle(ordered);
    }
    return ordered;
  }

  private shuffle(cards: Card[]): void {
    for (let i = cards.length - 1; i > 0; i -= 1) {
      const j = this.pickIndex(i + 1);
      const value = cards[i]!;
      cards[i] = cards[j]!;
      cards[j] = value;
    }
  }

  private pickIndex(length: number): number {
    if (length <= 0) return 0;
    const raw = this.rng();
    const normalized = Number.isFinite(raw) ? raw - Math.floor(raw) : 0;
    return Math.min(length - 1, Math.max(0, Math.floor(normalized * length)));
  }

  private randomChoice<T>(items: readonly T[]): T | null {
    if (items.length === 0) return null;
    return items[this.pickIndex(items.length)] ?? null;
  }

  // ── turn handling ────────────────────────────────────────────────────────

  private handleTurn(player: PlayerState, action: IceAction): IceActionResult {
    const current = this.currentPlayer();
    if (!current || current.userId !== player.userId) {
      return this.fail('E_TURN', '还没轮到你行动');
    }
    if (player.hand.length <= 1) {
      return this.fail('E_TURN', '你已经只剩最后一张身份牌，本回合被跳过');
    }
    switch (action.type) {
      case 'preserve':
        return this.handlePreserve(player, action.cardId);
      case 'accuse':
        return this.handleAccuse(player, action.cardId, action.targetPlayerId);
      case 'use':
        return this.handleUse(player, action.cardId, action.targetPlayerId);
      default:
        return this.fail('E_ILLEGAL', '现在只能使用、质疑或防腐一张手牌');
    }
  }

  private findHandCard(player: PlayerState, cardId: string | undefined): Card | null {
    if (!cardId) return null;
    return player.hand.find((card) => card.id === cardId) ?? null;
  }

  private handlePreserve(player: PlayerState, cardId: string | undefined): IceActionResult {
    const card = this.findHandCard(player, cardId);
    if (!card) return this.fail('E_ILLEGAL', '手牌中没有这张牌');
    if (card.key === 'culprit') {
      return this.fail('E_ILLEGAL', '【犯人】不能以任何方式被使用');
    }
    player.hand.splice(player.hand.indexOf(card), 1);
    this.state.preservation.push(card);
    this.addLog(`${player.name} 将一张牌置入防腐堆。`);
    this.completeTurn();
    return { ok: true };
  }

  private handleAccuse(
    player: PlayerState,
    cardId: string | undefined,
    targetPlayerId: string | undefined,
  ): IceActionResult {
    const card = this.findHandCard(player, cardId);
    if (!card) return this.fail('E_ILLEGAL', '手牌中没有这张牌');
    if (card.key === 'culprit') {
      return this.fail('E_ILLEGAL', '【犯人】不能以任何方式被使用');
    }
    const target = targetPlayerId ? this.playerById(targetPlayerId) : null;
    if (!target) return this.fail('E_ILLEGAL', '请选择质疑的目标玩家');
    if (target.userId === player.userId) {
      return this.fail('E_ILLEGAL', '不能质疑自己，请选择其他玩家');
    }
    player.hand.splice(player.hand.indexOf(card), 1);
    target.accusations.push(card);
    this.addLog(`${player.name} 将一张牌扣在 ${target.name} 面前。`);
    this.completeTurn();
    return { ok: true };
  }

  private handleUse(
    player: PlayerState,
    cardId: string | undefined,
    targetPlayerId: string | undefined,
  ): IceActionResult {
    const card = this.findHandCard(player, cardId);
    if (!card) return this.fail('E_ILLEGAL', '手牌中没有这张牌');
    if (card.key === 'culprit') {
      return this.fail('E_ILLEGAL', '【犯人】不能以任何方式被使用');
    }
    const canUse = this.canUse(card.key, player);
    if (!canUse.ok) return canUse;
    const definition = CARD_DEFS[card.key];

    let target: PlayerState | null = null;
    if (this.needsTarget(card.key)) {
      const candidates = this.validTargets(card.key, player);
      if (targetPlayerId) {
        target = candidates.find((candidate) => candidate.userId === targetPlayerId) ?? null;
        if (!target) return this.fail('E_ILLEGAL', '该玩家不是合法目标');
      } else if (candidates.length === 0) {
        return this.fail('E_ILLEGAL', '没有合法的目标玩家');
      }
    }

    player.hand.splice(player.hand.indexOf(card), 1);
    this.addLog(`${player.name} 使用了【${definition.name}】。`);

    switch (card.key) {
      case 'alien':
      case 'president': {
        this.state.discard.push(card);
        this.completeTurn();
        return { ok: true };
      }
      case 'infected': {
        player.front.push(card);
        this.state.faceUpInfection = { cardId: card.id, ownerId: player.userId };
        this.addLog(`${player.name} 将【感染者】正面置于自己面前。`);
        this.completeTurn();
        return { ok: true };
      }
      case 'library': {
        this.state.discard.push(card);
        this.setPeek(player, {
          kind: 'peek',
          choiceId: '',
          label: '你查看了防腐堆。',
          blocking: false,
          actorId: player.userId,
          awaiting: [],
          source: 'preservation',
          cards: this.state.preservation.map(toCardView),
          note:
            this.state.preservation.length === 0
              ? '防腐堆是空的。'
              : `防腐堆共 ${this.state.preservation.length} 张，顺序从上到下。`,
        });
        this.addLog(`${player.name} 查看了防腐堆。`);
        this.completeTurn();
        return { ok: true };
      }
      case 'honors': {
        this.state.discard.push(card);
        this.showIdentityHolders(player);
        this.completeTurn();
        return { ok: true };
      }
      case 'health': {
        this.state.discard.push(card);
        this.state.pending = {
          kind: 'choose-card',
          choiceId: randomUUID(),
          label: '选择弃牌堆中的一张牌置入手牌。',
          actorId: player.userId,
          purpose: 'health',
          from: 'discard',
        };
        return { ok: true };
      }
      case 'discipline': {
        this.state.discard.push(card);
        if (target) {
          this.revealHand(player, target);
          this.completeTurn();
        } else {
          this.state.pending = {
            kind: 'choose-player',
            choiceId: randomUUID(),
            label: '选择一名其他玩家查看其手牌。',
            actorId: player.userId,
            purpose: 'discipline',
            candidates: this.validTargets('discipline', player).map((candidate) => candidate.userId),
          };
        }
        return { ok: true };
      }
      case 'monitor': {
        this.state.discard.push(card);
        if (target) {
          this.startExchange(player, target);
        } else {
          this.state.pending = {
            kind: 'choose-player',
            choiceId: randomUUID(),
            label: '选择一名其他玩家交换手牌。',
            actorId: player.userId,
            purpose: 'monitor',
            candidates: this.validTargets('monitor', player).map((candidate) => candidate.userId),
          };
        }
        return { ok: true };
      }
      case 'ojou': {
        this.state.discard.push(card);
        if (target) {
          this.startOjouTake(player, target);
        } else {
          this.state.pending = {
            kind: 'choose-player',
            choiceId: randomUUID(),
            label: '选择一名其他玩家，随机取得其一张手牌。',
            actorId: player.userId,
            purpose: 'ojou',
            candidates: this.validTargets('ojou', player).map((candidate) => candidate.userId),
          };
        }
        return { ok: true };
      }
      case 'news': {
        this.state.discard.push(card);
        this.startNews(player);
        return { ok: true };
      }
      case 'homebody': {
        this.state.discard.push(card);
        this.state.pending = {
          kind: 'choose-card',
          choiceId: randomUUID(),
          label: '选择防腐堆中的一张牌，与一张手牌交换。',
          actorId: player.userId,
          purpose: 'homebody-preserve',
          from: 'preservation',
        };
        return { ok: true };
      }
      case 'accomplice': {
        this.state.discard.push(card);
        const hasAccusations = this.state.players.some((candidate) => candidate.accusations.length > 0);
        if (!hasAccusations) {
          this.addLog('质疑堆中没有任何牌，【从犯】的效果没有结算。');
          this.completeTurn();
          return { ok: true };
        }
        this.state.pending = {
          kind: 'choose-accusation',
          choiceId: randomUUID(),
          label: '选择一张质疑牌，将其移到另一位玩家的质疑堆。',
          actorId: player.userId,
        };
        return { ok: true };
      }
      default:
        this.state.discard.push(card);
        this.completeTurn();
        return { ok: true };
    }
  }

  private needsTarget(key: CardKey): boolean {
    return key === 'discipline' || key === 'monitor' || key === 'ojou';
  }

  /**
   * Standard needs 3 cards for effects that make the user give one away: after
   * playing the card they must still have a non-last card to give. Chaos allows
   * giving the last card, so 2 is enough.
   */
  private giveHandMin(): number {
    return this.state.mode === 'chaos' ? 2 : 3;
  }

  /** Standard cannot exchange a 1-card hand; chaos can exchange the last card. */
  private exchangeHandMin(): number {
    return this.state.mode === 'chaos' ? 1 : 2;
  }

  private canUse(key: CardKey, player: PlayerState): IceActionResult {
    switch (key) {
      case 'culprit':
        return this.fail('E_ILLEGAL', '【犯人】不能以任何方式被使用');
      case 'monitor': {
        const min = this.giveHandMin();
        if (player.hand.length < min) {
          return this.fail('E_ILLEGAL', `手牌不足 ${min} 张，无法使用【班长】`);
        }
        if (this.validTargets('monitor', player).length === 0) {
          return this.fail('E_ILLEGAL', '没有可以交换手牌的玩家');
        }
        return { ok: true };
      }
      case 'ojou':
        if (this.validTargets('ojou', player).length === 0) {
          return this.fail('E_ILLEGAL', '没有可以随机取牌的玩家');
        }
        return { ok: true };
      case 'news': {
        const min = this.giveHandMin();
        if (player.hand.length < min) {
          return this.fail('E_ILLEGAL', `手牌不足 ${min} 张，无法使用【新闻部】`);
        }
        return { ok: true };
      }
      case 'homebody': {
        const min = this.giveHandMin();
        if (player.hand.length < min) {
          return this.fail('E_ILLEGAL', `手牌不足 ${min} 张，无法使用【归宅部】`);
        }
        if (this.state.preservation.length === 0) {
          return this.fail('E_ILLEGAL', '防腐堆是空的');
        }
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  /**
   * Legal "other players" for target-requiring effects.
   *
   * 【班长】/【大小姐】 need a target with at least two cards, otherwise the
   * exchange would move that player's last (identity) card.
   */
  private validTargets(key: CardKey, player: PlayerState): PlayerState[] {
    const minTarget = this.exchangeHandMin();
    return this.state.players.filter((candidate) => {
      if (candidate.userId === player.userId) return false;
      if (key === 'monitor' || key === 'ojou') return candidate.hand.length >= minTarget;
      return true;
    });
  }

  // ── effects ──────────────────────────────────────────────────────────────

  private setPeek(player: PlayerState, view: IcePendingView): void {
    this.state.peek = { playerId: player.userId, view };
  }

  private revealHand(actor: PlayerState, target: PlayerState): void {
    this.setPeek(actor, {
      kind: 'peek',
      choiceId: '',
      label: `你查看了 ${target.name} 的手牌。`,
      blocking: false,
      actorId: actor.userId,
      awaiting: [],
      source: 'hand',
      targetPlayerId: target.userId,
      players: [{ userId: target.userId, name: target.name }],
      cards: target.hand.map(toCardView),
      note: `共 ${target.hand.length} 张，顺序为持有顺序（仅作展示）。`,
    });
    this.addLog(`${actor.name} 查看了 ${target.name} 的手牌。`);
  }

  private showIdentityHolders(actor: PlayerState): void {
    const holders = this.state.players.filter((candidate) =>
      candidate.hand.some((card) => card.key === 'culprit' || card.key === 'alien'),
    );
    const players = holders.map((holder) => ({ userId: holder.userId, name: holder.name }));
    this.setPeek(actor, {
      kind: 'peek',
      choiceId: '',
      label: '你锁定了持有【犯人】和【外星人】的玩家。',
      blocking: false,
      actorId: actor.userId,
      awaiting: [],
      source: 'identity-holders',
      players,
      note:
        players.length <= 1
          ? '这些身份牌集中在同一名玩家手中（或者另一张已经不在任何人手里）。'
          : '这两名玩家合计持有【犯人】和【外星人】，但你无法区分谁是谁。',
    });
    this.addLog(`${actor.name} 查看了持有【犯人】和【外星人】的玩家（仅本人可见）。`);
  }

  private startExchange(actor: PlayerState, target: PlayerState): void {
    this.addLog(`${actor.name} 与 ${target.name} 正在同时选择交换的手牌。`);
    this.state.pending = {
      kind: 'simultaneous',
      choiceId: randomUUID(),
      label: `与 ${target.name} 各选择一张手牌，同时交给对方。`,
      purpose: 'exchange',
      participants: [actor.userId, target.userId],
      partnerId: target.userId,
      choices: {},
    };
  }

  private startOjouTake(actor: PlayerState, target: PlayerState): void {
    if (target.hand.length === 0) return;
    const index = this.pickIndex(target.hand.length);
    const card = target.hand.splice(index, 1)[0];
    if (!card) return;
    actor.hand.push(card);
    this.addLog(`${actor.name} 从 ${target.name} 处随机取得一张手牌。`);
    this.state.pending = {
      kind: 'choose-hand-card',
      choiceId: randomUUID(),
      label: `选择一张手牌交给 ${target.name}。`,
      actorId: actor.userId,
      purpose: 'ojou-give',
      targetId: target.userId,
    };
  }

  private startNews(actor: PlayerState): void {
    const chaos = this.state.mode === 'chaos';
    const participants = this.state.players
      .filter((candidate) => candidate.hand.length >= (chaos ? 1 : 2))
      .map((candidate) => candidate.userId);
    this.addLog(
      `${actor.name} 使用了【新闻部】；${
        chaos ? '所有玩家' : '手牌多于一张的玩家'
      }同时选择一张牌交给上家。`,
    );
    this.state.pending = {
      kind: 'simultaneous',
      choiceId: randomUUID(),
      label: chaos
        ? '所有玩家各选择一张手牌，同时交给上家（混沌规则允许交出最后一张）。'
        : '所有手牌多于一张的玩家各选择一张手牌，同时交给上家。',
      purpose: 'news',
      participants,
      choices: {},
    };
  }

  // ── pending handling ─────────────────────────────────────────────────────

  private handlePending(
    player: PlayerState,
    pending: Pending,
    action: IceAction,
  ): IceActionResult {
    if (pending.kind === 'simultaneous') {
      if (!pending.participants.includes(player.userId)) {
        return this.fail('E_PENDING', '请等待其他玩家完成选择');
      }
      if (action.type !== 'resolve' || action.choiceId !== pending.choiceId) {
        return this.fail('E_STALE_CHOICE', '选择已过期，请刷新视图');
      }
      return this.submitSimultaneous(player, pending, action.cardId);
    }

    if (pending.actorId !== player.userId) {
      const actor = this.playerById(pending.actorId);
      return this.fail('E_PENDING', `等待 ${actor?.name ?? '其他玩家'} 完成选择`);
    }
    if (action.type !== 'resolve') {
      return this.fail('E_PENDING', '请先完成当前选择');
    }
    if (action.choiceId !== pending.choiceId) {
      return this.fail('E_STALE_CHOICE', '选择已过期，请刷新视图');
    }

    switch (pending.kind) {
      case 'choose-card':
        return this.resolveChooseCard(player, pending, action);
      case 'choose-hand-card':
        return this.resolveChooseHandCard(player, pending, action);
      case 'choose-player':
        return this.resolveChoosePlayer(player, pending, action);
      case 'choose-accusation':
        return this.resolveChooseAccusation(player, pending, action);
      default:
        return this.fail('E_ILLEGAL', '未知的选择');
    }
  }

  private submitSimultaneous(
    player: PlayerState,
    pending: Extract<Pending, { kind: 'simultaneous' }>,
    cardId: string | undefined,
  ): IceActionResult {
    if (pending.choices[player.userId]) {
      return this.fail('E_ILLEGAL', '你已经提交过选择');
    }
    const card = this.findHandCard(player, cardId);
    if (!card) return this.fail('E_ILLEGAL', '手牌中没有这张牌');
    if (player.hand.length < this.exchangeHandMin()) {
      return this.fail('E_ILLEGAL', '最后一张身份牌不能被交换');
    }
    pending.choices[player.userId] = card.id;

    if (Object.keys(pending.choices).length >= pending.participants.length) {
      this.resolveSimultaneous(pending);
    }
    return { ok: true };
  }

  private resolveSimultaneous(pending: Extract<Pending, { kind: 'simultaneous' }>): void {
    const entries = pending.participants.map((userId) => {
      const player = this.playerById(userId);
      const cardId = pending.choices[userId];
      const card = player?.hand.find((candidate) => candidate.id === cardId) ?? null;
      return { player, card };
    });
    if (entries.some((entry) => !entry.player || !entry.card)) {
      // Should not happen: no other action can mutate hands while a pending
      // exists. Fall back to finishing the turn rather than corrupting state.
      this.completeTurn();
      return;
    }
    const movable = entries as { player: PlayerState; card: Card }[];

    for (const { player, card } of movable) {
      const index = player.hand.indexOf(card);
      if (index >= 0) player.hand.splice(index, 1);
    }

    if (pending.purpose === 'exchange') {
      const [first, second] = movable;
      if (first && second) {
        first.player.hand.push(second.card);
        second.player.hand.push(first.card);
        this.addLog(`${first.player.name} 与 ${second.player.name} 交换了一张手牌。`);
      }
    } else {
      const playerCount = this.state.players.length;
      for (const { player, card } of movable) {
        const index = this.state.players.indexOf(player);
        const previous = this.state.players[(index - 1 + playerCount) % playerCount]!;
        previous.hand.push(card);
      }
      this.addLog('所有参与者同时将一张手牌交给了上家。');
    }

    this.state.pending = null;
    this.completeTurn();
  }

  private resolveChooseCard(
    player: PlayerState,
    pending: Extract<Pending, { kind: 'choose-card' }>,
    action: Extract<IceAction, { type: 'resolve' }>,
  ): IceActionResult {
    if (pending.from === 'discard') {
      const card = action.cardId
        ? this.state.discard.find((candidate) => candidate.id === action.cardId)
        : null;
      if (!card) return this.fail('E_ILLEGAL', '弃牌堆中没有这张牌');
      this.state.discard.splice(this.state.discard.indexOf(card), 1);
      player.hand.push(card);
      this.addLog(`${player.name} 从弃牌堆取回了【${CARD_DEFS[card.key].name}】。`);
      this.completeTurn();
      return { ok: true };
    }

    const index = action.index;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.state.preservation.length
    ) {
      return this.fail('E_ILLEGAL', '请选择防腐堆中的一张牌');
    }

    if (pending.purpose === 'infection') {
      const card = this.state.preservation.splice(index, 1)[0];
      if (!card) return this.fail('E_ILLEGAL', '防腐堆中没有牌');
      player.hand.push(card);
      this.discardInfection(player);
      this.addLog(`${player.name} 从防腐堆取回一张牌，面前的【感染者】进入弃牌堆。`);
      this.state.pending = null;
      this.clearDecisionTimer();
      if (player.hand.length > 1) {
        return { ok: true };
      }
      this.advanceTurn();
      return { ok: true };
    }

    // homebody-preserve: remember the position and ask for the hand card, but
    // do not reveal the face-down card before the player has chosen what to
    // put back.
    this.addLog(`${player.name} 选择了一张防腐牌，正在选择要交换出去的手牌。`);
    this.state.pending = {
      kind: 'choose-hand-card',
      choiceId: randomUUID(),
      label: '选择一张手牌，放回刚才选中的防腐堆位置。',
      actorId: player.userId,
      purpose: 'homebody-hand',
      targetId: player.userId,
      preserveIndex: index,
    };
    return { ok: true };
  }

  private resolveChooseHandCard(
    player: PlayerState,
    pending: Extract<Pending, { kind: 'choose-hand-card' }>,
    action: Extract<IceAction, { type: 'resolve' }>,
  ): IceActionResult {
    const card = this.findHandCard(player, action.cardId);
    if (!card) return this.fail('E_ILLEGAL', '手牌中没有这张牌');

    if (pending.purpose === 'ojou-give') {
      const target = this.playerById(pending.targetId);
      if (!target) return this.fail('E_ILLEGAL', '目标玩家不存在');
      if (player.hand.length < this.exchangeHandMin()) {
        return this.fail('E_ILLEGAL', '最后一张身份牌不能被交换');
      }
      player.hand.splice(player.hand.indexOf(card), 1);
      target.hand.push(card);
      this.addLog(`${player.name} 将一张手牌交给了 ${target.name}。`);
      this.completeTurn();
      return { ok: true };
    }

    const index = pending.preserveIndex;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= this.state.preservation.length
    ) {
      return this.fail('E_ILLEGAL', '防腐堆中的位置已失效');
    }
    if (player.hand.length < this.exchangeHandMin()) {
      return this.fail('E_ILLEGAL', '最后一张身份牌不能被交换');
    }
    const incoming = this.state.preservation[index]!;
    player.hand.splice(player.hand.indexOf(card), 1);
    this.state.preservation[index] = card;
    player.hand.push(incoming);
    this.addLog(`${player.name} 用一张手牌交换了防腐堆中的一张牌。`);
    this.completeTurn();
    return { ok: true };
  }

  private resolveChoosePlayer(
    player: PlayerState,
    pending: Extract<Pending, { kind: 'choose-player' }>,
    action: Extract<IceAction, { type: 'resolve' }>,
  ): IceActionResult {
    const targetId = action.targetPlayerId;
    if (!targetId || !pending.candidates.includes(targetId)) {
      return this.fail('E_ILLEGAL', '请选择合法的玩家');
    }
    const target = this.playerById(targetId);
    if (!target) return this.fail('E_ILLEGAL', '目标玩家不存在');

    switch (pending.purpose) {
      case 'discipline': {
        this.revealHand(player, target);
        this.completeTurn();
        return { ok: true };
      }
      case 'monitor': {
        if (target.hand.length < this.exchangeHandMin()) {
          return this.fail('E_ILLEGAL', '目标玩家手牌不足，不能交换');
        }
        this.startExchange(player, target);
        return { ok: true };
      }
      case 'ojou': {
        if (target.hand.length < this.exchangeHandMin()) {
          return this.fail('E_ILLEGAL', '目标玩家手牌不足，不能交换');
        }
        this.startOjouTake(player, target);
        return { ok: true };
      }
      case 'accusation-destination': {
        const sourceId = pending.sourcePlayerId;
        const sourceIndex = pending.sourceIndex;
        const source = sourceId ? this.playerById(sourceId) : null;
        if (!source || typeof sourceIndex !== 'number' || target.userId === source.userId) {
          return this.fail('E_ILLEGAL', '请选择另一位玩家的质疑堆');
        }
        const card = source.accusations[sourceIndex];
        if (!card) return this.fail('E_ILLEGAL', '质疑牌已失效');
        source.accusations.splice(sourceIndex, 1);
        target.accusations.push(card);
        this.addLog(
          `${player.name} 将一张质疑牌从 ${source.name} 的质疑堆移到 ${target.name} 的质疑堆。`,
        );
        this.completeTurn();
        return { ok: true };
      }
      default:
        return this.fail('E_ILLEGAL', '未知的选择');
    }
  }

  private resolveChooseAccusation(
    player: PlayerState,
    pending: Extract<Pending, { kind: 'choose-accusation' }>,
    action: Extract<IceAction, { type: 'resolve' }>,
  ): IceActionResult {
    const sourceId = action.targetPlayerId;
    const index = action.index;
    const source = sourceId ? this.playerById(sourceId) : null;
    if (!source) return this.fail('E_ILLEGAL', '请选择一名玩家');
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= source.accusations.length
    ) {
      return this.fail('E_ILLEGAL', '请选择该玩家质疑堆中的一张牌');
    }
    const candidates = this.state.players
      .filter((candidate) => candidate.userId !== source.userId)
      .map((candidate) => candidate.userId);
    if (candidates.length === 0) {
      return this.fail('E_ILLEGAL', '没有另一位玩家可以接收');
    }
    this.state.pending = {
      kind: 'choose-player',
      choiceId: randomUUID(),
      label: '选择接收这张质疑牌的另一位玩家。',
      actorId: player.userId,
      purpose: 'accusation-destination',
      candidates,
      sourcePlayerId: source.userId,
      sourceIndex: index,
    };
    return { ok: true };
  }

  // ── turn flow ────────────────────────────────────────────────────────────

  private completeTurn(): void {
    this.state.pending = null;
    this.clearDecisionTimer();
    this.advanceTurn();
  }

  private advanceTurn(): void {
    if (this.state.phase === 'finished') return;
    const count = this.state.players.length;
    const from = this.state.turnIndex;
    for (let step = 1; step <= count; step += 1) {
      const index = (from + step) % count;
      const player = this.state.players[index]!;
      const hasInfection = this.state.faceUpInfection?.ownerId === player.userId;
      if (player.hand.length > 1 || hasInfection) {
        this.state.turnIndex = index;
        this.state.turnCount += 1;
        this.beginTurn();
        return;
      }
    }
    this.finishGame();
  }

  private beginTurn(): void {
    if (this.state.phase === 'finished') return;
    const player = this.currentPlayer();
    if (!player) {
      this.finishGame();
      return;
    }

    const infection = this.state.faceUpInfection;
    if (infection && infection.ownerId === player.userId) {
      if (this.state.preservation.length > 0) {
        this.state.pending = {
          kind: 'choose-card',
          choiceId: randomUUID(),
          label: '【感染者】发作：选择防腐堆中的一张牌置入手牌。',
          actorId: player.userId,
          purpose: 'infection',
          from: 'preservation',
        };
        return;
      }
      this.discardInfection(player);
      this.addLog(
        `${player.name} 面前的【感染者】没有可取的防腐牌，直接置入弃牌堆。`,
      );
    }

    if (player.hand.length <= 1) {
      this.advanceTurn();
      return;
    }
    // Turn is live; actions are computed per view.
  }

  private discardInfection(player: PlayerState): void {
    const infection = this.state.faceUpInfection;
    if (!infection || infection.ownerId !== player.userId) return;
    const index = player.front.findIndex((card) => card.id === infection.cardId);
    if (index >= 0) {
      const [card] = player.front.splice(index, 1);
      if (card) this.state.discard.push(card);
    }
    this.state.faceUpInfection = null;
  }

  private finishGame(): void {
    if (this.state.phase === 'finished') return;
    this.state.phase = 'finished';
    this.state.pending = null;
    this.clearDecisionTimer();
    this.state.faceUpInfection = null;
    for (const player of this.state.players) {
      if (player.front.length > 0) {
        // Defensive: a face-up infection should have been resolved before the
        // game can end. Never lose the physical card if that invariant breaks.
        this.state.discard.push(...player.front);
        player.front = [];
      }
    }

    const settlement = settleGame({
      players: this.state.players.map((player) => ({
        userId: player.userId,
        name: player.name,
        identity: player.hand.length === 1 ? player.hand[0]!.key : null,
        accusations: player.accusations.map((card) => card.key),
      })),
      preservation: this.state.preservation.map((card) => card.key),
    });
    this.state.result = settlement;
    this.state.resultView = this.buildResultView(settlement);
    this.addLog(settlement.reason);
  }

  // ── views ────────────────────────────────────────────────────────────────

  private buildResultView(result: SettlementResult): IceResultView {
    const players = this.state.players;
    return {
      winners: result.winners,
      outcomes: result.outcomes,
      success: result.success,
      reason: result.reason,
      category: result.category,
      imprisoned: result.imprisoned,
      accusationTotals: result.accusationTotals,
      preservation: {
        total: result.preservationTotal,
        threshold: result.threshold,
        success: result.success,
        cards: this.state.preservation.map(toCardView),
      },
      identities: players.map((player) => ({
        userId: player.userId,
        name: player.name,
        card: player.hand.length === 1 ? toCardView(player.hand[0]!) : null,
      })),
      reveal: {
        hands: players.map((player) => ({
          userId: player.userId,
          cards: player.hand.map(toCardView),
        })),
        accusations: players.map((player) => ({
          playerId: player.userId,
          cards: player.accusations.map(toCardView),
        })),
        preservation: this.state.preservation.map(toCardView),
        discard: this.state.discard.map(toCardView),
      },
    };
  }

  private buildView(viewerId: string | null): IceView {
    const viewer = viewerId ? this.playerById(viewerId) : null;
    const spectator = viewer === null;
    const revealAll = spectator || this.state.phase === 'finished';
    const playerCount = this.state.players.length;

    const players: IcePlayerView[] = this.state.players.map((player) => {
      const view: IcePlayerView = {
        userId: player.userId,
        name: player.name,
        seat: player.seat,
        handCount: player.hand.length,
        accusationCount: player.accusations.length,
        connected: player.connected,
        front: player.front.map(toCardView),
      };
      if (revealAll) {
        view.identity = player.hand.length === 1 ? toCardView(player.hand[0]!) : null;
      }
      if (spectator) {
        view.hand = player.hand.map(toCardView);
      }
      return view;
    });

    const current = this.currentPlayer();
    const pending = this.pendingViewFor(viewerId);
    const result = this.state.resultView;

    return {
      schema: 'ice-v1',
      phase: this.state.phase,
      status: this.state.phase,
      config: {
        mode: this.state.mode,
        playerCount,
        preservationThreshold: preservationThreshold(playerCount),
        deckSize: deckSize(playerCount),
        startingHandSize: startingHandSize(playerCount),
        decisionTimeoutMs:
          this.state.phase === 'playing'
            ? this.state.pending
              ? this.pendingTimeoutMs
              : this.turnTimeoutMs
            : 0,
        decisionRemainingMs: this.state.decisionDeadline
          ? Math.max(0, this.state.decisionDeadline - Date.now())
          : 0,
      },
      you: viewer
        ? {
            userId: viewer.userId,
            seat: viewer.seat,
            hand: viewer.hand.map(toCardView),
            identity: viewer.hand.length === 1 ? toCardView(viewer.hand[0]!) : null,
            pending: this.personalPendingFor(viewer.userId),
          }
        : null,
      players,
      piles: {
        preservation: {
          count: this.state.preservation.length,
          ...(revealAll
            ? { cards: this.state.preservation.map(toCardView) }
            : {}),
        },
        accusations: this.state.players.map((player) => ({
          playerId: player.userId,
          count: player.accusations.length,
          ...(revealAll ? { cards: player.accusations.map(toCardView) } : {}),
        })),
        discard: {
          count: this.state.discard.length,
          cards: this.state.discard.map(toCardView),
        },
      },
      turn:
        this.state.phase === 'playing' && this.state.started && current
          ? { playerId: current.userId, index: this.state.turnCount }
          : null,
      pending,
      log: [...this.state.log],
      ...(this.state.phase === 'finished' && result ? { result } : {}),
    };
  }

  private pendingViewFor(viewerId: string | null): IcePendingView | null {
    if (viewerId && this.state.peek?.playerId === viewerId) {
      return this.state.peek.view;
    }
    const pending = this.state.pending;
    if (!pending) return null;
    if (viewerId && this.isPendingParticipant(pending, viewerId)) {
      return this.fullPendingView(pending, viewerId);
    }
    return this.summaryPendingView(pending);
  }

  private personalPendingFor(viewerId: string): IcePendingView | null {
    if (this.state.peek?.playerId === viewerId) return this.state.peek.view;
    const pending = this.state.pending;
    if (!pending || !this.isPendingParticipant(pending, viewerId)) return null;
    return this.fullPendingView(pending, viewerId);
  }

  private isPendingParticipant(pending: Pending, userId: string): boolean {
    if (pending.kind === 'simultaneous') return pending.participants.includes(userId);
    return pending.actorId === userId;
  }

  private awaitingOf(pending: Pending): string[] {
    if (pending.kind === 'simultaneous') {
      return pending.participants.filter((userId) => !pending.choices[userId]);
    }
    return [pending.actorId];
  }

  private fullPendingView(pending: Pending, viewerId: string): IcePendingView {
    const viewer = this.playerById(viewerId)!;
    const base = {
      choiceId: pending.choiceId,
      label: pending.label,
      blocking: true,
      actorId: pending.kind === 'simultaneous' ? null : pending.actorId,
      awaiting: this.awaitingOf(pending),
    };

    switch (pending.kind) {
      case 'choose-card': {
        if (pending.from === 'discard') {
          return {
            ...base,
            kind: 'choose-card',
            from: 'discard',
            purpose: pending.purpose,
            count: this.state.discard.length,
            cards: this.state.discard.map(toCardView),
          };
        }
        return {
          ...base,
          kind: 'choose-card',
          from: 'preservation',
          purpose: pending.purpose,
          count: this.state.preservation.length,
        };
      }
      case 'choose-hand-card':
        return {
          ...base,
          kind: 'choose-card',
          from: 'hand',
          purpose: pending.purpose,
          count: viewer.hand.length,
          cards: viewer.hand.map(toCardView),
          targetPlayerId: pending.targetId,
        };
      case 'choose-player':
        return {
          ...base,
          kind: 'choose-player',
          purpose: pending.purpose,
          candidates: pending.candidates.map((userId) => {
            const player = this.playerById(userId);
            return { userId, name: player?.name ?? userId };
          }),
        };
      case 'choose-accusation':
        return {
          ...base,
          kind: 'choose-accusation',
          purpose: 'move-accusation',
          sources: this.state.players
            .filter((player) => player.accusations.length > 0)
            .map((player) => ({
              playerId: player.userId,
              name: player.name,
              count: player.accusations.length,
            })),
        };
      case 'simultaneous':
        return {
          ...base,
          kind: 'simultaneous',
          purpose: pending.purpose,
          participants: [...pending.participants],
          submitted: Object.keys(pending.choices),
          awaiting: this.awaitingOf(pending),
          options:
            pending.choices[viewer.userId] === undefined
              ? viewer.hand.map(toCardView)
              : [],
        };
      default:
        return { ...base, kind: 'peek' };
    }
  }

  private summaryPendingView(pending: Pending): IcePendingView {
    const base = {
      choiceId: pending.choiceId,
      label: pending.label,
      blocking: true,
      actorId: pending.kind === 'simultaneous' ? null : pending.actorId,
      awaiting: this.awaitingOf(pending),
    };
    switch (pending.kind) {
      case 'choose-card':
        return {
          ...base,
          kind: 'choose-card',
          from: pending.from,
          purpose: pending.purpose,
          count:
            pending.from === 'discard'
              ? this.state.discard.length
              : pending.from === 'preservation'
                ? this.state.preservation.length
                : this.playerById(pending.actorId)?.hand.length ?? 0,
        };
      case 'choose-hand-card':
        return {
          ...base,
          kind: 'choose-card',
          from: 'hand',
          purpose: pending.purpose,
          count: this.playerById(pending.actorId)?.hand.length ?? 0,
          targetPlayerId: pending.targetId,
        };
      case 'choose-player':
        return {
          ...base,
          kind: 'choose-player',
          purpose: pending.purpose,
          candidates: pending.candidates.map((userId) => {
            const player = this.playerById(userId);
            return { userId, name: player?.name ?? userId };
          }),
        };
      case 'choose-accusation':
        return {
          ...base,
          kind: 'choose-accusation',
          purpose: 'move-accusation',
          sources: this.state.players
            .filter((player) => player.accusations.length > 0)
            .map((player) => ({
              playerId: player.userId,
              name: player.name,
              count: player.accusations.length,
            })),
        };
      case 'simultaneous':
        return {
          ...base,
          kind: 'simultaneous',
          purpose: pending.purpose,
          participants: [...pending.participants],
          submitted: Object.keys(pending.choices),
        };
      default:
        return { ...base, kind: 'peek' };
    }
  }

  // ── action hints (server-side legality for the UI) ───────────────────────

  private actionsFor(viewerId: string | null): unknown[] {
    if (!viewerId || this.state.phase !== 'playing' || !this.state.started) return [];
    const viewer = this.playerById(viewerId);
    if (!viewer) return [];

    // A peek is informational only. In a 3+ player game the turn can wrap back
    // to the same player after the last other player is skipped (all others at
    // one card), so a peek must never suppress the owner's actual actions.
    const pending = this.state.pending;
    if (pending) {
      if (!this.isPendingParticipant(pending, viewerId)) return [];
      return this.pendingActions(pending, viewer);
    }

    const current = this.currentPlayer();
    if (!current || current.userId !== viewerId) return [];
    if (viewer.hand.length <= 1) return [];

    const actions: IceAction[] = [];
    for (const card of viewer.hand) {
      if (card.key === 'culprit') continue;
      const name = CARD_DEFS[card.key].name;
      actions.push({ type: 'preserve', cardId: card.id, label: `防腐：${name}` });
      for (const target of this.state.players) {
        if (target.userId === viewer.userId) continue;
        actions.push({
          type: 'accuse',
          cardId: card.id,
          targetPlayerId: target.userId,
          label: `质疑给 ${target.name}：${name}`,
        });
      }
      if (!this.canUse(card.key, viewer).ok) continue;
      if (this.needsTarget(card.key)) {
        for (const target of this.validTargets(card.key, viewer)) {
          actions.push({
            type: 'use',
            cardId: card.id,
            targetPlayerId: target.userId,
            label: `使用【${name}】→ ${target.name}`,
          });
        }
      } else {
        actions.push({ type: 'use', cardId: card.id, label: `使用【${name}】` });
      }
    }
    return actions;
  }

  private pendingActions(
    pending: Pending,
    viewer: PlayerState,
  ): IceAction[] {
    const choiceId = pending.choiceId;
    if (pending.kind === 'simultaneous') {
      if (pending.choices[viewer.userId]) return [];
      // Standard: the identity card cannot be exchanged. Chaos explicitly
      // allows a one-card player to give their last card (news).
      if (viewer.hand.length < this.exchangeHandMin()) return [];
      return viewer.hand.map((card) => ({
        type: 'resolve' as const,
        choiceId,
        cardId: card.id,
        label: `选择【${CARD_DEFS[card.key].name}】`,
      }));
    }
    const actions: IceAction[] = [];
    switch (pending.kind) {
      case 'choose-card': {
        if (pending.from === 'discard') {
          for (const card of this.state.discard) {
            actions.push({
              type: 'resolve',
              choiceId,
              cardId: card.id,
              label: `取回【${CARD_DEFS[card.key].name}】`,
            });
          }
        } else {
          for (let index = 0; index < this.state.preservation.length; index += 1) {
            actions.push({
              type: 'resolve',
              choiceId,
              index,
              label: `选择防腐堆第 ${index + 1} 张`,
            });
          }
        }
        return actions;
      }
      case 'choose-hand-card': {
        if (viewer.hand.length < this.exchangeHandMin()) return [];
        for (const card of viewer.hand) {
          actions.push({
            type: 'resolve',
            choiceId,
            cardId: card.id,
            label:
              pending.purpose === 'ojou-give'
                ? `交出【${CARD_DEFS[card.key].name}】`
                : `将【${CARD_DEFS[card.key].name}】放入防腐堆`,
          });
        }
        return actions;
      }
      case 'choose-player': {
        for (const userId of pending.candidates) {
          const player = this.playerById(userId);
          actions.push({
            type: 'resolve',
            choiceId,
            targetPlayerId: userId,
            label: `选择 ${player?.name ?? userId}`,
          });
        }
        return actions;
      }
      case 'choose-accusation': {
        for (const player of this.state.players) {
          for (let index = 0; index < player.accusations.length; index += 1) {
            actions.push({
              type: 'resolve',
              choiceId,
              targetPlayerId: player.userId,
              index,
              label: `从 ${player.name} 的质疑堆选择第 ${index + 1} 张`,
            });
          }
        }
        return actions;
      }
      default:
        return [];
    }
  }

  // ── I/O ──────────────────────────────────────────────────────────────────

  private broadcast(): void {
    for (const player of this.state.players) {
      this.send({
        v: 1,
        t: 'view',
        matchId: this.state.matchId,
        to: `player:${player.userId}`,
        seq: this.state.seq,
        view: this.buildView(player.userId),
        actions: this.actionsFor(player.userId),
      });
    }
    this.send({
      v: 1,
      t: 'view',
      matchId: this.state.matchId,
      to: 'spectator',
      seq: this.state.seq,
      view: this.buildView(null),
      actions: [],
    });
  }

  private commit(): void {
    // Set the new deadline before building the views so the clients can show
    // the correct remaining time.
    this.scheduleDecisionTimer();
    this.broadcast();
    if (this.state.phase === 'finished' && !this.state.resultSent) {
      this.state.resultSent = true;
      this.send({
        v: 1,
        t: 'result',
        matchId: this.state.matchId,
        result: this.resultPayload(),
      });
    }
  }

  private resultPayload(): Record<string, unknown> {
    const result = this.state.result;
    return {
      winners: result?.winners.map((winner) => winner.userId) ?? [],
      status: result && result.winners.length > 0 ? 'won' : 'lost',
      success: result?.success ?? false,
      reason: result?.reason ?? '',
      category: result?.category ?? 'none',
    };
  }

  private sendError(playerId: string, code: string, message: string): void {
    this.send({
      v: 1,
      t: 'error',
      matchId: this.state.matchId,
      playerId,
      code,
      message,
    });
  }

  private fail(code: string, error: string): IceActionResult {
    return { ok: false, error, code };
  }

  private addLog(text: string): void {
    this.state.log.push({ ts: Date.now(), text });
    if (this.state.log.length > LOG_LIMIT) {
      this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
    }
  }

  // ── timers / lookups ─────────────────────────────────────────────────────

  private decisionKey(): string | null {
    if (this.state.phase !== 'playing') return null;
    if (this.state.pending) return `pending:${this.state.pending.choiceId}`;
    return `turn:${this.state.turnCount}:${this.state.turnIndex}`;
  }

  private scheduleDecisionTimer(): void {
    const key = this.decisionKey();
    if (!key) {
      this.clearDecisionTimer();
      return;
    }
    // A partial simultaneous submission must not reset the clock for the
    // players who have not answered yet.
    if (this.state.decisionKey === key && this.state.decisionTimer) return;

    this.clearDecisionTimer();
    const timeoutMs = this.state.pending ? this.pendingTimeoutMs : this.turnTimeoutMs;
    this.state.decisionKey = key;
    if (timeoutMs <= 0) return;
    this.state.decisionDeadline = Date.now() + timeoutMs;
    const token = this.state.decisionToken;
    const timer = setTimeout(() => {
      if (token !== this.state.decisionToken) return;
      this.state.decisionTimer = null;
      this.autoResolveDecision();
    }, timeoutMs);
    timer.unref?.();
    this.state.decisionTimer = timer;
  }

  private clearDecisionTimer(): void {
    this.state.decisionToken += 1;
    this.state.decisionKey = null;
    this.state.decisionDeadline = null;
    if (this.state.decisionTimer) {
      clearTimeout(this.state.decisionTimer);
      this.state.decisionTimer = null;
    }
  }

  /** Called when the current turn or pending choice hit its 20s deadline. */
  private autoResolveDecision(): void {
    if (this.state.phase !== 'playing') return;
    // The timeout counts as the next action; a previous private peek must not
    // survive it.
    this.state.peek = null;
    if (this.state.pending) {
      this.autoResolvePending(this.state.pending);
      return;
    }

    const actor = this.currentPlayer();
    if (!actor) {
      this.finishGame();
      this.state.seq += 1;
      this.commit();
      return;
    }
    const actions = this.actionsFor(actor.userId) as IceAction[];
    const action = this.randomChoice(actions);
    if (!action) {
      this.addLog(`${actor.name} 的决策超时，且没有可执行操作，回合跳过。`);
      this.completeTurn();
      this.state.seq += 1;
      this.commit();
      return;
    }
    this.addLog(`${actor.name} 的决策超时，系统随机执行了一个可执行操作。`);
    const result = this.handleTurn(actor, action);
    if (!result.ok) {
      this.addLog(`自动操作失败（${result.error ?? '未知原因'}），回合跳过。`);
      this.completeTurn();
    }
    this.state.seq += 1;
    this.commit();
  }

  private autoResolvePending(pending: Pending): void {
    if (this.state.phase !== 'playing' || this.state.pending !== pending) return;

    if (pending.kind === 'simultaneous') {
      for (const userId of pending.participants) {
        if (pending.choices[userId]) continue;
        const player = this.playerById(userId);
        const card = player ? this.randomChoice(player.hand) : null;
        if (card) pending.choices[userId] = card.id;
      }
      this.addLog('决策超时，系统为未提交的玩家随机选择了手牌。');
      this.state.seq += 1;
      this.resolveSimultaneous(pending);
      this.commit();
      return;
    }

    const actor = this.playerById(pending.actorId);
    const action = this.synthesizePendingAction(pending);
    if (!actor || !action) {
      this.addLog('决策超时，但没有可执行的选项，系统结束该效果。');
      this.completeTurn();
      this.state.seq += 1;
      this.commit();
      return;
    }
    this.addLog('决策超时，系统随机完成了一个可执行选项。');
    const result = this.handlePending(actor, pending, action);
    if (!result.ok) {
      this.addLog(`自动选择失败（${result.error ?? '未知原因'}），系统结束该效果。`);
      this.completeTurn();
    }
    this.state.seq += 1;
    this.commit();
  }

  private synthesizePendingAction(
    pending: Pending,
  ): Extract<IceAction, { type: 'resolve' }> | null {
    switch (pending.kind) {
      case 'choose-card': {
        if (pending.from === 'discard') {
          const card = this.randomChoice(this.state.discard);
          return card
            ? { type: 'resolve', choiceId: pending.choiceId, cardId: card.id }
            : null;
        }
        if (this.state.preservation.length === 0) return null;
        return {
          type: 'resolve',
          choiceId: pending.choiceId,
          index: this.pickIndex(this.state.preservation.length),
        };
      }
      case 'choose-hand-card': {
        const actor = this.playerById(pending.actorId);
        const card = actor ? this.randomChoice(actor.hand) : null;
        return card
          ? { type: 'resolve', choiceId: pending.choiceId, cardId: card.id }
          : null;
      }
      case 'choose-player': {
        const target = this.randomChoice(pending.candidates);
        return target
          ? { type: 'resolve', choiceId: pending.choiceId, targetPlayerId: target }
          : null;
      }
      case 'choose-accusation': {
        const sources = this.state.players.filter(
          (player) => player.accusations.length > 0,
        );
        const source = this.randomChoice(sources);
        if (!source) return null;
        return {
          type: 'resolve',
          choiceId: pending.choiceId,
          targetPlayerId: source.userId,
          index: this.pickIndex(source.accusations.length),
        };
      }
      default:
        return null;
    }
  }

  private playerById(userId: string): PlayerState | null {
    return this.state.players.find((player) => player.userId === userId) ?? null;
  }

  private currentPlayer(): PlayerState | null {
    return this.state.players[this.state.turnIndex] ?? null;
  }
}

export type { CardView };
