/**
 * Static card data for 《冰冷的她醒来之前》.
 *
 * Every card is both a hand resource and (usually) the player's final identity.
 * The table below is a direct transcription of docs/game-rules/before-she-rises.md;
 * the only extra information is the per-player-count override list (`variants`),
 * which the rule table keeps in the "数量" column footnotes.
 */

export type CardKey =
  | 'alien'
  | 'infected'
  | 'culprit'
  | 'accomplice'
  | 'president'
  | 'monitor'
  | 'honors'
  | 'discipline'
  | 'health'
  | 'library'
  | 'ojou'
  | 'news'
  | 'homebody';

/** The victory condition printed on a card. */
export type VictoryCategory =
  | 'imprisoned' // 被监禁
  | 'preservation-failed' // 防腐失败
  | 'not-imprisoned' // 未被监禁
  | 'culprit-wins' // 犯人在场且犯人胜利
  | 'preservation-succeeded' // 防腐成功
  | 'others-failed'; // 其他所有人均未胜利

export interface CardDefinition {
  key: CardKey;
  name: string;
  weight: number;
  victory: VictoryCategory;
  victoryText: string;
  text: string;
  victoryOrder: number;
  /** Number of copies in the base (4/6 player) deck. */
  baseCount: number;
  /** Per-player-count overrides (3 players / 5 players). */
  variants?: Partial<Record<number, number>>;
}

export const CARD_DEFS: Record<CardKey, CardDefinition> = {
  alien: {
    key: 'alien',
    name: '外星人',
    weight: -1,
    victory: 'imprisoned',
    victoryText: '被监禁',
    text: '无效果。此牌可以混淆【优等生】的效果。',
    victoryOrder: 1,
    baseCount: 1,
  },
  infected: {
    key: 'infected',
    name: '感染者',
    weight: 0,
    victory: 'preservation-failed',
    victoryText: '防腐失败',
    text:
      '将该牌正面置于你的面前（而非进入弃牌堆）。若在你的下个回合开始时此牌仍在你的面前，' +
      '则选择防腐堆中的一张牌置入你的手牌，随后将【感染者】置入弃牌堆。',
    victoryOrder: 2,
    baseCount: 1,
  },
  culprit: {
    key: 'culprit',
    name: '犯人',
    weight: 0,
    victory: 'not-imprisoned',
    victoryText: '未被监禁',
    text: '这张牌不能以任何方式被使用。',
    victoryOrder: 3,
    baseCount: 1,
  },
  accomplice: {
    key: 'accomplice',
    name: '从犯',
    weight: 0,
    victory: 'culprit-wins',
    victoryText: '犯人在场且犯人胜利',
    text: '选择任一玩家的质疑堆中的一张牌，将其移到另一位玩家的质疑堆。',
    victoryOrder: 3,
    baseCount: 1,
    variants: { 3: 0 },
  },
  president: {
    key: 'president',
    name: '学生会长',
    weight: 3,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '无效果。游戏开始时，持有该牌的玩家为起始玩家。',
    victoryOrder: 4,
    baseCount: 1,
  },
  monitor: {
    key: 'monitor',
    name: '班长',
    weight: 2,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '选择任一其他玩家，你与该玩家选择一张手牌，同时置入对方的手牌。',
    victoryOrder: 4,
    baseCount: 2,
  },
  honors: {
    key: 'honors',
    name: '优等生',
    weight: 2,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '秘密定位持有犯人和外星人的玩家，但你无法区分他们。',
    victoryOrder: 4,
    baseCount: 2,
    variants: { 3: 1 },
  },
  discipline: {
    key: 'discipline',
    name: '风纪委员',
    weight: 1,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '选择任意其他玩家，你查看他的手牌。',
    victoryOrder: 4,
    baseCount: 2,
    variants: { 3: 1 },
  },
  health: {
    key: 'health',
    name: '保健委员',
    weight: 1,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '选择弃牌堆中的一张牌置入你的手牌。',
    victoryOrder: 4,
    baseCount: 2,
  },
  library: {
    key: 'library',
    name: '图书委员',
    weight: 1,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '你查看防腐堆。',
    victoryOrder: 4,
    baseCount: 2,
    variants: { 5: 3 },
  },
  ojou: {
    key: 'ojou',
    name: '大小姐',
    weight: 1,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text:
      '选择任意其他玩家，随机指定其1张手牌并将其置入你的手牌。' +
      '然后选择手牌中的1张牌置入该玩家的手牌。',
    victoryOrder: 4,
    baseCount: 3,
    variants: { 3: 2 },
  },
  news: {
    key: 'news',
    name: '新闻部',
    weight: 1,
    victory: 'preservation-succeeded',
    victoryText: '防腐成功',
    text: '所有玩家选择手牌中的一张牌，同时将其置入上家的手牌。',
    victoryOrder: 4,
    baseCount: 3,
    variants: { 3: 2 },
  },
  homebody: {
    key: 'homebody',
    name: '归宅部',
    weight: 0,
    victory: 'others-failed',
    victoryText: '其他所有人均未胜利',
    text: '选择防腐堆中的一张牌，与手牌中的一张牌交换。',
    victoryOrder: 5,
    baseCount: 3,
    variants: { 3: 2 },
  },
};

export const CARD_KEYS = Object.keys(CARD_DEFS) as CardKey[];

/** Cards whose identity wins when preservation succeeds. */
export const STUDENT_KEYS: readonly CardKey[] = [
  'president',
  'monitor',
  'honors',
  'discipline',
  'health',
  'library',
  'ojou',
  'news',
];

export const SUPPORTED_PLAYER_COUNTS = [3, 4, 5, 6] as const;
export type SupportedPlayerCount = (typeof SUPPORTED_PLAYER_COUNTS)[number];

/** Preservation threshold by player count. */
export const PRESERVATION_THRESHOLD: Record<SupportedPlayerCount, number> = {
  3: 9,
  4: 8,
  5: 7,
  6: 6,
};

export function assertPlayerCount(playerCount: number): asserts playerCount is SupportedPlayerCount {
  if (!SUPPORTED_PLAYER_COUNTS.includes(playerCount as SupportedPlayerCount)) {
    throw new Error(`unsupported player count: ${playerCount}`);
  }
}

export function isSupportedPlayerCount(playerCount: number): playerCount is SupportedPlayerCount {
  return SUPPORTED_PLAYER_COUNTS.includes(playerCount as SupportedPlayerCount);
}

/** Number of copies of every card for a given player count. */
export function cardCounts(playerCount: number): Record<CardKey, number> {
  assertPlayerCount(playerCount);
  const counts = {} as Record<CardKey, number>;
  for (const key of CARD_KEYS) {
    const definition = CARD_DEFS[key];
    counts[key] = definition.variants?.[playerCount] ?? definition.baseCount;
  }
  return counts;
}

export function deckSize(playerCount: number): number {
  return Object.values(cardCounts(playerCount)).reduce((sum, count) => sum + count, 0);
}

export function startingHandSize(playerCount: number): number {
  return deckSize(playerCount) / playerCount;
}

export function preservationThreshold(playerCount: number): number {
  assertPlayerCount(playerCount);
  return PRESERVATION_THRESHOLD[playerCount];
}

export function cardWeight(key: CardKey): number {
  return CARD_DEFS[key].weight;
}

export function sumWeight(keys: readonly CardKey[]): number {
  return keys.reduce((sum, key) => sum + CARD_DEFS[key].weight, 0);
}

export interface Card {
  /** Unique physical-card instance id, e.g. "ojou-2". */
  id: string;
  key: CardKey;
}

/** A card as exposed to a browser view. */
export interface CardView {
  id: string;
  key: CardKey;
  name: string;
  weight: number;
  victory: VictoryCategory;
  victoryText: string;
  text: string;
  victoryOrder: number;
  special?: string;
}

export function toCardView(card: Card): CardView {
  const definition = CARD_DEFS[card.key];
  return {
    id: card.id,
    key: definition.key,
    name: definition.name,
    weight: definition.weight,
    victory: definition.victory,
    victoryText: definition.victoryText,
    text: definition.text,
    victoryOrder: definition.victoryOrder,
  };
}

/** Build the ordered (unshuffled) deck for a player count. */
export function createDeck(playerCount: number): Card[] {
  const counts = cardCounts(playerCount);
  const cards: Card[] = [];
  for (const key of CARD_KEYS) {
    for (let copy = 0; copy < counts[key]; copy += 1) {
      cards.push({ id: `${key}-${copy + 1}`, key });
    }
  }
  return cards;
}

/** Verify that a custom deck is exactly one legal deck for the player count. */
export function validateDeckKeys(keys: readonly CardKey[], playerCount: number): void {
  const expected = cardCounts(playerCount);
  const actual = new Map<CardKey, number>();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(CARD_DEFS, key)) {
      throw new Error(`unknown card key: ${String(key)}`);
    }
    actual.set(key, (actual.get(key) ?? 0) + 1);
  }
  for (const key of CARD_KEYS) {
    const count = actual.get(key) ?? 0;
    if (count !== expected[key]) {
      throw new Error(`deck mismatch for ${key}: expected ${expected[key]}, got ${count}`);
    }
  }
  if (keys.length !== deckSize(playerCount)) {
    throw new Error(`deck size mismatch: expected ${deckSize(playerCount)}, got ${keys.length}`);
  }
}
