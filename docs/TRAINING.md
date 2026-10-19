# Training Arbiter

Arbiter learns an optional neural correction to its classical evaluation.
There are no pretrained weights in the repository. Until a candidate passes
the arena gate, a fresh installation continues playing with the classical
engine. Importing a model explicitly selects those weights without an arena.

## Browser workflow

1. Open `index.html` in a JavaScript-capable browser, or visit the hosted app.
2. Scroll below the board to **Self-training lab**.
3. Select **Start training**. Self-play, training and candidate matches run in
   a separate worker, allowing the board to remain usable.
4. Select **Stop** to end training. The unfinished generation is discarded;
   completed generations remain saved in this browser.
5. Select **Export checkpoint** to keep a durable backup or transfer learning
   to another device. Select **Import model / checkpoint** to restore it.

The browser budget is fixed at 8 self-play games, 40 arena games, 10 ms per
move, depth at most 3, 240 total plies per game, 4 training passes and a
2,000-position replay limit. Use the CLI for larger budgets. A checkpoint
imported into the browser must contain no more than 20,000 replay positions;
files larger than 20 MB are rejected.

Browser storage belongs to the current origin and browser profile. Switching
hosts or browsers does not transfer it. Clearing site data removes it, and
storage quotas may prevent saving. Export a checkpoint when the lab reports a
saving problem. Browser training uses CPU and battery and requires Web Workers.

**Export candidate** downloads the latest candidate from the current session.
A candidate may have failed its arena and should not be assumed stronger.
**Reset learning** restores the classical evaluator and replaces the local
learning checkpoint. Export a backup before resetting progress you want to keep.

## Command-line workflow

Node.js 14 or newer is required. No npm dependencies need to be installed.
Run commands from the repository directory.

```sh
npm run train -- --generations 1
npm run train -- --continuous
```

Run `npm run train -- --help` for the command summary.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--generations` | `1` | Completed generations to run |
| `--continuous` | off | Continue until the process is stopped |
| `--games` | `8` | Self-play games per generation |
| `--arena-games` | `40` | Candidate/champion games; must be even |
| `--movetime` | `10` | Maximum thinking time per move in milliseconds |
| `--depth` | `3` | Maximum search depth |
| `--max-plies` | `240` | Game cap, including opening-prefix plies |
| `--epochs` | `4` | Passes over the training partition |
| `--learning-rate` | `0.01` | Neural SGD step size, greater than zero and at most one |
| `--replay-size` | `20000` | Maximum retained replay positions |
| `--seed` | `1` | Unsigned 32-bit random seed |
| `--output` | `.arbiter-training` | Destination directory |
| `--resume` | automatic | Explicit checkpoint to read |

Larger budgets improve label depth and statistical power but cost more compute.
For example:

```sh
npm run train -- --continuous --games 128 --arena-games 1000 \
  --movetime 100 --depth 8 --max-plies 400 --epochs 8 --replay-size 100000
```

The existing `OUTPUT/checkpoint.json` resumes automatically. Saved training
settings are restored unless overridden by explicit flags. `--generations`
and `--continuous` select how long this invocation runs.

To import a browser checkpoint into a new output directory:

```sh
npm run train -- --resume /path/to/arbiter-checkpoint.json --output imported-run
```

`--resume` selects the input checkpoint; new files are written to `--output`.
Use a separate output directory for each independent trainer. Ctrl-C may
interrupt the current generation; the last completed checkpoint is retained.
Each JSON file is replaced atomically, but the collection of output files is
not a single filesystem transaction. Resume from `checkpoint.json`.

| Output file | Contents |
| --- | --- |
| `checkpoint.json` | Champion, generation, replay, candidate continuation, RNG state and report |
| `champion.json` | Raw playing network, or JSON `null` for classical evaluation |
| `candidate.json` | Latest candidate network, or `null` when no candidate was trained |
| `reports/generation-N.json` | Settings, losses, self-play outcomes and arena evidence |

Generated training data is ignored by Git. Export and back up valuable runs
separately; publishing source code does not publish trained weights.

## Labels, replay and model selection

The default network has 768 sparse piece-square inputs, 32 clipped-ReLU hidden
units and a shared scalar output for each colour-relative board view. The
output difference adds a correction bounded to 2,000 centipawns. New networks
have zero output weights, preserving the classical score before training.
This is a residual network, not an incremental NNUE implementation.

Self-play uses seeded opening prefixes. Sampled positions exclude check,
capturing/promotion best moves, mate-like scores and incomplete search
iterations. Scores become side-to-move probabilities with `sigmoid(cp / 400)`.
For completed games, targets mix search probability and actual result equally.
For capped games, targets contain only search probability; no draw is invented.

Replay retains a bounded number of recent positions. Whole games receive
permanent training or held-out partitions. Reports include mean squared error
and cross-entropy for both partitions. Rejected candidate weights continue
training in later generations while the playing champion remains selected.
When the champion changes, candidate continuation starts from that champion.

The arena reuses each opening with colours reversed and applies the same
search budget to both models. It uses a conservative paired Hoeffding bound.
Promotion requires all of the following:

- At least 40 completed games in complete colour pairs.
- No incomplete opening pair anywhere in that arena.
- A 95% confidence lower bound on candidate score above 50%.

Forty games are a minimum, not a sufficient sample for small gains. A report
with incomplete pairs needs a larger game cap; an inconclusive complete arena
usually needs more games. Reducing prediction loss does not itself justify
promotion. Reported intervals apply to an individual arena, not the entire
history of repeatedly testing candidates.

Timed search can produce different games on different hardware or under
variable CPU load even with the same seed. The seed fixes the random choices,
not all timing-dependent search behavior. A loaded network adds evaluation
cost; any learned improvement must outweigh that cost in equal-budget games.

## Playing with trained weights

UCI `EvalFile` accepts a raw model such as `champion.json` or `candidate.json`.
It does not accept a full training checkpoint.

```text
uci
setoption name EvalFile value /full/path/to/champion.json
isready
position startpos
go movetime 3000
```

Use `setoption name EvalFile value <none>` to return to classical evaluation.
The browser imports either a raw model or a full checkpoint. Raw models carry
weights; checkpoints also carry replay and training progress.

## Measuring strength

```sh
npm run match -- --opponent /path/to/stockfish --games 200 --movetime 1000 \
  --model .arbiter-training/champion.json --out match.json --pgn match.pgn
```

The external opponent must speak UCI. `--opponent-arg` passes an argument to
its executable and may be repeated. `--opponent-elo 3000` is supported only
when the opponent advertises `UCI_LimitStrength` and `UCI_Elo`.
Run `npm run match -- --help` for all options.

Capped games are unscored. Relative Elo is calculated from complete opening
pairs; when games are capped, that estimate describes only those completed
pairs and may be biased by which games finished. Increase the cap before
using such results to judge strength. JSON `null` at an Elo interval endpoint
means an unbounded endpoint.

3000+ Elo remains an unverified development goal. An opponent's `UCI_Elo`
setting is not independent rating evidence. Establish absolute strength with
rated opponents, published hardware/time controls, balanced openings and
sufficient completed games. Keep match reports alongside model checkpoints.
