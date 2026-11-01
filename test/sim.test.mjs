// Unit tests for the simulator:  node --test test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, prepare } from '../js/sim.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, NOTES, SIDELINE } from '../js/playbook.js';

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
    // The line that ends the play is the last one: nothing happens after the whistle.
    assert.ok(ENDINGS.has(r.events.at(-1).kind), `${what} seed ${seed - 1}: the play-by-play goes on after the play is over, with "${r.events.at(-1).text}"`);
    for (const e of r.events) assert.ok(e.t <= r.result.t + 0.001, `${what} seed ${seed - 1}: "${e.text}" at ${e.t}s, after the play ended at ${r.result.t.toFixed(2)}s`);
    if (r.result.kind === 'sack') assert.ok(!r.events.some(e => e.kind === 'throw' || e.kind === 'away'), `${what} seed ${seed - 1}: a sack after the ball was thrown`);
    if (r.result.carrier >= 0) { // the board's last picture puts the ball carrier where the headline does
      const c = r.result.carrier;
      // He gets there from where he was hit, tackled or pushed out, over a few frames: no jump at the whistle. (From the
      // frame after he has the ball: one caught and hit at once makes the catch's own reach for the ball first.)
      for (let k = r.frames.findIndex(f => f.t >= r.result.t - 1e-9); k > 0 && k < r.frames.length; k++) {
        if (r.frames[k - 1].c !== c) continue;
        const a = r.frames[k - 1].xy, b = r.frames[k].xy, d = Math.hypot(b[2 * c] - a[2 * c], b[2 * c + 1] - a[2 * c + 1]);
        assert.ok(d < 0.75, `${what} seed ${seed - 1}: the ball carrier jumps ${d.toFixed(2)} yards at ${r.frames[k].t.toFixed(2)}s, at the end of the play`);
      }
      const y = r.frames.at(-1).xy[2 * c + 1];
      assert.ok(r.result.long ? y >= r.result.yards - 0.5 : Math.abs(y - r.result.yards) <= 0.5, `${what} seed ${seed - 1}: the play ends with the carrier at ${y.toFixed(2)}, the result says ${r.result.yards}`);
    }
  }
});

test('while the play is live nobody stands on the quarterback after the throw, and only the ball carrier leaves the field', () => {
  let seed = 271828;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure: seed % 3 ? 'four' : 'blitz', flip };
    const r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const qb = r.players.find(p => p.cls === 'qb').i;
    const thrown = r.events.find(e => e.kind === 'throw' || e.kind === 'away')?.t ?? Infinity;
    const on = new Array(22).fill(0); // frames running that each man has been within half a yard of the quarterback
    for (const f of r.frames) {
      if (f.t > r.result.t + 1e-9) break;
      for (const p of r.players) {
        const x = f.xy[2 * p.i];
        if (p.i !== f.c) assert.ok(Math.abs(x) <= SIDELINE, `${what}: the ${p.label} is off the field at x ${x.toFixed(2)}, ${f.t.toFixed(2)}s in, without the ball`);
        if (p.team === 'D' && f.t > thrown) {
          on[p.i] = Math.hypot(x - f.xy[2 * qb], f.xy[2 * p.i + 1] - f.xy[2 * qb + 1]) < 0.5 ? on[p.i] + 1 : 0;
          assert.ok(on[p.i] < 10, `${what}: the ${p.label} has stood on the quarterback for half a second after the throw, at ${f.t.toFixed(2)}s`);
        }
      }
    }
  }
});

test('a ball carrier in a pile is squeezed out of it, not thrown clear in one frame', () => {
  // Bodies that overlap push apart, and a back with five of them around him used to be pushed by each, three quarters
  // of a yard or more in a twentieth of a second (from this seed, Gun Trips Power into a nickel Cover 2 blitz).
  let seed = 1;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip };
    const r = simulate(call, seed++);
    const hand = r.events.find(e => e.kind === 'hand');
    if (!hand) continue;
    for (let k = 1; k < r.frames.length; k++) {
      const a = r.frames[k - 1], b = r.frames[k], c = b.c;
      if (a.t < hand.t + 0.1 || b.t > r.result.t + 1e-9 || a.c !== c || c < 0) continue;
      const d = Math.hypot(b.xy[2 * c] - a.xy[2 * c], b.xy[2 * c + 1] - a.xy[2 * c + 1]);
      assert.ok(d < 0.75, `${JSON.stringify(call)} seed ${seed - 1}: the ball carrier moves ${d.toFixed(2)} yards in one frame at ${b.t.toFixed(2)}s`);
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
    const pull = S.O.filter(p => p.job.pull || p.job.scheme === 'pull');
    assert.equal(pull.length, 1, `${what}: ${pull.length} men pull`);
    assert.ok(pull[0].x0 * S.aimX < 0, `${what}: the ${pull[0].label} at ${pull[0].x0} pulls, on the play side (aim ${S.aimX})`);
    // The end man on the play side gets kicked out: by the fullback, or with no fullback by the guard who pulls.
    const kick = S.O.filter(p => p.job.scheme === 'kick');
    assert.equal(kick.length, 1, `${what}: ${kick.length} men kick out the end`);
    assert.equal(kick[0], S.FB || pull[0], `${what}: the ${kick[0].label} kicks out the end`);
    assert.ok(S.emol && kick[0].job.target === S.emol, `${what}: the kick-out is for the ${kick[0].job.target?.label}, the end man is the ${S.emol?.label}`);
    assert.match(S.jobText[kick[0].i], S.FB ? /^Kicks out/ : /^Pulls from the back side and kicks out/, `${what}: "${S.jobText[kick[0].i]}"`);
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
  let seed = 300, thrown = 0, caught = 0;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    const call = { formation: fm.id, play: 'screen', front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const c = r.events.find(e => e.kind === 'catch');
    if (r.events.some(e => e.kind === 'throw')) thrown++;
    if (!c) continue;
    caught++;
    const f = r.frames.find(f => f.t >= c.t - 1e-9);
    for (const o of S.OL.filter(o => o.job.kind === 'screenOL')) {
      const d = f.eng[o.i];
      if (d >= 0) assert.ok(f.xy[2 * d + 1] >= 0, `${what}: at the catch the ${o.label} is still blocking a rusher behind the line`);
    }
    const man = S.D.find(d => d.job.kind === 'man' && d.job.r === S.RB);
    if (man && (cv.id === 'c0' || cv.id === 'c1')) assert.ok(f.xy[2 * man.i + 1] < man.y0 - 2, `${what}: the ${man.label}, in man on the back, never came forward`);
  }
  // The rushers coming free are the point of the screen, not pressure on the throw: it's lofted over them to the back,
  // who is there on purpose, and three in four or more are caught (about seven in ten, when they hurried it).
  assert.ok(caught / thrown >= 0.75, `${caught} of ${thrown} screens caught`);
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
  let seed = 314000;
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
    // Said once: "the cornerback on the X" is already chasing the X. And the catch is 18 yards downfield, not at it.
    assert.doesNotMatch(story, /cornerback on the (\w+) runs into traffic chasing the \1\b/, `${what}: "${story}"`);
    assert.doesNotMatch(story, /Caught by [^.]* at \d/, `${what}: "${story}"`);
    const thrown = r.events.find(e => e.kind === 'throw')?.text;
    if (thrown) {
      assert.match(thrown, /on (a|an) [a-z ]+ route|on the (check-down|screen)/, `${what}: "${thrown}"`);
      // The caption over the deep field takes two lines at most: the reads he passed up are counted, not listed. (The
      // longest is a tight end's read after the other tight end's: 21 words.)
      assert.ok(thrown.split(' ').length <= 21, `${what}: the throw takes ${thrown.split(' ').length} words: "${thrown}"`);
    }
    // (This used to happen about one run in a hundred, nearly always the nose on Outside Zone after the left tackle was
    // sent across his face to someone else. Now that the line takes the men in front of it, none of these snaps has it.)
    if (pl.type === 'run' && r.result.carrier === S.QB.i && !r.events.some(e => e.kind === 'hand')) {
      assert.match(r.events.at(-1).text, /drops the quarterback before the handoff/, `${what}: the quarterback goes down before the handoff, and the story says "${story}"`);
    }
  }
});

test('a run names the hole: one line, when the ball carrier gets to the line after the handoff', () => {
  let seed = 104729, named = 0;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure: seed % 3 ? 'four' : 'blitz', flip };
    const r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const holes = r.events.filter(e => e.kind === 'hole');
    const hand = r.events.find(e => e.kind === 'hand');
    // The first picture, while the play is live, with a ball carrier other than the quarterback at or past the line.
    const at = r.frames.find(f => f.t <= r.result.t + 1e-9 && f.c >= 0 && r.players[f.c].cls !== 'qb' && f.xy[2 * f.c + 1] >= 0);
    if (!at) { assert.equal(holes.length, 0, `${what}: "${holes[0]?.text}", but nobody got to the line`); continue; }
    assert.ok(hand && hand.t <= at.t + 1e-9, `${what}: at the line before the handoff`);
    assert.equal(holes.length, 1, `${what}: ${holes.length} lines about the hole: ${holes.map(e => e.text).join(' / ')}`);
    const h = holes[0];
    assert.equal(h.t, +at.t.toFixed(2), `${what}: the hole is named at ${h.t}s, the carrier got to the line at ${at.t.toFixed(2)}s`);
    assert.equal(h.who, at.c, `${what}: the hole line is about somebody else`);
    assert.match(h.text, /^The running back (hits the [ABCD] gap|cuts back into the [ABCD] gap|cuts it back outside|bounces it outside|gets to the outside) on the (strong|weak) side\.$/, `${what}: "${h.text}"`);
    if (r.events.some(e => e.kind === 'cut' && e.t <= h.t)) assert.doesNotMatch(h.text, /cuts/, `${what}: says he cut back twice`);
    named++;
  }
  assert.ok(named > 100, `only ${named} runs got to the line`);
});

test('every line of the play-by-play that names a man says which man, for the board to point at', () => {
  let seed = 4000;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    const r = simulate({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 }, seed++);
    for (const e of r.events) {
      if (e.text === 'It lands out of bounds. Incomplete.') continue; // names nobody
      assert.ok(Number.isInteger(e.who) && e.who >= 0 && e.who < 22, `${pl.id} seed ${seed - 1}: "${e.text}" (${e.kind}) has nobody to point at`);
    }
  }
});

test('run blocking: the men on the line first, linebackers next, and never a safety', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run' && p.scheme !== 'draw')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip }, 11);
    const what = `${fm.id} ${pl.id} vs ${fr.id} ${cv.id} ${pressure}${flip ? ', strong side left' : ''}`;
    const blockers = S.O.filter(o => o.job.kind === 'block');
    const lines = () => blockers.map(o => `${o.label}->${o.job.target?.label ?? '-'}`).join(' ');
    for (const b of blockers) {
      const d = b.job.target;
      if (!d) continue;
      assert.notEqual(d.cls, 's', `${what}: the ${b.label} is sent at the ${d.label}, a safety (${lines()})`);
      // (The kick-out is for the end man, whoever he is: a linebacker or a nickel back off the ball outside the end.)
      if (d.y0 >= 2 && b.job.scheme !== 'kick') assert.equal(d.cls, 'lb', `${what}: the ${b.label} climbs to the ${d.label}, who isn't a linebacker (${lines()})`);
      assert.equal(blockers.filter(o => o.job.target === d).length, 1, `${what}: two men have the ${d.label} (${lines()})`);
    }
    // Nobody leaves a man lined up on him, or in the gap he's stepping to, to climb to a linebacker.
    for (const d of S.D.filter(d => d.y0 < 2 && Math.abs(d.x0) < 9 && d !== S.emol && !blockers.some(o => o.job.target === d))) {
      const lean = pl.scheme === 'power' ? -1 : 1;
      for (const b of blockers.filter(o => o.cls === 'ol' && o.job.target && o.job.target.y0 >= 2 && o.job.scheme !== 'pull')) {
        const side = (d.x0 - b.x0) * S.p * lean;
        assert.ok(side < -0.5 || side > 1.6, `${what}: the ${b.label} climbs to the ${b.job.target.label} past the ${d.label} in front of him, who is left free (${lines()})`);
      }
    }
  }
  // The look from the first round's lab: Singleback inside zone into a 4-3 Over in Cover 1 went nowhere, the nose tackle
  // making most of the tackles, while a guard ran past him to a safety eight yards deep.
  let y = 0, nose = 0;
  for (let k = 0; k < 60; k++) {
    const r = simulate({ formation: 'single', play: 'iz', front: 'over', coverage: 'c1', pressure: k % 4 ? 'four' : 'blitz', flip: k % 2 === 1 }, 9000 + k);
    y += r.result.yards; if (r.result.by >= 0 && r.players[r.result.by].label === 'NT') nose++;
  }
  assert.ok(y / 60 > 3 && nose < 15, `Singleback inside zone against the Over in Cover 1: ${(y / 60).toFixed(1)} yards a carry, the nose made ${nose} of 60 tackles`);
});

test('on a run a rusher doesn\'t walk through anybody: a lineman bumps any rusher who runs into him', () => {
  let seed = 2024;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const on = new Map(); // frames running that a rusher, in nobody's block, has been inside half a yard of an offensive player
    for (const f of r.frames) {
      if (f.t > r.result.t + 1e-9) break;
      for (const d of S.D.filter(d => d.job.kind === 'rush')) for (const o of S.O) {
        const k = d.i * 32 + o.i, x = f.xy;
        const n = f.eng[d.i] < 0 && Math.hypot(x[2 * d.i] - x[2 * o.i], x[2 * d.i + 1] - x[2 * o.i + 1]) < 0.5 ? (on.get(k) || 0) + 1 : 0;
        on.set(k, n);
        assert.ok(n < 10, `${what}: the ${d.label} walks through the ${o.label}, at ${f.t.toFixed(2)}s`);
      }
    }
  }
});

test('on a run the ball carrier runs into a rusher held in a block, not through him', () => {
  // A rusher held in a block moves with it and lets the other linemen by, but the back still has to go round him: a
  // held defender within reach of the ball carrier can reach out of the block and tackle him.
  let seed = 4242;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const hand = r.events.find(e => e.kind === 'hand');
    if (!hand) continue;
    const on = new Map(); // frames running that a held rusher has been inside half a yard of the ball carrier
    for (const f of r.frames) {
      if (f.t > r.result.t + 1e-9) break;
      if (f.t < hand.t || f.c < 0) continue;
      for (const d of S.D.filter(d => d.job.kind === 'rush')) {
        const x = f.xy, n = f.eng[d.i] >= 0 && Math.hypot(x[2 * d.i] - x[2 * f.c], x[2 * d.i + 1] - x[2 * f.c + 1]) < 0.5 ? (on.get(d.i) || 0) + 1 : 0;
        on.set(d.i, n);
        assert.ok(n < 6, `${JSON.stringify(call)} seed ${seed - 1}: the ball carrier runs through the ${d.label}, held in a block, at ${f.t.toFixed(2)}s`);
      }
    }
  }
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

// Where the receiver caught it, in yards past the line (the first frame after the throw with the ball in his hands).
const caughtAt = r => { const f = r.frames.find(f => f.t > r.events.find(e => e.kind === 'throw').t && !f.air && f.c === r.result.carrier); return f.xy[2 * r.result.carrier + 1]; };

test('a deep catch is run down from behind: no long run after every catch 15 yards downfield', () => {
  // 640 snaps of the four plays that throw deep. From four start seeds (31, 1000, 5000, 77777) catches 15+ yards
  // downfield gain 5.9-8.1 yards after the catch on average; before the men chasing a deep catch got him more often,
  // 10.2-14.6. (NFL 2023 regular season: 5.2, from nflverse play-by-play.)
  let seed = 31, n = 0, yac = 0;
  for (const fm of FORMATIONS) for (const play of ['verts', 'smash', 'mesh', 'pa']) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    const r = simulate({ formation: fm.id, play, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 }, seed++);
    if (r.result.kind !== 'catch') continue;
    const at = caughtAt(r);
    if (at >= 15) { n++; yac += r.result.yards - at; }
  }
  assert.ok(n > 40, `${n} deep catches`);
  assert.ok(yac / n < 10, `${n} catches 15+ yards downfield gain ${(yac / n).toFixed(1)} yards after the catch on average`);
});

test('over many snaps the numbers look like football', () => {
  // 2,100 snaps, enough to hold the README's numbers: about four yards a carry, around 60% complete, a sack on about
  // one dropback in twenty-five. From twelve start seeds (77 + k * 7919) this recipe gives 3.44-5.18 yards a carry,
  // 57-61% complete, sacks on 2.6-4.4% of dropbacks and interceptions on 2.0-3.5% of throws; at 700 snaps a carry
  // ranged from 2.7 to 5.1 yards.
  let seed = 77;
  const pick = list => list[(seed = (seed * 16807) % 2147483647) % list.length];
  const run = { n: 0, y: 0 }, pass = { n: 0, att: 0, comp: 0, sack: 0, int: 0 };
  for (let k = 0; k < 2100; k++) {
    const pl = pick(PLAYS);
    const r = simulate({ formation: pick(FORMATIONS).id, play: pl.id, front: pick(FRONTS).id, coverage: pick(COVERAGES).id, pressure: k % 4 ? 'four' : 'blitz' }, seed).result;
    if (pl.type === 'run') { run.n++; run.y += r.yards; }
    else { pass.n++; if (r.kind === 'sack') pass.sack++; else pass.att++; if (r.kind === 'catch') pass.comp++; if (r.kind === 'int') pass.int++; }
  }
  const ypc = run.y / run.n, comp = pass.comp / pass.att, sack = pass.sack / pass.n, int = pass.int / pass.att;
  assert.ok(ypc > 3.3 && ypc < 5.3, `yards a carry ${ypc.toFixed(2)}`);
  assert.ok(comp > 0.52 && comp < 0.66, `completion rate ${comp.toFixed(3)}`);
  assert.ok(sack > 0.02 && sack < 0.06, `sack rate ${sack.toFixed(3)}`);
  assert.ok(int > 0.01 && int < 0.05, `interception rate ${int.toFixed(3)}`);
});

test('the README\'s matchups', () => {
  // The README says four verticals do least against Cover 4's extra deep defender (of Cover 2, 3 and 4), crossing
  // routes get open against Cover 1's man coverage, and runs struggle with more defenders in the box than blockers.
  // Each cell is 240 snaps: every formation against every front, 15 snaps each, a blitz on one in four. From four start
  // seeds (2718, 31415, 16180, 14142) Four Verticals gained 3.9-7.3 yards a dropback fewer against Cover 4 than Cover 3
  // (and 12.3-13.8 fewer than Cover 2), Mesh threw to its crossers on 41-48% of throws against Cover 1 and 15-22%
  // against Cover 3, and runs succeeded 40-44% of the time at even numbers in the box and 19-23% with two more
  // defenders than blockers. A change to the balance that undoes one of these has to change the README with it.
  let seed = 2718;
  const won = r => (r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= 4;
  const cell = (play, coverage, each) => {
    for (const fm of FORMATIONS) for (const fr of FRONTS) for (let k = 0; k < 15; k++) {
      const call = { formation: fm.id, play, front: fr.id, coverage, pressure: k % 4 ? 'four' : 'blitz', flip: k % 2 === 1 };
      each(call, seed, simulate(call, seed)); seed++;
    }
  };
  const verts = {};
  for (const c of ['c2', 'c3', 'c4']) { let y = 0, n = 0; cell('verts', c, (call, s, P) => { y += P.result.yards; n++; }); verts[c] = y / n; }
  assert.ok(verts.c4 < verts.c3 && verts.c4 < verts.c2, `Four Verticals, yards a dropback: Cover 2 ${verts.c2.toFixed(1)}, Cover 3 ${verts.c3.toFixed(1)}, Cover 4 ${verts.c4.toFixed(1)}`);
  const crossers = {};
  for (const c of ['c1', 'c3']) {
    let throws = 0, cross = 0;
    cell('mesh', c, (call, s, P) => {
      const t = P.events.find(e => e.kind === 'throw');
      if (t) { throws++; if (['drag', 'drag6'].includes(prepare(call, s).P[t.who].job.route)) cross++; }
    });
    crossers[c] = cross / throws;
  }
  assert.ok(crossers.c1 > crossers.c3, `Mesh's throws to its crossers: Cover 1 ${(100 * crossers.c1).toFixed(0)}%, Cover 3 ${(100 * crossers.c3).toFixed(0)}%`);
  const box = { 0: [0, 0], 2: [0, 0] };
  for (const pl of PLAYS.filter(p => p.type === 'run')) for (const cv of COVERAGES) for (const fm of FORMATIONS) for (const fr of FRONTS) for (let k = 0; k < 3; k++) {
    const P = simulate({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure: k % 4 ? 'four' : 'blitz', flip: k % 2 === 1 }, seed++);
    const b = box[P.box.box - P.box.blockers];
    if (b) { b[0]++; if (won(P.result)) b[1]++; }
  }
  const rate = d => box[d][1] / box[d][0];
  assert.ok(rate(2) < rate(0), `runs that succeed: ${(100 * rate(0)).toFixed(0)}% at even numbers in the box (${box[0][0]} runs), ${(100 * rate(2)).toFixed(0)}% with two more defenders than blockers (${box[2][0]})`);
});
