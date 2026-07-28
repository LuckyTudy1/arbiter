/* Correctness checks: evaluation symmetry, static exchange evaluation, tactics. */
const E = require('../arbiter-engine.js');
let failures = 0;

/* --- evaluation must be symmetric: mirror the board, negate the score --- */
function mirrorFen(fen) {
  const p = fen.split(' ');
  const rows = p[0].split('/').reverse().map(r =>
    r.replace(/[a-zA-Z]/g, c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  let cast = p[2] === '-' ? '-' : ['K','Q','k','q'].filter(x =>
    p[2].includes(x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase())).join('');
  const ep = p[3] === '-' ? '-' : p[3][0] + String(9 - (+p[3][1]));
  return [rows.join('/'), p[1] === 'w' ? 'b' : 'w', cast || '-', ep, p[4] || '0', p[5] || '1'].join(' ');
}
const fens = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'r1bqkb1r/pp3ppp/2n1pn2/2pp4/3P1B2/2P1PN2/PP1N1PPP/R2QKB1R w KQkq - 0 7',
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  '8/2p2pkp/3p2p1/1p1P4/1P2P3/P4PKP/8/8 w - - 0 30',
  '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1',
];
let symBad = 0;
for (const f of fens) {
  const a = E.evaluate(new E.Position(f));
  const b = E.evaluate(new E.Position(mirrorFen(f)));
  if (Math.abs(a - b) > 0.6) { symBad++; console.log(`FAIL symmetry: ${a.toFixed(1)} vs ${b.toFixed(1)}  ${f}`); }
}
console.log(`${symBad ? 'FAIL' : 'ok  '} evaluation symmetry (${fens.length - symBad}/${fens.length})`);
failures += symBad ? 1 : 0;

/* --- static exchange evaluation vs a brute-force capture search --- */
const VAL = [0, 100, 320, 330, 500, 900, 10000];
function seeBrute(pos, m) {
  const to = E.mTo(m);
  const cap = E.mEp(m) ? 100 : VAL[E.mCap(m) & 7];
  pos.makeMove(m);
  let sub = 0;
  for (const x of pos.legalMoves()) {
    if (E.mTo(x) !== to || (!E.mCap(x) && !E.mEp(x)) || E.mPromo(x)) continue;
    const v = seeBrute(pos, x);
    if (v > sub) sub = v;
  }
  pos.unmakeMove();
  return cap - sub;
}
let seeTotal = 0, seeOk = 0;
for (const f of fens) {
  const pos = new E.Position(f);
  for (const m of pos.legalMoves()) {
    if ((!E.mCap(m) && !E.mEp(m)) || E.mPromo(m)) continue;
    seeTotal++;
    if (E.see(pos, m) === seeBrute(pos, m)) seeOk++;
  }
}
console.log(`${seeOk === seeTotal ? 'ok  ' : 'FAIL'} static exchange evaluation (${seeOk}/${seeTotal} exact)`);
failures += seeOk === seeTotal ? 0 : 1;

/* --- SAN generation round-trips through the parser --- */
let sanTotal = 0, sanOk = 0;
for (const f of [...fens, 'n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1']) {
  const pos = new E.Position(f);
  for (const m of pos.legalMoves()) {
    sanTotal++;
    if (E.parseSAN(pos, E.toSAN(pos, m)) === m) sanOk++;
  }
}
console.log(`${sanOk === sanTotal ? 'ok  ' : 'FAIL'} SAN round-trip (${sanOk}/${sanTotal})`);
failures += sanOk === sanTotal ? 0 : 1;

/* --- tactics --- */
const tactics = [
  ['2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', 'Qg6'],
  ['5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', 'Rg3'],
  ['r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', 'Qxh7+'],
];
let tacOk = 0;
for (const [fen, want] of tactics) {
  const pos = new E.Position(fen);
  const r = E.think(pos, { moveTime: 2500, maxDepth: 24 });
  const got = E.toSAN(pos, r.best);
  if (got === want) tacOk++;
  console.log(`${got === want ? 'ok  ' : 'FAIL'} tactic: played ${got.padEnd(7)} expected ${want.padEnd(7)} (depth ${r.depth})`);
}
failures += tacOk === tactics.length ? 0 : 1;

console.log(failures ? `\n${failures} test group(s) FAILED` : '\nall correctness checks passed');
process.exit(failures ? 1 : 0);
