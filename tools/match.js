#!/usr/bin/env node
'use strict';

// A dependency-free measurement harness. Ratings here describe this match only.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const Engine = require('../arbiter-engine.js');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function random(seed) {
  let state = seed >>> 0 || 0x9e3779b9;
  return function () {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function toUci(E, move) {
  return E.sqToAlg(E.mFrom(move)) + E.sqToAlg(E.mTo(move)) +
    (E.mPromo(move) ? ' pnbrqk'[E.mPromo(move)] : '');
}

function fromUci(E, position, token) {
  return position.legalMoves().find(move => toUci(E, move) === token) || 0;
}

class UciClient {
  constructor(executable, args = [], timeout = 5000) {
    this.executable = executable;
    this.timeout = timeout;
    this.options = new Map();
    this.name = executable;
    this.stderr = '';
    this.pending = null;
    this.failure = null;
    this.exited = false;
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.child.on('error', error => this.fail(new Error('Cannot start UCI opponent: ' + error.message)));
    this.child.stdin.on('error', error => this.fail(new Error('UCI input failed: ' + error.message)));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192); });
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      this.fail(new Error('UCI opponent exited (' + (signal || code) + ')' +
        (this.stderr.trim() ? ': ' + this.stderr.trim() : '')));
    });
    this.lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.onLine(line.trim()));
  }

  fail(error) {
    this.failure = this.failure || error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  onLine(line) {
    if (line.length > 16384) return this.fail(new Error('UCI opponent emitted an oversized line'));
    if (line.startsWith('id name ')) this.name = line.slice(8);
    const option = /^option name (.+?) type (\w+)(.*)$/.exec(line);
    if (option) this.options.set(option[1].toLowerCase(), { name: option[1], type: option[2], tail: option[3] });
    if (!this.pending) return;
    try {
      const result = this.pending.match(line);
      if (result === undefined) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(result);
    } catch (error) { this.fail(error); }
  }

  request(commands, match, label) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Overlapping UCI requests'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('UCI timeout waiting for ' + label)), this.timeout);
      this.pending = { resolve, reject, match, timer };
      this.child.stdin.write(commands.join('\n') + '\n');
    });
  }

  async start(elo) {
    await this.request(['uci'], line => line === 'uciok' ? true : undefined, 'uciok');
    const commands = [];
    if (elo !== undefined) {
      const limit = this.options.get('uci_limitstrength');
      const rating = this.options.get('uci_elo');
      if (!limit || limit.type !== 'check' || !rating || rating.type !== 'spin')
        throw new Error('--opponent-elo requires advertised UCI_LimitStrength and UCI_Elo options');
      const minimum = /\bmin (-?\d+)/.exec(rating.tail);
      const maximum = /\bmax (-?\d+)/.exec(rating.tail);
      if ((minimum && elo < +minimum[1]) || (maximum && elo > +maximum[1]))
        throw new Error('--opponent-elo is outside the opponent\'s advertised range');
      commands.push('setoption name ' + limit.name + ' value true', 'setoption name ' + rating.name + ' value ' + elo);
    }
    commands.push('isready');
    await this.request(commands, line => line === 'readyok' ? true : undefined, 'readyok');
  }

  async newGame() {
    await this.request(['ucinewgame', 'isready'], line => line === 'readyok' ? true : undefined, 'readyok');
  }

  async bestMove(fen, moves, moveTime) {
    return this.request([
      'position fen ' + fen + (moves.length ? ' moves ' + moves.join(' ') : ''),
      'go movetime ' + moveTime
    ], line => {
      if (!/^bestmove\b/.test(line)) return undefined;
      const match = /^bestmove\s+([a-h][1-8][a-h][1-8][qrbn]?|0000|\(none\))(?:\s+ponder\s+[a-h][1-8][a-h][1-8][qrbn]?)?$/.exec(line);
      if (!match) throw new Error('Malformed UCI bestmove: ' + line);
      return match[1];
    }, 'bestmove');
  }

  async close() {
    if (this.pending) this.fail(new Error('UCI opponent closed'));
    this.lines.close();
    if (this.exited) return;
    await new Promise(resolve => {
      let killTimer;
      const finish = () => { clearTimeout(quitTimer); clearTimeout(killTimer); resolve(); };
      const quitTimer = setTimeout(() => {
        this.child.kill('SIGTERM');
        killTimer = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 200);
      }, 200);
      this.child.once('exit', finish);
      if (this.child.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.end('quit\n');
      else this.child.kill('SIGTERM');
    });
  }
}

function opening(E, fen, plies, rng) {
  const position = new E.Position(fen);
  if (E.gameStatus(position).over) throw new Error('--opening-fen must be a nonterminal legal chess position');
  const moves = [];
  for (let ply = 0; ply < plies; ply++) {
    const candidates = position.legalMoves();
    let accepted = false;
    // Avoid starting scored games after an opening has already ended the game.
    while (candidates.length) {
      const index = Math.floor(rng() * candidates.length);
      const move = candidates.splice(index, 1)[0];
      position.makeMove(move);
      const over = E.gameStatus(position).over;
      position.unmakeMove();
      if (over) continue;
      moves.push(toUci(E, move));
      position.makeMove(move);
      accepted = true;
      break;
    }
    if (!accepted) break;
  }
  return moves;
}

function validateFen(E, fen) {
  const fields = typeof fen === 'string' ? fen.trim().split(/\s+/) : [];
  const rows = fields.length === 6 ? fields[0].split('/') : [];
  if (rows.length !== 8 || rows.some(row => !/^[prnbqkPRNBQK1-8]+$/.test(row) ||
    [...row].reduce((count, item) => count + (/\d/.test(item) ? +item : 1), 0) !== 8) ||
    (fields[0].match(/K/g) || []).length !== 1 || (fields[0].match(/k/g) || []).length !== 1 ||
    /[pP]/.test(rows[0] + rows[7]) || !/^[wb]$/.test(fields[1]) ||
    !/^(?:-|K?Q?k?q?)$/.test(fields[2]) || !/^(?:-|[a-h][36])$/.test(fields[3]) ||
    !/^\d+$/.test(fields[4]) || !/^[1-9]\d*$/.test(fields[5]) ||
    !Number.isSafeInteger(+fields[4]) || !Number.isSafeInteger(+fields[5]))
    throw new Error('--opening-fen is not a valid six-field FEN');
  const position = new E.Position(fen);
  if (position.inCheck(position.side ^ E.BLACK))
    throw new Error('--opening-fen is illegal: the side that just moved is in check');
  const rights = [['K', 4, 7, E.WHITE], ['Q', 4, 0, E.WHITE],
    ['k', 116, 119, E.BLACK], ['q', 116, 112, E.BLACK]];
  for (const [right, kingSquare, rookSquare, colour] of rights) {
    if (fields[2].includes(right) && (position.board[kingSquare] !== (E.K | colour) ||
      position.board[rookSquare] !== (E.R | colour)))
      throw new Error('--opening-fen has inconsistent castling rights');
  }
  if (position.ep >= 0) {
    const direction = position.side === E.WHITE ? 16 : -16;
    if (fields[3][1] !== (position.side === E.WHITE ? '6' : '3') || position.board[position.ep] ||
      position.board[position.ep - direction] !== (E.P | (position.side ^ E.BLACK)))
      throw new Error('--opening-fen has an inconsistent en passant target');
  }
}

function eloDifference(score) {
  return score > 0 && score < 1 ? 400 * Math.log10(score / (1 - score)) : null;
}

function summarize(games) {
  const scored = games.filter(game => game.arbiterScore !== null);
  const wins = scored.filter(game => game.arbiterScore === 1).length;
  const draws = scored.filter(game => game.arbiterScore === 0.5).length;
  const losses = scored.length - wins - draws;
  const pairs = [];
  for (let i = 0; i < games.length; i += 2) {
    if (games[i].arbiterScore !== null && games[i + 1] && games[i + 1].arbiterScore !== null)
      pairs.push((games[i].arbiterScore + games[i + 1].arbiterScore) / 2);
  }
  const pairScore = pairs.length ? pairs.reduce((a, b) => a + b, 0) / pairs.length : null;
  // Each opening pair is one bounded observation: colours are never treated as independent.
  // Hoeffding stays conservative for tiny samples and all-win/all-draw results.
  const radius = pairs.length ? Math.sqrt(Math.log(40) / (2 * pairs.length)) : null;
  const lowerScore = pairScore === null ? null : Math.max(0, pairScore - radius);
  const upperScore = pairScore === null ? null : Math.min(1, pairScore + radius);
  return {
    games: games.length, completed: scored.length, truncated: games.length - scored.length,
    wins, draws, losses, score: scored.length ? (wins + draws / 2) / scored.length : null,
    relativeRating: {
      completePairs: pairs.length, score: pairScore, eloDifference: pairScore === null ? null : eloDifference(pairScore),
      scoreInterval95: [lowerScore, upperScore],
      eloInterval95: [lowerScore === null ? null : eloDifference(lowerScore), upperScore === null ? null : eloDifference(upperScore)],
      method: '95% Hoeffding interval over independent opening-pair mean scores; conservative; null Elo endpoints are unbounded',
      scope: 'Descriptive relative performance at this time control and these openings; no absolute Elo inferred.'
    }
  };
}

function integer(value, name, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(name + ' must be an integer from ' + minimum + ' to ' + maximum);
  return value;
}

function validate(options) {
  if (!options.opponent || typeof options.opponent !== 'string') throw new Error('--opponent <executable> is required');
  integer(options.games, '--games', 2);
  if (options.games % 2) throw new Error('--games must be even so every opening is played from both colours');
  integer(options.moveTime, '--movetime', 1, 3600000);
  integer(options.maxPlies, '--max-plies', 1);
  integer(options.openingPlies, '--opening-plies', 0, 100);
  integer(options.seed, '--seed', 0, 0xffffffff);
  integer(options.timeout, '--timeout', 1);
  if (options.timeout <= options.moveTime) throw new Error('--timeout must exceed --movetime');
  if (options.opponentElo !== undefined) integer(options.opponentElo, '--opponent-elo', 1);
}

async function runMatch(input) {
  const options = Object.assign({ games: 20, moveTime: 100, maxPlies: 320, openingPlies: 8, seed: 1,
    openingFen: START_FEN, opponentArgs: [] }, input);
  if (options.timeout === undefined) options.timeout = Math.max(5000, options.moveTime + 2000);
  validate(options);
  const E = typeof Engine.createEngine === 'function' ? Engine.createEngine() : Engine;
  if (options.model) {
    if (typeof E.loadNetwork !== 'function') throw new Error('This Arbiter build does not support neural models');
    E.loadNetwork(JSON.parse(fs.readFileSync(options.model, 'utf8')));
  }
  const rng = random(options.seed);
  // Validate the starting board before launching another process.
  validateFen(E, options.openingFen);
  opening(E, options.openingFen, 0, rng);
  const opponent = new UciClient(options.opponent, options.opponentArgs, options.timeout);
  const games = [];
  try {
    await opponent.start(options.opponentElo);
    for (let pair = 0; pair < options.games / 2; pair++) {
      const openingMoves = opening(E, options.openingFen, options.openingPlies, rng);
      for (let colour = 0; colour < 2; colour++) {
        E.clearTT();
        await opponent.newGame();
        const position = new E.Position(options.openingFen);
        const moves = [], san = [];
        for (const token of openingMoves) {
          const move = fromUci(E, position, token);
          san.push(E.toSAN(position, move)); moves.push(token); position.makeMove(move);
        }
        const arbiterColour = colour === 0 ? E.WHITE : E.BLACK;
        let status, playedPlies = 0;
        for (;;) {
          status = E.gameStatus(position);
          if (status.over || playedPlies >= options.maxPlies) break;
          let move;
          if (position.side === arbiterColour) {
            move = E.think(position, { moveTime: options.moveTime, maxDepth: 64 }).best;
            if (!position.legalMoves().includes(move)) throw new Error('Arbiter returned an illegal move');
          } else {
            const token = await opponent.bestMove(options.openingFen, moves, options.moveTime);
            move = fromUci(E, position, token);
            if (!move) throw new Error('UCI opponent returned illegal bestmove ' + token + ' in ' + position.fen());
          }
          san.push(E.toSAN(position, move)); moves.push(toUci(E, move));
          position.makeMove(move); playedPlies++;
        }
        const result = status.over ? status.result : '*';
        const score = result === '*' ? null : result === '1/2-1/2' ? 0.5 :
          ((result === '1-0') === (arbiterColour === E.WHITE) ? 1 : 0);
        const game = { number: games.length + 1, pair: pair + 1,
          white: colour === 0 ? 'Arbiter' : opponent.name, black: colour === 0 ? opponent.name : 'Arbiter',
          arbiterColour: colour === 0 ? 'white' : 'black', initialFen: options.openingFen,
          openingMoves: openingMoves.slice(), moves, san, playedPlies, finalFen: position.fen(),
          result, arbiterScore: score, termination: status.over ? status.reason : 'ply cap (unscored)' };
        games.push(game);
        if (options.onGame) options.onGame(game);
      }
    }
    return { format: 'arbiter-match-v1', opponent: opponent.name,
      config: { games: options.games, moveTime: options.moveTime, maxPlies: options.maxPlies,
        openingPlies: options.openingPlies, openingFen: options.openingFen, seed: options.seed,
        opponent: options.opponent, opponentArgs: options.opponentArgs,
        opponentEloSetting: options.opponentElo === undefined ? null : options.opponentElo,
        model: options.model ? path.resolve(options.model) : null },
      summary: summarize(games), games };
  } catch (error) {
    throw new Error('Match failed before game ' + (games.length + 1) + ' completed: ' + error.message);
  } finally { await opponent.close(); }
}

function pgn(report) {
  const escape = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return report.games.map(game => {
    const tags = { Event: 'Arbiter benchmark', White: game.white, Black: game.black, Result: game.result,
      TimeControl: '?', ArbiterMoveTimeMs: report.config.moveTime, Termination: game.termination,
      OpeningPair: game.pair, Seed: report.config.seed };
    if (game.initialFen !== START_FEN) { tags.SetUp = '1'; tags.FEN = game.initialFen; }
    const parts = game.initialFen.split(/\s+/);
    let turn = parts[1], number = +parts[5];
    const tokens = [];
    game.san.forEach((move, index) => {
      if (turn === 'w') tokens.push(number + '.');
      else if (index === 0) tokens.push(number + '...');
      tokens.push(move);
      if (turn === 'b') number++;
      turn = turn === 'w' ? 'b' : 'w';
    });
    return Object.entries(tags).map(([key, value]) => '[' + key + ' "' + escape(value) + '"]').join('\n') +
      '\n\n' + tokens.concat(game.result).join(' ') + '\n';
  }).join('\n');
}

const HELP = `Usage: node tools/match.js --opponent <UCI executable> [options]
  --opponent-arg <arg>    Pass an argument to the executable (repeatable; no shell)
  --games <even number>  Games, with colours swapped for every opening (default 20)
  --movetime <ms>        Equal fixed thinking time for both engines (default 100)
  --opening-plies <n>    Seeded random legal opening plies (default 8)
  --opening-fen <fen>    Optional common starting FEN
  --seed <uint32>       Reproduce the opening suite (default 1)
  --max-plies <n>        Stop after this many additional plies (default 320)
  --timeout <ms>         UCI response timeout, greater than movetime (default >=5000)
  --model <path>         Optional trained Arbiter network JSON
  --opponent-elo <n>     Only for engines advertising UCI_LimitStrength and UCI_Elo
  --out <path>           Write complete JSON results
  --pgn <path>           Write games, including unscored '*' truncated games
No absolute rating is inferred. A ply cap is unscored, never counted as a draw.
`;

function parseArgs(args) {
  const options = { opponentArgs: [] };
  const names = { '--opponent': 'opponent', '--games': 'games', '--movetime': 'moveTime',
    '--max-plies': 'maxPlies', '--opening-plies': 'openingPlies', '--opening-fen': 'openingFen',
    '--seed': 'seed', '--timeout': 'timeout', '--model': 'model', '--opponent-elo': 'opponentElo',
    '--out': 'out', '--pgn': 'pgn' };
  const numeric = new Set(['games', 'moveTime', 'maxPlies', 'openingPlies', 'seed', 'timeout', 'opponentElo']);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help' || args[i] === '-h') { options.help = true; continue; }
    const flag = args[i];
    if (!names[flag] && flag !== '--opponent-arg') throw new Error('Unknown argument: ' + flag);
    if (i + 1 >= args.length) throw new Error('Missing value for ' + flag);
    const value = args[++i];
    if (flag === '--opponent-arg') options.opponentArgs.push(value);
    else options[names[flag]] = numeric.has(names[flag]) ? Number(value) : value;
  }
  return options;
}

async function main(args) {
  const options = parseArgs(args);
  if (options.help) { process.stdout.write(HELP); return; }
  options.onGame = game => process.stdout.write('Game ' + game.number + ': ' + game.result +
    ' (Arbiter ' + game.arbiterColour + ', ' + game.termination + ')\n');
  const report = await runMatch(options);
  if (options.out) fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + '\n');
  if (options.pgn) fs.writeFileSync(options.pgn, pgn(report));
  const summary = report.summary, rating = summary.relativeRating;
  process.stdout.write('Arbiter W/D/L: ' + summary.wins + '/' + summary.draws + '/' + summary.losses +
    '; scored ' + summary.completed + '/' + summary.games + '; truncated (unscored) ' + summary.truncated + '\n');
  if (summary.score !== null) process.stdout.write('Score: ' + (100 * summary.score).toFixed(1) + '%\n');
  if (rating.completePairs) {
    const estimate = rating.eloDifference === null ? 'unbounded at observed score boundary' : rating.eloDifference.toFixed(0);
    const bounds = rating.eloInterval95.map((value, index) => value === null ? (index ? '+infinity' : '-infinity') : value.toFixed(0));
    process.stdout.write('Relative Elo: ' + estimate + '; conservative 95% interval [' + bounds.join(', ') +
      '] over ' + rating.completePairs + ' complete opening pairs\n');
  } else process.stdout.write('Relative Elo unavailable: no complete scored opening pairs.\n');
  process.stdout.write('No absolute Elo inferred; UCI_Elo is only an opponent setting.\n');
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});

module.exports = { runMatch, summarize, pgn, UciClient, parseArgs, START_FEN };
