'use strict';
const assert = require('assert');
const vm = require('vm');
const E = require('../arbiter-engine');
const LearningCore = require('../training');
const L = LearningCore(E);

const tiny = {
  seed: 7, selfPlayGames: 2, arenaGames: 2, maxPlies: 8,
  openingPlies: 0, sampleStartPly: 0, sampleEvery: 1,
  moveTime: 1000, maxDepth: 1, hidden: 4, epochs: 1,
  maxReplay: 100, learningRate: 0.01
};

// The same self-contained source used by the browser worker must load offline.
const sandbox = { E };
vm.runInNewContext('var L = (' + LearningCore.toString() + ')(E);', sandbox);
assert.strictEqual(sandbox.L.scoreScale, 400);

const rng = L.createRNG(0);
rng.next(); rng.next();
const resumed = L.createRNG(rng.state());
assert.strictEqual(resumed.next(), rng.next());
assert.strictEqual(L.defaults().seed, 1);
assert.throws(() => L.defaults({ arenaGames: 3 }), /even/);
assert.throws(() => L.defaults({ hidden: 257 }), /integer/);

const generated = L.generateSelfPlay(null, tiny);
assert(generated.samples.length > 0, 'Self-play must collect quiet positions');
assert(generated.games.every(game => game.truncated && game.result === null));
assert(generated.samples.every(sample => sample.truncated && sample.resultTarget === null && sample.target === sample.searchTarget && sample.source === 'search-bootstrap'));
const generatedAgain = L.generateSelfPlay(null, tiny);
assert.deepStrictEqual(generatedAgain, generated, 'Fixed-depth self-play uses seeded openings and partitions');
for (const sample of generated.samples) {
  const pos = new E.Position(sample.fen);
  assert.strictEqual(pos.inCheck(pos.side), false);
}

const split = L.splitByGame(generated.samples, 0.2, 7);
assert(split.train.length > 0 && split.heldout.length > 0);
assert(split.trainGames.every(id => !split.heldoutGames.includes(id)));
const savedPartitions = new Map(generated.samples.map(sample => [sample.gameId, sample.partition]));
const imported = generated.samples.concat([{ gameId: 'new-game', fen: generated.samples[0].fen, target: 0.5 }]);
L.splitByGame(imported, 0.2, 7);
for (const sample of imported) if (savedPartitions.has(sample.gameId)) assert.strictEqual(sample.partition, savedPartitions.get(sample.gameId));
assert.throws(() => L.splitByGame([
  { gameId: 'same', fen: generated.samples[0].fen, target: 0.5, partition: 'train' },
  { gameId: 'same', fen: generated.samples[0].fen, target: 0.5, partition: 'heldout' }
]), /both replay partitions/);

const mateFen = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
const terminal = L.generateSelfPlay(null, Object.assign({}, tiny, { openingFens: [mateFen] }));
assert(terminal.games.every(game => !game.truncated && game.result === '1-0'));
assert.strictEqual(terminal.samples.length, 0);

// Capped matches contribute no invented draws, Elo or promotion evidence.
const cappedArena = L.runArena(E.createNetwork({ hidden: 4, seed: 1 }), null, tiny);
assert.strictEqual(cappedArena.truncatedGames, 2);
assert.strictEqual(cappedArena.completedGames, 0);
assert.strictEqual(cappedArena.draws, 0);
assert.strictEqual(cappedArena.score, null);
assert.strictEqual(cappedArena.relativeElo, null);
assert.strictEqual(cappedArena.promoted, false);
assert(cappedArena.results[0].opening.fen === cappedArena.results[1].opening.fen);
assert.notStrictEqual(cappedArena.results[0].candidateColor, cappedArena.results[1].candidateColor);

function wins(games, score) {
  return Array.from({ length: games }, (_, i) => ({ pair: Math.floor(i / 2), candidateColor: i % 2 ? E.BLACK : E.WHITE, score, truncated: false }));
}
const overwhelming = L.summarizeArena(wins(40, 1), tiny);
assert.strictEqual(overwhelming.promoted, true);
assert(overwhelming.scoreInterval[0] > 0.5);
assert.strictEqual(L.summarizeArena(wins(40, 0.5), tiny).promoted, false);
assert.strictEqual(L.summarizeArena(wins(2, 1), Object.assign({}, tiny, { minArenaGames: 2 })).promoted, false);
const censored = wins(40, 1).concat([
  { pair: 20, candidateColor: E.WHITE, score: null, truncated: true },
  { pair: 20, candidateColor: E.BLACK, score: 1, truncated: false }
]);
assert.strictEqual(L.summarizeArena(censored, tiny).promoted, false, 'Censoring unfinished losses cannot improve the promotion case');

const first = L.runGeneration(null, null, tiny);
assert(first.candidate && first.replay.trainingCandidate);
assert.strictEqual(first.champion, null, 'A tiny arena must preserve the classical champion');
assert.strictEqual(first.report.trainingResumed, false);
assert(first.report.losses.championHeldout.count > 0);
assert(Number.isFinite(first.report.losses.candidateHeldout.mse));
assert.deepStrictEqual(E.exportNetwork(), null);
const firstSteps = first.candidate.metadata.trainingSteps;
const second = L.runGeneration(first.champion, JSON.parse(JSON.stringify(first.replay)), tiny);
assert.strictEqual(second.report.trainingResumed, true);
assert(second.candidate.metadata.trainingSteps > firstSteps, 'Rejected candidates must accumulate training across generations');
assert.strictEqual(second.report.generation, 2);
const firstIds = new Set(first.replay.samples.map(sample => sample.gameId));
const secondGameIds = second.report.selfPlay.games.map(game => game.id);
assert(secondGameIds.every(id => !firstIds.has(id)));
assert(second.replay.samples.length <= tiny.maxReplay);
assert.doesNotThrow(() => JSON.stringify(second));

// Importing an array checkpoint must infer its existing generation and counters.
const normalized = L.normalizeReplay([{ gameId: 'g8-120', fen: generated.samples[0].fen, target: 0.5 }]);
assert.strictEqual(normalized.generation, 8);
assert.strictEqual(normalized.nextGameId, 121);

const sentinel = E.createNetwork({ hidden: 4, seed: 999 });
E.loadNetwork(sentinel);
assert.throws(() => L.runGeneration(null, null, tiny, progress => {
  if (progress.phase === 'training') throw new Error('Injected training interruption');
}), /Injected/);
assert.deepStrictEqual(E.exportNetwork(), sentinel, 'A failed generation must restore the previous evaluator');
assert.throws(() => L.runArena(first.candidate, null, tiny, () => { throw new Error('Injected arena interruption'); }), /Injected/);
assert.deepStrictEqual(E.exportNetwork(), sentinel, 'A failed arena must restore the previous evaluator');
E.loadNetwork(null);
console.log('all learning pipeline checks passed');
