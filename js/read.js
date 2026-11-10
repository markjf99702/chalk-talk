// The coach's read: what the other side is showing before the snap, what it probably means, and two or three calls
// worth considering. It's worked out from what the board shows before the snap and nothing else: where the other side
// lines up, your own call, and the down and distance. The other coach's call never comes into it: coachRead() is handed
// a view of the board before the snap (see readView() in js/app.js), with no call of his in it, and weighs the calls he
// could have made that look that way, by how often he makes each one (his mix, below), using the simulator's own
// numbers for how each play does against each of them (js/read-table.js, made by tools/read-table.mjs).
import { TABLE } from './read-table.js';
import { FORMATIONS, PLAYS, FRONTS, COVERAGES, SITUATIONS, ROUTES, needed } from './playbook.js';
import { prepare, cantCall, blitzerFor, SIM_VERSION } from './sim.js';

const byId = (list, id) => list.find(x => x.id === id) || list[0];
const WORD = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];
const word = n => WORD[n] ?? String(n);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const and = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '');
const or = list => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0] || '');

// ---------------------------------------------------------------- the other coach's mix

// What the other coach picks from (rollTheirs() in js/app.js picks his call with these), and what the read weighs the
// calls he could have made by. Calling the defense, his play leans on his personnel: about this share of his plays are
// runs from each formation on 1st & 10, the rest passes, and every play stays possible. (A design choice in the
// direction real offenses lean, more backs and tight ends running more; not a published statistic.) The down moves it
// (see lean()).
export const RUN_SHARE = { iform: 0.6, single: 0.55, ace: 0.5, pistol: 0.45, trips: 0.375, doubles: 0.25, empty: 0 };
// Calling the defense, his offense puts a man in motion about one snap in three, across or jet alike, counting the
// formations that have nobody to send. (A design choice, so motion comes up as you watch your own defense; not a
// published statistic.)
export const MOTION_SHARE = 1 / 3;
// Calling the offense, about one of his snaps in four is a disguise: he plays Cover 1 or Cover 3 on 54% of them, and
// disguises 46% of those. (A design choice, so a look can't be trusted every time; not a published statistic.)
export const DISGUISES = ['c1', 'c3'];
export const DISGUISE_SHARE = 0.46;
// His fronts on 1st & 10, against three or four receivers (10 or 11 personnel) or against more backs and tight ends;
// his coverages; how often he blitzes; and who comes, of the ones who can with that front, coverage and disguise: the
// Mike most often, then the Will, the nickel back and the safety.
const FRONT_MIX = { spread: [['nickel', 0.55], ['over', 0.15], ['under', 0.12], ['34', 0.18]], base: [['over', 0.3], ['under', 0.25], ['34', 0.3], ['nickel', 0.15]] };
const COVER_MIX = [['c0', 0.06], ['c1', 0.22], ['c2', 0.2], ['c3', 0.32], ['c4', 0.2]];
export const BLITZ_SHARE = 0.25;
const BLITZER_MIX = [['M', 0.4], ['W', 0.3], ['NB', 0.15], ['SS', 0.15]];

// The down and distance moves his call the way NFL teams' calls moved from 1st & 10 to that situation in 2023 (nfl in
// SITUATIONS, js/playbook.js), from his 1st & 10 call as it always was. A yes-or-no share moves by the same odds as the
// NFL's did, so it stays between none and all: his nickel front by the NFL's five or more defensive backs, his blitz by
// its five or more rushers, and his run share by its runs (on 3rd & 8 the NFL blitzed on 39% of dropbacks against 25%
// on 1st & 10, and so does he; I-Form's 60% of runs on 1st & 10 becomes 6%). Each coverage moves by as many points as
// its share of the NFL's five did, rather than by odds, as this board's Cover 0 already comes up far more often on
// 1st & 10 than the NFL's 1%: on 3rd & 8 his Cover 1 goes from 22% to 38%.
export function lean(sit) {
  const a = SITUATIONS[0].nfl, b = sit.nfl;
  const odds = (from, to) => p => { if (from === to) return p; const o = (p / (1 - p)) * (to / (100 - to)) / (from / (100 - from)); return o / (1 + o); };
  const share = n => { const all = Object.values(n.cover).reduce((x, y) => x + y, 0); return c => n.cover[c] / all; };
  const was = share(a), now = share(b);
  return { nickel: odds(a.nickel, b.nickel), blitz: odds(a.blitz, b.blitz), run: odds(100 - a.pass, 100 - b.pass), cover: (c, p) => Math.max(0.01, p + now(c) - was(c)), passing: b.pass / a.pass };
}
// Each of these is a list of [choice, weight]: the weights needn't add up to one (he picks in proportion to them).
// His front against a formation: his 1st & 10 fronts, then nickel moved for the down and the others sharing what's left
// as they did.
export function frontMix(formation, L) {
  const pers = byId(FORMATIONS, formation).personnel, fronts = FRONT_MIX[pers === '10' || pers === '11' ? 'spread' : 'base'];
  const nickel = fronts.find(([f]) => f === 'nickel')[1], more = L.nickel(nickel);
  return fronts.map(([f, p]) => [f, f === 'nickel' ? more : p * (1 - more) / (1 - nickel)]);
}
export const coverMix = L => COVER_MIX.map(([c, p]) => [c, L.cover(c, p)]);
export const blitzerMix = (front, coverage, disguise) => BLITZER_MIX.filter(([b]) => !blitzerFor(front, coverage, b, disguise));
// His formation: Empty, which can only throw, half as often as each of the others on 1st & 10, and more or less often
// as the NFL's passes went with the down (a design choice, so it comes up without taking over; not a published
// statistic).
export const formationMix = L => FORMATIONS.map(f => [f.id, f.id === 'empty' ? 0.5 * L.passing : 1]);
// His play from a formation: only the plays it can run (from Empty, no runs, no fake and no screen), the runs sharing
// its run share and the passes the rest.
export function playMix(formation, L) {
  const can = PLAYS.filter(p => !cantCall(formation, p.id)), runs = can.filter(p => p.type === 'run').length;
  const run = runs ? L.run(RUN_SHARE[formation] ?? 0.42) : 0;
  return can.map(p => [p.id, p.type === 'run' ? run / runs : (1 - run) / (can.length - runs)]);
}
// How often he sends a man in motion from a formation: Gun Ace and Empty have nobody to send, so from the others a
// little more often, to keep it one snap in three.
export function motionShare(formation, L) {
  if (!byId(FORMATIONS, formation).motion) return 0;
  const lineups = formationMix(L), all = lineups.reduce((a, [, p]) => a + p, 0);
  const movers = lineups.filter(([id]) => byId(FORMATIONS, id).motion).reduce((a, [, p]) => a + p, 0);
  return Math.min(1, MOTION_SHARE * all / movers);
}
const share = list => { const t = list.reduce((a, [, p]) => a + p, 0); return new Map(list.map(([k, p]) => [k, p / t])); };

// How often he makes each call in the table (TABLE.calls) against a formation in a situation: his front, his coverage,
// then a disguise, a blitz and who comes, each as he picks them. Cover 0 always blitzes, so it's one call.
function defenseOdds(formation, L) {
  const pf = share(frontMix(formation, L)), pc = share(coverMix(L)), B = L.blitz(BLITZ_SHARE);
  return TABLE.calls.map(code => {
    const [front, coverage, pressure, blitzer, d] = code.split('.'), dis = d === '1';
    let w = pf.get(front) * pc.get(coverage);
    if (coverage === 'c0') return w;
    if (DISGUISES.includes(coverage)) w *= dis ? DISGUISE_SHARE : 1 - DISGUISE_SHARE;
    if (pressure === 'four') return w * (1 - B);
    return w * B * (share(blitzerMix(front, coverage, dis)).get(blitzer) || 0);
  });
}

// ---------------------------------------------------------------- the look

// What a quarterback reads in a defense before the snap, from where the players stand on the board's first frame (with
// a man in motion, before he goes): players are { team, label, cls, x, y }, in yards, x across the field and y up it
// from the line of scrimmage.
// - deep: how many are past 10 1/2 yards (the board's safeties count, as in the result card's read);
// - corners: how far off the nearer cornerback is, in the bands the result card uses: pressed (under 2 1/2 yards),
//   about 5 yards off (under 6), or 7 or more;
// - box: how many are in the box, as the simulator counts it (boxCount() in js/sim.js): from the end of the line each
//   side (a tight end within 8 yards of the ball, or else the tackle) out to 3 yards past it, and less than 8 deep;
// - walked: how many men off the line (linebackers and safeties, not the ones standing on the line at the edge, nor
//   the cornerbacks) stand in the box within 4 yards of the line: men walked up close, who might be coming;
// - blockers: the men a run hands blocks to, the line, the fullback and the tight ends within 8 yards (also as
//   boxCount() counts them).
// The key is what the read goes on: two calls with the same key look alike to it, and get the same read.
const EDGE = { under: ['S'], 34: ['S', 'J'] }; // linebackers who stand on the line at the edge in that front
export function lookOf(players, front) {
  const O = players.filter(p => p.team === 'O'), D = players.filter(p => p.team === 'D');
  const te = p => p.cls === 'te' && Math.abs(p.x) < 8;
  const end = sd => Math.max(3, ...O.filter(p => te(p) && Math.sign(p.x) === sd).map(p => Math.abs(p.x)));
  const edge = { [1]: end(1), [-1]: end(-1) };
  const inBox = d => Math.abs(d.x) < edge[Math.sign(d.x) || 1] + 3 && d.y < 8;
  const deep = D.filter(d => d.y > 10.5).length;
  const cy = Math.min(...D.filter(d => d.label === 'CB').map(d => d.y));
  const corners = cy < 2.5 ? 'press' : cy < 6 ? 'five' : 'deep';
  const box = D.filter(inBox).length;
  const off = d => !['DE', 'DT', 'NT', 'CB'].includes(d.label) && !(EDGE[front] || []).includes(d.label);
  const walked = D.filter(d => off(d) && inBox(d) && d.y < 4).length;
  const blockers = O.filter(p => p.cls === 'ol' || te(p) || p.cls === 'fb').length;
  return { deep, corners, box, walked, blockers, key: `${deep}|${corners}|${box}|${walked}` };
}
const unkey = key => { const [deep, corners, box, walked] = key.split('|'); return { deep: +deep, corners, box: +box, walked: +walked }; };

// ---------------------------------------------------------------- the numbers

// The table is for one version of the simulator: with another, the read still says what they're showing, but makes no
// picks (test/sim.test.mjs fails until the table is made again).
export const fresh = () => !!TABLE && TABLE.sim === SIM_VERSION && !!TABLE.long;
const VALUE = TABLE ? Object.fromEntries([...TABLE.alpha].map((ch, k) => [ch, k / (TABLE.alpha.length - 1)])) : {};
const NEEDS = [1, 2, 4, 8]; // the yards to gain, by the table's four numbers in a cell
const column = sit => NEEDS.indexOf(needed(sit));
// How often a play from a formation is a success against the call in TABLE.calls (call) or TABLE.base (b, in motion).
export function rate(formation, play, call, sit) {
  const k = TABLE.plays[formation].indexOf(play);
  return VALUE[TABLE.cells[formation][(k * TABLE.calls.length + call) * 4 + column(sit)]];
}
function rateMoving(formation, play, b, sit) {
  const k = TABLE.plays[formation].indexOf(play);
  return VALUE[TABLE.motion[formation][(k * TABLE.base.length + b) * 4 + column(sit)]];
}
// How often a play from a formation goes 15 yards or more against the call in TABLE.base (b), with a man in motion or
// not: the table has it for a short third or fourth down, and for any other.
export function longRate(formation, play, b, sit, moving = false) {
  const k = TABLE.plays[formation].indexOf(play);
  return VALUE[(moving ? TABLE.longMotion : TABLE.long)[formation][(k * TABLE.base.length + b) * 2 + (needed(sit) <= 2 ? 0 : 1)]];
}

// The calls he could have made that look the way this one does, each with its share of how often he'd make one of them.
export function lookAlikes(formation, front, key, sit) {
  const odds = defenseOdds(formation, lean(sit));
  const group = TABLE.calls.map((c, i) => i).filter(i => TABLE.calls[i].startsWith(`${front}.`) && TABLE.looks[formation][i] === key);
  const total = group.reduce((a, i) => a + odds[i], 0);
  return group.map(i => ({ call: i, code: TABLE.calls[i], p: odds[i] / total }));
}
// Each play from a formation, by how often it's a success against the look's calls, weighed by how often he makes each
// one: best first.
export function rankPlays(formation, alike, sit) {
  return TABLE.plays[formation].map(id => ({ id, rate: alike.reduce((a, { call, p }) => a + p * rate(formation, id, call, sit), 0) }))
    .sort((a, b) => b.rate - a.rate);
}
// Each call a defense can pick in its chips (TABLE.base), by how often it stops his plays from a formation short of a
// success (rate), less how often one of them goes 15 yards or more against it (long), each weighed by how often he runs
// each play and sends a man in motion first: best first. (By the first alone, Cover 0 came first for 27 of the 35
// formations and downs: it stops the most plays short, and gives up the most long ones. Counting them, 24.)
export function rankDefenses(formation, sit) {
  const L = lean(sit), plays = playMix(formation, L), m = motionShare(formation, L);
  const mix = (still, moving) => plays.reduce((a, [id, p]) => a + p * ((1 - m) * still(id) + (m ? m * moving(id) : 0)), 0);
  return TABLE.base.map((call, b) => {
    const held = mix(id => 1 - rate(formation, id, call, sit), id => 1 - rateMoving(formation, id, b, sit));
    const long = mix(id => longRate(formation, id, b, sit), id => longRate(formation, id, b, sit, true));
    return { call, code: TABLE.calls[call], rate: held, long, score: held - long };
  }).sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------- the words

// "about 7 in 10" (a share), "about 7 times in 10" (how often something happens).
const tenths = p => Math.min(9, Math.max(1, Math.round(p * 10)));
const tens = p => (p >= 0.95 ? 'nearly all' : p < 0.05 ? 'almost none' : `about ${tenths(p)} in 10`);
const times = p => (p >= 0.95 ? 'nearly every time' : p < 0.05 ? 'almost never' : `about ${tenths(p)} time${tenths(p) === 1 ? '' : 's'} in 10`);
// Out of 100, for the defense picks' two numbers: the picks are in order of the first less the second, unrounded, and to
// the nearest 1 in 10 a pick could read worse than the one under it on both (on 3rd & 8 against Gun Ace, Gun Doubles and
// the Pistol it did: a first pick giving up 15 yards or more about 6 times in 100 read "about 1 in 10", as did the ones
// under it giving up 9 and 13).
// (A number keeps its "in 100" on its line, with no-break spaces: on a phone the line wraps, and "100" alone on the
// next line read like a number of its own.)
const hundredths = p => Math.min(99, Math.max(1, Math.round(p * 100)));
const times100 = p => (p >= 0.995 ? 'nearly every time' : p < 0.005 ? 'almost never' : `about ${hundredths(p)}\u00a0time${hundredths(p) === 1 ? '' : 's'}\u00a0in\u00a0100`);
const share100 = p => (p < 0.005 ? 'almost never' : `about ${hundredths(p)}\u00a0in\u00a0100`);
const COVER_WORDS = {
  c0: 'man-to-man, nobody deep', c1: 'man-to-man, one safety deep', c2: 'two deep halves, the corners in the flats',
  c3: 'three deep thirds', c4: 'four deep quarters',
};
const coverName = (c, d) => `${byId(COVERAGES, c).name}${d ? ', disguised' : ''}`;
const FRONT_WORDS = {
  over: '4-3 Over: four linemen and three linebackers, with the 3-technique tackle (on the guard\'s outside shoulder) on your strong side.',
  under: '4-3 Under: four linemen and three linebackers, with the 3-technique tackle (on the guard\'s outside shoulder) on your weak side, and the Sam (the strong-side linebacker) standing up on the line at the strong-side end of it.',
  34: '3-4: three linemen and four linebackers, two of them standing up on the edges.',
  nickel: 'Nickel: four linemen, two linebackers and a fifth defensive back, the nickel back, over the slot: one linebacker fewer to stop a run.',
};
const DEEP_WORDS = ['Nobody deep: no safety more than 10 yards off.', 'One safety deep, about 13 yards off in the middle.', 'Two safeties deep, about 12 yards off, one over each half of the field.'];
const DEEP_SHORT = ['nobody deep', 'one deep', 'two deep'];
const CORNER_WORDS = {
  press: 'The corners are pressed: right up on the receivers, to jam them at the snap.',
  five: 'The corners are about 5 yards off.',
  deep: 'The corners are 7 yards or more off.',
};
const CORNER_SHORT = { press: 'the corners pressed', five: 'the corners about 5 off', deep: 'the corners 7 or more off' };

// Why a play is worth a look against this look, in football terms, from what the look shows: nothing here names a
// coverage, so the quiz after the snap keeps its answer. Each says what the coach's notes (NOTES in js/playbook.js)
// and the play's blurb say about that look.
const RUN_WORDS = {
  iz: 'Inside Zone wants a blocker for every man in the box.',
  oz: 'Outside Zone stretches them sideways, and the back cuts up where it opens.',
  power: 'Power brings a pulling guard to the hole: one more blocker where the ball goes.',
  counter: 'Counter steps one way and goes the other, behind the pulling guard.',
  draw: 'The Draw looks like a pass, and hands it off under rushers running up the field.',
};
// The man the quarterback looks to first on the Play-Action Shot from this formation when as many rush as he has
// blockers, with only three out (S.sightRead in js/sim.js: from I-Form, the tight end in the flat), or none.
const sightOf = fm => prepare({ formation: fm.id, play: 'pa', flip: false, motion: 'none', hot: {}, front: 'over', coverage: 'c2', pressure: 'four', blitzer: 'M', disguise: false, sit: '1and10' }, 1).sightRead;
function reasonFor(id, L, blockers, again = false, fm = null) {
  const pl = byId(PLAYS, id);
  if (pl.type === 'run') {
    const d = blockers - L.box;
    if (d >= 1) return `${cap(DEEP_SHORT[L.deep])} and only ${word(L.box)} in the box against your ${word(blockers)} blockers: run it.`;
    if (d === 0) return `A blocker for each of the ${word(L.box)} in the box. ${RUN_WORDS[id]}`;
    if (L.deep === 0) return `Nobody deep behind the ${word(L.box)} in the box: a back who gets past the first wave has room.`;
    // More in the box than you can block usually makes a run hard (the board's word for the box says so, and Inside
    // Zone's note wants even numbers), so a run picked against it says so plainly, and that it's a pick on the
    // board's numbers all the same; Inside Zone's own words are for even numbers, so they're left out. A second run
    // picked against the same box (again) says it shorter.
    const over = again ? `It does well despite the ${-d === 1 ? 'extra man' : `${word(-d)} extra men`} in the box too.`
      : `${cap(word(-d))} more in the box than you can block, which usually makes a run hard, but on the board's numbers it's still one of the best calls against this look.`;
    return id === 'iz' ? over : `${over} ${RUN_WORDS[id]}`;
  }
  const { deep, corners: c } = L, zero = deep === 0, press = c === 'press';
  switch (id) {
    case 'verts':
      if (zero) return 'Nobody deep: every vertical route is a footrace, if the ball comes out before the extra rusher gets there.';
      if (deep === 1) return 'One deep safety can\'t be over all four vertical routes, and the check-down is there underneath.';
      return c === 'five' ? 'Two deep and the corners sitting short: each deep safety has two vertical routes running at him.'
        : 'Four vertical routes at two deep safeties: when the deep men take them away, the check-down underneath is open.';
    case 'smash':
      if (zero) return 'Nobody deep: the ball comes out hot, before the extra rusher gets there.';
      if (press) return 'Corners pressed in man: the corner route breaks away from the man chasing it, a long way from the deep safety.';
      return c === 'five' ? 'The corners sit about 5 yards off: the corner route goes over them, with the deep safety a long way from the sideline, and the hitch is in front.'
        : 'The corners are off and deep: the hitch underneath them is open, short.';
    case 'flood':
      if (zero) return 'Nobody deep: the quick throw is to the back in the flat, with his man a step behind.';
      if (press) return 'The deep safety can\'t help on routes breaking to the sideline, and the back\'s flat route is a one-on-one in space.';
      if (c === 'five') return 'The corner sitting short is caught between the sail and the flat route under it.';
      return deep === 1 ? 'Three receivers at three depths on one side, against two defenders there: someone is left over.'
        : 'The deep men stay deep: the sail settles in front of them at 12 to 14 yards, and the flat is open underneath.';
    case 'mesh':
      if (press) return 'Men pressed on every receiver: the crossers rub them off each other, and a clean catch runs away from the man chasing.';
      return c === 'five' ? 'The corners sitting short leave the corner route open over them, while the linebackers sit on the crossers.'
        : 'The crossers and the back\'s swing find the room underneath, in front of the deep men.';
    case 'slants':
      if (zero) return 'Quick throws beat the blitz: the ball\'s out in about a second, before the rush gets there.';
      if (press) return 'The slant comes open inside the man pressing him; watch for the defender sitting in the short middle.';
      if (c === 'five') return 'Short and sure: the flat route is open more often, with the corner right there to tackle.';
      return deep === 1 ? 'The defender between the slant and the flat has to choose, and one of them comes open.'
        : 'The corners play off and deep: room underneath for both quick routes.';
    case 'stick':
      if (zero) return 'Short and quick: the ball\'s out before the rush gets there.';
      if (press) return 'Corners pressed: the stick sits down at five yards with the man on him still behind him, an easy throw if a short one.';
      if (c === 'five') return 'The corner sitting short covers a receiver in the flat, so the ball goes to the stick, in front of the linebackers, or to the back coming out of the backfield.';
      return 'The defender between the stick and the flat can\'t take both: the quarterback throws to the one he leaves.';
    case 'pa': {
      // With only three out, against everyone coming he takes the short one at once (see SIGHT in js/sim.js). Against
      // one deep with the corners pressed, man-to-man, the men on the backs join the rush once the backs stay in to block
      // (with four rushing too: see cover() in js/sim.js), so a blitz brings as many as he has blockers: from I-Form
      // that's why it's picked there, as often as not.
      const f = fm && sightOf(fm), first = f && `the quarterback looks first to the ${f.label} on the ${ROUTES[f.job.route].name}, at once`;
      if (zero && f) return `Nobody deep and everyone else coming, with only three out: ${first}, before they get there.`;
      if (zero) return 'Nobody deep: the deep routes are one-on-ones, if the fake buys time against the blitz.';
      if (deep === 1 && press && f) return `The one deep safety has to pick the post or the deep crosser. The men covering your backs join the rush once the backs stay in to block, so a blitz brings as many as you have blockers, and with only three out ${first}.`;
      return deep === 1 ? 'The one deep safety has to pick the post or the deep crosser, and the linebackers step up for the fake.'
        : 'Linebackers who step up for the fake leave the deep crosser room behind them.';
    }
    case 'screen':
      return L.walked || zero ? 'Men walked up to come: let them through and flip it to the back behind them, with linemen out in front.'
        : 'Let the rushers through and flip it to the back behind them, with three linemen out in front.';
    default: return pl.blurb;
  }
}
// How a success reads on this down: "gains 4 yards or more" on first or second down, "makes the first down" on third or
// fourth; and on defense, the other way round.
const gains = sit => (sit.down >= 3 ? 'makes the first down' : `gains ${needed(sit)} yards or more`);
const holds = sit => (sit.down >= 3 ? 'stops his plays short of the first down' : `holds his plays under ${needed(sit)} yards`);

// The men who stay in to block on your pass play, before any defense is there to block: the line, and the backs and
// tight ends who stay in or check for a blitzer first (see S.protection in js/sim.js). Lined up against nobody in
// particular, so it can't depend on his call.
function protection(v) {
  const S = prepare({ formation: v.formation, play: v.play, flip: false, motion: v.motion, hot: v.hot || {}, front: 'over', coverage: 'c2', pressure: 'four', blitzer: 'M', disguise: false, sit: v.sit }, 1);
  return S.protection.length;
}

// ---------------------------------------------------------------- the read

// view, calling the offense: { side: 'O', formation, flip, motion, play, hot, sit, front, players, quiz }: your call,
// the situation, their front (named on the board), and everyone where he stands before the snap; quiz: the question
// after the snap is on, so the read leaves out what coverage it probably is.
// view, calling the defense: { side: 'D', formation, flip, sit, call }: his formation and strong side, the situation,
// and your own call (to mark the pick it is, if it is one).
// The read: { side, key, lede, likelyShort, likely (null while the quiz is on), showing, tips, picksTitle, picks: [{
// label, set, rate, rateText, reason, current }], numbers }: lede and likelyShort are the read in a line each, likely
// and showing in full; set is the call a pick's chip sets, rate how often it's a success against the look (calling the
// defense, how often the call holds his plays short of one, and long how often one goes 15 yards or more against it).
export function coachRead(v) {
  return v.side === 'D' ? defenseRead(v) : offenseRead(v);
}

function offenseRead(v) {
  const sit = byId(SITUATIONS, v.sit), fm = byId(FORMATIONS, v.formation), pl = byId(PLAYS, v.play);
  const L = lookOf(v.players, v.front);
  const prot = pl.type === 'pass' && pl.drop !== 'screen' ? protection(v) : 0;
  const box = `${cap(word(L.box))} in the box (near the line, where they play the run)`;
  const showing = [
    FRONT_WORDS[v.front],
    DEEP_WORDS[L.deep],
    CORNER_WORDS[L.corners],
    pl.type === 'run' ? `${box} against your ${word(L.blockers)} blockers: ${L.blockers > L.box ? 'more blockers than defenders' : L.blockers === L.box ? 'a blocker for each of them' : L.box - L.blockers === 1 ? 'one more than you can block' : `${word(L.box - L.blockers)} more than you can block`}.`
      : prot ? `${box}, and ${word(prot)} in your protection (the men who stay in to block)${L.box > prot ? `: if more than ${word(prot)} come, someone is free, and the ball has to come out quickly` : ''}.`
        : `${box}. The screen lets the rushers through on purpose.`,
  ];
  if (L.walked) showing.push(`${cap(word(L.walked))} ${L.walked === 1 ? 'man off the line has' : 'men off the line have'} walked up inside 4 yards of it: ${L.walked === 1 ? 'he' : 'they'} might be coming.`);
  const lede = `${cap(DEEP_SHORT[L.deep])}, ${CORNER_SHORT[L.corners]}, ${word(L.box)} in the box${L.walked ? `, ${word(L.walked)} walked up` : ''}.`;
  const quiz = 'The quiz after the snap is on, so naming the coverage is up to you.';
  const read = { side: 'O', key: L.key, lede, likelyShort: v.quiz ? quiz : '', likely: null, showing, tips: [], picksTitle: `Worth a look on ${sit.name}, and how often each ${gains(sit)} against this look:`, picks: [], numbers: '' };
  if (!fresh()) return read;
  const alike = lookAlikes(fm.id, v.front, L.key, sit);
  if (!alike.length) return read;
  // What it probably is: the coverages that look this way, likeliest first, and how often a blitz comes with it.
  const covs = new Map();
  let blitz = 0;
  for (const { code, p } of alike) {
    const [, c, pressure, , d] = code.split('.');
    covs.set(`${c}.${d}`, (covs.get(`${c}.${d}`) || 0) + p);
    if (pressure === 'blitz') blitz += p;
  }
  const list = [...covs].sort((a, b) => b[1] - a[1]).map(([k, p]) => { const [c, d] = k.split('.'); return { c, d: d === '1', p }; });
  const named = list.filter(x => x.p >= 0.05), gloss = x => `${coverName(x.c, x.d)} (${x.d ? `lined up two deep, rotating at the snap into ${COVER_WORDS[x.c]}` : COVER_WORDS[x.c]})`;
  const likely = [named.length === 1 && named[0].p >= 0.95 ? `That's how ${gloss(named[0])} lines up here.`
    : `Most likely ${gloss(named[0])}, ${tens(named[0].p)}${named.length > 1 ? `; or ${or(named.slice(1).map(x => `${gloss(x)}, ${tens(x.p)}`))}` : ''}.`];
  const allZero = list.every(x => x.c === 'c0');
  likely.push(allZero ? 'Everyone not covering a man comes after the quarterback.' : blitz >= 0.95 ? 'And a blitz: five or more coming after the quarterback.'
    : blitz < 0.05 ? 'They rush four.' : blitz > 0.5 ? `A blitz (five or more coming) ${tens(blitz)}.` : `Usually four rushing; a blitz (five or more coming) ${tens(blitz)}.`);
  if (!v.quiz) {
    read.likely = likely;
    const one = named.length === 1 && named[0].p >= 0.95;
    read.likelyShort = (one ? `That's how ${coverName(named[0].c)} lines up here.` : `Probably ${or(named.map(x => (x.d ? `a disguised ${coverName(x.c)}` : coverName(x.c))))}.`)
      + (allZero ? ' Everyone else comes.' : blitz >= 0.95 ? ' And a blitz.' : blitz < 0.05 ? ' Four rushing.' : ` A blitz ${times(blitz)}.`);
  }
  // Tips: a two-deep look that can be a disguise, and the motion that tells man from zone, when the look could be
  // either. (With the question on, whenever they could apply, so that one showing up doesn't give anything away.)
  if (L.deep === 2 && (v.quiz || list.some(x => x.d))) read.tips.push('Two deep can be a disguise: a safety rotates down at the snap. Read the safeties again once the ball is snapped.');
  const man = list.some(x => x.c === 'c0' || x.c === 'c1'), zone = list.some(x => !['c0', 'c1'].includes(x.c));
  if (fm.motion && v.motion === 'none' && (v.quiz || (man && zone))) read.tips.push(`Not sure? Send the ${fm.motion.who} in motion: if a defender runs across with him, it's man coverage; if they only slide over, it's zone.`);
  const top = rankPlays(fm.id, alike, sit).slice(0, 3), isRun = id => byId(PLAYS, id).type === 'run';
  read.picks = top.map(({ id, rate: r }, n) => ({
    label: byId(PLAYS, id).name, set: { play: id }, rate: r, rateText: times(r), current: id === v.play,
    reason: reasonFor(id, L, L.blockers, top.slice(0, n).some(x => isRun(x.id)), fm),
  }));
  const moving = v.motion === 'across' || v.motion === 'jet', hot = Object.keys(v.hot || {}).length > 0;
  if (moving || hot) read.numbers = `The numbers are for each play as it's drawn${moving ? ', with nobody in motion' : ''}${hot ? ', without your route changes' : ''}.`;
  return read;
}

function defenseRead(v) {
  const sit = byId(SITUATIONS, v.sit), fm = byId(FORMATIONS, v.formation), Lm = lean(sit);
  const [backs, ends] = [...fm.personnel].map(Number); // (Empty's back is split out, but he's a back)
  const blockers = fm.players.filter(([, x, , cls]) => cls === 'ol' || cls === 'fb' || (cls === 'te' && Math.abs(x) < 8)).length;
  const qb = fm.under ? 'under center' : fm.id === 'pistol' ? 'in the pistol, 4 yards back, with the back right behind him' : 'in the shotgun, 5 yards back';
  const many = (n, w) => `${word(n)} ${w}${n === 1 ? '' : 's'}`;
  const plays = playMix(fm.id, Lm), run = plays.filter(([id]) => byId(PLAYS, id).type === 'run').reduce((a, [, p]) => a + p, 0);
  const m = motionShare(fm.id, Lm);
  const showing = [
    `${fm.name}: ${fm.personnel} personnel (${many(backs, 'back')} and ${many(ends, 'tight end')}), the quarterback ${qb}, strength to your ${v.flip ? 'right' : 'left'}.`,
    fm.blurb,
    run ? `On ${sit.name} he runs from here ${times(run)}, and throws the rest.` : 'From here he can only throw.',
  ];
  if (m) showing.push(`About ${Math.round(m * 10)} snaps in 10 he sends the ${fm.motion.who} in motion first.`);
  const runs = plays.filter(([id]) => byId(PLAYS, id).type === 'run').map(([id]) => (id === 'draw' ? 'the Draw' : byId(PLAYS, id).name));
  const passes = plays.length - runs.length;
  const likely = [run ? `A run ${times(run)}: ${or(runs)}, about equally. Otherwise one of his ${word(passes)} pass plays.` : `A pass: one of his ${word(passes)} pass plays, about equally.`];
  const lede = `${fm.name}, ${fm.personnel} personnel, strength to your ${v.flip ? 'right' : 'left'}: ${!run ? 'a pass' : tenths(run) > 5 ? 'leaning run' : tenths(run) < 5 ? 'leaning pass' : 'run or pass about evenly'}.`;
  const likelyShort = run ? `A run ${times(run)}, a pass the rest.` : 'A pass: there\'s no back to hand it to.';
  const read = { side: 'D', key: fm.id, lede, likelyShort, likely, showing, tips: [`Two backs or two tight ends lean run; four receivers lean pass.${fm.motion ? ' Watch for motion: in man coverage the man covering him has to run across with him.' : ''}`], picksTitle: `Worth a look on ${sit.name}: how often each ${holds(sit)} from here, and how often he goes 15 yards or more against it:`, picks: [], numbers: '' };
  if (!fresh()) return read;
  // The best calls, each a different coverage or rush from the ones above it (the best front for it), so three picks
  // aren't one call from three fronts.
  const picks = [];
  for (const x of rankDefenses(fm.id, sit)) if (picks.length < 3 && !picks.some(y => y.code.split('.').slice(1, 3).join() === x.code.split('.').slice(1, 3).join())) picks.push(x);
  const leans = !run ? 'a formation that can only throw' : tenths(run) > 5 ? 'a formation that leans run' : tenths(run) < 5 ? 'a formation that leans pass' : 'a formation that runs about half the time';
  read.picks = picks.map(({ call, code, rate: r, long }) => {
    const [front, coverage, pressure] = code.split('.'), L = unkey(TABLE.looks[fm.id][call]), zero = coverage === 'c0';
    const set = { front, coverage, pressure, blitzer: 'M', disguise: false };
    const c = v.call || {}, current = c.front === front && c.coverage === coverage && (zero || (c.pressure === pressure && (pressure === 'four' || c.blitzer === 'M') && !c.disguise));
    const rush = zero ? 'everyone not covering a man coming' : pressure === 'blitz' ? 'five coming' : 'four rushing';
    const why = run && tenths(run) >= 5 && L.box > blockers ? `more defenders near the line than he can block, against ${leans}`
      : run && tenths(run) >= 5 && L.box === blockers ? `a man near the line for each of his blockers, against ${leans}`
        : L.deep ? `help deep against ${leans}` : `pressure on ${leans}`;
    // (with nobody deep, a run that gets through goes a long way: the drill's note on stopping the run says so too)
    const risk = zero ? ' With nobody deep, though, a play that gets through can go a long way.' : '';
    return {
      label: `${byId(FRONTS, front).name}, ${byId(COVERAGES, coverage).name}${zero ? '' : pressure === 'blitz' ? ', blitz' : ', rush four'}`,
      set, rate: r, long, rateText: `${times100(r)}; 15 yards or more ${share100(long)}`, current,
      reason: `${cap(word(L.box))} in the box against his ${word(blockers)} blockers, ${DEEP_SHORT[L.deep]}, ${rush}: ${why}.${risk}`,
    };
  });
  if (m) read.numbers = 'The numbers count his motion too, as often as he sends it.';
  return read;
}
