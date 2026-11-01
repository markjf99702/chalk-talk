// The play simulator. prepare() lines both teams up and hands out every assignment; simulate() runs the snap a
// twentieth of a second at a time and records where everyone is, plus what happened, for the board to play back.
// It is a coaching model, not physics: blocks are pairs that push each other until one wins, coverage is
// men following receivers or defenders guarding spots, and the quarterback throws where nobody can get to first.
import { rng } from './rng.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, ZONES, ROUTES, SIDELINE } from './playbook.js';

export const DT = 0.05;
const MAX_T = 9;
const EDGE = SIDELINE - 0.4;

// Top speed (yards a second), acceleration, and strength, by body type.
const BODY = {
  qb: [7.4, 13, 0.45], rb: [8.9, 16, 0.6], fb: [7.9, 13, 0.85], wr: [9.1, 16, 0.4], te: [8.1, 13, 0.8], ol: [5.8, 10, 1],
  dl: [6.6, 11, 1], de: [7.6, 12, 0.92], lb: [8.1, 14, 0.78], cb: [9.0, 16, 0.42], s: [8.7, 15, 0.55],
};

const hyp = Math.hypot;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dist = (a, b) => hyp(a.x - b.x, a.y - b.y);
const unit = (x, y) => { const l = hyp(x, y); return l > 1e-9 ? [x / l, y / l] : [0, 0]; };
const byId = (list, id) => list.find(x => x.id === id) || list[0];

// Optimal one-to-one assignment by dynamic programming over subsets of `b` (small lists only).
// Each item of `a` takes one item of `b` or none (at skip(a)); returns an array: index into b, or -1.
function assign(a, b, cost, skip = () => 3) {
  const M = 1 << b.length;
  let dp = new Float64Array(M).fill(Infinity);
  dp[0] = 0;
  const par = [];
  for (let i = 0; i < a.length; i++) {
    const nd = new Float64Array(M).fill(Infinity), pj = new Int16Array(M).fill(-2), pm = new Int32Array(M);
    const sk = skip(a[i]);
    for (let m = 0; m < M; m++) {
      const v = dp[m];
      if (v === Infinity) continue;
      if (v + sk < nd[m]) { nd[m] = v + sk; pj[m] = -1; pm[m] = m; }
      for (let j = 0; j < b.length; j++) {
        if (m & (1 << j)) continue;
        const c = cost(a[i], b[j]);
        if (!(c < Infinity)) continue;
        const n = m | (1 << j);
        if (v + c < nd[n]) { nd[n] = v + c; pj[n] = j; pm[n] = m; }
      }
    }
    par.push([pj, pm]);
    dp = nd;
  }
  let m = 0;
  for (let k = 1; k < M; k++) if (dp[k] < dp[m]) m = k;
  const out = new Array(a.length).fill(-1);
  for (let i = a.length - 1; i >= 0; i--) {
    const [pj, pm] = par[i];
    out[i] = pj[m] >= 0 ? pj[m] : -1;
    m = pm[m];
  }
  return out;
}

function mk(S, team, label, cls, x, y) {
  const [top, acc, str] = BODY[cls];
  const R = S.R;
  const p = {
    i: S.P.length, team, label, cls, info: label, x, y, x0: x, y0: y, vx: 0, vy: 0, tx: x, ty: y, ts: 0,
    top: top * (1 + R.normal() * 0.03), acc, str: str * (1 + R.normal() * 0.08),
    eng: -1, job: { kind: 'none' }, hist: [], missUntil: -1, tried: -9, lostTo: -1, noEngage: -1, path: null, wp: 0,
  };
  S.P.push(p);
  (team === 'O' ? S.O : S.D).push(p);
  return p;
}

// ---------------------------------------------------------------- lining up

export function prepare(call, seed = 1) {
  const R = rng(seed);
  const fm = byId(FORMATIONS, call.formation), play = byId(PLAYS, call.play);
  const front = byId(FRONTS, call.front), cov = byId(COVERAGES, call.coverage);
  const f = call.flip ? -1 : 1;
  const S = {
    R, seed, call: { ...call }, fm, play, front, cov, s: f, p: f, P: [], O: [], D: [], t: 0, events: [],
    blitz: call.pressure === 'blitz' || cov.id === 'c0', over: false, endAt: Infinity, result: null,
    ball: { x: 0, y: -0.3, z: 0.3, state: 'snap', holder: -1 }, carrier: null, handT: Infinity, throwT: Infinity,
  };
  for (const [label, x, y, cls] of fm.players) mk(S, 'O', label, cls, x * f, y);
  for (const p of S.O) if (p.label === 'Y' && p.cls === 'wr') p.info = 'Yslot';
  S.QB = S.O.find(p => p.cls === 'qb');
  S.RB = S.O.find(p => p.cls === 'rb');
  S.FB = S.O.find(p => p.cls === 'fb');
  S.OL = S.O.filter(p => p.cls === 'ol');
  // The line is named from where each man stands, so with the strength on the left the left tackle is still on the
  // left. (The formation mirrors; the names don't.)
  S.OL.slice().sort((a, b) => a.x - b.x).forEach((o, k) => { o.label = o.info = ['LT', 'LG', 'C', 'RG', 'RT'][k]; });
  const elig = S.O.filter(p => p.cls === 'wr' || p.cls === 'te');
  const side = sg => elig.filter(p => Math.sign(p.x) === sg).sort((a, b) => Math.abs(b.x) - Math.abs(a.x));
  S.strongList = side(f);
  S.weakList = side(-f);
  S.keys = { RB: S.RB, FB: S.FB };
  S.strongList.forEach((p, n) => { S.keys['S' + (n + 1)] = p; p.num = n + 1; p.side = f; p.key = 'S' + (n + 1); });
  S.weakList.forEach((p, n) => { S.keys['W' + (n + 1)] = p; p.num = n + 1; p.side = -f; p.key = 'W' + (n + 1); });
  S.te = sg => elig.find(p => p.cls === 'te' && Math.sign(p.x) === sg && p.y > -1 && Math.abs(p.x) < 6);
  S.ends = { [1]: S.te(1), [-1]: S.te(-1) }; // a tight end on the line at the snap, each side
  buildDefense(S);
  assignOffense(S);
  S.pre = S.P.map(p => ({ x: p.x, y: p.y }));
  // Who is in the protection at the snap: blockers, and backs who check for a blitzer before they go out.
  S.protection = S.play.type === 'pass' ? S.O.filter(p => ['pro', 'screenOL', 'fake'].includes(p.job.kind) || (p.job.kind === 'route' && p.job.delay && p.job.route !== 'screen')) : [];
  S.box = boxCount(S);
  S.jobText = S.P.map(pl => describeJob(S, pl));
  S.overlay = overlay(S);
  return S;
}

function buildDefense(S) {
  const s = S.s, R = S.R, front = S.front, cov = S.cov;
  const teS = S.te(s), teW = S.te(-s);
  const techX = (t, sd) => {
    const te = sd === s ? teS : teW;
    return sd * ({ 0: 0, 1: 0.7, 3: 2.2, 5: 3.75, w5: te ? 3.9 : 4.7 })[t];
  };
  for (const [label, tech, sk] of front.dl) {
    const sd = sk === 'S' ? s : -s;
    const d = mk(S, 'D', label, label === 'DE' ? 'de' : 'dl', techX(tech, sd), 0.75);
    d.tech = tech; d.dl = true; d.side = sd;
  }
  for (const [label, rule] of front.lb) {
    let x, y;
    if (Array.isArray(rule)) [x, y] = [rule[0] * s, rule[1]];
    else if (rule === 'sam') [x, y] = teS ? [teS.x + 0.9 * s, 4.2] : [4.4 * s, 4.6];
    else if (rule === 'samUp' || rule === 'edgeS') [x, y] = teS ? [teS.x + 1.2 * s, 1] : [5.6 * s, 1];
    else if (rule === 'edgeW') [x, y] = teW ? [teW.x - 1.2 * s, 1] : [-5.6 * s, 1];
    const d = mk(S, 'D', label, 'lb', x, y);
    if (front.id === '34' && label === 'S') d.info = 'S34';
    d.edge = typeof rule === 'string' && rule !== 'sam';
    d.side = Math.sign(x) || s;
  }
  const left = S.O.filter(p => p.num === 1 && p.x < 0)[0], right = S.O.filter(p => p.num === 1 && p.x > 0)[0];
  const cbL = mk(S, 'D', 'CB', 'cb', left.x, 6), cbR = mk(S, 'D', 'CB', 'cb', right.x, 6);
  cbL.over = left; cbR.over = right; cbL.side = -1; cbR.side = 1;
  const fs = mk(S, 'D', 'FS', 's', 0, 13), ss = mk(S, 'D', 'SS', 's', 0, 8);
  if (cov.shell === 2) { ss.x = 7.5 * s; ss.y = 12.5; fs.x = -7.5 * s; fs.y = 12.5; }
  else if (cov.shell === 1) { fs.x = -0.8 * s; fs.y = 13.5; [ss.x, ss.y] = teS ? [teS.x + 2.4 * s, 7] : [6 * s, 7.5]; }
  else { fs.x = -1 * s; fs.y = 9; ss.x = 5 * s; ss.y = 6.5; }
  let nb = null;
  if (front.db === 'nickel') {
    const r2 = S.keys.S2;
    nb = r2 && Math.abs(r2.x) > 6 ? mk(S, 'D', 'NB', 'cb', r2.x - s, 4.5) : mk(S, 'D', 'NB', 'cb', teS ? teS.x + 3 * s : 6.5 * s, 5);
  }
  S.CB = [cbL, cbR]; S.FS = fs; S.SS = ss; S.NB = nb;
  const lab = l => S.D.find(d => d.label === l && !d.dl);

  // Who rushes.
  const rush = new Set(S.D.filter(d => d.dl));
  if (front.id === '34') rush.add(lab('J'));
  if (S.blitz) rush.add(lab('M'));
  const jobs = new Map();
  const left2 = S.O.filter(p => p.x < 0 && p.num === 2)[0], right2 = S.O.filter(p => p.x > 0 && p.num === 2)[0];

  if (cov.man) {
    const recvs = S.O.filter(p => p.num || p.cls === 'rb' || p.cls === 'fb');
    jobs.set(cbL, { kind: 'man', r: left, press: cov.press });
    jobs.set(cbR, { kind: 'man', r: right, press: cov.press });
    const rest = recvs.filter(r => r !== left && r !== right);
    const pool = S.D.filter(d => !rush.has(d) && !d.cls.startsWith('d') && d.cls !== 'dl' && d !== cbL && d !== cbR && !(cov.id === 'c1' && d === fs));
    const fit = { wr: { cb: 0, s: 1, lb: 4.5 }, te: { cb: 1.5, s: 0, lb: 0.5 }, rb: { cb: 4, s: 2, lb: 0 }, fb: { cb: 4, s: 2, lb: 0 } };
    const pick = assign(rest, pool, (r, d) => dist(r, d) + fit[r.cls][d.cls], () => 50);
    const used = new Set();
    rest.forEach((r, k) => { if (pick[k] >= 0) { jobs.set(pool[pick[k]], { kind: 'man', r, press: false }); used.add(pool[pick[k]]); } });
    const left_ = pool.filter(d => !used.has(d));
    if (cov.id === 'c1') {
      jobs.set(fs, { kind: 'zone', z: ZONES.deepM3, zid: 'deepM3' });
      if (left_.length) { const rat = left_.sort((a, b) => hyp(a.x, a.y - 7) - hyp(b.x, b.y - 7))[0]; jobs.set(rat, { kind: 'zone', z: ZONES.rat, zid: 'rat' }); left_.splice(left_.indexOf(rat), 1); }
    }
    for (const d of left_) rush.add(d);
  } else {
    const roles = {
      CBL: cbL, CBR: cbR, FS: fs,
      SL: fs.x < ss.x ? fs : ss, SR: fs.x < ss.x ? ss : fs,
    };
    for (const [role, zid] of Object.entries(cov.deep)) jobs.set(roles[role], { kind: 'zone', z: ZONES[zid], zid });
    const zones = (S.blitz ? cov.blitzUnder : cov.under).slice();
    const pool = S.D.filter(d => !rush.has(d) && !jobs.has(d));
    // Line them up where they'd stand before matching: a curl-flat defender goes where the slot is.
    const pick = assign(zones, pool, (zid, d) => { const z = ZONES[zid]; return (hyp(d.x - z.at[0], d.y - z.at[1]) ** 2) / 10 + (d.cls === 'cb' && zid.startsWith('hook') ? 3 : 0); }, () => 99);
    zones.forEach((zid, k) => { if (pick[k] >= 0) jobs.set(pool[pick[k]], { kind: 'zone', z: ZONES[zid], zid }); });
    for (const d of pool) if (!jobs.has(d)) rush.add(d);
  }
  for (const d of rush) jobs.set(d, { kind: 'rush' });
  for (const d of S.D) d.job = jobs.get(d) || { kind: 'rush' };

  // Rush lanes: each rusher takes a gap. A blitzing linebacker takes an A gap nobody else has.
  const gapOf = d => {
    if (d.tech === '0') return 0.75 * s;
    if (d.tech === '1') return 0.75 * d.side;
    if (d.tech === '3') return 2.25 * d.side;
    if (d.tech === '5') return 3.9 * d.side;
    if (d.tech === 'w5') return 5.2 * d.side;
    return null;
  };
  const taken = [];
  for (const d of S.D) if (d.job.kind === 'rush' && d.dl) { d.job.gap = gapOf(d); taken.push(d.job.gap); }
  for (const d of S.D) if (d.job.kind === 'rush' && !d.dl) {
    if (d.edge) d.job.gap = 6 * Math.sign(d.x);
    else {
      const opts = [0.75, -0.75, 2.25, -2.25, 3.9, -3.9].map(g => g * s).filter(g => !taken.some(t => Math.abs(t - g) < 0.5));
      opts.sort((a, b) => Math.abs(a - d.x) - Math.abs(b - d.x));
      d.job.gap = opts[0] ?? d.x;
      taken.push(d.job.gap);
    }
    d.blitzer = !front.rush.includes(d.label); // the 3-4's Jack rushes on every down; a blitzer is anyone extra
  }

  // Final alignment, from each man's job.
  const shade = { c0: -0.7, c1: 0.7, c2: 1, c3: 0.8, c4: -0.4 }[cov.id];
  const depth = { c0: 1.3, c1: 1.3, c2: 4.5, c3: 7, c4: 7.5 }[cov.id];
  for (const cb of S.CB) {
    const r = cb.job.kind === 'man' ? cb.job.r : cb.over;
    cb.x = r.x + shade * Math.sign(r.x); cb.y = depth + (r.y < -1 ? 0.6 : 0);
  }
  const core = sd => { const te = S.te(sd); return te ? te.x : 3 * sd; };
  for (const d of S.D) {
    const j = d.job;
    if (d.cls === 'cb' && d !== S.NB) continue;
    if (j.kind === 'man') {
      const r = j.r;
      if (r.num && Math.abs(r.x) > 6) { d.x = r.x - Math.sign(r.x) * (cov.id === 'c1' ? 0.9 : 0.6); d.y = cov.id === 'c0' ? 2 : 3.6; }
      else if (r.cls === 'te' && d.edge && r.y > -1) { /* an edge man on the line takes the tight end from outside him, a 9-technique: he stays there */ }
      else if (r.cls === 'te') { d.x = r.x + Math.sign(r.x) * 0.5; d.y = d.cls === 'lb' ? 4 : 4.5; }
      else if (d.cls === 's') { d.x = clamp(r.x * 0.5 + d.x * 0.5, -6, 6); d.y = 6; }
      else if (d.edge) { d.y = 3; }
    } else if (j.kind === 'zone' && !j.z.deep && j.zid !== 'rat') {
      const sd = j.z.at[0] < 0 ? -1 : 1;
      const slot = sd < 0 ? left2 : right2;
      const wide = slot && Math.abs(slot.x) > 6;
      // The curl-flat or flat defender walks out to the apex, halfway to the slot; a nickel back with a hook zone
      // does too (in Cover 2 the corners have the flats). A safety with a hook zone stays inside him, deeper.
      if (wide && (j.zid.startsWith('cf') || j.zid.startsWith('flat') || (j.zid.startsWith('hook') && d.cls === 'cb'))) {
        d.x = (slot.x + core(sd)) / 2; d.y = 5;
      } else if (wide && j.zid.startsWith('hook') && d.cls === 's') { d.x = core(sd) + 1.5 * sd; d.y = 7.5; }
      else if (d.edge) { d.y = 2.5; }
      else if (d.cls === 's' && d.y > 9) { d.y = 8; }
    } else if (j.kind === 'zone' && j.zid === 'rat') { if (d.cls === 's') { d.x = -0.5 * s; d.y = 8; } }
    else if (j.kind === 'rush' && d.blitzer && !d.edge) { d.y = Math.max(3.4, d.y - 1.2); }
  }
  // Nobody stands on top of anybody.
  for (let k = 0; k < 4; k++) for (const a of S.D) for (const b of S.D) {
    if (a === b) continue;
    const dd = dist(a, b);
    if (dd < 1.3) { // two men on the very same spot step apart sideways, the first one in the list toward the left
      const [ux, uy] = dd > 0 ? unit(a.x - b.x, a.y - b.y) : [a.i < b.i ? -1 : 1, 0];
      a.x += ux * (1.3 - dd) / 2; b.x -= ux * (1.3 - dd) / 2; a.y += uy * (1.3 - dd) / 2; b.y -= uy * (1.3 - dd) / 2;
    }
    if (a.y < 0.6) a.y = 0.6;
  }
  for (const d of S.D) { d.x0 = d.x; d.y0 = d.y; d.tx = d.x; d.ty = d.y; }
  // How quickly each one reads the play. Linebackers react first; corners last.
  for (const d of S.D) {
    d.lag = (d.cls === 'lb' ? 0.4 : d.cls === 's' ? 0.5 : d.cls === 'cb' ? 0.6 : 0.2) + R.range(0, 0.3);
    // Deep defenders read the quarterback from a backpedal and turn late on anything thrown underneath them.
    d.react = (d.job.kind === 'man' ? 0.24 : d.job.z?.deep ? 0.36 : 0.2) + R.range(0, 0.16);
  }
}

// ---------------------------------------------------------------- the offense's assignments

function assignOffense(S) {
  const { play, p, R } = S;
  const QB = S.QB;
  const under = S.fm.under;
  if (play.type === 'run') return assignRun(S);
  const map = play.routes(S.keys);
  for (const [key, route] of Object.entries(map)) {
    const pl = S.keys[key];
    if (!pl || key === 'side') continue;
    if (route === 'block') { pl.job = { kind: 'pro' }; continue; }
    const r = ROUTES[route];
    // Backs run their routes to the side the play says (strong by default, the screen to the back's own side).
    let out = pl.side || S.s;
    if (pl.cls === 'rb' || pl.cls === 'fb') {
      out = route === 'screen' && !under ? Math.sign(pl.x) || S.s : (map.side === 'W' ? -S.s : S.s);
      if (pl.cls === 'fb' && (route === 'check' || route === 'bflat')) out = map.side === 'S' && route === 'bflat' ? S.s : -S.s;
      // A back set off to one side checks down on his own side, outside his own tackle, not across the pocket.
      if (route === 'check' && Math.abs(pl.x) > 0.5) out = Math.sign(pl.x);
    }
    pl.job = { kind: 'route', route, out, delay: r.delay || 0 };
    pl.path = r.pts.map(([o, u]) => ({ x: clamp(pl.x + o * out, -EDGE + 0.6, EDGE - 0.6), y: r.fromLine ? u : pl.y + u }));
  }
  for (const pl of S.O) if (pl.cls !== 'qb' && pl.cls !== 'ol' && pl.job.kind === 'none') pl.job = { kind: 'pro' };
  for (const ol of S.OL) ol.job = { kind: 'pro' };
  if (play.drop === 'screen') {
    const sd = S.RB.job.out;
    const rel = S.OL.filter(o => o.x * sd >= -0.1).sort((a, b) => a.x * sd - b.x * sd);
    rel.forEach((o, k) => { o.job = { kind: 'screenOL', at: { x: sd * (3.6 + k * 2.2), y: -0.2 + k * 0.8 }, go: 1.0 + k * 0.08 }; });
  }
  const drops = {
    quick: under ? [{ x: 0, y: -3.6 }] : [{ x: 0, y: -5.9 }],
    five: under ? [{ x: 0, y: -7.3 }] : [{ x: 0, y: -7.3 }],
    pa: under ? [{ x: 0.9 * p, y: -3.8 }, { x: 0, y: -8 }] : [{ x: 0.3 * p, y: -5 }, { x: -0.3 * p, y: -7.4 }],
    screen: under ? [{ x: 0, y: -8.4 }] : [{ x: 0, y: -8.2 }],
  };
  QB.path = drops[play.drop];
  QB.job = { kind: 'qb' };
  S.readAt = { quick: under ? 0.75 : 0.55, five: under ? 1.45 : 1.05, pa: under ? 1.85 : 1.5, screen: 1.75 }[play.drop];
  S.dwell = play.drop === 'quick' ? 0.32 : 0.5;
  if (play.drop === 'pa') {
    S.fakeEnd = under ? 0.85 : 0.65;
    const rb = S.RB;
    rb.job = { kind: 'fake', then: 'pro', aim: 1.7 * p };
  }
  passPro(S);
  // His reads, from what's left after the protection: a back who stays in to block isn't one.
  S.reads = play.reads.map(k => S.keys[k]).filter(r => r && r.job.kind === 'route');
  S.hold = { quick: 2.4, five: 3.6, pa: 3.9, screen: 2.6 }[play.drop];
}

// Pass protection: every rusher is somebody's if there are the men for it. The line takes the rushers nearest them,
// sliding when it has a man to spare: a guard takes the end so the tackle can widen to the man outside him. A back who
// stays in, or checks for a blitzer before his route, takes anyone left that he can reach, and stays in to block him.
// A rusher goes free only when they outnumber the men who can get to him. A lineman with nobody helps whoever needs it.
const FREE = 6; // what leaving a rusher free costs the line, against the yards each block asks a lineman to cover
function passPro(S) {
  const rushers = S.D.filter(d => d.job.kind === 'rush');
  const ol = S.OL.filter(o => o.job.kind === 'pro');
  const pick = assign(rushers, ol, (d, o) => {
    const dx = Math.abs(o.x - d.x);
    if (dx > 4.2 || (d.edge && Math.abs(d.x) - Math.abs(o.x) > 3)) return Infinity;
    return dx + (d.dl ? 0 : 0.8) + Math.max(0, d.y - 2) * 0.3;
  }, () => FREE);
  const taken = new Set();
  rushers.forEach((d, k) => { if (pick[k] >= 0) { ol[pick[k]].job.target = d; taken.add(d); } });
  const backs = S.O.filter(p => p.cls !== 'ol' && p.cls !== 'qb' && (p.job.kind === 'pro' || p.job.kind === 'fake' || (p.job.kind === 'route' && p.job.delay && p.job.route !== 'screen')));
  const left = rushers.filter(d => !taken.has(d));
  const pb = assign(backs, left, (b, d) => (Math.abs(b.x - d.x) > 9 ? Infinity : Math.abs(b.x - d.x)), () => 10);
  backs.forEach((b, k) => {
    if (pb[k] < 0) return;
    const d = left[pb[k]];
    taken.add(d);
    if (b.job.kind === 'route') { b.job = { kind: 'pro', target: d, stayed: b.job.route }; b.path = null; } // he sees his man coming and stays in
    else b.job.target = d;
  });
  S.freeRushers = rushers.filter(d => !taken.has(d));
  for (const o of S.OL) {
    const depth = { quick: 0.6, five: 1.4, pa: 1.2, screen: 1.4 }[S.play.drop] ?? 1.2;
    const extra = Math.abs(o.x) > 2 ? 0.9 : Math.abs(o.x) > 1 ? 0.25 : 0;
    o.set = { x: o.x * 1.15, y: o.y - depth - extra };
  }
  for (const b of S.O) if (b.cls !== 'ol' && b.cls !== 'qb') b.set = { x: b.cls === 'te' ? b.x * 1.05 : b.x * 0.6 + Math.sign(b.x || S.s) * 1.5, y: Math.min(b.y, -3.2) };
}

function assignRun(S) {
  const { play, p, R } = S;
  const under = S.fm.under;
  const QB = S.QB, RB = S.RB;
  const aimX = play.aim * p;
  S.aimX = aimX;
  RB.job = { kind: 'carry' };
  QB.job = { kind: 'qb' };
  if (play.scheme === 'draw') {
    QB.path = under ? [{ x: 0, y: -4.2 }] : [{ x: 0, y: -6.2 }];
    S.handAt = under ? 1.0 : 0.95;
    S.mesh = under ? { x: 0.5 * Math.sign(RB.x || -p), y: -4.6 } : { x: 0.7 * (Math.sign(RB.x) || -p), y: -6 };
    for (const o of S.OL) o.job = { kind: 'pro', draw: true };
    for (const pl of S.O) if (pl.num) pl.job = pl.cls === 'te' && pl.y > -1 ? { kind: 'pro', draw: true } : { kind: 'route', route: 'go', out: pl.side, delay: 0 };
    for (const pl of S.O) if (pl.job.kind === 'route') pl.path = ROUTES.go.pts.map(([o, u]) => ({ x: clamp(pl.x + o * pl.side, -EDGE, EDGE), y: pl.y + u }));
    if (S.FB) S.FB.job = { kind: 'pro' };
    passPro(S);
    return;
  }
  // Handoff: under center the quarterback opens to the play side; from the gun the back takes it in front of him.
  const wide = play.scheme === 'reach' ? 0.6 : 0;
  S.mesh = under ? { x: (0.9 + wide) * p, y: -3.7 } : { x: (0.5 + wide * 0.6) * p, y: -4.9 };
  QB.path = under ? [{ x: S.mesh.x - 0.3 * p, y: S.mesh.y + 0.7 }, { x: -2.5 * p, y: -5.5 }] : [{ x: 0.2 * p, y: -5 }, { x: -2.5 * p, y: -5.6 }];
  // WRs block the defensive back over them.
  const dbs = S.D.filter(d => d.cls === 'cb' || d.cls === 's');
  const wrs = S.O.filter(pl => pl.cls === 'wr' && Math.abs(pl.x) > 5.5);
  const wpick = assign(wrs, dbs, (w, d) => (Math.abs(w.x - d.x) < 5 ? dist(w, d) : Infinity), () => 40);
  wrs.forEach((w, k) => { w.job = { kind: 'stalk', target: wpick[k] >= 0 ? dbs[wpick[k]] : null }; });

  const blockers = S.O.filter(pl => pl.cls === 'ol' || (pl.cls === 'te' && Math.abs(pl.x) < 8) || pl.cls === 'fb');
  const taken = new Set(wrs.map(w => w.job.target).filter(Boolean));
  const box = S.D.filter(d => Math.abs(d.x) < 9 && d.y < 8.5 && !taken.has(d));
  const playG = S.OL.find(o => o.label === (p > 0 ? 'RG' : 'LG')), backG = S.OL.find(o => o.label === (p > 0 ? 'LG' : 'RG'));
  // The man the kick-out block is for: the first defender outside the last play-side blocker on the line. Never a
  // safety: nobody on a run is sent at one.
  const teP = S.te(p), edgeX = teP ? Math.abs(teP.x) : 3;
  const front7 = box.filter(d => d.cls !== 's');
  const outside = front7.filter(d => d.x * p > edgeX + 0.2 && d.y < 6).sort((a, b) => hyp(a.x - p * (edgeX + 1.5), a.y - 1.5) - hyp(b.x - p * (edgeX + 1.5), b.y - 1.5));
  const emol = outside[0] || front7.filter(d => d.y < 2 && d.x * p > 2.6).sort((a, b) => b.x * p - a.x * p)[0];
  S.emol = emol;
  for (const b of blockers) {
    let kind = play.scheme;
    if (b.cls === 'fb') kind = play.scheme === 'power' ? 'kick' : 'lead';
    // On Power the back-side guard pulls: to lead up through the hole for the linebacker, or, with no fullback to do
    // it (from the gun, or two tight ends on the line), to kick out the end himself.
    const pull = play.scheme === 'power' && b === backG;
    if (pull) kind = S.FB ? 'pull' : 'kick';
    b.job = { kind: 'block', scheme: kind, target: null, pull };
  }
  // Two levels, the way a line coach draws it. First the men on the line of scrimmage: each is the lineman's or tight
  // end's he lines up on, or in the gap that blocker is responsible for: on a zone the gap to his play side (an outside
  // zone reaches the man from there), so the back-side end is left for the cutback to beat; on Power the gap inside
  // him, blocking down. Then whoever is left over climbs to a linebacker. A safety is nobody's.
  const lean = { zone: 0.8, reach: 0.9, power: -0.9 };
  const reach = (b, d, far) => {
    const side = (d.x - b.x) * p; // how far he is toward the play side
    if (b.job.scheme !== 'power' && side < -0.5) return false; // a zone never blocks the backside gap
    if (b.job.scheme === 'power' && side > 1.9) return false; // Power blocks down, never out
    return Math.abs(d.x - b.x) <= far;
  };
  const gap = (b, d) => Math.abs(d.x - (b.x + p * lean[b.job.scheme]));
  const kicked = blockers.some(b => b.job.scheme === 'kick') ? emol : null; // the kick-out's man is his alone
  const onLine = box.filter(d => d.y < 2 && d !== kicked);
  const first = blockers.filter(b => lean[b.job.scheme] !== undefined);
  const p1 = assign(onLine, first, (d, b) => (reach(b, d, 3.5) ? gap(b, d) + Math.abs(d.x - b.x) * 0.3 + (b.cls === 'te' ? 0.4 : 0) : Infinity), () => 8);
  onLine.forEach((d, k) => { if (p1[k] >= 0) first[p1[k]].job.target = d; });
  // The second level. The pulling guard on Power, or the fullback leading on a zone, has the linebacker at the hole.
  // Then a lineman or a tight end with nobody on him climbs to the linebacker over him or on the back side of him (on
  // Power, the backside linebacker: the last of gap, down, backer).
  const climb = (list, cost) => {
    const backers = box.filter(d => d.cls === 'lb' && !blockers.some(b => b.job.target === d) && d !== kicked);
    const pk = assign(list, backers, cost, () => 5);
    list.forEach((b, k) => { if (pk[k] >= 0) b.job.target = backers[pk[k]]; });
  };
  const atHole = (b, d) => Math.abs(d.x - aimX) * 0.8 + Math.abs(d.y - 4.5) * 0.3;
  climb(blockers.filter(b => b.job.scheme === 'pull' || b.job.scheme === 'lead'), atHole);
  climb(blockers.filter(b => !b.job.target && lean[b.job.scheme] !== undefined), (b, d) => {
    const side = (d.x - b.x) * p;
    if (b.job.scheme === 'power' ? side > 1.9 : side < -3.5) return Infinity;
    return Math.abs(d.x - b.x) <= (b.cls === 'te' ? 3 : 4.5) ? Math.abs(d.x - (b.x + p * lean[b.job.scheme] * 0.3)) + Math.max(0, d.y - 2) * 0.25 : Infinity;
  });
  // A lineman with nobody left at either level takes a man on the line still free beside him: on a zone with no
  // linebacker on the back side, the backside tackle cuts off the end.
  const idle = blockers.filter(b => !b.job.target && lean[b.job.scheme] !== undefined), loose = onLine.filter(d => !blockers.some(b => b.job.target === d));
  const p3 = assign(idle, loose, (b, d) => (Math.abs(d.x - b.x) <= 2 ? Math.abs(d.x - b.x) : Infinity), () => 5);
  idle.forEach((b, k) => { if (p3[k] >= 0) b.job.target = loose[p3[k]]; });
  const kick = blockers.find(b => b.job.scheme === 'kick');
  if (kick) kick.job.target = emol || null;
  const blocked = new Set(blockers.map(b => b.job.target).filter(Boolean));
  S.unblocked = box.filter(d => !blocked.has(d));
  if (S.FB && play.scheme !== 'power') S.FB.job.lead = true;
}

// The box: from the end of the line on each side (a tight end within 8 yards of the ball, attached or on the wing, or
// else the tackle) out to 3 yards past it, and up to 8 yards deep. The blockers are the men a run hands blocks to
// (see assignRun): the line, the fullback and the tight ends within 8 yards. in: which defenders are in the box.
function boxCount(S) {
  const te = pl => pl.cls === 'te' && Math.abs(pl.x) < 8;
  const end = sd => Math.max(3, ...S.O.filter(pl => te(pl) && Math.sign(pl.x) === sd).map(pl => Math.abs(pl.x)));
  const edge = { [1]: end(1), [-1]: end(-1) };
  const inBox = S.D.filter(d => Math.abs(d.x) < edge[Math.sign(d.x) || 1] + 3 && d.y < 8);
  const blockers = S.O.filter(pl => pl.cls === 'ol' || te(pl) || pl.cls === 'fb').length;
  const high = S.D.filter(d => d.cls === 's' && d.y > 10.5).length;
  return { box: inBox.length, blockers, high, in: inBox.map(d => d.i) };
}

// ---------------------------------------------------------------- running the play

export function simulate(call, seed = 1) {
  const S = prepare(call, seed);
  const frames = [];
  record(S, frames);
  while (!S.over) {
    step(S);
    record(S, frames);
    if (!S.result && !(S.t < MAX_T + 1)) timeUp(S);
    if (S.t >= S.endAt) S.over = true;
  }
  if (!S.result) finish(S, 'time');
  // Of the rushers the protection left over before the snap, the ones nobody blocked before the throw or the sack.
  const cut = Math.min(S.throwT, S.result.t) + 1e-9;
  const cameFree = S.play.type === 'pass' ? (S.freeRushers || []).filter(d => !frames.some(f => f.t <= cut && f.eng[d.i] >= 0)).map(d => d.i) : [];
  return {
    seed, call: S.call, frames, events: S.events, result: S.result, box: S.box,
    unblocked: (S.unblocked || []).map(d => d.i), free: (S.freeRushers || []).map(d => d.i), cameFree, protection: S.protection.map(p => p.i),
    players: S.P.map(pl => ({ i: pl.i, team: pl.team, label: pl.label, cls: pl.cls, info: pl.info, x: S.pre[pl.i].x, y: S.pre[pl.i].y })),
    jobs: S.jobText, overlay: S.overlay,
  };
}

function record(S, frames) {
  const n = S.P.length, xy = new Float32Array(n * 2), eng = new Int8Array(n);
  for (let k = 0; k < n; k++) { xy[2 * k] = S.P[k].x; xy[2 * k + 1] = S.P[k].y; eng[k] = S.P[k].eng; }
  frames.push({ t: S.t, xy, eng, ball: [S.ball.x, S.ball.y, S.ball.z], c: S.carrier ? S.carrier.i : -1, air: S.ball.state === 'air' });
}

function ev(S, kind, text, extra = {}) { S.events.push({ t: +S.t.toFixed(2), kind, text: cap(text), ...extra }); }

function step(S) {
  S.t += DT;
  for (const pl of S.P) { pl.hist.push(pl.x, pl.y); if (pl.hist.length > 24) pl.hist.splice(0, 2); }
  if (S.dead) {
    for (const pl of S.P) { pl.tx = pl.x + pl.vx * 0.3; pl.ty = pl.y + pl.vy * 0.3; pl.ts = 0; pl.eng = -1; }
    integrate(S);
    const D = S.down;
    if (D) { // down over four frames, then still
      const k = Math.min(1, ++D.k / 4), c = D.c;
      c.x = D.from.x + (D.to.x - D.from.x) * k; c.y = D.from.y + (D.to.y - D.from.y) * k; c.vx = 0; c.vy = 0;
      if (D.by) { D.by.x = c.x + D.off.x; D.by.y = c.y + D.off.y; D.by.vx = 0; D.by.vy = 0; }
    }
    const b = S.ball;
    if (b.state === 'held') { const h = S.P[b.holder]; b.x = h.x + 0.15; b.y = h.y + 0.1; b.z = 0.8; } else b.z = Math.max(0, b.z - 0.6);
    return;
  }
  ballThink(S);
  for (const pl of S.O) offense(S, pl);
  for (const d of S.D) defense(S, d);
  engage(S);
  integrate(S);
  hole(S);
  contact(S);
}

// ---- the ball

function ballThink(S) {
  const b = S.ball, QB = S.QB;
  if (b.state === 'snap') {
    const tt = S.fm.under ? 0.1 : 0.32;
    const k = Math.min(1, S.t / tt);
    b.x = QB.x * k; b.y = -0.3 + (QB.y + 0.3) * k; b.z = 0.4 + Math.sin(k * Math.PI) * 0.4;
    if (k >= 1) { b.state = 'held'; b.holder = QB.i; S.carrier = QB; }
  } else if (b.state === 'held') {
    const h = S.P[b.holder];
    b.x = h.x + 0.15; b.y = h.y + 0.1; b.z = 1;
  } else if (b.state === 'air') {
    const k = Math.min(1, (S.t - b.t0) / b.tf);
    b.x = b.fx + (b.tx - b.fx) * k; b.y = b.fy + (b.ty - b.fy) * k;
    b.z = 1.8 + (b.peak) * Math.sin(k * Math.PI);
    if (k >= 1) arrive(S);
  }
}

function giveBall(S, pl) {
  S.ball.state = 'held'; S.ball.holder = pl.i; S.carrier = pl;
}

function ballSpeed(d) { return Math.min(26, 18 + d * 0.25); }

function throwTo(S, r, P, tf, why) {
  const QB = S.QB, b = S.ball, R = S.R;
  const d = hyp(P.x - QB.x, P.y - QB.y);
  // A rusher close by hurries the throw, except on the screen: the line let the rushers through on purpose, and the
  // quarterback lofts it over them to the back he knew would be there.
  const pressed = nearestRusher(S) < 2.6 && S.play.drop !== 'screen';
  const sd = 0.3 + d * (d > 25 ? 0.022 : 0.012) + (pressed ? 0.55 : 0);
  const tx = P.x + R.normal() * sd, ty = P.y + R.normal() * sd * 0.8;
  Object.assign(b, { state: 'air', fx: b.x, fy: b.y, tx, ty, t0: S.t, tf, peak: Math.min(9, d * 0.16), target: r ? r.i : -1, holder: -1 });
  S.carrier = null;
  S.throwT = S.t;
  S.target = r;
  S.pressedThrow = pressed;
  if (r) {
    r.catchAt = { x: tx, y: ty };
    ev(S, 'throw', `${name(S, QB, true)} throws to ${name(S, r)} on ${routeText(r.job.route)}${why ? ', ' + why : ''}.`, { who: r.i });
  }
}

function arrive(S) {
  const b = S.ball, R = S.R;
  const r = b.target >= 0 ? S.P[b.target] : null;
  const P = { x: b.tx, y: b.ty };
  if (!r) { b.state = 'dead'; ev(S, 'away', 'It lands out of bounds. Incomplete.'); return finish(S, 'throwaway'); }
  if (Math.abs(P.x) > SIDELINE) { b.state = 'dead'; ev(S, 'inc', `Thrown out of bounds, out of ${name(S, r)}'s reach. Incomplete.`, { who: r.i }); return finish(S, 'incomplete'); }
  const rd = dist(r, P);
  let near = null, nd = 99;
  for (const d of S.D) { const dd = dist(d, P); if (dd < nd) { nd = dd; near = d; } }
  if (rd > 1.5) {
    if (nd < 1.1 && R.chance(0.2)) { b.state = 'dead'; ev(S, 'int', `The throw is off target, and ${name(S, near)} picks it off.`, { who: near.i }); return finish(S, 'int', near); }
    b.state = 'dead'; ev(S, 'inc', `Off target: ${name(S, r)} can't get to it. Incomplete.`, { who: r.i }); return finish(S, 'incomplete');
  }
  if (nd < rd + 0.25 && nd < 1.0) {
    const pi = nd < rd - 0.2 ? 0.13 : 0.04;
    if (R.chance(pi)) { b.state = 'dead'; ev(S, 'int', `${cap(name(S, near))} jumps the route and intercepts it.`, { who: near.i }); return finish(S, 'int', near); }
    if (R.chance(0.7)) { b.state = 'dead'; ev(S, 'pbu', `${cap(name(S, near))} breaks it up.`, { who: near.i }); return finish(S, 'incomplete', near); }
  }
  // Deep balls are harder to catch: the ball comes over the shoulder and the defender is closing.
  const pc = (nd > 2.5 ? 0.95 : nd > 1.5 ? 0.88 : nd > 0.8 ? 0.72 : 0.5) - (P.y > 18 ? 0.2 : 0);
  if (!R.chance(pc - rd * 0.08)) {
    b.state = 'dead';
    ev(S, 'inc', nd < 1.5 ? `${cap(name(S, near))} gets a hand in, and it falls incomplete.` : `${cap(name(S, r))} drops it.`, { who: (nd < 1.5 ? near : r).i });
    return finish(S, 'incomplete', nd < 1.5 ? near : null);
  }
  r.x = P.x * 0.6 + r.x * 0.4; r.y = P.y * 0.6 + r.y * 0.4;
  r.vx *= 0.65; r.vy *= 0.65; // he has to secure it first
  giveBall(S, r);
  S.caught = true;
  r.job = { kind: 'run' };
  S.catchY = r.y;
  ev(S, 'catch', `Caught by ${name(S, r)} ${yardText(r.y)}${nd < 1.6 ? ', with ' + name(S, near) + ' right there' : ''}.`, { who: r.i });
  for (const pl of S.O) if (pl !== r && pl.job.kind === 'route') pl.job = { kind: 'convoy' };
}

function nearestRusher(S) {
  let m = 99;
  for (const d of S.D) if (d.eng < 0 && d.y < S.QB.y + 6) m = Math.min(m, dist(d, S.QB));
  return m;
}

// ---- offense

function offense(S, pl) {
  const t = S.t, j = pl.job;
  if (S.carrier === pl && (S.caught || pl.cls !== 'qb' || S.qbRun)) return carry(S, pl);
  switch (j.kind) {
    case 'qb': return qb(S, pl);
    case 'route': return route(S, pl);
    case 'pro': return pro(S, pl);
    case 'fake': return fake(S, pl);
    case 'carry': return toMesh(S, pl);
    case 'block': return runBlock(S, pl);
    case 'stalk': return stalk(S, pl);
    case 'screenOL': return screenOL(S, pl);
    case 'convoy': return convoy(S, pl);
    default: pl.tx = pl.x; pl.ty = pl.y; pl.ts = 0;
  }
}

function followPath(pl, speed) {
  if (!pl.path || pl.wp >= pl.path.length) { pl.tx = pl.x; pl.ty = pl.y; pl.ts = 0; return true; }
  let w = pl.path[pl.wp];
  if (hyp(w.x - pl.x, w.y - pl.y) < 0.7) { pl.wp++; if (pl.wp >= pl.path.length) { pl.tx = pl.x; pl.ty = pl.y; pl.ts = 0; return true; } w = pl.path[pl.wp]; }
  pl.tx = w.x; pl.ty = w.y; pl.ts = speed;
  // Slow into a sharp break.
  const nx = pl.path[pl.wp + 1];
  if (nx) {
    const d = hyp(w.x - pl.x, w.y - pl.y);
    const [ax, ay] = unit(w.x - pl.x, w.y - pl.y), [bx, by] = unit(nx.x - w.x, nx.y - w.y);
    const turn = Math.acos(clamp(ax * bx + ay * by, -1, 1));
    if (turn > 0.6 && d < 2) pl.ts = speed * (1 - 0.42 * Math.min(1, turn / 1.6));
  }
  return false;
}

function route(S, pl) {
  const j = pl.job, t = S.t;
  if (S.ball.state === 'air' && S.ball.target === pl.i) {
    pl.tx = S.ball.tx; pl.ty = S.ball.ty; pl.ts = pl.top; return;
  }
  if (t < j.delay && j.route === 'screen') { pl.tx = pl.set ? pl.set.x : pl.x; pl.ty = pl.set ? pl.set.y : pl.y; pl.ts = 2.5; return; }
  if (t < j.delay) { // a back checking for a blitzer first
    const free = S.D.find(d => d.job.kind === 'rush' && d.eng < 0 && dist(d, pl) < 4.5 && d.y < 3 && !S.O.some(o => o !== pl && o.eng === d.i));
    if (free || j.blocking) { j.blocking = true; pl.job = { kind: 'pro', target: free || j.target }; return pro(S, pl); }
    pl.tx = pl.set ? pl.set.x : pl.x; pl.ty = pl.set ? pl.set.y : pl.y; pl.ts = 3; return;
  }
  const done = followPath(pl, pl.top * 0.93);
  if (done && ROUTES[j.route]?.settle) {
    // Sit down in the window, away from the nearest defender.
    let near = null, nd = 99;
    for (const d of S.D) { const dd = dist(d, pl); if (dd < nd) { nd = dd; near = d; } }
    if (near && nd < 3 && !j.slid) { j.slid = true; pl.path.push({ x: clamp(pl.x + Math.sign(pl.x - near.x || 1) * 1.6, -EDGE, EDGE), y: pl.y - 0.3 }); }
  }
  if (S.caught && S.carrier !== pl) pl.job = { kind: 'convoy' };
}

function pro(S, pl) {
  const j = pl.job;
  const QB = S.QB;
  if (j.draw && S.carrier && S.carrier !== QB) { // after the draw handoff, get up the field on somebody
    pl.job = { kind: 'block', scheme: 'zone', target: pl.eng >= 0 ? S.P[pl.eng] : nearestFree(S, pl, 6) };
    return;
  }
  if (pl.eng >= 0) { pl.tx = pl.set?.x ?? pl.x; pl.ty = pl.set?.y ?? pl.y; return; }
  // pick up the rusher he has, or a free one coming through his area
  let tgt = j.target && j.target.eng < 0 && j.target.lostTo !== pl.i ? j.target : null;
  if (!tgt) {
    let best = null, bd = 3.2;
    for (const d of S.D) if (d.job.kind === 'rush' && d.eng < 0 && d.lostTo !== pl.i && d.noEngage < S.t) { const dd = dist(d, pl); if (dd < bd && d.y > pl.y - 1) { bd = dd; best = d; } }
    tgt = best;
  }
  const set = pl.set || { x: pl.x, y: pl.y - 1 };
  if (tgt) {
    // step to the spot between him and the quarterback
    const [ux, uy] = unit(QB.x - tgt.x, QB.y - tgt.y);
    pl.tx = clamp(tgt.x + ux * 1.0, set.x - 2.5, set.x + 2.5); pl.ty = Math.min(tgt.y + uy * 1.0, set.y + 1.2); pl.ts = pl.top * 0.75;
    pl.want = tgt;
  } else {
    pl.tx = set.x; pl.ty = set.y; pl.ts = pl.top * 0.6; pl.want = null;
  }
}

// A run blocker's pick-up: the nearest defender in front of him who is free, that no teammate is on his way to block.
// (near: whoever shows up right in front of him, even a teammate's man if that teammate is still a way off).
function pickUp(S, pl, range, near) {
  let best = null, bd = range;
  for (const d of S.D) {
    if (d.eng >= 0 || d.noEngage >= S.t || d.lostTo === pl.i || d.y < pl.y - 0.5) continue;
    const dd = dist(d, pl);
    if (dd < bd && !S.O.some(o => o !== pl && o.eng < 0 && o.job.target === d && d.lostTo !== o.i && (!near || dist(o, d) < 2))) { bd = dd; best = d; }
  }
  return best;
}

function nearestFree(S, pl, range) {
  let best = null, bd = range;
  for (const d of S.D) if (d.eng < 0 && d.noEngage < S.t && d.y > pl.y - 0.5) { const dd = dist(d, pl); if (dd < bd) { bd = dd; best = d; } }
  return best;
}

function qb(S, pl) {
  const t = S.t, play = S.play;
  const hasBall = S.ball.holder === pl.i && S.ball.state === 'held';
  followPath(pl, play.type === 'run' ? 5.5 : 6.2);
  if (play.type === 'run') {
    if (hasBall && S.RB && (dist(S.RB, pl) < 1.35 || t > 1.1) && t > (S.handAt || 0.25)) {
      giveBall(S, S.RB);
      S.handT = t;
      ev(S, 'hand', `Handoff to ${name(S, S.RB)}.`, { who: S.RB.i });
    }
    return;
  }
  if (!hasBall) return;
  if (S.fakeEnd && t < S.fakeEnd) return;
  if (S.fakeEnd && !S.faked) { S.faked = true; ev(S, 'fake', `Play-action fake to ${name(S, S.RB)}.`, { who: S.RB.i }); }
  // Under pressure: slide away from the nearest rusher.
  let rn = null, rd = 99;
  for (const d of S.D) if (d.eng < 0 && d.job.kind === 'rush') { const dd = dist(d, pl); if (dd < rd) { rd = dd; rn = d; } }
  if (rn && rd < 3 && t > 0.6) { const [ux] = unit(pl.x - rn.x, pl.y - rn.y); pl.tx = pl.x + ux * 2; pl.ty = pl.y + 0.3; pl.ts = 2; }
  if (t < S.readAt) {
    if (rd < 1.5 && t > 0.5) hurry(S, pl);
    return;
  }
  if (S.play.drop === 'screen') {
    const rb = S.RB;
    if (rb.job.kind === 'route' && (rb.wp >= rb.path.length - 1 || t > 2.2 || rd < 2)) { const w = windowFor(S, rb); throwTo(S, rb, w.P, w.tf, ''); }
    return;
  }
  // The progression: look at each read in turn. Wait for a route to make its cut, give it a beat, then move on.
  if (S.k === undefined) { S.k = 0; S.kAt = t; S.kReady = null; }
  const k = S.k;
  S.look = S.reads[Math.min(k, S.reads.length - 1)] || null;
  if (k < S.reads.length) {
    const r = S.reads[k];
    const ok = r && r.job.kind === 'route' && isReady(S, r);
    if (ok && S.kReady === null) S.kReady = t;
    if (ok) {
      const w = windowFor(S, r);
      // The farther down the field, the more room he wants before he lets it go.
      const need = 0.8 + clamp((w.P.y - 8) * 0.06, 0, 1) + S.R.normal() * 0.3;
      if (w.w > need) return throwTo(S, r, w.P, w.tf, readNote(S, k));
    }
    if ((S.kReady !== null && t - S.kReady > S.dwell) || t - S.kAt > 1.1 || !r || r.job.kind !== 'route') {
      if (r && !r.passed) { r.passed = true; S.passed = (S.passed || []).concat(r); }
      S.k++; S.kAt = t; S.kReady = null;
    }
  } else {
    // Past the last read: take the best thing there, or throw it away when time runs out.
    const best = bestWindow(S);
    if (best && best.w > 0.3) return throwTo(S, best.r, best.P, best.tf, 'after nothing else came open');
    if (t > S.hold) return throwAway(S, pl);
  }
  if (rd < 1.5) hurry(S, pl);
}

// Why he threw to read k: the reads before it are counted, not listed, so the caption stays short ("read 4, with the
// first three covered"); one before it is named ("read 2, after the H was covered").
const COUNT = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
function readNote(S, k) {
  const passed = (S.passed || []).filter(r => r !== S.reads[k]);
  if (k === 0) return 'his first read';
  if (k === 1 && passed.length === 1) return `read 2, after ${name(S, passed[0])} was covered`;
  return `read ${k + 1}, with ${passed.length === k ? 'the first' : `${COUNT[passed.length]} of the first`} ${COUNT[k]} covered`;
}

function isReady(S, r) {
  const R = ROUTES[r.job.route];
  if (S.t < (r.job.delay || 0) + 0.25) return false;
  return R.readyY ? r.y - r.y0 >= R.readyY : r.wp >= (R.ready ?? 1);
}

function bestWindow(S) {
  let best = null;
  for (const r of S.O) {
    if (r.job.kind !== 'route' || !isReady(S, r)) continue;
    const w = windowFor(S, r);
    if (!best || w.w > best.w) best = { ...w, r };
  }
  return best;
}

function hurry(S, pl) {
  const best = bestWindow(S);
  if (best && best.w > 0.9 + S.R.normal() * 0.6) return throwTo(S, best.r, best.P, best.tf, 'under pressure');
  if (S.R.chance(0.025)) return throwAway(S, pl);
}

function throwAway(S, pl) {
  const sd = pl.x >= 0 ? 1 : -1;
  const P = { x: sd * (SIDELINE + 3), y: Math.max(pl.y + 8, 4) };
  const d = hyp(P.x - pl.x, P.y - pl.y);
  S.ball.target = -1;
  throwTo(S, null, P, 0.1 + d / ballSpeed(d), '');
  ev(S, 'away', `${cap(name(S, pl, true))} throws it away.`, { who: pl.i });
}

// Where the receiver will be when the ball gets there, and how close anyone else can get by then.
function predict(r, tf) {
  let x = r.x, y = r.y, wp = r.wp;
  let left = Math.max(hyp(r.vx, r.vy), r.top * 0.8) * tf;
  const path = r.path || [];
  while (left > 0 && wp < path.length) {
    const w = path[wp], d = hyp(w.x - x, w.y - y);
    if (d <= left) { x = w.x; y = w.y; left -= d; wp++; } else { x += (w.x - x) / d * left; y += (w.y - y) / d * left; left = 0; }
  }
  return { x: clamp(x, -EDGE, EDGE), y };
}

function windowFor(S, r) {
  const QB = S.QB;
  let P = predict(r, 0.5), tf = 0.5;
  for (let k = 0; k < 3; k++) { const d = hyp(P.x - QB.x, P.y - QB.y); tf = 0.1 + d / ballSpeed(d); P = predict(r, tf); }
  let w = 9;
  for (const d of S.D) {
    if (d.job.kind === 'rush' && d.y < 3) continue;
    const react = d.react;
    const sx = d.x + d.vx * Math.min(react, tf), sy = d.y + d.vy * Math.min(react, tf);
    // A deep defender turning to come down, or an underneath one trying to get depth under a throw over his head,
    // covers less ground than a man running straight at the spot.
    const z = d.job.z;
    const k = z?.deep && P.y < d.y - 2 ? 0.8 : z && !z.deep && P.y > z.y[1] + 3 ? 0.55 : 0.9;
    const reach = d.top * k * Math.max(0, tf - react);
    w = Math.min(w, hyp(sx - P.x, sy - P.y) - reach);
    // Underneath defenders in the throwing lane can knock down a low throw.
    const [lx, ly] = [P.x - QB.x, P.y - QB.y], L2 = lx * lx + ly * ly;
    const u = clamp(((d.x - QB.x) * lx + (d.y - QB.y) * ly) / L2, 0, 1);
    if (u > 0.15 && u < 0.45) { const qx = QB.x + lx * u, qy = QB.y + ly * u; w = Math.min(w, hyp(d.x - qx, d.y - qy) * 1.4 - 0.3 + (L2 > 400 ? 2 : 0)); }
  }
  return { w, P, tf };
}

function fake(S, pl) {
  const t = S.t;
  if (t < (S.fakeEnd || 0.7) + 0.2) { pl.tx = S.aimX ?? 1.7 * S.p; pl.ty = -1.8; pl.ts = pl.top * 0.7; return; }
  pl.job = { kind: 'pro', target: pl.job.target }; // then blocks the man the protection gave him, if it gave him one
  pl.set = { x: pl.x, y: pl.y - 0.5 };
}

function toMesh(S, pl) {
  // Run plays: get to the mesh with the quarterback, then (once handed the ball) carry.
  const t = S.t, m = S.mesh;
  if (S.play.scheme === 'draw') {
    if (t < (S.handAt || 1) - 0.25) { pl.job.blocking = true; pl.tx = m.x; pl.ty = m.y + 0.6; pl.ts = 2.5; return; }
    pl.tx = S.QB.x + 0.4; pl.ty = S.QB.y + 0.4; pl.ts = 4; return;
  }
  if (S.fm.under && t < 0.08) { pl.tx = pl.x; pl.ty = pl.y; pl.ts = 0; return; }
  // Through the mesh with the quarterback, then on toward the aiming point.
  if (!pl.meshed && hyp(m.x - pl.x, m.y - pl.y) < 0.6) pl.meshed = true;
  if (!pl.meshed && pl.y < m.y - 0.3) { pl.tx = m.x; pl.ty = m.y; pl.ts = pl.top * 0.7; return; }
  pl.tx = S.aimX; pl.ty = 0.3; pl.ts = pl.top * 0.75;
}

function carry(S, c) {
  // A ball carrier picks the lane with the most room, staying on his track until the line.
  const run = S.play.type === 'run' && !S.caught;
  const track = run && c.y < -0.4 && S.t < (S.handT || 0) + 1.2;
  let best = -1e9, bx = 0, by = 1;
  const free = S.D.filter(d => d.eng < 0 && d.missUntil < S.t);
  const walls = S.P.filter(q => q.eng >= 0 && q !== c);
  for (let a = -80; a <= 80; a += 8) {
    const th = a * Math.PI / 180, dx = Math.sin(th), dy = Math.cos(th);
    let space = 7;
    for (const d of free) for (const s of [1, 2.5, 4.5]) {
      const px = c.x + dx * s, py = c.y + dy * s, tc = s / Math.max(5, c.top * 0.9);
      const g = hyp(d.x - px, d.y - py) - d.top * tc * 0.85;
      if (g < space) space = g;
    }
    for (const q of walls) for (const s of [0.8, 1.8]) {
      const g = hyp(q.x - (c.x + dx * s), q.y - (c.y + dy * s)) - 0.55;
      if (g < space) space = g;
    }
    const room = EDGE - 0.8 - Math.abs(c.x + dx * 4);
    let score = Math.min(space, 6) + dy * 2.3 + (room < 0 ? room * 2 : 0);
    if (track) { const [ax, ay] = unit(S.aimX - c.x, 0.6 - c.y); score += 1.6 * (dx * ax + dy * ay); }
    if (c.dir) score += 0.45 * (dx * c.dir[0] + dy * c.dir[1]);
    if (score > best) { best = score; bx = dx; by = dy; }
  }
  if (run && c.dir && !S.cutNoted && c.y > -2 && c.y < 2 && (bx * S.p < -0.45) && S.aimX * S.p > 0) { S.cutNoted = true; ev(S, 'cut', `${cap(name(S, c))} cuts it back against the flow.`, { who: c.i }); }
  c.dir = [bx, by];
  c.tx = c.x + bx * 3; c.ty = c.y + by * 3; c.ts = c.top * (S.caught ? 0.86 : 0.95);
}

function runBlock(S, pl) {
  const j = pl.job, t = S.t, p = S.p;
  if (pl.eng >= 0) return;
  let tgt = j.target;
  if (tgt && (tgt.eng >= 0 && tgt.eng !== pl.i || tgt.lostTo === pl.i || dist(tgt, pl) > 9 || tgt.noEngage > t)) tgt = null;
  // With nobody to block, or once his man is gone (somebody else has him, or he got off this block), he takes whoever
  // comes free near him: never a man a teammate is on his way to.
  const lead = j.scheme === 'lead' || j.scheme === 'pull' || j.scheme === 'kick';
  if (!tgt && (t > 0.5 || !j.target)) { tgt = pickUp(S, pl, j.target || lead ? 4 : 2.5); if (tgt) j.target = tgt; }
  // On his way up to a linebacker, he blocks whoever shows up in front of him first.
  if (tgt && tgt.y0 > 2 && dist(tgt, pl) > 2) {
    const near = pickUp(S, pl, 1.6, true);
    if (near && near !== tgt) { tgt = near; j.target = near; }
  }
  if (j.pull && t < 0.55) { // the pulling guard: step back and run along the line
    pl.tx = pl.x0 + p * 4; pl.ty = -1.8; pl.ts = pl.top * 0.85; return;
  }
  if (!tgt) { // nobody yet: a lead blocker goes to the hole, a lineman to his play-side gap, each looking for work
    if (lead) { pl.tx = S.aimX; pl.ty = Math.min(pl.y + 2, 2); pl.ts = pl.top * 0.85; } else { pl.tx = pl.x0 + p * 1.2; pl.ty = Math.min(pl.y + 1.5, 2.5); pl.ts = 2.5; }
    return;
  }
  pl.tx = tgt.x + tgt.vx * 0.2; pl.ty = tgt.y + tgt.vy * 0.2 - 0.3;
  if (j.scheme === 'reach' && tgt.y < 2) pl.tx = tgt.x + p * 1.2;
  if (tgt.y > pl.y + 1.5) { // a linebacker coming downhill: get in his path to the ball, not behind him
    const ball = S.carrier && S.carrier !== S.QB ? S.carrier : { x: S.aimX, y: 0 };
    const [ux, uy] = unit(ball.x - tgt.x, ball.y - tgt.y), k = Math.min(1.5, dist(tgt, pl) * 0.4);
    pl.tx = tgt.x + ux * k; pl.ty = tgt.y + uy * k;
  }
  pl.ts = pl.top * (pl.cls === 'ol' ? 0.9 : 0.95);
}

function stalk(S, pl) {
  const j = pl.job;
  if (pl.eng >= 0) return;
  const tgt = j.target && j.target.eng < 0 && j.target.lostTo !== pl.i ? j.target : nearestFree(S, pl, 5);
  if (!tgt) { pl.tx = pl.x; pl.ty = pl.y + 2; pl.ts = 3; return; }
  j.target = tgt;
  pl.tx = tgt.x; pl.ty = tgt.y - 0.4; pl.ts = pl.top * 0.8;
}

function screenOL(S, pl) {
  const j = pl.job, t = S.t;
  if (t < j.go) { pl.job.kind = 'pro'; pro(S, pl); pl.job.kind = 'screenOL'; return; }
  if (!j.released) { // let his man go and forget him: the rushers run on past the back, and the linemen block downfield
    if (pl.eng >= 0) release(S, pl, S.P[pl.eng], true);
    j.released = true; j.target = null; pl.want = null;
  }
  if (!S.caught && dist(pl, j.at) > 0.8 && S.ball.state !== 'air') { pl.tx = j.at.x; pl.ty = j.at.y; pl.ts = pl.top * 0.9; return; }
  if (pl.eng >= 0) return;
  const c = S.carrier && S.caught ? S.carrier : S.RB;
  let best = null, bd = 7;
  for (const d of S.D) if (d.eng < 0 && d.lostTo !== pl.i && !behindLine(d)) { const dd = dist(d, c) + dist(d, pl) * 0.6; if (dd < bd && d.y > pl.y - 2) { bd = dd; best = d; } }
  if (best) { pl.job.target = best; pl.tx = best.x; pl.ty = best.y; pl.ts = pl.top; } else { pl.tx = pl.x; pl.ty = pl.y + 1; pl.ts = 2; }
}

// A rusher who has got past the line, into the backfield: the screen's linemen leave him be.
const behindLine = d => d.job.kind === 'rush' && d.y < 0;

function convoy(S, pl) {
  if (pl.eng >= 0) return;
  const c = S.carrier;
  if (!c) { pl.ts = 0; return; }
  // Block for the man with the ball: somebody coming at him, not the defender already on top of him.
  let best = null, bd = 7;
  for (const d of S.D) if (d.eng < 0 && d.lostTo !== pl.i) { const dd = dist(d, c); if (dd < bd && dd > 2.5 && dist(d, pl) < 5) { bd = dd; best = d; } }
  if (best) { pl.job.target = best; pl.tx = best.x; pl.ty = best.y; pl.ts = pl.top * 0.9; } else { pl.tx = pl.x; pl.ty = pl.y; pl.ts = 1; }
}

// ---- defense

function runLook(S, at) {
  const play = S.play;
  if (play.type === 'run') return play.scheme === 'draw' ? at >= S.handT : true;
  if (play.drop === 'pa') return at < S.fakeEnd;
  return false;
}

function defense(S, d) {
  const t = S.t, j = d.job, c = S.carrier;
  d.want = null;
  const ballOut = S.ball.state === 'air';
  // After a catch or a handoff seen: everyone runs to the ball.
  if (c && c.team === 'O' && (S.caught || (c !== S.QB && runLook(S, t - d.lag)) || (c !== S.QB && c.y > -0.5))) {
    if (j.kind === 'man' && !S.caught && c !== j.r && c.y < 0 && t < 2 && d.cls === 'cb') { cover(S, d); return; }
    return pursue(S, d, c);
  }
  if (ballOut) return breakOnBall(S, d);
  if (j.kind === 'rush') return rush(S, d);
  if (runLook(S, t - d.lag) && d.cls !== 'cb') return bite(S, d);
  if (t < 0.12) { d.tx = d.x; d.ty = d.y; d.ts = 0; return; }
  if (j.kind === 'man') return cover(S, d);
  if (j.kind === 'zone') return zone(S, d);
}

function pursue(S, d, c) {
  // Take an angle: run to where he can meet the ball carrier, not to where the carrier is now.
  const dd = dist(d, c);
  const vx = c.vx, vy = c.vy, sp = d.top, rx = c.x - d.x, ry = c.y - d.y;
  const a = vx * vx + vy * vy - sp * sp, b = 2 * (rx * vx + ry * vy), cc = rx * rx + ry * ry;
  let T = -1;
  if (Math.abs(a) < 1e-6) T = b < 0 ? -cc / b : -1;
  else { const disc = b * b - 4 * a * cc; if (disc >= 0) { const q = Math.sqrt(disc); T = [(-b - q) / (2 * a), (-b + q) / (2 * a)].filter(x => x > 0).sort((m, n) => m - n)[0] ?? -1; } }
  if (!(T > 0) || T > 2.5) T = Math.min(1.2, dd / sp);
  d.tx = c.x + vx * T * 0.92; d.ty = c.y + vy * T * 0.92;
  // Deep defenders keep the ball in front of them until they're close.
  if (d.y > c.y + 4 && dd > 6) d.ty = Math.max(d.ty, c.y + 2);
  d.ts = d.top;
  d.want = c;
}

function bite(S, d) {
  // The run fake (or the real run, before the ball carrier is clear): linebackers come downhill, safeties creep.
  const rb = S.RB || S.QB;
  const target = S.play.type === 'run' && S.carrier && S.carrier !== S.QB ? S.carrier : rb;
  if (d.cls === 'lb') { d.tx = target.x + (S.aimX ?? 0) * 0.3; d.ty = Math.max(0.6, d.y0 - 2.5); d.ts = d.top * 0.75; }
  else if (d.cls === 's') { d.tx = d.x; d.ty = d.y0 - 2.2; d.ts = d.top * 0.5; }
  else { d.tx = target.x; d.ty = target.y; d.ts = d.top; }
  d.want = target;
}

function rush(S, d) {
  const QB = S.QB, t = S.t;
  const g = d.job.gap ?? d.x;
  const tgt = S.carrier && S.carrier.team === 'O' ? S.carrier : QB;
  d.want = tgt;
  if (d.y > 0 && Math.abs(d.x - g) > 0.6 && t < 1.2) { d.tx = g; d.ty = -1; d.ts = d.top * 0.9; return; }
  // bend around the edge, then at the passer
  d.tx = tgt.x; d.ty = tgt.y; d.ts = d.top * (d.beat > t ? 1 : 0.85);
  if (d.beat > t && t - d.freeAt < 0.3) { // around the blocker's shoulder first
    const b = S.P[d.lostTo], sd = Math.sign(d.x - b.x) || 1;
    d.tx = b.x + sd * 1.4; d.ty = b.y - 0.8;
  }
}

function lagged(p, ticks) {
  const h = p.hist, n = h.length / 2;
  const k = Math.max(0, n - 1 - ticks);
  return n ? { x: h[2 * k], y: h[2 * k + 1] } : { x: p.x, y: p.y };
}

function cover(S, d) {
  const j = d.job, r = j.r, t = S.t;
  if (r.job.kind !== 'route' || (r.job.delay && t < r.job.delay)) {
    // His man stayed in to block. In Cover 0 he joins the rush; otherwise he sits underneath and reads.
    // So does the man on a back who blocks for a moment before the screen: he sees a blocker and comes after the passer.
    const screen = r.job.route === 'screen' && (S.cov.id === 'c0' || S.cov.id === 'c1') && t > 0.6;
    if (screen || (t > 0.9 && (S.cov.id === 'c0' || r.cls === 'rb' || r.cls === 'fb') && r.job.kind !== 'route')) { d.job = { kind: 'rush', gap: d.x * 0.3 }; d.addOn = true; return rush(S, d); }
    d.tx = d.x0 * 0.7 + r.x * 0.3; d.ty = d.y0; d.ts = 2; return;
  }
  // He sees his man a moment late: where the receiver was, carried forward at the speed he was going then.
  // On a hard cut he keeps going the old way for that moment, and that is the separation.
  const lagT = Math.round(d.react / DT);
  const L = lagged(r, lagT), L2 = lagged(r, lagT + 2);
  const lvx = (L.x - L2.x) / (2 * DT), lvy = (L.y - L2.y) / (2 * DT), ls = lagT * DT;
  const sideIn = -Math.sign(r.x || 1);
  const lev = (S.cov.id === 'c1' && d.cls === 'cb' ? -0.5 : 0.5) * sideIn;
  const cushion = j.press ? 0.5 : clamp(d.y0 - r.y0 - t * 2.4, 0.7, 6);
  const px = L.x + lvx * ls + lev, py = L.y + lvy * ls + cushion;
  d.dv = [lvx + (px - d.x) * 2.2, lvy + (py - d.y) * 2.2];
  if (t < 0.45 && j.press) d.dv = [(r.x + lev * 0.5 - d.x) * 3, (r.y + 1 - d.y) * 3];
  d.ts = d.top;
}

function zone(S, d) {
  const z = d.job.z, t = S.t;
  const [zx0, zx1] = z.x, [zy0, zy1] = z.y;
  const routes = S.O.filter(r => r.job.kind === 'route' && t >= (r.job.delay || 0));
  let tx = z.at[0], ty = z.at[1];
  if (z.deep) {
    // Stay deeper than the deepest man in the zone, and over the top of him.
    const mine = routes.filter(r => r.x > zx0 - 2 && r.x < zx1 + 2 && r.y > 4).sort((a, b) => b.y - a.y);
    const r = mine[0];
    if (r && r.y > z.at[1] - 7) { tx = clamp(r.x * 0.55 + tx * 0.45, zx0 - 1, zx1 + 1); ty = Math.max(z.at[1], r.y + 3.5); }
    else if (S.look && S.look.x > zx0 && S.look.x < zx1) tx = tx * 0.7 + S.look.x * 0.3;
    d.ts = d.y < ty - 2 ? d.top * 0.78 : d.top * 0.9;
  } else {
    const inZone = routes.filter(r => r.x > zx0 - 1 && r.x < zx1 + 1 && r.y > zy0 - 1 && r.y < zy1 + 1);
    const QB = S.QB;
    if (inZone.length) {
      // Who to play: a flat defender takes the shallowest man threatening the flat, a hook defender the one
      // nearest the middle of his area; otherwise the nearest. The quarterback's eyes pull him a little.
      const wide = d.job.zid.startsWith('flat') || d.job.zid.startsWith('cf');
      const score = r => (wide && r.y < 6 ? r.y * 0.6 - 6 : 0) + (!wide ? Math.abs(r.x - z.at[0]) * 0.8 : 0) + dist(r, d) - (S.look === r ? 2.5 : 0);
      inZone.sort((a, b) => score(a) - score(b));
      const r = inZone[0];
      if (wide && r.y < 7 && Math.abs(r.x + r.vx * 0.5) > Math.abs(d.x)) {
        // a flat route: stay in front of him and outside, squeezing him toward the sideline
        tx = clamp(r.x + r.vx * 0.45, zx0 - 2, zx1 + 2); ty = r.y + 1.6;
      } else {
        const [ux, uy] = unit(QB.x - r.x, QB.y - r.y);
        tx = clamp(r.x + ux * 1.3 + r.vx * 0.25, zx0 - 2, zx1 + 2);
        ty = clamp(r.y + uy * 1.3 + r.vy * 0.2, zy0, zy1 + 1);
      }
    } else {
      // Nobody here: sink under whatever is running over the top of the zone.
      const over = routes.filter(r => r.x > zx0 && r.x < zx1 && r.y >= zy1 + 1 && r.y < zy1 + 9);
      if (over.length) ty = Math.min(zy1 + 1.5, over[0].y - 2);
      if (S.look && S.look.x > zx0 - 3 && S.look.x < zx1 + 3) tx = tx * 0.6 + S.look.x * 0.4;
    }
    d.ts = d.top * 0.85;
  }
  if (t < 0.55 && !z.deep) ty = Math.max(ty, d.y); // open and drop first
  d.tx = tx; d.ty = ty;
}

function breakOnBall(S, d) {
  const b = S.ball;
  if (S.t < S.throwT + d.react || d.job.kind === 'rush' && d.y < 2) {
    if (d.job.kind === 'rush') return rush(S, d);
    if (d.job.kind === 'man') return cover(S, d);
    return zone(S, d);
  }
  const left = b.t0 + b.tf - S.t;
  const dd = hyp(b.tx - d.x, b.ty - d.y);
  const z = d.job.z;
  if (z && !z.deep && b.ty > z.y[1] + 4 && dd > 4) { d.tx = b.tx; d.ty = Math.min(b.ty, d.y + 2); d.ts = d.top * 0.8; return; }
  if (dd < d.top * left + 1.5) { d.tx = b.tx; d.ty = b.ty; d.ts = d.top; }
  else { const r = b.target >= 0 ? S.P[b.target] : null; if (r) { d.tx = b.tx; d.ty = b.ty + 1; d.ts = d.top; } }
}

// ---- blocks

function sampleShed(S, b, d, pass) {
  const R = S.R;
  let base;
  if (pass) base = (d.cls === 'dl' ? 2.25 : d.cls === 'de' ? 2.05 : 1.5) * (b.cls === 'ol' ? 1 : 0.7);
  else base = b.job.kind === 'convoy' ? 0.6 : b.cls === 'wr' ? 1.3 : d.cls === 'lb' || d.cls === 's' ? 1.6 : 2.1;
  base *= 1 + (b.str - d.str) * 0.45;
  if (!pass && (b.job.scheme === 'power' || b.job.scheme === 'kick' || b.job.scheme === 'pull')) base *= 1.45; // blocking down at an angle
  return Math.max(0.35, base * Math.exp(R.normal() * 0.42));
}

function engage(S) {
  const t = S.t;
  // new blocks
  for (const b of S.O) {
    if (b.eng >= 0) continue;
    const k = b.job.kind;
    const tgt = b.job.target || b.want;
    const canBlock = k === 'pro' || k === 'block' || k === 'stalk' || (k === 'screenOL' && b.job.released) || k === 'convoy';
    if (!canBlock || !tgt || tgt.eng >= 0 || tgt.noEngage > t || tgt.lostTo === b.i || tgt === S.carrier) continue;
    if (k === 'screenOL' && behindLine(tgt)) continue;
    if (dist(b, tgt) < 1.15) {
      const pass = S.play.type === 'pass' && !S.caught && k === 'pro' || (k === 'pro' && S.play.scheme === 'draw' && S.carrier === S.QB);
      b.eng = tgt.i; tgt.eng = b.i;
      b.u = unit(tgt.x - b.x, tgt.y - b.y);
      b.adv = clamp(0.5 + (b.str - tgt.str) * 0.35 + S.R.normal() * 0.12, 0.15, 0.85);
      tgt.shedAt = t + sampleShed(S, b, tgt, pass);
      b.engT = t;
    }
  }
  // a second blocker on the same man (a double team) buys time
  for (const b of S.O) if (b.eng < 0 && b.job.kind === 'pro' && !b.job.target && !b.want && S.t > 0.3) {
    let best = null, bd = 2.2;
    for (const d of S.D) if (d.eng >= 0 && !d.doubled && d.job.kind === 'rush') { const dd = dist(b, d); if (dd < bd) { bd = dd; best = d; } }
    if (best) { best.doubled = true; best.shedAt += 0.9 + S.R.range(0, 0.8); b.helping = best; }
  }
  for (const b of S.O) {
    if (b.eng < 0) continue;
    const d = S.P[b.eng];
    if (t >= d.shedAt) { release(S, b, d, false); continue; }
  }
}

function release(S, b, d, quiet) {
  b.eng = -1; d.eng = -1;
  d.lostTo = b.i; d.freeAt = S.t; d.noEngage = S.t + 0.7;
  // A rusher who beats his man has a clear run at the passer for a moment: nobody else picks him up in time.
  if (d.job.kind === 'rush' && S.play.type === 'pass' && !quiet) { d.beat = S.t + 1.4; d.noEngage = S.t + 1.4; }
  if (!quiet && (d.job.kind === 'rush' || S.play.type === 'run')) {
    S.sheds = S.sheds || [];
    S.sheds.push({ t: S.t, d: d.i, b: b.i });
  }
}

// ---- movement

function integrate(S) {
  for (const pl of S.P) {
    if (pl.team === 'D' && pl.eng >= 0) continue; // moved with his blocker below
    if (pl.team === 'O' && pl.eng >= 0) { pairMove(S, pl, S.P[pl.eng]); continue; }
    let speed = Math.min(pl.ts, pl.top);
    if (pl.missUntil > S.t) speed *= 0.45;
    let wx, wy;
    if (pl.dv) {
      // a wanted velocity rather than a spot (man coverage)
      const v = hyp(pl.dv[0], pl.dv[1]), k = v > speed ? speed / v : 1;
      wx = pl.dv[0] * k; wy = pl.dv[1] * k;
      pl.dv = null;
    } else {
      const dx = pl.tx - pl.x, dy = pl.ty - pl.y, d = hyp(dx, dy);
      if (d < 1.2) speed = Math.min(speed, d * 3);
      wx = d > 1e-6 ? dx / d * speed : 0; wy = d > 1e-6 ? dy / d * speed : 0;
    }
    let ax = wx - pl.vx, ay = wy - pl.vy;
    const a = hyp(ax, ay), max = pl.acc * DT;
    if (a > max) { ax *= max / a; ay *= max / a; }
    pl.vx += ax; pl.vy += ay;
    // Anyone without the ball eases up running at the sideline, in time to stop a step inside it (see the clamp below).
    if (pl !== S.carrier && pl.vx * pl.x > 0) {
      const v = Math.sqrt(2 * pl.acc * Math.max(0, SIDELINE - 0.3 - Math.abs(pl.x)));
      if (Math.abs(pl.vx) > v) pl.vx = Math.sign(pl.vx) * v;
    }
    pl.x += pl.vx * DT; pl.y += pl.vy * DT;
  }
  // Nobody runs through anybody. A man defender who runs into somebody else's receiver gets picked off (said only while
  // the play is live: the frames after the whistle still move everyone, and their bumps aren't news).
  const P = S.P;
  const c = S.carrier, cx = c ? c.x : 0, cy = c ? c.y : 0;
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
    const A = P[a], B = P[b];
    if (A.eng === B.i || B.eng === A.i) continue;
    if (A.team !== B.team) { // a pass rusher only bumps the blocker who's after him, until the ball is thrown
      const [o, d] = A.team === 'O' ? [A, B] : [B, A];
      // Before the throw the quarterback is the ball carrier, and bumps anyone. After it he doesn't have the ball, and
      // nobody walks through him or anyone else. On a run a rusher running free bumps anyone he runs into, his blocker
      // or not; one held in somebody else's block moves with that block, and the ball carrier still runs into him.
      if (S.play.type === 'run' ? d.job.kind === 'rush' && d.eng >= 0 && o !== S.carrier : d.job.kind === 'rush' && o !== S.carrier && !(S.throwT <= S.t) && (d.beat > S.t || (o.want !== d && o.job.target !== d))) continue;
    }
    if (S.dead && (A === S.carrier || B === S.carrier)) continue;
    const dx = A.x - B.x, dy = A.y - B.y, d = hyp(dx, dy);
    if (d >= 0.85 || d === 0) continue;
    const push = (0.85 - d) / 2, ux = dx / d, uy = dy / d;
    const wa = A.eng >= 0 ? 0.2 : 1, wb = B.eng >= 0 ? 0.2 : 1;
    A.x += ux * push * wa; A.y += uy * push * wa; B.x -= ux * push * wb; B.y -= uy * push * wb;
    for (const [X, Y] of [[A, B], [B, A]]) {
      if (X.team === 'D' && X.job.kind === 'man' && Y.team === 'O' && Y !== X.job.r && Y.job.kind === 'route') {
        X.vx *= 0.55; X.vy *= 0.55;
        if (!S.pickNoted && !S.dead && dist(X, X.job.r) > 1.5 && S.t < 3) {
          S.pickNoted = true;
          // A cornerback's name already says whose man he is ("the cornerback on the X"), so it isn't said twice.
          ev(S, 'pick', `${cap(name(S, X))} runs into traffic ${X.label === 'CB' ? 'and loses his man' : `chasing ${name(S, X.job.r)}`}.`, { who: X.i });
        }
      }
    }
  }
  // The ball carrier in a pile is squeezed out of it at a walk: a quarter of a yard a frame, however many push on him,
  // not thrown clear in one.
  if (c) { const mx = c.x - cx, my = c.y - cy, m = hyp(mx, my); if (m > 0.25) { c.x = cx + mx * 0.25 / m; c.y = cy + my * 0.25 / m; } }
  // Only the man with the ball goes out of bounds; everyone else stays a step inside the sideline.
  for (const pl of P) {
    const m = pl === S.carrier ? SIDELINE + 1 : SIDELINE - 0.3;
    if (Math.abs(pl.x) > m) { pl.x = Math.sign(pl.x) * m; if (pl.vx * pl.x > 0) pl.vx = 0; }
  }
}

function pairMove(S, b, d) {
  // The blocker drives his way, the defender fights toward the ball; the stronger of the two moves the pair.
  const j = b.job, p = S.p;
  let drive;
  const goal = d.want || S.carrier || S.QB;
  let [wx, wy] = unit(goal.x - d.x, goal.y - d.y);
  if (j.kind === 'pro' || (j.kind === 'screenOL' && !j.released)) {
    const set = b.set || { x: b.x, y: b.y };
    const ds = hyp(set.x - b.x, set.y - b.y);
    drive = ds > 0.5 ? unit(set.x - b.x, set.y - b.y) : [-wx * 0.6, -wy * 0.6];
  } else if (j.scheme === 'zone') drive = unit(p * 0.75, 0.66);
  else if (j.scheme === 'reach') drive = unit(p * 0.9, 0.45);
  else if (j.scheme === 'power') drive = unit(-p * 0.7, 0.7);
  else if (j.scheme === 'kick') drive = unit(p, 0.2);
  else drive = unit(d.x - b.x, d.y - b.y + 0.5);
  const adv = b.adv ?? 0.5;
  const sp = 1.6;
  b.vx = (drive[0] * adv + wx * (1 - adv)) * sp;
  b.vy = (drive[1] * adv + wy * (1 - adv)) * sp;
  b.x += b.vx * DT; b.y += b.vy * DT;
  // The defender works around the block toward where he wants to go.
  const u = b.u || [0, 1];
  const nu = unit(u[0] * 0.965 + wx * 0.035 * (1.2 - adv), u[1] * 0.965 + wy * 0.035 * (1.2 - adv));
  b.u = nu;
  d.x = b.x + nu[0] * 0.95; d.y = b.y + nu[1] * 0.95;
  d.vx = b.vx; d.vy = b.vy;
}

// ---- the hole

// The first time the ball carrier on a run gets to the line, which gap he goes through, from where the blockers are at
// that moment: A inside the guard, B inside the tackle, C outside the tackle (inside a tight end on the line), D outside
// the tight end, anything wider outside. Words only: it moves nobody and draws no dice.
function hole(S) {
  const c = S.carrier;
  if (S.holeNoted || S.play.type !== 'run' || S.caught || !c || c === S.QB || c.y < 0) return;
  S.holeNoted = true;
  const at = l => S.OL.find(o => o.label === l).x;
  const C = at('C'), sd = Math.sign(c.x - C) || S.s, d = Math.abs(c.x - C);
  const g = Math.abs(at(sd > 0 ? 'RG' : 'LG') - C), t = Math.abs(at(sd > 0 ? 'RT' : 'LT') - C);
  const te = S.ends[sd], e = te ? Math.abs(te.x - C) : null;
  const gap = d < g ? 'A' : d < t ? 'B' : e !== null ? (d < e ? 'C' : d < e + 2.5 ? 'D' : null) : d < t + 2.5 ? 'C' : null;
  const side = sd === S.s ? 'strong' : 'weak';
  // Away from where the play was aimed is a cutback (the draw is aimed up the middle, so it has none), said once.
  const back = S.play.scheme !== 'draw' && sd * S.aimX < 0;
  const who = cap(name(S, c));
  let text;
  if (back && !S.cutNoted) text = gap ? `${who} cuts back into the ${gap} gap on the ${side} side.` : `${who} cuts it back outside on the ${side} side.`;
  else if (gap) text = `${who} hits the ${gap} gap on the ${side} side.`;
  else text = S.play.scheme === 'reach' && !back ? `${who} gets to the outside on the ${side} side.` : `${who} bounces it outside on the ${side} side.`;
  if (back) S.cutNoted = true;
  ev(S, 'hole', text, { who: c.i, gap: gap || 'outside', side });
}

// ---- tackles, sacks, the end of the play

function contact(S) {
  const c = S.carrier, t = S.t, R = S.R;
  if (!c || S.dead) return;
  if (Math.abs(c.x) > SIDELINE) { ev(S, 'oob', `${cap(name(S, c))} is forced out of bounds.`, { who: c.i }); return finish(S, 'oob'); }
  if (c.y > 60) return stillRunning(S, c);
  const qbHeld = c === S.QB && S.play.type === 'pass' && !S.caught;
  // Near the sideline, a defender on his inside shoulder runs him out.
  if (Math.abs(c.x) > SIDELINE - 1.3 && !qbHeld && S.D.some(d => d.eng < 0 && dist(d, c) < 1.7 && Math.abs(d.x) < Math.abs(c.x) + 0.3) && R.chance(0.25)) {
    const hit = { x: c.x, y: c.y };
    c.x = Math.sign(c.x) * (SIDELINE + 0.3); // where he goes out, and goes there from where he was hit (see finish())
    ev(S, 'oob', `${cap(name(S, c))} is pushed out of bounds.`, { who: c.i });
    return finish(S, 'oob', undefined, hit);
  }
  for (const d of S.D) {
    if (d.missUntil > t || t - d.tried < 0.4) continue;
    const dd = dist(d, c);
    const blocked = d.eng >= 0;
    const head = -(d.vx * c.vx + d.vy * c.vy) / ((hyp(d.vx, d.vy) * hyp(c.vx, c.vy)) || 1);
    const reach = blocked ? 0.6 : qbHeld ? 1.3 : head < -0.4 ? 1.4 : 1.1;
    if (dd > reach) continue;
    d.tried = t;
    let pt = { dl: 0.82, de: 0.84, lb: 0.88, s: 0.85, cb: 0.81 }[d.cls];
    pt += { qb: 0.08, rb: -0.1, wr: -0.04, te: 0.02, fb: 0.03 }[c.cls] || 0;
    pt += head > 0.3 ? 0.04 : head < -0.4 ? (dd > 1.1 ? -0.4 : -0.14) : 0;
    if (blocked) pt = 0.14;
    if (S.D.some(o => o !== d && o.eng < 0 && dist(o, c) < 1.6)) pt += 0.12;
    if (R.chance(pt)) {
      if (qbHeld) { ev(S, 'sack', `${cap(name(S, d))} sacks the quarterback.`, { who: d.i }); return finish(S, 'sack', d); }
      const fall = clamp(c.vy * 0.16 * (head > 0.3 ? 0.5 : 1), -0.5, 1.8);
      const hit = { x: c.x, y: c.y };
      c.y += fall; // where he goes down, and where the ball is spotted
      if (c === S.QB && S.play.type === 'run') ev(S, 'tackle', `${cap(name(S, d))} ${blocked ? 'reaches out of a block' : 'gets into the backfield'} and drops the quarterback before the handoff.`, { who: d.i });
      else ev(S, 'tackle', `${cap(name(S, d))} makes the tackle${blocked ? ', reaching out of a block' : ''}.`, { who: d.i });
      return finish(S, c === S.QB && S.play.type === 'run' ? 'run' : S.caught ? 'catch' : 'run', d, hit);
    }
    d.missUntil = t + 0.8;
    c.vx *= 0.75; c.vy *= 0.75;
    if (qbHeld) { ev(S, 'escape', `${cap(name(S, S.QB, true))} slips out of ${name(S, d)}'s grasp.`, { who: S.QB.i }); S.QB.tx = S.QB.x - (d.x - S.QB.x) * 2; continue; }
    ev(S, 'miss', `${cap(name(S, c))} breaks a tackle from ${name(S, d)}.`, { who: d.i });
  }
  if (qbHeld && t > 6) throwAway(S, S.QB);
}

// The board stops counting at 60 yards, and at its clock: the carrier is still going, and the result says it's 60-plus.
function stillRunning(S, c) {
  ev(S, 'long', `${cap(name(S, c))} is still running at ${Math.round(c.y)} yards: the board stops counting here.`, { who: c.i });
  return finish(S, 'long');
}

// Out of time with the ball still live: the nearest defender close enough makes the tackle, or the carrier runs on.
function timeUp(S) {
  const c = S.carrier;
  if (!c || (c === S.QB && S.play.type === 'pass' && !S.caught)) return finish(S, 'time');
  let near = null, nd = 3;
  for (const d of S.D) { const dd = dist(d, c); if (dd < nd) { nd = dd; near = d; } }
  if (!near) return stillRunning(S, c);
  ev(S, 'tackle', `${cap(name(S, near))} makes the tackle.`, { who: near.i });
  finish(S, S.caught ? 'catch' : 'run', near);
}

// hit: where a tackled carrier was when he was hit, or one pushed out; he goes from there to the spot (down, or out of
// bounds) over the next few frames.
function finish(S, kind, by, hit) {
  if (S.result) return;
  const c = S.carrier;
  // The ball carrier stops where the ball is spotted, and his tackler goes down with him; one still running runs on.
  const long = kind === 'long';
  if (c && !long) {
    S.down = { c, from: hit || { x: c.x, y: c.y }, to: { x: c.x, y: c.y }, k: 0, by: by && by !== c ? by : null };
    if (S.down.by) S.down.off = { x: by.x - S.down.from.x, y: by.y - S.down.from.y };
  }
  let yards = 0;
  if (kind === 'run' || kind === 'catch' || kind === 'oob' || kind === 'long' || kind === 'sack' || kind === 'time') yards = c ? c.y : 0;
  if (kind === 'time' && S.play.type === 'pass' && !S.caught) { kind = 'sack'; }
  if (kind === 'oob' || kind === 'long' || kind === 'time') kind = S.caught ? 'catch' : S.play.type === 'run' ? 'run' : kind;
  S.result = { kind, yards: Math.round(yards * 2) / 2, by: by ? by.i : -1, carrier: c ? c.i : -1, target: S.target ? S.target.i : -1, t: S.t };
  if (long) S.result.long = true;
  S.dead = true;
  S.endAt = S.t + 0.7;
  if (S.ball.state === 'held' && c) S.ball.holder = c.i;
  if (S.down) { c.x = S.down.from.x; c.y = S.down.from.y; }
  // keep the shed blocks that mattered: the tackler's, and any rusher who got the passer, each in its place in time
  if (S.sheds && by) for (const sh of S.sheds) if (sh.d === by.i) {
    const e = { t: +sh.t.toFixed(2), kind: 'shed', text: `${cap(name(S, S.P[sh.d]))} gets off a block by ${name(S, S.P[sh.b])}.`, who: sh.d };
    const at = S.events.findIndex(x => x.t >= e.t);
    S.events.splice(at < 0 ? S.events.length : at, 0, e);
  }
}

// ---------------------------------------------------------------- words

const DEF_NAMES = { DT: 'the 3-technique', NT: 'the nose', M: 'the Mike', W: 'the Will', S: 'the Sam', J: 'the Jack', FS: 'the free safety', SS: 'the strong safety', NB: 'the nickel back' };
const OFF_NAMES = { QB: 'the quarterback', RB: 'the running back', FB: 'the fullback', LT: 'the left tackle', LG: 'the left guard', C: 'the center', RG: 'the right guard', RT: 'the right tackle' };

export function name(S, pl, plain) {
  if (pl.team === 'O') {
    if (OFF_NAMES[pl.label]) return OFF_NAMES[pl.label];
    if (pl.cls === 'te') return `the tight end (${pl.label})`;
    return `the ${pl.label}`;
  }
  if (pl.label === 'DE') return pl.side === S.s ? 'the strong-side end' : 'the weak-side end';
  // "Cornerback", not "corner", so he isn't mixed up with the route: over a receiver in a zone, on him in man.
  if (pl.label === 'CB') { const man = pl.job.kind === 'man', r = man ? pl.job.r : pl.over; return r ? `the cornerback ${man ? 'on' : 'over'} the ${r.label}` : 'the cornerback'; }
  if (pl.label === 'DT' && pl.tech !== '3') return 'the defensive tackle';
  return DEF_NAMES[pl.label] || `the ${pl.label}`;
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const yardWord = n => (n === 1 ? '1 yard' : `${n} yards`);
// Where something happened: "18 yards downfield", "2 yards behind the line", or "at the line of scrimmage".
export const yardText = y => (y >= 0.5 ? `${yardWord(Math.round(y))} downfield` : y <= -0.5 ? `${yardWord(Math.round(-y))} behind the line` : 'at the line of scrimmage');
// "a corner route", "an out route"; the check-down and the screen are what they are.
const routeText = id => { const n = ROUTES[id]?.name; return !n ? 'his route' : id === 'check' || id === 'screen' ? `the ${n}` : `${/^[aeiou]/.test(n) ? 'an' : 'a'} ${n} route`; };

// What each man is doing on the play, in a sentence, for the card that opens when you tap him.
function describeJob(S, pl) {
  const j = pl.job, s = S.s;
  const sideWord = x => ((x * s) >= 0 ? 'strong' : 'weak');
  if (pl.team === 'O') {
    if (pl.cls === 'qb') {
      if (S.play.type === 'run') return S.play.scheme === 'draw' ? 'Drops back like it\'s a pass, then hands the ball to the back underneath the rush.' : `Turns and hands the ball to the back, then carries out his fake the other way.`;
      const drop = { quick: 'Takes a quick drop and gets the ball out fast.', five: S.fm.under ? 'Takes a five-step drop.' : 'Takes a three-step drop from the shotgun.', pa: 'Fakes the handoff, then sets up deep.', screen: 'Drops deep to draw the rush, then lofts it to the back.' }[S.play.drop];
      const order = (S.reads || []).map((r, k) => `${k + 1}. ${r.label} (${ROUTES[r.job.route].name})`).join(', ');
      return `${drop}${order ? ' His reads: ' + order + '.' : ''}`;
    }
    if (j.kind === 'carry') return S.play.scheme === 'draw' ? 'Sets up like he is pass-blocking, takes the late handoff, and runs up the middle where the rushers left.' : `Takes the handoff aiming ${S.play.scheme === 'reach' ? 'for the edge' : 'just outside the play-side guard'}, and reads the blocks for a lane.`;
    if (j.kind === 'route' || j.kind === 'fake') {
      const r = ROUTES[j.route];
      if (j.kind === 'fake') return `Fakes taking the handoff, then stays in to ${j.target ? 'block ' + name(S, j.target) : 'pass-block'}.`;
      return S.play.type === 'run' ? 'Runs a go route to take his defender away from the run.' : r.desc;
    }
    if (j.kind === 'pro' && j.stayed) return `Checks for a blitzer before he slips out, and ${name(S, j.target)} is coming: he stays in and blocks him.`;
    if (j.kind === 'pro') return j.target ? `Pass-blocks ${name(S, j.target)}.` : 'Pass-blocks, helping whoever needs it.';
    if (j.kind === 'screenOL') return 'Pass-blocks for a second, lets his man go, then runs out in front of the screen to block.';
    if (j.kind === 'stalk') return j.target ? `Blocks ${name(S, j.target)} to keep him off the run.` : 'Blocks downfield.';
    if (j.kind === 'block') {
      const tgt = j.target ? name(S, j.target) : 'the first defender to show up';
      return ({ zone: `Zone-blocks to the play side: takes ${tgt}.`, reach: `Reach-blocks to the play side: gets outside ${tgt}.`, power: `Blocks down, toward the middle, on ${tgt}.`, kick: j.pull ? `Pulls from the back side and kicks out ${tgt}, the end man on the line.` : `Kicks out ${tgt}, the end man on the line.`, pull: `Pulls from the back side and leads through the hole for ${tgt}.`, lead: `Leads through the hole for ${tgt}.` })[j.scheme] || `Blocks ${tgt}.`;
    }
    return '';
  }
  if (j.kind === 'rush') {
    const gap = Math.abs(j.gap ?? 0);
    const g = gap < 1.2 ? 'A' : gap < 3 ? 'B' : gap < 4.6 ? 'C' : 'outside';
    const tech = pl.tech ? `Lines up as ${{ 0: 'a 0-technique', 1: 'a 1-technique', 3: 'a 3-technique', 5: 'a 5-technique', w5: 'a wide 5-technique' }[pl.tech]}. ` : '';
    return `${tech}${pl.blitzer ? 'Blitzes' : 'Rushes'} ${g === 'outside' ? 'off the edge' : `through the ${g} gap`} on the ${sideWord(j.gap ?? pl.x)} side.`;
  }
  // On a run his pass job comes first, as what he'd have done, then what he does about the run (see defense() and bite()).
  const run = S.play.type === 'run', draw = run && S.play.scheme === 'draw';
  const onRun = !run ? '' : draw ? ' On this draw he plays it as a pass until he sees the handoff, then comes up to the ball.'
    : j.kind === 'man' && pl.cls === 'cb' ? ' On this run he stays with his man until the ball carrier gets to the line, then comes up.'
    : ' On this run he reads it and comes downhill to the ball.';
  if (j.kind === 'man') {
    const man = `man-to-man on ${name(S, j.r)}${j.press ? ', pressed up at the line' : ''}`;
    return run ? `On a pass he'd play ${man}.${onRun}` : `Plays ${man}, and goes wherever he goes.`;
  }
  if (j.kind === 'zone') {
    // Strong and weak side, the way coaches say it, so it reads right from either side of the board.
    const z = j.z, sd = Math.sign(z.at[0]) * s > 0 ? 'strong' : 'weak';
    const area = !z.at[0] ? `the ${z.name}` : z.name === 'deep quarter' ? `the ${Math.abs(z.at[0]) > 10 ? 'outside' : 'inside'} quarter on the ${sd} side` : `the ${sd}-side ${z.name}`;
    return run ? `On a pass he'd play zone in ${area}.${onRun}` : `Plays zone in ${area} and ${z.deep ? 'stays deeper than anyone in his area' : 'breaks on the ball when it\'s thrown'}.`;
  }
  return '';
}

// Lines for the board before the snap: routes, blocks, rush lanes, zone drops and man assignments.
function overlay(S) {
  const out = [];
  for (const pl of S.O) {
    const j = pl.job;
    if (j.kind === 'route') out.push({ team: 'O', kind: 'route', i: pl.i, pts: [{ x: pl.x0, y: pl.y0 }, ...pl.path.map(w => ({ x: w.x, y: Math.min(w.y, pl.y0 + 28) }))], delay: j.delay, settle: !!ROUTES[j.route]?.settle });
    else if (j.kind === 'block' || j.kind === 'stalk') {
      const tg = j.target;
      if (j.pull && j.scheme === 'kick' && tg) { // along the line behind it, then out at the end man from inside him
        const kx = tg.x - S.p * 0.8;
        out.push({ team: 'O', kind: 'pull', i: pl.i, pts: [{ x: pl.x0, y: pl.y0 }, { x: pl.x0, y: -1.8 }, { x: kx, y: -1.6 }, { x: kx + S.p * 0.3, y: tg.y - 0.5 }], to: tg.i });
      } else if (j.pull) out.push({ team: 'O', kind: 'pull', i: pl.i, pts: [{ x: pl.x0, y: pl.y0 }, { x: pl.x0, y: -1.8 }, { x: S.aimX, y: -1.6 }, { x: S.aimX, y: 1.5 }], to: tg ? tg.i : -1 });
      else out.push({ team: 'O', kind: 'block', i: pl.i, to: tg ? tg.i : -1, dir: j.scheme });
    } else if (j.kind === 'pro' || j.kind === 'screenOL' || j.kind === 'fake') out.push({ team: 'O', kind: 'pro', i: pl.i, set: pl.set, to: j.target ? j.target.i : -1, screen: j.kind === 'screenOL' ? j.at : null });
    else if (j.kind === 'carry') out.push({ team: 'O', kind: 'carry', i: pl.i, pts: [{ x: pl.x0, y: pl.y0 }, { x: S.mesh.x, y: S.mesh.y + 0.6 }, { x: S.aimX, y: 0.5 }, { x: S.aimX + (S.aimX - S.mesh.x) * 0.25, y: 4 }] });
    else if (j.kind === 'qb') out.push({ team: 'O', kind: 'qb', i: pl.i, pts: [{ x: pl.x0, y: pl.y0 }, ...(pl.path || [])] });
  }
  for (const d of S.D) {
    const j = d.job;
    if (j.kind === 'rush') out.push({ team: 'D', kind: 'rush', i: d.i, pts: [{ x: d.x0, y: d.y0 }, { x: j.gap ?? d.x0, y: -0.8 }, { x: (j.gap ?? 0) * 0.5, y: -4.2 }], blitz: !!d.blitzer });
    else if (j.kind === 'man') out.push({ team: 'D', kind: 'man', i: d.i, to: j.r.i });
    else if (j.kind === 'zone') out.push({ team: 'D', kind: 'zone', i: d.i, at: { x: j.z.at[0], y: j.z.at[1] }, deep: !!j.z.deep, zid: j.zid });
  }
  return out;
}
