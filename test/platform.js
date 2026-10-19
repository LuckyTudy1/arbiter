'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const vm = require('vm');
const E = require('../arbiter-engine.js');
const { parse, atomicJSON } = require('../tools/train.js');
const LearningCore = require('../training.js');
const mate = new E.Position('7k/8/5KQ1/8/8/8/8/8 w - - 99 1');
let result = E.think(mate, { maxDepth: 2, moveTime: 500 });
assert.strictEqual(E.toSAN(mate, result.best), 'Qg7#', 'checkmate takes precedence over fifty-move draw');
assert(result.score > E.MATE - 10);
const terminal = new E.Position('7k/6Q1/6K1/8/8/8/8/8 b - - 100 1');
result = E.think(terminal, { maxDepth: 2, moveTime: 100 });
assert.strictEqual(result.best, 0);
assert.strictEqual(result.score, -E.MATE);
const forced = new E.Position('7k/8/6K1/8/8/8/8/Q7 b - - 0 1');
assert.strictEqual(forced.legalMoves().length, 1);
result = E.think(forced, { maxDepth: 1, moveTime: 200 });
assert.notStrictEqual(result.score, 0, 'forced moves still need a search score for training');
const isolated = E.createEngine();
isolated.loadNetwork(isolated.createNetwork({hidden:2}));
assert.strictEqual(E.networkInfo().loaded, false);
assert.strictEqual(isolated.networkInfo().loaded, true);
assert.throws(() => parse(['--arena-games','3']));
assert.throws(() => parse(['--epochs','NaN']));
assert.strictEqual(parse(['--seed','0']).seed,0);
// Exercise the actual page handlers: restarting while a model is queued must
// reject the old worker's result and preserve a subsequently selected model.
const html = fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
const page = { thinking:true, searchId:9, pendingNetwork:undefined, watchdog:null,
  workerProbe:null, humanColor:0, WHITE:0, BLACK:8, self:{}, loaded:[], terminated:0,
  worker:{terminate(){page.terminated++;},postMessage(){}},
  API:{loadNetwork(model){page.loaded.push(model);},Position:function(){this.side=0;this.fen=()=> 'start';}},
  $(){return {};},clearTimeout(){},setTimeout(){},setEvalBar(){},render(){},
  startWorker(){page.worker={postMessage(){},terminate(){page.terminated++;}};},
  showInfo(){throw new Error('A stale search must not update the display');} };
vm.createContext(page);
for(const name of ['setNetwork','newGame','onEngineMessage']) {
  const source = html.match(new RegExp('function '+name+'\\([^]*?\\n\\}'));
  assert(source,'page handler exists: '+name);
  vm.runInContext(source[0],page);
}
vm.runInContext("setNetwork('queued'); newGame('w'); setNetwork('latest'); onEngineMessage({data:{type:'result',id:9,f:100,t:68,p:0}});",page);
assert.deepStrictEqual(page.loaded,['queued','latest']);
assert.strictEqual(page.pendingNetwork,undefined);
assert.strictEqual(page.terminated,1);
assert.strictEqual(page.moveLog.length,0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arbiter-platform-'));
try {
  const modelPath = path.join(dir, 'model with spaces.json');
  atomicJSON(modelPath, isolated.exportNetwork());
  const uci = spawnSync(process.execPath, [path.resolve(__dirname, '../arbiter-engine.js')], {
    input: 'uci\nsetoption name EvalFile value ' + modelPath + '\nisready\nposition startpos\ngo depth 1\nsetoption name EvalFile value <none>\nquit\n', encoding: 'utf8', timeout: 10000
  });
  assert.strictEqual(uci.status, 0, uci.stderr);
  assert(uci.stdout.includes('option name EvalFile'));
  assert(uci.stdout.includes('info string evaluation loaded ' + modelPath));
  assert(uci.stdout.includes('readyok'));
  assert(/bestmove [a-h][1-8][a-h][1-8]/.test(uci.stdout));
  assert(uci.stdout.includes('info string evaluation classical'));
  const output = path.join(dir, 'learning');
  const cliPath = path.resolve(__dirname, '../tools/train.js');
  const args = [cliPath,'--output',output,'--games','2','--arena-games','2','--depth','1','--movetime','2','--max-plies','12','--epochs','1'];
  for (let generation = 1; generation <= 2; generation++) {
    const cli = spawnSync(process.execPath, args, { encoding:'utf8', timeout:30000 });
    assert.strictEqual(cli.status,0,cli.stderr + cli.stdout);
    const checkpoint = JSON.parse(fs.readFileSync(path.join(output,'checkpoint.json')));
    assert.strictEqual(checkpoint.generation,generation);
    assert.strictEqual(checkpoint.champion,null,'smoke arenas cannot promote');
    assert(fs.existsSync(path.join(output,'candidate.json')));
    assert(fs.existsSync(path.join(output,'reports','generation-'+generation+'.json')));
  }
  const resume = spawnSync(process.execPath,[cliPath,'--output',output],{encoding:'utf8',timeout:30000});
  assert.strictEqual(resume.status,0,resume.stderr);
  const resumed = JSON.parse(fs.readFileSync(path.join(output,'checkpoint.json')));
  assert.strictEqual(resumed.generation,3);
  assert.strictEqual(resumed.options.selfPlayGames,2);
  assert.strictEqual(resumed.options.maxDepth,1);
  assert.strictEqual(resumed.options.moveTime,2);
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('ok platform: mate labels, isolated engines, UCI model loading, CLI checkpoints and resume');
