#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../arbiter-engine.js');
const LearningCore = require('../training.js');

function parse(argv) {
  const values = { generations: 1, games: 8, 'arena-games': 40, movetime: 10, depth: 3,
    'max-plies': 240, epochs: 4, 'learning-rate': 0.01, 'replay-size': 20000,
    seed: 1, output: '.arbiter-training' };
  const switches = new Set(['continuous', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || (!(key in values) && !switches.has(key) && key !== 'resume')) throw new Error('Unknown argument: ' + argv[i]);
    if (switches.has(key)) { values[key] = true; continue; }
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error('Missing value for --' + key);
    values[key] = ['output', 'resume'].includes(key) ? value : Number(value);
  }
  for (const [key, val] of Object.entries(values)) {
    if (typeof val === 'number' && (!Number.isFinite(val) || (key === 'seed' ? val < 0 : val <= 0) || (!['learning-rate'].includes(key) && !Number.isInteger(val)))) throw new Error('Invalid --' + key);
  }
  if (values['arena-games'] % 2) throw new Error('--arena-games must be even for paired colours');
  return values;
}
function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data) + '\n');
  fs.renameSync(file + '.tmp', file);
}
async function main(argv) {
  const args = parse(argv);
  if (args.help) {
    console.log('Usage: npm run train -- [--generations 1 | --continuous] [--output .arbiter-training]\n' +
      '  --games 8 --arena-games 40 --movetime 10 --depth 3 --max-plies 240\n' +
      '  --epochs 4 --learning-rate 0.01 --replay-size 20000 --seed 1\n' +
      '  --resume path/to/checkpoint.json\n' +
      'Existing output/checkpoint.json resumes automatically. Weights are promoted only after\n' +
      'a confidence-gated arena. A training run does not establish an absolute Elo rating.');
    return;
  }
  const directory = path.resolve(args.output);
  const checkpoint = path.resolve(args.resume || path.join(directory, 'checkpoint.json'));
  let state = { format: 'arbiter-training', version: 1, generation: 0, champion: null, replay: null };
  if (fs.existsSync(checkpoint)) {
    state = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    if (state.format !== 'arbiter-training' || state.version !== 1 || !Number.isInteger(state.generation) || state.generation < 0) throw new Error('Unsupported training checkpoint');
    E.loadNetwork(state.champion);
    console.log('Resuming generation ' + (state.generation + 1) + ' from ' + checkpoint);
  } else if (args.resume) throw new Error('Resume checkpoint does not exist: ' + checkpoint);
  const savedOptions = state.options || (state.report && state.report.options) || {};
  const optionNames = { games: 'selfPlayGames', 'arena-games': 'arenaGames', movetime: 'moveTime',
    depth: 'maxDepth', 'max-plies': 'maxPlies', epochs: 'epochs',
    'learning-rate': 'learningRate', 'replay-size': 'maxReplay', seed: 'seed' };
  for (const [flag, name] of Object.entries(optionNames)) {
    if (!argv.includes('--' + flag) && savedOptions[name] !== undefined) args[flag] = savedOptions[name];
  }
  const trainer = LearningCore(E);
  for (let run = 0; args.continuous || run < args.generations; run++) {
    const opts = { selfPlayGames: args.games, arenaGames: args['arena-games'], moveTime: args.movetime,
      maxDepth: args.depth, maxPlies: args['max-plies'], epochs: args.epochs,
      learningRate: args['learning-rate'], maxReplay: args['replay-size'],
      seed: args.seed, generation: state.generation + 1 };
    const result = trainer.runGeneration(state.champion, state.replay, opts, progress => {
      console.log(JSON.stringify(progress));
    });
    state = { format: 'arbiter-training', version: 1, generation: result.report.generation,
      champion: result.champion, replay: result.replay, report: result.report, options: opts };
    // Publish supporting artifacts before the checkpoint that commits this generation.
    atomicJSON(path.join(directory, 'candidate.json'), result.candidate);
    atomicJSON(path.join(directory, 'champion.json'), result.champion);
    atomicJSON(path.join(directory, 'reports', 'generation-' + state.generation + '.json'), result.report);
    atomicJSON(path.join(directory, 'checkpoint.json'), state);
    console.log('Generation ' + state.generation + ': ' + (result.promoted ? 'candidate promoted' : 'champion retained') + '. Saved ' + path.join(directory, 'checkpoint.json'));
    await new Promise(resolve => setImmediate(resolve));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parse, atomicJSON };
