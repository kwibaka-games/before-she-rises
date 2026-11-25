/**
 * Pure end-game settlement for 《冰冷的她醒来之前》.
 *
 * Separated from the state machine so it can be unit-tested with crafted hands
 * and so the "victory priority ladder" has exactly one implementation.
 */
import {
  STUDENT_KEYS,
  preservationThreshold,
  sumWeight,
  type CardKey,
} from './cards.js';

export interface SettlementPlayer {
  userId: string;
  name: string;
  /** The single card left in hand at the end of the game. */
  identity: CardKey | null;
  /** Face-down cards sitting in front of this player. */
  accusations: CardKey[];
}

export interface SettlementInput {
  players: SettlementPlayer[];
  preservation: CardKey[];
}

export type SettlementCategory =
  | 'alien'
  | 'infected'
  | 'culprit'
  | 'students'
  | 'homebody'
  | 'none';

export interface SettlementWinner {
  userId: string;
  name: string;
  reason: string;
}

export interface SettlementOutcome {
  userId: string;
  name: string;
  win: boolean;
  reason: string;
}

export interface SettlementResult {
  winners: SettlementWinner[];
  outcomes: SettlementOutcome[];
  /** Whether the preservation pile reached the threshold. */
  success: boolean;
  /** Human-readable summary of the decisive category. */
  reason: string;
  category: SettlementCategory;
  imprisoned: string[];
  accusationTotals: {
    userId: string;
    name: string;
    total: number;
    imprisoned: boolean;
  }[];
  preservationTotal: number;
  threshold: number;
  identities: { userId: string; name: string; card: CardKey | null }[];
  /** Convenience maps for the UI / result view. */
  culpritWin: boolean;
  alienWin: boolean;
  infectedWin: boolean;
}

const CATEGORY_LABEL: Record<SettlementCategory, string> = {
  alien: '外星人',
  infected: '感染者',
  culprit: '犯人 / 从犯',
  students: '普通学生',
  homebody: '归宅部',
  none: '无人',
};

const WIN_REASON: Record<SettlementCategory, string> = {
  alien: '被监禁（质疑权重最高）',
  infected: '防腐失败',
  culprit: '未被监禁',
  students: '防腐成功',
  homebody: '其他所有人均未胜利',
  none: '未满足胜利条件',
};

function isStudentKey(key: CardKey | null): boolean {
  return key !== null && STUDENT_KEYS.includes(key);
}

/**
 * Compute imprisonment.
 *
 * Rule: the player(s) with the highest accusation weight sum are imprisoned.
 * If every player has the same sum, nobody is imprisoned.
 */
function computeImprisonment(
  players: readonly SettlementPlayer[],
): { totals: number[]; imprisoned: boolean[] } {
  const totals = players.map((player) => sumWeight(player.accusations));
  const max = totals.length > 0 ? Math.max(...totals) : 0;
  const allEqual = totals.every((total) => total === max);
  const imprisoned = totals.map((total) => !allEqual && total === max);
  return { totals, imprisoned };
}

/**
 * Settle the game.
 *
 * Victory is a priority ladder, matching the rulebook:
 *   外星人 → 感染者 → 犯人/从犯 → 普通学生 → 归宅部
 *
 * A category whose condition is met but that has no holder is void (its win is
 * skipped and the next category is checked). The first category that both has
 * a met condition and at least one holder decides the game; lower-priority
 * identities do not also win.
 */
export function settleGame(input: SettlementInput): SettlementResult {
  const players = input.players;
  if (players.length < 3 || players.length > 6) {
    throw new Error(`cannot settle a ${players.length}-player game`);
  }

  const threshold = preservationThreshold(players.length);
  const preservationTotal = sumWeight(input.preservation);
  const success = preservationTotal >= threshold;

  const { totals, imprisoned } = computeImprisonment(players);
  const imprisonedSet = new Set(
    players.filter((_player, index) => imprisoned[index]).map((player) => player.userId),
  );

  const holdersOf = (key: CardKey): SettlementPlayer[] =>
    players.filter((player) => player.identity === key);

  const winners: SettlementWinner[] = [];
  let category: SettlementCategory = 'none';

  const aliens = holdersOf('alien');
  const alienImprisoned = aliens.filter((player) => imprisonedSet.has(player.userId));
  if (alienImprisoned.length > 0) {
    category = 'alien';
    for (const player of alienImprisoned) {
      winners.push({ userId: player.userId, name: player.name, reason: WIN_REASON.alien });
    }
  } else {
    const infected = holdersOf('infected');
    if (!success && infected.length > 0) {
      category = 'infected';
      for (const player of infected) {
        winners.push({ userId: player.userId, name: player.name, reason: WIN_REASON.infected });
      }
    } else {
      const culprits = holdersOf('culprit');
      const freeCulprits = culprits.filter((player) => !imprisonedSet.has(player.userId));
      if (freeCulprits.length > 0) {
        category = 'culprit';
        for (const player of freeCulprits) {
          winners.push({ userId: player.userId, name: player.name, reason: WIN_REASON.culprit });
        }
        for (const player of holdersOf('accomplice')) {
          winners.push({
            userId: player.userId,
            name: player.name,
            reason: '犯人在场且犯人胜利',
          });
        }
      } else {
        const students = players.filter((player) => isStudentKey(player.identity));
        if (success && students.length > 0) {
          category = 'students';
          for (const player of students) {
            winners.push({ userId: player.userId, name: player.name, reason: WIN_REASON.students });
          }
        } else {
          const homebodies = holdersOf('homebody');
          if (homebodies.length > 0) {
            category = 'homebody';
            for (const player of homebodies) {
              winners.push({ userId: player.userId, name: player.name, reason: WIN_REASON.homebody });
            }
          }
        }
      }
    }
  }

  const winnerIds = new Set(winners.map((winner) => winner.userId));
  const outcomes: SettlementOutcome[] = players.map((player) => {
    const win = winnerIds.has(player.userId);
    let reason: string;
    if (win) {
      reason = winners.find((winner) => winner.userId === player.userId)?.reason ?? '胜利';
    } else if (player.identity === null) {
      reason = '没有身份牌';
    } else if (category === 'none') {
      reason = '没有任何玩家的胜利条件达成';
    } else {
      reason = `${CATEGORY_LABEL[category]}胜利（${WIN_REASON[category]}），你的身份未获胜`;
    }
    return { userId: player.userId, name: player.name, win, reason };
  });

  const categoryLabel = CATEGORY_LABEL[category];
  const reason =
    category === 'none'
      ? `全体失败：没有人满足胜利条件（防腐${success ? '成功' : '失败'}，${preservationTotal}/${threshold}）`
      : `${categoryLabel}胜利：${winners.map((winner) => winner.name).join('、')}（${
          WIN_REASON[category]
        }）`;

  const identities = players.map((player) => ({
    userId: player.userId,
    name: player.name,
    card: player.identity,
  }));

  return {
    winners,
    outcomes,
    success,
    reason,
    category,
    imprisoned: players
      .filter((player) => imprisonedSet.has(player.userId))
      .map((player) => player.userId),
    accusationTotals: players.map((player, index) => ({
      userId: player.userId,
      name: player.name,
      total: totals[index] ?? 0,
      imprisoned: imprisoned[index] ?? false,
    })),
    preservationTotal,
    threshold,
    identities,
    culpritWin: category === 'culprit',
    alienWin: category === 'alien',
    infectedWin: category === 'infected',
  };
}
