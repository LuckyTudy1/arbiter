/* Self-play lab. Embedded by tools/sync-browser.js for offline use. */
(function () {
  'use strict';
  var E = self.ChessAPI;
  var storageKey = 'arbiter.learning.v1';
  var state = { format: 'arbiter-training', version: 1, generation: 0, champion: null, replay: null };
  var trainingWorker = null;
  var lastCandidate = null;
  var storageWarning = '';
  var style = document.createElement('style');
  style.textContent = '#learnLab{padding:12px;background:var(--panel);margin-top:14px;border:1px solid var(--line)}' +
    '#learnLab h2{margin:0 0 8px;font-size:14px;color:var(--chalk)}#learnLab p{font-size:11px;color:var(--ink-dim)}' +
    '#learnLab .actions{display:flex;flex-wrap:wrap;gap:6px}#learnLab button{font:inherit;font-size:11px;padding:8px;background:var(--panel-2);color:var(--ink);border:1px solid var(--line);cursor:pointer}' +
    '#learnLab button:disabled{opacity:.45;cursor:default}#learnStatus{white-space:pre-wrap;overflow-wrap:anywhere}';
  document.head.appendChild(style);
  var panel = document.createElement('section');
  panel.id = 'learnLab';
  panel.setAttribute('aria-label', 'Self-training lab');
  panel.innerHTML = '<h2>Self-training lab</h2>' +
    '<p>Arbiter plays itself, learns a neural evaluation, then tests it against its current champion. Only a candidate with convincing match results becomes the playing model.</p>' +
    '<p id="learnStatus" role="status" aria-live="polite"></p>' +
    '<div class="actions"><button id="learnStart">Start training</button><button id="learnStop" disabled>Stop</button>' +
    '<button id="learnExport">Export checkpoint</button><button id="learnCandidate" disabled>Export candidate</button>' +
    '<button id="learnImport">Import model / checkpoint</button><button id="learnReset">Reset learning</button></div>' +
    '<input id="learnFile" type="file" accept=".json,application/json" hidden>' +
    '<p>Training runs on this device and uses CPU and battery. Completed generations save locally. 3000+ Elo is a goal; this version has no verified rating.</p>';
  document.querySelector('.wrap').appendChild(panel);
  function el(id) { return document.getElementById(id); }
  function status(message) { el('learnStatus').textContent = message + (storageWarning ? '\n' + storageWarning : ''); }
  function progressText(progress) {
    if (progress.phase === 'selfplay') return 'Self-play game ' + progress.game + '/' + progress.games + ' · ply ' + progress.ply + ' · ' + progress.samples + ' sampled positions';
    if (progress.phase === 'training') return 'Learning from ' + progress.samples + ' positions · ' + progress.epochs + ' passes';
    if (progress.phase === 'evaluation') return 'Checking held-out predictions' + (progress.heldout && progress.heldout.mse !== null ? ' · error ' + progress.heldout.mse.toFixed(5) : '');
    if (progress.phase === 'arena') return 'Candidate match ' + progress.game + '/' + progress.games + ' · ' + (progress.truncated ? 'unfinished at move cap' : progress.result);
    return progress.reason || 'Saving generation…';
  }
  function apply() { self.ArbiterUI.setNetwork(state.champion); }
  function save() {
    try { localStorage.setItem(storageKey, JSON.stringify(state)); storageWarning = ''; }
    catch (error) { storageWarning = 'Local saving unavailable or full. Export a checkpoint to keep progress.'; }
  }
  function validateCheckpoint(value) {
    if (!value || value.format !== 'arbiter-training' || value.version !== 1 || !Number.isInteger(value.generation) || value.generation < 0 || !('champion' in value)) throw new Error('Unsupported checkpoint');
    // Validate independently, without replacing the playing model on failure.
    var scope = {};
    ChessCore(scope);
    scope.ChessAPI.loadNetwork(value.champion);
    if (value.replay && value.replay.samples && value.replay.samples.length > 20000) throw new Error('Checkpoint replay exceeds the browser limit of 20,000 positions');
    return value;
  }
  try {
    var saved = localStorage.getItem(storageKey);
    if (saved) { state = validateCheckpoint(JSON.parse(saved)); apply(); }
  } catch (error) { storageWarning = 'Saved learning could not be loaded: ' + error.message; }
  status('Generation ' + state.generation + ' · ' + (state.champion ? 'neural champion loaded' : 'classical champion') + ' · ready');

  function workerMain() {
    var A = self.ChessAPI;
    var learner = LearningCore(A);
    var current;
    function next() {
      try {
        var result = learner.runGeneration(current.champion, current.replay, {
          selfPlayGames: 8, arenaGames: 40, moveTime: 10, maxDepth: 3, maxPlies: 240,
          epochs: 4, learningRate: 0.01, maxReplay: 2000, seed: 1,
          generation: current.generation + 1
        }, function (progress) { self.postMessage({ type: 'progress', progress: progress }); });
        current = { format: 'arbiter-training', version: 1, generation: current.generation + 1,
          champion: result.champion, replay: result.replay, report: result.report };
        self.postMessage({ type: 'generation', state: current, candidate: result.candidate, promoted: result.promoted });
        setTimeout(next, 20);
      } catch (error) { self.postMessage({ type: 'error', message: error.message }); }
    }
    self.onmessage = function (event) { current = event.data.state; next(); };
  }
  function controls(running) {
    el('learnStart').disabled = running;
    el('learnStop').disabled = !running;
    el('learnImport').disabled = running;
    el('learnReset').disabled = running;
  }
  el('learnStart').onclick = function () {
    if (trainingWorker) return;
    var url;
    try {
      var source = '(' + ChessCore.toString() + ')();\n' + LearningCore.toString() + '\n(' + workerMain.toString() + ')();';
      url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      trainingWorker = new Worker(url);
      URL.revokeObjectURL(url);
      controls(true);
      status('Generation ' + (state.generation + 1) + ' · generating self-play games…');
      trainingWorker.onmessage = function (event) {
        var data = event.data;
        if (data.type === 'progress') {
          status('Generation ' + (state.generation + 1) + ' · ' + progressText(data.progress));
        } else if (data.type === 'generation') {
          state = data.state;
          lastCandidate = data.candidate;
          el('learnCandidate').disabled = false;
          save(); apply();
          status('Generation ' + state.generation + ' saved · ' + (data.promoted ? 'new champion promoted' : 'champion retained') + '\nNext generation starting…');
        } else if (data.type === 'error') stop('Training failed: ' + data.message);
      };
      trainingWorker.onerror = function (event) { stop('Training failed: ' + (event.message || 'worker unavailable')); };
      trainingWorker.postMessage({ state: state });
    } catch (error) {
      if (url) URL.revokeObjectURL(url);
      stop('Training needs browser Web Worker support: ' + error.message);
    }
  };
  function stop(message) {
    if (trainingWorker) trainingWorker.terminate();
    trainingWorker = null;
    controls(false);
    status(message || 'Stopped. Generation ' + state.generation + ' kept; the unfinished generation was discarded.');
  }
  el('learnStop').onclick = function () { stop(); };
  function download(value, name) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
    var link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  el('learnExport').onclick = function () { download(state, 'arbiter-checkpoint.json'); };
  el('learnCandidate').onclick = function () { if (lastCandidate) download(lastCandidate, 'arbiter-candidate.json'); };
  el('learnImport').onclick = function () { el('learnFile').click(); };
  el('learnFile').onchange = function () {
    var file = this.files[0];
    this.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { status('Import failed: file exceeds 20 MB'); return; }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var value = JSON.parse(reader.result);
        if (value && value.format === 'arbiter-training') state = validateCheckpoint(value);
        else {
          // Preserve the existing model if validation throws.
          var scope = {}; ChessCore(scope); scope.ChessAPI.loadNetwork(value);
          state = { format: 'arbiter-training', version: 1, generation: 0, champion: scope.ChessAPI.exportNetwork(), replay: null };
        }
        lastCandidate = null;
        el('learnCandidate').disabled = true;
        save(); apply();
        status('Imported generation ' + state.generation + '. Imported models are user-selected and have not passed this device’s arena.');
      } catch (error) { status('Import failed: ' + error.message); }
    };
    reader.onerror = function () { status('Import failed: file could not be read'); };
    reader.readAsText(file);
  };
  el('learnReset').onclick = function () {
    state = { format: 'arbiter-training', version: 1, generation: 0, champion: null, replay: null };
    lastCandidate = null;
    el('learnCandidate').disabled = true;
    save(); apply();
    status('Learning reset. Classical champion restored.');
  };
})();
