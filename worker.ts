import { WebSocket } from 'ws';
import { IceMatch } from './game.js';
import { metadataForMode, modeForGameId } from './metadata.js';
import type { GameToPlatform, PlatformToGame } from '../../protocol/protocol.js';

const matchId = process.env.MATCH_ID;
const platformUrl = process.env.PLATFORM_WS_URL;
const secret = process.env.GAME_SECRET;
const gameId = process.env.GAME_ID;
const mode = modeForGameId(gameId);

if (!matchId || !platformUrl || !secret || !mode) {
  console.error(
    '[ice-worker] MATCH_ID, PLATFORM_WS_URL, GAME_SECRET and GAME_ID=ice|ice-chaos are required',
  );
  process.exit(2);
}

const metadata = metadataForMode(mode);

const ws = new WebSocket(platformUrl);
let game: IceMatch | null = null;
let registered = false;

const send = (message: GameToPlatform) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
};

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      v: 1,
      t: 'register',
      secret,
      matchId,
      game: metadata,
    } satisfies GameToPlatform),
  );
});

ws.on('message', (raw) => {
  let message: PlatformToGame | { t: string; ok?: boolean; error?: string };
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }

  if (!registered) {
    if (message.t !== 'register.ack') return;
    if (!('ok' in message) || !message.ok) {
      console.error('[ice-worker] register rejected:', message.error ?? 'unknown');
      process.exit(3);
    }
    registered = true;
    console.log(`[ice-worker] matched ${matchId}`);
    return;
  }

  if (message.t === 'register.ack') return;

  if (message.t === 'match.create') {
    if (game) return;
    const create = message as Extract<PlatformToGame, { t: 'match.create' }>;
    try {
      game = new IceMatch({
        matchId: create.matchId,
        seats: create.seats,
        mode,
        send,
      });
      console.log(
        `[ice-worker] created ${mode} match ${create.matchId} with ${create.seats.length} seats`,
      );
    } catch (error) {
      console.error('[ice-worker] could not create match:', (error as Error).message);
      send({
        v: 1,
        t: 'error',
        matchId: create.matchId,
        code: 'E_SETUP',
        message: `ice setup failed: ${(error as Error).message}`,
      });
      process.exit(4);
    }
    return;
  }

  game?.handle(message as PlatformToGame);
});

ws.on('close', (code) => {
  console.log(`[ice-worker] platform closed (${code})`);
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('[ice-worker] websocket error:', error.message);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    game?.abort();
    ws.close();
    process.exit(0);
  });
}
