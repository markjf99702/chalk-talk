// Chalk Talk: the page. Picks the calls, runs the simulator, plays the result back on the board, and explains it.
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, PRESSURES, BLITZERS, POSITIONS, PERSONNEL, TECHNIQUES, NOTES, ROUTES, DRILLS, HOT, SITUATIONS, needed } from './playbook.js';
import { simulate, prepare, name, hotRoutes, cantCall, blitzerFor, SIM_VERSION } from './sim.js';
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
  off: { formation: 'trips', play: 'smash', flip: false, motion: 'none', hot: {} },
  def: { front: 'nickel', coverage: 'c2', pressure: 'four', blitzer: 'M', disguise: false },
  sit: '1and10', // the down and distance, for both sides (SITUATIONS in js/playbook.js)
  auto: true,
  labels: true,
  speed: 1,
  zoom: false, // zoomed to the line, on a narrow board (not kept: each visit starts with the whole field)
  seed: newSeed(),
  linked: false, // showing a shared play: both calls, until the first change
  seen: false, // the other coach's call has been out since he picked it: a snap showed it, or the playbook did
  book: false, // the playbook set his call and showed it, and it hasn't been snapped yet (see showPart())
  quiz: true, // calling the offense against the other coach, ask what he played after the snap (see answer())
  streak: 0, best: 0, // coverages named right in a row, and the most, on this device
  ask: null, // that question for his call: { guess: null } while it's open, then { guess } once it's answered
  play: null,
  phase: 'pre', // pre, playing, paused, done
  t: 0,
};

// Whether call a has everything call b has (the hot routes alike, none and {} the same).
const same = (a, b) => Object.keys(b).every(f => (f === 'hot' ? JSON.stringify(a.hot || {}) === JSON.stringify(b.hot || {}) : a[f] === b[f]));
// A kept call that this version can play, tidied up, or null.
// (One the formation can't run, a run from Empty, plays Smash: see callable().)
const okOff = o => (o && FORMATIONS.some(f => f.id === o.formation) && PLAYS.some(p => p.id === o.play) ? { formation: o.formation, play: cantCall(o.formation, o.play) ? 'smash' : o.play, flip: !!o.flip, motion: MOTIONS.includes(o.motion) ? o.motion : 'none', hot: okHot(o.hot, o.formation, o.play) } : null);
// Hot routes: a receiver or a back given another route before the snap, by his label ({ H: 'slant' }), on a pass play
// (see hotRoutes() in js/sim.js). Kept in the order the formation lists its men, only the ones that can be, and only
// with the call they were given for: a new play or formation starts from the play as drawn.
function okHot(hot, formation, play) {
  const out = {}, pl = byId(PLAYS, play);
  if (!hot || typeof hot !== 'object') return out;
  for (const [label, , , cls] of byId(FORMATIONS, formation).players) {
    if (typeof hot[label] === 'string' && hotRoutes(pl, { cls }).includes(hot[label])) out[label] = hot[label];
  }
  return out;
}
const hotList = o => Object.entries(o.hot || {});
// In words: "the H on a slant", "the RB in to block".
const HOT_WORDS = { go: 'on a go route', seam: 'on a seam route', post: 'on a post', corner: 'on a corner route', out: 'on an out', dig: 'on a dig', slant: 'on a slant', hitch: 'on a hitch', curl: 'on a curl', flat: 'to the flat', drag: 'on a drag', swing: 'on a swing', wheel: 'on a wheel', check: 'on a check-down', block: 'in to block' };
const and = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '');
const hotWords = o => and(hotList(o).map(([who, r]) => `the ${who} ${HOT_WORDS[r]}`));
// The play as the call has it: "Smash", or "Smash, H on a slant". Short, for the line along the top of the board:
// "Smash (H slant)", or "Smash (3 hot routes)".
const playName = o => byId(PLAYS, o.play).name + hotList(o).map(([who, r]) => `, ${who} ${HOT_WORDS[r]}`).join('');
const playShort = o => { const h = hotList(o); return byId(PLAYS, o.play).name + (!h.length ? '' : h.length > 2 ? ` (${h.length} hot routes)` : ` (${h.map(([who, r]) => `${who} ${r === 'check' ? 'check-down' : r}`).join(', ')})`); };
// The code for them in a shared link: each man's label and his route, run together ("HslantRBblock").
const hotCode = o => hotList(o).map(([who, r]) => who + r).join('');
// Motion before the snap (see presnap() in js/sim.js): none, across (he runs over and sets), or jet (at full speed, the
// ball snapped as he crosses). A formation with a receiver off the line to send has its motion in the playbook (Gun Ace
// has none: its men off the line are its two tight ends).
const MOTIONS = ['none', 'across', 'jet'];
const moving = o => (o.motion === 'across' || o.motion === 'jet') && !!byId(FORMATIONS, o.formation).motion;
// "the H in motion across", "the H in jet motion", or '' with none.
const motionWords = o => (!moving(o) ? '' : `the ${byId(FORMATIONS, o.formation).motion.who} in ${o.motion === 'jet' ? 'jet motion' : 'motion across'}`);
const okDef = d => (d && FRONTS.some(f => f.id === d.front) && COVERAGES.some(c => c.id === d.coverage) ? { front: d.front, coverage: d.coverage, pressure: d.pressure === 'blitz' ? 'blitz' : 'four', blitzer: BLITZERS.some(b => b.id === d.blitzer) ? d.blitzer : 'M', disguise: d.disguise === true } : null);
// Who blitzes on a blitz: the one picked if he can, or else the Mike (see blitzerFor() in js/sim.js); a call keeps its
// pick through a change of front or coverage and back, as it keeps its disguise. Cover 0 sends everyone anyway.
const blitzer = d => (d.coverage !== 'c0' && !blitzerFor(d.front, d.coverage, d.blitzer, d.disguise) ? d.blitzer || 'M' : 'M');
// Who blitzes in the chart, whose rows are every coverage: the one picked, unless he can't be in any of them (the nickel
// back outside the Nickel front, the safety from a disguise), when it's the Mike. (The safety's rows in Cover 2 and Cover
// 4, where he can't come, are the Mike's too, and the chart's words say so.)
const chartBlitzer = d => (BLITZERS.some(b => b.id === d.blitzer) && !blitzerFor(d.front, 'c3', d.blitzer, d.disguise) ? d.blitzer : 'M');
// The blitz as the board says it: "blitz" for the Mike's, as it always was, or "Will blitz", "nickel blitz", "safety blitz".
const blitzWord = d => ({ M: 'blitz', W: 'Will blitz', NB: 'nickel blitz', SS: 'safety blitz' })[blitzer(d)];
// Only Cover 1 and Cover 3 disguise, showing two deep and rotating at the snap (see the end of buildDefense() in
// js/sim.js); a call keeps its disguise through a change to another coverage and back, as it keeps its pressure.
const DISGUISES = ['c1', 'c3'];
const disguised = d => d.disguise && DISGUISES.includes(d.coverage);
// The coverage as a sentence says it: "Cover 3", or "disguised Cover 3".
const covWords = d => `${disguised(d) ? 'disguised ' : ''}${byId(COVERAGES, d.coverage).name}`;
// The down and distance, the same for both sides: one of SITUATIONS (js/playbook.js) by its id, as it's kept and as a
// shared link has it ("3and8"). A play has the one it was snapped in (state.play.sit, see lineUp()).
const okSit = id => (SITUATIONS.some(s => s.id === id) ? id : null);
const situation = () => byId(SITUATIONS, state.sit);

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s) {
      if (s.side === 'O' || s.side === 'D') state.side = s.side;
      state.off = okOff(s.off) || state.off;
      state.def = okDef(s.def) || state.def;
      state.sit = okSit(s.sit) || state.sit;
      if (typeof s.auto === 'boolean') state.auto = s.auto;
      if (typeof s.labels === 'boolean') state.labels = s.labels;
      if (s.speed === 0.5 || s.speed === 1) state.speed = s.speed;
      takeQuiz(s);
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
  try { localStorage.setItem(KEY, JSON.stringify({ side: state.side, off: own.off, def: own.def, sit: state.sit, auto: ownAuto, labels: state.labels, speed: state.speed, quiz: state.quiz, streak: state.streak, best: state.best })); } catch { /* fine */ }
}
// The question's switch and the streak, from a save (this tab's, or another tab's as it saves).
const tally = n => (Number.isInteger(n) && n >= 0 ? n : null);
function takeQuiz(s) {
  if (typeof s.quiz === 'boolean') state.quiz = s.quiz;
  state.streak = tally(s.streak) ?? state.streak;
  state.best = Math.max(state.streak, tally(s.best) ?? state.best);
}

// The play on the board, kept for this tab only: a reload, or a phone dropping the tab while it's in the background,
// comes back to it (the same snap and the same call from the other coach, finished if it had been snapped), while a new
// visit gets a fresh look.
const PLAY_KEY = 'chalk-talk.v1.play';
function keepPlay() {
  try { sessionStorage.setItem(PLAY_KEY, JSON.stringify({ side: state.side, auto: state.auto, off: state.off, def: state.def, sit: state.sit, seed: state.seed, seen: state.seen, book: state.book, ask: state.ask, drill, drilled, snapped: state.phase !== 'pre' })); } catch { /* fine */ }
}
// The kept play, if it's for the calls and the situation you have now (after a shared play, say, it isn't). One kept
// before there were downs was on 1st & 10.
function keptPlay() {
  try {
    const k = JSON.parse(sessionStorage.getItem(PLAY_KEY) || 'null'), off = okOff(k?.off), def = okDef(k?.def);
    // A drill under way has the other coach picking, whatever your own switch says (see startDrill()).
    const drill = okDrill(k?.drill, k?.side), auto = drill ? true : state.auto;
    if (!off || !def || k.side !== state.side || k.auto !== auto || (k.sit ?? '1and10') !== state.sit || !Number.isInteger(k.seed) || k.seed < 0) return null;
    if ((!auto || state.side === 'O') && !same(off, own.off)) return null;
    if ((!auto || state.side === 'D') && !same(def, own.def)) return null;
    const ask = k.ask && (k.ask.guess === null || COVERAGES.some(c => c.id === k.ask.guess)) ? { guess: k.ask.guess } : null;
    const done = okDrill(k.drilled), drilled = done?.n === DRILL_SNAPS ? done : null;
    return { off, def, seed: k.seed, seen: !!k.seen, book: !!k.seen && !k.snapped && k.book === true, ask: k.snapped ? ask : null, drill, drilled, snapped: !!k.snapped };
  } catch { return null; }
}

const call = () => ({ ...state.off, ...state.def });
// The other coach's call is hidden from the board, the chart and the player cards until the snap, and while you're asked
// what he played, until you've answered. Once it's out, it stays out until he picks again. With a man in motion the
// snap comes after Snap is pressed: his call waits for the ball (atSnap, see out()).
let atSnap = false;
const hidden = () => state.auto && ((state.phase === 'pre' && !state.seen) || atSnap || asking());
// Whether the question "What did they play?" is waiting for an answer.
const asking = () => state.auto && state.side === 'O' && !!state.ask && !state.ask.guess;

// The other coach's call, picked the way a real one might: nickel against three and four receivers, and so on. It's
// never the call they had (New look always changes something), short of ten unlucky rolls in a row.
// Calling the defense, his play leans on his personnel, so reading it before the snap tells you something: about this
// share of his plays are runs from each formation on 1st & 10, the rest passes, and every play stays possible. (A
// design choice in the direction real offenses lean, more backs and tight ends running more; not a published
// statistic.) The down moves it (see lean()).
const RUN_SHARE = { iform: 0.6, single: 0.55, ace: 0.5, pistol: 0.45, trips: 0.375, doubles: 0.25, empty: 0 };
// The down and distance moves his call the way NFL teams' calls moved from 1st & 10 to that situation in 2023 (nfl in
// SITUATIONS, js/playbook.js), from his 1st & 10 call as it always was. A yes-or-no share moves by the same odds as the
// NFL's did, so it stays between none and all: his nickel front by the NFL's five or more defensive backs, his blitz by
// its five or more rushers, and his run share by its runs (on 3rd & 8 the NFL blitzed on 39% of dropbacks against 25%
// on 1st & 10, and so does he; I-Form's 60% of runs on 1st & 10 becomes 6%). Each coverage moves by as many points as
// its share of the NFL's five did, rather than by odds, as this board's Cover 0 already comes up far more often on
// 1st & 10 than the NFL's 1%: on 3rd & 8 his Cover 1 goes from 22% to 38%.
function lean(sit) {
  const a = SITUATIONS[0].nfl, b = sit.nfl;
  const odds = (from, to) => p => { if (from === to) return p; const o = (p / (1 - p)) * (to / (100 - to)) / (from / (100 - from)); return o / (1 + o); };
  const share = n => { const all = Object.values(n.cover).reduce((x, y) => x + y, 0); return c => n.cover[c] / all; };
  const was = share(a), now = share(b);
  return { nickel: odds(a.nickel, b.nickel), blitz: odds(a.blitz, b.blitz), run: odds(100 - a.pass, 100 - b.pass), cover: (c, p) => Math.max(0.01, p + now(c) - was(c)), passing: b.pass / a.pass };
}
// Calling the defense, his offense puts a man in motion about one snap in three, across or jet alike, counting the
// formations that have nobody to send. (A design choice, so motion comes up as you watch your own defense; not a
// published statistic.)
const MOTION_SHARE = 1 / 3;
// Calling the offense, about one of his snaps in four is a disguise: he plays Cover 1 or Cover 3 on 54% of them, and
// disguises 46% of those. (A design choice, so a look can't be trusted every time; not a published statistic.)
const DISGUISE_SHARE = 0.46;
function rollTheirs() {
  state.seen = state.book = false;
  state.ask = null;
  if (drill) { drillCall(); return; }
  const R = rng(newSeed());
  const w = list => { let x = R() * list.reduce((a, [, p]) => a + p, 0); for (const [v, p] of list) { if ((x -= p) <= 0) return v; } return list[0][0]; };
  const theirs = () => (state.side === 'O'
    ? [state.def.front, state.def.coverage, state.def.coverage === 'c0' ? 'blitz' : state.def.pressure === 'blitz' ? blitzWord(state.def) : 'four'] // Cover 0 always blitzes; a disguise alone isn't a new call
    : [state.off.formation, state.off.play, state.off.flip]).join();
  const had = theirs(), L = lean(situation());
  for (let tries = 0; tries < 10 && theirs() === had; tries++) {
    if (state.side === 'O') {
      const pers = byId(FORMATIONS, state.off.formation).personnel;
      const spread = pers === '10' || pers === '11';
      // his fronts on 1st & 10, then nickel moved for the down and the others sharing what's left as they did
      const fronts = spread ? [['nickel', 0.55], ['over', 0.15], ['under', 0.12], ['34', 0.18]] : [['over', 0.3], ['under', 0.25], ['34', 0.3], ['nickel', 0.15]];
      const nickel = fronts.find(([f]) => f === 'nickel')[1], more = L.nickel(nickel);
      state.def.front = w(fronts.map(([f, p]) => [f, f === 'nickel' ? more : p * (1 - more) / (1 - nickel)]));
      state.def.coverage = w([['c0', 0.06], ['c1', 0.22], ['c2', 0.2], ['c3', 0.32], ['c4', 0.2]].map(([c, p]) => [c, L.cover(c, p)]));
      state.def.pressure = R() < L.blitz(0.25) ? 'blitz' : 'four';
      state.def.disguise = DISGUISES.includes(state.def.coverage) && R() < DISGUISE_SHARE;
      // who comes, of the ones who can with this front, coverage and disguise: the Mike most often, then the Will, the
      // nickel back and the safety
      state.def.blitzer = w([['M', 0.4], ['W', 0.3], ['NB', 0.15], ['SS', 0.15]].filter(([b]) => !blitzerFor(state.def.front, state.def.coverage, b, state.def.disguise)));
    } else {
      // Empty, which can only throw, half as often as each of the others on 1st & 10, and more or less often as the NFL's
      // passes went with the down (a design choice, so it comes up without taking over; not a published statistic)
      const lineups = FORMATIONS.map(f => [f.id, f.id === 'empty' ? 0.5 * L.passing : 1]);
      state.off.formation = w(lineups);
      // (only the plays his formation can run: from Empty, no runs, no fake and no screen)
      const can = PLAYS.filter(p => !cantCall(state.off.formation, p.id)), runs = can.filter(p => p.type === 'run').length;
      const run = runs ? L.run(RUN_SHARE[state.off.formation] ?? 0.42) : 0;
      state.off.play = w(can.map(p => [p.id, p.type === 'run' ? run / runs : (1 - run) / (can.length - runs)]));
      state.off.flip = R() < 0.5;
      // Gun Ace and Empty have nobody to send, so from the others a little more often, to keep it one snap in three
      const all = lineups.reduce((a, [, p]) => a + p, 0), movers = lineups.filter(([id]) => byId(FORMATIONS, id).motion).reduce((a, [, p]) => a + p, 0);
      const share = byId(FORMATIONS, state.off.formation).motion ? Math.min(1, MOTION_SHARE * all / movers) : 0, m = R();
      state.off.motion = m < share / 2 ? 'across' : m < share ? 'jet' : 'none';
      state.off.hot = {};
    }
  }
}

// ---------------------------------------------------------------- the board

const board = new Board($('board'));

// keep: the result card stays where it is, faded, until this play's comes in (see snap()); otherwise it goes.
function lineUp(keep = false) {
  cancelAnimationFrame(raf); // a frame of the last play still to come would run its clock on into this one
  clearTimeout(whyTimer);
  moment = null;
  state.play = simulate(call(), state.seed);
  state.play.sit = situation();
  state.phase = 'pre';
  board.setPlay(state.play);
  board.togo = state.play.sit.togo; // the yellow line
  board.mark = endMark(state.play.result, state.play.sit);
  state.t = board.t = board.start(); // the snap, or before it with a man in motion
  board.waitSnap = atSnap = false;
  board.selected = -1;
  board.spot = -1;
  board.spotAll = null;
  hideWho();
  closeRoutes();
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

// A moment from the play-by-play, watched again (see replay()): its line, and while it plays, the time it stops at.
let moment = null; // { e, until }, then { e } once it has stopped there
// The play last seen to the whistle (played out, scrubbed to the end, or back after a reload): the scrubber's marks are
// for it (see syncMarks()).
let whistled = null;

function play() {
  if (!state.play) return;
  moment = null;
  const snapped = state.phase === 'pre';
  if (snapped) { linkNote = ''; state.book = false; dropHint(); } // a word about a link that couldn't open lasts until the next play
  // His call is out now, and stays out until he picks again, unless you're to say what he played first: then it's
  // out once you have (see answer()). For a replay the status line is cleared, so that its end is said again.
  // A call of his that was hidden stays off the board through any motion before the snap, until the ball is snapped.
  if (snapped) board.waitSnap = state.auto && !state.seen;
  // In words too: with a man in motion before the snap, it comes out when the ball is snapped (see snappedNow()).
  atSnap = snapped && board.waitSnap && board.start() < 0;
  if (snapped && state.auto && !atSnap) out();
  else if (!snapped) say('');
  if (state.phase === 'done' || state.t >= board.duration()) state.t = board.start();
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
  closeRoutes();
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
  const dt = Math.min(0.05, (now - last) / 1000), again = moment?.until !== undefined;
  last = now;
  state.t = Math.min(again ? moment.until : board.duration(), state.t + dt * (again ? 0.5 : state.speed));
  snappedNow();
  caption();
  draw();
  syncScrub();
  if (again && state.t >= moment.until) { pause(); return; }
  if (state.t >= board.duration()) { finish({ hold: true }); return; }
  if (state.phase === 'playing') raf = requestAnimationFrame(tick);
}

// His call comes out: at the snap, which is as Snap is pressed unless a man goes in motion first.
function out() {
  atSnap = false;
  if (!state.seen && state.side === 'O' && state.quiz && !drill) state.ask = { guess: null };
  else if (state.ask?.guess) state.ask = null; // answered last snap: this one shows his call as usual
  state.seen = true;
  say(asking() ? 'What did they play? Name their coverage, in their call.' : `They called: ${theirSummary()}.`);
}
// The ball snapped after a man's motion, as the play runs or is scrubbed past it: the call he kept back comes out, in
// his drawn-up play, his card, the matchup, the jobs, the tapped player's card and the chart.
function snappedNow() {
  if (!atSnap || state.t < -1e-6) return;
  out();
  syncBoard();
  syncTheirs();
  syncJobs();
  renderMatchup();
  if (board.selected >= 0) showWho(board.selected);
  syncChart();
  keepPlay();
}

function pause() { state.phase = 'paused'; cancelAnimationFrame(raf); if (moment) delete moment.until; syncTransport(); }

// A time in the play-by-play, tapped: that moment again, the way a broadcast replays it, from a second before it to a
// second after, at half speed whatever the speed is set to, and then it stops there with that line still on the board.
// (It stops short where two more lines would have come up after it and pushed it off.) ▶ plays on from there at the
// speed you have.
function replay(e) {
  if (!state.play || state.phase === 'pre') return;
  const F = state.play.frames, dt = F[1].t - F[0].t;
  const lines = state.play.events.filter(x => x.kind !== 'shed' || x === e), next = lines[lines.indexOf(e) + 2];
  let until = Math.min(e.t + 1, board.duration() - dt);
  if (next) until = Math.min(until, next.t - dt);
  cancelAnimationFrame(raf);
  clearTimeout(whyTimer);
  moment = { e, until: Math.max(until, e.t) };
  state.t = Math.max(board.start(), e.t - 1);
  state.phase = 'playing';
  $('why').hidden = true;
  if (board.selected >= 0 && cardClosesOnPlay()) { board.selected = -1; hideWho(); }
  caption(); draw(); syncTransport();
  toBoard();
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

// The end of the play. Played out, the line that ended it stays up a moment to be read (the simulator stops the board
// 0.7 s after it, which is short for "The strong safety makes the tackle." and the catch just before it), and then the
// button down to the explanation takes its place. The result card under the board, and what a screen reader hears,
// come at once. Scrubbed to the end, or back after a reload, the button is there at once too.
let whyTimer = 0;
const HOLD = 1300; // ms
function finish({ hold = false } = {}) {
  state.phase = 'done';
  snappedNow();
  if (board.selected >= 0 && !$('who').hidden) routeChips(state.play.players[board.selected]); // his route can be changed again
  whistled = state.play;
  tallyDrill();
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
  const where = resultBeside() ? 'beside' : 'under';
  say(`${headline(state.play.result, state.play.sit)}. ${$('resKicker').textContent}. ${asking() ? `Name their coverage ${where} the board, and the coach's note says why.` : `Why it worked is ${where} the board.`}${drillNews ? ` ${drillNews}` : ''}`);
  drillNews = '';
}
const resultBeside = () => $('result').getBoundingClientRect().left >= $('board').getBoundingClientRect().right;

// On a computer the result card goes at the top of the right-hand column, beside the board, so it's there as the play
// ends (over the key, if that's open), and when the call changes it goes and the calls are back at the top. On a phone or a tablet it comes after the
// calls, under the board, with the button on the board to take you down to it. It's moved in the page rather than only
// drawn somewhere else, so the keyboard and a screen reader come to it where the eye does.
const wide = matchMedia('(min-width: 960px)');
function placeResult() {
  const r = $('result'), focused = r.contains(document.activeElement) ? document.activeElement : null;
  if (wide.matches) $('key').before(r); else $('chart').before(r);
  focused?.focus({ preventScroll: true });
}

// At the end of the play, the headline and a way down to the explanation, where the caption was.
function showWhy() {
  setCaption('');
  board.spot = -1; board.spotAll = null; // the caption makes way for the headline, and nobody is named
  draw();
  $('why').innerHTML = `${esc(headline(state.play.result, state.play.sit, true))} · <span class="why-go">Why <span aria-hidden="true">${resultBeside() ? '→' : '↓'}</span></span>`;
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
    if (drill && state.side === 'D') rollTheirs(); // in the run drill, a new run each snap
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
// The man the newest line names is ringed on the board (see Board.players()). A moment being watched again from the
// play-by-play is the exception: once it has come, its line stays up beside the newest one (even where two more come in
// the same frame) and its man is the one ringed, and a line about a block shed comes up only when it's that moment.
function caption() {
  const m = moment?.e;
  const evs = state.play.events.filter(e => e.t <= state.t + 0.001 && state.t - e.t < 2.2 && (e.kind !== 'shed' || e === m));
  let shown = evs.slice(-2);
  if (m && evs.includes(m) && !shown.includes(m)) shown = [m, evs.at(-1)];
  setCaption(shown.map(words));
  const ringed = m && shown.includes(m) && (m.who >= 0 || m.all) ? m : evs.at(-1);
  board.spot = ringed?.who ?? -1;
  board.spotAll = ringed?.all || null;
}
// A line of the play-by-play, as the board and the result card say it. While you're asked what they played, Cover 0's
// blitz names the blitzers, and a disguise's rotation the safety, without naming the coverage.
const words = e => (!asking() ? e.text : e.kind === 'blitz' ? e.text.replace(/^Cover 0: (\w)/, (_, c) => c.toUpperCase())
  : e.kind === 'rotate' ? e.text.replace(/: Cover \d\.$/, '.') : e.text);

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
  syncMarks();
  for (const b of document.querySelectorAll('[data-speed]')) b.setAttribute('aria-checked', String(+b.dataset.speed === state.speed));
  rove(document.querySelector('.seg'));
  $('labels').setAttribute('aria-pressed', String(state.labels));
}

// The scrubber counts the play's frames, twenty to the second, so an arrow key steps one frame and the far end is the
// last. What a screen reader hears is the time and what's going on: "1.9 of 4.1 seconds: The quarterback throws to the H
// on a corner route", and at the end the headline. The clock beside it shows the time the way the play-by-play does,
// so you can scrub to the moment a line names: "1.9s", and a dash before the snap. With a man in motion the time
// before the snap counts down to it, "−1.2s", as the play-by-play has it, and a mark on the scrubber is at the snap.
const clock = t => (t < -0.049 ? `\u2212${(-t).toFixed(1)}s` : `${Math.max(0, t).toFixed(1)}s`);
function syncScrub() {
  const s = $('scrub'), F = state.play?.frames;
  if (!F) return;
  $('clock').textContent = state.phase === 'pre' ? '–' : clock(state.t);
  const dt = F.length > 1 ? F[1].t - F[0].t : 0.05;
  s.max = String(F.length - 1);
  s.value = String(Math.min(F.length - 1, Math.round((state.t - F[0].t) / dt)));
  const now = state.phase === 'pre' ? '' : state.phase === 'done' ? headline(state.play.result, state.play.sit) : $('caption').lastElementChild?.textContent;
  const when = state.t < -0.049 ? `${(-state.t).toFixed(1)} seconds before the snap` : `${Math.max(0, state.t).toFixed(1)} of ${board.duration().toFixed(1)} seconds`;
  s.setAttribute('aria-valuetext', `${when}${now ? `: ${now}` : ''}`);
}

// The marks under the scrubber at the handoff, the throw and the catch (or the interception), once the play has been
// seen to the whistle: as it runs the first time they'd give away how it comes out (a second mark is a catch, none on a
// pass is a sack), and before the snap whether a hidden play is a run or a pass.
// The snap's mark, with a man in motion, is there from the start: it gives nothing away.
let marked = null;
function syncMarks() {
  const seen = state.phase !== 'pre' && whistled === state.play;
  if (marked?.play === state.play && marked.seen === seen) return;
  marked = { play: state.play, seen };
  const host = $('marks'), P = state.play, F = P?.frames;
  host.textContent = '';
  if (!P) return;
  const dt = F[1].t - F[0].t;
  const mark = (kind, t) => {
    const i = document.createElement('i');
    i.dataset.kind = kind;
    i.style.setProperty('--at', String(Math.min(1, Math.round((t - F[0].t) / dt) / (F.length - 1))));
    host.append(i);
  };
  if (F[0].t < 0) mark('snap', 0);
  if (seen) for (const e of P.events.filter(x => ['hand', 'throw', 'catch', 'int'].includes(x.kind))) mark(e.kind, e.t);
}

$('snap').addEventListener('click', snap);
// The result card's buttons go with it, or fade out of reach with it, as the next play lines up, so the focus goes on
// to Snap.
const toSnap = () => $('snap').focus({ preventScroll: true });
$('again').addEventListener('click', () => { toSnap(); snap(); if (matchMedia('(max-width: 959px)').matches) toBoard(); });
$('play').addEventListener('click', () => (state.phase === 'playing' ? pause() : play()));
$('scrub').addEventListener('input', e => {
  if (!state.play) return;
  moment = null;
  cancelAnimationFrame(raf);
  clearTimeout(whyTimer);
  const F = state.play.frames;
  state.t = F[Math.max(0, Math.min(F.length - 1, Math.round(+e.target.value)))].t;
  state.phase = state.t >= board.duration() ? 'done' : 'paused';
  snappedNow();
  if (state.phase === 'done') { whistled = state.play; tallyDrill(); }
  caption(); draw(); syncTransport();
  if (state.phase === 'done') { showResult(); showWhy(); sayResult(); } else $('why').hidden = true;
});
for (const b of document.querySelectorAll('[data-speed]')) b.addEventListener('click', () => { state.speed = +b.dataset.speed; save(); syncTransport(); });
$('labels').addEventListener('click', () => { state.labels = !state.labels; board.labels = state.labels; save(); syncTransport(); draw(); });
// Zoom to the line, on a narrow board: twice as big, on the ball, so the linemen and their labels can be told apart.
// The magnifier again zooms back out. It eases in and out over a third of a second, or at once with reduced motion
// asked for; tapping and the drawn-up play work the same zoomed in.
$('zoom').addEventListener('click', () => { state.zoom = !state.zoom; syncZoom(true); });
let zoomRaf = 0;
function syncZoom(ease = false) {
  const to = state.zoom && narrow() ? 1 : 0, from = board.zoomU, t0 = performance.now();
  $('zoom').setAttribute('aria-pressed', String(state.zoom));
  cancelAnimationFrame(zoomRaf);
  const step = now => {
    const u = !ease || board.still.matches ? 1 : Math.min(1, (now - t0) / 330);
    board.zoomU = from + (to - from) * (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2);
    if (state.phase !== 'playing') draw(); // (a play running draws it every frame anyway)
    if (u < 1) zoomRaf = requestAnimationFrame(step);
    else if (!$('who').hidden) placeWho(true);
  };
  step(t0);
}

// Key: how to read the board, in a card just under the board on a phone (where the board stays at the top, so the two
// are on the screen together) and at the top of the column beside it on a computer. Key again, or its ×, puts it away.
$('keyOpen').addEventListener('click', () => { if ($('key').hidden) openKey(); else closeKey(); });
$('keyClose').addEventListener('click', () => closeKey(true));
function openKey() {
  $('key').hidden = false;
  $('keyOpen').setAttribute('aria-expanded', 'true');
  $('key').scrollIntoView({ block: 'start', behavior: smooth() });
  $('keyTitle').focus({ preventScroll: true });
}
function closeKey(back = false) {
  $('key').hidden = true;
  $('keyOpen').setAttribute('aria-expanded', 'false');
  if (back) $('keyOpen').focus({ preventScroll: true });
}
// The chalk dust the board punches out of its lines (see Board.makeGrain()), as a mask for the key's drawings on the
// chalkboard: the same specks, the same size on the screen.
{
  const g = document.createElement('canvas'), c = g.getContext('2d');
  g.width = g.height = 160;
  c.fillRect(0, 0, 160, 160);
  c.globalCompositeOperation = 'destination-out';
  let a = 7;
  const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  for (let i = 0; i < 2600; i++) {
    c.fillStyle = `rgba(0,0,0,${0.15 + rnd() * 0.5})`;
    const sz = rnd() < 0.85 ? 1 : 2;
    c.fillRect(Math.floor(rnd() * 160), Math.floor(rnd() * 160), sz, sz);
  }
  document.documentElement.style.setProperty('--grain', `url(${g.toDataURL()})`);
  document.documentElement.style.setProperty('--grain-size', `${160 / Math.min(devicePixelRatio || 1, 2.5)}px`);
}

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
  closeRoutes();
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
  closeRoutes();
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
    : p.team === 'D' ? `${tell(state.play, i)} His job is hidden until ${asking() ? 'you name their coverage' : 'the snap'}.`
      : 'His job on this play is hidden until the snap. Read the alignment: where he stands gives some of it away.';
  $('whoAbout').textContent = about;
  $('whoMore').textContent = `More about the ${p.label}`;
  $('whoMore').hidden = !about;
  routeChips(p);
  $('who').hidden = false;
  syncMore();
  placeWho(fresh);
}
function hideWho() { $('who').hidden = true; }

// Hot routes: on your own pass play, until it's snapped (or again once it's over), a receiver's or a back's card has
// "Change his route". It opens a row under the board with a button for each route he can be given, his route as called
// first, and the card makes way for it, so the whole board shows, his lines over the others. One picked redraws his
// line, and he keeps his place in the quarterback's reads (or, if he had none, he's read last): see assignOffense() in
// js/sim.js. The row stays with him until Done, a tap on the board, the snap, or a change of call other than his route.
let routesFor = -1; // the man the row is open for
const routeName = id => (id === 'block' ? 'block' : ROUTES[id]?.name || id);
// (before the snap, or once the play has been seen to the whistle: not paused part way through it)
const routeTime = () => state.phase === 'pre' || state.phase === 'done' || (state.phase === 'paused' && whistled === state.play);
const canRoute = p => (p.team === 'O' && (state.side === 'O' || !state.auto) && routeTime() ? hotRoutes(byId(PLAYS, state.off.play), p) : []);
function routeChips(p) { $('whoRoutesOpen').hidden = !canRoute(p).length; }
// Where he is in the quarterback's reads, with the route he has now.
function readWords(p, now, drawn) {
  if (now === 'block') return 'In to block, he isn\'t one of the quarterback\'s reads.';
  if (state.play.drawnReads.includes(p.label)) return 'He keeps his place in the quarterback\'s reads.';
  return now === drawn ? 'He isn\'t one of the quarterback\'s reads as it\'s drawn: give him another route and he\'s read last.' : 'The quarterback reads him last.';
}
function openRoutes(i) {
  const p = state.play.players[i], can = canRoute(p);
  if (!can.length) { closeRoutes(); return; }
  routesFor = i;
  const host = $('routeChips'), drawn = state.play.drawn[p.label], now = state.off.hot?.[p.label] || drawn;
  $('routesWho').innerHTML = `<b>The ${esc(p.label)}'s route.</b> <span>${esc(readWords(p, now, drawn))}</span>`;
  host.textContent = '';
  for (const id of [drawn, ...can.filter(r => r !== drawn)]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(id === now));
    b.dataset.route = id;
    b.innerHTML = id === drawn ? `${esc(routeName(id))} <small>as called</small>` : esc(routeName(id));
    b.addEventListener('click', () => changeRoute(p.label, id));
    host.append(b);
  }
  rove(host);
  $('routes').hidden = false;
  hideWho();
  // in sight: on a phone turned sideways it's under the scrubber, in the stage beside the calls, which scrolls to it
  const r = $('routes').getBoundingClientRect();
  if (r.bottom > innerHeight || r.top < 0) $('routes').scrollIntoView({ block: 'nearest', behavior: smooth() });
}
function closeRoutes() {
  routesFor = -1;
  $('routes').hidden = true;
}
onButton($('whoRoutesOpen'), () => {
  openRoutes(board.selected);
  $('routeChips').querySelector('[aria-checked="true"]')?.focus({ preventScroll: true });
});
$('routesDone').addEventListener('click', () => {
  closeRoutes();
  board.selected = -1;
  hideWho();
  draw();
  toSnap();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('routes').hidden && $('who').hidden) $('routesDone').click(); });
function changeRoute(label, route) {
  const i = board.selected, drawn = state.play.drawn[label], hot = { ...state.off.hot };
  if (route === drawn) delete hot[label]; else hot[label] = route;
  state.off.hot = okHot(hot, state.off.formation, state.off.play);
  afterChange(); // a change of call: lined up again, with a new roll of the dice
  board.selected = i;
  openRoutes(i);
  draw();
  setCaption(route === drawn ? `The ${label} runs his route as called.` : `Hot route: the ${label} ${HOT_WORDS[route]}.`);
  $('routeChips').querySelector(`[data-route="${route}"]`)?.focus({ preventScroll: true });
}

// What a defender's spot before the snap gives away, from what anyone can see on the board: how deep he is, what he's
// over, whether he's in the box. On this board the tells are exact (corners pressed only in man, a Mike only creeps up
// to blitz), short of a disguise, which shows two deep; they're worded the way they'd hold on a real field.
function tell(P, i) {
  // (where everyone stands before the snap: with a man in motion, before he goes)
  const spot = q => ({ ...q, x: P.frames[0].xy[2 * q.i], y: P.frames[0].xy[2 * q.i + 1] });
  const p = spot(P.players[i]), { x, y } = p, yd = n => `${Math.round(n)} yards`;
  const recv = P.players.filter(q => q.team === 'O' && (q.cls === 'wr' || q.cls === 'te')).map(spot);
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
        : 'Deep over his half of the field, with the other safety deep too: two deep, so Cover 2 or Cover 4, unless one of them rotates down at the snap.';
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
      // A chip can be greyed out on its own (off: why, its title, which a pointer shows and a screen reader gives as its
      // description; the row's words below say it too).
      b.disabled = !!opts.disabled || !!it.off;
      if (it.off) b.title = it.off;
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
    if ((patch.formation || state.off.formation) !== state.off.formation || (patch.play || state.off.play) !== state.off.play) patch.hot = {};
    Object.assign(state.off, patch);
    // New personnel and the other coach substitutes: nickel against three receivers, base against two backs. A new play
    // or strong side keeps his call, the way an audible at the line does. The board says so until the snap, the way New
    // look does, since his new call is hidden.
    const fixed = callable();
    const subbed = state.auto && state.side === 'O' && byId(FORMATIONS, state.off.formation).personnel !== was;
    if (subbed) rollTheirs();
    afterChange();
    if (subbed || fixed) setCaption([fixed, subbed ? 'New personnel: they\'ve substituted.' : ''].filter(Boolean).join(' '));
  };
  chips(host, 'Formation', FORMATIONS.map(f => ({ id: f.id, name: f.name, sub: f.personnel, subWord: 'personnel' })), fm.id, id => set({ formation: id }), {
    disabled: readonly, blurb: `${fm.blurb} ${personnelWords(fm.personnel)}`,
  });
  chips(host, 'Strong side', [{ id: 'R', name: 'Right' }, { id: 'L', name: 'Left' }], state.off.flip ? 'L' : 'R', id => set({ flip: id === 'L' }), {
    disabled: readonly, blurb: strongBlurb(fm),
  });
  if (fm.motion) {
    chips(host, 'Motion', [{ id: 'none', name: 'None' }, { id: 'across', name: 'Across' }, { id: 'jet', name: 'Jet' }], moving(state.off) ? state.off.motion : 'none', id => set({ motion: id }), {
      disabled: readonly, blurb: motionBlurb(fm, moving(state.off) ? state.off.motion : 'none'),
    });
  }
  // From Empty the plays that need a back are greyed out, each saying why (see cantCall() in js/sim.js).
  const items = PLAYS.map(p => ({ id: p.id, name: p.name, type: p.type, off: cantCall(fm.id, p.id) }));
  chips(host, 'Play', items, pl.id, id => set({ play: id }), {
    disabled: readonly, blurb: pl.blurb + (items.some(it => it.off) ? ` From ${fm.name} there's no back behind the line: no runs, no play-action fake and no RB Screen.` : ''),
    groups: [{ name: 'Runs', items: items.filter(p => p.type === 'run') }, { name: 'Passes', items: items.filter(p => p.type === 'pass') }],
  });
}

// A call the board can't make, a formation with no back and a play that needs one (see cantCall() in js/sim.js), put
// right: the play becomes Smash, or (keep: 'play', when the play was picked from the playbook) the formation becomes
// Gun Trips. The words for the caption, or '' when there was nothing to put right.
function callable(keep) {
  const { formation, play } = state.off, no = cantCall(formation, play), fm = byId(FORMATIONS, formation);
  if (!no) return '';
  state.off.hot = {};
  if (keep === 'play') { state.off.formation = 'trips'; state.off.motion = 'none'; return `${fm.name} has no back for it, so it's from Gun Trips.`; }
  state.off.play = 'smash';
  return `${fm.name}: ${no.charAt(0).toLowerCase()}${no.slice(1, -1)}, so the play is Smash.`;
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

// What the motion does from this formation: who goes, where he sets and how the receivers count then, and the read.
function motionBlurb(fm, motion) {
  const { who, to } = fm.motion, side = to > 0 ? 'strong' : 'weak';
  const n = sd => fm.players.filter(([label, x, , c]) => (c === 'wr' || c === 'te') && Math.sign(label === who ? to : x) === sd).length;
  const word = k => ['no', 'one', 'two', 'three', 'four'][k], a = n(Math.sign(to)), b = n(-Math.sign(to));
  // (counted again once he's set, and a pass play goes to the side with more: see prepare() in js/sim.js)
  const count = a === b ? `${word(a)} receivers each side` : `${word(a)} receivers on his side and ${word(b)} on the other, so a pass play goes his way`;
  const read = 'If a defender runs with him, it\'s man coverage; if the defense only slides over, it\'s zone.';
  if (motion === 'across') return `Before the snap the ${who} runs across the formation, behind the line, and sets on the ${side} side: ${count}. ${read}`;
  if (motion === 'jet') return `Jet motion: the ${who} runs across the formation at full speed and the ball is snapped as he crosses, so a man covering him has to run with him flat out. He carries on across behind the line and runs his route from the ${side} side. ${read}`;
  return `Everyone stays put until the snap. Or send the ${who} across the formation first, and watch who goes with him: it shows man or zone.`;
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
  // Who blitzes: on a blitz, any of the four who can (see blitzerFor() in js/sim.js); the others are greyed out, and the
  // words under the row say why (a chip's title says it too, but a phone shows no title).
  const who = blitzer(state.def), b = byId(BLITZERS, who), waits = zero || pr.id !== 'blitz';
  const items = BLITZERS.map(x => ({ id: x.id, name: x.name, off: blitzerFor(fr.id, cv.id, x.id, state.def.disguise) }));
  const why = items.map(x => x.off).filter(Boolean).join(' ');
  chips(host, 'Blitzer', items, who, id => set({ blitzer: id }), {
    disabled: readonly || waits,
    blurb: zero ? 'In Cover 0 every man not covering a receiver comes: the Mike and whoever is left over.'
      : waits ? 'Pick Blitz above, then who comes: the Mike, the Will, the nickel back or the strong safety.'
        : `${b.words.charAt(0).toUpperCase()}${b.words.slice(1)}. ${who === 'NB' ? 'The slot receiver he leaves is covered by someone else, or by nobody: a quick throw there beats it.' : who === 'SS' ? 'One deep safety is left, and a linebacker or the nickel back covers the man the safety would have.' : 'The man he would have covered is someone else\'s, or a zone has one fewer defender.'}${why ? ` ${why}` : ''}`,
  });
  // A disguise: Cover 1 or Cover 3 lined up as two deep, rotating at the snap. Off unless it's picked.
  const can = DISGUISES.includes(cv.id), on = can && state.def.disguise;
  chips(host, 'Disguise', [{ id: 'no', name: 'None' }, { id: 'yes', name: 'Show two deep' }], on ? 'yes' : 'no', id => set({ disguise: id === 'yes' }), {
    disabled: readonly || !can,
    blurb: !can ? 'Only Cover 1 and Cover 3 disguise here: they can line up two deep, the way Cover 4 does, and rotate a safety down at the snap.'
      : on ? `${cv.name} lines up two deep, the way Cover 4 does, with the corners 7 yards off. At the snap the free safety runs to the middle and the strong safety comes down${cv.id === 'c1' ? ', and the corners play their men from off the ball instead of pressed' : ''}.`
        : `${cv.name} lines up the way it plays. Or disguise it: show two deep, the way Cover 4 lines up, and rotate a safety down at the snap.`,
  });
}

// why: 'sit' when it's the situation that changed, for the chart's word on it.
function afterChange(why = '') {
  const focused = document.activeElement?.dataset.key; // a chip picked from the keyboard keeps the focus once it's drawn again
  // The chart is for the last call. One still on its first time round starts again for the new call; one that has
  // every row's first numbers up counts as finished, even while it's adding snaps: it stops and goes, with a word saying
  // why until it's run again. (Calling the other side is another chart altogether.)
  const k = state.side === 'O' ? 'off' : 'def', yours = !state.auto || !same(state[k], own[k]);
  const finished = chart && chart.rows.every(r => r.avg !== undefined);
  const rerun = chart && !finished && chart.side === state.side;
  const stale = chart ? finished && chart.side === state.side : redo?.side === state.side; // a finished one, or one gone already
  redo = stale ? { side: state.side, yours, sit: why === 'sit' } : null;
  // On a computer the result card at the top of the column goes, and the calls under it would jump up the screen, out
  // of sight if the page was scrolled down to them: they stay where they were instead, or as near as the page scrolls,
  // which brings them back to the top of the column.
  const held = wide.matches && !$('result').hidden ? $('mine').getBoundingClientRect().top : null;
  state.linked = false;
  linkNote = '';
  if (drill && state.side === 'D' && state.seen) rollTheirs(); // the run drill: a new run, hidden until the snap
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
  // In a drill the drill picks his call: his switch and New look go until it's over.
  $('newLook').hidden = $('theirsLook').hidden = !state.auto || !!drill;
  $('autoSwitch').hidden = !!drill;
  $('quiz').checked = state.quiz;
  $('askSwitch').hidden = !(state.auto && state.side === 'O') || !!drill;
  syncTheirs();
  renderDrills();
  renderSituation();
}

// The situation: a button for each down and distance, and what it means, for whichever side you call.
function renderSituation() {
  const host = $('sitChips'), sit = situation();
  host.textContent = '';
  for (const s of SITUATIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(s.id === sit.id));
    b.dataset.key = `Situation:${s.id}`;
    b.textContent = s.name;
    b.addEventListener('click', () => setSit(s.id));
    host.append(b);
  }
  rove(host);
  $('sitBlurb').textContent = sit.blurb + (state.auto && !drill ? ' The other coach\'s calls lean the same way.' : ''); // (a drill's are the drill's)
}
// A new down and distance. The other coach makes a new call for it, hidden until the snap as usual (see rollTheirs()),
// unless it's a drill's: a drill is five snaps in one situation, so a new one starts it over. The chart was for the
// last one.
function setSit(id) {
  if (!okSit(id) || id === state.sit) return;
  state.sit = id;
  if (drill) drill = { ...drill, n: 0, ok: 0, last: null };
  const repick = state.auto && !drill;
  if (repick) rollTheirs();
  afterChange('sit');
  const s = situation();
  setCaption(`${s.name}: ${drill ? 'the drill starts over.' : repick ? 'they\'ve changed their call.' : `${s.togo} yard${s.togo === 1 ? '' : 's'} to go.`}`);
}

function theirSummary() {
  if (state.side === 'O') {
    const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
    return `${fr.name}, ${covWords(state.def)}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? `, ${blitzWord(state.def)}` : ', rush four'}`;
  }
  // Where the strength is on the board as you see it: the defense's view is turned around, so their right is your left.
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  return `${fm.name}, strength to your ${state.off.flip ? 'right' : 'left'}, ${moving(state.off) ? `${motionWords(state.off)}, ` : ''}${playName(state.off)}`;
}

function syncTheirs() {
  const hint = $('theirsHint');
  renderAsk($('theirsAsk'), true);
  hint.hidden = asking() && !linkNote; // the question takes its place
  if (linkNote) { hint.textContent = linkNote; return; }
  if (!state.auto) {
    hint.textContent = state.linked ? 'A shared play: both calls are shown. Turn on "Let the other coach pick" to call your own.'
      : 'You\'re calling both sides. Turn on "Let the other coach pick" to be surprised.';
    return;
  }
  if (asking()) hint.textContent = '';
  else if (hidden()) hint.textContent = state.side === 'O'
    ? 'Hidden until the snap. Read their alignment: how many safeties are deep, how far off the corners are, how many defenders are in the box. Then call the play that beats it: change your play and they keep their call; change your personnel and they\'ll substitute.'
    : 'Hidden until the snap. You can see their formation; the play is a surprise. Read their personnel: two backs or two tight ends lean run, four receivers lean pass. Change your call to match it: they keep theirs.';
  else if (state.phase === 'pre') hint.textContent = `${state.book ? 'From the playbook' : 'Same call as last snap'}: ${theirSummary()}. New look gets you a new one.`;
  else hint.textContent = `They called: ${theirSummary()}.`;
}

function renderMatchup() {
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
  const dim = what => ` <span class="dim">· ${what} hidden</span>`;
  const mo = moving(state.off) ? ` · ${fm.motion.who} ${state.off.motion === 'jet' ? 'jet' : 'across'}` : '';
  const off = esc(fm.name) + (state.side === 'D' && hidden() ? dim('play') : `${esc(mo)} · ${esc(playShort(state.off))}`);
  const def = esc(fr.name) + (state.side === 'O' && hidden() ? dim('coverage') : ` · ${esc(cv.name)}${disguised(state.def) ? ' (disguised)' : ''}${cv.id !== 'c0' && state.def.pressure === 'blitz' ? ` · ${blitzWord(state.def).replace(/^\w/, c => c.toUpperCase())}` : ''}`);
  $('matchup').innerHTML = `${esc(situation().name)} · ${off}  vs  ${def}`;
}

for (const b of document.querySelectorAll('[data-side]')) b.addEventListener('click', () => {
  if (state.side === b.dataset.side) return;
  if (drill) { drill = null; state.auto = ownAuto; } // a drill is one side's
  drilled = null;
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

// ---------------------------------------------------------------- what did they play?

// Calling the offense with the other coach picking, a snap of a call you haven't seen asks what he played, with the
// five coverages as buttons, in his card and, at the whistle, in the coach's note's place: the note says what he played
// and why it mattered, so it waits for your answer, and so do his call on the board and in words. A change of your play
// keeps it waiting (he keeps his call); a new call from him (New look, new personnel) drops it. The answer says what
// gave it away. On this board every coverage lines up its own way, so the look tells (the safeties deep and how far
// off the corners are), unless it's a disguise: then what the safeties do at the snap does. A streak is kept on this
// device, and the switch in his card turns the question off.
$('quiz').addEventListener('change', e => {
  state.quiz = e.target.checked;
  save();
  if (!state.quiz && asking()) reveal(); // the question goes, and his call is out
});

// The question, or its answer, in its card (his, or the result's). In his card, how many you've named right in a row.
function renderAsk(host, theirs) {
  const open = asking(), done = state.auto && state.side === 'O' && state.ask?.guess;
  host.textContent = '';
  host.hidden = !open && !done;
  if (host.hidden) return;
  const p = (cls, text) => { const el = document.createElement('p'); el.className = cls; el.textContent = text; host.append(el); return el; };
  if (open) {
    p('ask-q', 'What did they play?');
    p('ask-how', theirs ? `Name their coverage from how they lined up (how many safeties were deep, how far off the corners were) and what the safeties did at the snap.${state.phase === 'pre' ? '' : ' Scrub back to the snap to see it again.'}`
      : `Name their coverage, in their call or here, and the note on how ${byId(PLAYS, state.off.play).name} does against it comes up.`);
    const row = document.createElement('div');
    row.className = 'chips';
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'What did they play?');
    for (const c of COVERAGES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = c.name;
      b.addEventListener('click', () => answer(c.id, host));
      row.append(b);
    }
    host.append(row);
  } else {
    const v = p('ask-verdict', '');
    v.tabIndex = -1;
    const [first, ...rest] = verdict(state.play, state.ask.guess).split(/(?<=:) /);
    v.innerHTML = `<b>${esc(first)}</b> ${esc(rest.join(' '))}`;
  }
  if (theirs) { const st = streakWords(); if (st) p('ask-streak', st); }
}
function streakWords() {
  const { streak, best } = state, right = state.ask?.guess === state.def.coverage;
  if (asking()) return streak ? `${streak} right in a row so far.` : '';
  if (right) return `${streak} right in a row.${best > streak ? ` Your best: ${best}.` : ''}`;
  return best ? `Your best: ${best} in a row.` : '';
}

// An answer: the streak, and then his call is out everywhere it was held back.
function answer(id, host) {
  if (!asking()) return;
  state.ask.guess = id;
  state.streak = id === state.def.coverage ? state.streak + 1 : 0;
  state.best = Math.max(state.best, state.streak);
  save();
  reveal();
  host.querySelector('.ask-verdict')?.focus({ preventScroll: true });
}
function reveal() {
  if (!state.quiz && asking()) state.ask = null;
  keepPlay();
  syncBoard();
  renderMatchup();
  syncTheirs();
  syncJobs();
  syncChart();
  if (board.selected >= 0) showWho(board.selected);
  if (state.phase === 'playing' || state.phase === 'paused') caption();
  if (!$('result').hidden && !$('result').classList.contains('stale')) showResult();
  draw();
  if (state.phase === 'pre' || !state.auto) return;
  say(`They called: ${theirSummary()}.`);
}

// ---------------------------------------------------------------- drills

// A drill: five snaps against one call from the other coach (DRILLS in js/playbook.js), counting the ones that work,
// and then a line from the coach's notes on what beats it. It takes his picking over: his call is the drill's, hidden
// until the first snap as usual, and your side is the drill's; you can change your own call between snaps. It's over
// after the fifth whistle, and Stop, the other side, a shared link, another drill or a part of his call put on the board
// from the playbook ends it sooner; his picking goes back to how you had it, with the drill's call as his. "What did
// they play?" isn't asked: the drill has said.
const DRILL_SNAPS = 5;
let drill = null; // the drill under way: { id, n, ok, last }, snaps seen to the whistle, how many worked, the last one's seed
// The drill just finished, for its debrief: { id, n, ok, last, sit }, with the situation it ran in, so what it counted
// is still said right after a new one is set.
let drilled = null;
const okDrill = (d, side) => {
  const D = d && DRILLS.find(x => x.id === d.id), whole = v => Number.isInteger(v) && v >= 0;
  return D && (side === undefined || D.side === side) && whole(d.n) && d.n <= DRILL_SNAPS && whole(d.ok) && d.ok <= d.n
    && (d.last == null || whole(d.last)) ? { id: d.id, n: d.n, ok: d.ok, last: d.last ?? null, ...(okSit(d.sit) ? { sit: d.sit } : {}) } : null;
};
// The situation a finished drill ran in (one kept before it was noted was in the situation it came back in).
const drillSit = d => byId(SITUATIONS, okSit(d?.sit) || state.sit);
// What counts: a success in the situation on offense (4 yards or more on 1st & 10, the first down on third down), a run
// held short of one on defense. A drill is five snaps in one situation (a new one starts it over: see setSit()).
const drillWorked = (D, res, sit) => (D.side === 'O' ? success(res, sit) : !success(res, sit));
function drillGoal(D, snap = false, sit = situation()) {
  const n = needed(sit), first = sit.down > 2;
  if (snap) return D.side === 'O' ? (first ? 'snap that makes the first down' : `snap that gains ${n} yards or more`) : (first ? 'run held short of the first down' : `run held under ${n} yards`);
  return D.side === 'O' ? (first ? 'made the first down' : `gained ${n} yards or more`) : (first ? 'held short of the first down' : `held under ${n} yards`);
}

// His call for the drill: its coverage and pressure, from the front he'd set against your personnel; or a run from its
// formation, to either side.
function drillCall() {
  const D = byId(DRILLS, drill.id);
  if (D.side === 'O') {
    const pers = byId(FORMATIONS, state.off.formation).personnel;
    state.def = { front: pers === '10' || pers === '11' ? 'nickel' : 'over', coverage: D.coverage, pressure: D.pressure, blitzer: 'M', disguise: false };
  } else {
    const R = rng(newSeed());
    state.off = { formation: D.formation, play: R.pick(PLAYS.filter(p => p.type === 'run')).id, flip: R() < 0.5, motion: 'none', hot: {} };
  }
}
function startDrill(id) {
  const D = byId(DRILLS, id), fromCard = $('drillNow').contains(document.activeElement);
  drilled = null;
  state.side = D.side;
  state.auto = true;
  if (D.side === 'O') state.off = { ...own.off }; else state.def = { ...own.def }; // your own call for that side
  drill = { id, n: 0, ok: 0, last: null };
  rollTheirs();
  afterChange();
  setCaption(`Drill: ${D.name}. Call ${D.side === 'O' ? 'a play' : 'a defense'}, then Snap.`);
  if (fromCard) toDrills(); // Run it again goes with the card it was in
}
function endDrill() {
  drill = null;
  state.auto = ownAuto;
  // Calling both sides, the drill's call is now his on your board, so it's kept as yours for his side, and a reload
  // brings it back (with how the drill went) rather than the call you had before.
  keepOwn();
  save();
  renderChoosers();
  syncBoard();
  renderMatchup();
  syncJobs();
  syncChart();
  draw();
  keepPlay();
}
// At the whistle (played out or scrubbed to the end), a snap of the drill counts once.
function tallyDrill() {
  if (!drill || drill.last === state.seed) return;
  drill.last = state.seed;
  drill.n++;
  const D = byId(DRILLS, drill.id);
  if (drillWorked(D, state.play.result, state.play.sit)) drill.ok++;
  drillNews = `${D.name}: ${drill.ok} of ${drill.n} ${drill.n < DRILL_SNAPS ? `snaps so far ${drillGoal(D)}` : `${drillGoal(D)}, and the coach has a word on it`}.`;
  if (drill.n >= DRILL_SNAPS) { drilled = { ...drill, sit: state.play.sit.id }; endDrill(); } else renderDrills();
  keepPlay();
}
// What a screen reader hears of the count, with the end of the play (see sayResult()).
let drillNews = '';

// The drills card: a button for each drill (pressed while it's under way), and under them where it's up to, or how the
// last one went and the coach's line on it.
for (const D of DRILLS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.dataset.drill = D.id;
  b.textContent = D.name;
  b.addEventListener('click', () => startDrill(D.id));
  $('drillChips').append(b);
}
function renderDrills() {
  for (const b of $('drillChips').children) b.setAttribute('aria-pressed', String(drill?.id === b.dataset.drill));
  const host = $('drillNow'), on = drill || drilled;
  $('drillsHint').hidden = !!on;
  host.hidden = !on;
  host.textContent = '';
  if (!on) return;
  const D = byId(DRILLS, on.id);
  const p = (cls, html) => { const el = document.createElement('p'); el.className = cls; el.innerHTML = html; host.append(el); return el; };
  const button = (text, act) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost'; b.textContent = text; b.addEventListener('click', act); return b; };
  const row = document.createElement('div');
  row.className = 'actions';
  if (drill) {
    p('drill-brief', `<b>${esc(D.name)}.</b> ${esc(D.brief)} On ${esc(situation().name)}, a ${drillGoal(D, true)} counts.`);
    p('drill-count', drill.n ? `${drill.n} of ${DRILL_SNAPS} snaps: ${drill.ok} ${drillGoal(D)}.` : `Snap 1 of ${DRILL_SNAPS}.`);
    row.append(button('Stop the drill', () => { endDrill(); toDrills(); }));
  } else {
    // (in the situation it ran in, named once another is set)
    const ran = drillSit(drilled);
    p('drill-count', `<b>${esc(D.name)}${ran.id === state.sit ? '' : ` on ${esc(ran.name)}`}: ${drilled.ok} of ${drilled.n} ${drillGoal(D, false, ran)}.</b>`);
    p('drill-note', esc(D.note));
    row.append(button('Run it again', () => startDrill(D.id)), button('Done', () => { drilled = null; renderDrills(); keepPlay(); toDrills(); }));
  }
  host.append(row);
}
// The focus, from a button that goes, to the drill buttons.
const toDrills = () => ($('drillChips').querySelector('[aria-pressed="true"]') || $('drillChips').firstElementChild)?.focus({ preventScroll: true });

// What their look was before the snap: how many safeties were deep (as the board counts them, past 10 and a half yards)
// and how far off the nearer corner stood, in the bands the corners' read uses (see coachNote()).
function shell(players, high) {
  const corner = Math.min(...players.filter(p => p.label === 'CB').map(p => p.y));
  return { deep: high, corners: corner < 2.5 ? 'press' : corner < 6 ? 'five' : 'deep' };
}
const DEEP = ['nobody deep', 'one deep', 'two deep'];
const DEEP_WAS = ['nobody was deep', 'one safety was deep', 'two safeties were deep'];
const CORNERS = { press: 'the corners pressed', five: 'the corners about 5 yards off', deep: 'the corners 7 yards or more off' };
const CORNERS_WAS = { press: 'the corners were pressed', five: 'the corners sat about 5 yards off', deep: 'the corners sat 7 yards or more off' };
// "Right: two deep and the corners about 5 yards off, Cover 2.", or what told it from the one you named, which is how
// that one lines up against the same offense on the board.
// A disguise lined up like Cover 4, so the answer is in what the safeties and the corners did at the snap.
function verdict(P, guess) {
  const cv = byId(COVERAGES, P.call.coverage), was = shell(P.players, P.box.high);
  if (disguised(P.call)) {
    const three = cv.id === 'c3', did = c3 => (c3 ? 'dropped into deep thirds' : 'ran with their receivers');
    const then = `the strong safety rotated down at the snap and the corners ${did(three)}`;
    if (guess === cv.id) return `Right: it showed two deep, then ${then}: ${cv.name}.`;
    const other = guess === (three ? 'c1' : 'c3') ? ` In ${byId(COVERAGES, guess).name} they'd have ${did(!three)}.` : '';
    return `It was ${cv.name}, disguised: it showed ${DEEP[was.deep]} and ${CORNERS[was.corners]}, the way Cover 4 lines up, then ${then}.${other}`;
  }
  if (guess === cv.id) return `Right: ${DEEP[was.deep]} and ${CORNERS[was.corners]}, ${cv.name}.`;
  // (what the one you named looks like is its honest look: a disguise is the other coach's to pick)
  const g = byId(COVERAGES, guess), S = prepare({ ...P.call, coverage: guess, disguise: false }, P.seed), would = shell(S.P, S.box.high);
  const deep = would.deep === was.deep, corners = would.corners === was.corners;
  if (deep && corners) return `It was ${cv.name}, though it lined up like ${g.name}: ${DEEP[was.deep]} and ${CORNERS[was.corners]}.`;
  if (deep) return `It was ${cv.name}: ${DEEP[was.deep]}, but ${CORNERS_WAS[was.corners]}. ${g.name} has ${CORNERS[would.corners]}.`;
  if (corners) return `It was ${cv.name}: ${CORNERS_WAS[was.corners]}, but ${DEEP_WAS[was.deep]}. ${g.name} has ${DEEP[would.deep]}.`;
  return `It was ${cv.name}: ${DEEP[was.deep]} and ${CORNERS[was.corners]}. ${g.name} has ${DEEP[would.deep]} and ${CORNERS[would.corners]}.`;
}

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
    const at = p => P.frames[0].xy[2 * p.i], deep = p => Math.abs(P.frames[0].xy[2 * p.i + 1]); // as they line up
    const men = P.players.filter(p => p.team === team).sort((a, b) => board.sx(at(a)) - board.sx(at(b)) || deep(a) - deep(b));
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
    + (hidden() ? ` Their jobs stay hidden until ${asking() ? 'you name their coverage' : 'the snap'}, as on the board.` : '');
}

// The board in words, as the teams line up: the down and the line to gain, the formation, where the receivers and the
// backs are, and then what the defense shows: the safeties deep, the box count and the corners. Left and right are the
// board's, as it's shown.
function boardWords(P) {
  const fm = byId(FORMATIONS, P.call.formation);
  const lr = sd => ((sd > 0) !== board.flip ? 'right' : 'left'); // sd: the offense's right (+1) or left (-1)
  const strong = P.call.flip ? -1 : 1;
  const many = (n, one, more) => (n === 1 ? `a ${one}` : `${COUNT[n] || n} ${more}`);
  const lined = p => P.frames[0].xy[2 * p.i]; // where he lines up (with motion, before he goes)
  const side = sd => {
    const on = P.players.filter(p => p.team === 'O' && Math.sign(lined(p)) === sd);
    const parts = [[on.filter(p => p.cls === 'te').length, 'tight end', 'tight ends'], [on.filter(p => p.cls === 'wr').length, 'receiver', 'receivers']];
    return parts.filter(([n]) => n).map(([n, one, more]) => many(n, one, more)).join(' and ') || 'nobody';
  };
  const sides = side(strong) === side(-strong) ? `${side(strong)} each side` : `${side(strong)} ${lr(strong)}, ${side(-strong)} ${lr(-strong)}`;
  const backs = P.players.filter(p => p.cls === 'rb' || p.cls === 'fb').length;
  const backfield = fm.under ? `the quarterback under center, ${many(backs, 'back', 'backs')} behind him` : !backs ? 'the quarterback in the shotgun, nobody in the backfield' : `the quarterback in the shotgun, ${many(backs, 'back', 'backs')} ${fm.players.some(([, x, , c]) => c === 'rb' && !x) ? 'behind' : 'beside'} him`;
  const high = P.box.high, deep = high >= 2 ? `${COUNT[high]} safeties deep` : high === 1 ? 'one safety deep' : 'nobody deep';
  const depth = y => (y < 2.5 ? 'pressed' : y < 6 ? 'about 5 yards off' : '7 yards or more off'); // as the corners' read says
  const cbs = P.players.filter(p => p.label === 'CB').map(p => depth(p.y));
  const corners = cbs.length === 2 && cbs[0] === cbs[1] ? `both corners ${cbs[0]}` : cbs.map((d, k) => `${k ? 'the other' : 'one corner'} ${d}`).join(', ');
  // His motion, where it's yours or both calls are shown: the other coach's is part of his play, hidden until the snap.
  // (across to the side he didn't line up on: at the snap a jet man is still short of the middle, on his first side)
  const mover = P.motion && P.players[P.motion.who];
  const m = P.motion && (state.side === 'O' || !state.auto) ? ` Before the snap the ${mover.label} goes in ${P.motion.kind === 'jet' ? 'jet motion' : 'motion'} across to the ${lr(-Math.sign(lined(mover)) || 1)}.` : '';
  // (the down first, with the yellow line's distance, as the board draws it)
  const line = `${P.sit.name}, the line to gain ${P.sit.togo} yard${P.sit.togo === 1 ? '' : 's'} up the field.`;
  return `${line} ${fm.name}, strong ${lr(strong)}: ${sides}; ${backfield}.${m} The defense${P.motion ? ' at the snap' : ''}: ${deep}, ${P.box.box} in the box against ${P.box.blockers} blockers, ${corners}.`;
}

// ---------------------------------------------------------------- the result

// Whole yards, as the headline says them. The simulator spots the ball to the half yard, and a half rounds away from
// zero, so a 3.5-yard run is a gain of 4 and a success in the headline, the verdict over it and the chart alike.
const gained = res => Math.sign(res.yards) * Math.round(Math.abs(res.yards));
// A success by the down (sit, one of SITUATIONS): a run or a catch that gains 40% of the yards to go on first down, 60%
// on second, and all of them on third and fourth, in whole yards. On 1st & 10 that's 4.
const carried = res => res.kind === 'run' || res.kind === 'catch';
const success = (res, sit) => carried(res) && gained(res) >= needed(sit);
// The verdict over the headline, and which side's colour it's in. A big play is a run of 10 yards or more or a catch of
// 20 or more (see "Big play" in the playbook), and a gain short of a success counts for the defense, which looks like a
// mistake unless it says why: short of the yards that make it one, or on third down of the first down. On fourth down
// anything short of the first down hands the ball over.
const bigPlay = (res, sit) => success(res, sit) && gained(res) >= (res.kind === 'run' ? 10 : 20);
function kicker(res, sit) {
  const n = gained(res);
  if (res.kind === 'int') return ['A takeaway for the defense', 'D'];
  if (success(res, sit)) return [bigPlay(res, sit) ? 'A big play for the offense' : 'A win for the offense', 'O'];
  if (sit.down === 4) return ['A win for the defense: a turnover on downs', 'D'];
  if (carried(res) && n >= 0) return [sit.down === 3 ? 'A win for the defense: short of the first down' : `A win for the defense: short of the ${needed(sit)}\u00a0yards that make a play a success`, 'D'];
  return ['A win for the defense', 'D'];
}

// What's written in marker on the board at the whistle (see Board.endMark()), the yards as the headline counts them:
// "+17", "−3", "Sack −7", "Incomplete", "Picked off". A big play's is written bigger, and it's in the colour of the
// side that won the play, as the verdict over the headline is.
function endMark(res, sit) {
  const n = gained(res);
  const text = { incomplete: 'Incomplete', throwaway: 'Thrown away', int: 'Picked off' }[res.kind]
    || (res.kind === 'sack' ? (n ? `Sack −${-n}` : 'Sack') : res.long ? `${Math.min(n, 60)}+` : n > 0 ? `+${n}` : n < 0 ? `−${-n}` : 'No gain');
  return { text, big: bigPlay(res, sit), win: kicker(res, sit)[1] };
}

// The headline: how far it went, and against the yellow line, how far short of it or that it got there. Short, for the
// button on the board, where the whole of it would be cut off on a phone: "Gain of 6, 2 short", "Gain of 12, first down".
function headline(res, sit, short = false) {
  const n = Math.abs(gained(res)), g = gained(res);
  const yd = v => `${v} yard${v === 1 ? '' : 's'}`;
  switch (res.kind) {
    case 'incomplete': return 'Incomplete';
    case 'int': return 'Intercepted';
    case 'throwaway': return 'Thrown away';
    case 'sack': return n ? `Sacked for a loss of ${yd(n)}` : 'Sacked at the line';
    default:
      if (res.long) return short ? `Gain of ${Math.min(n, 60)}+${g >= sit.togo ? ', first down' : ''}` : `Gain of ${Math.min(n, 60)}+ yards${g >= sit.togo ? ' and a first down' : ''}`; // still running when the board stopped counting
      if (g > 0 && short) return `Gain of ${n}, ${g >= sit.togo ? 'first down' : `${sit.togo - g} short`}`;
      if (g > 0) return g >= sit.togo ? `Gain of ${yd(n)} and a first down` : `Gain of ${yd(n)}, ${sit.togo - g} short of the first down`;
      return g < 0 ? `Loss of ${yd(n)}` : 'No gain';
  }
}

function showResult() {
  const P = state.play, res = P.result;
  [$('resKicker').textContent, $('resKicker').dataset.win] = kicker(res, P.sit);
  $('resHead').textContent = headline(res, P.sit);
  const fm = byId(FORMATIONS, state.off.formation), pl = byId(PLAYS, state.off.play);
  const fr = byId(FRONTS, state.def.front), cv = byId(COVERAGES, state.def.coverage);
  // (While you're asked what they played, the coverage waits: Cover 0 is said as a blitz, as it is.)
  const blitz = state.def.pressure === 'blitz' || cv.id === 'c0';
  const from = `On ${P.sit.name}, ${playName(state.off)} from ${fm.name}${moving(state.off) ? `, ${motionWords(state.off)},` : ''}`;
  const bw = cv.id === 'c0' ? 'blitz' : blitzWord(state.def);
  $('resVs').textContent = asking() ? `${from} against ${fr.name}${blitz ? ` with a ${bw}` : ''}.`
    : `${from} against ${fr.name}, ${covWords(state.def)}${cv.id === 'c0' ? '' : blitz ? ` with a ${bw}` : ''}.${typicalNote()}`;
  $('resVer').textContent = versionNote();
  $('resVer').hidden = !$('resVer').textContent;
  // Each line's time is a button that watches that moment again on the board (see replay()).
  const story = $('story');
  story.textContent = '';
  for (const e of P.events) {
    const li = document.createElement('li'), b = document.createElement('button'), at = clock(e.t);
    b.type = 'button';
    b.className = 't';
    b.textContent = at;
    b.setAttribute('aria-label', `${e.t < -0.049 ? `${(-e.t).toFixed(1)} seconds before the snap` : at}: watch it again`);
    b.addEventListener('click', () => replay(e));
    const text = document.createElement('span');
    text.textContent = words(e);
    li.append(b, text);
    story.append(li);
  }
  // The note says what they played, so while you're asked, the question is in its place.
  const { lead, note, now, reads } = coachNote(P);
  $('note').innerHTML = `<b>${esc(lead)}</b> ${esc(note)}`;
  $('noteNow').innerHTML = `<b>This time:</b> ${esc(now)}`;
  const ul = $('reads');
  ul.textContent = '';
  for (const r of reads) { const li = document.createElement('li'); li.textContent = r; ul.append(li); }
  for (const id of ['note', 'noteNow', 'reads']) $(id).hidden = asking();
  renderAsk($('noteAsk'), false);
  resetShare();
  // In a drill, where it's up to; after its last snap, how it went, for a computer, where the drills are down the column.
  const D = byId(DRILLS, (drill || drilled)?.id);
  $('actionsNote').textContent = drill ? `Snap again: the next snap of the drill${state.side === 'D' ? ', a new run' : ''}. ${drill.n} of ${DRILL_SNAPS} snaps so far: ${drill.ok} ${drillGoal(D)}.`
    : `${drilled?.last === state.seed ? `That was the drill's last snap: ${drilled.ok} of ${drilled.n} ${drillGoal(D, false, drillSit(drilled))}. The coach's word on it is in Drills. ` : ''}Snap again: the same two calls, played out fresh.${state.auto ? ' New look: the other coach changes his call.' : ''}`;
  $('result').hidden = false;
  staleResult(false);
  syncTheirs();
}

function coachNote(P) {
  const pl = byId(PLAYS, state.off.play), cv = byId(COVERAGES, state.def.coverage);
  const reads = [];
  const high = P.box.high, mask = disguised(P.call);
  // A disguise showed two deep and played one deep: the look, and then what the safeties did at the snap.
  reads.push(mask ? `Safeties: showed two deep, played ${cv.name}. The strong safety rotated down at the snap, and the free safety went to the middle.`
    : high >= 2 ? 'Safeties: two deep before the snap, a Cover 2 or Cover 4 look.' : high === 1 ? 'Safeties: one deep in the middle, a Cover 1 or Cover 3 look.' : 'Safeties: nobody deep. Expect man coverage and a blitz.');
  // How far off the corners stood before the snap: on this board they're pressed in man coverage, about 5 yards off in
  // Cover 2 and 7 or more in Cover 3 and 4 (see the corners' depths in js/sim.js), so this and the safeties name it,
  // unless it's a disguise: a disguised Cover 1's corners stand 7 off and play man from there.
  const corner = Math.min(...P.players.filter(p => p.label === 'CB').map(p => p.y));
  reads.push(mask && cv.id === 'c1' ? 'Corners: 7 yards or more off, as if to drop deep, but they played their men from there: part of the disguise.'
    : corner < 2.5 ? 'Corners: pressed up on the receivers. Corners press in man coverage.'
      : corner < 6 ? 'Corners: about 5 yards off and outside the receivers. Cover 2 corners sit there to take the flat.'
        : 'Corners: 7 yards or more off. They drop deep, to a third or a quarter of the field.');
  // Motion: who went with him, which says man or zone.
  if (P.motion) {
    const m = P.motion, who = P.players[m.who].label;
    reads.push(m.man >= 0 ? `Motion: ${nm(P, m.man).replace(/^a corner$/, 'a cornerback')} ran with the ${who}. Someone running with a man in motion means man coverage.${m.bump >= 0 ? ' And the strong safety slid over to the side the cornerback left, to keep a run inside there: the bump.' : ''}`
      : `Motion: nobody ran with the ${who}; the defense only slid over. That means zone.`);
  }
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
  const note = (pl.type === 'pass' ? NOTES[pl.id][cv.id] : RUN_NOTES[pl.id] + backEnd) + (mask ? ` ${DISGUISE_NOTES[pl.type === 'run' ? 'run' : cv.id]}` : '') + motionNote(P) + hotNote(P);
  return { lead, note, now: thisTime(P), reads };
}

// With motion the note is about the play, and the play was run from the count once he'd gone: said, so the note isn't
// read as being about the formation as it lined up.
function motionNote(P) {
  if (!P.motion || byId(PLAYS, P.call.play).type !== 'pass') return '';
  const who = P.players[P.motion.who], word = n => ['no', 'one', 'two', 'three', 'four'][n];
  const to = byId(FORMATIONS, P.call.formation).motion.to * (P.call.flip ? -1 : 1); // where he's counted (a jet man is still crossing)
  const n = sd => P.players.filter(p => p.team === 'O' && (p.cls === 'wr' || p.cls === 'te') && Math.sign(p === who ? to : p.x) === sd).length;
  const a = n(1), b = n(-1);
  return ` Here the ${who.label} went in motion first, and the play was run from where the receivers stood then: ${a === b ? `${word(a)} each side` : `${word(Math.max(a, b))} on one side and ${word(Math.min(a, b))} on the other`}.`;
}

// The note is about the play as it's drawn: with hot routes, it says this one wasn't, and where to see how yours does.
function hotNote(P) {
  const o = { ...P.call, hot: okHot(P.call.hot, P.call.formation, P.call.play) };
  if (!hotList(o).length) return '';
  return ` That's ${byId(PLAYS, o.play).name} as it's drawn; yours had ${hotWords(o)}, so it can go another way. Run it 100 times each to see how your version does against every coverage.`;
}

// What a disguise changes, after the note on the coverage it is: what the board shows over many snaps against the
// disguised Cover 1 and Cover 3 next to the honest ones (the safety's late start helps the runs; the disguised Cover 1's
// off corners take away the deep throws, while Mesh and the RB Screen find more room).
const DISGUISE_NOTES = {
  run: 'Disguised, the strong safety starts 12 yards deep and has to come down at the snap: one fewer defender near the line when the ball is handed off.',
  c1: 'Disguised, the corners play their men from 7 yards off instead of pressed: the deep throws are harder, the crossing routes and the screen find room in front of them, and the strong safety comes down late.',
  c3: 'Disguised, the strong safety starts deep and has to come down at the snap, so he\'s late to his zone underneath.',
};

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
    // (the quarterback's line, which counts them, not the one after it as it lands)
    const passed = E.find(e => e.kind === 'away' && e.passed !== undefined)?.passed || 0;
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
  if (res.kind === 'catch') came = res.long ? `, and it went for ${Math.min(n, 60)}+ yards` : success(res, P.sit) ? `, and it went for ${yd(n)}` : n > 0 ? `, but it went for only ${yd(n)}` : n < 0 ? `, but he was dropped for a loss of ${yd(-n)}` : ', but it went for no gain';
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

// On a phone or a tablet (a touch screen first) that has a share sheet, the link goes out through it, to Messages,
// WhatsApp, Mail or wherever the person picks. On a computer, or a phone without one, it's copied, and where it can't
// be copied it's put up, ready to copy by hand. A sheet that won't open falls back to copying too.
const SHEET = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches;
if (SHEET) $('share').textContent = 'Share this play';
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
  const code = [state.side, c.formation, c.play, c.flip ? 1 : 0, c.front, c.coverage, c.pressure === 'blitz' && blitzer(c) !== 'M' ? `blitz${blitzer(c)}` : c.pressure, state.seed, c.disguise ? 1 : 0, moving(c) ? c.motion : 'none', hotCode(state.off), state.sit, `v${SIM_VERSION}`].filter(x => x !== '').join('.');
  const base = document.documentElement.hasAttribute('data-single') || location.protocol === 'file:' ? SITE : location.href.split('#')[0];
  const url = `${base}#p=${code}`;
  resetShare();
  if (SHEET) {
    try {
      await navigator.share({ title: document.title, url });
      return;
    } catch (e) {
      if (e?.name === 'AbortError') return; // the sheet closed without sharing: nothing to say
    }
  }
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

// A play link in the address (#p=side.formation.play.flip.front.coverage.pressure.seed.disguise.motion.hot.situation.version;
// the pressure is "four", "blitz" for the Mike's, or "blitz" and who for another's: "blitzW", "blitzNB", "blitzSS"):
// 'ok' once it's set up, 'bad' for one cut short or garbled, 'unknown' for a formation, play, front, coverage, hot route
// or situation this version doesn't have (the address is cleared either way), '' when there's none. A link from before
// there were disguises ends at the seed, one from before motion at the disguise, one from before downs at the hot
// routes, and one with no hot routes goes from the motion to the situation: they open without them, and one from before
// downs is on 1st & 10, as the board was then. The hot routes are each man's label and his route, run together
// ("HslantRBblock"); the situation is the down, "and", and the yards to go ("3and8"). The version is the simulator's
// (SIM_VERSION in js/sim.js), "v" and the number ("v1"), always last; a link from before there were versions has none,
// and counts as version 1.
let linkNote = '';
// A link made with another version of the simulator: its version, and the snap it's for (its seed and the calls), for
// the result card to say so while that snap is the one shown (see versionNote()).
let linkFrom = null;
function fromLink() {
  let hash = location.hash;
  if (!hash.startsWith('#p=')) return '';
  history.replaceState(null, '', location.pathname + location.search);
  const v = hash.match(/\.v(\d+)\b/), ver = v ? +v[1] : 1;
  if (v) hash = hash.slice(0, v.index);
  const m = hash.match(/p=([OD])\.(\w+)\.(\w+)\.([01])\.(\w+)\.(\w+)\.(\w+)\.(\d+)(?:\.([01])(?:\.(\w+)(?:\.([A-Za-z]+))?(?:\.(\d+and\d+))?)?)?/);
  if (!m) return 'bad';
  const [, side, formation, playId, flip, front, coverage, pressure, seed, disguise, motion, code = '', sit = '1and10'] = m;
  if ((motion && !MOTIONS.includes(motion)) || !okSit(sit)) return 'unknown';
  if (!FORMATIONS.some(f => f.id === formation) || !PLAYS.some(p => p.id === playId) || !FRONTS.some(f => f.id === front) || !COVERAGES.some(c => c.id === coverage)) return 'unknown';
  if (cantCall(formation, playId)) return 'unknown'; // (a run from Empty: no link the board makes has one)
  const given = [...code.matchAll(/([A-Z]+)([a-z]+)/g)], hot = okHot(Object.fromEntries(given.map(([, who, r]) => [who, r])), formation, playId);
  if (given.map(g => g[0]).join('') !== code || Object.keys(hot).length !== given.length) return 'unknown';
  Object.assign(state, { side, sit, auto: false, linked: true, ask: null, seed: +seed >>> 0 });
  drill = drilled = null;
  state.off = { formation, play: playId, flip: flip === '1', motion: motion || 'none', hot };
  const who = pressure.match(/^blitz(W|NB|SS)?$/);
  state.def = { front, coverage, pressure: who ? 'blitz' : 'four', blitzer: who?.[1] || 'M', disguise: disguise === '1' };
  linkNote = '';
  linkFrom = ver === SIM_VERSION ? null : { ver, seed: state.seed, call: JSON.stringify(call()) };
  return 'ok';
}
// What the result card says of a link made with another version, while its snap is the one on the board: the same
// calls and the same roll of the dice can come out differently through another simulator.
function versionNote() {
  if (!linkFrom || linkFrom.seed !== state.seed || linkFrom.call !== JSON.stringify(call())) return '';
  return linkFrom.ver < SIM_VERSION
    ? 'Made with an earlier version of Chalk Talk: the same calls and the same roll of the dice, but the simulator has changed, so this snap may not play out as it did for whoever sent it.'
    : 'Made with a newer version of Chalk Talk: the same calls and the same roll of the dice, but this copy has an older simulator, so this snap may not play out as it did for whoever sent it.';
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
// Each row counts its snaps as they're run (n, yds, ok), and keeps each one's seed, strong side and gain (snaps), so it
// can play a typical one again (see watchTypical()). Its bar shows avg and rate as they stood when it last finished a
// time round, `of` snaps in, so a row drawn again part way (at the snap, to mark their call) says what its numbers come
// from.
let chart = null; // the rows of the last run: { rows: [{ id, name, call, n, yds, ok, snaps, avg, rate, of }], pressure, side }
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
// Before a run, the rows it will fill: every coverage (or every play his formation can run, calling the defense), each
// with an empty track.
function drawIdle() {
  const host = $('bars');
  host.innerHTML = '<div class="bar-head" aria-hidden="true">success · avg yards</div>';
  for (const r of state.side === 'O' ? COVERAGES : PLAYS.filter(p => !cantCall(state.off.formation, p.id))) {
    const row = document.createElement('div');
    row.className = 'bar-row idle';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-label', `${r.name}: not run yet`);
    row.innerHTML = `<span class="bar-name"><span>${esc(r.name)}</span></span><span class="bar-track idle"></span><span class="bar-val">–</span>`;
    host.append(row);
  }
}

// Before the snap the offense's chart can't use the other coach's real pressure without giving it away, so every
// coverage gets a four-man rush (Cover 0 always blitzes) until the call is out, and no disguise. Once it's out, a
// disguise is his for Cover 1 and Cover 3 alike, as his pressure is for every row.
// The bars are the success rate: a few long runs after the catch swing the average yards a lot (one row can average 20
// yards a play while its typical snap is an incompletion), so the average is the small number beside each bar.
function chartHint() {
  // the formation, and the motion when it's yours, or his and out (before then his chart's plays have none)
  const off = { ...state.off, motion: chart ? chart.motion : state.side === 'O' || !hidden() ? state.off.motion : 'none' };
  const fm = `${byId(FORMATIONS, off.formation).name}${moving(off) ? ` with ${motionWords(off)}` : ''}`;
  // (calling both sides, with routes changed: those are for that one play, and the rest are run as drawn; see runChart())
  const changed = hotList(state.off).length ? `: ${byId(PLAYS, state.off.play).name} as you changed it (${hotWords(state.off)}), the rest as drawn` : '';
  // what a success is on this down (see success())
  const sit = chart ? chart.sit : situation(), n = needed(sit);
  const goal = `on ${sit.name}, ${sit.down > 2 ? `making the first down (${sit.togo} yard${sit.togo === 1 ? '' : 's'})` : `gaining ${n} yards or more`}`;
  if (state.side === 'D') return `How often each play from ${fm} succeeds against your defense ${goal}${changed}. Beside each bar, the average yards a play you allow.${tapRow()}${again()}`;
  const pressure = chart ? chart.pressure : hidden() ? 'four' : state.def.pressure, mask = chart ? chart.disguise : !hidden() && state.def.disguise;
  const who = chart ? chart.blitzer : chartBlitzer(state.def), bw = { M: 'blitz', W: 'Will blitz', NB: 'nickel blitz', SS: 'safety blitz' }[who] || 'blitz';
  const yours = hotList(state.off).length ? `your version of ${byId(PLAYS, state.off.play).name} (${hotWords(state.off)})` : 'your play';
  return `How often ${yours} succeeds ${goal}, from ${fm} against a ${byId(FRONTS, state.def.front).name} front ${pressure === 'blitz' ? `with a ${bw}${who === 'SS' ? ', the Mike\'s in Cover 2 and Cover 4, where both safeties play deep' : ''}` : 'rushing four (Cover 0 always blitzes)'}${mask ? ', with Cover 1 and Cover 3 disguised as two deep' : ''}.`
    + ` Beside each bar, the average yards a play.${hidden() ? ` Their real call stays hidden until ${asking() ? 'you name their coverage' : 'the snap'}.` : ''}${tapRow()}${again()}`;
}
// Once a row has its numbers, it can be tapped.
const tapRow = () => (chart?.rows.some(r => r.avg !== undefined) ? ' Tap a row to watch a typical snap of it.' : '');
function again() {
  if (!redo) return '';
  const cv = byId(COVERAGES, state.def.coverage);
  const mine = state.side === 'O' ? byId(PLAYS, state.off.play).name
    : `${byId(FRONTS, state.def.front).name}, ${covWords(state.def)}${cv.id === 'c0' ? '' : state.def.pressure === 'blitz' ? `, ${blitzWord(state.def)}` : ', rush four'}`;
  if (redo.sit) return ` The situation changed. Run it again for ${mine} on ${situation().name}.`;
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
  if (state.side === 'O' && hidden()) Object.assign(base, { pressure: 'four', disguise: false });
  if (state.side === 'D' && hidden()) base.motion = 'none'; // his motion is part of his hidden play
  const rows = (state.side === 'O'
    ? COVERAGES.map(c => ({ id: c.id, name: c.name, call: { ...base, coverage: c.id } }))
    : PLAYS.filter(p => !cantCall(base.formation, p.id)).map(p => ({ id: p.id, name: p.name, call: { ...base, play: p.id, hot: p.id === base.play ? base.hot : {} } }))).map(r => ({ ...r, n: 0, yds: 0, ok: 0, snaps: [] })); // (routes changed on one play aren't the others'; from Empty, no runs)
  const sit = situation();
  chart = { rows, pressure: base.pressure, blitzer: base.pressure === 'blitz' ? chartBlitzer(base) : 'M', disguise: !!base.disguise, motion: moving(base) ? base.motion : 'none', side: state.side, sit };
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
        const flip = r.n % 2 === 1, seed = newSeed(), res = simulate({ ...r.call, flip }, seed).result;
        r.n++; r.yds += res.yards; if (success(res, sit)) r.ok++;
        r.snaps.push({ seed, flip, yards: res.yards });
      }
      r.avg = r.yds / r.n; r.rate = r.ok / r.n; r.of = r.n;
      syncChart(); // (its hint says a row can be tapped once one has numbers)
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
  const focused = host.contains(document.activeElement) ? document.activeElement.dataset.row : null;
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
    // A row with its numbers up is a button that plays a typical snap of it (see watchTypical()).
    row.className = 'bar-item';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bar-row' + (mine ? ' mine' : '');
    b.dataset.row = r.id;
    const pct = Math.round(r.rate * 100), tenths = Math.round(r.avg * 10) / 10, avg = `${tenths < 0 ? '−' : ''}${Math.abs(tenths).toFixed(1)}`;
    b.innerHTML = `${name}
      <span class="bar-track"><span class="bar" data-id="${esc(r.id)}"></span></span>
      <span class="bar-val">${pct}% <small>${avg}</small></span>`;
    const bar = b.querySelector('.bar'), from = was.get(r.id);
    b.title = `${r.name}${mine ? ` (${tag})` : ''}: ${pct}% successful, ${avg} yards a play, over ${r.of} snaps`;
    b.setAttribute('aria-label', `${b.title}. ${typicalWords(r)}`);
    b.addEventListener('click', () => watchTypical(r));
    row.append(b);
    if (from) { bar.style.width = from; bar.getBoundingClientRect(); } // from where it was, then on
    bar.style.width = `${Math.max(0.6, r.rate * 100)}%`;
  }
  if (focused) host.querySelector(`[data-row="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true }); // drawn again as snaps come in
}
$('runChart').addEventListener('click', runChart);

// A row of the chart, tapped: a typical snap of it on the board. The other side's call becomes that row's, "Let the
// other coach pick" goes off (both calls are yours now, so a drill under way ends), and the snap the board plays is the
// middle one by yards gained of the row's snaps with the strong side the board has: the one its numbers mean. The chart
// stays up, with that row marked as this call; the result card says which snap it was.
const typicalWords = r => (chart.side === 'O' ? `Watch a typical snap against ${r.name}.` : `Watch a typical snap of ${r.name}.`);
let typical = null; // the snap last played that way: { seed, call, n, name }, for the result card
function watchTypical(r) {
  const flip = state.off.flip, mine = r.snaps.filter(x => x.flip === flip);
  if (!mine.length) return;
  const mid = mine.slice().sort((a, b) => a.yards - b.yards)[(mine.length - 1) >> 1];
  if (drill) drill = null;
  state.auto = ownAuto = false;
  Object.assign(state, { linked: false, ask: null, seed: mid.seed });
  linkNote = '';
  state.off = { ...okOff(r.call), flip };
  state.def = okDef(r.call);
  keepOwn();
  save();
  renderChoosers();
  lineUp();
  typical = { seed: mid.seed, call: JSON.stringify(call()), n: mine.length, name: r.name };
  syncChart();
  toSnap();
  const b = $('board').getBoundingClientRect();
  if (b.top < 0 || b.bottom > innerHeight) $('board').scrollIntoView({ block: 'nearest', behavior: smooth() });
  play();
  say(`${typicalWords(r).replace(/^Watch a/, 'A')} Both calls are yours now.`);
}
// What the result card says of a typical snap from the chart.
function typicalNote() {
  if (!typical || typical.seed !== state.seed || typical.call !== JSON.stringify(call())) return '';
  return ` A typical snap from the chart: of its ${typical.n} snaps ${state.side === 'O' ? `against ${typical.name}` : `of ${typical.name}`} with the strength on this side, the middle one by yards gained.`;
}

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
  // A row can end with what it shows on the board, [kind, id, name]: its name then has a button beside it (see showPart()).
  const showing = (a, [kind, id, name]) => `<dt class="shows"><span>${esc(a)}</span><button type="button" class="show" data-show="${kind}:${esc(id)}" aria-label="Show on the board: ${esc(name)}">Show on the board</button></dt>`;
  const dl = rows => `<dl>${rows.map(([a, b, show]) => `${show ? showing(a, show) : `<dt>${esc(a)}</dt>`}<dd>${esc(b)}</dd>`).join('')}</dl>`;
  const pos = keys => keys.map(k => [`${k.replace(/34|slot|wide/, '')} · ${POSITIONS[k][0]}`, POSITIONS[k][1]]);
  sec('Offense positions', false, dl(pos(['QB', 'RB', 'RBwide', 'FB', 'X', 'Z', 'H', 'Y', 'U', 'LT', 'LG', 'C', 'RG', 'RT'])));
  sec('Defense positions', false, dl(pos(['DE', 'DT', 'NT', 'S', 'M', 'W', 'J', 'CB', 'NB', 'FS', 'SS'])));
  sec('Formations and personnel', false, `<p>${esc(PERSONNEL)}</p><p>Personnel is the defense's first read: two backs or two tight ends lean run, four receivers lean pass.</p>` + dl(FORMATIONS.map(f => [`${f.name} · ${f.personnel}`, f.blurb, ['formation', f.id, f.name]])));
  sec('Fronts and techniques', false, `<p>Technique numbers tell a defensive lineman where to line up against the offensive line. Gaps between the blockers are lettered from the center out: A between the center and a guard, B between guard and tackle, C outside the tackle, D outside the tight end.</p>`
    + techDiagram() + dl([...TECHNIQUES, ...FRONTS.map(f => [f.name, f.blurb, ['front', f.id, f.name]])]));
  sec('Coverages', false, dl([...COVERAGES.map(c => [c.name, c.blurb, ['coverage', c.id, c.name]]), ['Man and zone', 'In man coverage each defender follows one receiver wherever he goes. In zone coverage each defender guards an area and plays whoever comes into it.'], ['Reading the shell', 'Before the snap, count the safeties deep. Two deep usually means Cover 2 or Cover 4; one deep means Cover 1 or Cover 3; none means Cover 0 and a blitz. The corners help too: up close and pressing means man; about five yards off means Cover 2; seven or more means a deep zone, thirds or quarters. Defenses disguise it, though, and so can the ones on this board: see Disguise.'], ['Disguise', 'Lining up to look like one coverage and playing another. Here Cover 1 and Cover 3 can show two deep, the way Cover 4 lines up, and rotate at the snap: the strong safety comes down and the free safety runs to the middle, leaving one deep. The other coach does it about one snap in four. So read the safeties again at the snap: if one comes down, it\'s one deep after all, and the corners say which. Dropping into deep thirds is Cover 3; running with their receivers is Cover 1.']]));
  sec('Run plays', false, dl(PLAYS.filter(p => p.type === 'run').map(p => [p.name, p.blurb, ['play', p.id, p.name]])));
  sec('Pass plays', false, dl([...PLAYS.filter(p => p.type === 'pass').map(p => [p.name, p.blurb, ['play', p.id, p.name]]), ['Reading the routes', 'Receivers are counted from the outside in on each side: #1 is the widest, #2 the next one in. A pass concept tells each number what to run, so the same play works from any formation. A man in motion is counted where he sets: from Gun Trips the H going across leaves two each side, and the routes go by the new count.']]));
  // drag6 and bflat are the same routes as drag and flat at another depth or from the backfield, so they're listed once;
  // jet is what a man in jet motion does on a run, under "Jet motion" in the words coaches use. Each says which plays
  // run it, and the route tree draws them all.
  const routeDesc = { flat: 'Out toward the sideline about four yards past the line, run by a receiver or by a back coming out of the backfield.' };
  const use = routeUse(), list = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
  sec('Routes', false, routeTree(use) + dl(Object.entries(ROUTES).filter(([k]) => !['drag6', 'bflat', 'jet'].includes(k)).map(([k, r]) => [r.name.replace(/^\w/, c => c.toUpperCase()),
    `${routeDesc[k] || r.desc.replace(/^[^:]+: /, '').replace(/^\w/, c => c.toUpperCase())} ${use[k] ? `Run in ${list(use[k])}.` : `No play here runs it, but a ${HOT.back.includes(k) ? 'back' : 'receiver'} can: tap him before the snap and change his route.`}`])));
  sec('How to read the board', false, keyList());
  // The words on the board, the cards and the notes that aren't a position, a play or a coverage. The zones are the
  // areas in ZONES (js/playbook.js), as the player cards name them.
  sec('Words coaches use', false, dl([
    ['Strong side and weak side', 'The strong side is the tight end\'s side, or the side with more receivers; the weak side is the other one. The defense sets its strength to it: the Sam and the strong safety go to the strong side, the Will to the weak side.'],
    ['Play side and back side', 'On a run, the play side is where the ball is going and the back side is the other half of the line. Every run on this board is drawn up to the strong side.'],
    ['The box', 'The area near the line where defenders play the run. The board counts it out to 3 yards past the end of the line on each side (the tight end, or the tackle where there\'s no tight end) and up to 8 yards deep. More defenders in the box than there are blockers makes a run hard: there aren\'t enough blockers to go round.'],
    ['Motion', 'A receiver off the line running across the formation before the snap. The defense has to answer it, and how it does gives the coverage away: in man coverage the man covering him runs with him (and if he\'s a cornerback, a safety slides over to the side he left: see The bump); in zone the defenders only slide over. Once he sets he\'s counted on his new side, so three receivers to one side can become two and two.'],
    ['The bump', 'When a cornerback runs across the formation with a man in motion, the side he left has nobody out wide to keep a run from getting round the end: a run there could go the distance. So a safety slides over and takes his place, a few yards outside the tight end. Here it\'s the strong safety, in Cover 1 and Cover 0: in Cover 1 he holds the edge, outside the ball carrier, until the run gets to the line, the way the cornerback would have; in Cover 0 he stays on his man, the tight end, from outside him. (Not when his man is the back or the other tight end: he stays where he can cover him.)'],
    ['Jet motion', 'Motion at full speed, with the ball snapped as he crosses the formation. A man covering him has to run with him flat out. On a run he keeps going, out to the flat, and takes his defender with him.'],
    ['Shotgun', 'The quarterback lines up about five yards behind the center and takes a short snap through the air, instead of under center with his hands on the ball. He sees the defense from there, and needs only a short drop to throw.'],
    ['Press', 'A corner lined up a yard or so off the receiver, right in his face, to jam him at the snap and stay on him. Corners press in man coverage.'],
    ['Leverage', 'Which side of a receiver a defender lines up on. With outside leverage he\'s a step outside him, so the receiver\'s easy way is inside; with inside leverage it\'s the other way round.'],
    ['Over the top', 'Deeper than a receiver, between him and the end zone: where a deep safety helps.'],
    ['Three-step and five-step drop', 'How far the quarterback drops back before he throws, counted in steps. From the shotgun he\'s already back, so a three-step drop does what five steps do under center; a quick drop gets the ball out for short routes.'],
    ['Check-down', 'The short, safe throw when everything downfield is covered, usually to the back a few yards past the line.'],
    ['Hot throw', 'A quick throw when a blitzer is coming with nobody left to block him: the quarterback gets it out before he arrives, usually to the receiver in the area the blitzer left.'],
    ['Hot route', 'A receiver\'s route changed at the line, just before the snap: he and the quarterback see how the defense lines up and switch to a route that beats it, often a quick one against a blitz. Here, tap a receiver or a back on your own pass play and pick Change his route; the play then reads "Smash, H on a slant".'],
    ['Flat', 'The short area out by the sideline, up to about 10 yards past the line.'],
    ['Curl-flat', 'From about the slot out to the sideline, up to about 12 yards deep. The defender there sinks under a curl route first, then widens to the flat.'],
    ['Hook-curl', 'Inside, from about the end of the line out to the slot, 2 to 13 yards deep: where curls and sit routes settle.'],
    ['Middle hook', 'The middle of the field in front of the safeties, 3 to 14 yards deep.'],
    ['Short middle, "the rat"', 'The middle of the field up to about 10 yards. In Cover 1 the defender left over sits there to take away crossing routes.'],
    ['Deep thirds, halves and quarters', 'The deep field, from about 9 yards on, split between the deep defenders: in thirds in Cover 3 (the corners and the free safety), in halves in Cover 2 (the two safeties), in quarters in Cover 4 (the corners and the safeties). The deep middle third is the middle one of the three; an inside quarter is one of the two nearest the middle.'],
    ['Down and distance', 'The offense has four downs, four plays, to gain 10 yards. Get there and it\'s a first down, with four more. "3rd & 8" is the third down with 8 yards still to go. Here it\'s the Situation, above your call, and the yellow line across the field is how far there is to go.'],
    ['Success', 'A play that gains enough for its down: 40% of the yards to go on first down, 60% on second, and all of them, a first down, on third and fourth. That\'s how Pro-Football-Reference counts it. On 1st & 10 it\'s 4 yards; on 2nd & 6, 4 (60% of 6, in whole yards); on 3rd & 8, all 8, so a 6-yard gain that\'s a win on first down is a failure there. The chart\'s bars and the drills count it.'],
    // (counted from nflverse's 2023 play-by-play file, regular season: 793 tries of 4,047 fourth downs; 430 of 775 with 1 or 2 to go)
    ['Turnover on downs', 'A fourth down that comes up short of the first down: the other team gets the ball where the play ended. So on most fourth downs a team punts or kicks a field goal instead. NFL teams went for it on one fourth down in five in 2023, but on more than half of those with a yard or two to go.'],
    ['Big play', 'A run of 10 yards or more, or a pass play that gains 20 or more: a common way analysts count explosive plays (Sharp Football Analysis, for one). Teams draw the line in different places.'],
    ['Takeaway', 'The defense taking the ball away: an interception, or a fumble it recovers. There are no fumbles on this board, so here a takeaway is an interception.'],
  ]));
}

// Which plays run each route, in the playbook's order: the routes each pass play gives its receivers and backs, by where
// they line up in each formation (S1, S2... counted from the outside in, as prepare() in js/sim.js counts them, with
// nobody in motion). A drag at six or seven yards is a drag, and a back's flat route a flat route.
function routeUse() {
  const use = {};
  for (const fm of FORMATIONS) {
    const men = fm.players.map(([label, x, y, cls]) => ({ label, x, y, cls }));
    const elig = men.filter(p => p.cls === 'wr' || p.cls === 'te');
    const side = sg => elig.filter(p => Math.sign(p.x) === sg).sort((a, b) => Math.abs(b.x) - Math.abs(a.x));
    const ps = side(-1).length > side(1).length ? -1 : 1;
    const keys = { RB: men.find(p => p.cls === 'rb'), FB: men.find(p => p.cls === 'fb') };
    side(ps).forEach((p, n) => { keys[`S${n + 1}`] = p; });
    side(-ps).forEach((p, n) => { keys[`W${n + 1}`] = p; });
    for (const pl of PLAYS.filter(x => x.type === 'pass')) {
      for (const [key, route] of Object.entries(pl.routes(keys))) {
        if (key === 'side' || !keys[key] || !ROUTES[route]) continue;
        const id = { drag6: 'drag', bflat: 'flat' }[route] || route;
        if (!(use[id] ||= []).includes(pl.name)) use[id].push(pl.name);
      }
    }
  }
  for (const id in use) use[id].sort((a, b) => PLAYS.findIndex(x => x.name === a) - PLAYS.findIndex(x => x.name === b));
  return use;
}

// The route tree: every route drawn from where its man lines up, the way the technique diagram draws the line, in the
// board's own chalk. A receiver split out on the right, so "out" is to the right, toward his sideline, and a back in
// the backfield, whose routes go out the same way. Long routes are cut off at the top and the long crossers at the
// left, each with its arrowhead. A route no play here runs is drawn faint. The words are placed by hand, beside each
// route's end (or a short way up it), so they don't run into each other: a route moved in js/playbook.js may need its
// words moved too.
// [text-anchor, yards across, yards up] for the words, from the route's end; and for some, where the drawing cuts the
// route off sooner, the yards up it stops.
const TREE_WR = { go: ['start', 0.6, 0], seam: ['end', -0.6, 0], post: ['end', -0.6, 0], corner: ['start', 0.6, 0], out: ['start', 0.6, 0], sail: ['start', 0.6, 0],
  dig: ['end', -0.6, 0], over: ['end', -0.6, 0], slant: ['end', -0.6, -0.2, 10], hitch: ['start', 0.7, -0.4], curl: ['end', -1.2, 0.7],
  flat: ['start', 0.6, 0], drag: ['end', -0.6, 0], sit: ['end', -1.2, -0.6], stick: ['start', 1.4, 2.3] };
const TREE_BACK = { wheel: ['start', 0.5, 0], swing: ['start', 0.5, 0], bflat: ['start', 0.5, 0], check: ['middle', 0, 0.8], screen: ['middle', -1.8, -2.35] };
function routeTree(use) {
  const list = names => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
  const runs = id => !!use[{ bflat: 'flat' }[id] || id];
  // routes: TREE_WR or TREE_BACK; K: pixels a yard; ox: where he lines up, in pixels across; los: the line of
  // scrimmage, pixels down; y0: how far behind the line he lines up, in yards; box: where the drawing ends, x0 yards to
  // the left and y1 up the field
  const draw = (routes, K, ox, los, y0, box, label) => {
    const X = x => +(ox + x * K).toFixed(1), Y = y => +(los - y * K).toFixed(1);
    let s = `<line class="los" x1="0" y1="${los}" x2="400" y2="${los}"/>`;
    for (const [id, [anchor, dx, dy, up = box.y1]] of Object.entries(routes)) {
      const r = ROUTES[id], all = [[0, y0], ...r.pts.map(([o, u]) => [o, r.fromLine ? u : y0 + u])], pts = [];
      for (const [k, [x, y]] of all.entries()) { // his path in yards, cut off at the edge of the drawing
        if (x >= box.x0 && y <= up) { pts.push([x, y]); continue; }
        const [px, py] = all[k - 1], f = Math.min(x < box.x0 ? (box.x0 - px) / (x - px) : 1, y > up ? (up - py) / (y - py) : 1);
        pts.push([px + (x - px) * f, py + (y - py) * f]);
        break;
      }
      // the arrowhead, as Board.arrow() draws one
      const [a, b] = pts.slice(-2), tip = [X(b[0]), Y(b[1])], ang = Math.atan2(tip[1] - Y(a[1]), tip[0] - X(a[0]));
      const wing = d => `${(tip[0] - 6 * Math.cos(ang + d)).toFixed(1)},${(tip[1] - 6 * Math.sin(ang + d)).toFixed(1)}`;
      s += `<g${runs(id) ? '' : ' class="unused"'}><polyline points="${pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(' ')}"${r.delay ? ' stroke-dasharray="5 4"' : ''}/>`
        + `<polygon points="${tip.join(',')} ${wing(-0.45)} ${wing(0.45)}"/>`
        + `<text x="${X(b[0] + dx)}" y="${Y(b[1] + dy)}" text-anchor="${anchor}">${id === 'bflat' ? 'flat' : esc(r.name)}</text></g>`;
    }
    return `${s}<circle class="man" cx="${ox}" cy="${Y(y0)}" r="6"/><text class="pos" x="${ox}" y="${Y(y0) + 20}" text-anchor="middle">${label}</text>`;
  };
  const faint = [...Object.keys(TREE_WR), ...Object.keys(TREE_BACK)].filter(id => !runs(id)).map(id => (id === 'bflat' ? 'flat' : ROUTES[id].name));
  const wr = `<svg class="tree" viewBox="0 0 350 192" role="img" aria-label="The route tree: a receiver split out on the right, and the routes he can run, out toward his sideline or in toward the middle: ${list(Object.keys(TREE_WR).map(id => ROUTES[id].name))}.">${draw(TREE_WR, 7, 196, 166, 0, { x0: -18, y1: 21 }, 'WR')}</svg>`;
  const rb = `<svg class="tree" viewBox="0 0 196 196" role="img" aria-label="Routes from the backfield: ${list(Object.keys(TREE_BACK).map(id => (id === 'bflat' ? 'flat' : ROUTES[id].name)))}.">${draw(TREE_BACK, 10, 34, 104, -5, { x0: -18, y1: 8.5 }, 'RB')}</svg>`;
  return `<figure class="trees">${wr}${rb}<figcaption>The route tree: each route from where his man lines up, a receiver split out on the right and a back in the backfield, with "out" to the right, toward his sideline. A dashed line starts late: the back blocks first.${faint.length ? ` Drawn faint: ${list(faint)}, which no play here runs, but a man can be given one: tap him on the board before the snap, then Change his route.` : ''}</figcaption></figure>`;
}

// "Show on the board", from the playbook: a formation, a play, a front or a coverage goes into the call and is lined up,
// with the board back in view and Snap ready to press. Your side and "Let the other coach pick" stay as they are. A
// part of the other coach's call (a coverage when you call the offense, a play when you call the defense) becomes his,
// and it's out, not hidden until the snap: you asked to see it. (A formation or a front is out anyway: it's in the
// alignment.) A coverage of his is shown as it plays, not disguised. Your own part goes in the way its chip would put
// it, new personnel and all. A drill under way ends when it's his call that changes, as it does when you switch sides.
const PARTS = { formation: ['off', FORMATIONS], play: ['off', PLAYS], front: ['def', FRONTS], coverage: ['def', COVERAGES] };
function showPart(kind, id) {
  const [k, list] = PARTS[kind], thing = list.find(x => x.id === id);
  if (!thing) return;
  const his = () => state.auto && (k === 'off') !== (state.side === 'O');
  if (drill && his()) { drill = null; state.auto = ownAuto; }
  const was = byId(FORMATIONS, state.off.formation).personnel;
  if (k === 'off' && state.off[kind] !== id) state.off.hot = {}; // the play as drawn
  state[k][kind] = id;
  const fixed = k === 'off' ? callable(kind === 'play' ? 'play' : '') : '';
  let subbed = false;
  if (his()) {
    if (kind === 'coverage') state.def.disguise = false;
    if (kind === 'coverage' || kind === 'play') { state.seen = state.book = true; state.ask = null; }
  } else if (k === 'off' && state.auto && state.side === 'O' && byId(FORMATIONS, state.off.formation).personnel !== was) { rollTheirs(); subbed = true; }
  afterChange();
  setCaption(`From the playbook: ${thing.name}.${fixed ? ` ${fixed}` : ''}${subbed ? ' New personnel: they\'ve substituted.' : ''}`);
  toSnap();
  // The board is near the top of the page, but out of sight from the playbook, even where it stays at the top of a
  // phone: it stays at the top only as far down as the calls go.
  const b = $('board').getBoundingClientRect();
  if (b.top < 0 || b.bottom > innerHeight) scrollTo({ top: 0, behavior: smooth() });
}
$('pbGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-show]');
  if (b) showPart(...b.dataset.show.split(':'));
});

// ---------------------------------------------------------------- the key

// How to read the board, each mark with a small drawing of it in the board's own colours (the CSS custom properties the
// board reads, so it follows the chalkboard and the whiteboard), at about the size the board draws it on a phone. It's
// in the playbook, and in a card the Key button under the board opens, under the board on a phone and beside it on a
// computer.
const BOARD_KEY = [
  ['O and X', 'The offense is drawn as circles (the center as a square) and the defense as Xs, the way coaches draw them. Once the play runs, an offensive player with the ball is filled in.', 'marks'],
  ['The line of scrimmage', 'The dashed line across the field, where the ball is snapped. The yard numbers count from it.', 'los'],
  ['The yellow line', 'The line to gain: get the ball to it for a first down. It\'s as far up the field as the yards to go in the Situation above your call, the way TV draws it.', 'first'],
  ['The ball', 'At the center\'s feet before the snap. Thrown, it rises off the field, with its shadow under it.', 'ball'],
  ['Lines with arrows', 'Routes for receivers and the path for a ball carrier. The quarterback\'s drop is the short broken line behind him.', 'route'],
  ['A dashed line with an arrow', 'A route that starts late: the back blocks first, then goes out.', 'late'],
  ['A zigzag behind the line', 'Motion: before the snap he runs across the formation, and his route starts where the zigzag ends.', 'motion'],
  ['Numbers on routes', 'The order the quarterback reads them: 1 is the first receiver he looks at, then 2, and so on. They\'re up before the snap, on your own pass play, or theirs once it\'s out.', 'reads'],
  ['A line with a bar across the end', 'A block.', 'block'],
  ['Dashed line to a bubble', 'A zone drop: the defender goes to that area.', 'zone'],
  ['Dotted line to a receiver', 'Man-to-man coverage on that receiver.', 'man'],
  ['Arrows from the defense', 'Pass rush. A blitzer\'s arrow is drawn thicker, with a double head, in the bright colour.', 'rush'],
  ['Rings', 'As the play runs, a dashed ring in the bright colour is round the man the words on the board are about. A thin ring is round the player you tapped.', 'rings'],
  ['Trails', 'Once the play is running, each man leaves a trail of where he went. The drawn-up play stays faintly underneath, so you can see where it broke down.', 'trail'],
  ['Dotted line from the quarterback', 'The throw: from where the ball left his hand to where it came down.', 'throw'],
  ['At the whistle', 'A line across the field where the ball is spotted, with the gain written beside it ("+17", "Sack −7"), or "Incomplete" by an × where the pass came down. A big play is written bigger. Both are in the colour of the side that won the play. After a play that went past the line, the board pulls back to show all of it, from the backfield to the spot, unless it\'s zoomed to the line.', 'whistle'],
];
function keyList() {
  return `<dl class="key-list">${BOARD_KEY.map(([term, words, art]) => `<div class="key-row"><dt><span class="key-art" aria-hidden="true">${keyArt(art)}</span>${esc(term)}</dt><dd>${esc(words)}</dd></div>`).join('')}</dl>`;
}

// The drawings, 72 by 44, drawn as Board draws them: the same dashes, line widths, arrowheads and fades. Classes in
// css/app.css colour them: o offense, d defense, l the line of scrimmage, b the ball, h the bright colour; f fills.
function keyArt(kind) {
  const pts = p => p.map(q => q.join(',')).join(' ');
  const line = (p, cls, more = '') => `<polyline class="${cls}" points="${pts(p)}"${more}/>`;
  // an arrowhead at b, coming from a, as Board.arrow() draws it
  const head = (a, b, cls, s = 6) => {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), at = d => [+(b[0] - s * Math.cos(ang + d)).toFixed(2), +(b[1] - s * Math.sin(ang + d)).toFixed(2)];
    return `<polygon class="f${cls}" points="${pts([b, at(-0.45), at(0.45)])}"/>`;
  };
  const arrow = (p, cls, more = '') => line(p, cls, more) + head(p.at(-2), p.at(-1), cls);
  const O = (x, y, more = '') => `<circle class="o" cx="${x}" cy="${y}" r="5.5"${more}/>`;
  const X = (x, y) => `<path class="d" d="M${x - 4.4} ${y - 4.4}L${x + 4.4} ${y + 4.4}M${x + 4.4} ${y - 4.4}L${x - 4.4} ${y + 4.4}"/>`;
  const C = (x, y) => `<rect class="o" x="${x - 5}" y="${y - 5}" width="10" height="10"/>`;
  const ball = (x, y) => `<ellipse class="fb" cx="${x}" cy="${y}" rx="5" ry="3.2" transform="rotate(-28.6 ${x} ${y})"/>`;
  const num = (x, y, n) => `<text class="key-num fo" x="${x}" y="${y}">${n}</text>`;
  const art = {
    marks: O(11, 22) + C(28, 22) + O(45, 22, ' style="fill: var(--off)"') + X(61, 22),
    los: line([[5, 24], [67, 24]], 'l', ' stroke-dasharray="6 5" opacity=".85"') + X(36, 12) + C(36, 34),
    first: line([[5, 34], [67, 34]], 'l', ' stroke-dasharray="6 5" opacity=".85"') + line([[5, 13], [67, 13]], 'y', ' stroke-width="3.5" opacity=".9"') + ball(36, 34),
    ball: ball(22, 26) + '<ellipse cx="50" cy="30" rx="4.4" ry="2.4" style="fill: var(--field-line)" opacity=".25"/>' + ball(50, 14),
    route: arrow([[12, 36], [12, 11], [54, 11]], 'o') + O(12, 36),
    late: arrow([[14, 34], [56, 14]], 'o', ' stroke-dasharray="6 4"') + O(14, 34),
    motion: line([[10, 34], [15, 37.5], [20, 32.5], [25, 37.5], [30, 32.5], [35, 37.5], [40, 32.5], [44, 35]], 'o') + arrow([[44, 35], [44, 9]], 'o') + O(10, 34),
    reads: arrow([[12, 37], [12, 15], [38, 15]], 'o') + num(47, 15, 1) + arrow([[58, 37], [58, 21]], 'o') + num(58, 12, 2) + O(12, 37) + O(58, 37),
    block: line([[18, 32], [37, 21.5]], 'o') + `<path class="o" d="M34.4 16.9L39.6 26.1"/>` + O(18, 32) + X(54, 12),
    zone: line([[12, 34], [46, 15]], 'd', ' stroke-dasharray="4 5"') + '<ellipse class="fd" cx="46" cy="15" rx="20" ry="10" opacity=".16"/>'
      + '<ellipse class="d" cx="46" cy="15" rx="20" ry="10" stroke-dasharray="3 5" opacity=".5"/>' + X(12, 34),
    man: line([[14, 12], [56, 32]], 'd', ' stroke-dasharray="1 5" stroke-width="2.2"') + X(14, 12) + O(56, 32),
    // a rusher's arrow, and a blitzer's: thicker, in the bright colour, with a second head a head's length back
    rush: arrow([[13, 9], [23, 35]], 'd') + line([[45, 9], [56, 35]], 'h', ' stroke-width="3.2"') + head([45, 9], [56, 35], 'h', 7.2) + head([45, 9], [52.9, 27.6], 'h', 7.2) + X(13, 9) + X(45, 9),
    rings: O(20, 22) + `<circle class="h" cx="20" cy="22" r="11.5" stroke-width="2.2" stroke-dasharray="3.9 2.5"/>` + X(54, 22) + `<circle class="d" cx="54" cy="22" r="10.5" stroke-width="1.5" opacity=".9"/>`,
    trail: `<g opacity=".33">${arrow([[12, 38], [12, 11], [52, 11]], 'o')}</g>` + line([[12, 38], [14, 30], [22, 24], [34, 22], [46, 25]], 'o', ' stroke-width="1.6" opacity=".42"') + O(46, 25),
    throw: line([[13, 32], [51, 14]], 'b', ' stroke-dasharray="0.1 4.5" opacity=".8"') + O(12, 34) + O(59, 11) + ball(52, 14),
    whistle: line([[4, 26], [68, 26]], 'o', ' stroke-width="2.5" opacity=".9"') + ball(17, 26) + '<text class="key-mark fo" x="26" y="14">+7</text>',
  }[kind];
  return `<svg viewBox="0 0 72 44" focusable="false">${art}</svg>`;
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
  Object.assign(state, { off: kept.off, def: kept.def, seed: kept.seed, seen: kept.seen, book: kept.book, ask: kept.ask });
  ({ drill, drilled } = kept);
  if (drill) state.auto = true;
  firstHint = !kept.snapped;
} else if (link !== 'ok' && state.auto) rollTheirs();
renderChoosers();
playbook();
$('keyBody').innerHTML = keyList();
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
  syncZoom(); // only on a narrow board
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
    takeQuiz(s);
    $('quiz').checked = state.quiz;
    if (!state.quiz && asking()) reveal(); // turned off there: the question goes here too, and his call is out
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
window.chalkTalk = { state, board, lineUp, play, pause, snap, finish, simulate, rollTheirs, chart: () => chart };
