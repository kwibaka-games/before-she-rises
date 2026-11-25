import type { GameMetadata } from '../../protocol/protocol.js';
import type { IceMode } from './types.js';

/**
 * The platform starts one worker per room and looks the worker up by game id.
 * The room owner chooses the rule set by creating a room for `ice` (standard)
 * or `ice-chaos` (chaos); the worker selects the matching metadata from
 * `GAME_ID`. This keeps the platform's room API unchanged.
 */

const BASE = {
  version: '0.1.0',
  protocol: 1,
  minPlayers: 3,
  maxPlayers: 6,
  author: 'kwibaka',
  spectatorChat: false,
} as const;

export const ICE_GAME: GameMetadata = {
  ...BASE,
  id: 'ice',
  name: '冰冷的她醒来之前（标准规则）',
  description:
    '丧尸封锁下的校园社交推理：为少女尸体防腐，同时找出凶手。3–6 人，标准规则（最后一张身份牌不可交换）。',
};

export const ICE_CHAOS_GAME: GameMetadata = {
  ...BASE,
  id: 'ice-chaos',
  name: '冰冷的她醒来之前（混沌规则）',
  description:
    '丧尸封锁下的校园社交推理。混沌规则：最后一张身份牌可以被交换，2 张手牌也能使用班长/新闻部/归宅部。3–6 人。',
};

export const ICE_GAME_IDS = ['ice', 'ice-chaos'] as const;
export type IceGameId = (typeof ICE_GAME_IDS)[number];

export function modeForGameId(gameId: string | undefined): IceMode | null {
  if (gameId === 'ice') return 'standard';
  if (gameId === 'ice-chaos') return 'chaos';
  return null;
}

export function metadataForMode(mode: IceMode): GameMetadata {
  return mode === 'chaos' ? ICE_CHAOS_GAME : ICE_GAME;
}
