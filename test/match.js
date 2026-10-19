'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { runMatch, summarize, pgn, parseArgs } = require('../tools/match.js');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-match-'));
  const fake = path.join(directory, 'fake-uci.js');
  const log = path.join(directory, 'commands.log');
  fs.writeFileSync(fake, `
const fs = require('fs');
const E = require(${JSON.stringify(path.resolve(__dirname, '../arbiter-engine.js'))});
const mode = process.argv[2], log = process.argv[3];
let position = new E.Position();
const uci = move => E.sqToAlg(E.mFrom(move)) + E.sqToAlg(E.mTo(move)) + (E.mPromo(move) ? ' pnbrqk'[E.mPromo(move)] : '');
require('readline').createInterface({input:process.stdin}).on('line', line => {
  if (log) fs.appendFileSync(log, line + '\\n');
  const parts = line.split(' ');
  if (line === 'uci') {
    console.log('id name Fake UCI');
    if (mode !== 'unsupported') {
      console.log('option name UCI_LimitStrength type check default false');
      console.log('option name UCI_Elo type spin default 1500 min 1000 max 3000');
    }
    console.log('uciok');
  } else if (line === 'isready') console.log('readyok');
  else if (parts[0] === 'position') {
    const at = parts.indexOf('moves');
    position = new E.Position(parts.slice(2, at < 0 ? undefined : at).join(' '));
    if (at >= 0) for (const token of parts.slice(at + 1)) {
      const move = position.legalMoves().find(move => uci(move) === token);
      if (!move) process.exit(8);
      position.makeMove(move);
    }
  } else if (parts[0] === 'go') {
    if (mode === 'missing') return;
    if (mode === 'crash') process.exit(7);
    if (mode === 'malformed') console.log('bestmove bananas');
    else if (mode === 'illegal') console.log('bestmove a1a8');
    else console.log('bestmove ' + uci(position.legalMoves()[0]));
  } else if (line === 'quit') process.exit(0);
});
`);
  const base = { opponent: process.execPath, opponentArgs: [fake, 'normal', log],
    games: 4, moveTime: 1, openingPlies: 2, maxPlies: 1, seed: 42, timeout: 2000 };
  try {
    const report = await runMatch(Object.assign({}, base, { opponentElo: 2400 }));
    assert.strictEqual(report.summary.completed, 0);
    assert.strictEqual(report.summary.truncated, 4);
    assert.strictEqual(report.summary.draws, 0, 'a ply cap must never count as a draw');
    assert.strictEqual(report.summary.relativeRating.completePairs, 0);
    assert.deepStrictEqual(report.games[0].openingMoves, report.games[1].openingMoves);
    assert.deepStrictEqual(report.games[2].openingMoves, report.games[3].openingMoves);
    assert.notDeepStrictEqual(report.games[0].openingMoves, report.games[2].openingMoves);
    assert.strictEqual(report.games[0].arbiterColour, 'white');
    assert.strictEqual(report.games[1].arbiterColour, 'black');
    const commands = fs.readFileSync(log, 'utf8');
    assert(commands.includes('setoption name UCI_LimitStrength value true\n'));
    assert(commands.includes('setoption name UCI_Elo value 2400\n'));
    assert.strictEqual((commands.match(/^go movetime 1$/gm) || []).length, 2);
    assert(commands.endsWith('quit\n'), 'the UCI child should be shut down');
    assert(pgn(report).includes('[Result "*"]'));

    const repeated = await runMatch(base);
    assert.deepStrictEqual(repeated.games.map(game => game.openingMoves), report.games.map(game => game.openingMoves));
    const modelPath = path.join(directory, 'model.json');
    fs.writeFileSync(modelPath, JSON.stringify(require('../arbiter-engine.js').createNetwork({ hidden: 2, seed: 1 })));
    const neural = await runMatch(Object.assign({}, base, { games: 2, model: modelPath }));
    assert.strictEqual(neural.config.model, modelPath);
    assert.strictEqual(neural.summary.games, 2);

    const terminal = await runMatch(Object.assign({}, base, { games: 2, openingPlies: 0,
      openingFen: '7k/8/5KQ1/8/8/8/8/8 w - - 0 1' }));
    assert.strictEqual(terminal.games[0].result, '1-0');
    assert.strictEqual(terminal.games[0].termination, 'checkmate');
    assert.strictEqual(terminal.summary.wins, 1);
    assert.strictEqual(terminal.summary.draws, 1, 'the fake opponent\'s king move produces a real stalemate');
    assert.strictEqual(terminal.summary.score, 0.75);
    assert.strictEqual(terminal.summary.relativeRating.completePairs, 1);
    const incomplete = summarize([{ arbiterScore: 1 }, { arbiterScore: null }]);
    assert.strictEqual(incomplete.relativeRating.completePairs, 0, 'incomplete pairs cannot influence Elo');

    for (const [mode, expected] of [
      ['malformed', /Malformed UCI bestmove/], ['illegal', /illegal bestmove/],
      ['missing', /timeout waiting for bestmove/], ['crash', /exited \(7\)/]
    ]) {
      await assert.rejects(runMatch(Object.assign({}, base, { games: 2, openingPlies: 0,
        timeout: 500, opponentArgs: [fake, mode, log] })), expected);
      assert(fs.readFileSync(log, 'utf8').endsWith(mode === 'crash' ? 'go movetime 1\n' : 'quit\n'));
    }
    await assert.rejects(runMatch(Object.assign({}, base, { games: 3 })), /must be even/);
    await assert.rejects(runMatch(Object.assign({}, base, { openingFen: '8/8/8/8/8/8/8/8 w - - 0 1' })), /valid six-field FEN/);
    await assert.rejects(runMatch(Object.assign({}, base, { opponentElo: 4000 })), /advertised range/);
    await assert.rejects(runMatch(Object.assign({}, base, { opponentArgs: [fake, 'unsupported', log], opponentElo: 2400 })), /requires advertised/);
    const unsupportedLog = fs.readFileSync(log, 'utf8').split('quit\n').slice(-2)[0];
    assert(!unsupportedLog.includes('setoption'), 'unsupported Elo options must never be sent');
    await assert.rejects(runMatch(Object.assign({}, base, { opponent: path.join(directory, 'missing-executable') })), /Cannot start UCI opponent/);

    const ratings = summarize(Array.from({ length: 200 }, (_, index) => ({ arbiterScore: [1, 0.5, 0.5, 0][index % 4] })));
    assert.strictEqual(ratings.relativeRating.completePairs, 100);
    assert.strictEqual(ratings.relativeRating.score, 0.5);
    assert.strictEqual(ratings.relativeRating.eloDifference, 0);
    assert(ratings.relativeRating.scoreInterval95[0] < 0.5);
    assert(ratings.relativeRating.scoreInterval95[1] > 0.5);
    const undefeated = summarize([{ arbiterScore: 1 }, { arbiterScore: 1 }]);
    assert.strictEqual(undefeated.relativeRating.eloDifference, null, 'all wins cannot imply a finite exact rating');
    assert.deepStrictEqual(undefeated.relativeRating.scoreInterval95, [0, 1]);
    assert.throws(() => parseArgs(['--wat']), /Unknown argument/);
    assert.deepStrictEqual(parseArgs(['--opponent', 'node', '--opponent-arg', '--jitless']).opponentArgs, ['--jitless']);

    const output = path.join(directory, 'result.json'), games = path.join(directory, 'result.pgn');
    const text = execFileSync(process.execPath, [path.resolve(__dirname, '../tools/match.js'),
      '--opponent', process.execPath, '--opponent-arg', fake, '--opponent-arg', 'normal',
      '--games', '2', '--movetime', '1', '--opening-plies', '0', '--max-plies', '1',
      '--out', output, '--pgn', games], { encoding: 'utf8', timeout: 10000 });
    assert(text.includes('No absolute Elo inferred'));
    assert.strictEqual(JSON.parse(fs.readFileSync(output, 'utf8')).summary.truncated, 2);
    assert(fs.readFileSync(games, 'utf8').includes('[Termination "ply cap (unscored)"]'));
    console.log('ok  match harness: paired openings, scoring, UCI options, errors, cleanup, JSON and PGN');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
