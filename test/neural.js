'use strict';

const assert = require('assert');
const E = require('../arbiter-engine.js');

const fens = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1',
  '8/2p2pkp/3p2p1/1p1P4/1P2P3/P4PKP/8/8 w - - 0 30'
];
const positions = fens.map(fen => new E.Position(fen));
const baseline = positions.map(p => E.evaluateClassical(p));
assert.deepStrictEqual(E.networkInfo(), { loaded: false });
assert.strictEqual(E.exportNetwork(), null);
assert.deepStrictEqual(positions.map(p => E.evaluate(p)), baseline);
assert.throws(() => E.trainNetwork([{ fen: fens[2], target: 0.9 }]), /network before training/);

const initialized = E.createNetwork({ hidden: 16, seed: 17 });
assert.deepStrictEqual(initialized, E.createNetwork({ hidden: 16, seed: 17 }));
assert.notDeepStrictEqual(initialized.inputWeights, E.createNetwork({ hidden: 16, seed: 18 }).inputWeights);
assert.strictEqual(E.networkInfo().loaded, false, 'creating a model does not activate it');
E.loadNetwork(initialized);
assert.deepStrictEqual(positions.map(p => E.evaluate(p)), baseline, 'zero output initialization preserves classical evaluation');

// Imported and exported arrays cannot mutate the active network.
initialized.inputWeights[0] = 9;
assert.notStrictEqual(E.exportNetwork().inputWeights[0], 9);
const exported = E.exportNetwork();
exported.hiddenBias[0] = 9;
exported.metadata.trainingSteps = 999;
assert.notStrictEqual(E.exportNetwork().hiddenBias[0], 9);
assert.strictEqual(E.networkInfo().metadata.trainingSteps, 0);

// Failed imports preserve all existing weights and metadata.
const untouched = E.exportNetwork();
for (const alter of [
  m => { m.version = 2; },
  m => { m.inputs = 64; },
  m => { m.hidden = 0; },
  m => { m.hidden = 257; },
  m => { m.inputWeights.pop(); },
  m => { m.hiddenBias[0] = NaN; },
  m => { m.outputWeights[0] = Infinity; },
  m => { m.outputWeights[0] = 17; },
  m => { m.metadata.trainingSteps = -1; }
]) {
  const bad = JSON.parse(JSON.stringify(untouched));
  alter(bad);
  assert.throws(() => E.loadNetwork(bad));
  assert.deepStrictEqual(E.exportNetwork(), untouched);
}

const samples = [
  { fen: fens[2], target: 0.9 },
  { fen: fens[2].replace(' w ', ' b '), target: 0.1 }
];
for (const badSamples of [
  [],
  [{ fen: fens[2], target: 1.1 }],
  [{ fen: fens[2], target: '0.9' }],
  [samples[0], { fen: 'broken FEN', target: 0.5 }],
  [samples[0], { fen: '8/8/8/8/8/8/8/8 w - - 0 1', target: 0.5 }]
]) {
  assert.throws(() => E.trainNetwork(badSamples));
  assert.deepStrictEqual(E.exportNetwork(), untouched, 'invalid samples must not partially train');
}
for (const opts of [{ epochs: 0 }, { learningRate: NaN }, { learningRate: 2 }, { seed: -1 }]) {
  assert.throws(() => E.trainNetwork(samples, opts));
  assert.deepStrictEqual(E.exportNetwork(), untouched);
}

const opts = { epochs: 400, learningRate: 0.05, seed: 13 };
const result = E.trainNetwork(samples, opts);
assert(result.lossAfter < result.lossBefore / 10, 'training must learn the supplied probability labels');
assert.strictEqual(result.samples, 2);
assert.strictEqual(result.epochs, 400);
const trained = E.exportNetwork();
assert.deepStrictEqual(trained.metadata, { seed: 17, trainingSteps: 800, trainingSamples: 2, epochs: 400 });
assert(trained.inputWeights.some((value, i) => value !== untouched.inputWeights[i]), 'backpropagation must train the hidden layer');
assert(trained.outputWeights.some(value => value !== 0));
const predictions = positions.map(p => E.evaluate(p));
assert(predictions[2] > baseline[2] + 100, 'learned residual must participate in evaluation');

// The exact seed, dataset, and options reproduce the complete training result.
E.loadNetwork(untouched);
assert.deepStrictEqual(E.trainNetwork(samples, opts), result);
assert.deepStrictEqual(E.exportNetwork(), trained);
E.loadNetwork(JSON.parse(JSON.stringify(trained)));
assert.deepStrictEqual(positions.map(p => E.evaluate(p)), predictions, 'JSON round-trip preserves evaluation');

function flipColorsAndRanks(fen) {
  const p = fen.split(' ');
  p[0] = p[0].split('/').reverse().map(row => row.replace(/[a-zA-Z]/g,
    ch => ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('/');
  p[1] = p[1] === 'w' ? 'b' : 'w';
  p[2] = p[2] === '-' ? '-' : ['K', 'Q', 'k', 'q'].filter(ch =>
    p[2].includes(ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('') || '-';
  p[3] = p[3] === '-' ? '-' : p[3][0] + (9 - Number(p[3][1]));
  return p.join(' ');
}
function residual(fen) {
  const p = new E.Position(fen);
  return E.evaluate(p) - E.evaluateClassical(p);
}
for (const fen of fens) {
  const value = residual(fen);
  assert(Math.abs(value - residual(flipColorsAndRanks(fen))) < 1e-9,
    'colour/rank reflection must preserve side-to-move residual');
  const otherSide = fen.includes(' w ') ? fen.replace(' w ', ' b ') : fen.replace(' b ', ' w ');
  assert(Math.abs(value + residual(otherSide)) < 1e-9, 'changing the side to move must negate the residual');
  assert(Math.abs(value) <= 2000, 'neural residual must remain outside mate-score range');
}
const extreme = E.exportNetwork();
extreme.outputWeights.fill(16);
E.loadNetwork(extreme);
for (const fen of fens) assert(Math.abs(residual(fen)) <= 2000);

E.loadNetwork(null);
assert.strictEqual(E.exportNetwork(), null);
assert.deepStrictEqual(positions.map(p => E.evaluate(p)), baseline, 'disabling the model restores classical evaluation');
console.log('ok   neural training, validation, determinism, serialization, symmetry, and classical fallback');
