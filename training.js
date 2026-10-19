/* Arbiter's portable self-play, replay and candidate testing pipeline.
 * This function has no external dependencies: browsers may embed its toString()
 * beside ChessCore in an offline worker. Node: require('./training')(engine).
 */
function LearningCore(E) {
  'use strict';
  if (!E || typeof E.think !== 'function') throw new Error('A ChessCore engine is required');

  var VERSION = 1, SCORE_SCALE = 400, PROMOTION_MIN_GAMES = 40;
  var OPENINGS = [
    'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7',
    'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6',
    'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4',
    'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6',
    'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 Nc3 Bg7',
    'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7',
    'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6',
    'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O',
    'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5',
    'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O',
    'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3',
    'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5',
    'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7',
    'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 Bb4 Bg2 O-O',
    'Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O',
    'd4 d5 Nf3 Nf6 Bf4 e6 e3 Bd6 Bg3 O-O',
    'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6',
    'e4 Nf6 e5 Nd5 d4 d6 Nf3 Bg4 Be2 e6',
    'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O',
    'd4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O'
  ];

  function copy(value) { return value == null ? null : JSON.parse(JSON.stringify(value)); }
  function integer(value, fallback, min, max) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isFinite(value) || Math.floor(value) !== value || value < min || value > max)
      throw new Error('Expected an integer between ' + min + ' and ' + max);
    return value;
  }
  function number(value, fallback, min, max) {
    if (value === undefined || value === null) return fallback;
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error('Expected a number between ' + min + ' and ' + max);
    return value;
  }
  function seedNumber(seed) {
    if (seed == null) return 1;
    if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
    var str = String(seed == null ? 1 : seed), h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function createRNG(seed) {
    var state = seedNumber(seed);
    return {
      next: function () {
        state = (state + 0x6D2B79F5) >>> 0;
        var t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      state: function () { return state; }
    };
  }
  function probability(score) { return 1 / (1 + Math.exp(-Math.max(-16000, Math.min(16000, score)) / SCORE_SCALE)); }
  // ChessCore invalidates its transposition table when loading an evaluator.
  function setModel(model) { E.loadNetwork(model == null ? null : model); }
  function notify(callback, value) { if (typeof callback === 'function') callback(value); }

  function options(opts) {
    opts = opts || {};
    var cfg = {
      seed: seedNumber(opts.seed),
      selfPlayGames: integer(opts.selfPlayGames, 8, 1, 100000),
      arenaGames: integer(opts.arenaGames, 40, 2, 100000),
      minArenaGames: Math.max(PROMOTION_MIN_GAMES, integer(opts.minArenaGames, PROMOTION_MIN_GAMES, 2, 100000)),
      maxPlies: integer(opts.maxPlies, 160, 1, 10000),
      moveTime: number(opts.moveTime, 10, 1, 3600000),
      maxDepth: integer(opts.maxDepth, 3, 1, 64),
      openingPlies: integer(opts.openingPlies, 8, 0, 20),
      sampleEvery: integer(opts.sampleEvery, 2, 1, 10000),
      sampleStartPly: integer(opts.sampleStartPly, 8, 0, 10000),
      resultWeight: number(opts.resultWeight, 0.5, 0, 1),
      heldoutFraction: number(opts.heldoutFraction, 0.2, 0.01, 0.5),
      maxReplay: integer(opts.maxReplay, 20000, 2, 1000000),
      hidden: integer(opts.hidden, 32, 1, 256),
      epochs: integer(opts.epochs, 3, 1, 10000),
      learningRate: number(opts.learningRate, 0.01, 0.000001, 1),
      confidence: number(opts.confidence, 0.95, 0.8, 0.9999),
      generation: integer(opts.generation, 1, 1, Number.MAX_SAFE_INTEGER),
      nextGameId: integer(opts.nextGameId, 0, 0, Number.MAX_SAFE_INTEGER),
      openingFens: Array.isArray(opts.openingFens) ? opts.openingFens.slice() : null,
      rngState: opts.rngState == null ? null : integer(opts.rngState, 0, 0, 4294967295)
    };
    if (cfg.arenaGames % 2) throw new Error('arenaGames must be even for paired-color testing');
    return cfg;
  }

  function modelSignature(model) {
    var json = JSON.stringify(model == null ? null : model), hashes = [2166136261, 2246822519, 3266489917, 668265263];
    for (var i = 0; i < json.length; i++) {
      var code = json.charCodeAt(i);
      for (var j = 0; j < hashes.length; j++) hashes[j] = Math.imul(hashes[j] ^ code, 16777619 + j * 2) >>> 0;
    }
    return json.length + ':' + hashes.map(function (hash) { return hash.toString(16); }).join(':');
  }

  function opening(rng, cfg, pairIndex) {
    var pos, index, moves = [];
    if (cfg.openingFens && cfg.openingFens.length) {
      index = Math.floor(rng.next() * cfg.openingFens.length);
      pos = new E.Position(cfg.openingFens[index]);
    } else {
      index = Math.floor(rng.next() * OPENINGS.length);
      pos = new E.Position();
      var line = OPENINGS[index].split(' ');
      var length = Math.min(cfg.openingPlies, line.length, Math.max(0, cfg.maxPlies - 1));
      // Vary the prefix as well as the line, while reusing it exactly for a pair.
      if (length > 4) length = 4 + Math.floor(rng.next() * (length - 3));
      for (var i = 0; i < length; i++) {
        var move = E.parseSAN(pos, line[i]);
        if (!move) throw new Error('Invalid training opening: ' + line.slice(0, i + 1).join(' '));
        pos.makeMove(move);
        moves.push(line[i]);
      }
    }
    return { index: index, pair: pairIndex == null ? null : pairIndex, san: moves, fen: pos.fen() };
  }
  function openingPosition(start) {
    if (!start.san.length) return new E.Position(start.fen);
    var pos = new E.Position();
    start.san.forEach(function (san) { pos.makeMove(E.parseSAN(pos, san)); });
    return pos;
  }

  function actualScore(result, color) {
    if (result === '1/2-1/2') return 0.5;
    if (result === '1-0') return color === E.WHITE ? 1 : 0;
    if (result === '0-1') return color === E.BLACK ? 1 : 0;
    return null;
  }

  function generateSelfPlay(model, opts, onProgress) {
    var cfg = options(opts), rng = createRNG(cfg.rngState == null ? cfg.seed : cfg.rngState);
    var samples = [], games = [], heldoutCount = cfg.selfPlayGames > 1 ? Math.max(1, Math.floor(cfg.selfPlayGames * cfg.heldoutFraction)) : 0;
    var partitions = [], i;
    for (i = 0; i < cfg.selfPlayGames; i++) partitions.push(i < heldoutCount ? 'heldout' : 'train');
    for (i = partitions.length - 1; i > 0; i--) {
      var j = Math.floor(rng.next() * (i + 1)), swap = partitions[i];
      partitions[i] = partitions[j]; partitions[j] = swap;
    }
    setModel(model);
    for (var g = 0; g < cfg.selfPlayGames; g++) {
      var start = opening(rng, cfg), pos = openingPosition(start), observations = [];
      var id = 'g' + cfg.generation + '-' + (cfg.nextGameId + g);
      var ply = start.san.length, status = E.gameStatus(pos);
      E.clearTT();
      while (!status.over && ply < cfg.maxPlies) {
        var search = E.think(pos, { moveTime: cfg.moveTime, maxDepth: cfg.maxDepth });
        if (!search.best) throw new Error('Search did not return a legal self-play move');
        var quiet = !pos.inCheck(pos.side) && !E.mCap(search.best) && !E.mEp(search.best) && !E.mPromo(search.best);
        if (quiet && search.depth > 0 && Number.isFinite(search.score) && Math.abs(search.score) < E.MATE - 1000 && ply >= cfg.sampleStartPly && (ply - cfg.sampleStartPly) % cfg.sampleEvery === 0) {
          observations.push({ gameId: id, fen: pos.fen(), side: pos.side, ply: ply, searchTarget: probability(search.score), partition: partitions[g] });
        }
        pos.makeMove(search.best);
        ply++;
        status = E.gameStatus(pos);
        if (ply % 32 === 0) notify(onProgress, { phase: 'selfplay', game: g + 1, games: cfg.selfPlayGames, ply: ply, samples: samples.length + observations.length });
      }
      var truncated = !status.over, result = status.over ? status.result : null;
      observations.forEach(function (sample) {
        sample.resultTarget = truncated ? null : actualScore(result, sample.side);
        sample.target = truncated ? sample.searchTarget : (1 - cfg.resultWeight) * sample.searchTarget + cfg.resultWeight * sample.resultTarget;
        sample.truncated = truncated;
        sample.source = truncated ? 'search-bootstrap' : 'search-and-result';
        delete sample.side;
        samples.push(sample);
      });
      games.push({ id: id, opening: start, plies: ply, result: result, reason: truncated ? 'ply-cap' : status.reason, truncated: truncated, samples: observations.length, partition: partitions[g] });
      notify(onProgress, { phase: 'selfplay', game: g + 1, games: cfg.selfPlayGames, ply: ply, result: result, truncated: truncated, samples: samples.length });
    }
    return { games: games, samples: samples, nextGameId: cfg.nextGameId + cfg.selfPlayGames, rngState: rng.state() };
  }

  function validSample(sample) {
    return sample && typeof sample.gameId === 'string' && sample.gameId.length > 0 && typeof sample.fen === 'string' && Number.isFinite(sample.target) && sample.target >= 0 && sample.target <= 1;
  }
  function splitByGame(samples, fraction, seed) {
    fraction = number(fraction, 0.2, 0.01, 0.5);
    var groups = Object.create(null), train = [], heldout = [], trainGames = [], heldoutGames = [];
    samples.forEach(function (sample) {
      if (!validSample(sample)) throw new Error('Invalid replay sample');
      var group = groups[sample.gameId] || (groups[sample.gameId] = { samples: [], partition: null });
      if (sample.partition === 'train' || sample.partition === 'heldout') {
        if (group.partition && group.partition !== sample.partition) throw new Error('A game cannot appear in both replay partitions');
        group.partition = sample.partition;
      }
      group.samples.push(sample);
    });
    Object.keys(groups).forEach(function (id) {
      var group = groups[id];
      // Hashing gives old/imported games a permanent partition as the replay grows.
      var partition = group.partition || (seedNumber(String(seedNumber(seed)) + ':' + id) / 4294967296 < fraction ? 'heldout' : 'train');
      group.samples.forEach(function (sample) { sample.partition = partition; });
      if (partition === 'heldout') { heldout.push.apply(heldout, group.samples); heldoutGames.push(id); }
      else { train.push.apply(train, group.samples); trainGames.push(id); }
    });
    return { train: train, heldout: heldout, trainGames: trainGames, heldoutGames: heldoutGames };
  }

  function evaluateLoss(model, samples) {
    var previous = E.exportNetwork(), squared = 0, crossEntropy = 0;
    try {
      setModel(model);
      samples.forEach(function (sample) {
        if (!validSample(sample)) throw new Error('Invalid loss sample');
        var predicted = probability(E.evaluate(new E.Position(sample.fen)));
        if (!Number.isFinite(predicted)) throw new Error('Non-finite network evaluation');
        var error = predicted - sample.target;
        squared += error * error;
        predicted = Math.max(1e-12, Math.min(1 - 1e-12, predicted));
        crossEntropy -= sample.target * Math.log(predicted) + (1 - sample.target) * Math.log(1 - predicted);
      });
    } finally { setModel(previous); }
    return { count: samples.length, mse: samples.length ? squared / samples.length : null, crossEntropy: samples.length ? crossEntropy / samples.length : null };
  }

  function relativeElo(score) {
    // Endpoints have infinite Elo; use null so checkpoints remain valid JSON.
    return score <= 0 || score >= 1 ? null : 400 * Math.log(score / (1 - score)) / Math.LN10;
  }
  function summarizeArena(results, opts) {
    var cfg = options(opts), grouped = Object.create(null), wins = 0, draws = 0, losses = 0, truncated = 0;
    results.forEach(function (game) {
      var pair = grouped[game.pair] || (grouped[game.pair] = []);
      pair.push(game);
      if (game.truncated || game.score == null) truncated++;
      else if (game.score === 1) wins++;
      else if (game.score === 0) losses++;
      else draws++;
    });
    var pairScores = [];
    Object.keys(grouped).forEach(function (id) {
      var pair = grouped[id];
      if (pair.length === 2 && pair[0].candidateColor !== pair[1].candidateColor && pair.every(function (game) { return !game.truncated && Number.isFinite(game.score); }))
        pairScores.push((pair[0].score + pair[1].score) / 2);
    });
    var mean = pairScores.length ? pairScores.reduce(function (sum, score) { return sum + score; }, 0) / pairScores.length : null;
    var radius = pairScores.length ? Math.sqrt(Math.log(2 / (1 - cfg.confidence)) / (2 * pairScores.length)) : null;
    var lower = mean == null ? null : Math.max(0, mean - radius);
    var upper = mean == null ? null : Math.min(1, mean + radius);
    var scoredGames = pairScores.length * 2;
    var incompletePairs = Object.keys(grouped).length - pairScores.length;
    // Censoring long games could preferentially hide losses. Complete-pair
    // estimates remain useful diagnostics, but incomplete matches cannot promote.
    var promoted = scoredGames >= cfg.minArenaGames && incompletePairs === 0 && lower > 0.5;
    return {
      attemptedGames: results.length, completedGames: wins + draws + losses, scoredGames: scoredGames,
      completePairs: pairScores.length, incompletePairs: incompletePairs,
      wins: wins, draws: draws, losses: losses, truncatedGames: truncated,
      score: mean, confidence: cfg.confidence, scoreInterval: [lower, upper],
      relativeElo: mean == null ? null : relativeElo(mean),
      relativeEloInterval: [lower == null ? null : relativeElo(lower), upper == null ? null : relativeElo(upper)],
      intervalMethod: 'paired Hoeffding bound', minGames: cfg.minArenaGames, promoted: promoted,
      reason: promoted ? 'Candidate passed the paired confidence gate' : incompletePairs ? 'Arena contains incomplete pairs; increase maxPlies before promotion' : scoredGames < cfg.minArenaGames ? 'Insufficient completed paired games' : 'Confidence interval does not establish an improvement',
      results: results
    };
  }

  function runArena(candidate, champion, opts, onProgress) {
    var cfg = options(opts), rng = createRNG(cfg.seed), results = [];
    var previous = E.exportNetwork(), succeeded = false;
    try {
    var pairCount = Math.floor(cfg.arenaGames / 2), activeModel;
    for (var pair = 0; pair < pairCount; pair++) {
      var start = opening(rng, cfg, pair), firstColor = rng.next() < 0.5 ? E.WHITE : E.BLACK;
      for (var colorGame = 0; colorGame < 2; colorGame++) {
        var candidateColor = colorGame ? firstColor ^ E.BLACK : firstColor;
        var pos = openingPosition(start), status = E.gameStatus(pos), ply = start.san.length;
        E.clearTT(); activeModel = undefined;
        while (!status.over && ply < cfg.maxPlies) {
          var model = pos.side === candidateColor ? candidate : champion;
          if (model !== activeModel) { setModel(model); activeModel = model; }
          var search = E.think(pos, { moveTime: cfg.moveTime, maxDepth: cfg.maxDepth });
          if (!search.best) throw new Error('Search did not return a legal arena move');
          pos.makeMove(search.best); ply++;
          status = E.gameStatus(pos);
        }
        var truncated = !status.over;
        results.push({ pair: pair, opening: start, candidateColor: candidateColor, plies: ply, result: truncated ? null : status.result, score: truncated ? null : actualScore(status.result, candidateColor), reason: truncated ? 'ply-cap' : status.reason, truncated: truncated });
        notify(onProgress, { phase: 'arena', game: results.length, games: pairCount * 2, result: results[results.length - 1].result, truncated: truncated });
      }
    }
    var summary = summarizeArena(results, cfg);
    succeeded = true;
    return summary;
    } finally { setModel(succeeded ? champion : previous); }
  }

  function normalizeReplay(replay) {
    if (replay == null) return { version: VERSION, generation: 0, nextGameId: 0, samples: [], rngState: null };
    if (Array.isArray(replay)) replay = { version: VERSION, generation: 0, nextGameId: replay.length, samples: replay, rngState: null };
    if (replay.version !== VERSION || !Array.isArray(replay.samples)) throw new Error('Unsupported replay checkpoint');
    if (!replay.samples.every(validSample)) throw new Error('Invalid replay checkpoint samples');
    var generation = integer(replay.generation, 0, 0, Number.MAX_SAFE_INTEGER);
    var nextGameId = integer(replay.nextGameId, replay.samples.length, 0, Number.MAX_SAFE_INTEGER);
    replay.samples.forEach(function (sample) {
      var match = /^g(\d+)-(\d+)$/.exec(sample.gameId);
      if (match) { generation = Math.max(generation, Number(match[1])); nextGameId = Math.max(nextGameId, Number(match[2]) + 1); }
    });
    return { version: VERSION, generation: generation, nextGameId: nextGameId, samples: copy(replay.samples), rngState: replay.rngState == null ? null : integer(replay.rngState, 0, 0, 4294967295), trainingCandidate: copy(replay.trainingCandidate), trainingChampionSignature: typeof replay.trainingChampionSignature === 'string' ? replay.trainingChampionSignature : null };
  }

  function runGeneration(champion, replay, opts, onProgress) {
    var cfg = options(opts), state = normalizeReplay(replay), started = Date.now();
    var previous = E.exportNetwork(), succeeded = false, selected;
    try {
    cfg.generation = state.generation + 1;
    cfg.nextGameId = state.nextGameId;
    cfg.rngState = state.rngState;
    champion = copy(champion);
    var championSignature = modelSignature(champion);
    var trainingResumed = !!state.trainingCandidate && state.trainingChampionSignature === championSignature;
    var generated = generateSelfPlay(champion, cfg, onProgress);
    var retained = state.samples.concat(generated.samples).slice(-cfg.maxReplay);
    var split = splitByGame(retained, cfg.heldoutFraction, cfg.seed);
    var candidate = null, metrics = null, arena;
    var championTrain = evaluateLoss(champion, split.train), championHeldout = evaluateLoss(champion, split.heldout);
    var candidateTrain = championTrain, candidateHeldout = championHeldout;
    if (split.train.length) {
      setModel(trainingResumed ? state.trainingCandidate : champion || E.createNetwork({ hidden: cfg.hidden, seed: (cfg.seed + cfg.generation) >>> 0 }));
      notify(onProgress, { phase: 'training', samples: split.train.length, heldout: split.heldout.length, epochs: cfg.epochs });
      metrics = E.trainNetwork(split.train, { epochs: cfg.epochs, learningRate: cfg.learningRate, seed: (cfg.seed + cfg.generation) >>> 0 });
      candidate = E.exportNetwork();
      candidateTrain = evaluateLoss(candidate, split.train);
      candidateHeldout = evaluateLoss(candidate, split.heldout);
      notify(onProgress, { phase: 'evaluation', train: candidateTrain, heldout: candidateHeldout });
      // Keep arena sampling independent of the self-play stream and reproducible.
      var arenaOpts = Object.assign({}, cfg, { seed: seedNumber(cfg.seed + ':arena:' + cfg.generation) });
      arena = runArena(candidate, champion, arenaOpts, onProgress);
    } else {
      arena = summarizeArena([], cfg);
      arena.reason = 'No eligible training positions were generated';
    }
    var promoted = !!candidate && arena.promoted;
    selected = promoted ? candidate : champion;
    setModel(selected);
    var report = {
      version: VERSION, generation: cfg.generation, seed: cfg.seed,
      durationMs: Date.now() - started, promoted: promoted,
      options: cfg,
      selfPlay: { games: generated.games, completedGames: generated.games.filter(function (game) { return !game.truncated; }).length, truncatedGames: generated.games.filter(function (game) { return game.truncated; }).length, samples: generated.samples.length },
      replay: { samples: retained.length, trainSamples: split.train.length, heldoutSamples: split.heldout.length, trainGames: split.trainGames.length, heldoutGames: split.heldoutGames.length },
      losses: { championTrain: championTrain, championHeldout: championHeldout, candidateTrain: candidateTrain, candidateHeldout: candidateHeldout },
      training: metrics, trainingResumed: trainingResumed, arena: arena,
      policy: 'Promote only after at least ' + cfg.minArenaGames + ' completed paired-color games, no incomplete pairs, and a paired confidence lower bound above 0.5; Elo is relative to this champion at this search budget.'
    };
    notify(onProgress, { phase: 'complete', generation: cfg.generation, promoted: promoted, reason: arena.reason });
    succeeded = true;
    return { candidate: candidate, champion: copy(selected), promoted: promoted, replay: { version: VERSION, generation: cfg.generation, nextGameId: generated.nextGameId, samples: retained, rngState: generated.rngState, trainingCandidate: promoted ? null : candidate || (trainingResumed ? state.trainingCandidate : null), trainingChampionSignature: promoted ? null : championSignature }, report: report };
    } finally { setModel(succeeded ? selected : previous); }
  }

  return {
    version: VERSION, scoreScale: SCORE_SCALE, promotionMinGames: PROMOTION_MIN_GAMES,
    createRNG: createRNG, probability: probability, defaults: options,
    generateSelfPlay: generateSelfPlay, splitByGame: splitByGame,
    evaluateLoss: evaluateLoss, runArena: runArena, summarizeArena: summarizeArena,
    normalizeReplay: normalizeReplay, runGeneration: runGeneration
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = LearningCore;
if (typeof globalThis !== 'undefined') globalThis.LearningCore = LearningCore;
