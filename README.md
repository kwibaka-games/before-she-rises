# before-she-rises

《冰冷的她醒来之前》 / *Before She Rises* — game implementation for the
[kwibaka-boardgame-platform](https://github.com/kwibaka-games/boardgame-platform).

This repository is designed to be mounted as the `src/games/ice` submodule of
the host platform. It contains the rules engine, worker entrypoint, metadata
for both `ice` (standard) and `ice-chaos` (chaos) catalogs, and the browser UI
module + card art.

## Host integration

The host expects the shared protocol at `../../protocol/protocol.js` and passes
`GAME_ID`, `SEATS_JSON`, `MATCH_ID`, `PLATFORM_WS_URL` and `GAME_SECRET` to the
worker. See the host documentation:

- [Game & frontend interface](https://github.com/kwibaka-games/boardgame-platform/blob/main/docs/en/interfaces.md)
- [Game testing](https://github.com/kwibaka-games/boardgame-platform/blob/main/docs/en/testing.md)

## Layout

```text
cards.ts / types.ts / settle.ts / game.ts   rules engine
metadata.ts                                standard + chaos metadata
worker.ts                                  platform worker entrypoint
web/ice.js, web/ice-chaos.js               browser modules
web/cards/*.webp                           card art
```

## License

AGPL-3.0-only. See `LICENSE`.
