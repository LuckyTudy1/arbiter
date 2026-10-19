# Arbiter

A chess engine written from scratch in JavaScript, with an optional trainable
neural evaluator and a self-play training platform. No runtime dependencies or
external engine code. Runs in a browser, as a UCI engine, or as a library.

[Play Arbiter](https://luckytudy1.github.io/arbiter/)

[Plain-text quick start](QUICKSTART.txt) · [Training guide](docs/TRAINING.md) ·
[Development guide](docs/DEVELOPMENT.md) · [Changelog](CHANGELOG.md)

## Play and train in your browser

Open `index.html`, or serve it with any static host. The complete app, engine
and trainer are embedded in this file, so it also works offline.

The **Self-training lab** below the board provides:

- **Start training / Stop**: continuously generate self-play games, train a
  candidate network and test it against the champion in a separate Web Worker.
- Automatic local checkpoints after each completed generation. Stopping discards
  the unfinished generation and preserves the last checkpoint.
- Checkpoint export/import to continue on another device or in Node, candidate
  model export, and a reset to the classical evaluator.

Training uses this device's CPU and battery. Browser storage can be cleared or
fill up; export checkpoints for durable backups. If Web Workers are unavailable,
use the command-line trainer. Some mobile file viewers restrict JavaScript;
serving the page is more reliable than opening it from a file manager.

A new installation plays with the classical evaluator. Neural weights become
active after a candidate passes the match gate, or when you explicitly import a
model. Training and playing use separate engine instances.

## Train from the command line

Requires Node.js 14 or newer. No package installation is needed.

```sh
npm run train -- --generations 1
npm run train -- --continuous
```

The default generation uses 8 self-play games, 40 candidate/champion games,
10 ms per move, depth at most 3 and a 240-ply cap. These are inexpensive starting
settings for exercising the pipeline. For more useful search labels and a
larger evaluation sample, increase the budget, for example:

```sh
npm run train -- --continuous --games 128 --arena-games 1000 \
  --movetime 100 --depth 8 --max-plies 400 --epochs 8 --replay-size 100000
```

Use `--help` for all flags. Each generation writes to `.arbiter-training/`:

| Artifact | Purpose |
| --- | --- |
| `checkpoint.json` | Champion, replay positions, random-stream state, generation and report |
| `candidate.json` | Latest trained network, even if it was not promoted |
| `champion.json` | Playing network; JSON `null` means the classical evaluator |
| `reports/generation-N.json` | Training/held-out losses, results and uncertainty |

Existing output checkpoints resume automatically. Use `--output another-folder`
for an independent run or `--resume /path/to/arbiter-checkpoint.json` to import a
browser checkpoint. Saved settings, replay and random-stream state are
preserved; explicit flags override settings for the next generation. Each JSON
file is replaced atomically; resume from `checkpoint.json`. Stop with Ctrl-C;
the last completed generation remains available. An explicit `--resume` selects
the input file; subsequent checkpoints are written to `--output`.

### What learns

The original material, piece-square, mobility, pawn structure and king-safety
evaluation remains the foundation. A sparse **768 → 32 → 1** network learns a
bounded correction to it using clipped ReLU hidden activations and stochastic
gradient descent. The same weights evaluate both colour-relative board views;
subtracting the outputs preserves rank/colour symmetry. New networks have zero
output weights, reproducing the classical evaluation before training.

Self-play starts from seeded, varied opening prefixes. Quiet positions receive
a target combining the search's win probability and the eventual game result.
Games stopped at the ply cap have **no invented result**: their samples use only
the search target, and their truncation is recorded. Mate scores and positions
without a completed search iteration are excluded from training.

Replay is bounded. Training and held-out partitions are assigned by whole game
and remain fixed as replay grows, avoiding positions from the same game leaking
into both sets. Reports compare champion and candidate prediction losses.

A candidate plays the champion from identical openings with colours reversed,
at the same time/depth budget. Only complete game pairs count toward the score.
An arena with any unfinished pair cannot promote a candidate. Promotion
requires at least 40 scored games and a 95% paired confidence lower bound above
50%. The conservative bound often needs substantially more than 40 games to
demonstrate a small gain. A failed or inconclusive candidate leaves
the champion in place; its candidate weights and generated positions remain
in replay for the next generation.

There are no bundled pretrained weights. Self-play can reinforce existing
mistakes, and the neural evaluator adds search cost. Better prediction loss
alone does not prove stronger play; the match gate measures that tradeoff.

## Strength and the 3000+ Elo goal

**3000+ Elo is a development target, not an achieved or guaranteed rating.**
Adding a network and a training loop does not establish playing strength. This
release has not been rated in an external tournament.

Earlier documentation reported about 2530 from 24 fast games against
strength-limited Stockfish, then extrapolated roughly 2800 at a longer thinking
time. The latter was an estimate, not a measured rating at that time control.
Those historical results have not been rerun for this version.

Use the included UCI match runner to gather external evidence:

```sh
npm run match -- --opponent /path/to/stockfish --games 200 --movetime 1000 \
  --model .arbiter-training/champion.json --out match-results.json
```

An optional `--opponent-elo 3000` sets the opponent's advertised
`UCI_LimitStrength` / `UCI_Elo` controls. That setting is not an independently
rated opponent. Match reports show wins/draws/losses, incomplete games, relative
Elo and uncertainty; they do not assign Arbiter an absolute rating. Run
`npm run match -- --help` for opening, seed, cap and timeout options.

To establish 3000+, test against independently rated opponents under published
hardware and time controls, using many balanced opening pairs and enough games
to narrow the interval. Preserve reports, check tactical regressions, and judge
changes by results. Stockfish is an optional opponent only; none of its code or
weights is used by Arbiter.

## UCI and library use

Start the engine:

```sh
node arbiter-engine.js
```

```text
uci
setoption name EvalFile value /full/path/to/champion.json
isready
position startpos moves e2e4 e7e5
go movetime 3000
```

`EvalFile` accepts a raw exported network or JSON `null`. Use
`setoption name EvalFile value <none>` to restore classical evaluation. Invalid
models are rejected before active weights change. Paths may contain spaces.
`Skill` remains available from 1 to 5.

Chess GUIs and [lichess-bot](https://github.com/lichess-bot-devs/lichess-bot)
can launch Arbiter through a wrapper:

```sh
#!/bin/sh
exec node /full/path/to/arbiter-engine.js
```

On Windows:

```bat
@echo off
node "%~dp0arbiter-engine.js" %*
```

```js
const fs = require('fs');
const E = require('./arbiter-engine.js');
E.loadNetwork(JSON.parse(fs.readFileSync('champion.json', 'utf8')));
const pos = new E.Position();
const result = E.think(pos, { moveTime: 2000 });
console.log(E.toSAN(pos, result.best), result.depth, result.score);

// Independent engine instances have their own weights and search tables.
const other = E.createEngine();
const trainer = require('./training.js')(other);
const generation = trainer.runGeneration(null, null, {
  selfPlayGames: 8, arenaGames: 40, moveTime: 10, maxDepth: 3
});
```

Neural APIs: `createNetwork({ hidden, seed })`, `loadNetwork(modelOrNull)`,
`exportNetwork()`, `networkInfo()`, `evaluateClassical(pos)`, and
`trainNetwork([{ fen, target }], { epochs, learningRate, seed })`. Targets are
side-to-move probabilities in `[0, 1]`; training requires a loaded network.
Models are versioned and validated for shape, finite bounded weights and
metadata. The serialized format is shared by Node and the browser.

## Engine and development

The engine uses a 0x88 board, packed moves, iterative-deepening alpha-beta,
transposition tables, null-move pruning, late move reductions, quiescence search,
SEE, killer/history ordering, aspiration windows and a small opening book.
Evaluation blends middlegame and endgame terms. The network is an optional
residual evaluator, not an incremental NNUE implementation.

| File | Purpose |
| --- | --- |
| `arbiter-engine.js` | Engine, neural evaluator, model format and UCI driver |
| `training.js` | Portable self-play, replay, training and match gate |
| `tools/train.js` | Resumable command-line trainer |
| `tools/match.js` | External UCI opponent measurement |
| `web/training-ui.js` | Browser lab controls and worker lifecycle |
| `index.html` | Complete offline playing and training app |
| `test/` | Move generation, tactics, learning and platform checks |
| `docs/` | Detailed training and development guides |
| `QUICKSTART.txt` | Plain-text setup and training instructions |
| `CHANGELOG.md` | Version 3.0.0 changes |

After editing engine, training or browser lab source, update the embedded page:

```sh
npm run build
npm test
```

The suite checks the browser embedding is current, standard perft counts,
evaluation symmetry, SEE, SAN, tactics, neural learning/serialization/validation,
replay partitions, truncation, promotion statistics, UCI handling and checkpoint
resume. Training/search label regressions include forced-move scores and
checkmate taking precedence over the fifty-move draw rule.

## Licence

MIT. See `LICENSE`.
