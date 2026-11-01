// Chalk Talk: the page. Picks the calls, runs the simulator, plays the result back on the board, and explains it.
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, PRESSURES, POSITIONS, PERSONNEL, TECHNIQUES, NOTES, ROUTES } from './playbook.js';
import { simulate, name } from './sim.js';
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
  draw: 'The draw wants defenders who think pass: rushers running up the field past the back, linebackers dropping into coverage. Against man coverage a defender is waiting on the back, and against an all-out blitz the rushers are already there.',
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

// Whether call a has everything call b has.
const same = (a, b) => Object.keys(b).every(f => a[f] === b[f]);
// A kept call that this version can play, tidied up, or null.
const okOff = o => (o && FORMATIONS.some(f => f.id === o.formation) && PLAYS.some(p => p.id === o.play) ? { formation: o.formation, play: o.play, flip: !!o.flip } : null);
const okDef = d => (d && FRONTS.some(f => f.id === d.front) && COVERAGES.some(c => c.id === d.coverage) ? { front: d.front, coverage: d.coverage, pressure: d.pressure === 'blitz' ? 'blitz' : 'four' } : null);

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) {
      if (s.side === 'O' || s.side === 'D') state.side = s.side;
      state.off = okOff(s.off) || state.off;
      state.def = okDef(s.def) || state.def;
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

// The play on the board, kept for this tab only: a reload, or a phone dropping the tab while it's in the background,
// comes back to it (the same snap and the same call from the other coach, finished if it had been snapped), while a new
// visit gets a fresh look.
const PLAY_KEY = 'chalk-talk.v1.play';
function keepPlay() {
  try { sessionStorage.setItem(PLAY_KEY, JSON.stringify({ side: state.side, auto: state.auto, off: state.off, def: state.def, seed: state.seed, seen: state.seen, snapped: state.phase !== 'pre' })); } catch { /* fine */ }
}
// The kept play, if it's for the calls you have now (after a shared play, say, it isn't).
function keptPlay() {
  try {
    const k = JSON.parse(sessionStorage.getItem(PLAY_KEY) || 'null'), off = okOff(k?.off), def = okDef(k?.def);
    if (!off || !def || k.side !== state.side || k.auto !== state.auto || !Number.isInteger(k.seed) || k.seed < 0) return null;
    if ((!state.auto || state.side === 'O') && !same(off, own.off)) return null;
    if ((!state.auto || state.side === 'D') && !same(def, own.def)) return null;
    return { off, def, seed: k.seed, seen: !!k.seen, snapped: !!k.snapped };
  } catch { return null; }
}

const call = () => ({ ...state.off, ...state.def });
// The other coach's call is hidden from the board, the chart and the player cards until the snap. Once a snap has shown
// it, it stays out until he picks again.
const hidden = () => state.auto && state.phase === 'pre' && !state.seen;

// The other coach's call, picked the way a real one might: nickel against three and four receivers, and so on. It's
// never the call they had (New look always changes something), short of ten unlucky rolls in a row.
// Calling the defense, his play leans on his personnel, so reading it before the snap tells you something: about this
// share of his plays are runs from each formation, the rest passes, and every play stays possible. (A design choice
// in the direction real offenses lean, more backs and tight ends running more; not a published statistic.)
const RUN_SHARE = { iform: 0.6, single: 0.55, trips: 0.375, doubles: 0.25 };
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
      const run = RUN_SHARE[state.off.formation] ?? 0.42, runs = PLAYS.filter(p => p.type === 'run').length;
      state.off.play = w(PLAYS.map(p => [p.id, p.type === 'run' ? run / runs : (1 - run) / (PLAYS.length - runs)]));
      state.off.flip = R() < 0.5;
    }
  }
}

// ---------------------------------------------------------------- the board

const board = new Board($('board'));

// keep: the result card stays where it is, faded, until this play's comes in (see snap()); otherwise it goes.
function lineUp(keep = false) {
  cancelAnimationFrame(raf); // a frame of the last play still to come would run its clock on into this one
  clearTimeout(whyTimer);
  state.play = simulate(call(), state.seed);
  state.phase = 'pre';
  state.t = 0;
  board.setPlay(state.play);
  board.mark = endMark(state.play.result);
  board.t = 0;
  board.selected = -1;
  board.spot = -1;
  board.spotAll = null;
  hideWho();
  $('why').hidden = true;
  $('result').hidden = !keep;
  staleResult(keep);
  say('');
  syncBoard();
  syncTransport();
  syncTheirs();
  renderMatchup();
  renderJobs();
  setCaption(firstHint ? FIRST_HINT : '');
  draw();
  keepPlay();
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
  // His call is out now, and stays out until he picks again. For a replay the status line is cleared, so that its end
  // is said again.
  if (snapped && state.auto) { state.seen = true; say(`They called: ${theirSummary()}.`); } else if (!snapped) say('');
  if (state.phase === 'done' || state.t >= board.duration()) state.t = 0;
  state.phase = 'playing';
  clearTimeout(whyTimer);
  if (snapped) keepPlay();
  $('why').hidden = true;
  syncBoard();
  syncTheirs();
  syncJobs();
  renderMatchup();
  syncTransport();
  if (board.selected >= 0 && cardClosesOnPlay()) { board.selected = -1; hideWho(); }
  if (snapped) { // the other side's call is out now: the tapped player's job, and which row of the chart it is
    if (board.selected >= 0) showWho(board.selected);
    syncChart();
  }
  last = performance.now();
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

// Whether the player's card closes as the play starts to run: at the snap, at ▶ after a pause or a scrub, and at
// ↺ Watch it again. On a narrow board it would hide part of the play; a bigger board has room to keep it up.
const cardClosesOnPlay = () => narrow();

function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  state.t = Math.min(board.duration(), state.t + dt * state.speed);
  caption();
  draw();
  syncScrub();
  if (state.t >= board.duration()) { finish({ hold: true }); return; }
  if (state.phase === 'playing') raf = requestAnimationFrame(tick);
}

function pause() { state.phase = 'paused'; cancelAnimationFrame(raf); syncTransport(); }

// The end of the play. Played out, the line that ended it stays up a moment to be read (the simulator stops the board
// 0.7 s after it, which is short for "The strong safety makes the tackle." and the catch just before it), and then the
// button down to the explanation takes its place. The result card under the board, and what a screen reader hears,
// come at once. Scrubbed to the end, or back after a reload, the button is there at once too.
let whyTimer = 0;
const HOLD = 1300; // ms
function finish({ hold = false } = {}) {
  state.phase = 'done';
  cancelAnimationFrame(raf);
  syncTransport();
  showResult();
  clearTimeout(whyTimer);
  if (hold) whyTimer = setTimeout(showWhy, HOLD); else showWhy();
  sayResult();
  keepPlay();
}

// What a screen reader hears of what the eye gets from the board: the other coach's call at the snap, how the play came
// out at the end, and a word about a link that couldn't open.
function say(text) { $('say').textContent = text; }
function sayResult() {
  say(`${headline(state.play.result)}. ${$('resKicker').textContent}. Why it worked is ${resultBeside() ? 'beside' : 'under'} the board.`);
}
const resultBeside = () => $('result').getBoundingClientRect().left >= $('board').getBoundingClientRect().right;

// On a computer the result card goes at the top of the right-hand column, beside the board, so it's there as the play
// ends, and when the call changes it goes and the calls are back at the top. On a phone or a tablet it comes after the
// calls, under the board, with the button on the board to take you down to it. It's moved in the page rather than only
// drawn somewhere else, so the keyboard and a screen reader come to it where the eye does.
const wide = matchMedia('(min-width: 960px)');
function placeResult() {
  const r = $('result'), focused = r.contains(document.activeElement) ? document.activeElement : null;
  if (wide.matches) $('mine').before(r); else $('chart').before(r);
  focused?.focus({ preventScroll: true });
}

// At the end of the play, the headline and a way down to the explanation, where the caption was.
function showWhy() {
  setCaption('');
  board.spot = -1; board.spotAll = null; // the caption makes way for the headline, and nobody is named
  draw();
  $('why').innerHTML = `${esc(headline(state.play.result))} · <span class="why-go">Why <span aria-hidden="true">${resultBeside() ? '→' : '↓'}</span></span>`;
  $('why').hidden = false;
  placeWhy();
  placeWho(); // draw() placed the card before the button was there
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
// The result card, just under the board where the board stays at the top of a phone, or near the top (the page's
// scroll-padding-top, in css/app.css).
onButton($('why'), () => {
  $('result').scrollIntoView({ block: 'start', behavior: smooth() });
  $('resHead').focus({ preventScroll: true });
});
// A phone held upright, or a tablet, where the board stays at the top of the screen (the same query as in css/app.css).
const stuckBoard = () => matchMedia('(max-width: 959px) and (min-height: 700px), (max-width: 959px) and (orientation: portrait)').matches;
// The board back into view after a button down the page, unless it's there anyway, stuck at the top: scrolled "into
// view" there, it would go below the page's scroll padding, which is the board's own height.
function toBoard() { if (!stuckBoard()) $('board').scrollIntoView({ block: 'nearest', behavior: smooth() }); }

function snap() {
  if (state.phase !== 'pre') { // Snap again: same calls, a new roll of the dice
    state.seed = newSeed();
    // Someone reading the result card keeps his place on the page: the last result stays, faded, until this one's is
    // in. (A change of call, New look or a shared link takes it away: those are up at the choosers.)
    lineUp(!$('result').hidden);
  }
  play();
}
// The last result, faded and out of reach while the next snap of the same calls plays, or back as it was.
function staleResult(on) {
  const r = $('result');
  r.classList.toggle('stale', on);
  r.inert = on;
  if (on) r.setAttribute('aria-hidden', 'true'); else r.removeAttribute('aria-hidden');
}

// The last two things that happened in the last 2.2 seconds, the older one above and fainter, so two that happen close
// together both stay up long enough to read. It follows the clock alone, so scrubbing and pausing show the same words.
// The man the newest line names is ringed on the board (see Board.players()).
function caption() {
  const evs = state.play.events.filter(e => e.t <= state.t + 0.001 && state.t - e.t < 2.2 && e.kind !== 'shed');
  setCaption(evs.slice(-2).map(e => e.text));
  board.spot = evs.at(-1)?.who ?? -1;
  board.spotAll = evs.at(-1)?.all || null;
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
  syncScrub();
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-checked', String(+b.dataset.speed === state.speed));
  rove(document.querySelector('.seg'));
  $('labels').setAttribute('aria-pressed', String(state.labels));
}

// The scrubber counts the play's frames, twenty to the second, so an arrow key steps one frame and the far end is the
// last. What a screen reader hears is the time and what's going on: "1.9 of 4.1 seconds: The quarterback throws to the H
// on a corner route", and at the end the headline. The clock beside it shows the time the way the play-by-play does,
// so you can scrub to the moment a line names: "1.9s", and a dash before the snap.
function syncScrub() {
  const s = $('scrub'), F = state.play?.frames;
  if (!F) return;
  $('clock').textContent = state.phase === 'pre' ? '–' : `${state.t.toFixed(1)}s`;
  const dt = F.length > 1 ? F[1].t - F[0].t : 0.05;
  s.max = String(F.length - 1);
  s.value = String(Math.min(F.length - 1, Math.round(state.t / dt)));
  const now = state.phase === 'pre' ? '' : state.phase === 'done' ? headline(state.play.result) : $('caption').lastElementChild?.textContent;
  s.setAttribute('aria-valuetext', `${state.t.toFixed(1)} of ${board.duration().toFixed(1)} seconds${now ? `: ${now}` : ''}`);
}

$('snap').addEventListener('click', snap);
// The result card's buttons go with it, or fade out of reach with it, as the next play lines up, so the focus goes on
// to Snap.
const toSnap = () => $('snap').focus({ preventScroll: true });
$('again').addEventListener('click', () => { toSnap(); snap(); if (matchMedia('(max-width: 959px)').matches) toBoard(); });
$('play').addEventListener('click', () => (state.phase === 'playing' ? pause() : play()));
$('scrub').addEventListener('input', e => {
  if (!state.play) return;
  cancelAnimationFrame(raf);
  clearTimeout(whyTimer);
  const F = state.play.frames;
  state.t = F[Math.max(0, Math.min(F.length - 1, Math.round(+e.target.value)))].t;
  state.phase = state.t >= board.duration() ? 'done' : 'paused';
  caption(); draw(); syncTransport();
  if (state.phase === 'done') { showResult(); showWhy(); sayResult(); } else $('why').hidden = true;
});
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => { state.speed = +b.dataset.speed; save(); syncTransport(); });
$('labels').addEventListener('click', () => { state.labels = !state.labels; board.labels = state.labels; save(); syncTransport(); draw(); });

// Tap a player to see who he is and what he's doing. On a crowded line a fingertip covers two or three players, so a tap
// where the picked player is goes to the next one there: tap again until it's the one you meant. A tap on empty field
// (or the card's ×) closes the card.
let down = null;
$('board').addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
$('board').addEventListener('pointerup', e => {
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 8) pick(e.clientX, e.clientY);
});
// A tap on the board at this point in the window.
function pick(x, y) {
  const r = $('board').getBoundingClientRect();
  const near = board.hit(x - r.left, y - r.top);
  opener = null;
  if (!near.length) { board.selected = -1; hideWho(); } else {
    const i = near[(near.indexOf(board.selected) + 1) % near.length];
    board.selected = i; dropHint(); showWho(i);
  }
  draw();
}
// The buttons on the board (Why, and More about on the player's card). A finger that comes down just off one, on a
// player, can still be sent to the button: the browser takes a tap near a button as meant for it (Chromium's touch
// adjustment), and a real fingertip touches more than a point. Where the finger came down outside the button and its
// hit area, on a player, it's a tap on him instead; just off it over empty field, it's still the button's.
function onButton(el, act) {
  let at = null;
  el.addEventListener('pointerdown', e => { at = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
  el.addEventListener('click', e => {
    const p = at;
    at = null;
    if (p && e.detail && e.timeStamp - p.t < 1500 && !within(hitArea(el), p.x, p.y) && onPlayer(p.x, p.y)) { el.blur(); pick(p.x, p.y); } else act();
  });
}
// Whether a tap at this point in the window is on a player. Just off a button over empty field, the button was meant.
const onPlayer = (x, y) => { const r = $('board').getBoundingClientRect(); return board.hit(x - r.left, y - r.top).length > 0; };
// A button's box with the bigger hit area some are given round them (a ::before, in css/app.css).
function hitArea(el) {
  const b = el.getBoundingClientRect(), s = getComputedStyle(el, '::before');
  const out = side => (s.content === 'none' || s.position !== 'absolute' ? 0 : Math.max(0, -parseFloat(s[side]) || 0));
  return { l: b.left - out('left'), r: b.right + out('right'), t: b.top - out('top'), b: b.bottom + out('bottom') };
}
const within = (b, x, y) => x >= b.l && x <= b.r && y >= b.t && y <= b.b;
$('whoClose').addEventListener('click', closeWho);
// Closing the card, with × or Escape, takes the focus back to the button in "Every player's job" that opened it, if
// the focus was on the card.
function closeWho() {
  const back = opener?.isConnected && ($('who').contains(document.activeElement) || document.activeElement === document.body) ? opener : null;
  board.selected = -1;
  hideWho();
  draw();
  back?.focus();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('who').hidden) closeWho(); });
// On a narrow board the card leaves out what the position is in general until it's asked for, and keeps it open for
// the next player once it has been.
let moreAbout = false;
onButton($('whoMore'), () => { moreAbout = !moreAbout; syncMore(); placeWho(); });

// What a player's position is called, and what it is in general.
const position = p => POSITIONS[p.info] || POSITIONS[p.label] || [p.label, ''];
function showWho(i) {
  const p = state.play.players[i];
  const [title, about] = position(p);
  const hiddenJob = p.team !== state.side && hidden();
  const fresh = $('who').hidden || $('who').dataset.i !== String(i);
  $('who').dataset.i = i;
  $('whoPos').textContent = `${p.label} · ${title}`;
  $('whoJob').textContent = !hiddenJob ? `On this play: ${state.play.jobs[i]}`
    : p.team === 'D' ? `${tell(state.play, i)} His job is hidden until the snap.`
      : 'His job on this play is hidden until the snap. Read the alignment: where he stands gives some of it away.';
  $('whoAbout').textContent = about;
  $('whoMore').textContent = `More about the ${p.label}`;
  $('whoMore').hidden = !about;
  $('who').hidden = false;
  syncMore();
  placeWho(fresh);
}
function hideWho() { $('who').hidden = true; }

// What a defender's spot before the snap gives away, from what anyone can see on the board: how deep he is, what he's
// over, whether he's in the box. On this board the tells are exact (corners pressed only in man, a Mike only creeps up
// to blitz), but they're worded the way they'd hold on a real field.
function tell(P, i) {
  const p = P.players[i], { x, y } = p, yd = n => `${Math.round(n)} yards`;
  const recv = P.players.filter(q => q.team === 'O' && (q.cls === 'wr' || q.cls === 'te'));
  const over = recv.reduce((a, q) => (Math.abs(q.x - x) < Math.abs(a.x - x) ? q : a));
  const slot = q => recv.some(o => Math.sign(o.x) === Math.sign(q.x) && Math.abs(o.x) > Math.abs(q.x));
  const him = `the ${over.cls === 'te' ? 'tight end' : slot(over) ? 'slot receiver' : 'receiver'} (${over.label})`;
  const inBox = P.box.in.includes(i);
  if (p.label === 'CB') {
    return y < 2.5 ? 'Up in the receiver\'s face, pressed: corners press in man coverage.'
      : y < 6 ? 'About 5 yards off, outside the receiver: where a Cover 2 corner sits to take the flat.'
        : 'Seven yards or more off: ready to drop deep, to a third or a quarter of the field.';
  }
  if (p.cls === 's') {
    if (!P.box.high) return 'Nobody is deep: both safeties are up, inside 10 yards. Expect man coverage and a blitz.';
    if (y > 10.5) {
      return P.box.high === 1 ? `Alone in the middle, ${yd(y)} deep: one deep safety, so Cover 1 or Cover 3.`
        : 'Deep over his half of the field, with the other safety deep too: two deep, so Cover 2 or Cover 4.';
    }
    return `Down at ${yd(y)}, not deep${inBox ? ', in the box' : ''}: an extra man against the run, or he's covering a tight end, a slot receiver or an area underneath.`;
  }
  if (p.label === 'NB') return `Over ${him}: a nickel back usually covers him, man or zone.`;
  if (p.cls === 'lb') {
    if (Math.abs(x) < 3.5 && y < 4) return 'Walked up close to the line between the tackles: a linebacker creeping up like this is often blitzing.';
    if (y < 1.5) return 'Standing up on the end of the line: he may rush the passer or drop into coverage.';
    if (y < 2.5) return `Up close over ${him}: a linebacker this tight on a receiver is usually playing man coverage on him.`;
    if (inBox) return `About ${yd(y)} off the ball, in the box: count him when you count the box.`;
    return `Out over ${him}, outside the box: he'll cover him or the area around him, man or zone.`;
  }
  return 'Down linemen rush on almost every play. What\'s hidden is who joins them.';
}
function syncMore() {
  $('who').classList.toggle('more', moreAbout);
  $('whoMore').setAttribute('aria-expanded', String(moreAbout));
  // Taps on the card go through to the board, unless there's more in it to scroll to.
  const body = $('whoBody');
  body.classList.toggle('scrolls', body.scrollHeight > body.clientHeight + 1);
}

// The card goes at the end of the board away from the player it's about, so it doesn't hide him, and while the play
// runs it moves if he runs under it. A narrow board places it by measure (see placeNarrow()).
function placeWho(fresh) {
  const who = $('who');
  if (who.hidden || board.selected < 0 || !state.play) return;
  const at = board.pos(board.t, board.selected);
  const x = board.sx(at.x), y = board.sy(at.y), reach = board.radius() * 2.4 + 4; // his ring and his label
  const him = { l: x - reach, r: x + reach, t: y - reach, b: y + reach };
  if (narrow()) { placeNarrow(who, him, fresh); return; }
  who.style.top = who.style.bottom = who.style.maxHeight = '';
  if (fresh) who.classList.toggle('top', y > board.h / 2);
  const covered = () => { const c = onBoard(who); return meet(c, him) ? Math.min(c.b, him.b) - Math.max(c.t, him.t) : 0; };
  const before = covered();
  if (!before) return;
  who.classList.toggle('top');
  if (covered() > before) who.classList.toggle('top');
}
// Where an element is on the board, in the board's own pixels, and whether two such boxes overlap.
function onBoard(el) {
  const b = el.getBoundingClientRect(), cv = board.cv.getBoundingClientRect();
  return { l: b.left - cv.left, r: b.right - cv.left, t: b.top - cv.top, b: b.bottom - cv.top };
}
const meet = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

// A narrow board's card takes up to half the board, so where it goes matters more. A new card tries both ends: off him
// and his label, clear of the button down to the explanation and of the caption's words, and over as few of the others
// as it can (the end farther from him, if that's a tie). Where neither end leaves him clear, or the one that does would
// hide more than three others (a safety's card over the whole formation), it fits into the room between him and that
// end instead, down to about the name and a line, with the rest scrolling. Once it's up it stays put, unless he runs
// under it or the caption's words come up under it.
function placeNarrow(who, him, fresh) {
  const keep = [$('why'), ...$('caption').children].filter(el => !el.hidden && el.textContent).map(onBoard);
  if (!fresh) { const c = onBoard(who); if (!meet(c, him) && !keep.some(k => meet(c, k))) return; }
  const H = board.h, cap = H * 0.45, EDGE = 8;
  who.style.top = who.style.bottom = '';
  who.style.maxHeight = 'none';
  const tall = who.offsetHeight, { l, r } = onBoard(who);
  // the smallest it goes: his name and the first line of his job
  const line = parseFloat(getComputedStyle($('whoJob')).lineHeight);
  const MIN = Math.ceil($('whoPos').getBoundingClientRect().bottom - who.getBoundingClientRect().top + line + 1);
  // the others' marks, and their labels where they're shown (where the board drew them: see Board.labelSpots())
  const others = state.play.players.filter(p => p.i !== board.selected).map(p => {
    const q = board.pos(board.t, p.i), x = board.sx(q.x), y = board.sy(q.y);
    return board.drawn ? [[x, y], board.drawn[p.i]] : [[x, y]];
  });
  const ends = [true, false].map(top => {
    // Measured from this end's edge of the board: s is where the card starts, and he's at [near, far].
    const from = k => (top ? [k.t, k.b] : [H - k.b, H - k.t]);
    who.classList.toggle('top', top);
    const s0 = parseFloat(getComputedStyle(who)[top ? 'top' : 'bottom']);
    let s = s0;
    for (const [a, b] of keep.filter(k => k.l < r && l < k.r).map(from).filter(([a]) => a < H / 2).sort((m, n) => m[0] - n[0])) {
      if (a < s + Math.min(tall, cap) && b > s) s = b + 4;
    }
    const [near, far] = from(him);
    let max = Math.min(cap, H - EDGE - s), full = true;
    if (him.r <= l || him.l >= r || far <= s) { /* he's clear of it whatever its height */ }
    else if (near < s) { full = false; max = 0; } // he's where it would start
    else if (s + Math.min(tall, max) > near - 4) { // it would reach him: it stops short, starting at the edge if it can
      full = false;
      if (s === s0) s = Math.min(s, EDGE);
      max = Math.min(cap, H - EDGE - s, near - 4 - s);
    }
    const h = Math.min(tall, Math.max(max, MIN));
    const c = { l, r, t: top ? s : H - s - h, b: top ? s + h : H - s };
    const hides = others.filter(o => o.some(([x, y]) => x > c.l && x < c.r && y > c.t && y < c.b)).length;
    return { top, s, max, full, hides, far: Math.hypot((c.l + c.r) / 2 - (him.l + him.r) / 2, (c.t + c.b) / 2 - (him.t + him.b) / 2) };
  });
  const best = (list, tie) => list.sort((a, b) => a.hides - b.hides || tie(a, b))[0];
  const whole = best(ends.filter(e => e.full), (a, b) => b.far - a.far);
  const fitted = best(ends.filter(e => !e.full && e.max >= MIN), (a, b) => b.max - a.max);
  const end = (whole && whole.hides <= 3 ? whole : fitted && (!whole || fitted.hides < whole.hides) ? fitted : whole)
    || ends.sort((a, b) => b.max - a.max)[0];
  who.classList.toggle('top', end.top);
  who.style.top = end.top ? `${end.s}px` : 'auto';
  who.style.bottom = end.top ? 'auto' : `${end.s}px`;
  who.style.maxHeight = `${Math.max(end.max, MIN)}px`;
  syncMore();
}

// ---------------------------------------------------------------- choosers

function chips(host, label, items, current, pick, opts = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'pick';
  const h = document.createElement('p');
  h.className = 'pick-label';
  h.textContent = label;
  wrap.append(h);
  // One radio group, even where it's in rows with their own names (the plays: runs, then passes), so the arrow keys go
  // all the way through it.
  const group = document.createElement('div');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', label);
  for (const g of opts.groups || [{ name: '', items }]) {
    if (g.name) { const gl = document.createElement('div'); gl.className = 'group-label'; gl.textContent = g.name; group.append(gl); }
    const row = document.createElement('div');
    row.className = 'chips';
    for (const it of g.items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(it.id === current));
      b.dataset.key = `${label}:${it.id}`; // the same chip once the choosers are drawn again, for the keyboard's focus
      b.disabled = !!opts.disabled;
      // The small print a screen reader says in full: "I-Form 21 personnel", not a bare "twenty-one". (The name still
      // starts with the words on the chip, for speech input: WCAG 2.2, 2.5.3 Label in Name.)
      b.innerHTML = it.sub ? `${esc(it.name)} <small>${esc(it.sub)}<span class="sr-only"> ${esc(it.subWord)}</span></small>` : esc(it.name);
      b.addEventListener('click', () => pick(it.id));
      row.append(b);
    }
    group.append(row);
  }
  wrap.append(group);
  rove(group);
  if (opts.blurb) { const p = document.createElement('p'); p.className = 'blurb'; p.textContent = opts.blurb; wrap.append(p); }
  host.append(wrap);
}

// The arrow keys in a radio group, the way the WAI-ARIA Authoring Practices' radio group pattern has them: Right or Down
// picks the next one and Left or Up the one before, wrapping round at the ends; Home and End pick the first and the last.
// Tab stops once in each group, at the one that's picked (rove()).
document.addEventListener('keydown', e => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' }[e.key];
  const radio = e.target.closest?.('[role="radio"]');
  if (!step || !radio || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  const all = [...radio.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]')].filter(b => !b.disabled);
  const next = step === 'first' ? all[0] : step === 'last' ? all.at(-1) : all[(all.indexOf(radio) + step + all.length) % all.length];
  if (!next || next === radio) return;
  next.focus();
  next.click();
});
function rove(group) {
  const all = [...group.querySelectorAll('[role="radio"]')].filter(b => !b.disabled);
  const on = all.find(b => b.getAttribute('aria-checked') === 'true') || all[0];
  for (const b of all) b.tabIndex = b === on ? 0 : -1;
}

// A smooth scroll, unless reduced motion is asked for (WCAG 2.2, 2.3.3 Animation from Interactions).
function smooth() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'; }

function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

function offenseChooser(host, readonly) {
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const set = patch => {
    const was = fm.personnel;
    Object.assign(state.off, patch);
    // New personnel and the other coach substitutes: nickel against three receivers, base against two backs. A new play
    // or strong side keeps his call, the way an audible at the line does. The board says so until the snap, the way New
    // look does, since his new call is hidden.
    const subbed = state.auto && state.side === 'O' && byId(FORMATIONS, state.off.formation).personnel !== was;
    if (subbed) rollTheirs();
    afterChange();
    if (subbed) setCaption('New personnel: they\'ve substituted.');
  };
  chips(host, 'Formation', FORMATIONS.map(f => ({ id: f.id, name: f.name, sub: f.personnel, subWord: 'personnel' })), fm.id, id => set({ formation: id }), {
    disabled: readonly, blurb: `${fm.blurb} ${personnelWords(fm.personnel)}`,
  });
  chips(host, 'Strong side', [{ id: 'R', name: 'Right' }, { id: 'L', name: 'Left' }], state.off.flip ? 'L' : 'R', id => set({ flip: id === 'L' }), {
    disabled: readonly, blurb: strongBlurb(fm),
  });
  chips(host, 'Play', PLAYS, pl.id, id => set({ play: id }), {
    disabled: readonly, blurb: pl.blurb,
    groups: [{ name: 'Runs', items: PLAYS.filter(p => p.type === 'run') }, { name: 'Passes', items: PLAYS.filter(p => p.type === 'pass') }],
  });
}

// "21 personnel: two backs, one tight end.", from the two digits.
const COUNT = ['no', 'one', 'two', 'three'];
function personnelWords(p) {
  const [backs, ends] = [...p].map(Number), many = (n, w) => `${COUNT[n]} ${w}${n === 1 ? '' : 's'}`;
  return `${p} personnel: ${many(backs, 'back')}, ${many(ends, 'tight end')}.`;
}
// What the strong side is. A formation with the same men on each side has none of its own: it's the side you call.
function strongBlurb(fm) {
  const count = (sd, cls) => fm.players.filter(([, x, , c]) => c === cls && Math.sign(x) === sd).length;
  const balanced = ['te', 'wr'].every(c => count(1, c) === count(-1, c));
  if (!balanced) return 'The strong side is the tight end\'s side, or the side with more receivers. Runs go that way, and the defense sets its strength to it.';
  const each = [[count(1, 'te'), 'tight end'], [count(1, 'wr'), 'receiver']].filter(([n]) => n).map(([n, w]) => (n === 1 ? `a ${w}` : `${COUNT[n]} ${w}s`)).join(' and ');
  return `${fm.name} is balanced, ${each} on each side, so the strong side is whichever side you call. The runs and one-sided pass plays like Flood go that way, and the defense sets its strength to it.`;
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
  // The chart is for the last call. One still on its first time round starts again for the new call; one that has
  // every row's first numbers up counts as finished, even while it's adding snaps: it stops and goes, with a word saying
  // why until it's run again. (Calling the other side is another chart altogether.)
  const k = state.side === 'O' ? 'off' : 'def', yours = !state.auto || !same(state[k], own[k]);
  const finished = chart && chart.rows.every(r => r.avg !== undefined);
  const rerun = chart && !finished && chart.side === state.side;
  const stale = chart ? finished && chart.side === state.side : redo?.side === state.side; // a finished one, or one gone already
  redo = stale ? { side: state.side, yours } : null;
  // On a computer the result card at the top of the column goes, and the calls under it would jump up the screen, out
  // of sight if the page was scrolled down to them: they stay where they were instead, or as near as the page scrolls,
  // which brings them back to the top of the column.
  const held = wide.matches && !$('result').hidden ? $('mine').getBoundingClientRect().top : null;
  state.linked = false;
  linkNote = '';
  keepOwn();
  save();
  state.seed = newSeed();
  renderChoosers();
  lineUp();
  clearChart();
  if (rerun) runChart();
  if (held !== null) scrollBy(0, $('mine').getBoundingClientRect().top - held);
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
  rove(document.querySelector('.side-pick'));
  $('newLook').hidden = $('theirsLook').hidden = !state.auto;
  syncTheirs();
}

function theirSummary() {
  if (state.side === 'O') {
    const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
    return `${fr.name}, ${cv.name}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? ', blitz' : ', rush four'}`;
  }
  // Where the strength is on the board as you see it: the defense's view is turned around, so their right is your left.
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  return `${fm.name}, strength to your ${state.off.flip ? 'right' : 'left'}, ${pl.name}`;
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
    : 'Hidden until the snap. You can see their formation; the play is a surprise. Read their personnel: two backs or two tight ends lean run, four receivers lean pass. Change your call to match it: they keep theirs.';
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
  if (state.auto) setCaption('The other coach has his call. It\'s hidden until the snap.');
});
// New look: the other coach picks again. It's in the result card after a play, and in his card before the snap.
// The board says what it did until the snap, even when nothing there shows it: calling the defense, a new play from the
// same formation and strong side lines up just like the last one.
function newLook(e) {
  const fromResult = !!e?.currentTarget.closest('#result');
  if (fromResult) toSnap();
  const formation = () => `${state.off.formation} ${state.off.flip}`, was = formation();
  rollTheirs();
  afterChange();
  setCaption(state.side === 'D' && formation() === was ? 'New look: same formation, a new play.' : 'New look: they\'ve changed their call.');
  // From the result card, which goes, to their card just under the board where it stays at the top of a phone.
  if (fromResult && stuckBoard()) $('theirs').scrollIntoView({ block: 'start', behavior: smooth() }); else toBoard();
}
$('newLook').addEventListener('click', newLook);
$('theirsLook').addEventListener('click', newLook);

// ---------------------------------------------------------------- every player's job

// Every player as a button, left to right as the board shows them, each opening his card on the board: the way to them
// from a keyboard or a screen reader, which can't tap the board (WCAG 2.2, 2.1.1 Keyboard). Above them, the board in
// words, which a screen reader also hears as the board's description. Both are drawn again for each lineup.
let opener = null; // the button that opened the card (see closeWho())
function renderJobs() {
  const P = state.play, host = $('jobsBody');
  opener = null;
  host.textContent = '';
  for (const team of ['O', 'D']) {
    const wrap = document.createElement('div');
    wrap.className = 'jobs-team';
    wrap.innerHTML = `<h3 class="pick-label">${team === 'O' ? 'Offense' : 'Defense'}</h3>`;
    const row = document.createElement('div');
    row.className = 'chips';
    // left to right on the board, and from the line back where two are in a file (the center, the quarterback, the backs)
    const men = P.players.filter(p => p.team === team).sort((a, b) => board.sx(a.x) - board.sx(b.x) || Math.abs(a.y) - Math.abs(b.y));
    for (const p of men) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `${p.label} · ${position(p)[0]}`;
      b.addEventListener('click', () => {
        board.selected = p.i;
        dropHint();
        showWho(p.i);
        draw();
        opener = b;
        // Where the board doesn't stay in view (a window under 960 px wide and under 700 tall, a small phone turned
        // sideways), the page goes up to the card, which would otherwise open out of sight: the whole board in the
        // middle of the window, with him and his card on it, or the card there if the board is taller than the window.
        // Only the page scrolls: the board's frame clips what's on it, and scrolling the card into view could shift the
        // field inside it.
        const r = $('who').getBoundingClientRect(), f = $('board').getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight) {
          scrollBy({ top: f.height <= innerHeight ? f.top - (innerHeight - f.height) / 2 : r.top + r.height / 2 - innerHeight / 2, behavior: smooth() });
        }
        $('who').focus({ preventScroll: true });
      });
      row.append(b);
    }
    wrap.append(row);
    host.append(wrap);
  }
  // The board's description is a copy of them: a browser doesn't take one from inside a closed section. The copy is out
  // of sight, and so isn't read twice.
  $('boardWords').textContent = $('boardDesc').textContent = boardWords(P);
  syncJobs();
}
function syncJobs() {
  $('jobsHint').textContent = 'Left to right as the board shows them. Each one opens his card on the board, with his job on this play.'
    + (hidden() ? ' Their jobs stay hidden until the snap, as on the board.' : '');
}

// The board in words, as the teams line up: the formation, where the receivers and the backs are, and then what the
// defense shows: the safeties deep, the box count and the corners. Left and right are the board's, as it's shown.
function boardWords(P) {
  const fm = byId(FORMATIONS, P.call.formation);
  const lr = sd => ((sd > 0) !== board.flip ? 'right' : 'left'); // sd: the offense's right (+1) or left (-1)
  const strong = P.call.flip ? -1 : 1;
  const many = (n, one, more) => (n === 1 ? `a ${one}` : `${COUNT[n] || n} ${more}`);
  const side = sd => {
    const on = P.players.filter(p => p.team === 'O' && Math.sign(p.x) === sd);
    const parts = [[on.filter(p => p.cls === 'te').length, 'tight end', 'tight ends'], [on.filter(p => p.cls === 'wr').length, 'receiver', 'receivers']];
    return parts.filter(([n]) => n).map(([n, one, more]) => many(n, one, more)).join(' and ') || 'nobody';
  };
  const sides = side(strong) === side(-strong) ? `${side(strong)} each side` : `${side(strong)} ${lr(strong)}, ${side(-strong)} ${lr(-strong)}`;
  const backs = P.players.filter(p => p.cls === 'rb' || p.cls === 'fb').length;
  const backfield = fm.under ? `the quarterback under center, ${many(backs, 'back', 'backs')} behind him` : `the quarterback in the shotgun, ${many(backs, 'back', 'backs')} beside him`;
  const high = P.box.high, deep = high >= 2 ? `${COUNT[high]} safeties deep` : high === 1 ? 'one safety deep' : 'nobody deep';
  const depth = y => (y < 2.5 ? 'pressed' : y < 6 ? 'about 5 yards off' : '7 yards or more off'); // as the corners' read says
  const cbs = P.players.filter(p => p.label === 'CB').map(p => depth(p.y));
  const corners = cbs.length === 2 && cbs[0] === cbs[1] ? `both corners ${cbs[0]}` : cbs.map((d, k) => `${k ? 'the other' : 'one corner'} ${d}`).join(', ');
  return `${fm.name}, strong ${lr(strong)}: ${sides}; ${backfield}. The defense: ${deep}, ${P.box.box} in the box against ${P.box.blockers} blockers, ${corners}.`;
}

// ---------------------------------------------------------------- the result

// Whole yards, as the headline says them. The simulator spots the ball to the half yard, and a half rounds away from
// zero, so a 3.5-yard run is a gain of 4 and a success in the headline, the verdict over it and the chart alike.
const gained = res => Math.sign(res.yards) * Math.round(Math.abs(res.yards));
const success = res => (res.kind === 'run' || res.kind === 'catch') && gained(res) >= 4;
// The verdict over the headline, and which side's colour it's in. A big play is a run of 10 yards or more or a catch of
// 20 or more (see "Big play" in the playbook), and a gain short of 4 yards counts for the defense, which looks like a
// mistake unless it says why.
const bigPlay = res => success(res) && gained(res) >= (res.kind === 'run' ? 10 : 20);
function kicker(res) {
  const n = gained(res), carried = res.kind === 'run' || res.kind === 'catch';
  if (res.kind === 'int') return ['A takeaway for the defense', 'D'];
  if (success(res)) return [bigPlay(res) ? 'A big play for the offense' : 'A win for the offense', 'O'];
  if (carried && n >= 0) return ['A win for the defense: short of the 4\u00a0yards that make a play a success', 'D'];
  return ['A win for the defense', 'D'];
}

// What's written in marker on the board at the whistle (see Board.endMark()), the yards as the headline counts them:
// "+17", "−3", "Sack −7", "Incomplete", "Picked off". A big play's is written bigger, and it's in the colour of the
// side that won the play, as the verdict over the headline is.
function endMark(res) {
  const n = gained(res);
  const text = { incomplete: 'Incomplete', throwaway: 'Thrown away', int: 'Picked off' }[res.kind]
    || (res.kind === 'sack' ? (n ? `Sack −${-n}` : 'Sack') : res.long ? `${Math.min(n, 60)}+` : n > 0 ? `+${n}` : n < 0 ? `−${-n}` : 'No gain');
  return { text, big: bigPlay(res), win: kicker(res)[1] };
}

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
  [$('resKicker').textContent, $('resKicker').dataset.win] = kicker(res);
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
  const { lead, note, now, reads } = coachNote(P);
  $('note').innerHTML = `<b>${esc(lead)}</b> ${esc(note)}`;
  $('noteNow').innerHTML = `<b>This time:</b> ${esc(now)}`;
  const ul = $('reads');
  ul.textContent = '';
  for (const r of reads) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  resetShare();
  $('actionsNote').textContent = `Snap again: the same two calls, played out fresh.${state.auto ? ' New look: the other coach changes his call.' : ''}`;
  $('result').hidden = false;
  staleResult(false);
  syncTheirs();
}

function coachNote(P) {
  const pl = byId(PLAYS, state.off.play), cv = byId(COVERAGES, state.def.coverage);
  const reads = [];
  const high = P.box.high;
  reads.push(high >= 2 ? 'Safeties: two deep before the snap, a Cover 2 or Cover 4 look.' : high === 1 ? 'Safeties: one deep in the middle, a Cover 1 or Cover 3 look.' : 'Safeties: nobody deep. Expect man coverage and a blitz.');
  // How far off the corners stood before the snap: on this board they're pressed in man coverage, about 5 yards off in
  // Cover 2 and 7 or more in Cover 3 and 4 (see the corners' depths in js/sim.js), so this and the safeties name it.
  const corner = Math.min(...P.players.filter(p => p.label === 'CB').map(p => p.y));
  reads.push(corner < 2.5 ? 'Corners: pressed up on the receivers. Corners press in man coverage.'
    : corner < 6 ? 'Corners: about 5 yards off and outside the receivers. Cover 2 corners sit there to take the flat.'
      : 'Corners: 7 yards or more off. They drop deep, to a third or a quarter of the field.');
  reads.push(`Box: ${P.box.box} defenders near the line against ${P.box.blockers} blockers.`);
  const rushers = P.overlay.filter(o => o.kind === 'rush').length;
  if (pl.id === 'screen') { // the rushers come free by design: "came unblocked" would read as the protection failing
    reads.push(`Rush: ${rushers} rushers, and the line lets them through on purpose: that's the screen. The linemen on the back's side block a moment, then run out in front of him.`);
  } else if (pl.type === 'pass') {
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
  // How the call does in general, then how this snap went, so a snap that goes the other way doesn't read as the note
  // being wrong.
  const lead = pl.type === 'pass' ? `How ${pl.name} does against ${cv.name}:` : `How ${pl.name} works:`;
  const note = pl.type === 'pass' ? NOTES[pl.id][cv.id] : RUN_NOTES[pl.id] + backEnd;
  return { lead, note, now: thisTime(P), reads };
}

// This snap in one sentence, from the play-by-play: on a pass, which read he threw to and what came of it, or what got
// to him first; on a run, the numbers in the box and who made the tackle. The yards are the headline's.
const READS = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
function thisTime(P) {
  const res = P.result, E = P.events, pl = byId(PLAYS, P.call.play), n = gained(res), by = res.by;
  const yd = v => `${v} yard${v === 1 ? '' : 's'}`;
  const him = i => name(null, P.players[i]); // an offensive player's name: "the H", "the tight end (Y)"
  const shed = i => E.some(e => e.kind === 'shed' && e.who === i);
  const covered = (k, passed = k) => (k === 1 && passed === 1 ? 'his first read' : passed >= k ? `his first ${READS[k]} reads` : `${READS[passed]} of his first ${READS[k]} reads`);
  if (pl.type === 'run') {
    const d = P.box.box - P.box.blockers;
    const box = d > 0 ? `the defense had ${d} more in the box than the offense had blockers` : d < 0 ? 'the offense had more blockers than the defense had defenders in the box' : 'the numbers in the box were even';
    const yards = n > 0 ? `after ${yd(n)}` : n < 0 ? `for a loss of ${yd(-n)}` : 'for no gain';
    let carry;
    const blocked = E.findLast(e => e.kind === 'tackle')?.blocked;
    if (res.carrier >= 0 && P.players[res.carrier].cls === 'qb') carry = `${nm(P, by, true)} ${blocked ? 'reached out of a block and' : 'got into the backfield and'} dropped the quarterback before the handoff`;
    else if (res.long) carry = `the back broke it for ${Math.min(n, 60)}+ yards`;
    else if (by < 0) carry = `the back was forced out of bounds ${yards}`;
    else if (P.unblocked.includes(by)) carry = `${nm(P, by, true)}, left unblocked, made the tackle ${yards}`;
    else carry = `${nm(P, by, true)} ${shed(by) ? 'got off a block to make the tackle' : blocked ? 'reached out of a block to make the tackle' : 'made the tackle'} ${yards}`;
    return `${box}, and ${carry}.`;
  }
  if (res.kind === 'sack') {
    const s = E.findLast(e => e.kind === 'sack'), passed = s?.passed || 0;
    if (by < 0) return 'nothing came open, and he never got rid of it.';
    const free = P.cameFree.includes(by) || !P.frames.some(f => f.t <= res.t && f.eng[by] >= 0);
    return `${nm(P, by)} ${free ? 'came unblocked' : shed(by) ? 'got off his block' : 'got through'} and sacked him ${res.t.toFixed(1)} seconds after the snap, ${passed ? `with ${covered(passed)} covered` : pl.drop === 'screen' ? 'before the screen was set up' : 'before his first read came open'}.`;
  }
  if (res.kind === 'throwaway') {
    const passed = E.findLast(e => e.kind === 'away')?.passed || 0;
    return `${passed ? `with ${covered(passed)} covered` : 'with nothing open in time'}, he threw it away rather than take a sack.`;
  }
  const t = E.find(e => e.kind === 'throw');
  if (!t) return '';
  const who = him(t.who), route = ROUTES[t.route]?.name || 'route', on = `${who} on the ${route}${/route|check-down|screen/.test(route) ? '' : ' route'}`;
  const threw = {
    read: t.read === 0 ? `he threw to his first read, ${on}` : !t.passed ? `he threw to read ${t.read + 1}, ${on}` : t.route === 'check' ? `with ${covered(t.read, t.passed)} covered, he checked it down to ${who}` : `with ${covered(t.read, t.passed)} covered, he threw to ${on}`,
    hot: `${t.blitzer >= 0 ? nm(P, t.blitzer) : 'a blitzer'} came unblocked, so he threw hot to ${on}`,
    pressure: `with the rush on him, he threw to ${on}`,
    last: `with none of his reads open, he threw to ${on}`,
    screen: `he threw the screen to ${who}`,
  }[t.how] || `he threw to ${on}`;
  const end = E.findLast(e => e.kind === 'inc' || e.kind === 'pbu' || e.kind === 'int');
  let came;
  if (res.kind === 'catch') came = res.long ? `, and it went for ${Math.min(n, 60)}+ yards` : n >= 4 ? `, and it went for ${yd(n)}` : n > 0 ? `, but it went for only ${yd(n)}` : n < 0 ? `, but he was dropped for a loss of ${yd(-n)}` : ', but it went for no gain';
  else if (res.kind === 'int') came = end?.how === 'off' ? `, but the throw was off target and ${nm(P, by)} picked it off` : `, and ${nm(P, by)} jumped the route and picked it off`;
  else came = { out: ', but the throw went out of bounds', off: ', but the throw was off target', drop: ', but he dropped it' }[end?.how]
    || (end?.kind === 'pbu' ? `, but ${nm(P, by)} broke it up` : by >= 0 ? `, but ${nm(P, by)} got a hand on it` : ', but it fell incomplete');
  return `${threw}${came}.`;
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

// A play link in the address (#p=side.formation.play.flip.front.coverage.pressure.seed): 'ok' once it's set up, 'bad'
// for one cut short or garbled, 'unknown' for a formation, play, front or coverage this version doesn't have (the
// address is cleared either way), '' when there's none.
let linkNote = '';
function fromLink() {
  const hash = location.hash;
  if (!hash.startsWith('#p=')) return '';
  history.replaceState(null, '', location.pathname + location.search);
  const m = hash.match(/p=([OD])\.(\w+)\.(\w+)\.([01])\.(\w+)\.(\w+)\.(\w+)\.(\d+)/);
  if (!m) return 'bad';
  const [, side, formation, playId, flip, front, coverage, pressure, seed] = m;
  if (!FORMATIONS.some(f => f.id === formation) || !PLAYS.some(p => p.id === playId) || !FRONTS.some(f => f.id === front) || !COVERAGES.some(c => c.id === coverage)) return 'unknown';
  Object.assign(state, { side, auto: false, linked: true, seed: +seed >>> 0 });
  state.off = { formation, play: playId, flip: flip === '1' };
  state.def = { front, coverage, pressure: pressure === 'blitz' ? 'blitz' : 'four' };
  linkNote = '';
  return 'ok';
}
function badLink(link) {
  linkNote = link === 'bad' ? 'That link is cut off or garbled, so there\'s no play to show. Ask for it again.'
    : 'That link is for a play this version doesn\'t have.';
  syncTheirs();
  say(linkNote);
  if (state.phase === 'pre') setCaption(linkNote);
}
// Another play link opened in a tab that's already open.
addEventListener('hashchange', () => {
  const link = fromLink();
  if (link === 'ok') { redo = null; renderChoosers(); clearChart(); lineUp(); play(); }
  else if (link) badLink(link);
});

// ---------------------------------------------------------------- the chart: this call against everything

let chartJob = 0;
// Each row counts its snaps as they're run (n, yds, ok). Its bar shows avg and rate as they stood when it last finished
// a time round, `of` snaps in, so a row drawn again part way (at the snap, to mark their call) says what its numbers
// come from.
let chart = null; // the rows of the last run: { rows: [{ id, name, call, n, yds, ok, avg, rate, of }], pressure, side }
let redo = null; // a finished chart went with a change of call: { side, yours } until it's run again
// Run once, the button says it can be run again: each run is a new set of snaps, and the numbers move a little.
// Twenty snaps a row is enough for a first look but not to rank the rows (one row can swing from 1 to 14 yards a play
// between runs), so the chart shows each row's first numbers after FIRST snaps and then goes round them again, FIRST
// more at a time, until each has SNAPS, with the bars settling as it goes.
const RUN_LABEL = $('runChart').textContent, AGAIN_LABEL = 'Run it again', FIRST = 20, SNAPS = 100;

function clearChart() {
  chartJob++;
  chart = null;
  $('chartTitle').textContent = state.side === 'O' ? 'Your play against each coverage' : 'Your defense against each play';
  $('chartHint').textContent = chartHint();
  $('runChart').textContent = RUN_LABEL;
  $('runChart').removeAttribute('aria-disabled');
  drawIdle();
}
// Before a run, the rows it will fill: every coverage (or every play, calling the defense), each with an empty track.
function drawIdle() {
  const host = $('bars');
  host.innerHTML = '<div class="bar-head" aria-hidden="true">success · avg yards</div>';
  for (const r of state.side === 'O' ? COVERAGES : PLAYS) {
    const row = document.createElement('div');
    row.className = 'bar-row idle';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${r.name}: not run yet`);
    row.innerHTML = `<span class="bar-name"><span>${esc(r.name)}</span></span><span class="bar-track idle"></span><span class="bar-val">–</span>`;
    host.append(row);
  }
}

// Before the snap the offense's chart can't use the other coach's real pressure without giving it away, so every
// coverage gets a four-man rush (Cover 0 always blitzes) until the call is out.
// The bars are the success rate: a few long runs after the catch swing the average yards a lot (one row can average 20
// yards a play while its typical snap is an incompletion), so the average is the small number beside each bar.
function chartHint() {
  const fm = byId(FORMATIONS, state.off.formation).name;
  if (state.side === 'D') return `How often each play from ${fm} succeeds against your defense, gaining 4 yards or more. Beside each bar, the average yards a play you allow.${again()}`;
  const pressure = chart ? chart.pressure : hidden() ? 'four' : state.def.pressure;
  return `How often your play succeeds, gaining 4 yards or more, from ${fm} against a ${byId(FRONTS, state.def.front).name} front ${pressure === 'blitz' ? 'with a blitz' : 'rushing four (Cover 0 always blitzes)'}.`
    + ` Beside each bar, the average yards a play.${hidden() ? ' Their real call stays hidden until the snap.' : ''}${again()}`;
}
function again() {
  if (!redo) return '';
  const cv = byId(COVERAGES, state.def.coverage);
  const mine = state.side === 'O' ? byId(PLAYS, state.off.play).name
    : `${byId(FRONTS, state.def.front).name}, ${cv.name}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? ', blitz' : ', rush four'}`;
  return ` ${redo.yours ? 'You changed the call' : 'They changed their call'}. Run it again for ${mine}.`;
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
  redo = null;
  button.setAttribute('aria-disabled', 'true');
  const base = call();
  if (state.side === 'O' && hidden()) base.pressure = 'four';
  const rows = (state.side === 'O'
    ? COVERAGES.map(c => ({ id: c.id, name: c.name, call: { ...base, coverage: c.id } }))
    : PLAYS.map(p => ({ id: p.id, name: p.name, call: { ...base, play: p.id } }))).map(r => ({ ...r, n: 0, yds: 0, ok: 0 }));
  chart = { rows, pressure: base.pressure, side: state.side };
  $('chartHint').textContent = chartHint();
  drawBars();
  let slice = performance.now();
  // The first time round, a row at a time ("Running… 2 of 5"); then every row again, FIRST more each time ("Running…
  // 40 of 100"), so they all settle together. (Short enough to stay beside the heading on a computer: with "each" on
  // the end it went under it, and the chart jumped down and back.) A change of call once every row has its first
  // numbers ends the run (see afterChange), and the chart goes, as a finished one does.
  for (let round = 1; round * FIRST <= SNAPS; round++) {
    for (const [i, r] of rows.entries()) {
      button.textContent = round === 1 ? `Running… ${i + 1} of ${rows.length}` : `Running… ${round * FIRST} of ${SNAPS}`;
      for (let k = 0; k < FIRST; k++) {
        if (performance.now() - slice > 10 || state.phase === 'playing') {
          await breather();
          while (state.phase === 'playing' && job === chartJob) await wait(100);
          if (job !== chartJob) return;
          slice = performance.now();
        }
        const res = simulate({ ...r.call, flip: r.n % 2 === 1 }, newSeed()).result;
        r.n++; r.yds += res.yards; if (success(res)) r.ok++;
      }
      r.avg = r.yds / r.n; r.rate = r.ok / r.n; r.of = r.n;
      drawBars();
    }
  }
  button.textContent = AGAIN_LABEL;
  button.removeAttribute('aria-disabled');
}

// The row for the other side's call is marked only once that call is out. A bar that was already up glides to its new
// length as the snaps come in, rather than jumping.
function drawBars() {
  const host = $('bars');
  const was = new Map([...host.querySelectorAll('.bar[data-id]')].map(b => [b.dataset.id, b.style.width]));
  host.textContent = '';
  const mineId = hidden() ? null : state.side === 'O' ? state.def.coverage : state.off.play;
  const tag = state.auto ? 'their call' : 'this call';
  host.insertAdjacentHTML('beforeend', '<div class="bar-head" aria-hidden="true">success · avg yards</div>');
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
    const pct = Math.round(r.rate * 100), tenths = Math.round(r.avg * 10) / 10, avg = `${tenths < 0 ? '−' : ''}${Math.abs(tenths).toFixed(1)}`;
    row.innerHTML = `${name}
      <span class="bar-track"><span class="bar" data-id="${esc(r.id)}"></span></span>
      <span class="bar-val">${pct}% <small>${avg}</small></span>`;
    const bar = row.querySelector('.bar'), from = was.get(r.id);
    if (from) { bar.style.width = from; bar.getBoundingClientRect(); } // from where it was, then on
    bar.style.width = `${Math.max(0.6, r.rate * 100)}%`;
    row.title = `${r.name}${mine ? ` (${tag})` : ''}: ${pct}% successful, ${avg} yards a play, over ${r.of} snaps`;
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
  sec('Formations and personnel', false, `<p>${esc(PERSONNEL)}</p><p>Personnel is the defense's first read: two backs or two tight ends lean run, four receivers lean pass.</p>` + dl(FORMATIONS.map(f => [`${f.name} · ${f.personnel}`, f.blurb])));
  sec('Fronts and techniques', false, `<p>Technique numbers tell a defensive lineman where to line up against the offensive line. Gaps between the blockers are lettered from the center out: A between the center and a guard, B between guard and tackle, C outside the tackle, D outside the tight end.</p>`
    + techDiagram() + dl([...TECHNIQUES, ...FRONTS.map(f => [f.name, f.blurb])]));
  sec('Coverages', false, dl([...COVERAGES.map(c => [c.name, c.blurb]), ['Man and zone', 'In man coverage each defender follows one receiver wherever he goes. In zone coverage each defender guards an area and plays whoever comes into it.'], ['Reading the shell', 'Before the snap, count the safeties deep. Two deep usually means Cover 2 or Cover 4; one deep means Cover 1 or Cover 3; none means Cover 0 and a blitz. The corners help too: up close and pressing means man; about five yards off means Cover 2; seven or more means a deep zone, thirds or quarters. Real defenses disguise it, rotating a safety down or back at the snap. The defenses on this board line up in what they\'ll play.']]));
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
    ['Arrows from the defense', 'Pass rush. A blitzer\'s arrow is drawn thicker, with a double head, in the bright colour.'],
    ['Trails', 'Once the play is running, each man leaves a trail of where he went. The drawn-up play stays faintly underneath, so you can see where it broke down.'],
    ['Dotted line from the quarterback', 'The throw: from where the ball left his hand to where it came down.'],
    ['At the whistle', 'A line across the field where the ball is spotted, with the gain written beside it ("+17", "Sack −7"), or "Incomplete" by an × where the pass came down. A big play is written bigger. Both are in the colour of the side that won the play. After a play that went past the line, the board pulls back to show all of it, from the backfield to the spot.'],
  ]));
  // The words on the board, the cards and the notes that aren't a position, a play or a coverage. The zones are the
  // areas in ZONES (js/playbook.js), as the player cards name them.
  sec('Words coaches use', false, dl([
    ['Strong side and weak side', 'The strong side is the tight end\'s side, or the side with more receivers; the weak side is the other one. The defense sets its strength to it: the Sam and the strong safety go to the strong side, the Will to the weak side.'],
    ['Play side and back side', 'On a run, the play side is where the ball is going and the back side is the other half of the line. Every run on this board is drawn up to the strong side.'],
    ['The box', 'The area near the line where defenders play the run. The board counts it out to 3 yards past the end of the line on each side (the tight end, or the tackle where there\'s no tight end) and up to 8 yards deep. More defenders in the box than there are blockers makes a run hard: there aren\'t enough blockers to go round.'],
    ['Shotgun', 'The quarterback lines up about five yards behind the center and takes a short snap through the air, instead of under center with his hands on the ball. He sees the defense from there, and needs only a short drop to throw.'],
    ['Press', 'A corner lined up a yard or so off the receiver, right in his face, to jam him at the snap and stay on him. Corners press in man coverage.'],
    ['Leverage', 'Which side of a receiver a defender lines up on. With outside leverage he\'s a step outside him, so the receiver\'s easy way is inside; with inside leverage it\'s the other way round.'],
    ['Over the top', 'Deeper than a receiver, between him and the end zone: where a deep safety helps.'],
    ['Three-step and five-step drop', 'How far the quarterback drops back before he throws, counted in steps. From the shotgun he\'s already back, so a three-step drop does what five steps do under center; a quick drop gets the ball out for short routes.'],
    ['Check-down', 'The short, safe throw when everything downfield is covered, usually to the back a few yards past the line.'],
    ['Hot throw', 'A quick throw when a blitzer is coming with nobody left to block him: the quarterback gets it out before he arrives, usually to the receiver in the area the blitzer left.'],
    ['Flat', 'The short area out by the sideline, up to about 10 yards past the line.'],
    ['Curl-flat', 'From about the slot out to the sideline, up to about 12 yards deep. The defender there sinks under a curl route first, then widens to the flat.'],
    ['Hook-curl', 'Inside, from about the end of the line out to the slot, 2 to 13 yards deep: where curls and sit routes settle.'],
    ['Middle hook', 'The middle of the field in front of the safeties, 3 to 14 yards deep.'],
    ['Short middle, "the rat"', 'The middle of the field up to about 10 yards. In Cover 1 the defender left over sits there to take away crossing routes.'],
    ['Deep thirds, halves and quarters', 'The deep field, from about 9 yards on, split between the deep defenders: in thirds in Cover 3 (the corners and the free safety), in halves in Cover 2 (the two safeties), in quarters in Cover 4 (the corners and the safeties). The deep middle third is the middle one of the three; an inside quarter is one of the two nearest the middle.'],
    ['Success', 'A play that gains 4 yards or more. Coaches judge a gain by the down and the distance to go; with no downs on this board, 4 yards, a good start on 1st and 10, is the line. The chart\'s bars show how often a play gets there.'],
    ['Big play', 'A run of 10 yards or more, or a pass play that gains 20 or more: a common way analysts count explosive plays (Sharp Football Analysis, for one). Teams draw the line in different places.'],
    ['Takeaway', 'The defense taking the ball away: an interception, or a fumble it recovers. There are no fumbles on this board, so here a takeaway is an interception.'],
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

placeResult();
wide.addEventListener('change', placeResult);
load();
const link = fromLink();
const kept = link ? null : keptPlay();
if (link === 'ok') firstHint = false; // a shared play runs on its own
if (kept) { // back after a reload: no new look from the other coach
  Object.assign(state, { off: kept.off, def: kept.def, seed: kept.seed, seen: kept.seen });
  firstHint = !kept.snapped;
} else if (link !== 'ok' && state.auto) rollTheirs();
renderChoosers();
playbook();
clearChart();
lineUp();
syncTransport();
if (kept?.snapped) { state.t = board.duration(); finish(); draw(); }
if (link === 'ok') setTimeout(play, 500);
if (link && link !== 'ok') badLink(link);

// A board under about 620 px wide (a phone, or the two-column layout on a small laptop) gets the compact player card.
function narrow() { return $('board').parentElement.classList.contains('narrow'); }
const fit = () => {
  // The board's height, which the page keeps clear when it scrolls something into view while the board is stuck at the
  // top of a phone (scroll-padding-top in css/app.css).
  document.documentElement.style.setProperty('--stage-h', `${document.querySelector('.stage').offsetHeight}px`);
  board.resize();
  $('board').parentElement.classList.toggle('narrow', board.w < 620);
  draw();
  placeWhy();
  if (!$('who').hidden) { syncMore(); placeWho(true); } // placed again for the board's new size
};
fit();
// Once the board has stuck to the top of a phone, a soft edge under it (.stage.stuck in css/app.css), so what scrolls
// under it goes under something. A mark where the board would be in the page goes off the top of the screen as it
// sticks.
{
  const stage = document.querySelector('.stage'), mark = document.createElement('div');
  mark.className = 'stuck-mark';
  stage.before(mark);
  new IntersectionObserver(([e]) => stage.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 0)).observe(mark);
}
const resized = new ResizeObserver(fit);
resized.observe($('board'));
resized.observe(document.querySelector('.stage')); // the controls under the board can take another row on their own
// A window dragged to a screen with another pixel density keeps its size in CSS pixels, so the ResizeObserver doesn't
// see it: a query for the density it has now says when that changes, once, and then the new density is watched.
const density = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { fit(); density(); }, { once: true });
density();
// Another tab saved: take its labels and speed, so neither tab saves its own over them later. Its calls stay its own,
// and a play under way here isn't swapped out.
addEventListener('storage', e => {
  if (e.key !== KEY || !e.newValue) return;
  try {
    const s = JSON.parse(e.newValue);
    if (typeof s.labels === 'boolean') state.labels = board.labels = s.labels;
    if (s.speed === 0.5 || s.speed === 1) state.speed = s.speed;
    syncTransport();
    draw();
  } catch { /* something this version can't read: keep ours */ }
});
const recolor = () => { board.readColors(); draw(); };
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', recolor);
new MutationObserver(recolor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
document.fonts?.ready.then(draw);

if ('serviceWorker' in navigator && !document.documentElement.hasAttribute('data-single') && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// For the screenshot and test scripts.
window.chalkTalk = { state, board, lineUp, play, pause, snap, finish, simulate, rollTheirs };
