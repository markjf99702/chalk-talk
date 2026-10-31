// Unit tests for the simulator:  node --test test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, prepare } from '../js/sim.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES } from '../js/playbook.js';

const KINDS = new Set(['run', 'catch', 'incomplete', 'int', 'sack', 'throwaway']);

test('every call against every defense runs to a finish', () => {
  let seed = 1;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const r = simulate(call, seed++);
    const what = JSON.stringify(call);
    assert.ok(KINDS.has(r.result.kind), `${what}: result ${r.result.kind}`);
    assert.ok(Number.isFinite(r.result.yards), `${what}: yards`);
    assert.equal(r.players.length, 22, what);
    assert.ok(r.frames.length > 5 && r.frames.length < 240, `${what}: ${r.frames.length} frames`);
    for (const f of r.frames) for (const v of f.xy) assert.ok(Number.isFinite(v), `${what}: a position went bad`);
    assert.equal(r.jobs.filter(Boolean).length, 22, `${what}: everyone has a job to describe`);
  }
});

test('the same seed replays the same play', () => {
  const call = { formation: 'trips', play: 'smash', front: 'nickel', coverage: 'c3', pressure: 'four' };
  const a = simulate(call, 4242), b = simulate(call, 4242);
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual([...a.frames.at(-1).xy], [...b.frames.at(-1).xy]);
});

test('formations are legal: seven on the line, eleven a side, nobody offside', () => {
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) {
    const S = prepare({ formation: fm.id, play: 'iz', front: fr.id, coverage: cv.id, pressure: 'four' }, 3);
    assert.equal(S.O.length, 11); assert.equal(S.D.length, 11);
    assert.equal(S.O.filter(p => p.y > -1).length, 7, `${fm.id}: players on the line`);
    for (const d of S.D) assert.ok(d.y >= 0.6, `${fm.id} vs ${fr.id} ${cv.id}: ${d.label} is offside`);
    for (const p of S.O) assert.ok(p.y < 0, `${fm.id}: ${p.label} is offside`);
  }
});

test('coverages put the right number deep and the right number rushing', () => {
  const count = (cov, pressure) => {
    const S = prepare({ formation: 'doubles', play: 'verts', front: 'over', coverage: cov, pressure }, 9);
    return { deep: S.D.filter(d => d.job.kind === 'zone' && d.job.z.deep).length, rush: S.D.filter(d => d.job.kind === 'rush').length, man: S.D.filter(d => d.job.kind === 'man').length };
  };
  assert.deepEqual(count('c3', 'four'), { deep: 3, rush: 4, man: 0 });
  assert.deepEqual(count('c2', 'four'), { deep: 2, rush: 4, man: 0 });
  assert.deepEqual(count('c4', 'four'), { deep: 4, rush: 4, man: 0 });
  assert.deepEqual(count('c4', 'blitz'), { deep: 4, rush: 5, man: 0 });
  assert.equal(count('c1', 'four').deep, 1);
  assert.equal(count('c1', 'four').man, 5);
  const zero = count('c0', 'four');
  assert.equal(zero.deep, 0); assert.equal(zero.man, 5); assert.equal(zero.rush, 6);
});

test('over many snaps the numbers look like football', () => {
  let seed = 77;
  const pick = list => list[(seed = (seed * 16807) % 2147483647) % list.length];
  const run = { n: 0, y: 0 }, pass = { n: 0, att: 0, comp: 0, sack: 0 };
  for (let k = 0; k < 700; k++) {
    const pl = pick(PLAYS);
    const r = simulate({ formation: pick(FORMATIONS).id, play: pl.id, front: pick(FRONTS).id, coverage: pick(COVERAGES).id, pressure: k % 4 ? 'four' : 'blitz' }, seed).result;
    if (pl.type === 'run') { run.n++; run.y += r.yards; }
    else { pass.n++; if (r.kind === 'sack') pass.sack++; else pass.att++; if (r.kind === 'catch') pass.comp++; }
  }
  const ypc = run.y / run.n, comp = pass.comp / pass.att, sack = pass.sack / pass.n;
  assert.ok(ypc > 2.5 && ypc < 6, `yards a carry ${ypc.toFixed(2)}`);
  assert.ok(comp > 0.45 && comp < 0.78, `completion rate ${comp.toFixed(2)}`);
  assert.ok(sack > 0.015 && sack < 0.14, `sack rate ${sack.toFixed(3)}`);
});
