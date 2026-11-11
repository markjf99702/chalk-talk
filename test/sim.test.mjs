// Unit tests for the simulator:  node --test test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { simulate, prepare, name, hotRoutes, cantCall, blitzerFor, SIM_VERSION } from '../js/sim.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, NOTES, ROUTES, SIDELINE, DRILLS, HOT, BLITZERS, SITUATIONS, needed } from '../js/playbook.js';
import { rng } from '../js/rng.js';
import { coachRead, lookOf, lookAlikes, rankPlays, rankDefenses, rate, lean, playMix, motionShare } from '../js/read.js';
import { TABLE } from '../js/read-table.js';

const KINDS = new Set(['run', 'catch', 'incomplete', 'int', 'sack', 'throwaway']);
// The play-by-play line that ends a play: a tackle, out of bounds, a long run the board stops counting, a sack, an
// incompletion, a pass broken up, an interception or a throwaway.
const ENDINGS = new Set(['tackle', 'oob', 'long', 'sack', 'inc', 'pbu', 'int', 'away']);
const ended = r => r.events.some(e => ENDINGS.has(e.kind));

test('every call against every defense runs to a finish', () => {
  let seed = 1;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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

// Every share link carries SIM_VERSION (js/sim.js), and replays its calls and its roll of the dice through whatever
// simulator the site has now: a link made with another version says its snap may not play out as it did for whoever
// sent it. So any change to how snaps play out needs a new version. PRINTS keeps a fingerprint of how each version
// played a fixed set of snaps: every formation, play and coverage, both ways round, with the front, the pressure and
// blitzer, a disguise, motion, a hot route (a back's too) and the down picked from a fixed seed. It's where every man
// and the ball was, a twentieth of a second at a time, who was blocking whom, and what happened (the play-by-play and
// the result, but not their words, which can change without the play changing). Keep the old ones: they say when the
// board changed.
// (Changing which snaps howItPlays() runs changes the print but not the simulator: then replace the current version's
// print, and leave SIM_VERSION as it is.)
const PRINTS = { 1: 'eecb1df0fce4', 2: 'dae7b7cbcb44', 3: 'eef3338297b6', 4: '58b13bd04745', 5: '7f0851b2108c' };
function howItPlays() {
  const all = createHash('sha256');
  let seed = 0;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const cv of COVERAGES) for (const flip of [false, true]) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    // Anyone the board lets you give a new route, the backs too: a back's wheel is only ever a hot route.
    const R = rng(++seed), men = fm.players.map(([label, , , cls]) => [label, hotRoutes(pl, { cls })]).filter(([, routes]) => routes.length);
    const hot = men.length && R.chance(0.3) ? (([who, routes]) => ({ [who]: R.pick(routes) }))(R.pick(men)) : {};
    const r = simulate({
      formation: fm.id, play: pl.id, front: R.pick(FRONTS).id, coverage: cv.id, flip,
      pressure: R.chance(0.4) ? 'blitz' : 'four', blitzer: R.pick(BLITZERS).id, disguise: R.chance(0.3),
      motion: fm.motion ? R.pick(['none', 'across', 'jet']) : 'none', hot, sit: R.pick(SITUATIONS).id,
    }, seed);
    const one = createHash('sha256');
    one.update(JSON.stringify([r.result, r.events.map(({ text, ...e }) => e)]));
    for (const f of r.frames) {
      one.update(JSON.stringify([f.t, f.ball, f.c, f.air]));
      one.update(new Uint8Array(f.xy.buffer, f.xy.byteOffset, f.xy.byteLength));
      one.update(new Uint8Array(f.eng.buffer, f.eng.byteOffset, f.eng.byteLength));
    }
    all.update(one.digest());
  }
  return all.digest('hex').slice(0, 12);
}

test('snaps play out the way this version of the simulator played them: a change to that is a new version', () => {
  const print = howItPlays(), last = Math.max(...Object.keys(PRINTS).map(Number));
  assert.ok(Number.isInteger(SIM_VERSION) && SIM_VERSION >= last, `SIM_VERSION is ${SIM_VERSION}, and PRINTS goes up to ${last}: versions only go up`);
  if (!(SIM_VERSION in PRINTS)) assert.fail(`Add ${SIM_VERSION}: '${print}' to PRINTS in test/sim.test.mjs: it's how version ${SIM_VERSION} plays.`);
  const next = SIM_VERSION + 1;
  assert.equal(print, PRINTS[SIM_VERSION], `Snaps play out differently from version ${SIM_VERSION} of the simulator, so a link made with it would show something else now. Set SIM_VERSION in js/sim.js to ${next}, and add ${next}: '${print}' to PRINTS in test/sim.test.mjs. (If version ${SIM_VERSION} hasn't reached main, the live site, no link has it: change its print to '${print}' instead.)`);
});

test('formations are legal: seven on the line, eleven a side, nobody offside', () => {
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) {
    const S = prepare({ formation: fm.id, play: cantCall(fm.id, 'iz') ? 'smash' : 'iz', front: fr.id, coverage: cv.id, pressure: 'four' }, 3);
    assert.equal(S.O.length, 11); assert.equal(S.D.length, 11);
    assert.equal(S.O.filter(p => p.y > -1).length, 7, `${fm.id}: players on the line`);
    for (const d of S.D) assert.ok(d.y >= 0.6, `${fm.id} vs ${fr.id} ${cv.id}: ${d.label} is offside`);
    for (const p of S.O) assert.ok(p.y < 0, `${fm.id}: ${p.label} is offside`);
  }
});

test('the Pistol puts the back straight behind a quarterback 4 yards back, and Gun Ace splits both tight ends off the line', () => {
  for (const flip of [false, true]) {
    const P = prepare({ formation: 'pistol', play: 'screen', front: 'over', coverage: 'c2', pressure: 'four', flip }, 4), s = flip ? -1 : 1;
    assert.deepEqual([P.QB.x, P.QB.y, P.RB.x, P.RB.y].map(v => v + 0), [0, -4, 0, -7], 'the Pistol\'s backfield');
    // With the back behind him rather than beside him on the weak side, the screen still goes weak, and the back sets
    // to that side to block for a moment first, rather than the other way and then back across.
    assert.equal(P.RB.job.out, -s, 'the Pistol\'s screen goes to the weak side');
    assert.ok(P.RB.set.x * -s > 1, `the back sets to the weak side first, at x ${P.RB.set.x}`);
    const A = prepare({ formation: 'ace', play: 'smash', front: 'over', coverage: 'c2', pressure: 'four', flip }, 4);
    const ends = A.O.filter(p => p.cls === 'te');
    assert.equal(ends.length, 2);
    for (const te of ends) assert.ok(te.y < -1 && Math.abs(te.x) > 5, `Gun Ace's ${te.label} is split off the line, at ${te.x}, ${te.y}`);
    assert.deepEqual([A.ends[1], A.ends[-1]], [undefined, undefined], 'neither tight end is on the line');
    assert.deepEqual([A.keys.S2.cls, A.keys.W2.cls], ['te', 'te'], 'each is the second receiver on his side');
  }
  // The screen from the Pistol: the quarterback isn't sacked by the end the screen side lets through any more often than
  // from the other shotgun sets (it was one dropback in three when the screen went to the strong side).
  let n = 0, sacks = 0;
  for (const front of ['over', 'under', '34', 'nickel']) for (const coverage of ['c1', 'c2', 'c3', 'c4']) for (let k = 0; k < 10; k++) {
    n++;
    if (simulate({ formation: 'pistol', play: 'screen', front, coverage, pressure: 'four', flip: k % 2 === 1 }, 500 + n).result.kind === 'sack') sacks++;
  }
  assert.ok(sacks / n < 0.15, `the Pistol's screen is a sack ${sacks} times in ${n}`);
});

test('Empty: the back splits out as a fifth receiver, only the five linemen block, and nothing needs a back behind the line', () => {
  for (const flip of [false, true]) for (const pl of PLAYS) {
    const call = { formation: 'empty', play: pl.id, front: 'nickel', coverage: 'c1', pressure: 'blitz', flip };
    const no = cantCall('empty', pl.id);
    // No back to hand it to, to fake to, or to throw the screen to.
    assert.equal(!!no, pl.type === 'run' || pl.drop === 'pa' || pl.drop === 'screen', `${pl.id}: "${no}"`);
    if (no) { assert.throws(() => prepare(call, 1), /Empty/); continue; }
    const S = prepare(call, 1), rb = S.O.find(p => p.label === 'RB');
    assert.equal(S.RB, undefined, 'nobody in the backfield');
    assert.equal(rb.info, 'RBwide');
    assert.ok(rb.key && /^[SW][12]$/.test(rb.key), `the back is counted as a receiver, ${rb.key}`);
    assert.deepEqual([S.strongList.length, S.weakList.length], [3, 2], 'three receivers on one side, two on the other');
    assert.deepEqual(hotRoutes(pl, rb), HOT.receiver, 'he can be given a receiver\'s routes');
    assert.equal(rb.job.kind, 'route', `${pl.id}: he runs a route`);
    assert.ok(!['check', 'swing', 'wheel', 'bflat', 'screen'].includes(rb.job.route), `${pl.id}: a receiver's route, not ${rb.job.route}`);
    assert.deepEqual(S.protection.map(p => p.cls), ['ol', 'ol', 'ol', 'ol', 'ol'], `${pl.id}: the five linemen protect`);
  }
  // Every other formation has a back, and can call every play.
  for (const fm of FORMATIONS.filter(f => f.id !== 'empty')) for (const pl of PLAYS) assert.equal(cantCall(fm.id, pl.id), '', `${fm.id} ${pl.id}`);
  // Five blockers against six rushers in Cover 0: one comes free, and the ball comes out hot.
  let hot = 0, n = 0;
  for (const pl of PLAYS.filter(p => !cantCall('empty', p.id))) for (const front of ['over', 'nickel']) for (let k = 0; k < 8; k++) {
    const r = simulate({ formation: 'empty', play: pl.id, front, coverage: 'c0', pressure: 'blitz', flip: k % 2 === 1 }, 900 + n++);
    if (r.events.some(e => e.kind === 'throw' && /, hot, with /.test(e.text))) hot++;
  }
  assert.ok(hot / n > 0.5, `${hot} hot throws in ${n} dropbacks from Empty against Cover 0`);
});

test('Stick: the outside man clears out deep, one man sits at five yards, and the flat goes outside him', () => {
  const routes = (formation, flip) => { const S = prepare({ formation, play: 'stick', front: 'nickel', coverage: 'c3', pressure: 'four', flip }, 2); return [S, Object.fromEntries(S.O.filter(p => p.job.kind === 'route').map(p => [p.key || p.label, p.job.route]))]; };
  for (const flip of [false, true]) {
    const [T, trips] = routes('trips', flip), [, doubles] = routes('doubles', flip);
    assert.equal(T.play.id, 'stick');
    assert.deepEqual([trips.S1, trips.S2, trips.S3], ['go', 'flat', 'stick'], 'from three receivers: go, then the slot to the flat, and the inside man on the stick');
    assert.deepEqual([doubles.S1, doubles.S2, doubles.RB], ['go', 'stick', 'bflat'], 'from two: the back runs the flat');
    assert.equal(T.reads[0].job.route, 'stick', 'the stick is his first read');
    assert.equal(T.reads[1].job.route, 'flat', 'and the flat his second');
    const st = T.reads[0], end = st.path.at(-1);
    assert.ok(end.y - st.y0 > 4 && end.y - st.y0 < 7 && ROUTES.stick.settle, `the stick sits down ${(end.y - st.y0).toFixed(1)} yards up`);
    // From three receivers the flat starts outside the stick and runs away from it, toward the sideline.
    const fl = T.reads[1];
    assert.ok(Math.abs(fl.x0) > Math.abs(st.x0) && Math.abs(fl.path.at(-1).x) > Math.abs(end.x) + 10, `the flat runs from ${fl.x0.toFixed(1)} to ${fl.path.at(-1).x.toFixed(1)}, the stick sits at ${end.x.toFixed(1)}`);
  }
  // From Gun Trips, the formation the board starts in, against Cover 3 and Cover 4: the defender sitting on the stick
  // can't get to the flat as well. (When the inside man ran the flat, it went under him, a yard or two away: a third of
  // the throws were caught, for under 2 yards a play, and one in twelve was intercepted.)
  for (const coverage of ['c3', 'c4']) {
    let n = 0, y = 0, comp = 0, att = 0, int = 0;
    for (const front of FRONTS) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 6; k++) {
      const r = simulate({ formation: 'trips', play: 'stick', front: front.id, coverage, pressure, flip: k % 2 === 1 }, 4100 + n++).result;
      y += r.yards; if (r.kind !== 'sack') att++; if (r.kind === 'catch') comp++; if (r.kind === 'int') int++;
    }
    assert.ok(comp / att > 0.65 && y / n > 4.5 && int / att < 0.03, `Gun Trips against ${coverage}: ${(100 * comp / att).toFixed(0)}% complete, ${(y / n).toFixed(1)} yards a dropback, ${int} intercepted in ${att}`);
  }
  // From Gun Doubles the back's flat ends well outside the slot's stick, and against Cover 3 the quarterback finds one of
  // them. (It ended under the stick, and the man sitting there had both: the ball was thrown away about half the time.)
  for (const flip of [false, true]) {
    const D = prepare({ formation: 'doubles', play: 'stick', front: 'nickel', coverage: 'c3', pressure: 'four', flip }, 2);
    const st = D.keys.S2.path.at(-1), fl = D.RB.path.at(-1);
    assert.ok(Math.abs(fl.x) >= Math.abs(st.x) + 5 && Math.sign(fl.x) === Math.sign(st.x), `the back's flat ends at ${fl.x.toFixed(1)}, the stick sits at ${st.x.toFixed(1)}`);
  }
  {
    let n = 0, y = 0, away = 0;
    for (const front of FRONTS) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 24; k++) {
      const r = simulate({ formation: 'doubles', play: 'stick', front: front.id, coverage: 'c3', pressure, flip: k % 2 === 1 }, 4300 + n++).result;
      y += r.yards; if (r.kind === 'throwaway') away++;
    }
    assert.ok(away / n < 0.35 && y / n > 4, `Gun Doubles against Cover 3: thrown away ${away} times in ${n}, ${(y / n).toFixed(1)} yards a dropback`);
  }
  // He reads the man sitting on the stick: once he's come off it to the flat, if that man goes with the back to the flat,
  // the ball goes to the stick, open where he was. Gun Doubles against a Cover 3 blitz, three defenders underneath:
  // about half the snaps, nine in ten caught. (He didn't look back: the stick was thrown only once nothing else had
  // come open, as the drop ran out, about 2 1/2 seconds after the snap.) In man coverage the man on the stick stays on
  // him, so never. Since the coverage and the routes vary from snap to snap (version 5: see PASS_SPREAD in js/sim.js),
  // the man sitting on the stick is often a yard or so off it, and the stick is open on the first look: here 33 of the
  // 96, and the stick read 15 times, 13 caught, with the stick thrown on 57 snaps (before, 5, 42 and 48). From start
  // seed 50000, 400 snaps: the read 80 times, 77 of them gaining 4 yards or more, and the stick thrown 257 times.
  for (const coverage of ['c3', 'c1']) {
    let n = 0, read = 0, comp = 0, t0 = 0, stick = 0;
    for (const front of FRONTS) for (let k = 0; k < 24; k++) {
      const r = simulate({ formation: 'doubles', play: 'stick', front: front.id, coverage, pressure: 'blitz', flip: k % 2 === 1 }, 4500 + n++);
      const t = r.events.find(e => e.kind === 'throw');
      if (t?.route === 'stick') stick++;
      if (t?.how !== 'stick') continue;
      read++; t0 += t.t;
      if (r.result.kind === 'catch') comp++;
      const f = r.frames.find(f => f.t >= t.t), at = i => [f.xy[2 * i], f.xy[2 * i + 1]], d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
      const [key, st, fl] = [at(t.key), at(t.who), at(t.flat)];
      assert.ok(d(key, st) > 2 && d(key, fl) < d(key, st), `seed ${4500 + n - 1}: thrown to the stick with the man on it ${d(key, st).toFixed(1)} yards from him and ${d(key, fl).toFixed(1)} from the flat`);
      assert.match(t.text, /^The quarterback throws to the Y on a stick route, as the .+ leaves him for the flat\.$/);
    }
    if (coverage === 'c1') assert.equal(read, 0, 'against Cover 1 the man on the stick left him');
    else assert.ok(read / n > 0.1 && stick / n > 0.45 && comp / read > 0.8 && t0 / read < 2.4, `against a Cover 3 blitz the stick read ${read} times in ${n}, ${comp} caught, ${(t0 / read).toFixed(2)} s after the snap; the stick thrown ${stick} times`);
  }
  // Over many snaps: short, sure throws, the stick or a flat route nearly every time, against zone and man alike.
  for (const coverage of ['c1', 'c3', 'c4']) {
    let n = 0, y = 0, short = 0, comp = 0, att = 0;
    for (const fm of FORMATIONS) for (const front of ['over', 'nickel']) for (let k = 0; k < 6; k++) {
      const r = simulate({ formation: fm.id, play: 'stick', front, coverage, pressure: 'four', flip: k % 2 === 1 }, 700 + n++);
      y += r.result.yards;
      const t = r.events.find(e => e.kind === 'throw');
      if (t && ['stick', 'flat', 'bflat'].includes(t.route)) short++;
      if (r.result.kind !== 'sack') att++;
      if (r.result.kind === 'catch') comp++;
    }
    assert.ok(short / n > 0.7, `${coverage}: the stick or the flat on ${short} of ${n} snaps`);
    assert.ok(comp / att > 0.55 && y / n > 3 && y / n < 9, `${coverage}: ${(100 * comp / att).toFixed(0)}% complete for ${(y / n).toFixed(1)} yards a dropback`);
  }
});

test('Counter: the back steps away first and the linebackers go with him; the back-side guard kicks out the end, and the tackle pulls behind him when a tight end can take the end they leave', () => {
  const job = (S, l) => S.O.find(p => p.label === l).job;
  for (const flip of [false, true]) {
    const p = flip ? -1 : 1, call = f => ({ formation: f, play: 'counter', front: 'over', coverage: 'c3', pressure: 'four', flip });
    const [bg, bt] = p > 0 ? ['LG', 'LT'] : ['RG', 'RT'];
    const single = prepare(call('single'), 3), iform = prepare(call('iform'), 3), trips = prepare(call('trips'), 3);
    for (const S of [single, iform, trips]) assert.deepEqual([job(S, bg).scheme, job(S, bg).pull], ['kick', true], `${S.fm.id}: the back-side guard pulls and kicks out`);
    // From Singleback the back-side tackle pulls with no man of his own: he follows the back through the hole and
    // blocks whoever's left there (the back is at the line ahead of him about six snaps in seven). (Sent at the Mike,
    // who steps the other way with the fake, he got past the line 2-4 yards inside the hole, chasing him.) When he gets
    // past the line, it's through the hole: the one drawn, or the one the back took inside it, leaning to the cutback
    // (see LEAN in js/sim.js; from Singleback against the 4-3 Over, seed 2, the back went through 2.8 yards inside it
    // and the tackle after him, 1.9 inside).
    assert.deepEqual([job(single, bt).scheme, job(single, bt).target], ['pull', null], 'from Singleback the back-side tackle pulls, with no man of his own');
    assert.equal(single.jobText[single.O.find(o => o.label === bt).i], 'Pulls from the back side behind the guard, follows the back through the hole, and blocks whoever\'s left there.');
    let through = 0;
    for (const front of ['over', 'under', '34', 'nickel']) for (let s = 1; s <= 6; s++) {
      const c = { ...call('single'), front, coverage: ['c1', 'c2', 'c3', 'c4'][s % 4] }, T = prepare(c, s), tk = T.O.find(o => o.label === bt);
      const F = simulate(c, s).frames, f = F.find(f => f.xy[2 * tk.i + 1] > 0.5), b = F.find(f => f.xy[2 * T.RB.i + 1] > 0.5);
      if (!f) continue;
      through++;
      const hole = Math.min(0, b ? (b.xy[2 * T.RB.i] - T.aimX) * p : 0); // (inside the hole as drawn, where the back took it)
      assert.ok((f.xy[2 * tk.i] - T.aimX) * p - hole > -1.5, `Singleback against the ${front}, seed ${s}: the pulling tackle gets past the line ${((T.aimX - f.xy[2 * tk.i]) * p).toFixed(1)} yards inside the hole, the back ${(-hole).toFixed(1)}`);
    }
    assert.ok(through >= 3, `the pulling tackle got past the line on ${through} snaps`);
    assert.equal(job(single, 'U').scheme, 'fill', 'and the back-side tight end takes the end they leave');
    assert.equal(job(single, 'U').target?.label, 'DE');
    for (const S of [iform, trips]) assert.deepEqual([job(S, bt).scheme, job(S, bt).target?.label], ['fill', 'DE'], `${S.fm.id}: the tackle stays home on the end`);
    // Against the 3-4 the outside linebacker stands up outside that end. The man left on the back side takes the end
    // nearest him, and leaves the outside linebacker, farthest from the play.
    for (const fm of ['iform', 'trips', 'doubles', 'pistol', 'single']) {
      const T = prepare({ ...call(fm), front: '34' }, 3), who = fm === 'single' ? 'U' : bt;
      assert.deepEqual([job(T, who).scheme, job(T, who).target?.label], ['fill', 'DE'], `${fm} against the 3-4: the ${who} blocks the end`);
      assert.match(T.jobText[T.O.find(o => o.label === who).i], /the weak-side end, the (end the pulling guard|man the pullers) leaves?\./, `${fm} against the 3-4: the ${who}'s card`);
    }
    assert.equal(job(iform, 'FB').scheme, 'lead', 'from I-Form the fullback leads through the hole');
    // From Gun Ace the tight end a step off the line on the back side blocks that end, so the tackle staying home has
    // nobody of his own, and his card doesn't say he has the end.
    const ace = prepare(call('ace'), 3), aceT = ace.O.find(o => o.label === bt), aceU = ace.O.find(o => o.label === 'U');
    assert.deepEqual([aceT.job.scheme, aceT.job.target, Math.sign(aceU.x0), aceU.job.target?.label], ['fill', null, -p, 'DE'], 'from Gun Ace the back-side tight end has the end');
    assert.equal(ace.jobText[aceT.i], 'Stays home on the back side, for anyone coming through the gap the pulling guard leaves.');
    // The step away, and the linebackers with it.
    const r = simulate(call('single'), 3), at = t => r.frames.find(f => f.t >= t - 1e-9).xy, rb = single.RB.i;
    assert.ok((at(0.25)[2 * rb] - single.RB.x0) * p < -0.12, 'the back jabs away from the play first');
    const lbs = single.D.filter(d => d.cls === 'lb' && d.job.kind !== 'rush');
    assert.ok(lbs.every(d => (at(0.6)[2 * d.i] - d.x0) * p < -0.2), 'the linebackers go with him');
    // Under center they go with him until 0.9 s, half a yard up the field. From the shotgun, where the back has the ball
    // sooner, only until the handoff: by 0.85 s each has come downhill toward the back, more than a yard.
    assert.ok(lbs.every(d => d.y0 - at(0.85)[2 * d.i + 1] < 0.7), 'under center the linebackers are still stepping with the fake at 0.85 s');
    // (Not one who guessed wrong, who takes a step away from the play first: see GUESS in js/sim.js.)
    for (const fm of ['pistol', 'ace', 'doubles', 'trips']) {
      const G = prepare(call(fm), 3), g = simulate(call(fm), 3), xy = g.frames.find(f => f.t >= 0.85 - 1e-9).xy;
      assert.ok(g.events.find(e => e.kind === 'hand').t < 0.85, `${fm}: the handoff comes before 0.85 s`);
      for (const d of G.D.filter(d => d.cls === 'lb' && d.job.kind !== 'rush' && d.guess >= 0)) assert.ok(d.y0 - xy[2 * d.i + 1] > 1, `${fm}: once the back has the ball the ${d.label} comes downhill: ${(d.y0 - xy[2 * d.i + 1]).toFixed(2)} yards at 0.85 s`);
    }
    // But not a linebacker in the bump, holding the edge: the Sam, when the strong safety blitzes after the Z goes across.
    const bc = { ...call('iform'), coverage: 'c1', pressure: 'blitz', blitzer: 'SS', motion: 'across' };
    const B = prepare(bc, 5), sam = B.D.find(d => d.bump), xy = simulate(bc, 5).frames.find(f => f.t >= 0.6 - 1e-9).xy;
    assert.equal(sam?.label, 'S', 'the Sam bumps');
    assert.ok((xy[2 * sam.i] - sam.x0) * p > -0.2, `the Sam in the bump holds his ground: ${(xy[2 * sam.i] - sam.x0).toFixed(2)} yards`);
  }
  // Over many snaps: about 3.5 yards a carry, about half of them gaining 4, and about one in ten losing yards (the
  // coach's note says so). (Built before the shotgun read and the run-down from behind, it gave 3.1 yards a
  // carry here, 29% gaining 4 and 25% losing yards; since then, 3.6, 51% and 20%: from the shotgun, where the defense
  // waited to read the handoff as well as stepping with the fake, it gained 4 yards 44-81% of the time, from 11-39%.
  // With their step ending at the handoff there, from this seed and 1, 100000 and 7777777: 2.4-3.2 yards a carry,
  // 36-43% gaining 4, 24-27% losing yards. With the back side's end blocked rather than the outside linebacker beyond
  // him: 3.2-3.8, 44-51% and 10-14%; against the 3-4, 7-10% losing yards, from 49-53%. With Singleback's pulling
  // tackle leading through the hole rather than chasing the Mike: 3.4-4.0, 48-56% and 7-10%, and from Singleback 44-50%
  // gaining 4, from 17-25%. From 424242 and 55555 as well, 7-10% losing yards: held under 15%, so the note's "one time
  // in ten" can't drift to one in five unseen. With the guard pulling flat when the man he kicks out is the Sam, 3.7-4.1
  // yards a carry, 48-56% gaining 4 and 7-10% losing yards, and from Singleback 53-56% gaining 4, from 44-53%. With the
  // back's lean, the linebackers' guesses and run blocks won and lost early more often (version 4), from these six start
  // seeds: 3.4-3.9 yards a carry, 45-51% gaining 4 and 8-13% losing yards (from 3.7-4.1, 48-56% and 7-10%); against the
  // 3-4, 7-13% losing yards, from 0-3%; and from Singleback 39-56% gaining 4, from 53-61%.)
  let n = 0, y = 0, ok = 0, lost = 0, n34 = 0, lost34 = 0, n1 = 0, ok1 = 0;
  for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'counter'))) for (const front of ['over', 'nickel', '34']) for (const coverage of ['c1', 'c2', 'c3']) for (let k = 0; k < 4; k++) {
    const res = simulate({ formation: fm.id, play: 'counter', front, coverage, pressure: k % 2 ? 'four' : 'blitz', flip: k % 2 === 1 }, 1300 + n++).result;
    y += res.yards; if (Math.round(res.yards) >= 4) ok++; if (res.yards < 0) lost++;
    if (front === '34') { n34++; if (res.yards < 0) lost34++; }
    if (fm.id === 'single') { n1++; if (Math.round(res.yards) >= 4) ok1++; }
  }
  assert.ok(y / n > 2.5 && y / n < 5 && ok / n > 0.35 && ok / n < 0.6 && lost / n > 0.06 && lost / n < 0.15, `Counter: ${(y / n).toFixed(1)} yards a carry, ${Math.round(100 * ok / n)}% gaining 4, ${Math.round(100 * lost / n)}% losing yards`);
  assert.ok(lost34 / n34 < 0.2, `against the 3-4 Counter loses yards ${Math.round(100 * lost34 / n34)}% of the time`);
  assert.ok(ok1 / n1 > 0.33, `from Singleback Counter gains 4 yards ${Math.round(100 * ok1 / n1)}% of the time`);
});

test('Counter from Singleback against the 4-3 Over: the guard pulls at the heels of the line and gets up through it to the Sam', () => {
  // The man he kicks out there is the Sam, a linebacker off the line outside the tight end. Pulling 1.8 yards deep he
  // came up behind the play-side tackle blocking down and was caught on his back, with the back already at the line:
  // from this start seed and 1, 100000 and 7777 he got to the Sam on 11-15% of these snaps, and Counter gained 4 yards
  // 18-24% of the time. Pulling flat, 33-36%, and 29-31% gaining 4: at least one time in four (Mark's call).
  let n = 0, reach = 0, ok = 0, seed = 2600;
  for (const coverage of ['c1', 'c2', 'c3', 'c4']) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 10; k++) {
    const call = { formation: 'single', play: 'counter', front: 'over', coverage, pressure, flip: k % 2 === 1 };
    const S = prepare(call, seed), r = simulate(call, seed++), g = S.O.find(o => o.job.scheme === 'kick');
    assert.equal(g.job.target?.label, 'S', 'the guard kicks out the Sam');
    if (!k) for (const f of r.frames) if (f.t > 0 && f.t <= 0.55) assert.ok(f.xy[2 * g.i + 1] > -1.3, `${coverage} ${pressure}: the guard pulls ${(-f.xy[2 * g.i + 1]).toFixed(2)} yards behind the line`);
    n++;
    if (r.frames.some(f => f.eng[g.i] === g.job.target.i && f.t <= r.result.t)) reach++;
    if (Math.round(r.result.yards) >= 4) ok++;
  }
  assert.ok(reach / n > 0.25, `the guard got to the Sam on ${reach} snaps of ${n}`);
  assert.ok(ok / n > 0.25, `Counter gained 4 yards on ${ok} snaps of ${n}`);
  // Power's guard, and Counter's when his man is the end on the line (from Gun Doubles), pull as before, and are drawn so.
  for (const [fm, play] of [['single', 'power'], ['doubles', 'counter']]) {
    const S = prepare({ formation: fm, play, front: 'over', coverage: 'c3', pressure: 'four' }, 5), g = S.O.find(o => o.job.pull);
    assert.equal(S.overlay.find(o => o.kind === 'pull' && o.i === g.i).pts[1].y, -1.8, `${fm} ${play}: the guard's pull is drawn 1.8 yards deep`);
  }
  const C = prepare({ formation: 'single', play: 'counter', front: 'over', coverage: 'c3', pressure: 'four' }, 5), cg = C.O.find(o => o.job.scheme === 'kick');
  assert.equal(C.overlay.find(o => o.kind === 'pull' && o.i === cg.i).pts[1].y, -1.2, 'Singleback Counter: the guard\'s pull is drawn at the heels of the line');
});

test('the line is named left to right with the strength on either side, and on Power the back-side guard pulls', () => {
  for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'power'))) for (const flip of [false, true]) for (const front of ['over', '34']) {
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
  for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'screen'))) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
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

test('on the screen against the 3-4, the end let through doesn\'t get to the quarterback before the throw', () => {
  // The 3-4's end on the screen side lines up tight, on the tackle, and the line lets him go, so from the shotgun he
  // reached the quarterback at about 1.7 seconds, before the drop was over: a sack on about one screen in three. Once
  // the back has slipped out and turned, a rusher about to reach him gets the ball thrown, not a sack.
  let n = 0, sacks = 0, early = 0;
  for (const formation of ['pistol', 'ace', 'doubles', 'trips']) for (const coverage of ['c1', 'c2', 'c3', 'c4']) for (let k = 0; k < 6; k++) {
    const call = { formation, play: 'screen', front: '34', coverage, pressure: 'four', flip: k % 2 === 1 };
    const S = prepare(call, 1300 + n), r = simulate(call, 1300 + n++);
    if (r.result.kind === 'sack') sacks++;
    const thr = r.events.find(e => e.kind === 'throw');
    if (!thr) continue;
    assert.equal(thr.who, S.RB.i, `${JSON.stringify(call)}: the screen goes to the back`);
    // (thrown before the drop is over, to the back already out of his block and turned)
    const f = r.frames.find(f => f.t >= thr.t - 1e-9), rb = S.RB;
    assert.ok(thr.t >= rb.job.delay && Math.hypot(f.xy[2 * rb.i] - rb.x0, f.xy[2 * rb.i + 1] - rb.y0) > 2, `${JSON.stringify(call)}: thrown at ${thr.t} with the back still at his block`);
    if (thr.t < 1.75) early++;
  }
  assert.ok(sacks / n < 0.05, `the screen against the 3-4 is a sack ${sacks} times in ${n}`);
  assert.ok(early > 0, 'thrown before the drop is over when a rusher is about to get there');
  // Against the other fronts nobody gets to him that soon, so he still waits for the drop, and the linemen get out in
  // front first. (When a rusher within 3 yards was enough, the ball went early on nine screens in ten against every
  // front, and the screen worked less often.)
  let m = 0, thrown = 0, soon = 0;
  for (const formation of ['pistol', 'ace', 'doubles', 'trips']) for (const front of ['over', 'under', 'nickel']) for (const coverage of ['c1', 'c2', 'c3', 'c4']) for (let k = 0; k < 2; k++) {
    const r = simulate({ formation, play: 'screen', front, coverage, pressure: 'four', flip: k % 2 === 1 }, 1500 + m++);
    const thr = r.events.find(e => e.kind === 'throw');
    if (thr) { thrown++; if (thr.t < 1.75) soon++; }
  }
  assert.ok(soon / thrown < 1 / 3, `against the other fronts the screen went before the drop was over ${soon} times in ${thrown}`);
});

test('the rush read tells the truth: only blitzers are drawn as blitzers, and only rushers nobody blocked came unblocked', () => {
  let seed = 500, came = 0;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const pl of PLAYS.filter(p => p.type === 'pass')) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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

test('the play-by-play names the run at the handoff, and the blitzers right after the snap', () => {
  let seed = 271000, blitzes = 0;
  const RUN = { zone: /^Handoff to the running back, aiming just outside the guard\.$/, reach: /^Handoff to the running back, heading for the edge\.$/, draw: /^A late handoff to the running back, under the rush\.$/ };
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const what = `${JSON.stringify(call)} seed ${seed - 1}`;
    const hand = r.events.find(e => e.kind === 'hand');
    if (hand) {
      const want = pl.scheme === 'power' ? (S.FB ? /^Handoff to the running back, behind the pulling guard\.$/ : /^Handoff to the running back, inside the pulling guard's kick-out\.$/)
        : pl.scheme === 'counter' ? (S.FB ? /^Handoff to the running back, back the other way, behind the pulling guard and the fullback\.$/ : /^Handoff to the running back, back the other way, behind the pulling guard\.$/)
          : RUN[pl.scheme];
      assert.match(hand.text, want, `${what}: "${hand.text}"`);
    }
    const men = S.D.filter(d => d.job.kind === 'rush' && d.blitzer).map(d => d.i).sort((a, b) => a - b);
    const lines = r.events.filter(e => e.kind === 'blitz');
    if (!men.length) { assert.equal(lines.length, 0, `${what}: "${lines[0]?.text}" with nobody blitzing`); continue; }
    assert.equal(lines.length, 1, `${what}: ${lines.length} blitz lines`);
    const b = lines[0];
    assert.ok(b.t > 0 && b.t <= 0.15 && r.events[0] === b, `${what}: the blitz is named at ${b.t}s, after "${r.events[0].text}"`);
    assert.deepEqual([...b.all].sort((x, y) => x - y), men, `${what}: "${b.text}" points at the wrong men`);
    assert.ok(b.all.includes(b.who), `${what}: the blitz line points at somebody who isn't blitzing`);
    assert.match(b.text, cv.id === 'c0' ? /^Cover 0: the [\w ]+( and the [\w ]+)* blitz(es)?\.$/ : /^The [\w ]+(, the [\w ]+)*( and the [\w ]+)? blitz(es)?\.$/, `${what}: "${b.text}"`);
    assert.equal(/ and /.test(b.text), men.length > 1, `${what}: "${b.text}" for ${men.length} blitzers`);
    blitzes++;
  }
  assert.ok(blitzes > 300, `only ${blitzes} snaps had a blitz`);
});

test('every line of the play-by-play that names a man says which man, for the board to point at', () => {
  let seed = 4000;
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const r = simulate({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 }, seed++);
    for (const e of r.events) {
      if (e.text === 'It lands out of bounds. Incomplete.') continue; // names nobody
      assert.ok(Number.isInteger(e.who) && e.who >= 0 && e.who < 22, `${pl.id} seed ${seed - 1}: "${e.text}" (${e.kind}) has nobody to point at`);
    }
  }
});

test('run blocking: the men on the line first, linebackers next (or the nickel back, for a tight end), and never a safety', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'run' && p.scheme !== 'draw')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const S = prepare({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip }, 11);
    const what = `${fm.id} ${pl.id} vs ${fr.id} ${cv.id} ${pressure}${flip ? ', strong side left' : ''}`;
    const blockers = S.O.filter(o => o.job.kind === 'block');
    const lines = () => blockers.map(o => `${o.label}->${o.job.target?.label ?? '-'}`).join(' ');
    for (const b of blockers) {
      const d = b.job.target;
      if (!d) continue;
      assert.notEqual(d.cls, 's', `${what}: the ${b.label} is sent at the ${d.label}, a safety (${lines()})`);
      // (The kick-out is for the end man, whoever he is: a linebacker or a nickel back off the ball outside the end. And a
      // tight end with nobody else takes the nickel back near him, who has come on for a linebacker.)
      if (d.y0 >= 2 && b.job.scheme !== 'kick' && !(b.cls === 'te' && d === S.NB)) assert.equal(d.cls, 'lb', `${what}: the ${b.label} climbs to the ${d.label}, who isn't a linebacker (${lines()})`);
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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

test('on Power the pullers get to their men: the kick-out lands on the end, and the guard leads up on the linebacker', () => {
  // A puller or a kick-out blocker used to stop for whoever showed up in front of him first, and the tackle beside him
  // could take the end he was going for: of 288 Power snaps (every formation, front, coverage and pressure, both ways)
  // the kick-out had his man by the time the back got to the line in 125 and the pulling guard ahead of a fullback in 29
  // of 72. Now it's 221 and 57.
  let seed = 1, kick = 0, kickN = 0, pull = 0, pullN = 0;
  for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'power'))) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: 'power', front: fr.id, coverage: cv.id, pressure, flip };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const hole = r.events.find(e => e.kind === 'hole'), until = (hole ? hole.t : r.result.t) + 1e-9;
    for (const b of S.O.filter(o => o.job.kind === 'block' && o.job.target && (o.job.scheme === 'kick' || o.job.scheme === 'pull'))) {
      const got = r.frames.some(f => f.t <= until && f.eng[b.i] === b.job.target.i);
      if (b.job.scheme === 'kick') { kickN++; if (got) kick++; } else { pullN++; if (got) pull++; }
    }
  }
  assert.ok(kick >= 0.65 * kickN, `the kick-out got to his man in ${kick} of ${kickN} Power snaps`);
  assert.ok(pull >= 0.65 * pullN, `the pulling guard got to his linebacker in ${pull} of ${pullN} Power snaps`);
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

test('a back\'s flat route and check-down end past the line, the flat well outside a receiver who sits down short, and Flood sends one back to the flat', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass')) for (const flip of [false, true]) for (const motion of ['none', 'across']) {
    if (cantCall(fm.id, pl.id) || (motion !== 'none' && !fm.motion)) continue; // (Empty has no back: no runs, no fake, no screen)
    const S = prepare({ formation: fm.id, play: pl.id, front: 'over', coverage: 'c3', pressure: 'four', flip, motion }, 5);
    const backs = S.O.filter(p => p.job.kind === 'route' && (p.job.route === 'bflat' || p.job.route === 'check'));
    for (const b of backs) {
      const end = b.path.at(-1);
      assert.ok(end.y > 1.5, `${fm.id} ${pl.id}: the ${b.label}'s ${b.job.route} ends at ${end.y.toFixed(1)}, not past the line`);
      if (b.job.route === 'check') assert.ok(Math.abs(end.x) > 3.5, `${fm.id} ${pl.id}: the ${b.label}'s check-down ends inside the tackles, at x ${end.x.toFixed(1)}`);
      // A stick or a hitch on his side: the flat ends 5 yards or more past where he sits, not under him.
      if (b.job.route === 'bflat') for (const r of S.O.filter(p => p.num && ['stick', 'hitch'].includes(p.job.route) && p.path.at(-1).x * b.job.out > 0)) {
        assert.ok(end.x * b.job.out >= r.path.at(-1).x * b.job.out + 5 - 1e-9, `${fm.id} ${pl.id} ${motion}: the ${b.label}'s flat ends at ${end.x.toFixed(1)}, under the ${r.label}'s ${r.job.route} at ${r.path.at(-1).x.toFixed(1)}`);
      }
    }
    if (pl.id === 'flood') assert.equal(backs.filter(b => b.job.route === 'bflat').length + S.O.filter(p => p.num && p.job.route === 'flat').length, 1, `${fm.id} flood: one man in the flat`);
  }
});

test('Flood beats Cover 3 from Gun Ace and the Pistol too: the curl-flat defender leaves the tight end going deep for the back in the flat, and the sail opens behind him', () => {
  // From two receivers on a side the tight end runs Flood's sail and the back runs to the flat from behind the
  // quarterback. The Cover 3 curl-flat defender used to stay with the tight end until the back got into his area, so the
  // sail was covered when it was thrown: from Gun Ace about one throw to it in three was caught and one in nine was
  // intercepted, and from both formations Flood gained less against Cover 3 than against Cover 1 or Cover 2.
  let seed = 6100;
  const run = (formation, coverage) => {
    let n = 0, y = 0, sail = 0, caught = 0;
    for (const front of FRONTS) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 8; k++) {
      const r = simulate({ formation, play: 'flood', front: front.id, coverage, pressure, flip: k % 2 === 1 }, seed++);
      n++; y += r.result.yards;
      if (r.events.find(e => e.kind === 'throw')?.route === 'sail') { sail++; if (r.result.kind === 'catch') caught++; }
    }
    return { y: y / n, sail: caught / sail };
  };
  for (const formation of ['ace', 'pistol']) {
    const c1 = run(formation, 'c1'), c2 = run(formation, 'c2'), c3 = run(formation, 'c3');
    assert.ok(c3.y > c1.y && c3.y > c2.y, `${formation}: ${c3.y.toFixed(1)} yards a dropback against Cover 3, ${c1.y.toFixed(1)} against Cover 1, ${c2.y.toFixed(1)} against Cover 2`);
    assert.ok(c3.sail > 0.5, `${formation}: ${(100 * c3.sail).toFixed(0)}% of the throws to the sail caught against Cover 3`);
  }
});

test('the drawn-up play numbers the quarterback\'s reads on their routes, in the order his card lists them, and only on a pass', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const P = simulate({ formation: fm.id, play: pl.id, front: 'over', coverage: 'c1', pressure, flip: pressure === 'blitz' }, 11);
    const numbered = P.overlay.filter(o => o.read !== undefined);
    if (pl.type === 'run') { assert.equal(numbered.length, 0, `${fm.id} ${pl.id}: a run has read numbers`); continue; }
    assert.ok(numbered.every(o => o.kind === 'route'), `${fm.id} ${pl.id}: a read number on something that isn't a route`);
    const order = numbered.sort((a, b) => a.read - b.read).map(o => `${o.read}. ${P.players[o.i].label}`);
    const qb = P.players.find(p => p.cls === 'qb');
    const card = P.jobs[qb.i].match(/His reads: (.+)\.$/)?.[1].split(', ').map(r => r.replace(/ \(.+\)$/, ''));
    assert.ok(numbered.length > 0, `${fm.id} ${pl.id}: no reads numbered`);
    assert.deepEqual(order, card, `${fm.id} ${pl.id} ${pressure}: the numbers on the routes aren't the reads in the quarterback's card`);
  }
});

test('the Cover 2 corner stays in the flat: he lets a slant go inside and widens with the man coming out into it', () => {
  // Slant-Flat against Cover 2, 96 looks: a moment after the throw (0.3 s), the corner is outside the slant on his side
  // in 80% of them. When he followed the slant inside, leaving the flat route to run, it was 6%.
  let seed = 1, n = 0, outside = 0;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: 'slants', front: fr.id, coverage: 'c2', pressure, flip };
    const r = simulate(call, seed), S = prepare(call, seed); seed++;
    const at = r.frames.findIndex(f => f.air);
    if (at < 0) continue;
    const f = r.frames[Math.min(at + 6, r.frames.length - 1)];
    for (const cb of S.CB) {
      const sd = Math.sign(cb.x), slant = S.O.find(p => p.job.route === 'slant' && Math.sign(p.x) === sd);
      if (!slant || !S.O.some(p => p.job.route === 'flat' && Math.sign(p.x) === sd)) continue;
      n++;
      if (f.xy[2 * cb.i] * sd > f.xy[2 * slant.i] * sd) outside++;
    }
  }
  assert.ok(n > 60 && outside / n > 0.5, `the corner is outside the slant 0.3 s after the throw on ${outside} of ${n} looks`);
});

test('against a quick drop, a deep corner stops backing up once the quarterback has set up', () => {
  // Slant-Flat against Cover 3 and Cover 4, 64 looks each: from the moment the quarterback is set to when the ball gets
  // there, the corners in the deep zones back up 0.7 (Cover 3) and 0.2 yards (Cover 4) on average. When they kept
  // backpedaling until the ball was in the air, 3.7 and 2.3, and the slant ran on under them.
  let seed = 1;
  for (const coverage of ['c3', 'c4']) {
    let n = 0, back = 0;
    for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
      const call = { formation: fm.id, play: 'slants', front: fr.id, coverage, pressure, flip };
      const r = simulate(call, seed), S = prepare(call, seed); seed++;
      const thrown = r.frames.findIndex(f => f.air), there = r.frames.findIndex((f, k) => k > thrown && !f.air), set = r.frames.findIndex(f => f.t >= S.readAt + 0.1);
      if (thrown < 0) continue;
      for (const cb of S.CB) { n++; back += r.frames[there].xy[2 * cb.i + 1] - r.frames[set].xy[2 * cb.i + 1]; }
    }
    assert.ok(back / n < 1.5, `${coverage}: the deep corners back up ${(back / n).toFixed(1)} yards after the quarterback sets`);
  }
});

test('a Cover 2 safety keeps to the middle of his half until the throw, rather than running with Smash\'s corner route', () => {
  // Smash against Cover 2, 64 looks: in every frame before the throw with a corner route past 12 yards and 3 or more
  // yards outside his safety's spot, the safety has moved out 0.14 of a yard for each yard the route has. When he ran
  // with the route, 0.41.
  let seed = 1, num = 0, den = 0;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: 'smash', front: fr.id, coverage: 'c2', pressure, flip };
    const r = simulate(call, seed), S = prepare(call, seed); seed++;
    for (const two of [S.keys.S2, S.keys.W2].filter(p => p && p.job.route === 'corner')) {
      const safety = S.D.find(d => d.job.kind === 'zone' && d.job.z.deep && Math.sign(d.job.z.at[0]) === Math.sign(two.x)), spot = Math.abs(safety.job.z.at[0]);
      for (const f of r.frames) {
        if (f.air || f.t >= r.result.t) break;
        const out = Math.abs(f.xy[2 * two.i]) - spot;
        if (f.xy[2 * two.i + 1] < 12 || out < 3) continue;
        num += (Math.abs(f.xy[2 * safety.i]) - spot) * out; den += out * out;
      }
    }
  }
  assert.ok(den > 0 && num / den < 0.25, `the safety moves out ${(num / den).toFixed(2)} of a yard for each yard the corner route gets outside his spot`);
});

test('the quarterback passes over a first read covered by a deep defender', () => {
  // Mesh's first read is the corner route, into the deep third the Cover 3 corner is guarding. Over 128 looks he now
  // throws it on about one throw in four; when he rated a deep defender at nine-tenths of the speed the man runs at
  // the ball, four in five, and more than half of those were broken up or intercepted.
  let seed = 1, throws = 0, corner = 0;
  for (let k = 0; k < 2; k++) for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const call = { formation: fm.id, play: 'mesh', front: fr.id, coverage: 'c3', pressure, flip };
    const r = simulate(call, seed), S = prepare(call, seed); seed++;
    const t = r.events.find(e => e.kind === 'throw');
    if (!t) continue;
    throws++;
    if (t.who === S.reads[0].i) corner++;
  }
  assert.ok(throws > 80 && corner / throws < 0.4, `Mesh against Cover 3 throws to its first read, the corner route, on ${corner} of ${throws} throws`);
});

test('a draw against zone coverage is stopped short some of the time: pass rushers read it on the way by', () => {
  // 384 draws against Cover 2, 3 and 4. When no rusher came off his block for the back, 85% gained 4 yards or more
  // (the NFL's 2023 designed runs: 43%, nflverse play-by-play); now 73%.
  let seed = 1, n = 0, won = 0;
  for (const coverage of ['c2', 'c3', 'c4']) for (let k = 0; k < 2; k++) for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'draw'))) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const r = simulate({ formation: fm.id, play: 'draw', front: fr.id, coverage, pressure, flip }, seed++).result;
    n++; if (Math.round(r.yards) >= 4) won++;
  }
  assert.ok(won / n < 0.78, `${won} of ${n} draws against zone coverage gained 4 yards or more`);
});

test('with a rusher closing in and nobody open, the quarterback throws it away, toward a receiver', () => {
  // Smash from Singleback against Cover 2 rushing four: the tight ends' corner routes rarely come open and the back's
  // check-down is the last read, so a rusher often gets there first. 128 dropbacks: 19 sacks now; 52 when he threw it
  // away only once a rusher had hold of him.
  let seed = 1, sacks = 0;
  for (let k = 0; k < 32; k++) for (const fr of FRONTS) if (simulate({ formation: 'single', play: 'smash', front: fr.id, coverage: 'c2', pressure: 'four', flip: k % 2 === 1 }, seed++).result.kind === 'sack') sacks++;
  assert.ok(sacks < 128 / 3, `Smash from Singleback against Cover 2: sacked on ${sacks} of 128 dropbacks`);
  // A throwaway from the pocket goes in the direction and vicinity of a receiver (NFL rule 8-2-1, intentional
  // grounding): over 1,280 dropbacks every one comes down within 8 yards of one. Thrown 3 yards out of bounds at the
  // quarterback's sideline, as they were, most came down 10 to 30 yards from anybody.
  seed = 1;
  let n = 0;
  for (let k = 0; k < 2; k++) for (const fm of FORMATIONS) for (const play of ['verts', 'smash', 'mesh', 'pa']) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, play)) continue;
    const r = simulate({ formation: fm.id, play, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 }, seed++);
    if (r.result.kind !== 'throwaway') continue;
    n++;
    const f = r.frames.filter(f => f.air).at(-1);
    const near = Math.min(...r.players.filter(p => p.team === 'O' && p.cls !== 'qb' && p.cls !== 'ol').map(p => Math.hypot(f.xy[2 * p.i] - f.ball[0], f.xy[2 * p.i + 1] - f.ball[1])));
    assert.ok(near < 8.5, `${JSON.stringify(r.call)} seed ${seed - 1}: thrown away ${near.toFixed(1)} yards from the nearest receiver`);
  }
  assert.ok(n >= 5, `${n} throwaways`);
});

test('with a blitzer coming unblocked the quarterback throws hot, before he gets there', () => {
  // Every pass play but the screen against Cover 0 (everyone rushes who isn't in man coverage), 48 dropbacks from each
  // formation: more than half are hot throws now, every one out within 2.75 seconds and naming a rusher nobody blocked.
  // (Now and then one comes later: over 3,840 such dropbacks from seed 60000, seven came at 2.5 seconds or later, the
  // latest at 2.8, Four Verticals from Singleback against the Nickel front at seed 60991, as it did before the Pistol,
  // Gun Ace and Empty.) Since he waits for the free rusher to get within HOT_AT, 4 yards, rather than 8 (version 5: see
  // js/sim.js), 165 of these 384 are hot throws, from 262, with the rusher 3.8 yards from him at most when he lets it go
  // (257 of the 262 had him 4 1/2 yards off or more), the latest at 2.7 seconds.
  let seed = 1, n = 0, hotN = 0;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass' && p.drop !== 'screen')) for (const fr of FRONTS) for (const flip of [false, true]) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const r = simulate({ formation: fm.id, play: pl.id, front: fr.id, coverage: 'c0', pressure: 'blitz', flip }, seed++);
    n++;
    const t = r.events.find(e => e.kind === 'throw' && /, hot, with /.test(e.text));
    if (!t) continue;
    hotN++;
    assert.ok(t.t < 2.75, `${pl.id} seed ${seed - 1}: a hot throw at ${t.t} s`);
    const S = prepare(r.call, seed - 1), b = S.D.find(d => t.text.includes(`with ${name(S, d)} coming unblocked`));
    assert.ok(b && !r.frames.some(f => f.t <= t.t && f.eng[b.i] >= 0), `${pl.id} seed ${seed - 1}: "${t.text}" names a man nobody blocked`);
    const f = r.frames.find(f => f.t >= t.t - 1e-9), d = Math.hypot(f.xy[2 * b.i] - f.xy[2 * S.QB.i], f.xy[2 * b.i + 1] - f.xy[2 * S.QB.i + 1]);
    assert.ok(d < 4, `${pl.id} seed ${seed - 1}: thrown hot with the ${b.label} ${d.toFixed(1)} yards from the quarterback`);
  }
  assert.ok(hotN / n > 0.3 && hotN / n < 0.55, `${hotN} hot throws in ${n} dropbacks against Cover 0`);
});

test('Cover 0 looks like Cover 0: the extra blitzer walks up over his gap, and nobody stands deep', () => {
  // The man left over after the man-to-man matchups used to stand 7.8 yards deep in the middle, where a quarterback
  // counting safeties would take him for one.
  for (const fm of FORMATIONS) for (const pl of PLAYS) for (const fr of FRONTS) for (const flip of [false, true]) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const S = prepare({ formation: fm.id, play: pl.id, front: fr.id, coverage: 'c0', pressure: 'blitz', flip }, 7);
    const what = `${fm.id} ${pl.id} ${fr.id}${flip ? ' flipped' : ''}`;
    for (const d of S.D) assert.ok(d.y0 <= 6, `${what}: the ${d.label} stands ${d.y0.toFixed(1)} yards deep`);
    const extra = S.D.filter(d => d.extra);
    assert.equal(extra.length, 1, `${what}: one extra blitzer`);
    for (const d of extra) assert.ok(d.y0 <= 5 && Math.abs(d.x0 - d.job.gap) < 1.3, `${what}: the ${d.label} lines up at ${d.x0.toFixed(1)}, ${d.y0.toFixed(1)}, rushing the gap at ${d.job.gap}`);
  }
});

test('on a run in man coverage the man on the back runs with him to the line, rather than chasing him from behind', () => {
  // Outside Zone from Singleback against Cover 0 gained 30-32 yards a carry, half of them 20 or more: the back's man
  // chased him into the backfield, and when the back turned up outside the tight end he was a yard or two behind him
  // and never caught up (in 70-78 of about 110 runs that got to the line). From six start seeds, 120 snaps each, it now
  // gains 10-14 yards a carry, and the man is never behind the back when he gets to the line.
  let seed = 1, y = 0, n = 0, behind = 0, holes = 0;
  for (const fr of FRONTS) for (let k = 0; k < 30; k++) {
    const call = { formation: 'single', play: 'oz', front: fr.id, coverage: 'c0', pressure: 'blitz', flip: k % 2 === 1 };
    const S = prepare(call, seed), r = simulate(call, seed++);
    n++; y += r.result.yards;
    const hole = r.events.find(e => e.kind === 'hole'), man = S.D.find(d => d.job.kind === 'man' && d.job.r === S.RB);
    if (!hole || !man) continue;
    holes++;
    const f = r.frames.find(f => f.t >= hole.t - 1e-9);
    if (f.xy[2 * man.i + 1] < f.xy[2 * f.c + 1] - 1) behind++;
  }
  assert.ok(behind <= holes / 10, `the man on the back was a yard or more behind him when he got to the line in ${behind} of ${holes} runs`);
  assert.ok(y / n < 20, `Outside Zone from Singleback against Cover 0: ${(y / n).toFixed(1)} yards a carry over ${n} snaps`);
});

test('NFL timing: on five-step and play-action drops he starts reading later, and only once a route is out of its break', () => {
  // A read throw (his first read, read 2 and on, or the best left after them) on a five-step drop comes out no sooner
  // than 1.55 s from the shotgun or 1.95 s under center (2.0 and 2.35 s after a play-action fake), half a second later
  // than before; and a route that breaks is a yard out of its break when he lets it go. The quick game and the screen
  // keep their timing: Slant-Flat's average throw is still out in about a second. (So does a look first to the route
  // nearest the line, with only three out and as many rushing as he has blockers: see the next test.)
  let seed = 1, quick = 0, quickN = 0;
  const READ = /, (his first read|read \d|after nothing else came open)/;
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass')) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const call = { formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 };
    const r = simulate(call, seed), S = prepare(call, seed); seed++;
    const t = r.events.find(e => e.kind === 'throw');
    if (!t) continue;
    if (pl.drop === 'quick') { quick += t.t; quickN++; }
    if ((pl.drop !== 'five' && pl.drop !== 'pa') || !READ.test(t.text)) continue;
    const first = { five: fm.under ? 1.95 : 1.55, pa: fm.under ? 2.35 : 2.0 }[pl.drop];
    assert.ok(t.t >= first - 1e-9, `${JSON.stringify(call)} seed ${seed - 1}: "${t.text}" at ${t.t} s`);
    const rcv = S.P[t.who], route = ROUTES[rcv.job.route];
    if (route.readyY || /after nothing else/.test(t.text)) continue;
    // How far along the line out of the break he is when the ball's thrown; on a route that stops, that he has.
    const k = route.ready ?? 1, a = rcv.path[k - 1], b = rcv.path[k], at = r.frames.findIndex(f => f.t >= t.t - 1e-9), f = r.frames[at];
    if (route.settle) {
      const vy = (f.xy[2 * rcv.i + 1] - r.frames[at - 1].xy[2 * rcv.i + 1]) / 0.05;
      assert.ok(vy < 1, `${JSON.stringify(call)} seed ${seed - 1}: thrown to the ${rcv.label}'s ${rcv.job.route} while he's still running up the field (${vy.toFixed(1)} yards a second)`);
      continue;
    }
    if (!b) continue;
    const L = Math.hypot(b.x - a.x, b.y - a.y), past = ((f.xy[2 * rcv.i] - a.x) * (b.x - a.x) + (f.xy[2 * rcv.i + 1] - a.y) * (b.y - a.y)) / L;
    assert.ok(past > Math.min(0.9, 0.7 * L), `${JSON.stringify(call)} seed ${seed - 1}: thrown to the ${rcv.label}'s ${rcv.job.route} ${past.toFixed(2)} yards out of his break`);
  }
  assert.ok(quick / quickN < 1.1, `Slant-Flat's throws come out at ${(quick / quickN).toFixed(2)} s on average`);
});

test('three out against as many rushers as blockers: on the Play-Action Shot from I-Form he looks to the tight end in the flat first, at once', () => {
  // From I-Form both backs stay in on the Play-Action Shot, so only three go out, and against a Cover 1 blitz the men on
  // the backs come too: seven rushing against seven blockers. Reading the post, the deep crosser and the flat, in that
  // order, from 2.35 s, he was sacked on 20% of 300 snaps (three seed sets, every front) and threw it away on 25%, 4.1
  // yards a play, with the flat, open by about 8 yards at 2.35 s, thrown on two. Now, once the fake is over and he sees
  // as many coming as he has blockers, he looks first to the route nearest the line, at once: on those 300 snaps, sacked
  // on 6% (6, 5 and 7% in the three sets), the flat thrown on three in four at a median 1.55 s, 76% of throws caught,
  // 6.6 yards a play. Every other formation sends four out on it, and no other play has the rule.
  const card = 'With only three out, if they rush as many as he has blockers, he looks first to the Y (flat), at once.';
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass')) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no fake, no screen)
    const S = prepare({ formation: fm.id, play: pl.id, front: 'over', coverage: 'c1', pressure: 'blitz' }, 1), mine = fm.id === 'iform' && pl.id === 'pa';
    assert.equal(S.sightRead?.label, mine ? 'Y' : undefined, `${fm.id} ${pl.id}: the route he looks to first with as many rushing as he has blockers`);
    assert.equal(S.jobText[S.QB.i].includes(card), mine, `${fm.id} ${pl.id}: the quarterback's card`);
  }
  // A man kept in to block makes it three: from Singleback with the Y kept in, the U's flat.
  assert.equal(prepare({ formation: 'single', play: 'pa', front: 'over', coverage: 'c0', pressure: 'blitz', hot: { Y: 'block' } }, 1).sightRead?.label, 'U');
  let seed = 9100, n = 0, sacks = 0, first = 0;
  for (const fr of FRONTS) for (let k = 0; k < 30; k++) {
    const r = simulate({ formation: 'iform', play: 'pa', front: fr.id, coverage: 'c1', pressure: 'blitz', flip: k % 2 === 1 }, seed++);
    n++;
    if (r.result.kind === 'sack') sacks++;
    const t = r.events.find(e => e.kind === 'throw');
    if (t?.how !== 'sight' || t.who !== t.first) continue;
    first++;
    assert.match(t.text, /^The quarterback throws to the tight end \(Y\) on a flat route, at once, with (seven|eight) rushing against seven blockers\.$/);
    assert.ok(t.t < 2.35, `thrown at ${t.t} s, when he'd only have started reading`);
  }
  assert.ok(sacks / n <= 0.12, `sacked on ${sacks} of ${n} snaps`);
  assert.ok(first / n > 0.6, `the flat, first and at once, on ${first} of ${n} snaps`);
  // Rushing four, fewer than his seven blockers, he reads as drawn.
  for (let k = 0; k < 24; k++) {
    const r = simulate({ formation: 'iform', play: 'pa', front: FRONTS[k % 4].id, coverage: k % 2 ? 'c1' : 'c3', pressure: 'four', flip: k % 2 === 1 }, seed++);
    assert.ok(!r.events.some(e => e.how === 'sight'), `rushing four, seed ${seed - 1}`);
  }
  // The coach's read picks it from I-Form against those looks, and says why: nobody deep, or one deep with the corners
  // pressed, where the men covering the backs join the rush once the backs stay in to block (rushing four as well: see
  // cover() in js/sim.js), so a blitz brings as many as he has blockers. (It said "If they blitz, the men on your backs
  // come too", as if they came only on a blitz.)
  for (const code of ['over.c0.blitz.M.0', 'over.c1.blitz.M.0', '34.c1.blitz.M.0']) {
    const R = coachRead(viewOf({ formation: 'iform', play: 'smash', flip: false }, code, '1and10')), pa = R.picks.find(p => p.set.play === 'pa');
    assert.ok(pa, `from I-Form against ${code}, no Play-Action Shot in the picks: ${R.picks.map(p => p.label)}`);
    assert.match(pa.reason, /the quarterback looks first to the Y on the flat, at once/, code);
    if (code.includes('.c1.')) assert.match(pa.reason, /The men covering your backs join the rush once the backs stay in to block, so a blitz brings as many as you have blockers/, code);
  }
});

test('a choice of blitzer: the Mike, the Will, the nickel back or the strong safety, each where he can be', () => {
  const extra = S => S.D.filter(d => d.job.kind === 'rush' && d.blitzer).map(d => d.label);
  for (const flip of [false, true]) {
    const base = { formation: 'trips', play: 'smash', front: 'nickel', coverage: 'c3', pressure: 'blitz', flip };
    assert.deepEqual(extra(prepare(base, 5)), ['M'], 'the Mike unless another is picked');
    for (const who of ['M', 'W', 'NB', 'SS']) assert.deepEqual(extra(prepare({ ...base, blitzer: who }, 5)), [who], `${who} blitzes`);
    const nb = prepare({ ...base, blitzer: 'NB' }, 5);
    assert.ok(Math.abs(nb.NB.job.gap) >= 6, `the nickel back comes off the edge, at ${nb.NB.job.gap}`);
    // Where he can't be the one, it's the Mike: no nickel back outside the Nickel front, no safety where both play
    // deep or from a disguise that lines him up deep.
    assert.deepEqual(extra(prepare({ ...base, front: 'over', blitzer: 'NB' }, 5)), ['M']);
    for (const coverage of ['c2', 'c4']) assert.deepEqual(extra(prepare({ ...base, coverage, blitzer: 'SS' }, 5)), ['M'], coverage);
    assert.deepEqual(extra(prepare({ ...base, disguise: true, blitzer: 'SS' }, 5)), ['M'], 'disguised');
    assert.deepEqual(extra(prepare({ ...base, pressure: 'four', blitzer: 'W' }, 5)), [], 'rushing four, nobody extra');
    // Cover 0 sends everyone not covering a receiver, whoever is picked.
    assert.equal(JSON.stringify(simulate({ ...base, coverage: 'c0', blitzer: 'SS' }, 5).frames.at(-1).xy), JSON.stringify(simulate({ ...base, coverage: 'c0' }, 5).frames.at(-1).xy));
    // The coverage still adds up: Cover 3 with the safety coming has three deep, three underneath and five rushing.
    const ss = prepare({ ...base, blitzer: 'SS' }, 5);
    assert.deepEqual([ss.D.filter(d => d.job.z?.deep).length, ss.D.filter(d => d.job.kind === 'zone' && !d.job.z.deep).length, ss.D.filter(d => d.job.kind === 'rush').length], [3, 3, 5]);
    const r = simulate({ ...base, blitzer: 'NB' }, 5);
    assert.equal(r.events.find(e => e.kind === 'blitz').text, 'The nickel back blitzes.');
  }
  assert.equal(blitzerFor('over', 'c3', 'NB'), 'Only the Nickel front has a nickel back.');
  assert.equal(blitzerFor('nickel', 'c4', 'SS'), 'Cover 4 needs both safeties deep.');
  assert.equal(blitzerFor('nickel', 'c1', 'SS', true), 'Showing two deep, the safety is too far back to blitz.');
  for (const who of ['M', 'W']) for (const fr of FRONTS) for (const cv of COVERAGES) assert.equal(blitzerFor(fr.id, cv.id, who), '', `${who} ${fr.id} ${cv.id}`);
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

test('every coverage lines up its own way: the safeties deep and the corners\' depth always tell which it is', () => {
  // The page asks "What did they play?" after the snap (js/app.js, verdict()), and reads the look the way the corners'
  // and safeties' lines in the coach's note do: safeties past 10.5 yards, and the nearer corner pressed (under 2.5
  // yards), about 5 off (under 6) or 7 or more. Against every formation, front and pressure, each coverage has one look,
  // and no two share it, so the question can always be answered from the board.
  const looks = {};
  let seed = 3;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play: 'smash', front: fr.id, coverage: cv.id, pressure, flip }, seed++);
    const corner = Math.min(...S.D.filter(d => d.label === 'CB').map(d => d.y));
    (looks[cv.id] ||= new Set()).add(`${S.box.high} deep, corners ${corner < 2.5 ? 'pressed' : corner < 6 ? 'about 5 off' : '7 or more off'}`);
  }
  for (const [cv, seen] of Object.entries(looks)) assert.equal(seen.size, 1, `${cv} lines up more than one way: ${[...seen].join('; ')}`);
  const one = Object.values(looks).map(seen => [...seen][0]);
  assert.equal(new Set(one).size, COVERAGES.length, `two coverages look the same: ${one.join('; ')}`);
});

test('a disguise: Cover 1 or Cover 3 lines up like Cover 4, two deep and the corners off, and rotates at the snap', () => {
  // The look a disguised call shows is Cover 4's, against every formation, front, pressure and strong side: two safeties
  // deep and the corners 7 or more off (as the question after the snap reads it: see the test above). At the snap the
  // strong safety comes down and the free safety heads for the middle, and the play-by-play says so, naming the
  // coverage. Only Cover 1 and Cover 3 disguise; any other call with it lines up as it always does.
  const look = S => { const c = Math.min(...S.D.filter(d => d.label === 'CB').map(d => d.y)); return `${S.box.high} deep, corners ${c < 2.5 ? 'pressed' : c < 6 ? 'about 5 off' : '7 or more off'}`; };
  let seed = 41;
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const base = { formation: fm.id, play: 'smash', front: fr.id, pressure, flip };
    const c4 = look(prepare({ ...base, coverage: 'c4' }, seed));
    for (const coverage of ['c1', 'c3']) {
      const call = { ...base, coverage, disguise: true }, what = JSON.stringify(call);
      const S = prepare(call, seed);
      assert.equal(look(S), c4, `${what}: lines up like Cover 4`);
      assert.notEqual(look(prepare({ ...call, disguise: false }, seed)), c4, `${what}: without the disguise it doesn't`);
      const r = simulate(call, seed), at = t => r.frames.find(f => f.t >= t - 1e-9).xy, ss = S.SS.i, fs = S.FS.i;
      // In a zone he comes down to the spot he'd have lined up in; in man he comes down to play his man (but no farther
      // than his man lets him: one running deep keeps him deep).
      assert.ok(at(1)[2 * ss + 1] < S.SS.y - 1, `${what}: the strong safety comes down at the snap, from ${S.SS.y.toFixed(1)} to ${at(1)[2 * ss + 1].toFixed(1)} yards in a second`);
      if (S.SS.job.kind === 'zone') assert.ok(Math.hypot(at(1)[2 * ss] - S.SS.home.x, at(1)[2 * ss + 1] - S.SS.home.y) < 3, `${what}: the strong safety gets most of the way to his zone's spot in a second`);
      assert.ok(Math.abs(at(1)[2 * fs]) < Math.abs(S.FS.x) - 4, `${what}: the free safety heads for the middle, from ${S.FS.x.toFixed(1)} to ${at(1)[2 * fs].toFixed(1)} in a second`);
      const e = r.events.find(x => x.kind === 'rotate');
      assert.equal(e?.text, `The strong safety rotates down at the snap: ${COVERAGES.find(c => c.id === coverage).name}.`, what);
      assert.equal(e.who, ss, what);
      assert.ok(!simulate({ ...call, disguise: false }, seed).events.some(x => x.kind === 'rotate'), `${what}: no rotation without the disguise`);
    }
    for (const coverage of ['c0', 'c2', 'c4']) {
      const call = { ...base, coverage };
      assert.equal(JSON.stringify(simulate({ ...call, disguise: true }, seed).frames.at(-1).xy), JSON.stringify(simulate(call, seed).frames.at(-1).xy), `${JSON.stringify(call)}: only Cover 1 and Cover 3 disguise`);
    }
    seed++;
  }
});

test('motion: the board plays the time before the snap, and every call with it runs to a finish', () => {
  // Every formation, play and coverage, across and jet, a front and a pressure taking turns: the same checks as for a
  // play without motion, and the frames before the snap come first, a twentieth of a second apart up to the snap, with
  // nobody jumping. A play without motion starts at the snap.
  let seed = 61;
  for (const fm of FORMATIONS.filter(f => f.motion)) for (const pl of PLAYS) for (const cv of COVERAGES) for (const motion of ['across', 'jet']) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const call = { formation: fm.id, play: pl.id, front: FRONTS[seed % 4].id, coverage: cv.id, pressure: seed % 3 ? 'four' : 'blitz', flip: seed % 2 === 0, motion };
    const r = simulate(call, seed++), what = `${JSON.stringify(call)} seed ${seed - 1}`, F = r.frames;
    assert.ok(KINDS.has(r.result.kind), `${what}: result ${r.result.kind}`);
    assert.ok(ended(r) && ENDINGS.has(r.events.at(-1).kind), `${what}: the play-by-play doesn't end with the end of the play`);
    for (let k = 1; k < r.events.length; k++) assert.ok(r.events[k].t >= r.events[k - 1].t, `${what}: the play-by-play goes back in time at "${r.events[k].text}"`);
    assert.ok(F[0].t < (motion === 'jet' ? -1 : -2.5), `${what}: the motion takes ${-F[0].t} s`);
    assert.equal(r.motion.t0, F[0].t, what);
    for (let k = 1; k < F.length; k++) {
      assert.ok(Math.abs(F[k].t - F[k - 1].t - 0.05) < 1e-6, `${what}: frames ${F[k - 1].t} and ${F[k].t}`);
      if (F[k].t > 0) break;
      for (let i = 0; i < 22; i++) {
        assert.ok(Number.isFinite(F[k].xy[2 * i]) && Number.isFinite(F[k].xy[2 * i + 1]), `${what}: a position went bad`);
        assert.ok(Math.hypot(F[k].xy[2 * i] - F[k - 1].xy[2 * i], F[k].xy[2 * i + 1] - F[k - 1].xy[2 * i + 1]) < 0.75, `${what}: ${r.players[i].label} jumps before the snap at ${F[k].t}`);
      }
    }
    assert.ok(F.some(f => f.t === 0), `${what}: no frame at the snap`);
    assert.equal(r.events[0].kind, 'motion', what);
    assert.equal(simulate({ ...call, motion: 'none' }, seed - 1).frames[0].t, 0, `${what}: without motion it starts at the snap`);
  }
});

test('motion: he runs across and is counted on his new side; in man coverage his man runs with him, in zone they slide', () => {
  // Across: he starts where the formation has him and is set on the other side at the snap, at the spot the playbook
  // gives him, counted there (Gun Trips becomes two and two, Gun Doubles and the Pistol three and one, and from I-Form
  // and Singleback his side has more receivers than the tight end's, so the pass plays go his way). Jet: at the snap he's at the
  // middle, at full speed. In man coverage the man who had him before the motion has him at the snap, on his side of
  // the field; in zone nobody does, and nobody crosses to the other side of the field to follow him.
  // (From I-Form and Singleback the Z leaves more receivers on the other side, and the pass plays go that way.)
  const key = { trips: 'W2', doubles: 'S3', iform: 'S2', single: 'S2', pistol: 'S2' };
  let seed = 81;
  for (const fm of FORMATIONS.filter(f => f.motion)) for (const flip of [false, true]) for (const coverage of ['c1', 'c3', 'c0', 'c2']) for (const motion of ['across', 'jet']) {
    const call = { formation: fm.id, play: 'smash', front: 'nickel', coverage, pressure: 'four', flip, motion }, what = JSON.stringify(call);
    const S = prepare(call, seed), r = simulate(call, seed), was = prepare({ ...call, motion: 'none' }, seed);
    seed++;
    const who = S.O.find(p => p.label === fm.motion.who), f = flip ? -1 : 1, at = (fr, i) => ({ x: fr.xy[2 * i], y: fr.xy[2 * i + 1] });
    const snap = r.frames.find(x => x.t === 0), before = r.frames[r.frames.findIndex(x => x.t === 0) - 1];
    assert.equal(r.motion.who, who.i, what);
    assert.deepEqual(at(r.frames[0], who.i), { x: Math.fround(was.P[who.i].x), y: Math.fround(was.P[who.i].y) }, `${what}: he starts where the formation has him`);
    assert.equal(who.key, key[fm.id], `${what}: counted as ${who.key}`);
    if (motion === 'across') {
      assert.ok(Math.abs(at(snap, who.i).x - fm.motion.to * f) < 1e-3 && Math.hypot(at(snap, who.i).x - at(before, who.i).x, at(snap, who.i).y - at(before, who.i).y) < 1e-3, `${what}: set on the other side at the snap`);
      assert.match(r.events.find(e => e.text.startsWith('He sets'))?.text ?? '', fm.id === 'trips' ? /two receivers each side now/ : fm.id === 'doubles' || fm.id === 'pistol' ? /three receivers on his side now, one on the other/ : /two receivers on his side now, one on the other|three receivers on his side now, one on the other/, what);
    } else {
      assert.ok(Math.abs(at(snap, who.i).x) < 1, `${what}: at the snap the jet man is at the middle, at ${at(snap, who.i).x.toFixed(1)}`);
      assert.ok(Math.hypot(at(snap, who.i).x - at(before, who.i).x, at(snap, who.i).y - at(before, who.i).y) / 0.05 > 7, `${what}: still running at full speed at the snap`);
    }
    const line = r.events.find(e => e.kind === 'motion' && /follows|runs with him/.test(e.text));
    if (coverage === 'c0' || coverage === 'c1') {
      const had = was.D.find(d => d.job.kind === 'man' && d.job.r.i === who.i);
      assert.equal(r.motion.man, had.i, `${what}: the man who had him before the motion has him at the snap`);
      assert.ok(Math.sign(at(snap, had.i).x) === Math.sign(fm.motion.to * f) || Math.abs(at(snap, had.i).x) < 6, `${what}: his man ran with him`);
      assert.ok(Math.hypot(at(snap, had.i).x - at(r.frames[0], had.i).x) > 4, `${what}: his man ran with him`);
      assert.match(line.text, /runs with him: man coverage\.$/, what);
      // He's never down on the line, and he crosses the formation behind the linebackers (who line up 4.2 to 4.8 yards
      // deep): 6 yards deep, or at his own depth if that's deeper, and still 5 1/2 between the tackles as he comes back
      // up on the far side, not over the top of the linemen and through the linebackers. Across, he's set on him at the
      // snap.
      for (const fr of r.frames.filter(x => x.t <= 0)) {
        const y = at(fr, had.i).y;
        assert.ok(y > 1.5, `${what}: his man is down on the line at ${fr.t}`);
        if (Math.abs(at(fr, had.i).x) < 3) assert.ok(y >= Math.max(5.5, Math.min(was.P[had.i].y, S.P[had.i].y) - 0.1), `${what}: his man crosses ${y.toFixed(1)} yards deep at ${fr.t}`);
      }
      if (motion === 'across') assert.ok(Math.hypot(at(snap, had.i).x - at(before, had.i).x, at(snap, had.i).y - at(before, had.i).y) < 1e-3, `${what}: his man isn't set on him at the snap`);
    } else {
      assert.equal(r.motion.man, -1, what);
      for (const d of S.D) assert.ok(at(r.frames[0], d.i).x * at(snap, d.i).x > -2, `${what}: the ${d.label} crossed the field after him in a zone`);
      assert.equal(line.text, 'Nobody follows him: zone.', what);
    }
  }
});

test('the bump: when a cornerback goes across with the man in motion, the strong safety takes his place, or the man on the tight end does, and Outside Zone that way does about what it does without the motion, or a few yards more against Cover 0', () => {
  // From I-Form and Singleback the Z goes in motion from the tight end's side, and in man coverage the cornerback on
  // him goes too. The strong safety slides over to the side they left, outside the tight end, at the snap (ahead of a
  // jet as well), and the play-by-play says so. In a zone the corner stays, and from the formations whose H goes in
  // motion it's never a cornerback who has him: no bump. When the strong safety can't, because he's blitzing or his
  // own man is someone else, the back or the other tight end (he stays where he can cover him), the man covering that
  // tight end bumps instead in Cover 1, the nickel back or the Sam, from outside him. (Against the Nickel front with a
  // blitz the strong safety can have the back, or with the Will blitzing the far tight end.) Not in Cover 0, where the
  // runs that way didn't break long without him, and Inside Zone from I-Form against the Nickel front went from 3.9
  // yards a carry to 17.8 with the nickel back out there.
  let seed = 400, bumps = 0, stays = 0, others = new Set();
  for (const fm of FORMATIONS.filter(f => f.motion)) for (const coverage of ['c0', 'c1', 'c3']) for (const motion of ['across', 'jet']) for (const flip of [false, true]) for (const fr of FRONTS) {
    const call = { formation: fm.id, play: seed % 2 ? 'oz' : 'smash', front: fr.id, coverage, pressure: seed % 3 ? 'four' : 'blitz', blitzer: seed % 5 < 2 ? 'W' : seed % 5 === 2 && coverage !== 'c0' ? 'SS' : 'M', flip, motion }, what = JSON.stringify(call);
    const S = prepare(call, seed), r = simulate(call, seed++), was = prepare({ ...call, motion: 'none' }, seed - 1);
    const mover = was.O.find(p => p.label === fm.motion.who), sd = Math.sign(mover.x), te = S.te(sd);
    const snap = r.frames.find(f => f.t === 0), x = snap.xy[2 * S.SS.i], j = S.SS.job;
    const line = r.events.find(e => e.kind === 'motion' && /the bump\.$/.test(e.text));
    const gone = fm.motion.who === 'Z' && coverage !== 'c3', free = j.kind !== 'rush' && (j.kind !== 'man' || j.r === te);
    // (In Cover 0 nobody bumps in his place: see below.)
    const onTe = S.D.find(d => d.job.kind === 'man' && d.job.r === te);
    if (gone && free) {
      bumps++;
      assert.ok(Math.sign(x) === sd && Math.abs(x) >= Math.abs(te.x) + 1.5, `${what}: the strong safety is at ${x.toFixed(1)} at the snap, the tight end at ${te.x.toFixed(1)}`);
      assert.equal(line?.who, S.SS.i, `${what}: the play-by-play says the strong safety slides over`);
      assert.match(line.text, /^The strong safety slides over to the side the cornerback left/, what);
      assert.match(S.jobText[S.SS.i], /the bump/, what);
    } else if (gone && coverage === 'c1') {
      // The man on the tight end, outside him at the snap, and named.
      const b = S.D.find(d => d.bump), bx = snap.xy[2 * onTe.i];
      assert.equal(b, onTe, `${what}: the strong safety can't, so the ${onTe.label}, on the tight end, bumps`);
      others.add(`${b.label} ${j.kind === 'rush' ? 'SS blitzing' : 'SS on ' + j.r.label}`);
      assert.ok(Math.sign(bx) === sd && Math.abs(bx) > Math.abs(te.x) + 1, `${what}: the ${b.label} is at ${bx.toFixed(1)} at the snap, the tight end at ${te.x.toFixed(1)}`);
      assert.equal(line?.who, b.i, `${what}: the play-by-play says who slides over`);
      assert.match(line.text, /^The (nickel back|Sam) slides outside the tight end, to keep a run inside on the side the cornerback left: the bump\.$/, what);
      assert.match(S.jobText[b.i], /slides outside the tight end, keeping a run inside on the strong side: the bump, since the strong safety (is blitzing|has the running back|has the tight end \(U\))\./, what);
      // One whose man is the back or the far tight end lines up within reach of him, not out wide on the other side.
      if (j.kind === 'man') { stays++; assert.ok(Math.abs(x - j.r.x) < 6, `${what}: the strong safety has the ${j.r.label} but is at ${x.toFixed(1)} at the snap, ${Math.abs(x - j.r.x).toFixed(1)} yards from him`); }
    } else {
      assert.ok(!line && !S.D.some(d => d.bump), `${what}: a bump with no cornerback gone, or in Cover 0 by someone other than the strong safety`);
      if (gone && j.kind === 'man') { stays++; assert.ok(Math.abs(x - j.r.x) < 6, `${what}: the strong safety has the ${j.r.label} but is at ${x.toFixed(1)} at the snap, ${Math.abs(x - j.r.x).toFixed(1)} yards from him`); }
    }
  }
  assert.ok(bumps >= 16 && stays >= 4, `${bumps} bumps and ${stays} safeties staying with a man elsewhere: the test should see both`);
  assert.deepEqual([...others].map(o => o.split(' ')[0]).sort().filter((o, k, a) => a.indexOf(o) === k), ['NB', 'S'], `the nickel back and the Sam both bump: ${[...others].join(', ')}`);
  // Outside Zone, every front and pressure: from I-Form and Singleback against Cover 1 and Cover 0, the Z going across
  // first now gains within 4 yards a carry of what it gains without him going. (Before the bump it was 11 to 14 yards
  // more, and 5 more from Singleback against Cover 0: with the corner gone, nobody was left out there and about one run
  // in five went the distance. Over 1,152 snaps a cell from three start seeds (1234, 50000, 900000) it comes within
  // 0.1-3.0 yards, and 0.8-3.3 since a back past the line is run down from behind more often, which takes more off the
  // runs without the motion; the most from Singleback against Cover 0.) Against Cover 0, where a run that gets through
  // can go the distance, 160 snaps were too few to tell: from four start seeds (this one, 50000, 900000, 2000000) the Z
  // going across first added 3.0-5.3 yards a carry from I-Form; at 400 snaps, 2.4-2.9. With the back's lean, the
  // linebackers' guesses and run blocks won and lost early more often (version 4), it adds 3.4-4.9 from I-Form (over
  // 1,200 snaps from two more start seeds, 4.2 and 4.8, from 1.6 and 3.7), and from Singleback -0.4-3.8 (from
  // -0.1-3.7): a few yards more against Cover 0 from I-Form, with nobody holding the edge in the cornerback's place.
  seed = 1234;
  for (const [formation, coverage, k, most] of [['iform', 'c1', 20, 4], ['single', 'c1', 20, 4], ['iform', 'c0', 100, 6], ['single', 'c0', 100, 4]]) {
    const ypc = {};
    for (const motion of ['none', 'across']) {
      let y = 0, n = 0, s = seed;
      for (const fr of FRONTS) for (const pressure of coverage === 'c0' ? ['blitz'] : ['four', 'blitz']) for (let i = 0; i < k; i++) {
        y += simulate({ formation, play: 'oz', front: fr.id, coverage, pressure, flip: i % 2 === 1, motion }, s++).result.yards; n++;
      }
      ypc[motion] = y / n;
    }
    seed += 1000;
    assert.ok(Math.abs(ypc.across - ypc.none) < most, `Outside Zone from ${formation} against Cover ${coverage[1]}: ${ypc.none.toFixed(1)} yards a carry, ${ypc.across.toFixed(1)} with the Z going across first`);
  }
  // And in the two Cover 1 calls where the strong safety can't bump, with the man on the tight end bumping instead:
  // the Nickel front with the Mike or the Will blitzing (the strong safety has the back, or from Singleback the other
  // tight end), from I-Form and Singleback, and the strong safety blitzing, from I-Form against every front. With
  // nobody bumping, the Z going across first took the first from 6.1-6.7 yards a carry to 11.4-12.6, and the second
  // from 5.4-6.7 to 10.8-13.0, with one run in five or so going 15 yards or more; with the man on the tight end
  // bumping, 3.6-4.3 and 6.6-8.4 (8-12% going 15 or more, against 4-7% without the motion). That's 320 snaps a group
  // from four start seeds: 6000 (this one), 1, 100000 and 7777777.
  for (const [what, calls] of [
    ['the Nickel front, the Mike or the Will blitzing', ['iform', 'single'].flatMap(formation => ['M', 'W'].map(blitzer => ({ formation, front: 'nickel', blitzer })))],
    ['the strong safety blitzing, from I-Form', FRONTS.map(fr => ({ formation: 'iform', front: fr.id, blitzer: 'SS' }))],
  ]) {
    const ypc = {};
    for (const motion of ['none', 'across']) {
      let y = 0, n = 0, s = 6000;
      for (const c of calls) for (let i = 0; i < 80; i++) { y += simulate({ ...c, play: 'oz', coverage: 'c1', pressure: 'blitz', flip: i % 2 === 1, motion }, s++).result.yards; n++; }
      ypc[motion] = y / n;
    }
    assert.ok(ypc.across - ypc.none < 4, `Outside Zone against Cover 1, ${what}: ${ypc.none.toFixed(1)} yards a carry, ${ypc.across.toFixed(1)} with the Z going across first`);
  }
});

test('motion against a disguise: a safety showing deep who has the man in motion runs with him over the top', () => {
  // Disguised Cover 1 shows two deep; a safety in man on the man in motion goes with him at his own depth, and so
  // gives the man coverage away, rather than diving down to the line to cross the formation.
  let found = 0;
  for (let seed = 1; seed < 400 && found < 5; seed++) {
    const moves = FORMATIONS.filter(f => f.motion);
    const call = { formation: moves[seed % moves.length].id, play: 'smash', front: FRONTS[Math.floor(seed / 4) % 4].id, coverage: 'c1', pressure: seed % 2 ? 'four' : 'blitz', disguise: true, motion: seed % 3 ? 'jet' : 'across', flip: seed % 5 < 2 };
    const r = simulate(call, seed);
    if (r.motion.man < 0 || r.players[r.motion.man].cls !== 's') continue;
    found++;
    const i = r.motion.man, ys = r.frames.filter(f => f.t <= 0).map(f => f.xy[2 * i + 1]);
    assert.ok(Math.min(...ys) > 10, `${JSON.stringify(call)} seed ${seed}: the ${r.players[i].label} came down to ${Math.min(...ys).toFixed(1)} yards to run with him`);
  }
  assert.ok(found >= 3, `only ${found} calls where a safety had him`);
});

test('a tight end can stay in to block, as a back can, and a wide receiver can\'t', () => {
  // Kept in, he's in the protection with the linemen and the back, he isn't one of the quarterback's reads, and his card
  // says he pass-blocks. One split out a few yards (the Y in Gun Trips, both in Gun Ace) sets at the end of the line,
  // where a tight end on the line stands, rather than out where he lined up. From Singleback both can stay in.
  const smash = PLAYS.find(p => p.id === 'smash');
  assert.ok(hotRoutes(smash, { cls: 'te' }).includes('block'), 'a tight end can\'t stay in');
  assert.ok(!hotRoutes(smash, { cls: 'wr' }).includes('block'), 'a wide receiver can stay in');
  for (const [formation, hot] of [['trips', { Y: 'block' }], ['single', { U: 'block', Y: 'block' }], ['ace', { U: 'block' }], ['iform', { Y: 'block' }], ['pistol', { Y: 'block' }]]) {
    const call = { formation, play: 'smash', front: 'nickel', coverage: 'c1', pressure: 'blitz', flip: formation === 'ace', hot }, what = JSON.stringify(call);
    const S = prepare(call, 3), was = prepare({ ...call, hot: {} }, 3);
    for (const label of Object.keys(hot)) {
      const te = S.P.find(p => p.label === label);
      assert.equal(te.job.kind, 'pro', `${what}: the ${label} isn't blocking`);
      assert.ok(S.protection.includes(te) && !S.reads.includes(te), `${what}: the ${label} isn't in the protection, or is still read`);
      assert.match(S.jobText[te.i], /^Pass-blocks/, what);
      assert.ok(Math.abs(te.set.x) <= 4.6 * 1.05 + 1e-9 && Math.sign(te.set.x) === Math.sign(te.x0), `${what}: the ${label} sets at ${te.set.x.toFixed(1)}, lined up at ${te.x0.toFixed(1)}`);
    }
    assert.equal(S.protection.length, was.protection.length + Object.keys(hot).length, `${what}: one more blocker for each`);
    assert.ok(KINDS.has(simulate(call, 3).result.kind), what);
  }
  // A wide receiver given it runs his route as drawn.
  const call = { formation: 'trips', play: 'smash', front: 'nickel', coverage: 'c0', pressure: 'blitz', flip: false };
  assert.equal(JSON.stringify(simulate({ ...call, hot: { H: 'block' } }, 9).result), JSON.stringify(simulate(call, 9).result), 'a wide receiver stayed in');
});

test('a man kept in to block takes his own man when he comes after the quarterback, and the quarterback sees him picked up', () => {
  // In man coverage the defender on a back or a tight end who stays in comes after the passer a moment after the snap
  // (see cover()). The man kept in takes him, unless the protection gave him somebody else, and with him set up in his
  // path the quarterback counts that rusher as blocked rather than throwing hot. (Nobody had him: with the back kept in
  // on Smash from Gun Trips against Cover 1, the ball went out hot on 48 snaps of 48, and on the Play-Action Shot from
  // I-Form and the Pistol, where both backs stay in, on 60 of 96. A tight end kept in against Cover 0 with nobody of his
  // own blocked his man on 10 snaps of the 96 he came, standing there while he ran by; now on all 96.)
  let seed = 6100, n = 0, hot = 0;
  for (const [formation, play, keep] of [['trips', 'smash', { RB: 'block' }], ['iform', 'pa', {}], ['pistol', 'pa', {}]]) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 6; k++) {
    const r = simulate({ formation, play, front: fr.id, coverage: 'c1', pressure, flip: k % 2 === 1, hot: keep }, seed++);
    n++;
    if (r.events.some(e => e.kind === 'throw' && e.how === 'hot')) hot++;
  }
  assert.ok(hot / n < 0.05, `against Cover 1 with a man kept in, the ball went out hot on ${hot} of ${n} snaps`);
  // A tight end kept in against Cover 0 that the protection gave nobody: his man comes across the line, and he takes him.
  let came = 0, took = 0;
  for (const [formation, play, label] of [['single', 'smash', 'Y'], ['iform', 'flood', 'Y'], ['pistol', 'smash', 'Y']]) for (const fr of FRONTS) for (let k = 0; k < 8; k++) {
    const call = { formation, play, front: fr.id, coverage: 'c0', pressure: 'blitz', flip: k % 2 === 1, hot: { [label]: 'block' } };
    const S = prepare(call, seed), r = simulate(call, seed++);
    const te = S.P.find(p => p.label === label), man = S.D.find(d => d.job.kind === 'man' && d.job.r === te);
    if (te.job.target || !r.frames.some(f => f.t <= 3 && f.xy[2 * man.i + 1] < 0)) continue;
    came++;
    if (r.frames.some(f => f.t <= 3 && f.eng[te.i] === man.i)) took++;
  }
  assert.ok(came >= 48 && took / came > 0.8, `against Cover 0 the tight end kept in blocked his own man on ${took} of the ${came} snaps he came`);
});

// Where the receiver caught it, in yards past the line (the first frame after the throw with the ball in his hands).
const caughtAt = r => { const f = r.frames.find(f => f.t > r.events.find(e => e.kind === 'throw').t && !f.air && f.c === r.result.carrier); return f.xy[2 * r.result.carrier + 1]; };

test('hot routes: a receiver or a back given another route runs it, keeps his place in the reads, and every one runs to a finish', () => {
  const base = { formation: 'trips', play: 'smash', front: 'nickel', coverage: 'c2', pressure: 'four', flip: false };
  const reads = S => S.reads.map(r => `${r.label}:${r.job.route}`);
  // Smash from Gun Trips: the H runs the corner, read first. On a slant he's still read first, and drawn that way.
  const was = prepare(base, 3), now = prepare({ ...base, hot: { H: 'slant' } }, 3);
  assert.equal(was.drawn.H, 'corner');
  assert.deepEqual(now.drawn, was.drawn, 'the play\'s own routes are kept, for the card');
  assert.deepEqual(reads(now), reads(was).map(r => (r === 'H:corner' ? 'H:slant' : r)));
  const h = now.P.find(p => p.label === 'H');
  const pts = now.overlay.find(o => o.kind === 'route' && o.i === h.i).pts;
  assert.ok(pts.at(-1).x < h.x0 - 8 && pts.at(-1).y < 15, `the H's drawn route isn't a slant: ${JSON.stringify(pts.at(-1))}`);
  assert.match(now.jobText[h.i], /^Slant:/);
  // The tight end (Y) sits on Smash and isn't read; given a curl, he's read last.
  const y = prepare({ ...base, hot: { Y: 'curl' } }, 3);
  assert.deepEqual(reads(y), [...reads(was), 'Y:curl']);
  // A back staying in to block isn't read; one on a wheel is, in the back's place.
  const rb = prepare({ ...base, hot: { RB: 'block' } }, 3);
  assert.equal(rb.P.find(p => p.label === 'RB').job.kind, 'pro');
  assert.ok(!reads(rb).some(r => r.startsWith('RB:')));
  // What can't be given is ignored: a route a man can't run, a run play, the screen, the back on play-action.
  for (const [call, label] of [[{ ...base, hot: { H: 'wheel' } }, 'H'], [{ ...base, play: 'iz', hot: { H: 'slant' } }, 'H'], [{ ...base, play: 'screen', hot: { RB: 'swing', Z: 'curl' } }, 'Z'], [{ ...base, play: 'pa', hot: { RB: 'wheel' } }, 'RB'], [{ ...base, hot: { LT: 'go', QB: 'go' } }, 'LT']]) {
    const plain = { ...call };
    delete plain.hot;
    assert.equal(JSON.stringify(simulate(call, 9).result), JSON.stringify(simulate(plain, 9).result), `${JSON.stringify(call)} changed the play`);
  }
  assert.deepEqual(hotRoutes(PLAYS.find(p => p.id === 'pa'), { cls: 'fb' }), HOT.back, 'the fullback on play-action can be given a route');
  // Every route each man can be given, from every formation, runs to a finish and is thrown to sometimes.
  let seed = 1;
  const thrown = new Set();
  for (const fm of FORMATIONS) {
    for (const pl of PLAYS.filter(p => p.type === 'pass' && !cantCall(fm.id, p.id))) {
      const S = prepare({ ...base, formation: fm.id, play: pl.id }, 1);
      for (const man of S.O) {
        for (const route of hotRoutes(pl, man)) {
          const call = { ...base, formation: fm.id, play: pl.id, coverage: COVERAGES[seed % 5].id, flip: seed % 2 === 0, hot: { [man.label]: route } };
          const r = simulate(call, seed++);
          assert.ok(KINDS.has(r.result.kind) && ended(r), `${JSON.stringify(call)}: never finished`);
          const t = r.events.find(e => e.kind === 'throw');
          if (t && r.players[t.who].label === man.label) thrown.add(route);
        }
      }
    }
  }
  assert.deepEqual([...HOT.receiver, ...HOT.back].filter(r => r !== 'block' && !thrown.has(r)), [], 'a hot route nobody ever throws to');
});

test('from the shotgun the linebackers and safeties read the handoff before they go after the back, so runs from it work', () => {
  // The shotgun handoff comes about a third of a second after the snap, half the time it takes under center. When the
  // linebackers and safeties went flat out at the back the moment he had it, before the line could get to them, Inside
  // Zone, Outside Zone and Power from Gun Doubles and Gun Trips against the Nickel front succeeded (gained 4 yards or
  // more) 7% of the time here, 3-15% a play; from Singleback they succeed 28-33%. Now they come downhill to their gaps
  // until they've read it (see gunRead() in js/sim.js): 31%, 21-42% a play.
  let seed = 900;
  const rate = {};
  for (const formation of ['doubles', 'trips']) for (const play of ['iz', 'oz', 'power']) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) for (let k = 0; k < 4; k++) {
    const r = simulate({ formation, play, front: 'nickel', coverage: cv.id, pressure, flip: k % 2 === 1 }, seed++).result;
    const a = rate[play] ??= [0, 0];
    a[0]++; if (r.yards >= 4) a[1]++;
  }
  const say = Object.entries(rate).map(([p, [n, ok]]) => `${p} ${Math.round(100 * ok / n)}%`).join(', ');
  const all = Object.values(rate).reduce((a, [n, ok]) => [a[0] + n, a[1] + ok], [0, 0]);
  assert.ok(all[1] / all[0] > 0.22, `from the shotgun against Nickel, runs succeed ${say}`);
  for (const [n, ok] of Object.values(rate)) assert.ok(ok / n > 0.12, `from the shotgun against Nickel, runs succeed ${say}`);
});

test('from the Pistol the linebackers can\'t tell which way the run is going, and come downhill over their own gaps until they\'ve read it', () => {
  // The Pistol's back is straight behind the quarterback, 2 yards deeper than a back beside him, and gets to the line
  // about a quarter of a second later. When the linebackers drifted across with him as they read the handoff, as they
  // do from the other shotgun sets, the Will lined up over the slot on the other side got across in time: Inside Zone
  // and Power against the Nickel front succeeded (gained 4 yards or more) 20% and 16% of the time from this test's
  // seeds, and the Will made about half the stops. Now they lean only PISTOL_LEAN of the way toward him (see bite() in
  // js/sim.js): 34% and 44% (from six start seeds, 34-44% and 33-45%; with the back's lean, the linebackers' guesses
  // and run blocks won and lost early more often, version 4, 35% and 41%, and 31-38% and 28-43%). A back lined up beside
  // the quarterback still tells them: from Gun Doubles the Will has come 1.7-3.0 yards across a third of a second after
  // the handoff, and from the Pistol he came 2.6-3.3 before, 1.3-2.3 now.
  const drift = (formation, play, coverage, flip, seed) => {
    const r = simulate({ formation, play, front: 'nickel', coverage, pressure: 'four', flip }, seed);
    const w = r.players.findIndex(p => p.label === 'W'), h = r.events.find(e => e.kind === 'hand');
    const f = r.frames.find(f => f.t >= h.t + 0.35 - 1e-6);
    return (f.xy[2 * w] - r.frames[0].xy[2 * w]) * (flip ? -1 : 1); // toward the play side
  };
  // (A Will who guesses wrong takes a step away from the play first, from either: see GUESS in js/sim.js.)
  const guess = (formation, play, coverage, flip, seed) => prepare({ formation, play, front: 'nickel', coverage, pressure: 'four', flip }, seed).D.find(d => d.label === 'W').guess;
  let read = 0;
  for (const play of ['iz', 'power']) for (const coverage of ['c2', 'c3', 'c4']) for (const flip of [false, true]) for (let s = 1; s <= 6; s++) {
    const what = `${play} against ${coverage}${flip ? ', flipped' : ''}, seed ${s}`;
    assert.ok(drift('pistol', play, coverage, flip, s) < 2.5, `from the Pistol, ${what}: the Will has come ${drift('pistol', play, coverage, flip, s).toFixed(1)} yards across`);
    if (guess('doubles', play, coverage, flip, s) < 0) { assert.ok(drift('doubles', play, coverage, flip, s) < 0, `from Gun Doubles, ${what}: the Will guessed wrong`); continue; }
    read++;
    assert.ok(drift('doubles', play, coverage, flip, s) > 1.5, `from Gun Doubles, ${what}: the Will has come only ${drift('doubles', play, coverage, flip, s).toFixed(1)} yards across`);
  }
  assert.ok(read >= 36, `${read} snaps with the Will reading it`);
  let seed = 5100;
  const rate = {};
  for (const play of ['iz', 'power']) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) for (let k = 0; k < 12; k++) {
    const r = simulate({ formation: 'pistol', play, front: 'nickel', coverage: cv.id, pressure, flip: k % 2 === 1 }, seed++).result;
    const a = rate[play] ??= [0, 0];
    a[0]++; if (r.yards >= 4) a[1]++;
  }
  const say = Object.entries(rate).map(([p, [n, ok]]) => `${p} ${Math.round(100 * ok / n)}%`).join(', ');
  for (const [n, ok] of Object.values(rate)) assert.ok(ok / n > 0.27, `from the Pistol against Nickel, runs succeed ${say}`);
});

test('on a short third or fourth down a handoff from the shotgun makes it less often than one from under center', () => {
  // A defense expecting a run reads a shotgun handoff sooner (see gunRead() in js/sim.js), in time to meet the back
  // before the blocks do; under center the handoff comes after the read anyway, so nothing changes there. NFL backs'
  // runs on third or fourth and 2 or less made it 62% of the time from the shotgun in the 2023 regular season, and 71%
  // from under center (nflverse play-by-play). Inside Zone, Outside Zone and Power, every front and coverage, on 3rd & 2
  // and 4th & 1: from the shotgun formations they made it 76% of the time here before (more often than the 64% from
  // under center), and 57% now; the same snaps on 1st & 10 gain those yards 76% of the time.
  const made = { gun: [0, 0], under: [0, 0], first: [0, 0] };
  let seed = 3300;
  for (const fm of FORMATIONS.filter(f => !cantCall(f.id, 'iz'))) for (const play of ['iz', 'oz', 'power']) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) for (const sit of ['3and2', '4and1']) {
    const call = { formation: fm.id, play, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 1 }, togo = SITUATIONS.find(s => s.id === sit).togo;
    const r = simulate({ ...call, sit }, seed).result, a = made[fm.under ? 'under' : 'gun'];
    a[0]++; if (r.yards >= togo) a[1]++;
    if (fm.under) assert.deepEqual(r, simulate(call, seed).result, `${JSON.stringify(call)} seed ${seed}: under center the down changes nothing`);
    else { made.first[0]++; if (simulate(call, seed).result.yards >= togo) made.first[1]++; }
    seed++;
  }
  const rate = ([n, ok]) => ok / n, say = `from the shotgun ${Math.round(100 * rate(made.gun))}% (the same snaps on 1st & 10 ${Math.round(100 * rate(made.first))}%), from under center ${Math.round(100 * rate(made.under))}%`;
  assert.ok(rate(made.gun) < rate(made.under) - 0.02, `on 3rd & 2 and 4th & 1, runs make it ${say}`);
  assert.ok(rate(made.gun) < rate(made.first) - 0.08, `on 3rd & 2 and 4th & 1, runs make it ${say}`);
});

test('a tight end with nobody to block takes the nickel back near him: Gun Trips\' Y, rather than the slot from outside', () => {
  // In Gun Trips against the Nickel front in a zone, the nickel back stands between the tight end (the Y, off the line)
  // and the slot. The Y had nobody, and the slot was sent 4 yards inside to block him and seldom got there. Now the Y
  // takes him. Inside Zone from Gun Trips and Gun Ace against Nickel succeeded 22% of the time here; now 38%.
  for (const play of ['iz', 'oz', 'power']) for (const coverage of ['c2', 'c3', 'c4']) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: 'trips', play, front: 'nickel', coverage, pressure, flip }, 3), what = `${play} against ${coverage} ${pressure}${flip ? ', flipped' : ''}`;
    const Y = S.O.find(p => p.label === 'Y'), H = S.O.find(p => p.label === 'H');
    assert.equal(Y.job.target, S.NB, `${what}: the Y blocks ${Y.job.target?.label ?? 'nobody'}`);
    assert.notEqual(H.job.target, S.NB, `${what}: the slot is sent at the nickel back too`);
  }
  // Only from the shotgun: under center a tight end with nobody takes whoever comes free, as before. (Sending him at the
  // nickel back, often the man covering him there, took I-Form's Inside Zone against Cover 0 from 3 to 17 yards a carry
  // and its Outside Zone against Cover 1 from 54% succeeding to 28%.)
  for (const fm of FORMATIONS.filter(f => f.under)) for (const play of ['iz', 'oz', 'power']) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (const flip of [false, true]) {
    const S = prepare({ formation: fm.id, play, front: 'nickel', coverage: cv.id, pressure, flip }, 3);
    for (const te of S.O.filter(p => p.cls === 'te' && p.job.scheme !== 'kick')) assert.notEqual(te.job.target, S.NB, `${fm.id} ${play} against ${cv.id} ${pressure}${flip ? ', flipped' : ''}: the ${te.label} is sent at the nickel back under center`);
  }
  let seed = 7100, n = 0, ok = 0;
  for (const formation of ['trips', 'ace']) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) for (let k = 0; k < 12; k++) {
    n++; if (simulate({ formation, play: 'iz', front: 'nickel', coverage: cv.id, pressure, flip: k % 2 === 1 }, seed++).result.yards >= 4) ok++;
  }
  assert.ok(ok / n > 0.28, `Inside Zone from Gun Trips and Gun Ace against Nickel succeeds ${Math.round(100 * ok / n)}% of the time`);
});

test('a back through the line is run down from behind: not every run that gets 10 yards goes the distance', () => {
  // Inside Zone, Outside Zone and Power from every formation that has a back, against every front and coverage. Before
  // a defender chasing a back 3 yards past the line had the odds one chasing a deep catch has (see contact() in
  // js/sim.js), a run that got 10 yards went on for 35.6-39.0 more on average, from three start seeds (61, 5000, 90000),
  // and more than half went past 60, where the board stops counting; then 21.5-23.0, and since a tackle he breaks down
  // the field costs him a step (STUMBLE), 21.2-23.6: Cover 0, with nobody deep, is most of it. (NFL 2023 regular
  // season, designed runs, from nflverse's play-by-play: 6.8, and 1 in 80 went 60.)
  let seed = 61;
  const long = [];
  for (const fm of FORMATIONS) for (const play of ['iz', 'oz', 'power']) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 2; k++) {
    if (cantCall(fm.id, play)) continue;
    const y = simulate({ formation: fm.id, play, front: fr.id, coverage: cv.id, pressure, flip: k === 1 }, seed++).result.yards;
    if (y >= 10) long.push(y - 10);
  }
  const more = long.reduce((a, b) => a + b, 0) / long.length;
  assert.ok(long.length > 60, `${long.length} runs of 10 yards or more`);
  assert.ok(more < 29, `${long.length} runs of 10 yards or more went on for ${more.toFixed(1)} more on average`);
  // A man who misses him twice in a few steps is put another way the second time, not the same line twice.
  let twice = 0;
  for (let s = 1; s < 400 && twice < 3; s++) {
    const r = simulate({ formation: 'iform', play: 'oz', front: 'over', coverage: 'c3', pressure: 'four', flip: s % 2 === 1 }, s);
    const miss = r.events.filter(e => e.kind === 'miss'), by = miss.filter((e, k) => miss.findIndex(x => x.who === e.who) < k);
    if (!by.length) continue;
    twice++;
    for (const e of by) assert.match(e.text, / (again|once more)\.$/, `seed ${s}: "${e.text}"`);
    for (let k = 1; k < miss.length; k++) assert.notEqual(miss[k].text, miss[k - 1].text, `seed ${s}: ${miss.map(e => e.text).join(' / ')}`);
  }
  assert.ok(twice, 'no run where a man missed the back twice');
});

test('a back who breaks a tackle past the line loses a step, so getting past the one deep safety isn\'t a sure long run', () => {
  // Without it a back was back to full speed a tenth of a second after he broke a tackle, and with the men chasing him
  // no faster than he is, one who got past the lone deep safety in Cover 1 or Cover 3 nearly always went a long way.
  // Inside Zone, Outside Zone, Power and Counter from every formation that has a back, every front, both pressures:
  // from this test's seeds a run that got 10 yards went on 17.1 more on average against Cover 1 and Cover 3, now 7.6.
  // (NFL 2023 designed runs: 6.8; nflverse play-by-play.) Since Counter's linebackers stop stepping with the fake at the
  // handoff from the shotgun, 8.8 here, and 9.6-10.6 from start seeds 1, 100000 and 7777777 (7.7-9.2 before): Counter
  // from the shotgun against Cover 1 cuts back behind linebackers who've come downhill, and goes a long way more often.
  // Since a deep safety keeps the ball carrier in front of him and closes under control (FIT_DEPTH in js/sim.js), more
  // runs get 10 yards, and they go on 9.0 here, 7.3-9.0 from those seeds.
  let seed = 4400;
  const long = [];
  for (const fm of FORMATIONS) for (const play of ['iz', 'oz', 'power', 'counter']) for (const fr of FRONTS) for (const coverage of ['c1', 'c3']) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 8; k++) {
    if (cantCall(fm.id, play)) continue;
    const y = simulate({ formation: fm.id, play, front: fr.id, coverage, pressure, flip: k % 2 === 1 }, seed++).result.yards;
    if (y >= 10) long.push(y - 10);
  }
  const more = long.reduce((a, b) => a + b, 0) / long.length;
  assert.ok(long.length > 50, `${long.length} runs of 10 yards or more`);
  assert.ok(more < 11, `against Cover 1 and Cover 3, ${long.length} runs of 10 yards or more went on for ${more.toFixed(1)} more on average`);
  // The step he loses: for half a second after a tackle he breaks 3 yards past the line, he runs at 70% of his speed.
  let seen = 0;
  for (let s = 1; s < 3000 && seen < 5; s++) {
    const call = { formation: 'iform', play: 'oz', front: 'over', coverage: 'c3', pressure: 'four', flip: s % 2 === 1 };
    const r = simulate(call, s), c = r.result.carrier, top = prepare(call, s).P[c].top;
    const at = t => r.frames.find(f => f.t >= t - 1e-6);
    const miss = r.events.find(e => e.kind === 'miss' && at(e.t).xy[2 * c + 1] > 3.5 && e.t + 0.5 < r.result.t && !r.events.some(x => x.kind === 'miss' && x.t > e.t && x.t < e.t + 0.6));
    if (!miss) continue;
    seen++;
    const a = at(miss.t + 0.2), b = at(miss.t + 0.4);
    const speed = Math.hypot(b.xy[2 * c] - a.xy[2 * c], b.xy[2 * c + 1] - a.xy[2 * c + 1]) / (b.t - a.t);
    assert.ok(speed < 0.75 * top, `seed ${s}: ${speed.toFixed(1)} yards a second after a broken tackle, his best is ${top.toFixed(1)}`);
  }
  assert.ok(seen, 'no broken tackle downfield to look at');
});

test('on a run a deep safety is the last line: he keeps the ball carrier in front of him and closes under control', () => {
  // A safety with a deep zone (the free safety in Cover 1 and Cover 3, both safeties in Cover 2 and Cover 4) used to run
  // flat out at the back from the handoff, and met him 4 to 6 yards past the line: over these snaps, once he'd been
  // within 4 yards in front of the back for a fifth of a second and was within 3, he was going at more than 0.82 of his
  // top speed in 68% of the frames (half of them at 0.95 or more). Now he keeps 4 yards beyond the back until he's
  // within 4 (FIT_DEPTH, FIT_RANGE in js/sim.js) and closes at three quarters of his speed: 2% of those frames, from
  // bumps. So more runs get past 10 yards: 27 of these 768 before, 50 after (NFL 2023 regular season: one designed run
  // in ten, from nflverse's play-by-play). From four start seeds (this one, 1, 100000 and 7777777) that was 37-50, and
  // with the back's lean, the linebackers' guesses and run blocks won and lost early more often (version 4), 36-57; so
  // they're snapped three times over, 2,304 runs, and more than one in 20 get 10 yards, as 38 of 768 did: 5.2-6.4% of
  // them from those seeds before version 4, 6.1-6.4% since.
  let seed = 7000, n = 0, fast = 0, runs = 0, ten = 0;
  for (let pass = 0; pass < 3; pass++) for (const fm of FORMATIONS) for (const play of ['iz', 'oz', 'power', 'counter']) for (const fr of FRONTS) for (const coverage of ['c1', 'c2', 'c3', 'c4']) for (const flip of [false, true]) {
    if (cantCall(fm.id, play)) continue;
    const call = { formation: fm.id, play, front: fr.id, coverage, pressure: 'four', flip };
    const r = simulate(call, seed), S = prepare(call, seed++);
    const c = r.result.carrier, hand = r.events.find(e => e.kind === 'hand');
    runs++; if (r.result.yards >= 10) ten++;
    const F = r.frames.filter(f => f.t >= hand.t && f.t <= r.result.t), at = (f, i) => ({ x: f.xy[2 * i], y: f.xy[2 * i + 1] });
    for (const d of S.P.filter(p => p.cls === 's' && p.job.z?.deep)) for (let k = 4; k < F.length - 1; k++) {
      if ([k - 4, k, k + 1].some(j => F[j].eng[d.i] >= 0)) continue; // (not while somebody's blocking him)
      const D = at(F[k], d.i), C = at(F[k], c), Dp = at(F[k - 4], d.i), Cp = at(F[k - 4], c), D1 = at(F[k + 1], d.i);
      if (!(D.y > C.y + 0.5 && Dp.y > Cp.y + 0.5 && Math.hypot(D.x - C.x, D.y - C.y) < 3 && Math.hypot(Dp.x - Cp.x, Dp.y - Cp.y) < 4)) continue;
      n++; if (Math.hypot(D1.x - D.x, D1.y - D.y) / (F[k + 1].t - F[k].t) > 0.82 * d.top) fast++;
    }
  }
  assert.ok(n > 900, `${n} frames of a deep safety closing on the ball carrier`);
  assert.ok(fast / n < 0.1, `a deep safety closing on the ball carrier was going flat out in ${fast} frames of ${n}`);
  assert.ok(ten / runs > 0.05, `${ten} runs of ${runs} got 10 yards`);
});

test('Counter from the shotgun against Cover 1: a run that gets 10 yards doesn\'t go on as far, and it gains 4 yards as often', () => {
  // The back cuts back behind linebackers who've come downhill (their step with his fake ends at the handoff from the
  // shotgun), and the free safety met him about 5 yards past the line still coming down hard, and was run around or
  // missed, with nobody behind him. From this start seed, of 1,024 snaps 55 reached 10 yards and went on 14.7 more
  // (16.1-17.3 from start seeds 1, 100000 and 55555); since the deep safety keeps the ball in front of him and closes
  // under control, 91 reach 10 and go on 11.6 more (11.6-14.3). It gains 4 yards as often: 45.9% of the time, now 46.2%
  // (41.9-46.5% from the other seeds before, 42.4-46.7% now).
  let seed = 3300, n = 0, ok = 0;
  const long = [];
  for (const fm of FORMATIONS) for (const fr of FRONTS) for (const pressure of ['four', 'blitz']) for (let k = 0; k < 32; k++) {
    if (fm.under || cantCall(fm.id, 'counter')) continue;
    const y = simulate({ formation: fm.id, play: 'counter', front: fr.id, coverage: 'c1', pressure, flip: k % 2 === 1 }, seed++).result.yards;
    n++; if (Math.round(y) >= 4) ok++; if (y >= 10) long.push(y - 10);
  }
  const more = long.reduce((a, b) => a + b, 0) / long.length;
  assert.ok(long.length > 40 && more < 13, `${long.length} runs of ${n} got 10 yards and went on ${more.toFixed(1)} more on average`);
  assert.ok(ok / n > 0.42 && ok / n < 0.5, `it gained 4 yards ${(100 * ok / n).toFixed(1)}% of the time`);
});

test('a deep catch is run down from behind: no long run after every catch 15 yards downfield', () => {
  // 640 snaps of the four plays that throw deep. From four start seeds (31, 1000, 5000, 77777) catches 15+ yards
  // downfield gain 5.9-8.1 yards after the catch on average; before the men chasing a deep catch got him more often,
  // 10.2-14.6. (NFL 2023 regular season: 5.2, from nflverse play-by-play.)
  let seed = 31, n = 0, yac = 0;
  for (const fm of FORMATIONS) for (const play of ['verts', 'smash', 'mesh', 'pa']) for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of ['four', 'blitz']) {
    if (cantCall(fm.id, play)) continue;
    const r = simulate({ formation: fm.id, play, front: fr.id, coverage: cv.id, pressure, flip: seed % 2 === 0 }, seed++);
    if (r.result.kind !== 'catch') continue;
    const at = caughtAt(r);
    if (at >= 15) { n++; yac += r.result.yards - at; }
  }
  assert.ok(n > 40, `${n} deep catches`);
  assert.ok(yac / n < 10, `${n} catches 15+ yards downfield gain ${(yac / n).toFixed(1)} yards after the catch on average`);
});

test('one run against one defense comes out differently from snap to snap', () => {
  // The man nobody blocks decides a run, by where he meets the back, and that spot hardly moved: in 22% of run matchups
  // (one run from one formation against one call) the back went through the same gap on 9 snaps in 10 or more, and 11%
  // gained 4 yards 9 times in 10 or more, 12% one time in 10 or less. Now the back leans a little toward the cutback or
  // the play side each snap, a linebacker sometimes guesses (one in four steps the wrong way first, about one in six
  // jumps it), and on a run a block is won or lost early more often (LEAN, GUESS and BLOCK_SPREAD in js/sim.js).
  let lbs = 0, wrong = 0, right = 0;
  const leans = [];
  for (let seed = 1; seed <= 400; seed++) {
    const S = prepare({ formation: 'iform', play: 'iz', front: 'over', coverage: 'c3', pressure: 'four' }, seed);
    leans.push(S.lean);
    for (const d of S.D.filter(d => d.cls === 'lb')) { lbs++; if (d.guess < 0) wrong++; if (d.guess > 0) right++; }
  }
  const sd = Math.sqrt(leans.reduce((a, x) => a + x * x, 0) / leans.length);
  assert.ok(wrong / lbs > 0.2 && wrong / lbs < 0.3 && right / lbs > 0.12 && right / lbs < 0.22, `${wrong} of ${lbs} linebackers guess wrong, ${right} jump it`);
  assert.ok(sd > 0.75 && sd < 1.05, `the back's lean: spread ${sd.toFixed(2)}`);
  // One who guesses wrong takes a step away from the play before he reads it.
  let stepped = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const call = { formation: 'iform', play: 'iz', front: 'over', coverage: 'c3', pressure: 'four', flip: seed % 2 === 1 };
    const S = prepare(call, seed), r = simulate(call, seed), xy = r.frames.find(f => f.t >= 0.6 - 1e-9).xy;
    for (const d of S.D.filter(d => d.guess < 0 && d.job.kind !== 'rush')) { stepped++; assert.ok((xy[2 * d.i] - d.x0) * S.p < -0.3, `seed ${seed}: the ${d.label} guessed wrong but has gone ${((xy[2 * d.i] - d.x0) * S.p).toFixed(1)} yards toward the play`); }
  }
  assert.ok(stepped >= 5, `${stepped} linebackers guessed wrong`);
  // Sixteen matchups that came out nearly the same every snap, 40 snaps each: before, 15 of them gained 4 yards 9 times
  // in 10 or more or one time in 10 or less (40 of 40 snaps of Counter from I-Form against the 4-3 Over in Cover 1 went
  // through the same gap, the D gap on the strong side); now 2, and that Counter goes through it on 29.
  const cells = ['iform counter over.c1.four', 'ace oz under.c1.four', 'ace power 34.c2.blitz', 'trips power nickel.c2.blitz', 'single oz nickel.c1.blitz', 'pistol power 34.c2.four', 'iform power nickel.c4.blitz', 'doubles power nickel.c2.blitz',
    'iform oz nickel.c0.blitz', 'iform power under.c1.four', 'single oz over.c3.blitz', 'single oz under.c0.blitz', 'single power over.c3.four', 'iform counter under.c0.blitz', 'single iz under.c0.blitz', 'iform iz nickel.c4.four'];
  const all = [];
  let same = 0;
  for (const c of cells) {
    const [formation, play, call] = c.split(' '), [front, coverage, pressure] = call.split('.');
    let ok = 0;
    const holes = {};
    for (let k = 0; k < 40; k++) {
      const P = simulate({ formation, play, front, coverage, pressure, flip: false, motion: 'none', hot: {}, blitzer: 'M', disguise: false, sit: '1and10' }, 9e6 + k), r = P.result;
      if (r.kind === 'run' && Math.round(r.yards) >= 4) ok++;
      const h = P.events.find(e => e.kind === 'hole'), key = h ? `${h.gap}/${h.side}` : 'none';
      holes[key] = (holes[key] || 0) + 1;
    }
    all.push(`${c} ${ok}/40`);
    if (c === cells[0]) same = Math.max(...Object.values(holes));
  }
  const sure = all.filter(x => { const n = +x.split(' ').at(-1).split('/')[0]; return n >= 36 || n <= 4; });
  assert.ok(sure.length <= 5, `still nearly the same every snap: ${sure.join(', ')}`);
  assert.ok(same < 36, `Counter from I-Form against the 4-3 Over in Cover 1 went through the same gap on ${same} of 40 snaps`);
});

test('one pass against one defense comes out differently from snap to snap', () => {
  // Each receiver ran his route exactly as drawn, each man defender trailed his man by the same third of a second or so,
  // and each zone defender dropped to the same spot, so the same man came open by the same margin every snap: in half
  // the pass matchups (one pass play from one formation against one call) the ball went to the same man on 9 throws in
  // 10 or more. Now a man defender reacts a little quicker or slower each snap, a zone defender sets up a yard or so off
  // his spot (a deep one only deeper), and a route breaks a little deeper or shorter (PASS_SPREAD in js/sim.js).
  const reacts = [], spots = [], deep = [], depth = [];
  for (let seed = 1; seed <= 400; seed++) {
    const S = prepare({ formation: 'doubles', play: 'stick', front: 'over', coverage: 'c1', pressure: 'four' }, seed);
    for (const d of S.D) if (d.job.kind === 'man') reacts.push(d.react);
    const Z = prepare({ formation: 'doubles', play: 'stick', front: 'over', coverage: 'c3', pressure: 'four' }, seed);
    for (const d of Z.D) if (d.job.kind === 'zone') (d.job.z.deep ? deep : spots).push(d.offSpot);
    depth.push(Z.keys.S2.path.at(-1).y - Z.keys.S2.y0);
  }
  const q = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor(p * (a.length - 1))];
  const sd = a => { const m = a.reduce((t, x) => t + x, 0) / a.length; return Math.sqrt(a.reduce((t, x) => t + (x - m) ** 2, 0) / a.length); };
  assert.ok(q(reacts, 0.1) < 0.18 && q(reacts, 0.5) > 0.25 && q(reacts, 0.5) < 0.32 && q(reacts, 0.9) > 0.45, `a man defender's reaction: ${[0.1, 0.5, 0.9].map(p => q(reacts, p).toFixed(2)).join(', ')} s (one in ten, half, nine in ten)`);
  assert.ok(spots.every(Boolean) && [sd(spots.map(o => o.x)), sd(spots.map(o => o.y))].every(v => v > 1 && v < 1.4), 'a zone defender sets up a yard or so off his spot, either way');
  assert.ok(deep.length && deep.every(o => o.y >= 0), 'a deep one only deeper');
  assert.ok(q(depth, 0.9) - q(depth, 0.1) > 0.6 && Math.abs(q(depth, 0.5) - 5.1) < 0.2, `the stick sits down ${q(depth, 0.1).toFixed(1)} to ${q(depth, 0.9).toFixed(1)} yards up`);
  // Sixteen matchups that came out nearly the same every snap, 40 snaps each: before, 14 of them gained 4 yards 36 times
  // in 40 or more or 4 times or less, and in 10 of the 12 that aren't the RB Screen (which always goes to the back) the
  // ball went to the same man on 38 throws in 40 or more (Stick from Gun Doubles against the 4-3 Over in Cover 1 to the Y
  // on all 40); now 5 and 1, and that Stick goes to the Y on 35.
  const cells = ['doubles stick over.c1', 'doubles stick nickel.c1', 'ace smash nickel.c4', 'ace smash under.c3', 'iform smash 34.c3', 'pistol smash under.c4', 'ace flood 34.c2', 'doubles flood 34.c1',
    'iform stick over.c3', 'single stick nickel.c3', 'pistol stick nickel.c4', 'iform slants under.c4', 'iform screen nickel.c2', 'trips screen 34.c2', 'single screen over.c2', 'pistol screen 34.c3'];
  const all = [], same = [];
  for (const c of cells) {
    const [formation, play, call] = c.split(' '), [front, coverage] = call.split('.');
    let ok = 0;
    const who = {};
    for (let k = 0; k < 40; k++) {
      const P = simulate({ formation, play, front, coverage, pressure: 'four', flip: false, motion: 'none', hot: {}, blitzer: 'M', disguise: false, sit: '1and10' }, 9e6 + k), r = P.result;
      if (r.kind === 'catch' && Math.round(r.yards) >= 4) ok++;
      const t = P.events.find(e => e.kind === 'throw');
      if (t) who[t.who] = (who[t.who] || 0) + 1;
    }
    all.push(`${c} ${ok}/40`);
    if (play !== 'screen') same.push(`${c} ${Math.max(0, ...Object.values(who))}/40`);
  }
  const n = x => +x.split(' ').at(-1).split('/')[0];
  const sure = all.filter(x => n(x) >= 36 || n(x) <= 4), one = same.filter(x => n(x) >= 38);
  assert.ok(sure.length <= 7, `still nearly the same every snap: ${sure.join(', ')}`);
  assert.ok(one.length <= 3, `still to the same man nearly every snap: ${one.join(', ')}`);
  assert.ok(n(same[0]) < 38, `Stick from Gun Doubles against the 4-3 Over in Cover 1 went to the same man on ${same[0]}`);
});

test('the drills\' notes say what the board shows', () => {
  // Each drill ends with a line in DRILLS (js/playbook.js) on what does best against its call; this holds the board to
  // it. The offense drills face their coverage from the front the drill sets (nickel against 10 and 11 personnel, the
  // 4-3 Over otherwise), every play from every formation that can run it, 25 snaps each; the run drill is I-Form's
  // runs, 50 snaps each, against the two calls its note names. Run as this test runs them from three start seeds (11,
  // this one, 100000 and 7777777), with Counter (which reshuffles the snaps every later play draws, but changes no
  // pass): against Cover 2, Four Verticals 22.0-25.3 yards a play and Play-Action Shot 15.3-17.5, the next 14.9; Stick
  // 77-84% and Slant-Flat 75-79% succeed, the next 77% (Flood). Against Cover 3, Four Verticals 11.2-13.7 yards and
  // Play-Action Shot 10.0-10.4, the next 9.0 (Flood 8.7-10.0 since the Cover 3 curl-flat defender expands to a back in
  // the flat); the Draw 69-73% and Slant-Flat 68-71%, the next 71% (Smash, from one seed), and since Stick's flat goes
  // outside the stick from three receivers on a side, Stick 77-81% ahead of them, with the Draw, Slant-Flat and Smash
  // 65-73%, the next 57-61% (Flood or Counter). Against Cover 0, the RB Screen 63-71% (70-75% since it's thrown before
  // the drop is over when a rusher is within 2 yards of the quarterback, and the back has turned), then Smash,
  // Slant-Flat and Play-Action Shot 45-54%, the next 46%, and the Draw 1-5% and Power 9-18%,
  // the next 18-22%. Against I-Form's five runs, the 4-3 Over in Cover 1 with a blitz stops 68-73% for 2.4-2.7 yards a
  // run, and in Cover 0 73-80% for 5.2-8.0. (Before Counter, 80-82% and 81-84%, from four start seeds: Counter gets
  // through it two times in three, its fake pulling the linebackers the wrong way.) With the back's lean, the
  // linebackers' guesses and run blocks won and lost early more often (version 4), from the three start seeds: against
  // Cover 0, Power 13-17%, Counter 13-21% and the Draw 15-18% (from 1-4%), the next 25-27% (Inside Zone); and against
  // I-Form's runs, Cover 1 with a blitz stops 61-64% for 2.6-3.5 yards a run and Cover 0 69-78% for 5.6-7.3 (1,000
  // snaps of each from two more start seeds: 61-63% for 3.3-3.4, and 74-75% for 6.1-6.7).
  // Since the coverage and the routes vary from snap to snap on a pass (version 5: see PASS_SPREAD in js/sim.js), from
  // the three start seeds: against Cover 2, Four Verticals 19.8-21.4 yards a play and the Play-Action Shot 14.2-16.4
  // (Smash 11.6-14.0); Slant-Flat 79-86% succeed, then Stick 71-78% and the Draw 72-76%, the next 61-68% (Flood). Against
  // Cover 3, Four Verticals 10.5-12.9 yards, then Flood 9.6-11.1 and the Play-Action Shot 9.0-11.0 (Smash 7.8-8.8);
  // Slant-Flat 77-81%, then Stick, the Draw and Smash 70-77%, the next 63-71% (Flood). From 420 snaps a play (start
  // seed 31000000): against Cover 2, Slant-Flat 83%, Stick 76%, the Draw 71%, Flood 66%; against Cover 3, Slant-Flat
  // 80%, Stick 73%, the Draw 71%, Smash 69%, Flood 66%, and Four Verticals 11.4 yards, the Play-Action Shot 10.5, Flood
  // 10.0. (Stick and Slant-Flat had been 77-84% and 75-79% against Cover 2, and Stick 77-81% against Cover 3, ahead of
  // Slant-Flat's 68-71%.)
  let seed = 11;
  const won = r => (r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= 4;
  const front = fm => (['10', '11'].includes(fm.personnel) ? 'nickel' : 'over');
  const by = (coverage, pressure) => Object.fromEntries(PLAYS.map(pl => {
    let n = 0, ok = 0, y = 0;
    for (const fm of FORMATIONS.filter(f => !cantCall(f.id, pl.id))) for (let k = 0; k < 25; k++) {
      const r = simulate({ formation: fm.id, play: pl.id, flip: k % 2 === 1, front: front(fm), coverage, pressure }, seed++).result;
      n++; y += r.yards; if (won(r)) ok++;
    }
    return [pl.id, { rate: ok / n, avg: y / n }];
  }));
  const top = (o, k, n) => Object.entries(o).sort((a, b) => b[1][k] - a[1][k]).slice(0, n).map(([id]) => id).sort();
  const say = (o, k) => Object.entries(o).map(([id, v]) => `${id} ${k === 'rate' ? `${Math.round(v.rate * 100)}%` : v.avg.toFixed(1)}`).join(', ');
  const drill = id => DRILLS.find(d => d.id === id);
  const c2 = by(drill('c2').coverage, drill('c2').pressure);
  assert.deepEqual(top(c2, 'avg', 2), ['pa', 'verts'], `Cover 2, yards a play: ${say(c2, 'avg')}`);
  assert.deepEqual(top(c2, 'rate', 1), ['slants'], `Cover 2, success: ${say(c2, 'rate')}`);
  assert.deepEqual(top(c2, 'rate', 3), ['draw', 'slants', 'stick'], `Cover 2, success: ${say(c2, 'rate')}`);
  assert.ok(c2.slants.rate > 0.74 && c2.slants.rate < 0.9, `"about four times in five": ${say(c2, 'rate')}`);
  for (const id of ['stick', 'draw']) assert.ok(c2[id].rate > 0.64 && c2[id].rate < 0.84, `"about three times in four": ${say(c2, 'rate')}`);
  const c3 = by(drill('c3').coverage, drill('c3').pressure);
  assert.deepEqual(top(c3, 'avg', 1), ['verts'], `Cover 3, yards a play: ${say(c3, 'avg')}`);
  assert.ok(['pa', 'flood'].every(id => top(c3, 'avg', 4).includes(id)), `Cover 3, yards a play, "then the Play-Action Shot and Flood": ${say(c3, 'avg')}`);
  assert.deepEqual(top(c3, 'rate', 1), ['slants'], `Cover 3, success: ${say(c3, 'rate')}`);
  assert.deepEqual(top(c3, 'rate', 4), ['draw', 'slants', 'smash', 'stick'], `Cover 3, success: ${say(c3, 'rate')}`);
  assert.ok(c3.slants.rate > 0.72 && c3.slants.rate < 0.88, `"about four times in five": ${say(c3, 'rate')}`);
  for (const id of ['stick', 'draw', 'smash']) assert.ok(c3[id].rate > 0.62 && c3[id].rate < 0.8, `"about seven times in ten": ${say(c3, 'rate')}`);
  const c0 = by(drill('blitz').coverage, drill('blitz').pressure);
  assert.ok(top(c0, 'rate', 3).every(id => ['stick', 'flood', 'screen', 'mesh'].includes(id)), `Cover 0, success: ${say(c0, 'rate')}`);
  for (const id of ['stick', 'flood']) assert.ok(c0[id].rate > 0.58 && c0[id].rate < 0.84, `"about two times in three": ${say(c0, 'rate')}`);
  assert.ok(c0.screen.rate > 0.45 && c0.screen.rate < 0.82, `the screen "about two times in three": ${say(c0, 'rate')}`);
  for (const id of ['mesh', 'slants']) assert.ok(c0[id].rate > 0.38 && c0[id].rate < 0.7, `"about half the time or a little more": ${say(c0, 'rate')}`);
  assert.deepEqual(Object.entries(c0).sort((a, b) => a[1].rate - b[1].rate).slice(0, 3).map(([id]) => id).sort(), ['counter', 'draw', 'power'], `Cover 0, "the Draw, Power and Counter run straight into it": ${say(c0, 'rate')}`);
  const runs = PLAYS.filter(p => p.type === 'run').map(p => p.id);
  const stop = (front, coverage, pressure) => {
    let n = 0, s = 0, y = 0;
    for (const play of runs) for (let k = 0; k < 50; k++) {
      const r = simulate({ formation: drill('run').formation, play, flip: k % 2 === 1, front, coverage, pressure }, seed++).result;
      n++; y += r.yards; if (!won(r)) s++;
    }
    return { stop: s / n, avg: y / n };
  };
  const one = stop('over', 'c1', 'blitz'), zero = stop('over', 'c0', 'blitz');
  const both = `Cover 1 and a blitz stops ${Math.round(one.stop * 100)}% for ${one.avg.toFixed(1)} yards a run, Cover 0 ${Math.round(zero.stop * 100)}% for ${zero.avg.toFixed(1)}`;
  assert.ok(one.stop > 0.52 && one.stop < 0.72, `"about six runs in ten": ${both}`);
  assert.ok(zero.stop > one.stop && zero.stop > 0.64 && zero.stop < 0.86 && zero.avg > one.avg + 2, `"more, about three in four, but the runs that get through go a long way": ${both}`);
  const S = prepare({ formation: drill('run').formation, play: 'iz', front: 'over', coverage: 'c1', pressure: 'blitz' }, 5);
  assert.deepEqual([S.box.box, S.box.blockers], [8, 7], '"eight against seven"');

  // On 3rd & 8 (long) and on a short third or fourth down (short: 3rd & 2 and 4th & 1) a success is the first down, and
  // each drill has a note for those downs too. Run the same way, 12 snaps a play from each formation (the run drill's
  // calls 40 snaps a run, and every defense 4 a run for the share held short), from three start seeds (11, 100000,
  // 7777777): against Cover 2 on 3rd & 8, Four Verticals, Slant-Flat, the Play-Action Shot, Smash and Mesh made it
  // 43-56% of the time, the next 21% (Flood 18-20%, Stick 13-15%); on 3rd & 2 Stick, Slant-Flat, Flood and the Draw
  // 69-86%, the top three always among them (and Inside Zone 71-74%: since the Pistol's linebackers come downhill over
  // their own gaps, 81-85%, with them); on 4th & 1 Inside Zone, the Draw, Outside Zone and Counter 79-94%, the top
  // two among them. Against Cover 3 on 3rd & 8, Flood 50-61% and the Play-Action Shot 50-58%, both always in the top
  // three; the Draw, Four Verticals and Stick 36-50%; Slant-Flat 15-20%. On 3rd & 2 Stick, Slant-Flat, the Draw and the
  // RB Screen 65-86%, the top two among them; on 4th & 1 the Draw 88-92%, first or second, and Stick, Inside Zone and the
  // screen 72-86%. Against the blitz on 3rd & 8, Smash, Four Verticals and the Play-Action Shot 35-50%, the next 32%
  // (the screen 25-32%); on 3rd & 2 the screen 75-85%, Outside Zone 72-78% and Inside Zone 61-67% (75% as this test
  // runs it), the top two among them, and the Draw last, 4-10%;
  // on 4th & 1 Inside Zone 81-90%, Outside Zone 82-83% and the screen 75-85%, the top two among them, and the Draw last,
  // 18-24%. Against I-Form's runs on 3rd & 8, the 4-3 Over in Cover 1 with a blitz held 92-95% short and every defense
  // 85%; Cover 3 rushing four from the 4-3 and the 3-4, 68-81% (since a deep safety fits the run from depth, every
  // defense 83-84% and Cover 3 rushing four 57-67%: its lone free safety is the man a back past the linebackers has to
  // beat, and he now meets him farther down the field. With each of the 36 calls run 200 times from start seed 8800,
  // they held 82.5% short on average, from 85.8%, and half of them 83% or more, so the note says about four in five,
  // not nine in ten). On 3rd & 2 every defense held 36% short, and Cover 0
  // from the 4-3 or the 3-4 56-68%; on 4th & 1, 21%, Cover 0 from the 4-3 47-53% (the most of any call), and the 4-3
  // Over with two safeties deep and four rushing 1-4%. With the run changes of version 4 (see above), from the three
  // start seeds: the 4-3 Over in Cover 1 with a blitz held 87-94% short on 3rd & 8 (91-92% over 1,000 snaps from two
  // more); against Cover 0 on 3rd & 2 the Draw, Power and Counter made it 15-32% and on 4th & 1 21-43%, the zone runs
  // and the screen 57-85% and 74-88%; and the 4-3 Over with two safeties deep and four rushing stopped 4-10% on 4th &
  // 1 (5-8% over 500 snaps of each from two more). With the pass spread of version 5, from the three start seeds:
  // against Cover 2 on 3rd & 8, Four Verticals, Slant-Flat, Smash, the Play-Action Shot, Mesh and Flood 32-61% (Flood
  // 35-46%, from 18-20%), the next 26% (Outside Zone), and Stick 8-17%; on 3rd & 2 Slant-Flat 79-88%, Stick 74-81%, the
  // Draw 63-76%, the zone runs 61-78% and Flood 68-74%. Against Cover 3 on 3rd & 8, Flood 62-63%, first every time,
  // then the Play-Action Shot, Smash, the Draw, Four Verticals and Stick 31-53%, and Slant-Flat 31-39% (from 15-20%); on
  // 3rd & 2 Slant-Flat 79-85%, Stick 74-82%, the Draw 69-79% and Smash 64-77%; on 4th & 1 the Draw 83-86%, Inside Zone
  // 78-89%, Slant-Flat 77-86%, Stick 73-77% and the screen 72-75%.
  const on = (sit, coverage, pressure) => {
    const need = needed(SITUATIONS.find(s => s.id === sit));
    return Object.fromEntries(PLAYS.map(pl => {
      let n = 0, ok = 0;
      for (const fm of FORMATIONS.filter(f => !cantCall(f.id, pl.id))) for (let k = 0; k < 12; k++) {
        const r = simulate({ formation: fm.id, play: pl.id, flip: k % 2 === 1, front: front(fm), coverage, pressure, sit }, seed++).result;
        n++; if ((r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= need) ok++;
      }
      return [pl.id, { rate: ok / n }];
    }));
  };
  const within = (o, ids, lo, hi, what) => { for (const id of ids) assert.ok(o[id].rate >= lo && o[id].rate <= hi, `${what}: ${say(o, 'rate')}`); };
  const among = (o, k, ids, what) => assert.ok(top(o, 'rate', k).every(id => ids.includes(id)), `${what}: ${say(o, 'rate')}`);
  // (below: the first plays all make it less often than the second ones. On a short third or fourth down against Cover
  // 0 the Draw made it least often, 3-10% on 3rd & 2 and 17-24% on 4th & 1, until the run changes of version 4: now
  // it's with Power and Counter, see above.)
  const below = (o, ids, than, what) => assert.ok(Math.max(...ids.map(id => o[id].rate)) < Math.min(...than.map(id => o[id].rate)), `${what}: ${say(o, 'rate')}`);
  for (const id of ['c2', 'c3', 'blitz']) assert.ok(drill(id).long && drill(id).short, `${id} has no note for third down`);
  let o = on('3and8', 'c2', 'four');
  within(o, ['verts', 'slants', 'pa', 'smash', 'mesh', 'flood'], 0.28, 0.66, 'Cover 2 on 3rd & 8, "about two times in five to half the time each"');
  among(o, 6, ['verts', 'slants', 'pa', 'smash', 'mesh', 'flood'], 'Cover 2 on 3rd & 8');
  within(o, ['stick'], 0, 0.22, 'Cover 2 on 3rd & 8, Stick "only about one time in ten"');
  o = on('3and2', 'c2', 'four');
  within(o, ['slants', 'stick', 'draw', 'iz', 'oz'], 0.58, 0.92, 'Cover 2 on 3rd & 2, "three or four times in five"');
  among(o, 3, ['slants', 'stick', 'draw', 'iz', 'oz', 'flood'], 'Cover 2 on 3rd & 2, "most often", "with Flood close behind"');
  o = on('4and1', 'c2', 'four');
  within(o, ['iz', 'draw', 'oz', 'counter'], 0.72, 1, 'Cover 2 on 4th & 1, "about four times in five or better"');
  among(o, 2, ['iz', 'draw', 'oz', 'counter'], 'Cover 2 on 4th & 1, "most often"');
  o = on('3and8', 'c3', 'four');
  assert.deepEqual(top(o, 'rate', 1), ['flood'], `Cover 3 on 3rd & 8, "Flood makes the first down most often": ${say(o, 'rate')}`);
  within(o, ['flood'], 0.5, 0.74, 'Cover 3 on 3rd & 8, "about three times in five"');
  within(o, ['pa', 'smash', 'draw', 'verts', 'stick'], 0.28, 0.6, 'Cover 3 on 3rd & 8, "about two times in five to half the time"');
  within(o, ['slants'], 0.2, 0.44, 'Cover 3 on 3rd & 8, "about one time in three"');
  o = on('3and2', 'c3', 'four');
  within(o, ['slants', 'stick', 'draw', 'smash'], 0.6, 0.92, 'Cover 3 on 3rd & 2, "about three times in four"');
  among(o, 2, ['slants', 'stick', 'draw', 'smash'], 'Cover 3 on 3rd & 2, "most often"');
  o = on('4and1', 'c3', 'four');
  within(o, ['draw', 'iz'], 0.76, 1, 'Cover 3 on 4th & 1, "more than four times in five"');
  among(o, 3, ['draw', 'iz', 'slants', 'stick'], 'Cover 3 on 4th & 1, "the Draw and Inside Zone make it most often, with Slant-Flat and Stick close behind"');
  within(o, ['slants', 'stick', 'screen'], 0.64, 0.9, 'Cover 3 on 4th & 1, "close behind ... about three times in four"');
  o = on('3and8', 'c0', 'blitz');
  within(o, ['verts', 'flood'], 0.36, 0.62, 'Cover 0 on 3rd & 8, "about half the time"');
  among(o, 3, ['verts', 'flood', 'mesh', 'smash', 'pa'], 'Cover 0 on 3rd & 8, "most often"');
  within(o, ['mesh', 'smash', 'pa'], 0.26, 0.56, 'Cover 0 on 3rd & 8, "about two times in five"');
  within(o, ['stick'], 0.2, 0.48, 'Cover 0 on 3rd & 8, Stick "about one time in three"');
  within(o, ['screen'], 0.12, 0.38, 'Cover 0 on 3rd & 8, the screen "about one time in four"');
  o = on('3and2', 'c0', 'blitz');
  within(o, ['stick', 'screen'], 0.62, 0.92, 'Cover 0 on 3rd & 2, "about four times in five"');
  within(o, ['flood', 'mesh', 'oz'], 0.52, 0.86, 'Cover 0 on 3rd & 2, "about seven times in ten"');
  among(o, 2, ['stick', 'screen', 'flood', 'mesh', 'oz'], 'Cover 0 on 3rd & 2, "most often"');
  within(o, ['draw', 'power', 'counter'], 0.1, 0.42, 'Cover 0 on 3rd & 2, the Draw, Power and Counter "about one time in four"');
  below(o, ['draw', 'power', 'counter'], ['stick', 'screen', 'oz'], 'Cover 0 on 3rd & 2, the Draw, Power and Counter "run into the rush"');
  o = on('4and1', 'c0', 'blitz');
  within(o, ['stick', 'screen', 'iz', 'oz'], 0.66, 0.94, 'Cover 0 on 4th & 1, "about four in five"');
  among(o, 2, ['stick', 'screen', 'iz', 'oz'], 'Cover 0 on 4th & 1');
  within(o, ['draw', 'power', 'counter'], 0.18, 0.5, 'Cover 0 on 4th & 1, the Draw, Power and Counter "one in three"');
  below(o, ['draw', 'power', 'counter'], ['stick', 'screen', 'iz', 'oz'], 'Cover 0 on 4th & 1, the Draw, Power and Counter "run into the rush"');
  // The run drill: how often I-Form's runs are held short of the first down.
  const held = (sit, front, coverage, pressure, each = 40) => {
    const need = needed(SITUATIONS.find(s => s.id === sit));
    let n = 0, s = 0;
    for (const play of runs) for (let k = 0; k < each; k++) {
      const r = simulate({ formation: drill('run').formation, play, flip: k % 2 === 1, front, coverage, pressure, sit }, seed++).result;
      n++; if (!((r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= need)) s++;
    }
    return s / n;
  };
  const everyone = sit => { let t = 0, n = 0; for (const fr of FRONTS) for (const cv of COVERAGES) for (const pressure of cv.id === 'c0' ? ['blitz'] : ['four', 'blitz']) { t += held(sit, fr.id, cv.id, pressure, 4); n++; } return t / n; };
  assert.ok(drill('run').long && drill('run').short, 'the run drill has no note for third down');
  const long1 = held('3and8', 'over', 'c1', 'blitz'), longAll = everyone('3and8'), long3 = ['over', '34'].map(fr => held('3and8', fr, 'c3', 'four'));
  assert.ok(long1 > 0.84, `"the 4-3 Over with Cover 1 and a blitz about nine in ten": ${long1.toFixed(2)}`);
  assert.ok(longAll > 0.72 && longAll < 0.88, `"most calls hold it short about four times in five": every defense ${longAll.toFixed(2)}`);
  assert.ok(long3.every(x => x > 0.5 && x < 0.75 && x < long1), `"Cover 3 rushing four lets the most through, about one in three": ${long3.map(x => x.toFixed(2))}`);
  const shortAll = everyone('3and2'), short0 = ['over', 'under', '34'].map(fr => held('3and2', fr, 'c0', 'blitz'));
  assert.ok(shortAll > 0.28 && shortAll < 0.45, `"about one run in three is held short on 3rd & 2": ${shortAll.toFixed(2)}`);
  assert.ok(short0.every(x => x > 0.5 && x < 0.75), `"Cover 0 holds about three in five short on 3rd & 2": ${short0.map(x => x.toFixed(2))}`);
  const oneAll = everyone('4and1'), one0 = ['over', 'under'].map(fr => held('4and1', fr, 'c0', 'blitz')), oneRest = [['34', 'c1', 'blitz'], ['34', 'c3', 'blitz'], ['over', 'c1', 'blitz'], ['nickel', 'c3', 'four']].map(c => held('4and1', ...c));
  assert.ok(oneAll > 0.14 && oneAll < 0.28, `"one in five on 4th & 1": ${oneAll.toFixed(2)}`);
  assert.ok(one0.every(x => x > 0.38 && x < 0.62 && x > Math.max(...oneRest) - 0.06), `"from the 4-3, about half on 4th & 1, as many as any call here": ${one0.map(x => x.toFixed(2))} against ${oneRest.map(x => x.toFixed(2))}`);
  const oneDeep = ['c2', 'c4'].map(cv => held('4and1', 'over', cv, 'four'));
  assert.ok(oneDeep.every(x => x < 0.12), `"the 4-3 Over with two safeties deep and four rushing hardly ever stops it on 4th & 1, about one time in 15": ${oneDeep.map(x => x.toFixed(2))}`);
});

test('over many snaps the numbers look like football', () => {
  // 2,100 snaps, enough to hold the README's numbers: about four yards a carry, about two passes in three complete, a
  // sack on about one dropback in twenty-five. From twelve start seeds (77 + k * 7919) this recipe gave 3.73-5.41 yards
  // a carry and 64.7-68.9% complete before the Pistol, Gun Ace, Empty and Stick (four seeds above the 66% completion
  // bound, mean 66.0%); with them it gives 3.33-4.75 yards a carry, 64.8-67.8% complete (mean 66.4%, nine seeds above
  // 66%), sacks on 3.1-4.7% of dropbacks and interceptions on 1.4-2.4% of throws. Stick is a quick throw that's caught
  // about three times in four, and nudges the rate up. Since the defense reads a shotgun handoff before it goes after the
  // back, and a back past the line is run down from behind (version 2), it gives 3.88-4.89 yards a carry (the shotgun
  // read alone gave 5.05-6.61: a back who got past the linebackers nearly always went the distance), and the passes as
  // before; with a tight end taking the nickel back near him from the shotgun, 4.00-5.00. This one gave 65.3%, 1.6% and
  // 5.00. The completion bound is 68%, not 66%: the board sat right on 66% (the twelve seeds' mean is 66.4%), and adding
  // a play reshuffles which snaps the recipe draws, so adding Counter, a run, which changes no pass, took this seed to
  // 66.9%. About two in three is 66.7%. (Mark's call.) With Counter the twelve seeds give 4.04-5.19 yards a carry,
  // 64.3-70.6% complete (mean 67.5%), sacks on 2.5-5.4% of dropbacks and interceptions on 1.4-2.4% of throws. This one
  // gave 66.9%, 1.4% and 4.82. With the screen thrown before a rusher gets there and the Cover 3 curl-flat defender
  // expanding to the back in Flood's flat, 64.1-70.0% complete (mean 67.4%), sacks on 1.9-4.0%; with Stick's flat
  // outside the stick from three receivers on a side, which gets Stick from Gun Trips caught about five times in six
  // rather than one in three, 64.8-71.3% (mean 68.2%, six seeds above 68%) and interceptions on 1.0-2.3%; with the
  // screen thrown early only when a rusher is within 2 yards, 65.3-71.6% (mean 68.3%, six above 68%). This one gives
  // 67.7%, 1.0% (13 in 1,248) and 4.82. With the Pistol's linebackers over their own gaps, 4.14-5.06 yards a carry; and
  // since a tackle a back breaks down the field costs him a step, 3.74-4.58 (this one 4.30), the passes as before. With
  // a man kept in to block taking his own man in man coverage, and the quarterback counting a rusher with a blocker set
  // up in his path as blocked, the twelve give 64.5-71.1% complete (mean 67.7%, down from 68.3%; six above 68%) and sacks
  // on 2.0-4.1% of dropbacks; this one 67.9% (from 67.7%), 3.5% and 4.36. Since a deep safety fits the run from depth
  // (version 3), 4.17-4.97 yards a carry (mean 4.52, from 4.27; this one 4.74), with 5.6-9.1% of runs gaining 10 yards
  // or more (from 3.6-6.2%), and the passes as before. With the back's lean, the linebackers' guesses and run blocks won
  // and lost early more often (version 4), 3.77-4.95 yards a carry (mean 4.43, from 4.54; this one 4.95), with 10.9-15.3%
  // of runs losing yards (from 9.9-12.6%), and the passes as before.
  // With the quarterback looking first to the tight end in the flat on the Play-Action Shot from I-Form when as many
  // rush as he has blockers (version 4 too), the twelve give 64.8-71.3% complete (mean 67.86%, from 67.66%; seven above
  // 68%, from six) and sacks on 2.0-4.0% of dropbacks; this one 68.2% (851 of 1,247, from 846 of 1,246), over the 68%
  // bound, so the bound is 69% (Mark's call, 2026-11-10).
  let seed = 77;
  const pick = list => list[(seed = (seed * 16807) % 2147483647) % list.length];
  const run = { n: 0, y: 0 }, pass = { n: 0, att: 0, comp: 0, sack: 0, int: 0 };
  for (let k = 0; k < 2100; k++) {
    const pl = pick(PLAYS);
    let fm = pick(FORMATIONS);
    while (cantCall(fm.id, pl.id)) fm = pick(FORMATIONS); // (a run from Empty: another formation)
    const r = simulate({ formation: fm.id, play: pl.id, front: pick(FRONTS).id, coverage: pick(COVERAGES).id, pressure: k % 4 ? 'four' : 'blitz' }, seed).result;
    if (pl.type === 'run') { run.n++; run.y += r.yards; }
    else { pass.n++; if (r.kind === 'sack') pass.sack++; else pass.att++; if (r.kind === 'catch') pass.comp++; if (r.kind === 'int') pass.int++; }
  }
  const ypc = run.y / run.n, comp = pass.comp / pass.att, sack = pass.sack / pass.n, int = pass.int / pass.att;
  assert.ok(ypc > 3.3 && ypc < 5.3, `yards a carry ${ypc.toFixed(2)}`);
  // (The completion bound is 69% since the quarterback looks first to the tight end in the flat on the Play-Action Shot
  // from I-Form, when as many rush as he has blockers: Mark set it on 2026-11-10, for that rule. See above.)
  assert.ok(comp > 0.52 && comp < 0.69, `completion rate ${comp.toFixed(3)}`);
  assert.ok(sack > 0.02 && sack < 0.06, `sack rate ${sack.toFixed(3)}`);
  assert.ok(int > 0.01 && int < 0.05, `interception rate ${int.toFixed(3)}`);
});

test('the README\'s matchups', () => {
  // The README says four verticals hurt Cover 2 most, Smash beats Cover 2, Flood beats Cover 3, crossing routes get open
  // against Cover 1's man coverage, and runs struggle with more defenders in the box than blockers. Each cell is 420
  // snaps: every formation against every front, 15 snaps each, a blitz on one in four. From four start seeds (2718,
  // 31415, 16180, 14142), with the Pistol, Gun Ace and Empty, Four Verticals gained 22.2-24.1 yards a dropback against
  // Cover 2 and 9.1-12.8 against Cover 3 and 4, Smash 14.0-14.7 against Cover 2 and 6.2-8.3 against Cover 3 and 4,
  // Flood 8.9-9.5 against Cover 3 and 4.8-8.5 against Cover 1 and 2 (its lead over Cover 1 was 0.4-1.5 yards, down from
  // at least 1.7 before those formations: from Gun Ace and the Pistol it did worst against Cover 3; since the Cover 3
  // curl-flat defender expands to a back in the flat, 11.1-11.8 against Cover 3, a lead of 2.6-3.8), a throw to Mesh's
  // crossers 10.9-12.2 yards against Cover 1 and 4.2-5.5 against Cover 3, and runs succeeded 32-33% of the time at even
  // numbers in the box and 19% with two more defenders than blockers; since the shotgun handoff read, the run-down
  // from behind and a tight end on the nickel back (version 2), 50-52% and 25-28%; with Counter among the runs, 52-54%
  // and 26-27%; with a deep safety fitting the run from depth (version 3), 55-57% and 22-26%. A change to the balance
  // that undoes one of these has to change the README with it.
  let seed = 2718;
  const won = r => (r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= 4;
  const cell = (play, coverage, each) => {
    for (const fm of FORMATIONS) for (const fr of FRONTS) for (let k = 0; k < 15; k++) {
      const call = { formation: fm.id, play, front: fr.id, coverage, pressure: k % 4 ? 'four' : 'blitz', flip: k % 2 === 1 };
      each(call, seed, simulate(call, seed)); seed++;
    }
  };
  // Yards a dropback, play against each coverage.
  const ypd = (play, covs) => {
    const out = {};
    for (const c of covs) { let y = 0, n = 0; cell(play, c, (call, s, P) => { y += P.result.yards; n++; }); out[c] = y / n; }
    return out;
  };
  const say = o => Object.entries(o).map(([c, y]) => `Cover ${c[1]} ${y.toFixed(1)}`).join(', ');
  const verts = ypd('verts', ['c2', 'c3', 'c4']), smash = ypd('smash', ['c2', 'c3', 'c4']), flood = ypd('flood', ['c1', 'c2', 'c3']);
  assert.ok(verts.c2 > verts.c3 && verts.c2 > verts.c4, `Four Verticals, yards a dropback: ${say(verts)}`);
  assert.ok(smash.c2 > smash.c3 && smash.c2 > smash.c4, `Smash, yards a dropback: ${say(smash)}`);
  assert.ok(flood.c3 > flood.c1 && flood.c3 > flood.c2, `Flood, yards a dropback: ${say(flood)}`);
  // How open the crossers get: what a throw to one of them gains.
  const crossers = {};
  for (const c of ['c1', 'c3']) {
    let cross = 0, yards = 0;
    cell('mesh', c, (call, s, P) => {
      const t = P.events.find(e => e.kind === 'throw');
      if (t && ['drag', 'drag6'].includes(prepare(call, s).P[t.who].job.route)) { cross++; yards += P.result.yards; }
    });
    crossers[c] = yards / cross;
  }
  assert.ok(crossers.c1 > crossers.c3, `a throw to Mesh's crossers gains ${crossers.c1.toFixed(1)} yards against Cover 1, ${crossers.c3.toFixed(1)} against Cover 3`);
  const box = { 0: [0, 0], 2: [0, 0] };
  for (const pl of PLAYS.filter(p => p.type === 'run')) for (const cv of COVERAGES) for (const fm of FORMATIONS) for (const fr of FRONTS) for (let k = 0; k < 3; k++) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
    const P = simulate({ formation: fm.id, play: pl.id, front: fr.id, coverage: cv.id, pressure: k % 4 ? 'four' : 'blitz', flip: k % 2 === 1 }, seed++);
    const b = box[P.box.box - P.box.blockers];
    if (b) { b[0]++; if (won(P.result)) b[1]++; }
  }
  const rate = d => box[d][1] / box[d][0];
  assert.ok(rate(2) < rate(0), `runs that succeed: ${(100 * rate(0)).toFixed(0)}% at even numbers in the box (${box[0][0]} runs), ${(100 * rate(2)).toFixed(0)}% with two more defenders than blockers (${box[2][0]})`);
});

// ---------------------------------------------------------------- the coach's read (js/read.js)

// The board's calls on defense, as the other coach can make them: what tools/read-table.mjs measures.
const theirCalls = () => {
  const out = [];
  for (const f of FRONTS) for (const c of COVERAGES) {
    if (c.id === 'c0') { out.push(`${f.id}.c0.blitz.M.0`); continue; }
    for (const d of c.id === 'c1' || c.id === 'c3' ? [0, 1] : [0]) {
      out.push(`${f.id}.${c.id}.four.M.${d}`);
      for (const b of BLITZERS) if (!blitzerFor(f.id, c.id, b.id, !!d)) out.push(`${f.id}.${c.id}.blitz.${b.id}.${d}`);
    }
  }
  return out;
};
const callOf = code => { const [front, coverage, pressure, blitzer, d] = code.split('.'); return { front, coverage, pressure, blitzer, disguise: d === '1' }; };
// The board before the snap, as the page hands it to the read (readView() in js/app.js): your call, the situation,
// their front, and everyone where he stands. With nobody in motion that's where prepare() lines them up.
const viewOf = (own, code, sit, quiz = false) => {
  const S = prepare({ ...own, motion: 'none', hot: {}, ...callOf(code), sit }, 1);
  return { side: 'O', ...own, motion: 'none', hot: {}, sit, front: callOf(code).front, quiz, players: S.P.map(p => ({ team: p.team, label: p.label, cls: p.cls, x: p.x, y: p.y })) };
};

test('the coach\'s read: its numbers were made for this version of the simulator, for every call and every play', () => {
  assert.equal(TABLE.sim, SIM_VERSION, `the simulator's version is ${SIM_VERSION}, and the coach's read's numbers were made for ${TABLE.sim}: run node tools/read-table.mjs`);
  assert.deepEqual(TABLE.calls, theirCalls(), 'the other coach\'s calls have changed: run node tools/read-table.mjs');
  for (const fm of FORMATIONS) {
    assert.deepEqual(TABLE.plays[fm.id], PLAYS.filter(p => !cantCall(fm.id, p.id)).map(p => p.id), `${fm.name}'s plays have changed: run node tools/read-table.mjs`);
    assert.equal(TABLE.cells[fm.id].length, TABLE.plays[fm.id].length * TABLE.calls.length * 4);
    if (fm.motion) assert.equal(TABLE.motion[fm.id].length, TABLE.plays[fm.id].length * TABLE.base.length * 4);
    assert.equal(TABLE.long[fm.id].length, TABLE.plays[fm.id].length * TABLE.base.length * 2, `${fm.name} has no long plays in the table: run node tools/read-table.mjs`);
    if (fm.motion) assert.equal(TABLE.longMotion[fm.id].length, TABLE.plays[fm.id].length * TABLE.base.length * 2);
    // the look each call shows, as the read sees it now
    TABLE.calls.forEach((code, i) => {
      const S = prepare({ formation: fm.id, play: TABLE.plays[fm.id][0], flip: false, ...callOf(code) }, 1);
      assert.equal(lookOf(S.P, callOf(code).front).key, TABLE.looks[fm.id][i], `${fm.name} against ${code}: the look has changed: run node tools/read-table.mjs`);
    });
  }
});

test('the coach\'s read: its numbers are the simulator\'s', () => {
  // A few cells snapped again with the table's own seeds come out exactly as it has them; with new seeds, within the
  // noise of 120 and 200 snaps (three and a half standard errors, and the table's rounding to 1/90).
  const NEED = [1, 2, 4, 8], code = n => TABLE.alpha[Math.round((n / TABLE.snaps) * (TABLE.alpha.length - 1))];
  const count = (call, seeds) => {
    const c = [0, 0, 0, 0];
    for (const seed of seeds) {
      const r = simulate(call(seed), seed).result, g = Math.sign(r.yards) * Math.round(Math.abs(r.yards));
      if (r.kind === 'run' || r.kind === 'catch') NEED.forEach((n, j) => { if (g >= n) c[j]++; });
    }
    return c;
  };
  const per = TABLE.snaps / TABLE.sets.length, mine = TABLE.sets.flatMap(b => Array.from({ length: per }, (_, k) => b + k));
  const cells = [['iform', 'smash', 'over.c2.four.M.0', '1and10', 'none'], ['trips', 'iz', 'nickel.c1.blitz.W.0', '3and2', 'none'], ['pistol', 'power', '34.c1.blitz.M.0', '1and10', 'motion']];
  for (const [formation, play, c, sit, mo] of cells) {
    const i = TABLE.calls.indexOf(c), k = TABLE.plays[formation].indexOf(play);
    const at = mo === 'motion' ? (k * TABLE.base.length + TABLE.base.indexOf(i)) * 4 : (k * TABLE.calls.length + i) * 4;
    const have = (mo === 'motion' ? TABLE.motion : TABLE.cells)[formation].slice(at, at + 4);
    const call = seed => ({ formation, play, flip: false, motion: mo === 'motion' ? (seed % 2 ? 'jet' : 'across') : 'none', hot: {}, ...callOf(c), sit });
    const got = count(call, mine);
    // (the 1- and 2-yard numbers for a run from the shotgun are from 3rd & 2: those are the ones this cell checks)
    const j = sit === '3and2' ? [0, 1] : [2, 3];
    for (const n of j) assert.equal(have[n], code(got[n]), `${formation} ${play} against ${c}${mo === 'motion' ? ' with motion' : ''}, ${NEED[n]} yards: the table has ${have[n]}, the simulator ${code(got[n])}`);
    const fresh = Array.from({ length: 200 }, (_, n) => 7e6 + n), again = count(call, fresh);
    for (const n of j) {
      const p = TABLE.alpha.indexOf(have[n]) / (TABLE.alpha.length - 1), q = again[n] / 200, pq = (p + q) / 2;
      const se = Math.sqrt(pq * (1 - pq) * (1 / TABLE.snaps + 1 / 200));
      assert.ok(Math.abs(p - q) < 3.5 * se + 1 / 90, `${formation} ${play} against ${c}, ${NEED[n]} yards: the table says ${p.toFixed(2)}, 200 new snaps ${q.toFixed(2)}`);
    }
  }
});

test('the coach\'s read: its long plays are the simulator\'s', () => {
  // How often a play went 15 yards or more, a run or a catch, against a call a defense can pick in its card: a few cells
  // snapped again with the table's own seeds come out exactly as it has them. A handoff from the shotgun is counted on
  // 3rd & 2 for a short third or fourth down (the table's first number) and on 1st & 10 for any other (its second).
  const code = n => TABLE.alpha[Math.round((n / TABLE.snaps) * (TABLE.alpha.length - 1))];
  const per = TABLE.snaps / TABLE.sets.length, mine = TABLE.sets.flatMap(b => Array.from({ length: per }, (_, k) => b + k));
  const cells = [['iform', 'pa', 'over.c0.blitz.M.0', '1and10', 'none'], ['trips', 'iz', 'nickel.c2.four.M.0', '3and2', 'none'], ['pistol', 'oz', '34.c3.four.M.0', '1and10', 'motion']];
  for (const [formation, play, c, sit, mo] of cells) {
    const b = TABLE.base.indexOf(TABLE.calls.indexOf(c)), k = TABLE.plays[formation].indexOf(play);
    const have = (mo === 'motion' ? TABLE.longMotion : TABLE.long)[formation][(k * TABLE.base.length + b) * 2 + (sit === '3and2' ? 0 : 1)];
    let n = 0;
    for (const seed of mine) {
      const r = simulate({ formation, play, flip: false, motion: mo === 'motion' ? (seed % 2 ? 'jet' : 'across') : 'none', hot: {}, ...callOf(c), sit }, seed).result;
      if ((r.kind === 'run' || r.kind === 'catch') && Math.round(r.yards) >= 15) n++;
    }
    assert.ok(b >= 0, `${c} isn't one of the calls a defense can pick`);
    assert.equal(have, code(n), `${formation} ${play} against ${c}${mo === 'motion' ? ' with motion' : ''} on ${sit}: 15 yards or more, the table has ${have}, the simulator ${code(n)} (${n} of ${TABLE.snaps})`);
  }
});

test('the coach\'s read goes only on what can be seen before the snap: calls that look alike get the same read', () => {
  // Every call the other coach can make against every formation, with the strength either side, on every down: the
  // read of a call is the read of every other call that looks the same before the snap (the same safeties deep, corners,
  // box and men walked up, in the same front), whatever was called. (No two of his calls line up exactly alike, to a
  // hundredth of a yard: a blitzer walks up a yard, a disguised corner stands half a yard nearer than a Cover 4 one; so
  // these are the pairs a quarterback can't tell apart, which takes in any that did.) With the question after the snap
  // on, it never names a coverage.
  let groups = 0, alike = 0, twins = 0;
  for (const fm of FORMATIONS) for (const flip of [false, true]) {
    const own = { formation: fm.id, play: 'smash', flip };
    const views = theirCalls().map(code => ({ code, v: viewOf(own, code, '1and10') }));
    const byLook = new Map(), bySpot = new Map();
    for (const x of views) {
      const k = `${x.v.front} ${lookOf(x.v.players, x.v.front).key}`, spot = `${x.v.front} ${x.v.players.filter(p => p.team === 'D').map(p => `${p.label}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')}`;
      byLook.set(k, [...(byLook.get(k) || []), x]);
      bySpot.set(spot, [...(bySpot.get(spot) || []), x]);
    }
    twins += [...bySpot.values()].filter(g => g.length > 1).length;
    for (const sit of SITUATIONS) for (const group of byLook.values()) {
      groups++;
      for (const quiz of [false, true]) {
        const first = JSON.stringify(coachRead({ ...group[0].v, sit: sit.id, quiz }));
        for (const x of group.slice(1)) {
          alike++;
          assert.equal(JSON.stringify(coachRead({ ...x.v, sit: sit.id, quiz })), first, `${fm.name}${flip ? ', strength left' : ''}, ${sit.name}: ${x.code} and ${group[0].code} look alike, and get different reads`);
        }
        if (quiz) assert.ok(!/Cover [0-4]/.test(first), `with the question on, the read names a coverage: ${first}`);
      }
    }
    // Calling the defense, the read is his formation and strong side's: every play he could run, with or without
    // motion, gets the same one.
    const reads = new Set(PLAYS.filter(p => !cantCall(fm.id, p.id)).map(() => JSON.stringify(coachRead({ side: 'D', formation: fm.id, flip, sit: '3and8', call: { front: 'over', coverage: 'c3', pressure: 'four', blitzer: 'M', disguise: false } }))));
    assert.equal(reads.size, 1);
  }
  assert.ok(alike > 5000, `${groups} looks, ${alike} calls compared with another that looks like them, ${twins} sets that line up exactly alike`);
});

test('the coach\'s read picks by the numbers: the top pick does at least as well as the next against the look', () => {
  for (const fm of FORMATIONS) for (const sit of SITUATIONS) {
    const own = { formation: fm.id, play: TABLE.plays[fm.id][0], flip: false };
    const seen = new Set();
    for (const code of theirCalls()) {
      const v = viewOf(own, code, sit.id), k = `${v.front} ${lookOf(v.players, v.front).key}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const R = coachRead(v), all = rankPlays(fm.id, lookAlikes(fm.id, v.front, lookOf(v.players, v.front).key, sit), sit);
      assert.equal(R.picks.length, Math.min(3, TABLE.plays[fm.id].length));
      R.picks.forEach((p, n) => assert.equal(p.set.play, all[n].id));
      // A run picked against more in the box than you can block says that usually makes a run hard (the board's word
      // for the box), rather than giving Inside Zone's reason for even numbers; a second run picked says it shorter.
      const L = lookOf(v.players, v.front);
      R.picks.filter(x => PLAYS.find(pl => pl.id === x.set.play).type === 'run').forEach((p, n) => {
        const why = `${fm.name}, ${sit.name}, ${k}: ${p.label}: ${p.reason}`;
        if (L.box > L.blockers && L.deep > 0) assert.match(p.reason, n ? /^It does well despite the (extra man|\w+ extra men) in the box too\./ : /more in the box than you can block, which usually makes a run hard/, why);
        if (L.box > L.blockers) assert.doesNotMatch(p.reason, /wants a blocker for every man/, why);
      });
      for (let n = 1; n < all.length; n++) assert.ok(all[n - 1].rate >= all[n].rate);
      // a look only one call shows: the top pick is the play that does best against that call
      const group = lookAlikes(fm.id, v.front, lookOf(v.players, v.front).key, sit);
      if (group.length === 1) assert.equal(R.picks[0].rate, Math.max(...TABLE.plays[fm.id].map(id => rate(fm.id, id, group[0].call, sit))));
    }
    // Calling the defense: the best call, then the best of each other coverage and rush, so the three aren't one call
    // from three fronts.
    const D = coachRead({ side: 'D', formation: fm.id, flip: false, sit: sit.id, call: {} }), all = rankDefenses(fm.id, sit);
    for (let n = 1; n < all.length; n++) assert.ok(all[n - 1].score >= all[n].score);
    const kind = code => code.split('.').slice(1, 3).join(), best = [];
    for (const x of all) if (best.length < 3 && !best.some(y => kind(y.code) === kind(x.code))) best.push(x);
    assert.deepEqual(D.picks.map(p => `${p.set.front}.${p.set.coverage}.${p.set.pressure}.M.0`), best.map(x => x.code));
    assert.equal(D.picks[0].rate, all[0].rate);
  }
});

test('calling the defense, the read counts the long plays a call gives up against it', () => {
  // A call ranks by how often it holds his plays short of a success, less how often one goes 15 yards or more against
  // it, each over the plays he runs from that formation and as often as he sends a man in motion, read here straight
  // from the table. By holding plays short alone, Cover 0 (nobody deep) came first for most formations and downs: it
  // stops the most plays short and gives up the most long ones.
  const val = ch => TABLE.alpha.indexOf(ch) / (TABLE.alpha.length - 1), col = sit => [1, 2, 4, 8].indexOf(needed(sit));
  let zeroHeld = 0, zeroNow = 0, moved = 0;
  for (const fm of FORMATIONS) for (const sit of SITUATIONS) {
    const L = lean(sit), plays = playMix(fm.id, L), m = motionShare(fm.id, L);
    const calls = TABLE.base.map((call, b) => {
      let held = 0, long = 0;
      for (const [id, p] of plays) {
        const k = TABLE.plays[fm.id].indexOf(id), at = (k * TABLE.base.length + b) * 2 + (needed(sit) <= 2 ? 0 : 1);
        const still = val(TABLE.cells[fm.id][(k * TABLE.calls.length + call) * 4 + col(sit)]), lstill = val(TABLE.long[fm.id][at]);
        const moving = m ? val(TABLE.motion[fm.id][(k * TABLE.base.length + b) * 4 + col(sit)]) : 0, lmoving = m ? val(TABLE.longMotion[fm.id][at]) : 0;
        held += p * ((1 - m) * (1 - still) + m * (1 - moving));
        long += p * ((1 - m) * lstill + m * lmoving);
      }
      return { code: TABLE.calls[call], held, long };
    });
    const top = (f) => calls.reduce((a, x) => (f(x) > f(a) ? x : a));
    const byHeld = top(x => x.held), byBoth = top(x => x.held - x.long);
    const D = coachRead({ side: 'D', formation: fm.id, flip: false, sit: sit.id, call: {} });
    const why = `${fm.name}, ${sit.name}`;
    assert.equal(`${D.picks[0].set.front}.${D.picks[0].set.coverage}.${D.picks[0].set.pressure}.M.0`, byBoth.code, `${why}: the first pick isn't the call that holds his plays short most, less his long plays`);
    assert.ok(Math.abs(D.picks[0].rate - byBoth.held) < 1e-9 && Math.abs(D.picks[0].long - byBoth.long) < 1e-9, why);
    assert.match(D.picks[0].rateText, /^(about \d\d?\stimes?\sin\s100|nearly every time|almost never); 15 yards or more (almost never|about \d\d?\sin\s100)$/, why);
    assert.match(D.picksTitle, /and how often he goes 15 yards or more against it:$/, why);
    if (byHeld.code.includes('.c0.')) zeroHeld++;
    if (byBoth.code.includes('.c0.')) zeroNow++;
    if (byHeld.code !== byBoth.code) moved++;
  }
  assert.ok(zeroNow < zeroHeld, `Cover 0 first for ${zeroNow} formations and downs, and ${zeroHeld} by holding plays short alone`);
  assert.ok(moved > 0, 'counting long plays moved no first pick');
});

test('calling the defense, no pick reads better than the one above it', () => {
  // A defense pick gives two numbers, how often it holds his plays short and how often he goes 15 yards or more against
  // it, and the picks are in order of the first less the second, before rounding. Each to the nearest 1 in 10, on 3rd &
  // 8 against Gun Ace the first pick, the 4-3 Over in Cover 4 rushing four, read "about 7 times in 10; 15 yards or more
  // about 1 in 10" and both under it "about 8 times in 10; 15 yards or more about 1 in 10": it's first for giving up far
  // fewer long plays, about 6 in 100 against 9 and 13. So did Gun Doubles' and the Pistol's. Out of 100, none does.
  // (read as so many in 100, whether it says in 10 or in 100)
  const nums = t => {
    const m = t.match(/^(?:about (\d+)\stimes?\sin\s(10|100)|(nearly every time)|almost never); 15 yards or more (?:about (\d+)\sin\s(10|100)|almost never)$/);
    assert.ok(m, t);
    return [m[3] ? 100 : (+m[1] || 0) * (100 / (+m[2] || 100)), (+m[4] || 0) * (100 / (+m[5] || 100))];
  };
  let pairs = 0;
  for (const fm of FORMATIONS) for (const sit of SITUATIONS) {
    const D = coachRead({ side: 'D', formation: fm.id, flip: false, sit: sit.id, call: {} });
    for (let n = 1; n < D.picks.length; n++) {
      const [h0, l0] = nums(D.picks[n - 1].rateText), [h1, l1] = nums(D.picks[n].rateText);
      pairs++;
      assert.ok(!(h1 >= h0 && l1 <= l0 && (h1 > h0 || l1 < l0)), `${fm.name}, ${sit.name}: "${D.picks[n].label}" (${D.picks[n].rateText}) reads better than "${D.picks[n - 1].label}" above it (${D.picks[n - 1].rateText})`);
    }
  }
  assert.ok(pairs >= 60, `${pairs} picks under another`);
});
