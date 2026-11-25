/**
 * Wire types for the 《冰冷的她醒来之前》 game view and actions.
 *
 * These are game-private (the platform treats `view`/`action` as opaque), but
 * they are the contract between `src/games/ice` and `web/games/ice.js`.
 * Keep docs/冰她-后端实现与视图契约.md in sync when changing them.
 */
import type { CardKey, CardView } from './cards.js';

export type IcePhase = 'waiting' | 'playing' | 'finished';

/** Standard (last card is frozen) or chaos (last card may be exchanged). */
export type IceMode = 'standard' | 'chaos';

export type PendingKind =
  | 'peek'
  | 'choose-card'
  | 'choose-player'
  | 'choose-accusation'
  | 'simultaneous';

/**
 * A prompt shown to the viewer. Every blocking prompt has a `choiceId`; the
 * client answers with `{ type: 'resolve', choiceId, ... }`.
 *
 * `blocking: false` is informational only (private peeks); no resolve is due.
 */
export interface IcePendingView {
  kind: PendingKind;
  choiceId: string;
  label: string;
  blocking: boolean;
  actorId: string | null;
  /** userIds that still owe a response. */
  awaiting: string[];
  /** Short machine-readable hint, e.g. "exchange", "peek-hand", "infection". */
  purpose?: string;
  /** Number of options in the source pile (useful for blind piles). */
  count?: number;
  /** Where the card is chosen from. */
  from?: 'hand' | 'discard' | 'preservation';

  /** Visible card options (hand / discard; omitted for face-down preservation). */
  cards?: CardView[];
  /** Choose-player candidates. */
  candidates?: { userId: string; name: string }[];
  /** Choose-accusation source piles (players with at least one card). */
  sources?: { playerId: string; name: string; count: number }[];

  /** Simultaneous choice data. */
  participants?: string[];
  submitted?: string[];
  /** Your own hand for a simultaneous choice. */
  options?: CardView[];

  /** Peek payloads. */
  source?: 'hand' | 'preservation' | 'identity-holders';
  players?: { userId: string; name: string }[];
  note?: string;
  targetPlayerId?: string;
}

export interface IcePlayerView {
  userId: string;
  name: string;
  seat: number;
  handCount: number;
  accusationCount: number;
  connected: boolean;
  /** Face-up cards in front of the player (currently only 【感染者】). */
  front: CardView[];
  /** Spectators (or everyone after the game) see the final identity. */
  identity?: CardView | null;
  /** Spectators only: every hand face up. */
  hand?: CardView[];
}

export interface IceView {
  schema: 'ice-v1';
  phase: IcePhase;
  /** Compatibility alias for the platform shell, which reads `view.status`. */
  status: IcePhase;
  config: {
    /** 标准规则 ice / 混沌规则 ice-chaos. */
    mode: IceMode;
    playerCount: number;
    preservationThreshold: number;
    deckSize: number;
    startingHandSize: number;
    /** 每个决策（回合行动或 pending 选择）的服务端超时毫秒数. */
    decisionTimeoutMs: number;
    /** 当前决策距离超时还剩多少毫秒；0 表示没有计时（waiting/finished/已关闭）. */
    decisionRemainingMs: number;
  };
  you: null | {
    userId: string;
    seat: number;
    hand: CardView[];
    /** The last card, once the player is down to one card. */
    identity: CardView | null;
    /** The prompt addressed to you, if any. */
    pending: IcePendingView | null;
  };
  players: IcePlayerView[];
  piles: {
    preservation: { count: number; cards?: CardView[] };
    accusations: { playerId: string; count: number; cards?: CardView[] }[];
    discard: { count: number; cards: CardView[] };
  };
  turn: { playerId: string; index: number } | null;
  pending: IcePendingView | null;
  log: { ts: number; text: string }[];
  result?: IceResultView;
}

export interface IceResultView {
  winners: { userId: string; name: string; reason: string }[];
  outcomes: { userId: string; name: string; win: boolean; reason: string }[];
  success: boolean;
  reason: string;
  category: string;
  imprisoned: string[];
  accusationTotals: {
    userId: string;
    name: string;
    total: number;
    imprisoned: boolean;
  }[];
  preservation: { total: number; threshold: number; success: boolean; cards: CardView[] };
  identities: { userId: string; name: string; card: CardView | null }[];
  reveal: {
    hands: { userId: string; cards: CardView[] }[];
    accusations: { playerId: string; cards: CardView[] }[];
    preservation: CardView[];
    discard: CardView[];
  };
}

/** Actions accepted by the worker. */
export type IceAction =
  | {
      type: 'use';
      cardId: string;
      targetPlayerId?: string;
      /** Optional UI label; ignored by the worker. */
      label?: string;
    }
  | {
      type: 'accuse';
      cardId: string;
      targetPlayerId: string;
      label?: string;
    }
  | { type: 'preserve'; cardId: string; label?: string }
  | {
      type: 'resolve';
      choiceId: string;
      cardId?: string;
      targetPlayerId?: string;
      /** Zero-based index for face-down piles (防腐堆 / 质疑堆). */
      index?: number;
      label?: string;
    }
  | { type: 'ready'; label?: string };

export interface IceActionResult {
  ok: boolean;
  error?: string;
  code?: string;
}

/** Card keys that the worker can place face down without revealing. */
export type HiddenPile = 'preservation' | 'accusations';

export interface IceLogEntry {
  ts: number;
  text: string;
}

export type { CardKey, CardView };
