# Arbiter

A chess engine written from scratch in JavaScript. No dependencies, no neural
network, no code borrowed from another engine. Roughly **2800 Elo**.

It runs in a browser tab, as a command-line UCI engine, or as a library.

[[**Play it here**]((https://luckytudy1.github.io/arbiter/))]

---

## What's in the box

| File | What it is |
|---|---|
| `index.html` | The complete web app — board, rules, engine, all in one file (80 KB) |
| `arbiter-engine.js` | The engine on its own, speaking UCI. Works with any chess GUI |
| `test/` | The verification suite. Run it yourself |

---

## Playing it

**In a browser.** Open `index.html`. That's the whole installation. It works
offline and there's no server involved.

Note: on iOS, opening a downloaded HTML file from the Files app may not run
JavaScript properly. Host it somewhere and open the link instead — GitHub Pages
works well, and drag-and-drop hosts like Netlify Drop take about ten seconds.

**In a chess GUI.** Arbiter speaks UCI, so it loads into Arena, Cute Chess,
BanksiaGUI, or anything else that takes an engine. Those expect an executable,
so wrap it in a two-line launcher:

```sh
#!/bin/sh
exec node /full/path/to/arbiter-engine.js
```

`chmod +x` that and point the GUI at it. On Windows use a `.bat` file:

```bat
@echo off
node "%~dp0arbiter-engine.js" %*
```

**As a Lichess bot.** Arbiter works with
[lichess-bot](https://github.com/lichess-bot-devs/lichess-bot) out of the box.
Point the `engine` section of its `config.yml` at the launcher script above and
your bot is playable by anyone in the world.

**From the command line.**

```
$ node arbiter-engine.js
uci
position startpos moves e2e4 e7e5
go movetime 3000
```

**As a library.**

```js
const E = require('./arbiter-engine.js');

const pos = new E.Position();                 // or new E.Position(fen)
const result = E.think(pos, { moveTime: 2000 });

console.log(E.toSAN(pos, result.best));       // "e4"
console.log(result.depth, result.score);      // 12, 25
```

---

## Strength

**~2800 Elo** at 6 seconds per move. Measured, not estimated.

The method: play it against Stockfish with `UCI_LimitStrength` set to fixed
values and find where it scores 50%. At 200 ms per move, over 24 games from a
six-opening suite played from both colours:

| Opponent | Result | Score | Implied rating |
|---|---|---|---|
| Stockfish @ 2400 | +6 −3 =3 | 62.5% | 2489 |
| Stockfish @ 2600 | +4 −5 =3 | 45.8% | 2571 |

Two brackets agreeing on **~2530 at fast time control**. Thinking time is worth
roughly 50–70 Elo per doubling, which puts the full-strength setting near 2800.

Confidence interval on 24 games is about ±150 Elo. Treat the number as a range,
not a decimal point.

**Stockfish was used only as a measuring stick.** None of its code is in this
project, and the engine has no dependency on it. If you want a stronger engine,
use Stockfish — it's about 3650 and freely available. Arbiter exists to be
small, readable, and entirely self-contained.

---

## How it works

**Board.** 0x88 representation — a 16×8 array where off-board squares are
detected with a single bitwise AND. Moves are packed into integers: origin,
destination, promotion, captured piece, and flags for en passant, castling, and
double pawn pushes.

**Search.** Iterative deepening alpha-beta with:

- Transposition table (2M entries, two buckets, Zobrist hashed)
- Null-move pruning
- Late move reductions on a logarithmic schedule
- Futility pruning, reverse futility, razoring, late move pruning
- Static exchange evaluation for move ordering and pruning losing captures
- Killer moves, counter-moves, butterfly history
- Quiescence search with delta pruning
- Aspiration windows
- Check extensions, mate distance pruning

**Evaluation.** Tapered between middlegame and endgame by material phase:

- Material and piece-square tables
- Mobility, counted excluding squares attacked by enemy pawns
- King danger from weighted attacker counts, plus pawn shield and open files
- Passed, isolated, doubled and defended pawns; passers weighted by king distance
- Knight and bishop outposts, rooks on open files and the seventh rank
- Bishop pair, tempo, drawish-endgame scaling, lone-king mate driving

**Opening book.** 38 mainline openings, replayed at load time into a position
table, with weighted random selection for variety.

Depth reached is typically 9–15 in two seconds, and considerably more in
simplified endgames.

---

## Testing

```
npm test
```

Or individually:

```
node test/perft.js      # move generator: 26 checks, ~11M nodes
node test/engine.js     # evaluation, SEE, SAN, tactics
```

`perft.js` counts every legal move sequence to a fixed depth from six positions
chosen to exercise castling, en passant, promotion and pins, and compares against
the standard reference counts. If the move generator is wrong anywhere, this
catches it.

`engine.js` checks that evaluation is exactly symmetric when the board is
mirrored and colours swapped, that static exchange evaluation matches a
brute-force capture search, that move notation round-trips through the parser,
and that the search finds known tactics.

---

## Contributing

The interesting work is in evaluation tuning — the weights are hand-chosen and
almost certainly leave 100+ Elo on the table. If you change something, prove it
with games rather than intuition; at this level a real improvement is worth 5–20
Elo and is invisible in fewer than a few hundred games.

Keep `npm test` passing.

---

## Licence

MIT. Do whatever you like with it.
