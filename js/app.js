// Chalk Talk: the page. Picks the calls, runs the simulator, plays the result back on the board, and explains it.
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, PRESSURES, POSITIONS, PERSONNEL, TECHNIQUES, NOTES, ROUTES } from './playbook.js';
import { simulate } from './sim.js';
import { Board } from './board.js';
import { rng, newSeed } from './rng.js';

const SITE = 'https://chalk-talk.junkdrawer.works/';
const KEY = 'chalk-talk.v1';
const $ = id => document.getElementById(id);
const byId = (list, id) => list.find(x => x.id === id) || list[0];

const RUN_NOTES = {
  iz: 'Inside zone works when there are as many blockers as defenders in the box. The back-side end is left unblocked on purpose, because the back reads the play-side blocks and may cut it back behind the flow.',
  oz: 'Outside zone stretches the defense sideways. If the line reaches the edge, the back gets outside; if the defense flows too fast to stop that, a cutback lane opens behind it.',
  power: 'Power brings an extra blocker to the hole, the pulling guard, and wins with numbers at the point of attack. It loses to quick penetration and to an extra defender in the box.',
  draw: 'The draw wants defenders who think pass: rushers running up the field past the back, linebackers dropping into coverage. Against a blitz it runs into the rushers.',
};

// ---------------------------------------------------------------- state

const state = {
  side: 'O',
  off: { formation: 'trips', play: 'smash', flip: false },
  def: { front: 'nickel', coverage: 'c2', pressure: 'four' },
  auto: true,
  labels: true,
  speed: 1,
  seed: newSeed(),
  play: null,
  phase: 'pre', // pre, playing, paused, done
  t: 0,
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) {
      if (s.side === 'O' || s.side === 'D') state.side = s.side;
      if (s.off && FORMATIONS.some(f => f.id === s.off.formation) && PLAYS.some(p => p.id === s.off.play)) state.off = { formation: s.off.formation, play: s.off.play, flip: !!s.off.flip };
      if (s.def && FRONTS.some(f => f.id === s.def.front) && COVERAGES.some(c => c.id === s.def.coverage)) state.def = { front: s.def.front, coverage: s.def.coverage, pressure: s.def.pressure === 'blitz' ? 'blitz' : 'four' };
      if (typeof s.auto === 'boolean') state.auto = s.auto;
      if (typeof s.labels === 'boolean') state.labels = s.labels;
      if (s.speed === 0.5 || s.speed === 1) state.speed = s.speed;
    }
  } catch { /* storage unavailable: start fresh */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ side: state.side, off: state.off, def: state.def, auto: state.auto, labels: state.labels, speed: state.speed })); } catch { /* fine */ }
}

const call = () => ({ ...state.off, ...state.def });
// The other coach's call is hidden from the board, the chart and the player cards until the snap.
const hidden = () => state.auto && state.phase === 'pre';

// The other coach's call, picked the way a real one might: nickel against three and four receivers, and so on.
function rollTheirs() {
  const R = rng(newSeed());
  const w = list => { let x = R() * list.reduce((a, [, p]) => a + p, 0); for (const [v, p] of list) { if ((x -= p) <= 0) return v; } return list[0][0]; };
  if (state.side === 'O') {
    const pers = byId(FORMATIONS, state.off.formation).personnel;
    const spread = pers === '10' || pers === '11';
    state.def.front = w(spread ? [['nickel', 0.55], ['over', 0.15], ['under', 0.12], ['34', 0.18]] : [['over', 0.3], ['under', 0.25], ['34', 0.3], ['nickel', 0.15]]);
    state.def.coverage = w([['c0', 0.06], ['c1', 0.22], ['c2', 0.2], ['c3', 0.32], ['c4', 0.2]]);
    state.def.pressure = R() < 0.25 ? 'blitz' : 'four';
  } else {
    state.off.formation = R.pick(FORMATIONS).id;
    state.off.play = w(PLAYS.map(p => [p.id, p.type === 'run' ? 0.105 : 0.083]));
    state.off.flip = R() < 0.5;
  }
}

// ---------------------------------------------------------------- the board

const board = new Board($('board'));

function lineUp() {
  state.play = simulate(call(), state.seed);
  state.phase = 'pre';
  state.t = 0;
  board.setPlay(state.play);
  board.t = 0;
  board.selected = -1;
  hideWho();
  $('result').hidden = true;
  syncBoard();
  syncTransport();
  syncTheirs();
  renderMatchup();
  $('caption').textContent = '';
  draw();
}

function syncBoard() {
  board.flip = state.side === 'D';
  board.mineTeam = state.side;
  board.labels = state.labels;
  board.showMine = true;
  board.showTheirs = !state.auto || state.phase !== 'pre';
}

let raf = 0, last = 0;
function draw() { board.t = state.t; board.render(); }

function play() {
  if (!state.play) return;
  const snapped = state.phase === 'pre';
  if (state.phase === 'done' || state.t >= board.duration()) state.t = 0;
  state.phase = 'playing';
  syncBoard();
  syncTheirs();
  renderMatchup();
  syncTransport();
  if (snapped) { // the other side's call is out now: the tapped player's job, and which row of the chart it is
    if (board.selected >= 0) showWho(board.selected);
    syncChart();
  }
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.t = Math.min(board.duration(), state.t + dt * state.speed);
  draw();
  caption();
  $('scrub').value = String(Math.round(state.t / board.duration() * 1000));
  if (state.t >= board.duration()) { finish(); return; }
  if (state.phase === 'playing') raf = requestAnimationFrame(tick);
}

function pause() { state.phase = 'paused'; cancelAnimationFrame(raf); syncTransport(); }

function finish() {
  state.phase = 'done';
  cancelAnimationFrame(raf);
  syncTransport();
  showResult();
}

function snap() {
  if (state.phase !== 'pre') { // run it again: same calls, a new roll of the dice
    state.seed = newSeed();
    lineUp();
  }
  play();
}

function caption() {
  const evs = state.play.events.filter(e => e.t <= state.t + 0.001 && e.kind !== 'shed');
  const e = evs[evs.length - 1];
  $('caption').textContent = e && state.t - e.t < 2.2 ? e.text : '';
}

// ---------------------------------------------------------------- transport

function syncTransport() {
  const pre = state.phase === 'pre';
  $('snap').textContent = pre ? 'Snap' : 'Run it again';
  $('play').disabled = pre;
  $('scrub').disabled = pre;
  $('play').innerHTML = state.phase === 'playing' ? '<span aria-hidden="true">❚❚</span>' : '<span aria-hidden="true">▶</span>';
  $('play').setAttribute('aria-label', state.phase === 'playing' ? 'Pause' : 'Play');
  if (pre) $('scrub').value = '0';
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-checked', String(+b.dataset.speed === state.speed));
  $('labels').setAttribute('aria-pressed', String(state.labels));
}

$('snap').addEventListener('click', snap);
$('again').addEventListener('click', () => { snap(); if (matchMedia('(max-width: 959px)').matches) $('board').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
$('play').addEventListener('click', () => (state.phase === 'playing' ? pause() : play()));
$('scrub').addEventListener('input', e => {
  if (!state.play) return;
  cancelAnimationFrame(raf);
  state.t = (+e.target.value / 1000) * board.duration();
  state.phase = state.t >= board.duration() ? 'done' : 'paused';
  draw(); caption(); syncTransport();
  if (state.phase === 'done') showResult();
});
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => { state.speed = +b.dataset.speed; save(); syncTransport(); });
$('labels').addEventListener('click', () => { state.labels = !state.labels; board.labels = state.labels; save(); syncTransport(); draw(); });

// Tap a player to see who he is and what he's doing.
let down = null;
$('board').addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
$('board').addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
  const r = $('board').getBoundingClientRect();
  const i = board.hit(e.clientX - r.left, e.clientY - r.top);
  if (i < 0 || i === board.selected) { board.selected = -1; hideWho(); } else { board.selected = i; showWho(i); }
  draw();
});
$('whoClose').addEventListener('click', () => { board.selected = -1; hideWho(); draw(); });

function showWho(i) {
  const p = state.play.players[i];
  const [title, about] = POSITIONS[p.info] || POSITIONS[p.label] || [p.label, ''];
  const hiddenJob = p.team !== state.side && hidden();
  $('whoPos').textContent = `${p.label} · ${title}`;
  $('whoJob').textContent = hiddenJob ? 'His job on this play is hidden until the snap. Read the alignment: where he stands gives some of it away.' : `On this play: ${state.play.jobs[i]}`;
  $('whoAbout').textContent = about;
  $('who').hidden = false;
}
function hideWho() { $('who').hidden = true; }

// ---------------------------------------------------------------- choosers

function chips(host, label, items, current, pick, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pick';
  const h = document.createElement('p');
  h.className = 'pick-label';
  h.textContent = label;
  wrap.append(h);
  const groups = opts.groups || [{ name: '', items }];
  for (const g of groups) {
    if (g.name) { const gl = document.createElement('p'); gl.className = 'group-label'; gl.textContent = g.name; wrap.append(gl); }
    const row = document.createElement('div');
    row.className = 'chips';
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', g.name || label);
    for (const it of g.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.id === current));
      b.disabled = !!opts.disabled;
      b.innerHTML = it.sub ? `${esc(it.name)} <small>${esc(it.sub)}</small>` : esc(it.name);
      b.addEventListener('click', () => pick(it.id));
      row.append(b);
    }
    wrap.append(row);
  }
  if (opts.blurb) { const p = document.createElement('p'); p.className = 'blurb'; p.textContent = opts.blurb; wrap.append(p); }
  host.append(wrap);
}

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function offenseChooser(host, readonly) {
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const set = patch => { Object.assign(state.off, patch); afterChange(); };
  chips(host, 'Formation', FORMATIONS.map(f => ({ id: f.id, name: f.name, sub: f.personnel })), fm.id, id => set({ formation: id }), {
    disabled: readonly, blurb: `${fm.blurb} ${fm.personnel} personnel.`,
  });
  chips(host, 'Strong side', [{ id: 'R', name: 'Right' }, { id: 'L', name: 'Left' }], state.off.flip ? 'L' : 'R', id => set({ flip: id === 'L' }), { disabled: readonly });
  chips(host, 'Play', PLAYS, pl.id, id => set({ play: id }), {
    disabled: readonly, blurb: pl.blurb,
    groups: [{ name: 'Runs', items: PLAYS.filter(p => p.type === 'run') }, { name: 'Passes', items: PLAYS.filter(p => p.type === 'pass') }],
  });
}

function defenseChooser(host, readonly) {
  const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage), pr = byId(PRESSURES, state.def.pressure);
  const set = patch => { Object.assign(state.def, patch); afterChange(); };
  chips(host, 'Front', FRONTS, fr.id, id => set({ front: id }), { disabled: readonly, blurb: fr.blurb });
  chips(host, 'Coverage', COVERAGES, cv.id, id => set({ coverage: id }), { disabled: readonly, blurb: cv.blurb });
  const zero = cv.id === 'c0';
  chips(host, 'Pressure', PRESSURES, zero ? 'blitz' : pr.id, id => set({ pressure: id }), {
    disabled: readonly || zero, blurb: zero ? 'Cover 0 sends everyone who isn\'t covering a receiver.' : pr.blurb,
  });
}

function afterChange() {
  save();
  state.seed = newSeed();
  renderChoosers();
  lineUp();
  clearChart();
}

function renderChoosers() {
  const mine = $('mineBody'), theirs = $('theirsBody');
  mine.textContent = ''; theirs.textContent = '';
  $('mineTitle').textContent = state.side === 'O' ? 'Your call: offense' : 'Your call: defense';
  $('theirsTitle').textContent = state.side === 'O' ? 'Their call: defense' : 'Their call: offense';
  (state.side === 'O' ? offenseChooser : defenseChooser)(mine, false);
  $('auto').checked = state.auto;
  if (!state.auto) (state.side === 'O' ? defenseChooser : offenseChooser)(theirs, false);
  for (const b of document.querySelectorAll('[data-side]')) b.setAttribute('aria-checked', String(b.dataset.side === state.side));
  $('newLook').hidden = !state.auto;
  syncTheirs();
}

function theirSummary() {
  if (state.side === 'O') {
    const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
    return `${fr.name}, ${cv.name}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? ', blitz' : ', rush four'}`;
  }
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  return `${fm.name} (strong ${state.off.flip ? 'left' : 'right'}), ${pl.name}`;
}

function syncTheirs() {
  const hint = $('theirsHint');
  if (!state.auto) { hint.textContent = 'You\'re calling both sides. Turn on "Let the other coach pick" to be surprised.'; return; }
  if (state.phase === 'pre') hint.textContent = state.side === 'O'
    ? 'Hidden until the snap. Read their alignment on the board: how many safeties are deep, how many defenders are in the box.'
    : 'Hidden until the snap. You can see their formation; the play is a surprise.';
  else hint.textContent = `They called: ${theirSummary()}.`;
}

function renderMatchup() {
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
  const dim = what => ` <span class="dim">· ${what} hidden</span>`;
  const off = esc(fm.name) + (state.side === 'D' && hidden() ? dim('play') : ` · ${esc(pl.name)}`);
  const def = esc(fr.name) + (state.side === 'O' && hidden() ? dim('coverage') : ` · ${esc(cv.name)}${cv.id !== 'c0' && state.def.pressure === 'blitz' ? ' · Blitz' : ''}`);
  $('matchup').innerHTML = `${off}  vs  ${def}`;
}

for (const b of document.querySelectorAll('[data-side]')) b.addEventListener('click', () => {
  if (state.side === b.dataset.side) return;
  state.side = b.dataset.side;
  if (state.auto) rollTheirs();
  afterChange();
});
$('auto').addEventListener('change', e => {
  state.auto = e.target.checked;
  if (state.auto) rollTheirs();
  afterChange();
});
$('newLook').addEventListener('click', () => { rollTheirs(); afterChange(); $('board').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });

// ---------------------------------------------------------------- the result

function headline(res) {
  const n = Math.round(Math.abs(res.yards));
  const yd = v => `${v} yard${v === 1 ? '' : 's'}`;
  switch (res.kind) {
    case 'incomplete': return 'Incomplete';
    case 'int': return 'Intercepted';
    case 'throwaway': return 'Thrown away';
    case 'sack': return n ? `Sacked for a loss of ${yd(n)}` : 'Sacked at the line';
    default: return res.yards >= 0.5 ? `Gain of ${yd(n)}` : res.yards <= -0.5 ? `Loss of ${yd(n)}` : 'No gain';
  }
}

function showResult() {
  const P = state.play, res = P.result;
  const offWin = (res.kind === 'run' || res.kind === 'catch') && res.yards >= 4;
  $('resKicker').textContent = offWin ? 'A win for the offense' : 'A win for the defense';
  $('resKicker').dataset.win = offWin ? 'O' : 'D';
  $('resHead').textContent = headline(res);
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
  $('resVs').textContent = `${pl.name} from ${fm.name} against ${fr.name}, ${cv.name}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? ' with a blitz' : ''}.`;
  const story = $('story');
  story.textContent = '';
  for (const e of P.events) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${e.t.toFixed(1)}s</span> ${esc(e.text)}`;
    story.append(li);
  }
  const { note, reads } = coachNote(P);
  $('note').textContent = note;
  const ul = $('reads');
  ul.textContent = '';
  for (const r of reads) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  $('shareMsg').textContent = '';
  $('result').hidden = false;
  syncTheirs();
}

function coachNote(P) {
  const pl = byId(PLAYS, state.off.play), cv = byId(COVERAGES, state.def.coverage);
  const reads = [];
  const high = P.box.high;
  reads.push(high >= 2 ? 'Safeties: two deep before the snap, a Cover 2 or Cover 4 look.' : high === 1 ? 'Safeties: one deep in the middle, a Cover 1 or Cover 3 look.' : 'Safeties: nobody deep. Expect man coverage and a blitz.');
  reads.push(`Box: ${P.box.box} defenders near the line against ${P.box.blockers} blockers.`);
  const rushers = P.overlay.filter(o => o.kind === 'rush').length;
  if (pl.type === 'pass') {
    const pro = P.overlay.filter(o => o.kind === 'pro').length;
    reads.push(`Rush: ${rushers} rushers against ${pro} in protection${P.free.length ? `; ${P.free.map(i => nm(P, i)).join(' and ')} came unblocked` : ''}.`);
  } else if (P.unblocked.length) {
    reads.push(`Unblocked by design: ${P.unblocked.map(i => nm(P, i)).join(', ')}.`);
  }
  const note = pl.type === 'pass' ? NOTES[pl.id][cv.id] : RUN_NOTES[pl.id] + (P.box.box > P.box.blockers ? ` Here the defense had ${P.box.box - P.box.blockers} more in the box than the offense had blockers.` : P.box.box < P.box.blockers ? ' Here the offense had more blockers than the defense had defenders in the box: a good look to run against.' : ' Here the numbers in the box were even.');
  return { note, reads };
}

// A short name for a defender, for the notes ("the Will", "the strong safety").
function nm(P, i) {
  const p = P.players[i];
  const names = { DT: 'the defensive tackle', NT: 'the nose', M: 'the Mike', W: 'the Will', S: 'the Sam', J: 'the Jack', FS: 'the free safety', SS: 'the strong safety', NB: 'the nickel back', CB: 'a corner', DE: 'a defensive end' };
  return names[p.label] || `the ${p.label}`;
}

$('share').addEventListener('click', async () => {
  const c = call();
  const code = [state.side, c.formation, c.play, c.flip ? 1 : 0, c.front, c.coverage, c.pressure, state.seed].join('.');
  const base = document.documentElement.hasAttribute('data-single') || location.protocol === 'file:' ? SITE : location.href.split('#')[0];
  const url = `${base}#p=${code}`;
  try { await navigator.clipboard.writeText(url); $('shareMsg').textContent = 'Link copied. Whoever opens it sees this exact play.'; }
  catch { $('shareMsg').textContent = url; }
});

function fromLink() {
  const m = location.hash.match(/p=([OD])\.(\w+)\.(\w+)\.([01])\.(\w+)\.(\w+)\.(\w+)\.(\d+)/);
  if (!m) return false;
  const [, side, formation, playId, flip, front, coverage, pressure, seed] = m;
  if (!FORMATIONS.some(f => f.id === formation) || !PLAYS.some(p => p.id === playId) || !FRONTS.some(f => f.id === front) || !COVERAGES.some(c => c.id === coverage)) return false;
  Object.assign(state, { side, auto: false, seed: +seed >>> 0 });
  state.off = { formation, play: playId, flip: flip === '1' };
  state.def = { front, coverage, pressure: pressure === 'blitz' ? 'blitz' : 'four' };
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}

// ---------------------------------------------------------------- the chart: this call against everything

let chartJob = 0;
let chart = null; // the rows of the last run: { rows: [{ id, name, call, avg, rate }], pressure }
const RUN_LABEL = $('runChart').textContent, SNAPS = 20;

function clearChart() {
  chartJob++;
  chart = null;
  $('bars').textContent = '';
  $('chartTitle').textContent = state.side === 'O' ? 'Your play against each coverage' : 'Your defense against each play';
  $('chartHint').textContent = chartHint();
  $('runChart').textContent = RUN_LABEL;
  $('runChart').disabled = false;
}

// Before the snap the offense's chart can't use the other coach's real pressure without giving it away, so every
// coverage gets a four-man rush (Cover 0 always blitzes) until the call is out.
function chartHint() {
  const fm = byId(FORMATIONS, state.off.formation).name;
  if (state.side === 'D') return `Average yards a play allowed, against ${fm}. A play counts as a success for the offense if it gains 4 yards or more.`;
  const pressure = chart ? chart.pressure : hidden() ? 'four' : state.def.pressure;
  return `Average yards a play, from ${fm} against a ${byId(FRONTS, state.def.front).name} front ${pressure === 'blitz' ? 'with a blitz' : 'rushing four'}.`
    + `${hidden() ? ' Their real call stays hidden until the snap.' : ''} A play counts as a success if it gains 4 yards or more.`;
}
function syncChart() { $('chartHint').textContent = chartHint(); if (chart) drawBars(); }

// A snap takes a few milliseconds on a laptop and up to about 90 on a slow phone, so the chart runs about 10 ms' worth
// at a time and lets the page answer taps and draw in between. While a play is running it waits, so the play gets
// every frame. (A plain timeout, not scheduler.yield(): that one goes ahead of drawing and of timers, and a slow phone
// drew the page about ten times a second until the chart was done.)
const breather = () => new Promise(r => setTimeout(r, 0));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function runChart() {
  const job = ++chartJob, button = $('runChart');
  button.disabled = true;
  const base = call();
  if (state.side === 'O' && hidden()) base.pressure = 'four';
  const rows = state.side === 'O'
    ? COVERAGES.map(c => ({ id: c.id, name: c.name, call: { ...base, coverage: c.id } }))
    : PLAYS.map(p => ({ id: p.id, name: p.name, call: { ...base, play: p.id } }));
  chart = { rows, pressure: base.pressure };
  $('chartHint').textContent = chartHint();
  drawBars();
  let slice = performance.now();
  for (const [n, r] of rows.entries()) {
    button.textContent = `Running… ${n + 1} of ${rows.length}`;
    let yds = 0, ok = 0;
    for (let k = 0; k < SNAPS; k++) {
      if (performance.now() - slice > 10 || state.phase === 'playing') {
        await breather();
        while (state.phase === 'playing' && job === chartJob) await wait(100);
        if (job !== chartJob) return;
        slice = performance.now();
      }
      const res = simulate({ ...r.call, flip: k % 2 === 1 }, newSeed()).result;
      yds += res.yards; if ((res.kind === 'run' || res.kind === 'catch') && res.yards >= 4) ok++;
    }
    r.avg = yds / SNAPS; r.rate = ok / SNAPS;
    drawBars();
  }
  button.textContent = RUN_LABEL;
  button.disabled = false;
}

// The row for the other side's call is marked only once that call is out.
function drawBars() {
  const host = $('bars');
  host.textContent = '';
  const done = chart.rows.filter(r => r.avg !== undefined);
  const max = Math.max(8, ...done.map(r => Math.abs(r.avg)));
  const neg = done.some(r => r.avg < 0);
  const mineId = hidden() ? null : state.side === 'O' ? state.def.coverage : state.off.play;
  const tag = state.auto ? 'their call' : 'this call';
  host.insertAdjacentHTML('beforeend', '<div class="bar-head" aria-hidden="true">avg yards · success</div>');
  for (const r of chart.rows) {
    const mine = r.id === mineId;
    const name = `<span class="bar-name"><span>${esc(r.name)}</span>${mine ? `<em>${tag}</em>` : ''}</span>`;
    const row = document.createElement('div');
    row.setAttribute('role', 'listitem');
    host.append(row);
    if (r.avg === undefined) { // still to run
      row.className = 'bar-row waiting';
      row.innerHTML = `${name}<span class="bar-track"></span><span class="bar-val">…</span>`;
      continue;
    }
    row.className = 'bar-row' + (mine ? ' mine' : '');
    const w = Math.abs(r.avg) / max * (neg ? 50 : 100);
    const left = neg ? (r.avg < 0 ? 50 - w : 50) : 0;
    row.innerHTML = `${name}
      <span class="bar-track${neg ? ' split' : ''}"><span class="bar ${r.avg < 0 ? 'neg' : ''}" style="left:${left}%;width:${Math.max(0.6, w)}%"></span></span>
      <span class="bar-val">${r.avg >= 0 ? '' : '−'}${Math.abs(r.avg).toFixed(1)} <small>${Math.round(r.rate * 100)}%</small></span>`;
    row.title = `${r.name}${mine ? ` (${tag})` : ''}: ${r.avg.toFixed(1)} yards a play, ${Math.round(r.rate * 100)}% successful`;
  }
}
$('runChart').addEventListener('click', runChart);

// ---------------------------------------------------------------- the playbook

function playbook() {
  const grid = $('pbGrid');
  const sec = (title, open, body) => {
    const d = document.createElement('details');
    d.className = 'pb';
    if (open) d.open = true;
    d.innerHTML = `<summary>${esc(title)}</summary>${body}`;
    grid.append(d);
  };
  const dl = rows => `<dl>${rows.map(([a, b]) => `<dt>${esc(a)}</dt><dd>${esc(b)}</dd>`).join('')}</dl>`;
  const pos = keys => keys.map(k => [`${k.replace(/34|slot/, '')} · ${POSITIONS[k][0]}`, POSITIONS[k][1]]);
  sec('Offense positions', false, dl(pos(['QB', 'RB', 'FB', 'X', 'Z', 'H', 'Y', 'U', 'LT', 'LG', 'C', 'RG', 'RT'])));
  sec('Defense positions', false, dl(pos(['DE', 'DT', 'NT', 'S', 'M', 'W', 'J', 'CB', 'NB', 'FS', 'SS'])));
  sec('Formations and personnel', false, `<p>${esc(PERSONNEL)}</p>` + dl(FORMATIONS.map(f => [`${f.name} · ${f.personnel}`, f.blurb])));
  sec('Fronts and techniques', false, `<p>Technique numbers tell a defensive lineman where to line up against the offensive line. Gaps between the blockers are lettered from the center out: A between the center and a guard, B between guard and tackle, C outside the tackle, D outside the tight end.</p>`
    + techDiagram() + dl([...Object.entries(TECHNIQUES).map(([k, v]) => [`${k === 'w5' ? 'Wide 5' : k}-technique`, v.replace(/^an? /, '').replace(/^\w/, c => c.toUpperCase()) + '.']), ...FRONTS.map(f => [f.name, f.blurb])]));
  sec('Coverages', false, dl([...COVERAGES.map(c => [c.name, c.blurb]), ['Man and zone', 'In man coverage each defender follows one receiver wherever he goes. In zone coverage each defender guards an area and plays whoever comes into it.'], ['Reading the shell', 'Before the snap, count the safeties deep. Two deep usually means Cover 2 or Cover 4; one deep means Cover 1 or Cover 3; none means Cover 0 and a blitz. Defenses disguise it, so the read is a guess until the snap.']]));
  sec('Run plays', false, dl(PLAYS.filter(p => p.type === 'run').map(p => [p.name, p.blurb])));
  sec('Pass plays', false, dl([...PLAYS.filter(p => p.type === 'pass').map(p => [p.name, p.blurb]), ['Reading the routes', 'Receivers are counted from the outside in on each side: #1 is the widest, #2 the next one in. A pass concept tells each number what to run, so the same play works from any formation.']]));
  // drag6 and bflat are the same routes as drag and flat at another depth or from the backfield, so they're listed once.
  const routeDesc = { flat: 'Out toward the sideline about four yards past the line, run by a receiver or by a back coming out of the backfield.' };
  sec('Routes', false, dl(Object.entries(ROUTES).filter(([k]) => !['drag6', 'bflat'].includes(k)).map(([k, r]) => [r.name.replace(/^\w/, c => c.toUpperCase()), routeDesc[k] || r.desc.replace(/^[^:]+: /, '').replace(/^\w/, c => c.toUpperCase())])));
  sec('How to read the board', false, dl([
    ['O and X', 'The offense is drawn as circles (the center as a square) and the defense as Xs, the way coaches draw them.'],
    ['Lines with arrows', 'Routes for receivers and the path for a ball carrier. A dashed route starts late: the back blocks first.'],
    ['A line with a bar across the end', 'A block.'],
    ['Dashed line to a bubble', 'A zone drop: the defender goes to that area.'],
    ['Dotted line to a receiver', 'Man-to-man coverage on that receiver.'],
    ['Arrows from the defense', 'Pass rush. A blitzer\'s arrow is drawn in the bright colour.'],
    ['Trails', 'Once the play is running, each man leaves a trail of where he went. The drawn-up play stays faintly underneath, so you can see where it broke down.'],
  ]));
}

function techDiagram() {
  // The offensive line with the technique numbers over it.
  const ol = [-3, -1.5, 0, 1.5, 3, 4.6], lab = ['T', 'G', 'C', 'G', 'T', 'TE'];
  const techs = [['0', 0], ['1', 0.7], ['2', 1.5], ['3', 2.2], ['4', 3], ['5', 3.75], ['7', 4.05], ['6', 4.6], ['9', 5.4]];
  const X = x => 150 + x * 24;
  let s = '<svg class="tech" viewBox="0 0 300 92" role="img" aria-label="The offensive line with technique numbers: 0 on the center, 1 on his shoulder, 2 on the guard, 3 outside the guard, 4 on the tackle, 5 outside the tackle, 7 inside the tight end, 6 on him, 9 outside him.">';
  for (const [t, x] of techs) s += `<text x="${X(x)}" y="22" text-anchor="middle">${t}</text>`;
  for (const [g, x] of [['A', 0.75], ['B', 2.25], ['C', 3.8], ['D', 5.6]]) s += `<text class="gap" x="${X(x)}" y="44" text-anchor="middle">${g}</text>`;
  ol.forEach((x, n) => {
    s += n === 2 ? `<rect x="${X(x) - 8}" y="56" width="16" height="16" rx="2"/>` : `<circle cx="${X(x)}" cy="64" r="8"/>`;
    s += `<text class="pos" x="${X(x)}" y="88" text-anchor="middle">${lab[n]}</text>`;
  });
  return s + '</svg>';
}

// ---------------------------------------------------------------- start

load();
const linked = fromLink();
if (!linked && state.auto) rollTheirs();
renderChoosers();
playbook();
clearChart();
lineUp();
syncTransport();
if (linked) setTimeout(play, 500);

new ResizeObserver(() => { board.resize(); draw(); }).observe($('board'));
const recolor = () => { board.readColors(); draw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);
new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.fonts?.ready.then(draw);

if ('serviceWorker' in navigator && !document.documentElement.hasAttribute('data-single') && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For the screenshot and test scripts.
window.chalkTalk = { state, board, lineUp, play, pause, snap, finish, simulate };
