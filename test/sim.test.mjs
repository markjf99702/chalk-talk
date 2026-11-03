// Unit tests for the simulator:  node --test test/sim.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { simulate, prepare, name, hotRoutes, cantCall, blitzerFor, SIM_VERSION } from '../js/sim.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, NOTES, ROUTES, SIDELINE, DRILLS, HOT, BLITZERS } from '../js/playbook.js';
import { rng } from '../js/rng.js';

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
// blitzer, a disguise, motion and a hot route (a back's too) picked from a fixed seed. It's where every man and the ball
// was, a twentieth of a second at a time, who was blocking whom, and what happened (the play-by-play and the result, but
// not their words, which can change without the play changing). Keep the old ones: they say when the board changed.
// (Changing which snaps howItPlays() runs changes the print but not the simulator: then replace the current version's
// print, and leave SIM_VERSION as it is.)
const PRINTS = { 1: 'eecb1df0fce4', 2: '825f076d544f' };
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
      motion: fm.motion ? R.pick(['none', 'across', 'jet']) : 'none', hot,
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

test('Stick: the outside man clears out deep, the next one sits at five yards, and the flat goes under him', () => {
  const routes = (formation, flip) => { const S = prepare({ formation, play: 'stick', front: 'nickel', coverage: 'c3', pressure: 'four', flip }, 2); return [S, Object.fromEntries(S.O.filter(p => p.job.kind === 'route').map(p => [p.key || p.label, p.job.route]))]; };
  for (const flip of [false, true]) {
    const [T, trips] = routes('trips', flip), [, doubles] = routes('doubles', flip);
    assert.equal(T.play.id, 'stick');
    assert.deepEqual([trips.S1, trips.S2, trips.S3], ['go', 'stick', 'flat'], 'from three receivers: go, stick, flat');
    assert.deepEqual([doubles.S1, doubles.S2, doubles.RB], ['go', 'stick', 'bflat'], 'from two: the back runs the flat');
    assert.equal(T.reads[0].job.route, 'stick', 'the stick is his first read');
    const st = T.keys.S2, end = st.path.at(-1);
    assert.ok(end.y - st.y0 > 4 && end.y - st.y0 < 7 && ROUTES.stick.settle, `the stick sits down ${(end.y - st.y0).toFixed(1)} yards up`);
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
      const want = pl.scheme === 'power' ? (S.FB ? /^Handoff to the running back, behind the pulling guard\.$/ : /^Handoff to the running back, inside the pulling guard's kick-out\.$/) : RUN[pl.scheme];
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

test('a back\'s flat route and check-down end past the line, and Flood sends one back to the flat', () => {
  for (const fm of FORMATIONS) for (const pl of PLAYS.filter(p => p.type === 'pass')) for (const flip of [false, true]) {
    if (cantCall(fm.id, pl.id)) continue; // (Empty has no back: no runs, no fake, no screen)
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
  // Gun Ace and Empty.)
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
  }
  assert.ok(hotN / n > 0.4, `${hotN} hot throws in ${n} dropbacks against Cover 0`);
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
  // keep their timing: Slant-Flat's average throw is still out in about a second.
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
      // He crosses at his own depth, or between the line and the linebackers: never down on the line.
      for (const fr of r.frames.filter(x => x.t <= 0)) assert.ok(at(fr, had.i).y > 1.5, `${what}: his man is down on the line at ${fr.t}`);
    } else {
      assert.equal(r.motion.man, -1, what);
      for (const d of S.D) assert.ok(at(r.frames[0], d.i).x * at(snap, d.i).x > -2, `${what}: the ${d.label} crossed the field after him in a zone`);
      assert.equal(line.text, 'Nobody follows him: zone.', what);
    }
  }
});

test('the bump: when a cornerback goes across with the man in motion, the strong safety takes his place, and Outside Zone that way does about what it does without the motion', () => {
  // From I-Form and Singleback the Z goes in motion from the tight end's side, and in man coverage the cornerback on
  // him goes too. The strong safety slides over to the side they left, outside the tight end, at the snap (ahead of a
  // jet as well), and the play-by-play says so. In a zone the corner stays, and from the formations whose H goes in
  // motion it's never a cornerback who has him: no bump. Nor when the strong safety's own man is someone else, the
  // back or the other tight end: he stays where he can cover him. (Against the Nickel front with a blitz he can have
  // the back, or with the Will blitzing the far tight end.)
  let seed = 400, bumps = 0, stays = 0;
  for (const fm of FORMATIONS.filter(f => f.motion)) for (const coverage of ['c0', 'c1', 'c3']) for (const motion of ['across', 'jet']) for (const flip of [false, true]) for (const fr of FRONTS) {
    const call = { formation: fm.id, play: seed % 2 ? 'oz' : 'smash', front: fr.id, coverage, pressure: seed % 3 ? 'four' : 'blitz', blitzer: seed % 5 < 2 ? 'W' : 'M', flip, motion }, what = JSON.stringify(call);
    const S = prepare(call, seed), r = simulate(call, seed++), was = prepare({ ...call, motion: 'none' }, seed - 1);
    const mover = was.O.find(p => p.label === fm.motion.who), sd = Math.sign(mover.x), te = S.te(sd);
    const snap = r.frames.find(f => f.t === 0), x = snap.xy[2 * S.SS.i], j = S.SS.job;
    const line = r.events.find(e => e.kind === 'motion' && /the bump\.$/.test(e.text));
    if (fm.motion.who === 'Z' && coverage !== 'c3' && j.kind !== 'rush' && (j.kind !== 'man' || j.r === te)) {
      bumps++;
      assert.ok(Math.sign(x) === sd && Math.abs(x) >= Math.abs(te.x) + 1.5, `${what}: the strong safety is at ${x.toFixed(1)} at the snap, the tight end at ${te.x.toFixed(1)}`);
      assert.equal(line?.who, S.SS.i, `${what}: the play-by-play says the strong safety slides over`);
      assert.match(S.jobText[S.SS.i], /the bump/, what);
    } else {
      assert.ok(!line && !S.SS.bump, `${what}: a bump with no cornerback gone, or by a safety whose man is elsewhere`);
      // One whose man is the back or the far tight end lines up within reach of him, not out wide on the other side.
      if (fm.motion.who === 'Z' && j.kind === 'man') { stays++; assert.ok(Math.abs(x - j.r.x) < 6, `${what}: the strong safety has the ${j.r.label} but is at ${x.toFixed(1)} at the snap, ${Math.abs(x - j.r.x).toFixed(1)} yards from him`); }
    }
  }
  assert.ok(bumps >= 16 && stays >= 4, `${bumps} bumps and ${stays} safeties staying with a man elsewhere: the test should see both`);
  // Outside Zone, every front and pressure: from I-Form and Singleback against Cover 1 and Cover 0, the Z going across
  // first now gains within 4 yards a carry of what it gains without him going. (Before the bump it was 11 to 14 yards
  // more, and 5 more from Singleback against Cover 0: with the corner gone, nobody was left out there and about one run
  // in five went the distance. Over 1,152 snaps a cell it comes within 0.1-1.6 yards, and 0.4-2.8 since a back past
  // the line is run down from behind more often, which takes more off the runs without the motion.)
  seed = 1234;
  for (const [formation, coverage, k] of [['iform', 'c1', 20], ['single', 'c1', 20], ['iform', 'c0', 40], ['single', 'c0', 40]]) {
    const ypc = {};
    for (const motion of ['none', 'across']) {
      let y = 0, n = 0, s = seed;
      for (const fr of FRONTS) for (const pressure of coverage === 'c0' ? ['blitz'] : ['four', 'blitz']) for (let i = 0; i < k; i++) {
        y += simulate({ formation, play: 'oz', front: fr.id, coverage, pressure, flip: i % 2 === 1, motion }, s++).result.yards; n++;
      }
      ypc[motion] = y / n;
    }
    seed += 1000;
    assert.ok(Math.abs(ypc.across - ypc.none) < 4, `Outside Zone from ${formation} against Cover ${coverage[1]}: ${ypc.none.toFixed(1)} yards a carry, ${ypc.across.toFixed(1)} with the Z going across first`);
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
  // and more than half went past 60, where the board stops counting; now 20.9-23.1. (NFL 2023 regular season, designed
  // runs, from nflverse's play-by-play: 6.8, and 1 in 80 went 60.)
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

test('the drills\' notes say what the board shows', () => {
  // Each drill ends with a line in DRILLS (js/playbook.js) on what does best against its call; this holds the board to
  // it. The offense drills face their coverage from the front the drill sets (nickel against 10 and 11 personnel, the
  // 4-3 Over otherwise), every play from every formation that can run it, 25 snaps each; the run drill is I-Form's
  // runs, 50 snaps each, against the two calls its note names. Run as this test runs them from three start seeds (1,
  // 100000, 7777777), with the shotgun handoff read and the run-down from behind (version 2): against Cover 2, Four
  // Verticals 21.2-24.3 yards a play and Play-Action Shot 15.5-19.2, the next 14.7; Stick 82-85% and Slant-Flat 71-83%
  // succeed, the next 74%. Against Cover 3, Four Verticals 11.8-13.6 yards and Play-Action Shot 9.8-12.2, the next 8.9;
  // the Draw 71-78% and Slant-Flat 69-73%, the next 66%. Against Cover 0, the RB Screen 65-67%, then Smash, Slant-Flat
  // and Play-Action Shot 43-61%, the next 46%, and the Draw 3-5% and Power 9-12%, the next 21%. Against I-Form's runs,
  // the 4-3 Over in Cover 1 with a blitz stops 76-83% for 1.4-2.2 yards a run, and in Cover 0 79-87% for 4.3-8.4 (2.4-3.6
  // and 5.3-9.8 before the run-down).
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
  assert.deepEqual(top(c2, 'rate', 2), ['slants', 'stick'], `Cover 2, success: ${say(c2, 'rate')}`);
  for (const id of ['slants', 'stick']) assert.ok(c2[id].rate > 0.72 && c2[id].rate < 0.88, `"about four times in five": ${say(c2, 'rate')}`);
  const c3 = by(drill('c3').coverage, drill('c3').pressure);
  assert.deepEqual(top(c3, 'avg', 2), ['pa', 'verts'], `Cover 3, yards a play: ${say(c3, 'avg')}`);
  assert.deepEqual(top(c3, 'rate', 2), ['draw', 'slants'], `Cover 3, success: ${say(c3, 'rate')}`);
  const c0 = by(drill('blitz').coverage, drill('blitz').pressure);
  assert.deepEqual(top(c0, 'rate', 1), ['screen'], `Cover 0, success: ${say(c0, 'rate')}`);
  for (const id of ['smash', 'slants', 'pa']) assert.ok(c0[id].rate > 0.38 && c0[id].rate < 0.62, `"about half the time each": ${say(c0, 'rate')}`);
  assert.deepEqual(Object.entries(c0).sort((a, b) => a[1].rate - b[1].rate).slice(0, 2).map(([id]) => id).sort(), ['draw', 'power'], `Cover 0, success: ${say(c0, 'rate')}`);
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
  assert.ok(one.stop > 0.72 && one.stop < 0.88, `"about four runs in five": ${both}`);
  assert.ok(Math.abs(zero.stop - one.stop) < 0.1 && zero.avg > one.avg + 2, `"about as many, but the runs that get through go a long way": ${both}`);
  const S = prepare({ formation: drill('run').formation, play: 'iz', front: 'over', coverage: 'c1', pressure: 'blitz' }, 5);
  assert.deepEqual([S.box.box, S.box.blockers], [8, 7], '"eight against seven"');
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
  // before; with a tight end taking the nickel back near him, 4.00-4.99. This one gives 65.3%, 1.6% and 4.99.
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
  assert.ok(comp > 0.52 && comp < 0.66, `completion rate ${comp.toFixed(3)}`);
  assert.ok(sack > 0.02 && sack < 0.06, `sack rate ${sack.toFixed(3)}`);
  assert.ok(int > 0.01 && int < 0.05, `interception rate ${int.toFixed(3)}`);
});

test('the README\'s matchups', () => {
  // The README says four verticals hurt Cover 2 most, Smash beats Cover 2, Flood beats Cover 3, crossing routes get open
  // against Cover 1's man coverage, and runs struggle with more defenders in the box than blockers. Each cell is 420
  // snaps: every formation against every front, 15 snaps each, a blitz on one in four. From four start seeds (2718,
  // 31415, 16180, 14142), with the Pistol, Gun Ace and Empty, Four Verticals gained 22.2-24.1 yards a dropback against
  // Cover 2 and 9.1-12.8 against Cover 3 and 4, Smash 14.0-14.7 against Cover 2 and 6.2-8.3 against Cover 3 and 4,
  // Flood 8.9-9.5 against Cover 3 and 4.8-8.5 against Cover 1 and 2 (its lead over Cover 1 is 0.4-1.5 yards, down from
  // at least 1.7 before those formations: from Gun Ace and the Pistol it does worst against Cover 3), a throw to Mesh's
  // crossers 10.9-12.2 yards against Cover 1 and 4.4-5.5 against Cover 3, and runs succeeded 32-33% of the time at even
  // numbers in the box and 19% with two more defenders than blockers; since the shotgun handoff read, the run-down
  // from behind and a tight end on the nickel back (version 2), 51-52% and 25-28%. A change to the balance that undoes
  // one of these
  // has to change the README with it.
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
