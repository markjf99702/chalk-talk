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
  iz: 'Inside zone works when there are as many blockers as defenders in the box.',
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
  linked: false, // showing a shared play: both calls, until the first change
  seen: false, // the other coach's call has been out since he picked it: a snap showed it
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
  ownAuto = state.auto;
  own.off = { ...state.off };
  own.def = { ...state.def };
}
// The person's own "Let the other coach pick". A shared link shows both calls without changing it: only the switch does.
let ownAuto = true;
// The person's own call for each side, which is what's saved. While the other coach picks, the side you aren't calling
// is his, and switching sides brings yours back (see the side pick); calling both sides, both are yours.
const own = { off: { ...state.off }, def: { ...state.def } };
function keepOwn() {
  if (!state.auto || state.side === 'O') own.off = { ...state.off };
  if (!state.auto || state.side === 'D') own.def = { ...state.def };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ side: state.side, off: own.off, def: own.def, auto: ownAuto, labels: state.labels, speed: state.speed })); } catch { /* fine */ }
}

const call = () => ({ ...state.off, ...state.def });
// The other coach's call is hidden from the board, the chart and the player cards until the snap. Once a snap has shown
// it, it stays out until he picks again.
const hidden = () => state.auto && state.phase === 'pre' && !state.seen;

// The other coach's call, picked the way a real one might: nickel against three and four receivers, and so on. It's
// never the call they had (New look always changes something), short of ten unlucky rolls in a row.
function rollTheirs() {
  state.seen = false;
  const R = rng(newSeed());
  const w = list => { let x = R() * list.reduce((a, [, p]) => a + p, 0); for (const [v, p] of list) { if ((x -= p) <= 0) return v; } return list[0][0]; };
  const theirs = () => (state.side === 'O'
    ? [state.def.front, state.def.coverage, state.def.coverage === 'c0' ? 'blitz' : state.def.pressure] // Cover 0 always blitzes
    : [state.off.formation, state.off.play, state.off.flip]).join();
  const had = theirs();
  for (let tries = 0; tries < 10 && theirs() === had; tries++) {
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
}

// ---------------------------------------------------------------- the board

const board = new Board($('board'));

function lineUp() {
  cancelAnimationFrame(raf); // a frame of the last play still to come would run its clock on into this one
  state.play = simulate(call(), state.seed);
  state.phase = 'pre';
  state.t = 0;
  board.setPlay(state.play);
  board.t = 0;
  board.selected = -1;
  hideWho();
  $('why').hidden = true;
  $('result').hidden = true;
  syncBoard();
  syncTransport();
  syncTheirs();
  renderMatchup();
  setCaption(firstHint ? FIRST_HINT : '');
  draw();
}

// Before the first snap of a visit, the empty caption says what to do first, until a player is tapped or the play is
// snapped.
const FIRST_HINT = 'Tap any player to see his job, then Snap.';
let firstHint = true;
function dropHint() {
  if (!firstHint) return;
  firstHint = false;
  if ($('caption').textContent === FIRST_HINT) setCaption('');
}

function syncBoard() {
  board.flip = state.side === 'D';
  // The words on the board go over the deep field: at the top, or at the bottom when the board is turned around.
  $('board').parentElement.classList.toggle('flipped', board.flip);
  board.mineTeam = state.side;
  board.labels = state.labels;
  board.showMine = true;
  board.showTheirs = !hidden();
}

let raf = 0, last = 0;
function draw() { board.t = state.t; board.render(); placeWho(); }

function play() {
  if (!state.play) return;
  const snapped = state.phase === 'pre';
  if (snapped) { linkNote = ''; dropHint(); } // a word about a link that couldn't open lasts until the next play
  if (snapped && state.auto) state.seen = true;
  if (state.phase === 'done' || state.t >= board.duration()) state.t = 0;
  state.phase = 'playing';
  $('why').hidden = true;
  syncBoard();
  syncTheirs();
  renderMatchup();
  syncTransport();
  if (snapped) { // the other side's call is out now: the tapped player's job, and which row of the chart it is
    // On a narrow board the card would hide part of the play, so it closes; a bigger board has room to keep it.
    if (board.selected >= 0 && narrow()) { board.selected = -1; hideWho(); } else if (board.selected >= 0) showWho(board.selected);
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
  showWhy();
}

// At the end of the play, the headline and a way down to the explanation, where the caption was.
function showWhy() {
  setCaption('');
  $('why').innerHTML = `${esc(headline(state.play.result))} · <span class="why-go">Why <span aria-hidden="true">↓</span></span>`;
  $('why').hidden = false;
  placeWhy();
}
// The button sits along the deep end of the board, but at the end of a deep pass the receiver and the defenders around
// him can be there too: it goes in the middle, or to the left or the right if that covers fewer of them.
function placeWhy() {
  const why = $('why');
  if (why.hidden || !state.play) return;
  why.style.left = why.style.transform = '';
  const cv = board.cv.getBoundingClientRect(), b = why.getBoundingClientRect();
  const r = board.radius(), reach = r * 2.4 + 4, top = b.top - cv.top, bottom = b.bottom - cv.top;
  const spots = state.play.players.map(p => { const at = board.pos(board.t, p.i); return [board.sx(at.x), board.sy(at.y)]; })
    .filter(([, y]) => y + reach > top && y - reach < bottom);
  const covers = left => spots.filter(([x]) => x + r + 2 > left && x - r - 2 < left + b.width).length;
  const middle = b.left - cv.left, side = Math.min(middle, 8);
  const best = [middle, side, cv.width - side - b.width].reduce((a, c) => (covers(c) < covers(a) ? c : a));
  if (best !== middle) { why.style.left = `${best}px`; why.style.transform = 'none'; }
}
// The result card, just under the board where the board stays at the top of a phone, or near the top.
$('why').addEventListener('click', () => {
  const stage = document.querySelector('.stage');
  const under = innerWidth < 960 && getComputedStyle(stage).position === 'sticky' ? stage.offsetHeight + 8 : 12;
  const top = $('result').getBoundingClientRect().top + scrollY - under;
  scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('resHead').focus({ preventScroll: true });
});

function snap() {
  if (state.phase !== 'pre') { // run it again: same calls, a new roll of the dice
    state.seed = newSeed();
    lineUp();
  }
  play();
}

// The last two things that happened in the last 2.2 seconds, the older one above and fainter, so two that happen close
// together both stay up long enough to read. It follows the clock alone, so scrubbing and pausing show the same words.
function caption() {
  const evs = state.play.events.filter(e => e.t <= state.t + 0.001 && state.t - e.t < 2.2 && e.kind !== 'shed');
  setCaption(evs.slice(-2).map(e => e.text));
}
// Each line of the caption in its own span, which has a soft backing in the board's colour so it reads over the trails.
// A line still up stays as it is, so a screen reader reads each line once, when it's new.
function setCaption(lines) {
  const el = $('caption');
  lines = [].concat(lines).filter(Boolean);
  const now = [...el.children].map(s => s.textContent);
  let keep = Math.min(now.length, lines.length);
  while (keep && now.slice(now.length - keep).join('\n') !== lines.slice(0, keep).join('\n')) keep--;
  if (keep === now.length && keep === lines.length) return; // the same words: leave them be
  for (let k = keep; k < now.length; k++) el.firstElementChild.remove();
  for (const text of lines.slice(keep)) {
    const span = document.createElement('span');
    span.textContent = text;
    el.append(span);
  }
}

// ---------------------------------------------------------------- transport

function syncTransport() {
  const pre = state.phase === 'pre';
  $('snap').textContent = pre ? 'Snap' : 'Snap again';
  $('play').disabled = pre;
  $('scrub').disabled = pre;
  // At the end of the play it watches the same snap again, from the start.
  const [glyph, name] = { playing: ['❚❚', 'Pause'], done: ['↺', 'Watch it again'] }[state.phase] || ['▶', 'Play'];
  $('play').innerHTML = `<span aria-hidden="true">${glyph}</span>`;
  $('play').setAttribute('aria-label', name);
  if (pre) $('scrub').value = '0';
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-checked', String(+b.dataset.speed === state.speed));
  $('labels').setAttribute('aria-pressed', String(state.labels));
}

$('snap').addEventListener('click', snap);
// The result card's buttons go away with it as the next play lines up, so the focus goes on to Snap.
const toSnap = () => $('snap').focus({ preventScroll: true });
$('again').addEventListener('click', () => { toSnap(); snap(); if (matchMedia('(max-width: 959px)').matches) $('board').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
$('play').addEventListener('click', () => (state.phase === 'playing' ? pause() : play()));
$('scrub').addEventListener('input', e => {
  if (!state.play) return;
  cancelAnimationFrame(raf);
  state.t = (+e.target.value / 1000) * board.duration();
  state.phase = state.t >= board.duration() ? 'done' : 'paused';
  draw(); caption(); syncTransport();
  if (state.phase === 'done') { showResult(); showWhy(); } else $('why').hidden = true;
});
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => { state.speed = +b.dataset.speed; save(); syncTransport(); });
$('labels').addEventListener('click', () => { state.labels = !state.labels; board.labels = state.labels; save(); syncTransport(); draw(); });

// Tap a player to see who he is and what he's doing. On a crowded line a fingertip covers two or three players, so a tap
// where the picked player is goes to the next one there: tap again until it's the one you meant. A tap on empty field
// (or the card's ×) closes the card.
let down = null;
$('board').addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
$('board').addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) return;
  const r = $('board').getBoundingClientRect();
  const near = board.hit(e.clientX - r.left, e.clientY - r.top);
  if (!near.length) { board.selected = -1; hideWho(); } else {
    const i = near[(near.indexOf(board.selected) + 1) % near.length];
    board.selected = i; showWho(i); dropHint();
  }
  draw();
});
$('whoClose').addEventListener('click', () => { board.selected = -1; hideWho(); draw(); });
// On a narrow board the card leaves out what the position is in general until it's asked for, and keeps it open for
// the next player once it has been.
let moreAbout = false;
$('whoMore').addEventListener('click', () => { moreAbout = !moreAbout; syncMore(); placeWho(); });

function showWho(i) {
  const p = state.play.players[i];
  const [title, about] = POSITIONS[p.info] || POSITIONS[p.label] || [p.label, ''];
  const hiddenJob = p.team !== state.side && hidden();
  const fresh = $('who').hidden || $('who').dataset.i !== String(i);
  $('who').dataset.i = i;
  $('whoPos').textContent = `${p.label} · ${title}`;
  $('whoJob').textContent = hiddenJob ? 'His job on this play is hidden until the snap. Read the alignment: where he stands gives some of it away.' : `On this play: ${state.play.jobs[i]}`;
  $('whoAbout').textContent = about;
  $('whoMore').textContent = `More about the ${p.label}`;
  $('whoMore').hidden = !about;
  $('who').hidden = false;
  syncMore();
  placeWho(fresh);
}
function hideWho() { $('who').hidden = true; }
function syncMore() {
  $('who').classList.toggle('more', moreAbout);
  $('whoMore').setAttribute('aria-expanded', String(moreAbout));
  // Taps on the card go through to the board, unless there's more in it to scroll to.
  const body = $('whoBody');
  body.classList.toggle('scrolls', body.scrollHeight > body.clientHeight + 1);
}

// The card goes at the end of the board away from the player it's about, so it doesn't hide him, and while the play
// runs it moves if he runs under it.
function placeWho(fresh) {
  const who = $('who');
  if (who.hidden || board.selected < 0 || !state.play) return;
  const at = board.pos(board.t, board.selected);
  const x = board.sx(at.x), y = board.sy(at.y), reach = board.radius() * 2.4 + 4; // his ring and his label
  if (fresh) who.classList.toggle('top', y > board.h / 2);
  const cv = board.cv.getBoundingClientRect();
  const covered = () => {
    const c = who.getBoundingClientRect();
    const w = Math.min(c.right - cv.left, x + reach) - Math.max(c.left - cv.left, x - reach);
    const h = Math.min(c.bottom - cv.top, y + reach) - Math.max(c.top - cv.top, y - reach);
    return w > 0 && h > 0 ? h : 0;
  };
  const before = covered();
  if (!before) return;
  who.classList.toggle('top');
  if (covered() > before) who.classList.toggle('top');
}

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
      b.dataset.key = `${label}:${it.id}`; // the same chip once the choosers are drawn again, for the keyboard's focus
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
  const set = patch => {
    const was = fm.personnel;
    Object.assign(state.off, patch);
    // New personnel and the other coach substitutes: nickel against three receivers, base against two backs. A new play
    // or strong side keeps his call, the way an audible at the line does.
    if (state.auto && state.side === 'O' && byId(FORMATIONS, state.off.formation).personnel !== was) rollTheirs();
    afterChange();
  };
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
  const focused = document.activeElement?.dataset.key; // a chip picked from the keyboard keeps the focus once it's drawn again
  state.linked = false;
  linkNote = '';
  keepOwn();
  save();
  state.seed = newSeed();
  renderChoosers();
  lineUp();
  clearChart();
  if (focused) document.querySelector(`[data-key="${CSS.escape(focused)}"]`)?.focus();
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
  $('newLook').hidden = $('theirsLook').hidden = !state.auto;
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
  if (linkNote) { hint.textContent = linkNote; return; }
  if (!state.auto) {
    hint.textContent = state.linked ? 'A shared play: both calls are shown. Turn on "Let the other coach pick" to call your own.'
      : 'You\'re calling both sides. Turn on "Let the other coach pick" to be surprised.';
    return;
  }
  if (hidden()) hint.textContent = state.side === 'O'
    ? 'Hidden until the snap. Read their alignment: how many safeties are deep, how far off the corners are, how many defenders are in the box. Then call the play that beats it: change your play and they keep their call; change your personnel and they\'ll substitute.'
    : 'Hidden until the snap. You can see their formation; the play is a surprise. Change your call to match it: they keep theirs.';
  else if (state.phase === 'pre') hint.textContent = `Same call as last snap: ${theirSummary()}. New look gets you a new one.`;
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
  if (state.auto) { // your own call for this side comes back, and the other coach picks for the other one
    if (state.side === 'O') state.off = { ...own.off }; else state.def = { ...own.def };
    rollTheirs();
  }
  afterChange();
});
$('auto').addEventListener('change', e => {
  state.auto = ownAuto = e.target.checked;
  if (state.auto) rollTheirs();
  afterChange();
});
// New look: the other coach picks again. It's in the result card after a play, and in his card before the snap.
// The board says what it did until the snap, even when nothing there shows it: calling the defense, a new play from the
// same formation and strong side lines up just like the last one.
function newLook(e) {
  if (e?.currentTarget.closest('#result')) toSnap();
  const formation = () => `${state.off.formation} ${state.off.flip}`, was = formation();
  rollTheirs();
  afterChange();
  setCaption(state.side === 'D' && formation() === was ? 'New look: same formation, a new play.' : 'New look: they\'ve changed their call.');
  $('board').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
$('newLook').addEventListener('click', newLook);
$('theirsLook').addEventListener('click', newLook);

// ---------------------------------------------------------------- the result

// Whole yards, as the headline says them. The simulator spots the ball to the half yard, and a half rounds away from
// zero, so a 3.5-yard run is a gain of 4 and a success in the headline, the verdict over it and the chart alike.
const gained = res => Math.sign(res.yards) * Math.round(Math.abs(res.yards));
const success = res => (res.kind === 'run' || res.kind === 'catch') && gained(res) >= 4;

function headline(res) {
  const n = Math.abs(gained(res));
  const yd = v => `${v} yard${v === 1 ? '' : 's'}`;
  switch (res.kind) {
    case 'incomplete': return 'Incomplete';
    case 'int': return 'Intercepted';
    case 'throwaway': return 'Thrown away';
    case 'sack': return n ? `Sacked for a loss of ${yd(n)}` : 'Sacked at the line';
    default:
      if (res.long) return `Gain of ${Math.min(n, 60)}+ yards`; // still running when the board stopped counting
      return gained(res) > 0 ? `Gain of ${yd(n)}` : gained(res) < 0 ? `Loss of ${yd(n)}` : 'No gain';
  }
}

function showResult() {
  const P = state.play, res = P.result;
  const offWin = success(res);
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
  resetShare();
  $('actionsNote').textContent = `Snap again: the same two calls, played out fresh.${state.auto ? ' New look: the other coach changes his call.' : ''}`;
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
    const pro = P.protection.map(i => P.players[i].cls);
    // Who blocks: "5 linemen and 2 backs". Came unblocked: nobody got a hand on him before the throw or the sack.
    const count = (n, one, many) => (n === 1 ? `a ${one}` : `${n} ${many}`);
    const parts = [[pro.filter(c => c === 'ol').length, 'lineman', 'linemen'], [pro.filter(c => c === 'te').length, 'tight end', 'tight ends'],
      [pro.filter(c => c === 'rb' || c === 'fb').length, 'back', 'backs']].filter(([n]) => n).map(([n, one, many]) => count(n, one, many));
    const who = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
    reads.push(`Rush: ${rushers} rushers against ${pro.length} in protection (${who})${P.cameFree.length ? `; ${P.cameFree.map(i => nm(P, i)).join(' and ')} came unblocked` : ''}.`);
  } else if (P.unblocked.length) {
    reads.push(`Unblocked by design: ${P.unblocked.map(i => nm(P, i, true)).join(', ')}.`);
  }
  // On inside zone the line works to the play side; when that leaves the back-side end alone, the note says who he is.
  const backEnd = pl.id === 'iz' && P.unblocked.some(i => P.players[i].label === 'DE' && P.players[i].x * playSide(P) < 0)
    ? ' The back-side end was left unblocked: the line works to the play side, so he\'s the man a cutback has to beat.' : '';
  const note = pl.type === 'pass' ? NOTES[pl.id][cv.id] : RUN_NOTES[pl.id] + backEnd + (P.box.box > P.box.blockers ? ` Here the defense had ${P.box.box - P.box.blockers} more in the box than the offense had blockers.` : P.box.box < P.box.blockers ? ' Here the offense had more blockers than the defense had defenders in the box: a good look to run against.' : ' Here the numbers in the box were even.');
  return { note, reads };
}

// Which way a run goes: +1 to the offense's right, -1 to its left.
const playSide = P => Math.sign(byId(PLAYS, P.call.play).aim || 1) * (P.call.flip ? -1 : 1);

// A short name for a defender, for the notes ("the Will", "the strong safety"). On a run, the ends and linebackers are
// named by the side of the play they're on ("the back-side end", "the Will on the back side").
function nm(P, i, run) {
  const p = P.players[i];
  const names = { DT: 'the defensive tackle', NT: 'the nose', M: 'the Mike', W: 'the Will', S: 'the Sam', J: 'the Jack', FS: 'the free safety', SS: 'the strong safety', NB: 'the nickel back', CB: 'a corner', DE: 'a defensive end' };
  const side = run && (p.x * playSide(P) >= 0 ? 'play' : 'back');
  if (side && p.label === 'DE') return `the ${side}-side end`;
  if (side && 'SMWJ'.includes(p.label) && p.cls === 'lb') return `${names[p.label]} on the ${side} side`;
  return names[p.label] || `the ${p.label}`;
}

const SHARE_LABEL = $('share').textContent;
let shareTimer = 0;
function resetShare() {
  clearTimeout(shareTimer);
  $('share').textContent = SHARE_LABEL;
  $('shareMsg').textContent = '';
  $('shareUrl').hidden = true;
}
$('share').addEventListener('click', async () => {
  const c = call();
  const code = [state.side, c.formation, c.play, c.flip ? 1 : 0, c.front, c.coverage, c.pressure, state.seed].join('.');
  const base = document.documentElement.hasAttribute('data-single') || location.protocol === 'file:' ? SITE : location.href.split('#')[0];
  const url = `${base}#p=${code}`;
  resetShare();
  try {
    await navigator.clipboard.writeText(url);
    $('share').textContent = 'Link copied';
    $('shareMsg').textContent = 'Whoever opens it sees this exact play.';
    shareTimer = setTimeout(resetShare, 2000);
  } catch { // no clipboard here (an address that isn't https, or the browser said no): the link, ready to copy
    $('shareMsg').textContent = 'Couldn\'t copy it here. Copy this link:';
    const box = $('shareUrl');
    box.value = url;
    box.hidden = false;
    box.focus();
    box.select();
  }
});

// A play link in the address (#p=side.formation.play.flip.front.coverage.pressure.seed): 'ok' once it's set up,
// 'bad' for one this version can't open (the address is cleared either way), '' when there's none.
let linkNote = '';
function fromLink() {
  const hash = location.hash;
  if (!hash.startsWith('#p=')) return '';
  history.replaceState(null, '', location.pathname + location.search);
  const m = hash.match(/p=([OD])\.(\w+)\.(\w+)\.([01])\.(\w+)\.(\w+)\.(\w+)\.(\d+)/);
  if (!m) return 'bad';
  const [, side, formation, playId, flip, front, coverage, pressure, seed] = m;
  if (!FORMATIONS.some(f => f.id === formation) || !PLAYS.some(p => p.id === playId) || !FRONTS.some(f => f.id === front) || !COVERAGES.some(c => c.id === coverage)) return 'bad';
  Object.assign(state, { side, auto: false, linked: true, seed: +seed >>> 0 });
  state.off = { formation, play: playId, flip: flip === '1' };
  state.def = { front, coverage, pressure: pressure === 'blitz' ? 'blitz' : 'four' };
  linkNote = '';
  return 'ok';
}
function badLink() {
  linkNote = 'That link is for a play this version doesn\'t have.';
  syncTheirs();
  if (state.phase === 'pre') setCaption(linkNote);
}
// Another play link opened in a tab that's already open.
addEventListener('hashchange', () => {
  const link = fromLink();
  if (link === 'ok') { renderChoosers(); clearChart(); lineUp(); play(); }
  else if (link === 'bad') badLink();
});

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
  $('runChart').removeAttribute('aria-disabled');
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

// While it runs the button says it's busy and takes no clicks, but keeps the focus (a disabled one would drop it).
async function runChart() {
  const button = $('runChart');
  if (button.getAttribute('aria-disabled') === 'true') return;
  const job = ++chartJob;
  button.setAttribute('aria-disabled', 'true');
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
      yds += res.yards; if (success(res)) ok++;
    }
    r.avg = yds / SNAPS; r.rate = ok / SNAPS;
    drawBars();
  }
  button.textContent = RUN_LABEL;
  button.removeAttribute('aria-disabled');
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
    + techDiagram() + dl([...TECHNIQUES, ...FRONTS.map(f => [f.name, f.blurb])]));
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
  // The offensive line with the technique numbers over it. The tight end stands a little wide, so the 5, 7 and 6 between
  // the tackle and him read as three numbers rather than "57".
  const ol = [-3, -1.5, 0, 1.5, 3, 5], lab = ['T', 'G', 'C', 'G', 'T', 'TE'];
  const techs = [['0', 0], ['1', 0.7], ['2', 1.5], ['3', 2.2], ['4', 3], ['5', 3.6], ['7', 4.3], ['6', 5], ['9', 5.7]];
  const X = x => 128 + x * 27;
  let s = '<svg class="tech" viewBox="0 0 300 92" role="img" aria-label="The offensive line with technique numbers: 0 on the center, 1 on his shoulder, 2 on the guard, 3 outside the guard, 4 on the tackle, 5 outside the tackle, 7 inside the tight end, 6 on him, 9 outside him.">';
  for (const [t, x] of techs) s += `<text x="${X(x)}" y="22" text-anchor="middle">${t}</text>`;
  for (const [g, x] of [['A', 0.75], ['B', 2.25], ['C', 4], ['D', 5.85]]) s += `<text class="gap" x="${X(x)}" y="44" text-anchor="middle">${g}</text>`;
  ol.forEach((x, n) => {
    s += n === 2 ? `<rect x="${X(x) - 8}" y="56" width="16" height="16" rx="2"/>` : `<circle cx="${X(x)}" cy="64" r="8"/>`;
    s += `<text class="pos" x="${X(x)}" y="88" text-anchor="middle">${lab[n]}</text>`;
  });
  return s + '</svg>';
}

// ---------------------------------------------------------------- start

load();
const link = fromLink();
if (link === 'ok') firstHint = false; // a shared play runs on its own
if (link !== 'ok' && state.auto) rollTheirs();
renderChoosers();
playbook();
clearChart();
lineUp();
syncTransport();
if (link === 'ok') setTimeout(play, 500);
if (link === 'bad') badLink();

// A board under about 620 px wide (a phone, or the two-column layout on a small laptop) gets the compact player card.
function narrow() { return $('board').parentElement.classList.contains('narrow'); }
const fit = () => { board.resize(); $('board').parentElement.classList.toggle('narrow', board.w < 620); if (!$('who').hidden) syncMore(); draw(); placeWhy(); };
fit();
new ResizeObserver(fit).observe($('board'));
const recolor = () => { board.readColors(); draw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);
new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.fonts?.ready.then(draw);

if ('serviceWorker' in navigator && !document.documentElement.hasAttribute('data-single') && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For the screenshot and test scripts.
window.chalkTalk = { state, board, lineUp, play, pause, snap, finish, simulate };
