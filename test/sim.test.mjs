// Unit tests for the simulator:  node --test test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, prepare } from '../js/sim.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, NOTES } from '../js/playbook.js';

const KINDS = new Set(['run', 'catch', 'incomplete', 'int', 'sack', 'throwaway']);
// The play-by-play line that ends a play: a tackle, out of bounds, a long run the board stops counting, a sack, an
// incompletion, a pass broken up, an interception or a throwaway.
const ENDINGS = new Set(['tackle', 'oob', 'long', 'sack', 'inc', 'pbu', 'int', 'away']);
const ended = r => r.events.some(e => ENDINGS.has(e.kind));

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
    for (let k = 1; k < r.events.length; k++) assert.ok(r.events[k].t >= r.events[k - 1].t, `${what} seed ${seed - 1}: the play-by-play goes back in time at "${r.events[k].text}"`);
    assert.ok(ended(r), `${what} seed ${seed - 1}: the play-by-play never says how the play ended`);
    if (r.result.kind === 'sack') assert.ok(!r.events.some(e => e.kind === 'throw' || e.kind === 'away'), `${what} seed ${seed - 1}: a sack after the ball was thrown`);
    if (r.result.carrier >= 0) { // the board's last picture puts the ball carrier where the headline does
      const y = r.frames.at(-1).xy[2 * r.result.carrier + 1];
      assert.ok(r.result.long ? y >= r.result.yards - 0.5 : Math.abs(y - r.result.yards) <= 0.5, `${what} seed ${seed - 1}: the play ends with the carrier at ${y.toFixed(2)}, the result says ${r.result.yards}`);
    }
  }
});

test('a play still going when the board\'s clock runs out ends with a tackle or says the board stopped counting', () => {
  // Outside Zone from the I against the Under in Cover 3: the back breaks five tackles and is still running at 10 seconds.
  const r = simulate({ formation: 'iform', play: 'oz', front: 'under', coverage: 'c3', pressure: 'four', flip: true }, 404);
  assert.ok(ended(r), `the play ends on "${r.events.at(-1).text}"`);
  const last = r.events.at(-1);
  if (last.kind === 'long') assert.equal(r.result.long, true);
  else assert.equal(last.kind, 'tackle');
});

test('the coach has a note for every pass play against every coverage', () => {
  for (const pl of PLAYS.filter(p => p.type === 'pass')) for (const cv of COVERAGES) assert.ok(NOTES[pl.id]?.[cv.id], `no note for ${pl.name} against ${cv.name}`);
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

test('the line is named left to right with the strength on either side, and on Power the back-side guard pulls', () => {
  for (const fm of FORMATIONS) for (const flip of [false, true]) for (const front of ['over', '34']) {
    const S = prepare({ formation: fm.id, play: 'power', front, coverage: 'c3', pressure: 'four', flip }, 7);
    const what = `${fm.id} vs ${front}, strong side ${flip ? 'left' : 'right'}`;
    const line = S.OL.slice().sort((a, b) => a.x - b.x).map(o => o.label);
    assert.deepEqual(line, ['LT', 'LG', 'C', 'RG', 'RT'], `${what}: the line reads ${line.join(' ')} from left to right`);
    const lt = S.OL.find(o => o.label === 'LT'), rt = S.OL.find(o => o.label === 'RT');
    assert.ok(lt.x < 0 && rt.x > 0, `${what}: the left tackle is at ${lt.x}, the right tackle at ${rt.x}`);
    for (const o of S.OL) assert.equal(o.info, o.label, `${what}: the ${o.label}'s card is the ${o.info}'s`);
    const pull = S.O.filter(p => p.job.scheme === 'pull');
    assert.equal(pull.length, 1, `${what}: ${pull.length} men pull`);
    assert.ok(pull[0].x0 * S.aimX < 0, `${what}: the ${pull[0].label} at ${pull[0].x0} pulls, on the play side (aim ${S.aimX})`);
  }
});

test('before the snap, no two defenders stand on the same spot', () => {
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: 'smash', front: fr.id, coverage: cv.id, pressure, flip }, 7);
    for (const a of S.D) for (const b of S.D) {
      if (a.i >= b.i) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(d >= 1.2, `${fm.id} vs ${fr.id} ${cv.id} ${pressure}${flip ? ' flipped' : ''}: the ${a.label} and the ${b.label} are ${d.toFixed(2)} yards apart, at (${a.x.toFixed(1)}, ${a.y.toFixed(1)})`);
    }
  }
});

test('man coverage lines up on its men, and an edge man on the tight end stays on the line', () => {
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of ['c0', 'c1']) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: 'smash', front: fr.id, coverage: cv, pressure, flip }, 7);
    const what = `${fm.id} vs ${fr.id} ${cv} ${pressure}${flip ? ' flipped' : ''}`;
    for (const d of S.D) {
      const r = d.job.r;
      if (d.job.kind === 'man' && r.num) assert.ok(Math.hypot(d.x - r.x, d.y - r.y) < 7, `${what}: the ${d.label} covers the ${r.label} from ${Math.hypot(d.x - r.x, d.y - r.y).toFixed(1)} yards away`);
      if (d.edge && d.job.kind === 'man' && r.cls === 'te' && r.y > -1) assert.ok(d.y < 1.5, `${what}: the ${d.label} leaves the line to cover the tight end`);
    }
  }
});

test('on the screen the linemen let the rushers go, and in man coverage the back\'s man comes after them', () => {
  let seed = 300;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    const call = { formation: fm.id, play: 'screen', front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const c = r.events.find(e => e.kind === 'catch');
    if (!c) continue;
    const f = r.frames.find(f => f.t >= c.t - 1e-9);
    for (const o of S.OL.filter(o => o.job.kind === 'screenOL')) {
      const d = f.eng[o.i];
      if (d >= 0) assert.ok(f.xy[2 * d + 1] >= 0, `${what}: at the catch the ${o.label} is still blocking a rusher behind the line`);
    }
    const man = S.D.find(d => d.job.kind === 'man' && d.job.r === S.RB);
    if (man && (cv.id === 'c0' || cv.id === 'c1')) assert.ok(f.xy[2 * man.i + 1] < man.y0 - 2, `${what}: the ${man.label}, in man on the back, never came forward`);
  }
});

test('the rush read tells the truth: only blitzers are drawn as blitzers, and only rushers nobody blocked came unblocked', () => {
  let seed = 500, came = 0;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const pl of PLAYS.filter(p => p.type === 'pass')) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    for (const o of r.overlay.filter(o => o.kind === 'rush')) {
      const p = r.players[o.i], own = fr.rush.includes(p.label);
      assert.equal(o.blitz, !own, `${what}: the ${p.label} ${own ? 'is one of the front\'s rushers but is drawn as a blitzer' : 'blitzes but is drawn as a rusher'}`);
      assert.ok(r.jobs[o.i].includes(own ? 'Rushes' : 'Blitzes'), `${what}: the ${p.label}'s card says "${r.jobs[o.i]}"`);
    }
    const cut = (r.events.find(e => e.kind === 'throw' || e.kind === 'away') || r.result).t;
    const blocked = i => r.frames.some(f => f.t <= cut + 1e-9 && f.eng[i] >= 0);
    assert.ok(Array.isArray(r.cameFree), `${what}: no list of the rushers who came free`);
    assert.equal(r.protection.filter(i => r.players[i].cls === 'ol').length, 5, `${what}: the protection is missing a lineman`);
    for (const i of r.protection) assert.ok(r.players[i].team === 'O' && r.players[i].cls !== 'qb' && r.players[i].cls !== 'wr', `${what}: the ${r.players[i].label} is counted in the protection`);
    for (const i of r.cameFree) { assert.ok(r.free.includes(i) && !blocked(i), `${what}: the ${r.players[i].label} is said to have come unblocked, but he was blocked`); came++; }
    for (const i of r.free) if (!r.cameFree.includes(i)) assert.ok(blocked(i), `${what}: the ${r.players[i].label} came free but isn't named`);
  }
  // The protection leaves a rusher free only when there's nobody left to take him (Cover 0, the screen), so he comes
  // unblocked: these have to have happened for the checks above to mean anything.
  assert.ok(came > 0, 'no rusher ever came unblocked, so the check above proved nothing');
});

test('pass protection picks up every rusher it has the men for: a rusher goes free only when they outnumber the blockers', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass' && p.id !== 'screen')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip }, 5);
    const what = `${fm.id} ${pl.id} vs ${fr.id} ${cv.id} ${pressure}${flip ? ', strong side left' : ''}`;
    const rushers = S.D.filter(d => d.job.kind === 'rush');
    const free = S.freeRushers.map(d => d.label).join(', ');
    const lines = () => S.O.filter(o => o.job.kind === 'pro' || o.job.kind === 'fake').map(o => `${o.label}->${o.job.target?.label ?? 'helps'}`).join(' ');
    if (pressure === 'four' && cv.id !== 'c0') assert.equal(rushers.length, 4, `${what}: ${rushers.length} rushers on a four-man rush`);
    if (rushers.length <= S.protection.length) assert.equal(free, '', `${what}: ${rushers.length} rushers against ${S.protection.length} in protection, and the ${free} is left free (${lines()})`);
    else assert.ok(S.freeRushers.length <= rushers.length - S.protection.length, `${what}: ${S.freeRushers.length} free with ${rushers.length} rushing against ${S.protection.length} (${lines()})`);
    for (const o of S.O) if (o.job.target && o.job.kind === 'pro') assert.equal(S.O.filter(q => q.job.kind === 'pro' && q.job.target === o.job.target).length, 1, `${what}: two men have the ${o.job.target.label}`);
  }
});

test('the words match the board: zones by strong and weak side, a run in every defender\'s card, and plain play-by-play', () => {
  let seed = 314000, qbDown = 0;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure: seed % 3 ? 'four' : 'blitz', flip };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    for (const d of S.D) {
      const job = r.jobs[d.i];
      assert.doesNotMatch(job, /:.*:/, `${what}: the ${d.label}'s card stacks colons: "${job}"`);
      if (d.job.kind === 'zone' && d.job.z.at[0]) {
        const strong = Math.sign(d.job.z.at[0]) === S.s;
        assert.match(job, strong ? /strong[- ]side/ : /weak[- ]side/, `${what}: the ${d.label} at x ${d.x.toFixed(1)} has a zone on the ${strong ? 'strong' : 'weak'} side, and his card says "${job}"`);
        assert.doesNotMatch(job, /\b(left|right)\b/, `${what}: the ${d.label}'s card says left or right: "${job}"`);
      }
      if (pl.type === 'run' && (d.job.kind === 'zone' || d.job.kind === 'man')) assert.match(job, /On this (run|draw)/, `${what}: the ${d.label}'s card on a run is his pass job alone: "${job}"`);
    }
    const story = r.events.map(e => e.text).join(' ');
    assert.doesNotMatch(story, /\b1 yards\b/, `${what}: "${story}"`);
    assert.doesNotMatch(story, /'s block|his last option|The corner on/, `${what}: "${story}"`);
    if (r.events.some(e => e.kind === 'throw')) assert.match(r.events.find(e => e.kind === 'throw').text, /on (a|an) [a-z ]+ route|on the (check-down|screen)/, `${what}: "${r.events.find(e => e.kind === 'throw').text}"`);
    if (pl.type === 'run' && r.result.carrier === S.QB.i && !r.events.some(e => e.kind === 'hand')) {
      qbDown++;
      assert.match(r.events.at(-1).text, /drops the quarterback before the handoff/, `${what}: the quarterback goes down before the handoff, and the story says "${story}"`);
    }
  }
  assert.ok(qbDown > 0, 'no quarterback went down before the handoff, so that check proved nothing');
});

test('the box count sees a safety rolled down, and counts every man who blocks on a run', () => {
  const box = (formation, front, coverage) => prepare({ formation, play: 'iz', front, coverage, pressure: 'four' }, 3).box;
  for (const fm of ['iform', 'single']) for (const fr of ['over', 'under', '34']) {
    const two = box(fm, fr, 'c2').box, one = box(fm, fr, 'c3').box;
    assert.ok(one > two, `${fm} vs ${fr}: Cover 3 brings a safety down, but the box shows ${one} against Cover 2's ${two}`);
  }
  assert.equal(box('trips', 'over', 'c3').blockers, 6, 'Gun Trips: the five linemen and the tight end block on a run');
  assert.equal(box('iform', 'over', 'c3').blockers, 7, 'I-Form: the five linemen, the tight end and the fullback');
});

test('a back\'s flat route and check-down end past the line, and Flood sends one back to the flat', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass')) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: pl.id, front: 'over', coverage: 'c3', pressure: 'four', flip }, 5);
    const backs = S.O.filter(p => p.job.kind === 'route' && (p.job.route === 'bflat' || p.job.route === 'check'));
    for (const b of backs) {
      const end = b.path.at(-1);
      assert.ok(end.y > 1.5, `${fm.id} ${pl.id}: the ${b.label}'s ${b.job.route} ends at ${end.y.toFixed(1)}, not past the line`);
      if (b.job.route === 'check') assert.ok(Math.abs(end.x) > 3.5, `${fm.id} ${pl.id}: the ${b.label}'s check-down ends inside the tackles, at x ${end.x.toFixed(1)}`);
    }
    if (pl.id === 'flood') assert.equal(backs.filter(b => b.job.route === 'bflat').length + S.O.filter(p => p.num && p.job.route === 'flat').length, 1, `${fm.id} flood: one man in the flat`);
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
