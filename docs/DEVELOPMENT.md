# Developing Arbiter

## Requirements and checks

Use Node.js 14 or newer. The engine, trainer and tests have no runtime npm
dependencies.

```sh
npm run build
npm test
```

`npm run build` copies the engine, portable trainer and training controls into
the standalone browser page. `npm test` rejects a stale embedded page before
running the verification suite.

## Source layout

| Path | Responsibility |
| --- | --- |
| `arbiter-engine.js` | Chess rules, classical/neural evaluation, search and UCI |
| `training.js` | Portable self-play, replay, training, validation metrics and arena |
| `tools/train.js` | CLI arguments, checkpoint persistence and resume |
| `tools/match.js` | External UCI process lifecycle, paired matches, JSON and PGN |
| `tools/sync-browser.js` | Generate embedded browser sources; `--check` detects drift |
| `web/training-ui.js` | Training lab controls, storage, import/export and training worker |
| `index.html` | Browser layout, playing controls and generated source blocks |
| `test/` | Correctness and integration checks |

Edit the engine in `arbiter-engine.js`, trainer in `training.js`, and training
controls in `web/training-ui.js`. Rebuild afterward. Changes inside generated
blocks in `index.html` are overwritten. Board layout and playing controls live
in the page outside those blocks.

## Engine and learning interfaces

```js
const E = require('./arbiter-engine.js');
const independent = E.createEngine();
independent.loadNetwork(independent.createNetwork({ hidden: 32, seed: 1 }));
const result = independent.trainNetwork([
  { fen: '7k/8/8/8/8/8/P7/K7 w - - 0 1', target: 0.7 }
], { epochs: 4, learningRate: 0.01, seed: 1 });
console.log(result.lossBefore, result.lossAfter);
const model = independent.exportNetwork();
```

Targets are side-to-move probabilities in `[0, 1]`. `createNetwork` constructs
weights without loading them. `loadNetwork(null)` selects classical evaluation.
`evaluateClassical(position)` bypasses the network. `networkInfo()` describes
the active model. Loading or training weights clears cached search scores.
Engine instances keep weights and search tables separate.

```js
const trainer = require('./training.js')(independent);
const generation = trainer.runGeneration(null, null, {
  selfPlayGames: 8, arenaGames: 40, maxPlies: 240,
  moveTime: 10, maxDepth: 3, epochs: 4
});
```

`runGeneration(champion, replay, options, onProgress)` is synchronous. It returns
`candidate`, `champion`, `promoted`, `replay` and `report`. Pass the returned
champion and replay into the next call. The CLI handles persistence; browser
training runs the same code inside a worker.

Library option names differ from CLI flags: `selfPlayGames` maps to `--games`,
`arenaGames` to `--arena-games`, `moveTime` to `--movetime`, `maxDepth` to
`--depth`, `maxPlies` to `--max-plies`, and `maxReplay` to `--replay-size`.
The portable trainer's default cap is 160 plies and default epochs is 3;
the CLI and browser explicitly use 240 plies and 4 epochs.

## Verification coverage

- `test/perft.js`: 26 standard move-generation counts, including castling,
  en passant, promotions and pins.
- `test/engine.js`: evaluation symmetry, sampled SEE correctness, SAN
  round-trips and known tactics.
- `test/neural.js`: learning, validation, deterministic updates, model copies,
  serialization, score bounds, symmetry and classical fallback.
- `test/training.js`: replay/RNG resume, permanent game partitions, truncation,
  candidate continuation, paired confidence gates and error restoration.
- `test/match.js`: fake UCI process integration, model loading, pairing, legal
  moves, malformed responses, timeouts, cleanup and JSON/PGN output.
- `test/platform.js`: search labels, isolated engines, UCI model selection,
  CLI checkpoint/settings resume and stale browser-search rejection.

Browser checks should also cover playing a move, starting a new game during
search, importing valid/invalid models, training start/stop, a completed
generation, checkpoint export and persistence across reload. These UI checks
are separate from the dependency-free `npm test` suite.

## Change and release guidance

Preserve existing model format validation or version incompatible formats.
Keep the classical evaluator available. Changes to score scale affect training
labels and should be evaluated deliberately. Avoid mixing held-out games into
training or counting capped games as draws.

Use real paired matches to judge playing strength; a tactical pass or lower
training loss is insufficient evidence. Publish settings, game counts and
uncertainty with any rating claim. Individual arena confidence bounds do not
provide a guarantee across indefinitely repeated candidate tests.

Before uploading changes, rebuild, run `npm test`, and run `git diff --check`.
Training output under `.arbiter-training/` and `node_modules/` are ignored by
Git. Back up weights separately if they need to be preserved or shared.
