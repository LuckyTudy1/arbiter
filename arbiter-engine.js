#!/usr/bin/env node
/* ============================================================
   Arbiter 2.0 - a chess engine written from scratch.

   No external engine code, no neural network, no dependencies.
   0x88 board, alpha-beta search with transposition table,
   null-move pruning, late move reductions, static exchange
   evaluation, quiescence search, hand-written evaluation.

   UCI engine:  node arbiter-engine.js
   Library:     const E = require('./arbiter-engine.js')

   MIT licensed. See LICENSE.
   ============================================================ */

function ChessCore() {
  'use strict';
  var G = (typeof self !== 'undefined') ? self : globalThis;

  var EMPTY = 0;
  var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  var WHITE = 0, BLACK = 8;

  var KNIGHT_OFF = [-33, -31, -18, -14, 14, 18, 31, 33];
  var BISHOP_OFF = [-17, -15, 15, 17];
  var ROOK_OFF = [-16, -1, 1, 16];
  var KING_OFF = [-17, -16, -15, -1, 1, 15, 16, 17];

  var CW_K = 1, CW_Q = 2, CB_K = 4, CB_Q = 8;

  function mk(from, to, promo, cap, ep, castle, dbl) {
    return from | (to << 7) | (promo << 14) | (cap << 18) | (ep << 22) | (castle << 23) | (dbl << 24);
  }
  function mFrom(m) { return m & 127; }
  function mTo(m) { return (m >> 7) & 127; }
  function mPromo(m) { return (m >> 14) & 15; }
  function mCap(m) { return (m >> 18) & 15; }
  function mEp(m) { return (m >> 22) & 1; }
  function mCastle(m) { return (m >> 23) & 1; }
  function mDbl(m) { return (m >> 24) & 1; }
  function onBoard(sq) { return (sq & 0x88) === 0; }

  function rnd32() { return (Math.random() * 0x100000000) >>> 0; }
  var ZP = [];
  for (var zi = 0; zi < 16; zi++) {
    ZP[zi] = new Uint32Array(256);
    for (var zs = 0; zs < 256; zs++) ZP[zi][zs] = rnd32();
  }
  var ZSIDE = rnd32();
  var ZCASTLE = new Uint32Array(16);
  for (var zc = 0; zc < 16; zc++) ZCASTLE[zc] = rnd32();
  var ZEP = new Uint32Array(256);
  for (var ze = 0; ze < 256; ze++) ZEP[ze] = rnd32();

  function algToSq(a) { return (a.charCodeAt(1) - 49) * 16 + (a.charCodeAt(0) - 97); }
  function sqToAlg(sq) { return String.fromCharCode(97 + (sq & 15)) + String.fromCharCode(49 + (sq >> 4)); }
  function pieceChar(p) {
    var c = ' pnbrqk'[p & 7];
    return (p & BLACK) ? c : c.toUpperCase();
  }

  /* ===================== Position ===================== */
  function Position(fen) {
    this.board = new Int8Array(128);
    this.side = WHITE;
    this.castling = 0;
    this.ep = -1;
    this.half = 0;
    this.full = 1;
    this.kings = [-1, -1];
    this.hash = 0;
    this.history = [];
    this.repList = [];
    this.setFen(fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  }

  Position.prototype.setFen = function (fen) {
    this.board.fill(0);
    var parts = fen.trim().split(/\s+/);
    var rows = parts[0].split('/');
    var map = { p: P | BLACK, n: N | BLACK, b: B | BLACK, r: R | BLACK, q: Q | BLACK, k: K | BLACK, P: P, N: N, B: B, R: R, Q: Q, K: K };
    for (var r = 0; r < 8; r++) {
      var row = rows[r], file = 0, rank = 7 - r;
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch >= '1' && ch <= '8') { file += +ch; continue; }
        var sq = rank * 16 + file;
        this.board[sq] = map[ch];
        if (map[ch] === K) this.kings[0] = sq;
        if (map[ch] === (K | BLACK)) this.kings[1] = sq;
        file++;
      }
    }
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    if (parts[2] && parts[2] !== '-') {
      if (parts[2].indexOf('K') >= 0) this.castling |= CW_K;
      if (parts[2].indexOf('Q') >= 0) this.castling |= CW_Q;
      if (parts[2].indexOf('k') >= 0) this.castling |= CB_K;
      if (parts[2].indexOf('q') >= 0) this.castling |= CB_Q;
    }
    this.ep = (parts[3] && parts[3] !== '-') ? algToSq(parts[3]) : -1;
    this.half = parts[4] ? +parts[4] : 0;
    this.full = parts[5] ? +parts[5] : 1;
    this.history = [];
    this.hash = this.computeHash();
    this.repList = [this.hash];
  };

  Position.prototype.fen = function () {
    var s = '';
    for (var r = 7; r >= 0; r--) {
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = this.board[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        s += pieceChar(p);
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    s += this.side === WHITE ? ' w ' : ' b ';
    var c = '';
    if (this.castling & CW_K) c += 'K';
    if (this.castling & CW_Q) c += 'Q';
    if (this.castling & CB_K) c += 'k';
    if (this.castling & CB_Q) c += 'q';
    s += c || '-';
    s += ' ' + (this.ep >= 0 ? sqToAlg(this.ep) : '-');
    s += ' ' + this.half + ' ' + this.full;
    return s;
  };

  Position.prototype.computeHash = function () {
    var h = 0;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      var p = this.board[sq];
      if (p) h ^= ZP[p][sq];
    }
    if (this.side === BLACK) h ^= ZSIDE;
    h ^= ZCASTLE[this.castling];
    if (this.ep >= 0) h ^= ZEP[this.ep];
    return h >>> 0;
  };

  Position.prototype.attacked = function (sq, byColor) {
    var t, i, d, p, bd = this.board;
    if (byColor === WHITE) {
      t = sq - 15; if (onBoard(t) && bd[t] === P) return true;
      t = sq - 17; if (onBoard(t) && bd[t] === P) return true;
    } else {
      t = sq + 15; if (onBoard(t) && bd[t] === (P | BLACK)) return true;
      t = sq + 17; if (onBoard(t) && bd[t] === (P | BLACK)) return true;
    }
    for (i = 0; i < 8; i++) { t = sq + KNIGHT_OFF[i]; if (onBoard(t) && bd[t] === (N | byColor)) return true; }
    for (i = 0; i < 8; i++) { t = sq + KING_OFF[i]; if (onBoard(t) && bd[t] === (K | byColor)) return true; }
    for (i = 0; i < 4; i++) {
      d = BISHOP_OFF[i]; t = sq + d;
      while (onBoard(t)) {
        p = bd[t];
        if (p) { if (p === (B | byColor) || p === (Q | byColor)) return true; break; }
        t += d;
      }
    }
    for (i = 0; i < 4; i++) {
      d = ROOK_OFF[i]; t = sq + d;
      while (onBoard(t)) {
        p = bd[t];
        if (p) { if (p === (R | byColor) || p === (Q | byColor)) return true; break; }
        t += d;
      }
    }
    return false;
  };

  Position.prototype.inCheck = function (color) {
    var k = this.kings[color === WHITE ? 0 : 1];
    return k >= 0 && this.attacked(k, color ^ BLACK);
  };

  Position.prototype.genMoves = function (capturesOnly) {
    var out = [], bd = this.board;
    var us = this.side, them = us ^ BLACK;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      var pc = bd[sq];
      if (!pc || (pc & BLACK) !== us) continue;
      var type = pc & 7, i, t, tp, d, offs;

      if (type === P) {
        var dir = us === WHITE ? 16 : -16;
        var startRank = us === WHITE ? 1 : 6;
        var promoRank = us === WHITE ? 6 : 1;
        var rank = sq >> 4;
        var caps = [dir - 1, dir + 1];
        for (i = 0; i < 2; i++) {
          t = sq + caps[i];
          if (!onBoard(t)) continue;
          tp = bd[t];
          if (tp && (tp & BLACK) === them) {
            if (rank === promoRank) {
              out.push(mk(sq, t, Q, tp, 0, 0, 0)); out.push(mk(sq, t, R, tp, 0, 0, 0));
              out.push(mk(sq, t, B, tp, 0, 0, 0)); out.push(mk(sq, t, N, tp, 0, 0, 0));
            } else out.push(mk(sq, t, 0, tp, 0, 0, 0));
          } else if (!tp && t === this.ep) {
            out.push(mk(sq, t, 0, P | them, 1, 0, 0));
          }
        }
        if (capturesOnly) {
          t = sq + dir;
          if (rank === promoRank && onBoard(t) && !bd[t]) out.push(mk(sq, t, Q, 0, 0, 0, 0));
          continue;
        }
        t = sq + dir;
        if (onBoard(t) && !bd[t]) {
          if (rank === promoRank) {
            out.push(mk(sq, t, Q, 0, 0, 0, 0)); out.push(mk(sq, t, R, 0, 0, 0, 0));
            out.push(mk(sq, t, B, 0, 0, 0, 0)); out.push(mk(sq, t, N, 0, 0, 0, 0));
          } else {
            out.push(mk(sq, t, 0, 0, 0, 0, 0));
            var t2 = sq + dir * 2;
            if (rank === startRank && !bd[t2]) out.push(mk(sq, t2, 0, 0, 0, 0, 1));
          }
        }
        continue;
      }

      if (type === N || type === K) {
        offs = type === N ? KNIGHT_OFF : KING_OFF;
        for (i = 0; i < 8; i++) {
          t = sq + offs[i];
          if (!onBoard(t)) continue;
          tp = bd[t];
          if (tp && (tp & BLACK) === us) continue;
          if (capturesOnly && !tp) continue;
          out.push(mk(sq, t, 0, tp, 0, 0, 0));
        }
        continue;
      }

      offs = type === B ? BISHOP_OFF : (type === R ? ROOK_OFF : KING_OFF);
      for (i = 0; i < offs.length; i++) {
        d = offs[i]; t = sq + d;
        while (onBoard(t)) {
          tp = bd[t];
          if (tp) { if ((tp & BLACK) === them) out.push(mk(sq, t, 0, tp, 0, 0, 0)); break; }
          if (!capturesOnly) out.push(mk(sq, t, 0, 0, 0, 0, 0));
          t += d;
        }
      }
    }

    if (!capturesOnly) {
      if (us === WHITE) {
        if ((this.castling & CW_K) && !bd[0x05] && !bd[0x06] && bd[0x07] === R && bd[0x04] === K &&
          !this.attacked(0x04, BLACK) && !this.attacked(0x05, BLACK) && !this.attacked(0x06, BLACK))
          out.push(mk(0x04, 0x06, 0, 0, 0, 1, 0));
        if ((this.castling & CW_Q) && !bd[0x03] && !bd[0x02] && !bd[0x01] && bd[0x00] === R && bd[0x04] === K &&
          !this.attacked(0x04, BLACK) && !this.attacked(0x03, BLACK) && !this.attacked(0x02, BLACK))
          out.push(mk(0x04, 0x02, 0, 0, 0, 1, 0));
      } else {
        if ((this.castling & CB_K) && !bd[0x75] && !bd[0x76] && bd[0x77] === (R | BLACK) && bd[0x74] === (K | BLACK) &&
          !this.attacked(0x74, WHITE) && !this.attacked(0x75, WHITE) && !this.attacked(0x76, WHITE))
          out.push(mk(0x74, 0x76, 0, 0, 0, 1, 0));
        if ((this.castling & CB_Q) && !bd[0x73] && !bd[0x72] && !bd[0x71] && bd[0x70] === (R | BLACK) && bd[0x74] === (K | BLACK) &&
          !this.attacked(0x74, WHITE) && !this.attacked(0x73, WHITE) && !this.attacked(0x72, WHITE))
          out.push(mk(0x74, 0x72, 0, 0, 0, 1, 0));
      }
    }
    return out;
  };

  Position.prototype.legalMoves = function () {
    var ms = this.genMoves(false), res = [];
    for (var i = 0; i < ms.length; i++) {
      if (this.makeMove(ms[i])) { this.unmakeMove(); res.push(ms[i]); }
    }
    return res;
  };

  Position.prototype.makeMove = function (m) {
    var from = mFrom(m), to = mTo(m), bd = this.board;
    var pc = bd[from], us = pc & BLACK, them = us ^ BLACK, type = pc & 7;

    this.history.push({
      move: m, castling: this.castling, ep: this.ep, half: this.half,
      hash: this.hash, kw: this.kings[0], kb: this.kings[1], full: this.full
    });

    var h = this.hash;
    if (this.ep >= 0) h ^= ZEP[this.ep];
    h ^= ZCASTLE[this.castling];

    if (mEp(m)) {
      var capSq = to + (us === WHITE ? -16 : 16);
      h ^= ZP[bd[capSq]][capSq];
      bd[capSq] = EMPTY;
    } else if (mCap(m)) {
      h ^= ZP[bd[to]][to];
    }

    h ^= ZP[pc][from];
    bd[from] = EMPTY;
    var placed = mPromo(m) ? (mPromo(m) | us) : pc;
    bd[to] = placed;
    h ^= ZP[placed][to];

    if (type === K) {
      this.kings[us === WHITE ? 0 : 1] = to;
      if (mCastle(m)) {
        var rf, rt;
        if (to === 0x06) { rf = 0x07; rt = 0x05; }
        else if (to === 0x02) { rf = 0x00; rt = 0x03; }
        else if (to === 0x76) { rf = 0x77; rt = 0x75; }
        else { rf = 0x70; rt = 0x73; }
        var rp = bd[rf];
        h ^= ZP[rp][rf];
        bd[rf] = EMPTY;
        bd[rt] = rp;
        h ^= ZP[rp][rt];
      }
    }

    if (from === 0x04 || to === 0x04) this.castling &= ~(CW_K | CW_Q);
    if (from === 0x74 || to === 0x74) this.castling &= ~(CB_K | CB_Q);
    if (from === 0x00 || to === 0x00) this.castling &= ~CW_Q;
    if (from === 0x07 || to === 0x07) this.castling &= ~CW_K;
    if (from === 0x70 || to === 0x70) this.castling &= ~CB_Q;
    if (from === 0x77 || to === 0x77) this.castling &= ~CB_K;
    h ^= ZCASTLE[this.castling];

    this.ep = mDbl(m) ? (from + (us === WHITE ? 16 : -16)) : -1;
    if (this.ep >= 0) h ^= ZEP[this.ep];

    this.half = (type === P || mCap(m)) ? 0 : this.half + 1;
    if (us === BLACK) this.full++;

    this.side = them;
    h ^= ZSIDE;
    this.hash = h >>> 0;
    this.repList.push(this.hash);

    if (this.attacked(this.kings[us === WHITE ? 0 : 1], them)) {
      this.unmakeMove();
      return false;
    }
    return true;
  };

  Position.prototype.unmakeMove = function () {
    var rec = this.history.pop();
    if (!rec) return;
    var m = rec.move, from = mFrom(m), to = mTo(m), bd = this.board;
    var placed = bd[to], us = placed & BLACK;

    this.side = us;
    bd[from] = mPromo(m) ? (P | us) : placed;
    bd[to] = EMPTY;

    if (mEp(m)) {
      bd[to + (us === WHITE ? -16 : 16)] = P | (us ^ BLACK);
    } else if (mCap(m)) {
      bd[to] = mCap(m);
    }

    if (mCastle(m)) {
      var rf, rt;
      if (to === 0x06) { rf = 0x07; rt = 0x05; }
      else if (to === 0x02) { rf = 0x00; rt = 0x03; }
      else if (to === 0x76) { rf = 0x77; rt = 0x75; }
      else { rf = 0x70; rt = 0x73; }
      bd[rf] = bd[rt];
      bd[rt] = EMPTY;
    }

    this.castling = rec.castling;
    this.ep = rec.ep;
    this.half = rec.half;
    this.full = rec.full;
    this.hash = rec.hash;
    this.kings[0] = rec.kw;
    this.kings[1] = rec.kb;
    if (this.repList.length > 1) this.repList.pop();
  };

  Position.prototype.clone = function () { return new Position(this.fen()); };

  /* ===================== Evaluation ===================== */
  var VAL = [0, 100, 320, 330, 500, 900, 20000];
  var SEE_VAL = [0, 100, 320, 330, 500, 900, 10000];
  var PHASE_W = [0, 0, 1, 1, 2, 4, 0];
  var TOTAL_PHASE = 24;

  function flipTable(t) {
    var o = new Int16Array(64);
    for (var r = 0; r < 8; r++)
      for (var f = 0; f < 8; f++)
        o[r * 8 + f] = t[(7 - r) * 8 + f];
    return o;
  }

  var PST_MG = [];
  var PST_EG = [];

  PST_MG[P] = flipTable([
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 27, 27, 10, 5, 5,
    0, 0, 0, 25, 25, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -25, -25, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0]);
  PST_EG[P] = flipTable([
    0, 0, 0, 0, 0, 0, 0, 0,
    90, 90, 90, 90, 90, 90, 90, 90,
    55, 55, 55, 55, 55, 55, 55, 55,
    32, 32, 32, 32, 32, 32, 32, 32,
    18, 18, 18, 18, 18, 18, 18, 18,
    8, 8, 8, 8, 8, 8, 8, 8,
    4, 4, 4, 4, 4, 4, 4, 4,
    0, 0, 0, 0, 0, 0, 0, 0]);

  PST_MG[N] = flipTable([
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50]);
  PST_EG[N] = PST_MG[N];

  PST_MG[B] = flipTable([
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20]);
  PST_EG[B] = PST_MG[B];

  PST_MG[R] = flipTable([
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 5, 10, 10, 5, 0, 0]);
  PST_EG[R] = PST_MG[R];

  PST_MG[Q] = flipTable([
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20]);
  PST_EG[Q] = PST_MG[Q];

  PST_MG[K] = flipTable([
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20]);
  PST_EG[K] = flipTable([
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50]);

  var PASSED_MG = [0, 5, 10, 20, 36, 62, 100, 0];
  var PASSED_EG = [0, 10, 18, 32, 58, 96, 150, 0];

  // mobility bonuses, indexed by number of safe squares
  var MOB_N_MG = [-30, -18, -8, 0, 6, 12, 17, 21, 24];
  var MOB_N_EG = [-32, -20, -9, 0, 7, 13, 18, 22, 25];
  var MOB_B_MG = [-28, -16, -6, 2, 9, 15, 20, 24, 27, 30, 32, 34, 36, 37];
  var MOB_B_EG = [-30, -18, -7, 3, 11, 18, 24, 29, 33, 36, 38, 40, 42, 43];
  var MOB_R_MG = [-22, -12, -5, 0, 3, 7, 11, 15, 18, 21, 23, 25, 26, 27, 28];
  var MOB_R_EG = [-28, -14, -4, 6, 14, 21, 27, 32, 36, 39, 42, 44, 46, 47, 48];
  var MOB_Q_MG = [-18, -10, -4, 0, 3, 6, 9, 11, 13, 15, 16, 17, 18, 19, 20, 21, 21, 22, 22, 23, 23, 24, 24, 24, 25, 25, 25, 25];
  var MOB_Q_EG = [-24, -14, -6, 2, 8, 14, 19, 23, 27, 30, 33, 35, 37, 39, 40, 41, 42, 43, 44, 45, 45, 46, 46, 47, 47, 47, 48, 48];

  // king danger lookup: rises quadratically then saturates
  var KING_DANGER = new Int16Array(80);
  for (var kd = 0; kd < 80; kd++) {
    var v = (kd * kd) / 3.6;
    KING_DANGER[kd] = Math.min(600, Math.round(v));
  }

  var ATT_WEIGHT = [0, 0, 2, 2, 3, 5, 0];

  function fileOf(sq) { return sq & 15; }
  function rankOf(sq) { return sq >> 4; }
  function sqDist(a, b) {
    var df = Math.abs(fileOf(a) - fileOf(b)), dr = Math.abs(rankOf(a) - rankOf(b));
    return df > dr ? df : dr;
  }
  function centerDist(sq) {
    var f = fileOf(sq), r = rankOf(sq);
    var df = f < 4 ? 3 - f : f - 4;
    var dr = r < 4 ? 3 - r : r - 4;
    return df > dr ? df : dr;
  }

  // scratch buffers reused every eval to avoid allocation
  var wPawnAtt = new Int8Array(128);
  var bPawnAtt = new Int8Array(128);

  function evaluate(pos) {
    var bd = pos.board;
    var mg = 0, eg = 0, phase = 0;
    var wPawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    var bPawnFiles = [0, 0, 0, 0, 0, 0, 0, 0];
    var wPawnRankMax = [-1, -1, -1, -1, -1, -1, -1, -1];
    var bPawnRankMin = [8, 8, 8, 8, 8, 8, 8, 8];
    var wBishops = 0, bBishops = 0;
    var wNonPawn = 0, bNonPawn = 0;
    var sq, pc, type, r, f, i, d, t, tp;

    wPawnAtt.fill(0);
    bPawnAtt.fill(0);

    /* pass 1: pawn skeleton, material counts */
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      pc = bd[sq];
      if (!pc) continue;
      type = pc & 7;
      r = rankOf(sq); f = fileOf(sq);
      if (type === P) {
        if (pc & BLACK) {
          bPawnFiles[f]++;
          if (r < bPawnRankMin[f]) bPawnRankMin[f] = r;
          t = sq - 15; if (onBoard(t)) bPawnAtt[t] = 1;
          t = sq - 17; if (onBoard(t)) bPawnAtt[t] = 1;
        } else {
          wPawnFiles[f]++;
          if (r > wPawnRankMax[f]) wPawnRankMax[f] = r;
          t = sq + 15; if (onBoard(t)) wPawnAtt[t] = 1;
          t = sq + 17; if (onBoard(t)) wPawnAtt[t] = 1;
        }
      } else if (type !== K) {
        if (type === B) { if (pc & BLACK) bBishops++; else wBishops++; }
        if (pc & BLACK) bNonPawn += VAL[type]; else wNonPawn += VAL[type];
      }
      phase += PHASE_W[type];
    }

    var wKing = pos.kings[0], bKing = pos.kings[1];
    var wAttackUnits = 0, bAttackUnits = 0;

    /* pass 2: per-piece evaluation */
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      pc = bd[sq];
      if (!pc) continue;
      type = pc & 7;
      r = rankOf(sq); f = fileOf(sq);
      var black = (pc & BLACK) !== 0;
      var idx = black ? ((7 - r) * 8 + f) : (r * 8 + f);
      var vmg = VAL[type] + PST_MG[type][idx];
      var veg = VAL[type] + PST_EG[type][idx];
      var oppKing = black ? wKing : bKing;
      var oppPawnAtt = black ? wPawnAtt : bPawnAtt;
      var ownPawnAtt = black ? bPawnAtt : wPawnAtt;
      var attUnits = 0;

      if (type === P) {
        var own = black ? bPawnFiles : wPawnFiles;
        if (own[f] > 1) { vmg -= 14; veg -= 24; }
        var isolated = (f === 0 || !own[f - 1]) && (f === 7 || !own[f + 1]);
        if (isolated) { vmg -= 16; veg -= 20; }
        var passed = true;
        for (var df = -1; df <= 1; df++) {
          var nf = f + df;
          if (nf < 0 || nf > 7) continue;
          if (black) { if (wPawnFiles[nf] && wPawnRankMax[nf] < r) passed = false; }
          else { if (bPawnFiles[nf] && bPawnRankMin[nf] > r) passed = false; }
        }
        if (passed) {
          var adv = black ? (7 - r) : r;
          vmg += PASSED_MG[adv];
          veg += PASSED_EG[adv];
          // passed pawn is worth more when the enemy king is far from it
          veg += (sqDist(oppKing, sq) - sqDist(black ? bKing : wKing, sq)) * adv * 2;
        }
        // pawn defended by another pawn
        if (ownPawnAtt[sq]) { vmg += 6; veg += 8; }
      } else if (type === N || type === B) {
        var offs = type === N ? KNIGHT_OFF : BISHOP_OFF;
        var mob = 0;
        if (type === N) {
          for (i = 0; i < 8; i++) {
            t = sq + offs[i];
            if (!onBoard(t)) continue;
            tp = bd[t];
            if (tp && ((tp & BLACK) !== 0) === black) continue;
            if (oppPawnAtt[t]) continue;
            mob++;
            if (sqDist(t, oppKing) <= 1) attUnits += ATT_WEIGHT[N];
          }
          if (mob > 8) mob = 8;
          vmg += MOB_N_MG[mob]; veg += MOB_N_EG[mob];
        } else {
          for (i = 0; i < 4; i++) {
            d = offs[i]; t = sq + d;
            while (onBoard(t)) {
              tp = bd[t];
              if (tp && ((tp & BLACK) !== 0) === black) break;
              if (!oppPawnAtt[t]) mob++;
              if (sqDist(t, oppKing) <= 1) attUnits += ATT_WEIGHT[B];
              if (tp) break;
              t += d;
            }
          }
          if (mob > 13) mob = 13;
          vmg += MOB_B_MG[mob]; veg += MOB_B_EG[mob];
        }
        // outpost: protected by own pawn, cannot be hit by an enemy pawn
        if (ownPawnAtt[sq] && !oppPawnAtt[sq]) {
          var advRank = black ? (7 - r) : r;
          if (advRank >= 3 && advRank <= 5) {
            var canBeHit = false;
            for (var of2 = -1; of2 <= 1; of2 += 2) {
              var nf2 = f + of2;
              if (nf2 < 0 || nf2 > 7) continue;
              if (black) { if (wPawnFiles[nf2] && wPawnRankMax[nf2] < r) canBeHit = true; }
              else { if (bPawnFiles[nf2] && bPawnRankMin[nf2] > r) canBeHit = true; }
            }
            if (!canBeHit) { vmg += type === N ? 26 : 18; veg += type === N ? 16 : 10; }
          }
        }
      } else if (type === R) {
        var mobR = 0;
        for (i = 0; i < 4; i++) {
          d = ROOK_OFF[i]; t = sq + d;
          while (onBoard(t)) {
            tp = bd[t];
            if (tp && ((tp & BLACK) !== 0) === black) break;
            if (!oppPawnAtt[t]) mobR++;
            if (sqDist(t, oppKing) <= 1) attUnits += ATT_WEIGHT[R];
            if (tp) break;
            t += d;
          }
        }
        if (mobR > 14) mobR = 14;
        vmg += MOB_R_MG[mobR]; veg += MOB_R_EG[mobR];
        var ownP = black ? bPawnFiles : wPawnFiles;
        var oppP = black ? wPawnFiles : bPawnFiles;
        if (!ownP[f]) { vmg += oppP[f] ? 14 : 28; veg += 12; }
        // rook on the 7th (relative)
        var relRank = black ? (7 - r) : r;
        if (relRank === 6) { vmg += 22; veg += 30; }
      } else if (type === Q) {
        var mobQ = 0;
        for (i = 0; i < 8; i++) {
          d = KING_OFF[i]; t = sq + d;
          while (onBoard(t)) {
            tp = bd[t];
            if (tp && ((tp & BLACK) !== 0) === black) break;
            if (!oppPawnAtt[t]) mobQ++;
            if (sqDist(t, oppKing) <= 1) attUnits += ATT_WEIGHT[Q];
            if (tp) break;
            t += d;
          }
        }
        if (mobQ > 27) mobQ = 27;
        vmg += MOB_Q_MG[mobQ]; veg += MOB_Q_EG[mobQ];
      } else if (type === K) {
        var shield = 0;
        var fwd = black ? -16 : 16;
        var ownPawn = P | (black ? BLACK : 0);
        for (var sf = -1; sf <= 1; sf++) {
          var s1 = sq + fwd + sf;
          if (onBoard(s1) && bd[s1] === ownPawn) shield += 10;
          var s2 = sq + fwd * 2 + sf;
          if (onBoard(s2) && bd[s2] === ownPawn) shield += 5;
        }
        // open files next to the king are dangerous
        var oppMat = black ? wNonPawn : bNonPawn;
        var ownPF = black ? bPawnFiles : wPawnFiles;
        for (var kf = f - 1; kf <= f + 1; kf++) {
          if (kf < 0 || kf > 7) continue;
          if (!ownPF[kf]) shield -= 14;
        }
        vmg += Math.round(shield * Math.min(1, oppMat / 1400));
      }

      if (black) { mg -= vmg; eg -= veg; bAttackUnits += attUnits; }
      else { mg += vmg; eg += veg; wAttackUnits += attUnits; }
    }

    if (wBishops >= 2) { mg += 32; eg += 48; }
    if (bBishops >= 2) { mg -= 32; eg -= 48; }

    // king danger only matters while the attacker still has material
    if (bNonPawn >= 900) {
      var wu = Math.min(79, bAttackUnits);
      mg -= KING_DANGER[wu];
    }
    if (wNonPawn >= 900) {
      var bu = Math.min(79, wAttackUnits);
      mg += KING_DANGER[bu];
    }

    if (phase > TOTAL_PHASE) phase = TOTAL_PHASE;
    var score = ((mg * phase) + (eg * (TOTAL_PHASE - phase))) / TOTAL_PHASE;

    /* lone-king mate driving: push the bare king to the edge, bring ours close */
    var wPawnCount = 0, bPawnCount = 0;
    for (i = 0; i < 8; i++) { wPawnCount += wPawnFiles[i]; bPawnCount += bPawnFiles[i]; }
    if (score > 400 && bPawnCount === 0 && bNonPawn <= 330) {
      score += 12 * (3 - centerDist(bKing)) + 8 * (7 - sqDist(wKing, bKing));
    } else if (score < -400 && wPawnCount === 0 && wNonPawn <= 330) {
      score -= 12 * (3 - centerDist(wKing)) + 8 * (7 - sqDist(wKing, bKing));
    }

    /* drawish scaling: no pawns and near-equal material rarely wins */
    if (wPawnCount === 0 && bPawnCount === 0 && Math.abs(wNonPawn - bNonPawn) < 400) score = score / 4;

    score += (pos.side === WHITE ? 12 : -12); // tempo
    return pos.side === WHITE ? score : -score;
  }

  /* ---------- static exchange evaluation ---------- */
  var seeRemoved = new Int8Array(128);
  var seeTouched = new Int32Array(40);
  var seeGain = new Int32Array(40);

  function leastValuableAttacker(pos, sq, side) {
    var bd = pos.board, i, d, t, p;
    // pawns
    if (side === WHITE) {
      t = sq - 15; if (onBoard(t) && !seeRemoved[t] && bd[t] === P) return t;
      t = sq - 17; if (onBoard(t) && !seeRemoved[t] && bd[t] === P) return t;
    } else {
      t = sq + 15; if (onBoard(t) && !seeRemoved[t] && bd[t] === (P | BLACK)) return t;
      t = sq + 17; if (onBoard(t) && !seeRemoved[t] && bd[t] === (P | BLACK)) return t;
    }
    for (i = 0; i < 8; i++) {
      t = sq + KNIGHT_OFF[i];
      if (onBoard(t) && !seeRemoved[t] && bd[t] === (N | side)) return t;
    }
    for (i = 0; i < 4; i++) {
      d = BISHOP_OFF[i]; t = sq + d;
      while (onBoard(t)) {
        p = bd[t];
        if (p && !seeRemoved[t]) { if (p === (B | side)) return t; break; }
        t += d;
      }
    }
    for (i = 0; i < 4; i++) {
      d = ROOK_OFF[i]; t = sq + d;
      while (onBoard(t)) {
        p = bd[t];
        if (p && !seeRemoved[t]) { if (p === (R | side)) return t; break; }
        t += d;
      }
    }
    for (i = 0; i < 8; i++) {
      d = KING_OFF[i]; t = sq + d;
      while (onBoard(t)) {
        p = bd[t];
        if (p && !seeRemoved[t]) { if (p === (Q | side)) return t; break; }
        t += d;
      }
    }
    for (i = 0; i < 8; i++) {
      t = sq + KING_OFF[i];
      if (onBoard(t) && !seeRemoved[t] && bd[t] === (K | side)) return t;
    }
    return -1;
  }

  function see(pos, m) {
    var from = mFrom(m), to = mTo(m), bd = pos.board;
    var us = pos.side, them = us ^ BLACK;
    var nTouched = 0, d = 0;

    var captured = mEp(m) ? P : (mCap(m) & 7);
    if (!captured && !mPromo(m)) return 0;

    seeGain[0] = SEE_VAL[captured];
    seeRemoved[from] = 1; seeTouched[nTouched++] = from;
    if (mEp(m)) {
      var epSq = to + (us === WHITE ? -16 : 16);
      seeRemoved[epSq] = 1; seeTouched[nTouched++] = epSq;
    }
    var attackerVal = SEE_VAL[bd[from] & 7];
    if (mPromo(m)) { seeGain[0] += SEE_VAL[mPromo(m)] - SEE_VAL[P]; attackerVal = SEE_VAL[mPromo(m)]; }

    var side = them;
    while (true) {
      d++;
      if (d >= 38) break;
      seeGain[d] = attackerVal - seeGain[d - 1];
      var lva = leastValuableAttacker(pos, to, side);
      if (lva < 0) break;
      // a king may not capture into a square the other side still defends
      if ((bd[lva] & 7) === K) {
        seeRemoved[lva] = 1; seeTouched[nTouched++] = lva;
        if (leastValuableAttacker(pos, to, side ^ BLACK) >= 0) { d--; break; }
      } else {
        seeRemoved[lva] = 1; seeTouched[nTouched++] = lva;
      }
      attackerVal = SEE_VAL[bd[lva] & 7];
      side ^= BLACK;
    }
    while (nTouched-- > 0) seeRemoved[seeTouched[nTouched]] = 0;
    while (--d > 0) seeGain[d - 1] = -Math.max(-seeGain[d - 1], seeGain[d]);
    return seeGain[0];
  }

  /* ===================== Search ===================== */
  var MATE = 30000;
  var INF = 1000000;

  var TT_BITS = 21;
  var TT_SIZE = 1 << TT_BITS;
  var TT_MASK = TT_SIZE - 1;
  // two buckets per slot: [0] depth-preferred, [1] always-replace
  var ttKey = new Int32Array(TT_SIZE * 2);
  var ttMove = new Int32Array(TT_SIZE * 2);
  var ttScore = new Int32Array(TT_SIZE * 2);
  var ttDepth = new Int8Array(TT_SIZE * 2);
  var ttFlag = new Int8Array(TT_SIZE * 2);

  var TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
  var MAX_PLY = 96;

  var killers = [];
  for (var ki = 0; ki < MAX_PLY + 8; ki++) killers.push([0, 0]);
  var historyTbl = new Int32Array(16 * 128);
  var counterMove = new Int32Array(16 * 128);
  var evalStack = new Int32Array(MAX_PLY + 8);

  var nodes = 0, stopFlag = false, deadline = 0, searchAborted = false;

  // precomputed reduction table for late move reductions
  var LMR = [];
  for (var ld = 0; ld < 64; ld++) {
    LMR[ld] = new Int8Array(64);
    for (var lm = 0; lm < 64; lm++) {
      if (ld < 3 || lm < 2) LMR[ld][lm] = 0;
      else LMR[ld][lm] = Math.min(ld - 1, Math.round(0.80 + Math.log(ld) * Math.log(lm) / 2.20));
    }
  }
  var FUTILITY = [0, 110, 210, 320];
  var LMP = [0, 5, 8, 13, 20, 29, 40];

  function clearTT() {
    ttKey.fill(0); ttMove.fill(0); ttScore.fill(0); ttDepth.fill(0); ttFlag.fill(0);
    historyTbl.fill(0); counterMove.fill(0);
    for (var i = 0; i < killers.length; i++) { killers[i][0] = 0; killers[i][1] = 0; }
  }

  function isRepetition(pos) {
    var h = pos.hash;
    var start = pos.repList.length - 1 - pos.half;
    if (start < 0) start = 0;
    for (var i = pos.repList.length - 2; i >= start; i--) {
      if (pos.repList[i] === h) return true;
    }
    return false;
  }

  function prevMoveKey(pos) {
    var n = pos.history.length;
    if (!n) return -1;
    var pm = pos.history[n - 1].move;
    var to = mTo(pm);
    var pc = pos.board[to];
    if (!pc) return -1;
    return (pc & 15) * 128 + to;
  }

  function ttProbe(hash, depth, alpha, beta, ply, out) {
    var base = (hash & TT_MASK) * 2;
    for (var b = 0; b < 2; b++) {
      var i = base + b;
      if (ttKey[i] !== (hash | 0) || ttKey[i] === 0) continue;
      out.move = ttMove[i];
      out.found = true;
      if (ttDepth[i] >= depth && ply > 0) {
        var s = ttScore[i];
        if (s > MATE - 200) s -= ply;
        else if (s < -MATE + 200) s += ply;
        var fl = ttFlag[i];
        if (fl === TT_EXACT || (fl === TT_LOWER && s >= beta) || (fl === TT_UPPER && s <= alpha)) {
          out.score = s;
          out.cut = true;
          return;
        }
      }
      return;
    }
  }

  function ttStore(hash, depth, score, flag, move, ply) {
    var base = (hash & TT_MASK) * 2;
    var s = score;
    if (s > MATE - 200) s += ply;
    else if (s < -MATE + 200) s -= ply;
    // bucket 0 keeps the deepest entry, bucket 1 always takes the newest
    var slot = (ttKey[base] === (hash | 0) || depth >= ttDepth[base]) ? base : base + 1;
    ttKey[slot] = hash | 0;
    ttMove[slot] = move;
    ttScore[slot] = s;
    ttDepth[slot] = depth > 127 ? 127 : depth;
    ttFlag[slot] = flag;
  }

  function scoreMoves(pos, moves, ttM, ply, counterKey) {
    var scores = new Int32Array(moves.length);
    var k0 = killers[ply][0], k1 = killers[ply][1];
    var cm = counterKey >= 0 ? counterMove[counterKey] : 0;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i], s;
      if (m === ttM) s = 10000000;
      else if (mCap(m) || mEp(m) || mPromo(m)) {
        var victim = mEp(m) ? P : (mCap(m) & 7);
        var attacker = pos.board[mFrom(m)] & 7;
        var base = VAL[victim] * 12 - VAL[attacker];
        if (mPromo(m)) base += VAL[mPromo(m)] * 8;
        // losing captures get sorted behind the quiet moves
        s = (see(pos, m) >= 0) ? 5000000 + base : 100 + base;
      }
      else if (m === k0) s = 4000000;
      else if (m === k1) s = 3900000;
      else if (m === cm) s = 3800000;
      else s = 1000 + historyTbl[(pos.board[mFrom(m)] & 15) * 128 + mTo(m)];
      scores[i] = s;
    }
    return scores;
  }

  function pickMove(moves, scores, i) {
    var best = i;
    for (var j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
    if (best !== i) {
      var tm = moves[i]; moves[i] = moves[best]; moves[best] = tm;
      var ts = scores[i]; scores[i] = scores[best]; scores[best] = ts;
    }
  }

  function checkTime() {
    if ((nodes & 1023) === 0) {
      if (stopFlag || Date.now() >= deadline) searchAborted = true;
    }
    return searchAborted;
  }

  function ageHistory() {
    for (var i = 0; i < historyTbl.length; i++) historyTbl[i] >>= 1;
  }

  function quiesce(pos, alpha, beta, ply) {
    nodes++;
    if (checkTime()) return 0;
    if (ply >= MAX_PLY) return evaluate(pos);

    var inChk = pos.inCheck(pos.side);
    var stand = -INF;
    if (!inChk) {
      stand = evaluate(pos);
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
      if (stand < alpha - 1000) return alpha;   // delta pruning
    }

    var moves = inChk ? pos.genMoves(false) : pos.genMoves(true);
    var scores = scoreMoves(pos, moves, 0, ply, -1);
    var best = stand, legal = 0;

    for (var i = 0; i < moves.length; i++) {
      pickMove(moves, scores, i);
      var m = moves[i];
      // skip captures that lose material outright
      if (!inChk && (mCap(m) || mEp(m)) && see(pos, m) < 0) continue;
      if (!pos.makeMove(m)) continue;
      legal++;
      var score = -quiesce(pos, -beta, -alpha, ply + 1);
      pos.unmakeMove();
      if (searchAborted) return 0;
      if (score > best) {
        best = score;
        if (score > alpha) alpha = score;
        if (alpha >= beta) break;
      }
    }
    if (inChk && legal === 0) return -MATE + ply;
    return best;
  }

  function hasNonPawnMaterial(pos) {
    var bd = pos.board, us = pos.side;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      var p = bd[sq];
      if (!p || (p & BLACK) !== us) continue;
      var t = p & 7;
      if (t === N || t === B || t === R || t === Q) return true;
    }
    return false;
  }

  var probeOut = { move: 0, score: 0, cut: false, found: false };

  function search(pos, depth, alpha, beta, ply, allowNull) {
    if (checkTime()) return 0;
    nodes++;

    var isPV = beta - alpha > 1;

    if (ply > 0) {
      if (isRepetition(pos) || pos.half >= 100) return 0;
      var mAlpha = alpha > -MATE + ply ? alpha : -MATE + ply;
      var mBeta = beta < MATE - ply - 1 ? beta : MATE - ply - 1;
      if (mAlpha >= mBeta) return mAlpha;
      alpha = mAlpha; beta = mBeta;
    }

    var inChk = pos.inCheck(pos.side);
    if (inChk && depth < 40) depth++;
    if (depth <= 0) return quiesce(pos, alpha, beta, ply);
    if (ply >= MAX_PLY - 1) return evaluate(pos);

    probeOut.move = 0; probeOut.cut = false; probeOut.found = false;
    ttProbe(pos.hash, depth, alpha, beta, ply, probeOut);
    if (probeOut.cut && !isPV) return probeOut.score;
    var ttM = probeOut.move;

    var staticEval = inChk ? -INF : evaluate(pos);
    evalStack[ply] = staticEval;
    // are we better off than we were two plies ago?
    var improving = !inChk && ply >= 2 && evalStack[ply - 2] !== 0 && staticEval > evalStack[ply - 2];

    if (!isPV && !inChk) {
      // reverse futility / static null move
      if (depth <= 6 && staticEval - (85 * depth - (improving ? 40 : 0)) >= beta && Math.abs(beta) < MATE - 200)
        return staticEval;

      // razoring: hopeless position, verify with quiescence
      if (depth <= 2 && staticEval + 300 * depth < alpha) {
        var razorScore = quiesce(pos, alpha, alpha + 1, ply);
        if (searchAborted) return 0;
        if (razorScore < alpha) return razorScore;
      }

      // null move pruning
      if (allowNull && depth >= 3 && staticEval >= beta && hasNonPawnMaterial(pos)) {
        var savedEp = pos.ep, savedHash = pos.hash;
        pos.side ^= BLACK;
        pos.ep = -1;
        pos.hash = pos.computeHash();
        pos.repList.push(pos.hash);
        var Rn = 3 + (depth / 5 | 0) + Math.min(2, (staticEval - beta) / 220 | 0);
        var nullScore = -search(pos, depth - 1 - Rn, -beta, -beta + 1, ply + 1, false);
        pos.repList.pop();
        pos.side ^= BLACK;
        pos.ep = savedEp;
        pos.hash = savedHash;
        if (searchAborted) return 0;
        if (nullScore >= beta) return Math.abs(nullScore) > MATE - 200 ? beta : nullScore;
      }
    }

    var counterKey = prevMoveKey(pos);
    var moves = pos.genMoves(false);
    var scores = scoreMoves(pos, moves, ttM, ply, counterKey);
    var bestScore = -INF, bestMove = 0, legal = 0, quietCount = 0;
    var origAlpha = alpha;
    var quietsTried = [], quietPieces = [];

    for (var i = 0; i < moves.length; i++) {
      pickMove(moves, scores, i);
      var m = moves[i];
      var quiet = !mCap(m) && !mPromo(m) && !mEp(m);
      var movingPiece = pos.board[mFrom(m)] & 15;

      // shallow pruning of clearly unpromising quiet moves
      if (!isPV && !inChk && quiet && legal > 0 && bestScore > -MATE + 200) {
        if (depth <= 6 && quietCount >= LMP[Math.min(6, depth)] * (improving ? 2 : 1)) { quietCount++; continue; }
        if (depth <= 3 && staticEval + FUTILITY[depth] <= alpha) { quietCount++; continue; }
      }
      // don't bother with captures that lose material at shallow depth
      if (!isPV && !inChk && !quiet && depth <= 5 && legal > 0 && see(pos, m) < -60 * depth) continue;

      if (!pos.makeMove(m)) continue;
      legal++;
      if (quiet) { quietCount++; quietsTried.push(m); quietPieces.push(movingPiece); }
      var score;

      if (legal === 1) {
        score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        var red = 0;
        if (quiet && depth >= 3 && legal > 2) {
          red = LMR[Math.min(63, depth)][Math.min(63, legal)];
          if (isPV) red -= 1;
          if (!improving) red += 1;
          if (m === killers[ply][0] || m === killers[ply][1]) red -= 1;
          var hv = historyTbl[movingPiece * 128 + mTo(m)];
          if (hv > 4000) red -= 1; else if (hv < -1000) red += 1;
          if (red < 0) red = 0;
          if (red > depth - 2) red = depth - 2;
        }
        score = -search(pos, depth - 1 - red, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && red > 0) score = -search(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (score > alpha && score < beta) score = -search(pos, depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmakeMove();
      if (searchAborted) return 0;

      if (score > bestScore) {
        bestScore = score;
        bestMove = m;
        if (score > alpha) {
          alpha = score;
          if (alpha >= beta) {
            if (quiet) {
              if (killers[ply][0] !== m) { killers[ply][1] = killers[ply][0]; killers[ply][0] = m; }
              var bonus = depth * depth;
              var hidx = movingPiece * 128 + mTo(m);
              historyTbl[hidx] += bonus;
              if (historyTbl[hidx] > 1 << 20) ageHistory();
              if (counterKey >= 0) counterMove[counterKey] = m;
              // penalise the quiet moves that failed before this one
              for (var q = 0; q < quietsTried.length - 1; q++)
                historyTbl[quietPieces[q] * 128 + mTo(quietsTried[q])] -= bonus;
            }
            break;
          }
        }
      }
    }

    if (legal === 0) return inChk ? -MATE + ply : 0;

    ttStore(pos.hash, depth, bestScore,
      bestScore <= origAlpha ? TT_UPPER : (bestScore >= beta ? TT_LOWER : TT_EXACT),
      bestMove, ply);

    return bestScore;
  }

  function extractPV(pos, maxLen) {
    var pv = [], made = 0;
    for (var i = 0; i < maxLen; i++) {
      var base = (pos.hash & TT_MASK) * 2, m = 0;
      for (var b = 0; b < 2; b++) {
        if (ttKey[base + b] === (pos.hash | 0) && ttKey[base + b] !== 0 && ttMove[base + b]) { m = ttMove[base + b]; break; }
      }
      if (!m) break;
      var legal = pos.legalMoves(), found = false;
      for (var j = 0; j < legal.length; j++) if (legal[j] === m) { found = true; break; }
      if (!found) break;
      pv.push(m);
      pos.makeMove(m);
      made++;
    }
    while (made-- > 0) pos.unmakeMove();
    return pv;
  }

  function think(pos, opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 64;
    var moveTime = opts.moveTime || 1500;
    var onInfo = opts.onInfo;

    nodes = 0;
    stopFlag = false;
    searchAborted = false;
    deadline = Date.now() + moveTime;
    evalStack.fill(0);
    var t0 = Date.now();

    var rootMoves = pos.legalMoves();
    if (!rootMoves.length) return { best: 0, score: 0, depth: 0, nodes: 0, time: 0, list: [] };
    if (rootMoves.length === 1) {
      return { best: rootMoves[0], score: 0, depth: 1, nodes: 1, time: 0, list: [{ move: rootMoves[0], score: 0 }] };
    }

    var best = rootMoves[0], bestScore = 0, completedDepth = 0;
    var list = rootMoves.map(function (m) { return { move: m, score: -INF }; });

    for (var d = 1; d <= maxDepth; d++) {
      var window = 32;
      var alpha0 = (d >= 5) ? bestScore - window : -INF;
      var beta0 = (d >= 5) ? bestScore + window : INF;
      var iterList, iterBest, iterBestScore;

      for (var attempt = 0; attempt < 6; attempt++) {
        var alpha = alpha0, beta = beta0;
        iterList = []; iterBest = 0; iterBestScore = -INF;
        var ordered = list.slice().sort(function (a, b) { return b.score - a.score; });

        for (var i = 0; i < ordered.length; i++) {
          var m = ordered[i].move;
          if (!pos.makeMove(m)) continue;
          var sc;
          if (i === 0) sc = -search(pos, d - 1, -beta, -alpha, 1, true);
          else {
            sc = -search(pos, d - 1, -alpha - 1, -alpha, 1, true);
            if (sc > alpha && sc < beta) sc = -search(pos, d - 1, -beta, -alpha, 1, true);
          }
          pos.unmakeMove();
          if (searchAborted) break;
          iterList.push({ move: m, score: sc });
          if (sc > iterBestScore) { iterBestScore = sc; iterBest = m; if (sc > alpha) alpha = sc; }
        }

        if (searchAborted) break;
        // aspiration window failed — widen and try again
        if (iterBestScore <= alpha0 && alpha0 > -INF) { window *= 4; alpha0 = iterBestScore - window; continue; }
        if (iterBestScore >= beta0 && beta0 < INF) { window *= 4; beta0 = iterBestScore + window; continue; }
        break;
      }

      if (searchAborted) break;

      list = iterList;
      best = iterBest;
      bestScore = iterBestScore;
      completedDepth = d;
      // record the root so the principal variation can be walked out of the table
      ttStore(pos.hash, d, bestScore, TT_EXACT, best, 0);

      if (onInfo) {
        onInfo({ depth: d, score: bestScore, nodes: nodes, time: Date.now() - t0, pv: extractPV(pos, 10), best: best });
      }
      if (Math.abs(bestScore) > MATE - 200) break;
      if (Date.now() - t0 > moveTime * 0.5) break;
    }

    list.sort(function (a, b) { return b.score - a.score; });
    return { best: best, score: bestScore, depth: completedDepth, nodes: nodes, time: Date.now() - t0, list: list };
  }

  /* ===================== Opening book ===================== */
  var BOOK_LINES = [
    'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O',
    'e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6 Bxc6 dxc6 dxe5 Nf5',
    'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3 d6 O-O O-O',
    'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5+ c6',
    'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nxc6 bxc6 e5 Qe7',
    'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Be7',
    'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4 Nf3 Be7',
    'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5',
    'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6 c4 Nf6 Nc3 d6',
    'e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6 Nc3 Qc7 Be3 a6',
    'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7 d3 d6',
    'e4 c5 c3 d5 exd5 Qxd5 d4 Nf6 Nf3 e6',
    'e4 e6 d4 d5 Nc3 Nf6 Bg5 Be7 e5 Nfd7 Bxe7 Qxe7',
    'e4 e6 d4 d5 Nd2 c5 exd5 exd5 Ngf3 Nc6',
    'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6',
    'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5',
    'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 c6 Bc4 Bf5',
    'e4 Nf6 e5 Nd5 d4 d6 Nf3 g6 Bc4 Nb6',
    'e4 d6 d4 Nf6 Nc3 g6 Nf3 Bg7 Be2 O-O',
    'e4 g6 d4 Bg7 Nc3 d6 f4 Nf6 Nf3 O-O',
    'e4 e5 f4 exf4 Nf3 g5 h4 g4 Ne5 Nf6',
    'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6',
    'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5 e3 e6',
    'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5 O-O a6',
    'd4 d5 c4 e6 Nc3 c6 Nf3 Nf6 e3 Nbd7',
    'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5',
    'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7 O-O O-O',
    'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5',
    'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7',
    'd4 Nf6 Nf3 e6 c4 b6 g3 Bb7 Bg2 Be7',
    'd4 f5 g3 Nf6 Bg2 g6 Nf3 Bg7 O-O O-O c4 d6',
    'd4 e6 c4 f5 g3 Nf6 Bg2 Be7 Nf3 O-O',
    'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5',
    'c4 Nf6 Nc3 e6 Nf3 d5 d4 Be7 Bg5 O-O',
    'c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7',
    'Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d3 O-O',
    'Nf3 Nf6 c4 e6 Nc3 d5 d4 Be7 Bf4 O-O',
    'g3 d5 Nf3 Nf6 Bg2 e6 O-O Be7 d3 O-O'
  ];
  var BOOK = null;

  function stripSAN(s) { return s.replace(/[+#!?]/g, ''); }

  function parseSAN(pos, sanRaw) {
    var san = stripSAN(sanRaw);
    var legal = pos.legalMoves(), i;
    if (san === 'O-O' || san === 'O-O-O') {
      var wantFile = san === 'O-O' ? 6 : 2;
      for (i = 0; i < legal.length; i++)
        if (mCastle(legal[i]) && (mTo(legal[i]) & 15) === wantFile) return legal[i];
      return 0;
    }
    var promo = 0;
    var eq = san.indexOf('=');
    if (eq >= 0) { promo = ' PNBRQK'.indexOf(san[eq + 1]); san = san.slice(0, eq); }
    var type = P, body = san;
    if ('NBRQK'.indexOf(san[0]) >= 0) { type = ' PNBRQK'.indexOf(san[0]); body = san.slice(1); }
    body = body.replace('x', '');
    var dest = body.slice(-2);
    var disamb = body.slice(0, -2);
    var destSq = algToSq(dest);
    var dFile = -1, dRank = -1;
    for (i = 0; i < disamb.length; i++) {
      var ch = disamb[i];
      if (ch >= 'a' && ch <= 'h') dFile = ch.charCodeAt(0) - 97;
      else if (ch >= '1' && ch <= '8') dRank = ch.charCodeAt(0) - 49;
    }
    for (i = 0; i < legal.length; i++) {
      var m = legal[i];
      if (mTo(m) !== destSq) continue;
      if ((pos.board[mFrom(m)] & 7) !== type) continue;
      if (promo && mPromo(m) !== promo) continue;
      if (!promo && mPromo(m) && mPromo(m) !== Q) continue;
      if (dFile >= 0 && (mFrom(m) & 15) !== dFile) continue;
      if (dRank >= 0 && (mFrom(m) >> 4) !== dRank) continue;
      return m;
    }
    return 0;
  }

  function bookKey(pos) {
    var f = pos.fen().split(' ');
    return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3];
  }

  function buildBook() {
    BOOK = {};
    for (var i = 0; i < BOOK_LINES.length; i++) {
      var p = new Position();
      var toks = BOOK_LINES[i].split(' ');
      for (var j = 0; j < toks.length; j++) {
        var m = parseSAN(p, toks[j]);
        if (!m) break;
        var key = bookKey(p);
        var entry = BOOK[key] || (BOOK[key] = []);
        var f = mFrom(m), t = mTo(m), pr = mPromo(m), dup = false;
        for (var k = 0; k < entry.length; k++)
          if (entry[k].f === f && entry[k].t === t && entry[k].p === pr) { entry[k].n++; dup = true; break; }
        if (!dup) entry.push({ f: f, t: t, p: pr, n: 1 });
        p.makeMove(m);
      }
    }
  }

  function bookMove(pos) {
    if (!BOOK) buildBook();
    var entry = BOOK[bookKey(pos)];
    if (!entry || !entry.length) return 0;
    var total = 0, i;
    for (i = 0; i < entry.length; i++) total += entry[i].n;
    var r = Math.random() * total, acc = 0, pick = entry[0];
    for (i = 0; i < entry.length; i++) { acc += entry[i].n; if (r <= acc) { pick = entry[i]; break; } }
    var legal = pos.legalMoves();
    for (i = 0; i < legal.length; i++)
      if (mFrom(legal[i]) === pick.f && mTo(legal[i]) === pick.t && mPromo(legal[i]) === pick.p) return legal[i];
    return 0;
  }

  /* ---- level-based move choice ---- */
  function chooseMove(pos, level, onInfo) {
    var cfg = LEVELS[level] || LEVELS[3];
    if (cfg.book !== false && (pos.repList.length - 1) < 16) {
      var bm = bookMove(pos);
      if (bm) return { best: bm, score: 0, depth: 0, nodes: 0, time: 0, book: true, list: [{ move: bm, score: 0 }] };
    }
    var res = think(pos, { maxDepth: cfg.depth, moveTime: cfg.time, onInfo: onInfo });
    if (!res.list.length) return res;
    var top = res.list[0].score;
    var pool = [];
    for (var i = 0; i < res.list.length; i++) {
      if (top - res.list[i].score <= cfg.slack) pool.push(res.list[i]);
    }
    if (cfg.slack > 0 && pool.length > 1 && Math.random() < cfg.wobble) {
      var pick = pool[1 + ((Math.random() * (pool.length - 1)) | 0)];
      res.best = pick.move;
      res.score = pick.score;
    }
    return res;
  }

  var LEVELS = {
    1: { name: 'Skittles', depth: 2, time: 150, slack: 250, wobble: 0.85, book: false },
    2: { name: 'Club', depth: 4, time: 400, slack: 120, wobble: 0.60 },
    3: { name: 'Expert', depth: 8, time: 1000, slack: 40, wobble: 0.35 },
    4: { name: 'Master', depth: 20, time: 2500, slack: 12, wobble: 0.12 },
    5: { name: 'Arbiter', depth: 64, time: 6000, slack: 0, wobble: 0 }
  };

  /* ===================== SAN ===================== */
  function toSAN(pos, m) {
    var from = mFrom(m), to = mTo(m);
    var pc = pos.board[from], type = pc & 7;
    var san;
    if (mCastle(m)) {
      san = (to & 15) === 6 ? 'O-O' : 'O-O-O';
    } else if (type === P) {
      san = (mCap(m) || mEp(m)) ? (sqToAlg(from)[0] + 'x' + sqToAlg(to)) : sqToAlg(to);
      if (mPromo(m)) san += '=' + ' PNBRQK'[mPromo(m)];
    } else {
      var letter = ' PNBRQK'[type];
      var others = pos.legalMoves().filter(function (x) {
        return x !== m && mTo(x) === to && (pos.board[mFrom(x)] & 7) === type;
      });
      var disamb = '';
      if (others.length) {
        var sameFile = others.some(function (x) { return (mFrom(x) & 15) === (from & 15); });
        var sameRank = others.some(function (x) { return (mFrom(x) >> 4) === (from >> 4); });
        if (!sameFile) disamb = sqToAlg(from)[0];
        else if (!sameRank) disamb = sqToAlg(from)[1];
        else disamb = sqToAlg(from);
      }
      san = letter + disamb + ((mCap(m)) ? 'x' : '') + sqToAlg(to);
    }
    pos.makeMove(m);
    var opp = pos.side;
    if (pos.inCheck(opp)) san += pos.legalMoves().length ? '+' : '#';
    pos.unmakeMove();
    return san;
  }

  function gameStatus(pos) {
    var legal = pos.legalMoves();
    if (!legal.length) {
      if (pos.inCheck(pos.side)) return { over: true, result: pos.side === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
      return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    }
    if (pos.half >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    var h = pos.hash, count = 0;
    for (var i = 0; i < pos.repList.length; i++) if (pos.repList[i] === h) count++;
    if (count >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    // insufficient material
    var bd = pos.board, pieces = [];
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) continue;
      var p = bd[sq];
      if (p && (p & 7) !== K) pieces.push(p & 7);
    }
    if (!pieces.length) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    if (pieces.length === 1 && (pieces[0] === N || pieces[0] === B))
      return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    return { over: false, legal: legal };
  }

  G.ChessAPI = {
    Position: Position, evaluate: evaluate, think: think, chooseMove: chooseMove,
    toSAN: toSAN, gameStatus: gameStatus, clearTT: clearTT, LEVELS: LEVELS,
    parseSAN: parseSAN, bookMove: bookMove, see: see,
    mFrom: mFrom, mTo: mTo, mPromo: mPromo, mCap: mCap, mEp: mEp, mCastle: mCastle,
    sqToAlg: sqToAlg, algToSq: algToSq, pieceChar: pieceChar, mk: mk,
    stop: function () { stopFlag = true; },
    MATE: MATE,
    P: P, N: N, B: B, R: R, Q: Q, K: K, WHITE: WHITE, BLACK: BLACK
  };
}


ChessCore.call(globalThis);
var self = globalThis;
/* ============================================================
   UCI driver — makes Arbiter a standard chess engine that any
   GUI or bot framework can talk to.

   Run:   node arbiter-engine.js
   Then:  uci
          position startpos moves e2e4 e7e5
          go movetime 3000
   ============================================================ */

var API = self.ChessAPI;
var pos = new API.Position();
var skill = 5;                     // 1-5, 5 = full strength

function moveToUci(m) {
  if (!m) return '0000';
  var s = API.sqToAlg(API.mFrom(m)) + API.sqToAlg(API.mTo(m));
  if (API.mPromo(m)) s += ' pnbrqk'[API.mPromo(m)];
  return s;
}

function uciToMove(p, uci) {
  var from = API.algToSq(uci.slice(0, 2));
  var to = API.algToSq(uci.slice(2, 4));
  var promo = uci.length > 4 ? ' pnbrqk'.indexOf(uci[4]) : 0;
  var legal = p.legalMoves();
  for (var i = 0; i < legal.length; i++) {
    if (API.mFrom(legal[i]) === from && API.mTo(legal[i]) === to && API.mPromo(legal[i]) === promo)
      return legal[i];
  }
  return 0;
}

function scoreString(score) {
  if (Math.abs(score) > API.MATE - 200) {
    var n = Math.ceil((API.MATE - Math.abs(score)) / 2);
    return 'mate ' + (score > 0 ? n : -n);
  }
  return 'cp ' + Math.round(score);
}

function pvString(p, pv) {
  var out = [], made = 0;
  for (var i = 0; i < pv.length; i++) {
    var legal = p.legalMoves(), ok = false;
    for (var j = 0; j < legal.length; j++) if (legal[j] === pv[i]) { ok = true; break; }
    if (!ok) break;
    out.push(moveToUci(pv[i]));
    p.makeMove(pv[i]);
    made++;
  }
  while (made-- > 0) p.unmakeMove();
  return out.join(' ');
}

function allocateTime(tokens) {
  var opt = {};
  for (var i = 1; i < tokens.length; i += 2) opt[tokens[i]] = parseInt(tokens[i + 1], 10);

  if (opt.movetime) return { time: opt.movetime, depth: 64 };
  if (opt.depth) return { time: 3600000, depth: opt.depth };
  if (opt.infinite !== undefined || tokens.indexOf('infinite') >= 0) return { time: 3600000, depth: 64 };

  var white = pos.side === API.WHITE;
  var left = white ? opt.wtime : opt.btime;
  var inc = (white ? opt.winc : opt.binc) || 0;
  if (!left) return { time: 2000, depth: 64 };

  var togo = opt.movestogo || 30;
  var alloc = left / togo + inc * 0.75;
  alloc = Math.min(alloc, left * 0.4);          // never burn the whole clock
  alloc = Math.max(30, alloc - 30);             // leave a little for overhead
  return { time: Math.round(alloc), depth: 64 };
}

function handle(line) {
  var t = line.trim().split(/\s+/);
  var cmd = t[0];

  if (cmd === 'uci') {
    send('id name Arbiter 2.0');
    send('id author built from scratch, no external engine code');
    send('option name Skill type spin default 5 min 1 max 5');
    send('uciok');
  }
  else if (cmd === 'isready') send('readyok');
  else if (cmd === 'ucinewgame') { API.clearTT(); pos = new API.Position(); }
  else if (cmd === 'setoption') {
    var vi = t.indexOf('value');
    if (t.indexOf('Skill') >= 0 && vi > 0) skill = Math.max(1, Math.min(5, parseInt(t[vi + 1], 10) || 5));
  }
  else if (cmd === 'position') {
    var movesAt = t.indexOf('moves');
    if (t[1] === 'startpos') pos = new API.Position();
    else if (t[1] === 'fen') {
      var end = movesAt < 0 ? t.length : movesAt;
      pos = new API.Position(t.slice(2, end).join(' '));
    }
    if (movesAt >= 0) {
      for (var i = movesAt + 1; i < t.length; i++) {
        var m = uciToMove(pos, t[i]);
        if (!m) { send('info string illegal move in position command: ' + t[i]); break; }
        pos.makeMove(m);
      }
    }
  }
  else if (cmd === 'go') {
    var plan = allocateTime(t);
    var res;
    if (skill < 5) {
      res = API.chooseMove(pos, skill, emitInfo);
    } else {
      res = API.think(pos, { moveTime: plan.time, maxDepth: plan.depth, onInfo: emitInfo });
    }
    send('bestmove ' + moveToUci(res.best));
  }
  else if (cmd === 'stop') API.stop();
  else if (cmd === 'quit') { flush(); process.exit(0); }
  else if (cmd === 'd' || cmd === 'board') {
    send('info string ' + pos.fen());
  }
  else if (cmd === 'eval') {
    send('info string static eval ' + Math.round(API.evaluate(pos)));
  }
}

function emitInfo(info) {
  var nps = info.time > 0 ? Math.round(info.nodes / (info.time / 1000)) : 0;
  send('info depth ' + info.depth +
    ' score ' + scoreString(info.score) +
    ' nodes ' + info.nodes +
    ' nps ' + nps +
    ' time ' + info.time +
    ' pv ' + pvString(pos, info.pv));
}

/* ---------- I/O ---------- */
var outBuf = [];
function send(s) { outBuf.push(s); if (outBuf.length > 32) flush(); else process.stdout.write(s + '\n'), outBuf.length = 0; }
function flush() { if (outBuf.length) { process.stdout.write(outBuf.join('\n') + '\n'); outBuf.length = 0; } }

if (typeof module !== 'undefined' && require.main === module) {
  var readline = require('readline');
  var rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', function (line) {
    if (!line.trim()) return;
    try { handle(line); } catch (e) { send('info string error: ' + e.message); }
  });
  rl.on('close', function () { process.exit(0); });
}

if (typeof module !== 'undefined') module.exports = API;
