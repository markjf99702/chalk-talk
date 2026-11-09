// Measures the numbers the coach's read ranks its picks by (js/read.js), and writes them to js/read-table.js:
//   node tools/read-table.mjs [--workers 3] [--snaps 40] [--sets 6] [--progress file.jsonl]
// Every play from every formation against every call the other coach can make (front, coverage, rush or who blitzes,
// disguised or not), each snapped --snaps times in each of three seed sets, and how often it was a success at each
// down and distance the board has: a gain of 1 yard or more (4th & 1), 2 (3rd & 2), 4 (1st & 10, 2nd & 6) and 8
// (3rd & 8), a run or a catch, as the board counts a success (success() in js/app.js): --snaps in each of --sets seed
// sets, 240 a cell as it's made. Made in two halves of 120 snaps, the halves picked the same top play for 77% of the
// looks (each look on each down, calling the offense), and where they didn't, each half's top play was in the other's
// top three 99 times in 100, a median of no points and 2.5 or less nine times in ten behind the other's own top play by
// its numbers. The situation changes how a snap
// plays out only for a handoff from the shotgun on a short third or fourth down (gunRead() in js/sim.js), so those runs
// are snapped again on 3rd & 2 for the 1- and 2-yard numbers; every other snap is the same on any down.
// Calling the defense, the other coach's offense sends a man in motion about one snap in three, so each play from a
// formation with motion is also snapped against the calls a defense can pick in its card (any front, any coverage,
// rush four or the Mike blitzing, no disguise) with the man in motion, across and jet alike.
// Each snap's seed is its seed set's base (1 million for the first, 2 million for the next, and so on) plus its number in
// the set, the same in every cell. With --progress, each cell's seed set is written to the file as it's done, and a run
// that stops can pick up where it left off. It takes about an hour and a half on three cores. test/sim.test.mjs fails
// when SIM_VERSION changes and this hasn't been run.
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { cpus } from 'node:os';

const NEED = [1, 2, 4, 8];

if (!isMainThread) {
  const { simulate } = await import('../js/sim.js');
  const { snaps } = workerData;
  parentPort.on('message', task => {
    if (!task) { process.exit(0); }
    const [job, base] = task.split('@');
    const [kind, formation, play, call] = job.split(':');
    const [front, coverage, pressure, blitzer, disguise] = call.split('.');
    const c = [0, 0, 0, 0];
    for (let k = 0; k < snaps; k++) {
      const motion = kind[0] === 'm' ? (k % 2 ? 'jet' : 'across') : 'none';
      const P = simulate({ formation, play, flip: false, motion, hot: {}, front, coverage, pressure, blitzer, disguise: disguise === '1', sit: kind.endsWith('s') ? '3and2' : '1and10' }, +base + k);
      const r = P.result, g = Math.sign(r.yards) * Math.round(Math.abs(r.yards));
      if (r.kind === 'run' || r.kind === 'catch') NEED.forEach((n, j) => { if (g >= n) c[j]++; });
    }
    parentPort.postMessage({ task, counts: c });
  });
} else {
  const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
  const W = +arg('workers', Math.max(1, Math.min(3, cpus().length - 1))), snaps = +arg('snaps', 40), progress = arg('progress', null);
  const SETS = Array.from({ length: +arg('sets', 6) }, (_, k) => (k + 1) * 1e6);
  const { SIM_VERSION, simulate, blitzerFor, cantCall } = await import('../js/sim.js');
  const { FORMATIONS, PLAYS, FRONTS, COVERAGES, BLITZERS } = await import('../js/playbook.js');
  const { lookOf } = await import('../js/read.js');

  // Every call the other coach can make on defense (see rollTheirs() in js/app.js): Cover 0 always blitzes; otherwise
  // rush four or blitz with any man who can (blitzerFor()), and Cover 1 and Cover 3 disguised or not.
  const calls = [];
  for (const f of FRONTS) for (const c of COVERAGES) {
    if (c.id === 'c0') { calls.push(`${f.id}.c0.blitz.M.0`); continue; }
    for (const d of c.id === 'c1' || c.id === 'c3' ? [0, 1] : [0]) {
      calls.push(`${f.id}.${c.id}.four.M.${d}`);
      for (const b of BLITZERS) if (!blitzerFor(f.id, c.id, b.id, !!d)) calls.push(`${f.id}.${c.id}.blitz.${b.id}.${d}`);
    }
  }
  // The calls a defense can make in its card's chips: rush four or the Mike blitzing, no disguise.
  const base = calls.map((c, i) => [c, i]).filter(([c]) => /\.(four|blitz)\.M\.0$/.test(c)).map(([, i]) => i);
  const plays = Object.fromEntries(FORMATIONS.map(f => [f.id, PLAYS.filter(p => !cantCall(f.id, p.id)).map(p => p.id)]));
  const gunRun = (f, p) => !f.under && PLAYS.find(x => x.id === p).type === 'run' && PLAYS.find(x => x.id === p).scheme !== 'draw';

  // The look each call shows against each formation, as the read sees it (lookOf() in js/read.js): it's the same for
  // every play, every strong side and every seed, which is checked here.
  const looks = {};
  for (const f of FORMATIONS) {
    looks[f.id] = calls.map(c => {
      const [front, coverage, pressure, blitzer, disguise] = c.split('.');
      const keys = new Set();
      for (const [play, flip, seed] of [[plays[f.id][0], false, 1], [plays[f.id].at(-1), true, 99]]) {
        const P = simulate({ formation: f.id, play, flip, motion: 'none', hot: {}, front, coverage, pressure, blitzer, disguise: disguise === '1', sit: '1and10' }, seed);
        const xy = P.frames[0].xy;
        keys.add(lookOf(P.players.map(p => ({ ...p, x: xy[2 * p.i], y: xy[2 * p.i + 1] })), front).key);
      }
      if (keys.size > 1) throw new Error(`${f.id} ${c}: the look changes with the play or the side: ${[...keys]}`);
      return [...keys][0];
    });
  }

  const jobs = [];
  for (const f of FORMATIONS) for (const p of plays[f.id]) {
    calls.forEach(c => { jobs.push(`n:${f.id}:${p}:${c}`); if (gunRun(f, p)) jobs.push(`s:${f.id}:${p}:${c}`); });
    if (f.motion) base.forEach(i => { jobs.push(`m:${f.id}:${p}:${calls[i]}`); if (gunRun(f, p)) jobs.push(`ms:${f.id}:${p}:${calls[i]}`); });
  }
  const done = new Map(); // job@base: the counts
  if (progress && existsSync(progress)) {
    for (const line of readFileSync(progress, 'utf8').split('\n')) {
      if (!line) continue;
      const r = JSON.parse(line);
      if (r.sim !== SIM_VERSION || r.snaps !== snaps) continue;
      if (r.base) done.set(`${r.job}@${r.base}`, r.counts);
      else r.counts.forEach((c, k) => done.set(`${r.job}@${(k + 1) * 1e6}`, c)); // (a line with the first three sets)
    }
  }
  const todo = SETS.flatMap(base => jobs.map(j => `${j}@${base}`)).filter(t => !done.has(t));
  console.log(`${jobs.length} cells, ${todo.length} cell seed sets to go, ${snaps} snaps a cell in each of ${SETS.length} seed sets, ${W} workers`);
  const t0 = Date.now();
  let next = 0, finished = 0;
  await Promise.all(Array.from({ length: W }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { snaps } });
    const feed = () => w.postMessage(next < todo.length ? todo[next++] : null);
    w.on('message', ({ task, counts }) => {
      done.set(task, counts);
      const [job, base] = task.split('@');
      if (progress) appendFileSync(progress, JSON.stringify({ sim: SIM_VERSION, snaps, job, base: +base, counts }) + '\n');
      if (++finished % 500 === 0) console.log(`${finished}/${todo.length}, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      feed();
    });
    w.on('error', reject);
    w.on('exit', resolve);
    feed();
  })));

  // A success rate as one character: 0 to 90 (of 90) in the printable ASCII characters other than ', " and \.
  const ALPHA = [...Array(94)].map((_, k) => String.fromCharCode(33 + k)).filter(ch => !`'"\\`.includes(ch)).join('');
  const code = (n, of) => ALPHA[Math.round((n / of) * (ALPHA.length - 1))];
  const of = snaps * SETS.length;
  const pooled = job => SETS.map(base => done.get(`${job}@${base}`)).reduce((a, c) => a.map((v, j) => v + c[j]), [0, 0, 0, 0]);
  const cell = (k, f, p, c) => {
    const n = pooled(`${k}:${f.id}:${p}:${c}`), s = gunRun(f, p) ? pooled(`${k}s:${f.id}:${p}:${c}`.replace(/^ns:/, 's:')) : n;
    return code(s[0], of) + code(s[1], of) + code(n[2], of) + code(n[3], of);
  };
  const cells = {}, motion = {};
  for (const f of FORMATIONS) {
    cells[f.id] = plays[f.id].map(p => calls.map(c => cell('n', f, p, c)).join('')).join('');
    if (f.motion) motion[f.id] = plays[f.id].map(p => base.map(i => cell('m', f, p, calls[i])).join('')).join('');
  }
  const out = `// Made by tools/read-table.mjs for the simulator's version ${SIM_VERSION}, ${of} snaps a cell (${snaps} in each of
// ${SETS.length} seed sets): how often each play from each formation is a success against each call the other coach can
// make, for the coach's read (js/read.js). Don't edit it: run the tool again (test/sim.test.mjs says when).
// calls: the other coach's calls on defense, front.coverage.pressure.blitzer.disguised. base: the ones a defense can
// pick in its card's chips (rush four or the Mike blitzing, no disguise), by their place in calls. plays: each
// formation's plays. looks: the look each call shows against each formation (lookOf() in js/read.js), deep|corners|box|
// walked up. cells: for each formation, its plays one after another, and for each play the calls one after another,
// four characters each: the success rate with 1, 2, 4 and 8 yards to gain (alpha, below: its place in it, of
// ${ALPHA.length - 1}). motion: the same with a man in motion (half across, half jet), for the base calls only, for each
// formation that has one.
export const TABLE = ${JSON.stringify({ sim: SIM_VERSION, snaps: of, sets: SETS, alpha: ALPHA, calls, base, plays, looks, cells, motion }, null, 0).replace(/,"(?=[a-z]+":)/g, ',\n  "')};
`;
  writeFileSync(new URL('../js/read-table.js', import.meta.url), out);
  console.log(`wrote js/read-table.js (${(out.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}
