// Uses the app in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { DRILLS } from '../js/playbook.js';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the end). With
// `cut` set to a file, the connection goes down right after it's served.
let net = 'up', release = false, cut = null;
const held = [];
const server = createServer((req, res) => {
  if (net === 'down') { req.socket.destroy(); return; }
  if (net === 'stalled') { held.push([req, res]); return; }
  serve(req, res);
}).listen(0);
async function serve(req, res) {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  let body;
  try { body = await readFile(join(root, path)); } catch { res.writeHead(404); res.end(); return; }
  if (release && path === '/sw.js') body = Buffer.from(String(body).replace(/const FILES = '[0-9a-f]*'/, "const FILES = 'next'"));
  if (release && path === '/index.html') body = Buffer.concat([body, Buffer.from('<!-- the next release -->\n')]);
  if (release && path === '/js/sim.js') body = Buffer.concat([body, Buffer.from('// the next release\n')]);
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); } else { res.writeHead(200, head); res.end(body); }
  if (cut === path) net = 'down';
}
const base = `http://localhost:${server.address().port}/`;
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};

const browser = await pw.chromium.launch();
// Every file of this site a page asks for, in every context the test opens (the service worker's own requests aside).
// Each one has to be in the offline copy (see the end).
const asked = new Set();
const newContext = browser.newContext.bind(browser);
// The question after the snap ("What did they play?", on unless it's turned off) holds the other coach's call back until
// it's answered. It has a test of its own (with { quiz: true }); everywhere else a fresh visit has it turned off, so his
// call comes out at the snap, as it does with the switch off.
browser.newContext = async ({ quiz = false, ...options } = {}) => {
  const c = await newContext(options);
  if (!quiz) {
    await c.addInitScript(() => {
      try {
        const s = JSON.parse(localStorage.getItem('chalk-talk.v1') || '{}');
        if (!('quiz' in s)) localStorage.setItem('chalk-talk.v1', JSON.stringify({ ...s, quiz: false }));
      } catch { /* no storage */ }
    });
  }
  c.on('request', r => { if (r.url().startsWith(base) && !r.serviceWorker()) asked.add(new URL(r.url()).pathname); });
  return c;
};
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
const page = await ctx.newPage();
const problems = [];
page.on('pageerror', e => problems.push(e.message));
page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page.on('requestfailed', r => problems.push('failed: ' + r.url()));
page.on('request', r => { if (!r.url().startsWith(base)) problems.push('left the site: ' + r.url()); });

await page.goto(base);
await page.evaluate(() => document.fonts.ready);

// Before the snap the other coach's call is hidden everywhere: the board says so, the chart marks none of its rows, and
// a defender's card keeps his job back.
const tapOn = label => page.evaluate(label => {
  const { board, state } = window.chalkTalk;
  const i = state.play.players.findIndex(p => p.label === label);
  const r = board.cv.getBoundingClientRect(), p = board.pos(board.t, i);
  return { x: r.left + board.sx(p.x), y: r.top + board.sy(p.y) };
}, label).then(at => page.mouse.click(at.x, at.y));
assert.match(await page.textContent('#matchup'), /coverage hidden/, 'the board says the coverage is hidden');
// It says what to do with the read: call the play that beats it, and they keep their call.
assert.match(await page.textContent('#theirsHint'), /change your play and they keep their call/, 'the card says you can change your play after the read');
// The first thing to do, before the first snap: until a player is tapped or the play is snapped.
const HINT = 'Tap any player to see his job, then Snap.';
assert.equal(await page.textContent('#caption'), HINT, 'the board says what to do first');
// The clock beside the scrubber has nothing to count before the snap. On a phone it starts the scrubber's own row,
// under Snap.
assert.equal(await page.textContent('#clock'), '–', 'the clock before the snap');
{
  const at = await page.evaluate(() => Object.fromEntries(['clock', 'scrub', 'snap'].map(id => { const b = document.getElementById(id).getBoundingClientRect(); return [id, { l: b.left, r: b.right, t: b.top, b: b.bottom }]; })));
  assert.ok(at.clock.r <= at.scrub.l && Math.abs((at.clock.t + at.clock.b) / 2 - (at.scrub.t + at.scrub.b) / 2) < 3, `the clock isn't just left of the scrubber: ${JSON.stringify(at)}`);
  assert.ok(at.clock.t >= at.snap.b && at.clock.l < 30, `the clock and the scrubber aren't on a row of their own: ${JSON.stringify(at)}`);
}
await page.getByRole('radio', { name: 'Four Verticals' }).click();
assert.equal(await page.textContent('#caption'), HINT, 'the first hint stays when the call changes');
await page.getByRole('radio', { name: 'Smash' }).click();
// Before the snap every coverage gets a four-man rush, but Cover 0's row blitzes, as Cover 0 always does: the chart
// says so.
assert.match(await page.textContent('#chartHint'), /^How often your play succeeds on 1st & 10, gaining 4 yards or more, from Gun Trips against a .+ front rushing four \(Cover 0 always blitzes\)\. Beside each bar, the average yards a play\. /);
// Before it runs, the chart shows the rows it will fill: every coverage, with an empty track.
assert.deepEqual(await page.$$eval('#bars .bar-row.idle', r => r.map(x => [x.getAttribute('role'), x.getAttribute('aria-label'), x.querySelector('.bar-val').textContent])),
  ['Cover 0', 'Cover 1', 'Cover 2', 'Cover 3', 'Cover 4'].map(c => ['listitem', `${c}: not run yet`, '–']), 'the chart before it runs');
await page.click('#runChart');
assert.match(await page.textContent('#runChart'), /^Running… [1-5] of 5$/, 'the chart says how far along it is');
await page.waitForFunction(() => document.getElementById('runChart').getAttribute('aria-disabled') !== 'true' && document.querySelectorAll('#bars .bar-row:not(.waiting):not(.idle)').length === 5, null, { timeout: 60000 });
assert.equal(await page.locator('#bars .bar-row.mine').count(), 0, 'the chart gives away their coverage before the snap');
assert.equal(await page.locator('#bars .bar-row.idle').count(), 0, 'rows still waiting to run once it has run');
assert.equal(await page.textContent('#runChart'), 'Run it again', 'once it has run, the button says it runs again');
// Each bar is the share of snaps that gained 4 yards or more, the number on it; the average yards is the small one.
assert.equal(await page.textContent('#bars .bar-head'), 'success · avg yards');
for (const row of await page.$$eval('#bars .bar-row', r => r.map(x => ({ title: x.title, val: x.querySelector('.bar-val').textContent.replace(/\s+/g, ' '), small: x.querySelector('.bar-val small').textContent, width: parseFloat(x.querySelector('.bar').style.width) })))) {
  const [, pct, avg] = row.title.match(/: (\d+)% successful, (−?\d+\.\d) yards a play, over 100 snaps$/);
  assert.equal(row.val, `${pct}% ${avg}`, `the number on the bar is its success rate: ${row.title}`);
  assert.equal(row.small, avg, 'the average yards is the small number');
  assert.ok(Math.abs(row.width - Math.max(0.6, +pct)) < 0.6, `the bar is as long as its success rate: ${row.title}, ${row.width}%`);
}
await tapOn('FS');
assert.match(await page.textContent('#whoPos'), /Free safety/, 'tapping the free safety opens his card');
assert.equal(await page.textContent('#caption'), '', 'the first hint goes once a player is tapped');
assert.match(await page.textContent('#whoJob'), /hidden until the snap/, 'a defender\'s job is hidden before the snap');

// Snap a play: it runs, and the result card explains it. Their call is out: the chart marks it. On a phone the
// tapped player's card closes, so the play can be seen (on a bigger board it says what he's doing: see below).
await page.click('#snap');
assert.equal(await page.locator('#bars .bar-row.mine').count(), 1, 'the chart marks their coverage once it is out');
// A screen reader hears what the eye gets from the board: their call at the snap, and how the play came out at the end.
assert.match(await page.textContent('#say'), /^They called: .+\.$/, 'their call is said at the snap');
assert.equal(await page.isVisible('#who'), false, 'on a phone the card closes at the snap');
assert.equal(await page.evaluate(() => window.chalkTalk.board.selected), -1, 'and nobody is picked out');
// Part way through, the scrubber is part way along too.
const mid = await page.waitForFunction(() => {
  const { state, board } = window.chalkTalk, s = document.getElementById('scrub');
  if (state.phase !== 'playing' || state.t < Math.min(1.5, board.duration() * 0.4)) return false;
  return { at: +s.value / +s.max, played: state.t / board.duration() };
}, null, { timeout: 15000 }).then(h => h.jsonValue());
assert.ok(Math.abs(mid.at - mid.played) < 0.05, `the scrubber is at ${mid.at.toFixed(2)} of the way with ${mid.played.toFixed(2)} of the play shown`);
await page.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
// The line that ended the play stays up on the board a moment, to be read (the board stops 0.7 s after it), while the
// result card is in under the board at once.
const ending = await page.evaluate(() => ({
  caption: document.getElementById('caption').lastElementChild?.textContent,
  last: window.chalkTalk.state.play.events.filter(e => e.kind !== 'shed').at(-1).text,
  why: !document.getElementById('why').hidden,
}));
assert.equal(ending.caption, ending.last, 'the line that ended the play went from the board as soon as the play ended');
assert.equal(ending.why, false, 'the button to the explanation came up over the play\'s last line at once');
assert.ok((await page.textContent('#resHead')).trim().length > 3, 'the result has a headline');
assert.ok(await page.$$eval('#story li', li => li.length) >= 1, 'the play-by-play has at least one line');
assert.ok((await page.textContent('#note')).trim().length > 40, 'the coach\'s note is there');
// It says how the call does in general, and then how this snap went.
assert.match(await page.textContent('#note'), /^How .+ (does against Cover \d|works): [A-Z]/);
assert.match(await page.textContent('#noteNow'), /^This time: [a-z].+\.$/);
assert.match(await page.textContent('#theirsHint'), /They called/, 'their call is shown after the snap');
assert.equal(await page.textContent('#say'), `${await page.textContent('#resHead')}. ${await page.textContent('#resKicker')}. Why it worked is under the board.`);
// One name for one thing: Snap again is a new snap of the same calls, here and in the result card, and it says so. The
// play button watches this one again.
assert.equal(await page.textContent('#snap'), 'Snap again');
assert.equal(await page.textContent('#again'), 'Snap again');
assert.equal(await page.getAttribute('#play', 'aria-label'), 'Watch it again', 'at the end the play button watches it again');
assert.equal(await page.textContent('#actionsNote'), 'Snap again: the same two calls, played out fresh. New look: the other coach changes his call.');
// Then the board shows the headline, and a button down to the explanation, fading in.
await until(() => page.isVisible('#why'), 3000, 'the board points to the explanation when the play ends');
assert.equal(await page.textContent('#caption'), '', 'the button takes the place of the play\'s last line');
assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('why')).animationName), 'why-in', 'the button to the explanation fades in');
// (shortened where it's measured against the first down: "Gain of 6, 2 short", "Gain of 12, first down")
const shortHead = h => h.replace(/ yards?, (\d+) short of the first down$/, ', $1 short').replace(/(\+?) yards? and a first down$/, '$1, first down');
assert.equal((await page.textContent('#why')).replace(/\s+/g, ' ').trim(), `${shortHead(await page.textContent('#resHead'))} · Why ↓`);

// The scrubber reaches the whole play: halfway is halfway, and the far end is the end of the play.
const scrub = to => page.evaluate(to => {
  const s = document.getElementById('scrub'), { state, board } = window.chalkTalk;
  s.value = String(to === 'max' ? s.max : Math.round(to * s.max));
  s.dispatchEvent(new Event('input'));
  return { t: state.t, duration: board.duration(), phase: state.phase, result: !document.getElementById('result').hidden, why: !document.getElementById('why').hidden, clock: document.getElementById('clock').textContent };
}, to);
const half = await scrub(0.5);
assert.ok(Math.abs(half.t - half.duration / 2) < 0.1, `halfway along the scrubber shows ${half.t.toFixed(2)} s of a ${half.duration.toFixed(2)} s play`);
// The clock says where you are, the way the play-by-play says its times.
assert.equal(half.clock, `${half.t.toFixed(1)}s`, 'the clock halfway through the play');
assert.ok(await page.$$eval('#story .t', t => t.every(x => /^\d+\.\ds$/.test(x.textContent))), 'the play-by-play\'s times are written another way');
assert.equal(half.why, false, 'the button to the explanation goes away when you scrub back into the play');
const end = await scrub('max');
assert.equal(end.t, end.duration, 'the far end of the scrubber is the end of the play');
assert.equal(end.clock, `${end.duration.toFixed(1)}s`, 'the clock at the end of the play');
assert.equal(end.phase, 'done', 'the far end of the scrubber finishes the play');
assert.ok(end.result, 'the result shows at the far end of the scrubber');
assert.ok(end.why, 'the button to the explanation comes back at the far end of the scrubber');

// Tapping it brings the explanation up just under the board, which stays at the top of a phone.
await page.click('#why');
await until(async () => {
  const [a, b] = [await page.evaluate(() => scrollY), await new Promise(r => setTimeout(r, 150)).then(() => page.evaluate(() => scrollY))];
  return a > 0 && a === b;
}, 5000, 'the page did not scroll to the explanation');
const where = await page.evaluate(() => ({ top: document.getElementById('result').getBoundingClientRect().top, under: document.querySelector('.stage').getBoundingClientRect().bottom, height: innerHeight }));
assert.ok(where.top >= where.under && where.top < where.height - 100, `the explanation's top is at ${Math.round(where.top)} px, with the board ending at ${Math.round(where.under)} px of ${where.height}`);
await page.evaluate(() => scrollTo(0, 0));

// Tap a player: his card says who he is and what he did. (At the snap: the board follows the ball, so after a long
// gain the quarterback can be off the board.)
await scrub(0);
await tapOn('QB');
assert.match(await page.textContent('#whoPos'), /Quarterback/, 'tapping the quarterback opens his card');
await page.click('#whoClose');

// New look always changes their call, even from the likeliest one against three receivers (Nickel, Cover 3, rush four).
const looks = await page.evaluate(() => {
  const { state } = window.chalkTalk;
  let same = 0;
  for (let k = 0; k < 30; k++) {
    Object.assign(state.def, { front: 'nickel', coverage: 'c3', pressure: 'four', disguise: false });
    document.getElementById('newLook').click();
    if (state.def.front === 'nickel' && state.def.coverage === 'c3' && state.def.pressure === 'four') same++;
  }
  return { same, phase: state.phase };
});
assert.equal(looks.same, 0, `New look gave the same call ${looks.same} times in 30`);
assert.equal(looks.phase, 'pre', 'New look lines up a new play');

// Call the defense instead: the choosers swap and the board turns around.
await page.click('[data-side="D"]');
assert.match(await page.textContent('#mineTitle'), /defense/);
assert.equal(await page.evaluate(() => window.chalkTalk.board.flip), true, 'the board turns to the defense\'s view');
await page.getByRole('radio', { name: 'Cover 0' }).click();
assert.equal(await page.evaluate(() => window.chalkTalk.state.def.coverage), 'c0');
assert.equal(await page.getByRole('radio', { name: 'Blitz' }).isDisabled(), true, 'Cover 0 always blitzes');

// The chart runs every play against this defense: eleven rows, waiting until it does.
assert.equal(await page.locator('#bars .bar-row.idle').count(), 11, 'the defense\'s chart before it runs');
assert.equal(await page.textContent('#runChart'), 'Run it 100 times each', 'a chart for the other side is a new one');
await page.click('#runChart');
await page.waitForFunction(() => document.querySelectorAll('#bars .bar-row:not(.waiting):not(.idle)').length === 11, null, { timeout: 30000 });

// The headline and the verdict over it round the same way: the simulator spots the ball to the half yard, and a
// 3.5-yard run reads "Gain of 4 yards", the line where a play counts as a win for the offense on 1st & 10.
const close = await page.evaluate(() => {
  const { state, board, simulate, lineUp, finish } = window.chalkTalk;
  Object.assign(state.off, { formation: 'iform', play: 'iz', flip: false, motion: 'none' });
  Object.assign(state.def, { front: 'over', coverage: 'c3', pressure: 'four', disguise: false });
  for (let seed = 1; seed < 3000; seed++) {
    const res = simulate({ ...state.off, ...state.def }, seed).result;
    if (res.kind !== 'run' || res.yards !== 3.5) continue;
    state.seed = seed; lineUp(); state.t = board.duration(); finish();
    return { seed, head: document.getElementById('resHead').textContent, kicker: document.getElementById('resKicker').textContent };
  }
});
assert.ok(close, 'no 3.5-yard run in 3,000 snaps of Inside Zone');
assert.equal(close.head, 'Gain of 4 yards, 6 short of the first down', `seed ${close.seed}`);
assert.equal(close.kicker, 'A win for the offense', `"Gain of 4 yards" under "${close.kicker}" (seed ${close.seed})`);
// A gain short of that says why it's a win for the defense, so it doesn't look like a mistake.
const short = await page.evaluate(() => {
  const { state, board, simulate, lineUp, finish } = window.chalkTalk;
  for (let seed = 1; seed < 3000; seed++) {
    const res = simulate({ ...state.off, ...state.def }, seed).result;
    if (res.kind !== 'run' || res.yards !== 3) continue;
    state.seed = seed; lineUp(); state.t = board.duration(); finish();
    return { seed, head: document.getElementById('resHead').textContent, kicker: document.getElementById('resKicker').textContent };
  }
});
assert.equal(short?.head, 'Gain of 3 yards, 7 short of the first down');
assert.equal(short.kicker, 'A win for the defense: short of the 4\u00a0yards that make a play a success', `"Gain of 3 yards" under "${short.kicker}" (seed ${short.seed})`);
// The verdict says a big play (a run of 10 yards or more, a catch of 20 or more) and a takeaway for what they are,
// and a 3-yard gain why it's the defense's. The headline says how far short of the first down a gain was, or that it
// made one. Both go by the down: a success is 40% of the yards to go on first down, 60% on second (4 of 6, in whole
// yards) and all of them on third and fourth, where a 6-yard gain on 3rd & 8 is a win for the defense; and on fourth
// down, anything short of the first down hands the ball over. Each is a shared play: one that no longer comes out this
// way (after a change to the simulator) needs another seed that does.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  for (const [code, head, kicker, win] of [
    ['O.single.iz.0.over.c3.four.1', 'Gain of 3 yards, 7 short of the first down', 'A win for the defense: short of the 4\u00a0yards that make a play a success', 'D'],
    ['O.trips.smash.0.nickel.c3.four.65', 'Intercepted', 'A takeaway for the defense', 'D'],
    ['O.trips.smash.0.nickel.c2.four.262', 'Gain of 19 yards and a first down', 'A win for the offense', 'O'],
    ['O.trips.smash.0.nickel.c2.four.10', 'Gain of 20 yards and a first down', 'A big play for the offense', 'O'],
    ['D.single.iz.0.over.c3.four.579', 'Gain of 9 yards, 1 short of the first down', 'A win for the offense', 'O'],
    ['D.single.iz.0.over.c3.four.8', 'Gain of 10 yards and a first down', 'A big play for the offense', 'O'],
    ['O.single.iz.0.over.c3.four.1.0.none.2and6', 'Gain of 3 yards, 3 short of the first down', 'A win for the defense: short of the 4\u00a0yards that make a play a success', 'D'],
    ['O.single.iz.0.over.c3.four.2.0.none.2and6', 'Gain of 4 yards, 2 short of the first down', 'A win for the offense', 'O'],
    ['O.single.iz.0.over.c3.four.1.0.none.3and2', 'Gain of 3 yards and a first down', 'A win for the offense', 'O'],
    ['O.single.iz.0.over.c3.four.47.0.none.3and8', 'Gain of 6 yards, 2 short of the first down', 'A win for the defense: short of the first down', 'D'],
    ['D.single.iz.0.over.c3.four.8.0.none.3and8', 'Gain of 10 yards and a first down', 'A big play for the offense', 'O'],
    ['O.trips.smash.0.nickel.c3.four.1.0.none.3and8', 'Incomplete', 'A win for the defense', 'D'],
    ['O.single.iz.0.over.c3.four.11.0.none.4and1', 'Gain of 1 yard and a first down', 'A win for the offense', 'O'],
    ['O.single.iz.0.over.c3.four.10.0.none.4and1', 'No gain', 'A win for the defense: a turnover on downs', 'D'],
    ['O.trips.smash.0.nickel.c3.four.1.0.none.4and1', 'Incomplete', 'A win for the defense: a turnover on downs', 'D'],
    ['O.trips.smash.0.nickel.c3.four.65.0.none.4and1', 'Intercepted', 'A takeaway for the defense', 'D'],
  ]) {
    await p.evaluate(code => { location.hash = `#p=${code}`; }, code);
    await p.waitForFunction(seed => { const { state } = window.chalkTalk; return state.seed === seed && state.phase === 'playing'; }, +code.split('.')[7], { timeout: 5000 });
    const seen = await p.evaluate(() => {
      const s = document.getElementById('scrub'); s.value = s.max; s.dispatchEvent(new Event('input'));
      const k = document.getElementById('resKicker');
      return { head: document.getElementById('resHead').textContent, kicker: k.textContent, win: k.dataset.win, vs: document.getElementById('resVs').textContent };
    });
    assert.equal(seen.head, head, `#p=${code} no longer shows this: pick another seed`);
    const down = { '2and6': '2nd & 6', '3and2': '3rd & 2', '3and8': '3rd & 8', '4and1': '4th & 1' }[code.split('.')[10]] || '1st & 10';
    assert.ok(seen.vs.startsWith(`On ${down}, `), `#p=${code}: "${seen.vs}" doesn't say the down`);
    delete seen.vs;
    assert.deepEqual(seen, { head, kicker, win }, `#p=${code}`);
  }
  // On the RB Screen the line lets the rushers through on purpose, so the pre-snap read doesn't say one came unblocked
  // as if the protection had failed.
  for (const code of ['O.trips.screen.0.over.c2.four.77', 'D.iform.screen.1.nickel.c3.blitz.5', 'O.single.screen.0.34.c0.blitz.9']) {
    await p.evaluate(code => { location.hash = `#p=${code}`; }, code);
    await p.waitForFunction(seed => { const { state } = window.chalkTalk; return state.seed === seed && state.phase === 'playing'; }, +code.split('.').at(-1), { timeout: 5000 });
    const reads = await p.evaluate(() => {
      const s = document.getElementById('scrub'); s.value = s.max; s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('#reads li')].map(li => li.textContent);
    });
    const rush = reads.find(r => r.startsWith('Rush:')) ?? '';
    assert.match(rush, /^Rush: \d rushers, and the line lets them through on purpose: that's the screen\./, `#p=${code}`);
    assert.ok(!reads.some(r => /came unblocked|in protection/.test(r)), `#p=${code}: ${reads.join(' | ')}`);
  }
  await p.close();
}

// A shared link opens the exact same play. Copying it says so on the button.
await page.click('[data-side="O"]');
await page.click('#snap');
await page.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
const head = await page.textContent('#resHead');
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.click('#share');
await page.waitForFunction(() => document.getElementById('share').textContent === 'Link copied' || !document.getElementById('shareUrl').hidden);
const link = await page.evaluate(async () => { const box = document.getElementById('shareUrl'); return box.hidden ? navigator.clipboard.readText() : box.value; });
assert.match(link, /#p=O\./, 'the share link has the play in it');
// Where there's no clipboard to copy it to, the link is there to copy by hand, picked out ready.
await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
await page.click('#share');
assert.equal(await page.textContent('#shareMsg'), 'Couldn\'t copy it here. Copy this link:');
assert.deepEqual(await page.evaluate(() => { const box = document.activeElement; return { id: box.id, value: box.value, picked: box.selectionStart === 0 && box.selectionEnd === box.value.length }; }),
  { id: 'shareUrl', value: link, picked: true }, 'the link is focused and selected, ready to copy');

const page2 = await ctx.newPage();
page2.on('pageerror', e => problems.push(e.message));
page2.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
page2.on('requestfailed', r => problems.push('failed: ' + r.url()));
await page2.goto(base + link.slice(link.indexOf('#')));
await page2.waitForSelector('#result:not([hidden])', { timeout: 15000 });
assert.equal(await page2.textContent('#resHead'), head, 'the shared link replays the same result');
assert.match(await page2.textContent('#theirsHint'), /^A shared play: both calls are shown/, 'it says it is a shared play');
// Another link opened in the same tab plays that one.
await page2.evaluate(() => { location.hash = '#p=D.iform.power.1.34.c1.blitz.777'; });
await page2.waitForFunction(() => { const { state } = window.chalkTalk; return state.side === 'D' && state.off.play === 'power' && state.seed === 777 && state.phase !== 'pre'; }, null, { timeout: 5000 })
  .catch(() => assert.fail('a second link opened in the same tab did nothing'));
assert.equal(await page2.evaluate(() => location.hash), '', 'the link leaves the address once it is open');
// A link this version can't open says so, clears itself from the address, and leaves the play alone.
await page2.evaluate(() => { location.hash = '#p=O.trips.nosuch.0.nickel.c2.four.15'; });
await page2.waitForFunction(() => location.hash === '', null, { timeout: 5000 }).catch(() => assert.fail('a bad link stays in the address'));
assert.equal(await page2.textContent('#theirsHint'), 'That link is for a play this version doesn\'t have.');
assert.equal(await page2.textContent('#say'), 'That link is for a play this version doesn\'t have.', 'a screen reader hears it too');
assert.equal(await page2.evaluate(() => window.chalkTalk.state.off.play), 'power', 'a bad link changes the play');
// One cut short (a messaging app can do that to a long link) says so, rather than that it's for a play from elsewhere.
await page2.evaluate(() => { location.hash = '#p=O.trips.sm'; });
await page2.waitForFunction(() => location.hash === '', null, { timeout: 5000 }).catch(() => assert.fail('a cut-off link stays in the address'));
assert.equal(await page2.textContent('#theirsHint'), 'That link is cut off or garbled, so there\'s no play to show. Ask for it again.');
assert.equal(await page2.evaluate(() => window.chalkTalk.state.off.play), 'power', 'a cut-off link changes the play');
await page2.click('#snap');
assert.doesNotMatch(await page2.textContent('#theirsHint'), /That link/, 'the word about the bad link stays after the next snap');
// Opening links doesn't turn off "Let the other coach pick" for next time, even once you change a call.
await page2.getByRole('radio', { name: 'Cover 2' }).click();
assert.equal(await page2.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).auto), true, 'opening a link turned off "Let the other coach pick" for good');
await page2.close();

// The words on the board sit over the deep field, where nobody is for most of the play, not on the backfield: at the top
// when you call the offense, and at the bottom when you call the defense and the board is turned around. And there's
// room behind the offense for the quarterback's label on a deep drop.
for (const side of ['O', 'D']) {
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + `#p=${side}.iform.pa.0.over.c1.four.7`);
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  await p.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
  for (const t of [0, 1.6]) {
    const seen = await p.evaluate(t => {
      const { state, board } = window.chalkTalk, s = document.getElementById('scrub');
      if (t) { s.disabled = false; s.value = String(Math.round(t / board.duration() * +s.max)); s.dispatchEvent(new Event('input')); }
      const cv = board.cv.getBoundingClientRect();
      // A player's mark and his label, which sits on one side of it or the other (see Board.players()).
      const r = board.radius(), fs = Math.max(8.5, Math.min(12, r * 1.15)), tall = r + fs * 1.15;
      const backs = state.play.players.filter(q => ['QB', 'RB', 'FB'].includes(q.label)).map(q => {
        const at = board.pos(board.t, q.i), x = cv.left + board.sx(at.x), y = cv.top + board.sy(at.y);
        return { label: q.label, l: x - r - 4, r: x + r + 4, t: y - tall, b: y + tall };
      });
      const words = ['matchup', 'caption'].map(id => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(id));
        return [...range.getClientRects()].map(b => ({ id, l: b.left, r: b.right, t: b.top, b: b.bottom }));
      }).flat();
      const on = words.flatMap(w => backs.filter(q => w.l < q.r && q.l < w.r && w.t < q.b && q.t < w.b).map(q => `${w.id} on the ${q.label}`));
      const out = backs.filter(q => q.t < cv.top || q.b > cv.bottom).map(q => `the ${q.label} off the edge`);
      return { on: [...on, ...out], caption: document.getElementById('caption').textContent };
    }, t);
    assert.deepEqual(seen.on, [], `calling the ${side === 'O' ? 'offense' : 'defense'}, at ${t} s`);
    if (t) assert.ok(seen.caption.length > 5, `a caption at ${t} s`);
  }
  // At the end, the button down to the explanation stays on the board and off the ball.
  const end = await p.evaluate(() => {
    const { board } = window.chalkTalk, s = document.getElementById('scrub');
    s.value = s.max; s.dispatchEvent(new Event('input'));
    const cv = board.cv.getBoundingClientRect(), b = document.getElementById('why').getBoundingClientRect();
    const { a } = board.at(board.t), x = cv.left + board.sx(a.ball[0]), y = cv.top + board.sy(a.ball[1]);
    return { inside: b.left >= cv.left && b.right <= cv.right && b.top >= cv.top && b.bottom <= cv.bottom, onBall: x > b.left - 6 && x < b.right + 6 && y > b.top - 6 && y < b.bottom + 6 };
  });
  assert.deepEqual(end, { inside: true, onBall: false }, `the button at the end, calling the ${side === 'O' ? 'offense' : 'defense'}`);
  await p.close();
}

// Before the snap every label can be read on a phone: none is on another player's mark (under center the center's
// label would be on the quarterback, and in the I the fullback's on the tailback), every formation against every front
// and shell, calling either side. And each label is knocked out of the lines under it: a stroke in the board's colour
// round the letters, drawn before any of the letters, so none cuts into the next.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const seen = await p.evaluate(() => {
    const { board, state, simulate, lineUp } = window.chalkTalk, ctx = board.ctx, on = [];
    for (const formation of ['iform', 'single', 'doubles', 'trips']) for (const front of ['over', 'under', '34', 'nickel']) for (const coverage of ['c1', 'c3']) for (const side of ['O', 'D']) {
      const play = simulate({ formation, play: 'power', flip: false, front, coverage, pressure: 'four' }, 3);
      board.setPlay(play); board.t = 0; board.flip = side === 'D'; board.render();
      const r = board.radius(), fs = board.labelSize();
      ctx.font = `700 ${fs}px "Barlow Condensed", "Arial Narrow", sans-serif`;
      const marks = play.players.map(q => { const z = board.pos(0, q.i); return [board.sx(z.x), board.sy(z.y)]; });
      for (const q of play.players) {
        const [x, y] = board.drawn?.[q.i] ?? [marks[q.i][0], marks[q.i][1] + board.labelDy(q)], w = ctx.measureText(q.label).width;
        for (const o of play.players) {
          const [X, Y] = marks[o.i], over = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
          if (o !== q && over(x - w / 2, x + w / 2, X - r * 0.8, X + r * 0.8) && over(y - fs * 0.38, y + fs * 0.38, Y - r * 0.8, Y + r * 0.8)) on.push(`${side} ${formation} v ${front} ${coverage}: ${q.label} on the ${o.label}`);
        }
      }
    }
    // the knock-outs, as the board draws them
    const calls = [], { strokeText, fillText } = ctx;
    ctx.strokeText = function (t, ...a) { calls.push(['stroke', t, this.strokeStyle]); return strokeText.call(this, t, ...a); };
    ctx.fillText = function (t, ...a) { calls.push(['fill', t]); return fillText.call(this, t, ...a); };
    board.flip = state.side === 'D'; lineUp();
    delete ctx.strokeText; delete ctx.fillText;
    const n = state.play.players.length, mine = calls.filter(c => state.play.players.some(q => q.label === c[1]));
    const strokes = mine.filter(c => c[0] === 'stroke');
    return { on, players: n, strokes: strokes.length, colours: [...new Set(strokes.map(c => c[2]))], board: board.colors.board, first: mine.findIndex(c => c[0] === 'fill') >= strokes.length };
  });
  assert.deepEqual(seen.on, [], 'labels on another player\'s mark before the snap');
  assert.equal(seen.strokes, seen.players, 'a label without its knock-out');
  assert.ok(seen.board && seen.colours.length === 1 && seen.colours[0] === (await p.evaluate(c => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; return x.fillStyle; }, seen.board)), `the labels' knock-outs are ${seen.colours}, the board is ${seen.board}`);
  assert.ok(seen.first, 'a label drawn before every knock-out was');
  await p.close();
}

// The man the caption names is ringed on the board while his line is up, scrubbing as well as playing: the receiver at
// the throw. Nobody is ringed before the snap or once the caption makes way for the headline.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  const ring = await p.evaluate(() => {
    const { state, board, pause, lineUp } = window.chalkTalk, s = document.getElementById('scrub');
    pause(); lineUp();
    const before = board.spot;
    const throwEv = state.play.events.find(e => e.kind === 'throw');
    s.disabled = false; s.value = String(Math.round((throwEv.t + 0.05) / board.duration() * +s.max)); s.dispatchEvent(new Event('input'));
    const at = { spot: board.spot, who: throwEv.who, caption: document.getElementById('caption').textContent.includes(throwEv.text) };
    s.value = s.max; s.dispatchEvent(new Event('input'));
    return { before, ...at, end: board.spot };
  });
  assert.equal(ring.before, -1, 'somebody is ringed before the snap');
  assert.ok(ring.caption, 'the throw is in the caption');
  assert.equal(ring.spot, ring.who, 'at the throw the ring is on somebody other than the receiver');
  assert.equal(ring.end, -1, 'somebody is still ringed once the headline replaces the caption');
  // Right after the snap the caption names the blitzers, and every one of them is ringed.
  await p.goto(base + '#p=O.trips.smash.0.nickel.c0.blitz.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  const blitz = await p.evaluate(() => {
    const { state, board, pause, lineUp } = window.chalkTalk, s = document.getElementById('scrub');
    pause(); lineUp();
    const b = state.play.events.find(e => e.kind === 'blitz');
    s.disabled = false; s.value = '3'; s.dispatchEvent(new Event('input')); // 0.15 s in
    return { text: b.text, all: b.all, rung: board.spotAll, caption: document.getElementById('caption').textContent };
  });
  assert.match(blitz.text, /^Cover 0: the .+ and the .+ blitz\.$/);
  assert.ok(blitz.caption.includes(blitz.text), `just after the snap the caption says "${blitz.caption}"`);
  assert.deepEqual(blitz.rung, blitz.all, 'the blitzers the caption names aren\'t all ringed');
  await p.close();
}

// The coach's note says how this snap went, from what happened on it: on a pass, the man he threw to and the yards the
// headline gives, or the man who broke it up, picked it off or sacked him; on a run, the box count and the man who made
// the tackle.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.waitForFunction(() => window.chalkTalk);
  const bad = await p.evaluate(() => {
    const { state, lineUp, finish, board } = window.chalkTalk, out = [], seen = new Set();
    const F = ['iform', 'single', 'doubles', 'trips'], PL = ['iz', 'oz', 'power', 'draw', 'verts', 'smash', 'flood', 'mesh', 'slants', 'pa', 'screen'];
    const FR = ['over', 'under', '34', 'nickel'], CV = ['c0', 'c1', 'c2', 'c3', 'c4'];
    const short = { DT: 'the defensive tackle', NT: 'the nose', M: 'the Mike', W: 'the Will', S: 'the Sam', J: 'the Jack', FS: 'the free safety', SS: 'the strong safety', NB: 'the nickel back', CB: 'a corner', DE: 'a defensive end' };
    state.auto = false;
    for (let k = 0; k < 220; k++) {
      state.off = { formation: F[k % 4], play: PL[k % 11], flip: k % 2 === 1 };
      state.def = { front: FR[(k * 7) % 4], coverage: CV[(k * 3) % 5], pressure: k % 3 ? 'four' : 'blitz' };
      state.seed = 7100 + k;
      lineUp(); state.t = board.duration(); finish();
      const P = state.play, res = P.result, now = document.getElementById('noteNow').textContent, head = document.getElementById('resHead').textContent;
      const say = why => out.push(`${state.off.play}/${state.def.coverage} seed ${state.seed}: ${why}: "${now}" (${head})`);
      if (!/^This time: .+\.$/.test(now)) { say('not a sentence'); continue; }
      const yards = head.match(/(\d+)\+? yards?/)?.[1];
      if (yards && res.kind !== 'sack' && !now.includes(` ${yards}`)) say('not the headline\'s yards');
      const end = res.by >= 0 && res.kind !== 'catch' && P.players[res.by].label; // after a catch, the yards are what count
      if (end && !now.includes(short[end]) && !(end === 'DE' && /side end/.test(now))) say('not the man who ended it');
      const thrown = P.events.find(e => e.kind === 'throw');
      if (thrown) { const r = P.players[thrown.who]; if (!now.includes(r.cls === 'te' ? `(${r.label})` : r.label === 'RB' ? 'running back' : r.label === 'FB' ? 'fullback' : `the ${r.label} `)) say('not the man he threw to'); }
      if (res.kind === 'sack' && !/sacked him/.test(now)) say('a sack, unsaid');
      if (k % 11 < 4 && !/ in the box/.test(now)) say('a run without the box count');
      seen.add(res.kind);
    }
    // A throwaway after reads that were covered says how many (Four Verticals against Nickel Cover 3, seed 2: two).
    state.off = { formation: 'trips', play: 'verts', flip: false };
    state.def = { front: 'nickel', coverage: 'c3', pressure: 'four' };
    state.seed = 2;
    lineUp(); state.t = board.duration(); finish();
    const away = { kind: state.play.result.kind, now: document.getElementById('noteNow').textContent };
    return { out, seen: [...seen].sort(), away };
  });
  assert.deepEqual(bad.out, [], 'the This time line in the coach\'s note');
  assert.deepEqual(bad.away, { kind: 'throwaway', now: 'This time: with his first two reads covered, he threw it away rather than take a sack.' });
  assert.ok(['catch', 'incomplete', 'run', 'sack'].every(k => bad.seen.includes(k)), `only these kinds of ending came up: ${bad.seen}`);
  await p.close();
}

// Two things that happen close together both stay up long enough to read: the caption shows the last two from the
// last 2.2 seconds, the older one above. It follows the clock, so scrubbing back and forth shows the same words.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const seen = await p.evaluate(() => {
    const { state, board, simulate, lineUp } = window.chalkTalk, s = document.getElementById('scrub');
    Object.assign(state, { side: 'O', auto: false });
    Object.assign(state.off, { formation: 'iform', play: 'oz', flip: false, motion: 'none' });
    Object.assign(state.def, { front: 'over', coverage: 'c3', pressure: 'four', disguise: false });
    let a, b;
    for (let seed = 1; seed < 500 && !b; seed++) {
      const r = simulate({ ...state.off, ...state.def }, seed), evs = r.events.filter(e => e.kind !== 'shed');
      // two lines between 0.2 and 1 second apart, and nothing else until after the first has gone, mid-play
      const k = evs.findIndex((e, n) => n && e.t - evs[n - 1].t > 0.2 && e.t - evs[n - 1].t < 1 && !(evs[n + 1]?.t < evs[n - 1].t + 2.4) && evs[n - 1].t + 2.4 < r.frames.at(-1).t);
      if (k > 0) { state.seed = seed; [a, b] = [evs[k - 1], evs[k]]; }
    }
    lineUp();
    const at = t => {
      s.disabled = false; s.value = String(Math.round(t / board.duration() * +s.max)); s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('#caption span')].map(x => x.textContent);
    };
    // A line still up when the next one comes stays put, so a screen reader doesn't read it out again.
    const span = text => [...document.querySelectorAll('#caption span')].find(x => x.textContent === text);
    at(a.t + 0.05);
    const first = span(a.text);
    const both = at(b.t + 0.1), kept = !!first && span(a.text) === first;
    return { a: a.text, b: b.text, both, kept, before: at((a.t + b.t) / 2), later: at(a.t + 2.3), again: at(b.t + 0.1) };
  });
  assert.ok(seen.kept, 'the older line was put up again when the newer one came, so a screen reader reads it twice');
  assert.deepEqual(seen.both, [seen.a, seen.b], 'the caption shows the last two, the older one first');
  assert.ok(seen.before.at(-1) === seen.a && !seen.before.includes(seen.b), 'scrubbing back shows only what had happened by then');
  assert.deepEqual(seen.later, [seen.b], 'the older one goes after 2.2 seconds, and the newer one is still up');
  assert.deepEqual(seen.again, seen.both, 'the same moment shows the same caption');
  await p.close();
}

// The player's card on a phone: who he is and his job, at the end of the board away from him so it doesn't hide him,
// before the snap and during the play. What the position is in general is a tap away, and a tap on the card that
// misses its buttons goes through to the board.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  await p.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
  const spot = label => p.evaluate(label => {
    const { board, state } = window.chalkTalk;
    const i = state.play.players.findIndex(q => q.label === label);
    const r = board.cv.getBoundingClientRect(), q = board.pos(board.t, i);
    return { x: r.left + board.sx(q.x), y: r.top + board.sy(q.y), r: board.radius() };
  }, label);
  const card = () => p.evaluate(() => {
    const b = document.getElementById('who').getBoundingClientRect(), cv = document.getElementById('board').getBoundingClientRect();
    return { l: b.left, r: b.right, t: b.top, b: b.bottom, share: b.height / cv.height, shown: !document.getElementById('who').hidden };
  });
  for (const t of [0, 1.6]) {
    if (t) await p.evaluate(t => { const s = document.getElementById('scrub'), { board } = window.chalkTalk; s.value = String(Math.round(t / board.duration() * +s.max)); s.dispatchEvent(new Event('input')); }, t);
    for (const label of ['QB', 'LT', 'FS']) {
      if (await p.isVisible('#who')) await p.click('#whoClose'); // the last card could be over him
      const at = await spot(label);
      await p.mouse.click(at.x, at.y);
      const c = await card();
      assert.match(await p.textContent('#whoPos'), new RegExp(`^${label} ·`), `tapping the ${label} at ${t} s opens his card`);
      assert.ok(!(at.x > c.l && at.x < c.r && at.y + at.r > c.t && at.y - at.r < c.b), `the ${label}'s card covers him at ${t} s`);
      assert.ok(c.share < 0.46, `the ${label}'s card takes ${Math.round(c.share * 100)}% of the board`);
    }
  }
  assert.equal(await p.isVisible('#whoAbout'), false, 'what the position is in general waits to be asked for');
  await p.click('#whoMore');
  assert.equal(await p.isVisible('#whoAbout'), true, 'More about him shows what the position is');
  assert.equal(await p.getAttribute('#whoMore', 'aria-expanded'), 'true');
  await p.click('#whoMore');
  // A tap on the card where there's no player under it closes it, the way a tap on the empty field does.
  const empty = await p.evaluate(() => {
    const { board, state } = window.chalkTalk, cv = board.cv.getBoundingClientRect(), c = document.getElementById('who').getBoundingClientRect();
    const spots = state.play.players.map(q => { const at = board.pos(board.t, q.i); return [cv.left + board.sx(at.x), cv.top + board.sy(at.y)]; });
    for (let y = c.top + 10; y < c.bottom - 10; y += 4) for (let x = c.left + 10; x < c.right - 60; x += 4) {
      const el = document.elementFromPoint(x, y);
      if (el.closest('button')) continue;
      if (spots.every(([sx, sy]) => Math.hypot(sx - x, sy - y) > 30)) return { x, y };
    }
  });
  assert.ok(empty, 'no empty field under the card to tap');
  await p.mouse.click(empty.x, empty.y);
  assert.equal(await p.isVisible('#who'), false, 'a tap on the card over empty field goes through and closes it');
  await p.close();
}
// On a phone the card closes whenever the play starts to run, not only at the snap: at ▶ after a pause or a scrub, and
// at ↺ Watch it again. Left up, it sits over the caption saying what's happening.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  const tap = async label => {
    const at = await p.evaluate(label => {
      const { board, state } = window.chalkTalk, i = state.play.players.findIndex(q => q.label === label);
      const r = board.cv.getBoundingClientRect(), q = board.pos(board.t, i);
      return { i, x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) };
    }, label);
    for (let n = 0; n < 4 && await p.evaluate(() => window.chalkTalk.board.selected) !== at.i; n++) await p.mouse.click(at.x, at.y);
    assert.match(await p.textContent('#whoPos'), new RegExp(`^${label} ·`), `tapping the ${label}`);
  };
  const closed = async what => assert.deepEqual(await p.evaluate(() => ({ phase: window.chalkTalk.state.phase, shown: !document.getElementById('who').hidden, picked: window.chalkTalk.board.selected })),
    { phase: 'playing', shown: false, picked: -1 }, `on a phone the card stays up over the play ${what}`);
  await p.waitForFunction(() => window.chalkTalk.state.t > 1, null, { timeout: 10000 });
  await p.click('#play');
  await tap('RT');
  await p.click('#play');
  await closed('when it goes on after a pause');
  await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = '20'; s.dispatchEvent(new Event('input')); });
  await tap('RT');
  await p.click('#play');
  await closed('when it goes on after a scrub');
  await p.waitForFunction(() => window.chalkTalk.state.phase === 'done', null, { timeout: 15000 });
  await tap('RT');
  await p.click('#play');
  await closed('when it is watched again');
  // Watched again, or scrubbed back, while the play's last line is still up, the button down to the explanation
  // doesn't come up later over the play.
  const why = () => p.evaluate(() => ({ phase: window.chalkTalk.state.phase, why: !document.getElementById('why').hidden }));
  await new Promise(r => setTimeout(r, 1600));
  assert.deepEqual(await why(), { phase: 'playing', why: false }, 'the button to the explanation came up while the play was watched again');
  await p.waitForFunction(() => window.chalkTalk.state.phase === 'done', null, { timeout: 15000 });
  await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = '20'; s.dispatchEvent(new Event('input')); });
  await new Promise(r => setTimeout(r, 1600));
  assert.deepEqual(await why(), { phase: 'paused', why: false }, 'the button to the explanation came up after a scrub back into the play');
  await p.close();
}
// Where the card goes on a phone: at the end of the play, a lineman's or the quarterback's card stays off the button
// down to the explanation, on either side of the ball. Before the snap a safety's card doesn't cover the formation
// (his deep spot is near the middle of a phone's board, and the card is a third of it): it covers three others at most,
// and never him.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  const box = sel => p.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; }, sel);
  const tap = async label => {
    const at = await p.evaluate(label => {
      const { board, state } = window.chalkTalk, i = state.play.players.findIndex(q => q.label === label);
      const r = board.cv.getBoundingClientRect(), q = board.pos(board.t, i);
      return { i, x: r.left + board.sx(q.x), y: r.top + board.sy(q.y), r: board.radius() };
    }, label);
    await p.evaluate(() => { window.chalkTalk.board.selected = -1; document.getElementById('who').hidden = true; });
    for (let n = 0; n < 4 && await p.evaluate(() => window.chalkTalk.board.selected) !== at.i; n++) await p.mouse.click(at.x, at.y);
    assert.match(await p.textContent('#whoPos'), new RegExp(`^${label} ·`), `tapping the ${label}`);
    const c = await box('#who');
    assert.ok(!(at.x > c.l && at.x < c.r && at.y + at.r > c.t && at.y - at.r < c.b), `the ${label}'s card covers him`);
    return { ...at, c };
  };
  for (const side of ['O', 'D']) {
    const team = side === 'O' ? 'offense' : 'defense';
    await p.goto(base + `#p=${side}.trips.smash.0.nickel.c2.four.262`);
    await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
    await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = s.max; s.dispatchEvent(new Event('input')); });
    const why = await box('#why');
    for (const label of ['LT', 'RT', 'QB']) {
      const { c } = await tap(label);
      assert.ok(!(c.l < why.r && why.l < c.r && c.t < why.b && why.t < c.b), `calling the ${team}, the ${label}'s card at the end of the play is over the button down to the explanation (card ${Math.round(c.t)}-${Math.round(c.b)}, button ${Math.round(why.t)}-${Math.round(why.b)})`);
    }
    for (const link of [`#p=${side}.trips.smash.0.nickel.c2.four.262`, `#p=${side}.iform.iz.0.over.c3.four.15`]) {
      await p.evaluate(link => { location.hash = link; }, link);
      await p.waitForFunction(() => window.chalkTalk.state.phase === 'playing');
      await p.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
      for (const label of ['FS', 'SS']) {
        const at = await tap(label);
        const hid = await p.evaluate(([i, c]) => {
          const { board, state } = window.chalkTalk, cv = board.cv.getBoundingClientRect();
          return state.play.players.filter(q => q.i !== i).filter(q => { const z = board.pos(board.t, q.i), x = cv.left + board.sx(z.x), y = cv.top + board.sy(z.y); return x > c.l && x < c.r && y > c.t && y < c.b; }).length;
        }, [at.i, at.c]);
        assert.ok(hid <= 3, `${link}: the ${label}'s card before the snap covers ${hid} other players`);
      }
    }
  }
  await p.close();
}
// A tap just off a button on the board, on a player, picks the player: 4 px under More about with the card at the top
// end, and 4 px under the Why button. (Chromium sends a tap that near a button to the button, and a real fingertip
// covers more than a point.) A tap on either button still works.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  await p.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
  const players = () => p.evaluate(() => {
    const { board, state } = window.chalkTalk, cv = board.cv.getBoundingClientRect();
    return state.play.players.map(q => { const z = board.pos(board.t, q.i); return { i: q.i, label: q.label, x: cv.left + board.sx(z.x), y: cv.top + board.sy(z.y) }; });
  });
  const box = sel => p.evaluate(sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; }, sel);
  const lg = (await players()).find(q => q.label === 'LG');
  for (let n = 0; n < 4 && await p.evaluate(() => window.chalkTalk.board.selected) !== lg.i; n++) await p.mouse.click(lg.x, lg.y);
  assert.equal(await p.evaluate(() => document.getElementById('who').classList.contains('top')), true, 'the LG\'s card is at the top end');
  let more = await box('#whoMore');
  const card = await box('#who');
  const under = (await players()).filter(q => q.i !== lg.i && q.x > more.l + 6 && q.x < more.r - 6 && q.y > card.b).sort((a, b) => a.y - b.y)[0];
  assert.ok(under, 'nobody under More about');
  // the card moved down the few pixels that put him 4 px under the button
  await p.evaluate(dy => { const w = document.getElementById('who'); w.style.top = `${parseFloat(getComputedStyle(w).top) + dy}px`; }, under.y - 4 - more.b);
  more = await box('#whoMore');
  await p.touchscreen.tap(under.x, more.b + 4);
  assert.deepEqual(await p.evaluate(() => ({ picked: window.chalkTalk.board.selected, more: document.getElementById('whoMore').getAttribute('aria-expanded') })),
    { picked: under.i, more: 'false' }, `a tap 4 px under More about, on the ${under.label}`);
  more = await box('#whoMore');
  await p.touchscreen.tap((more.l + more.r) / 2, (more.t + more.b) / 2);
  assert.equal(await p.getAttribute('#whoMore', 'aria-expanded'), 'true', 'a tap on More about');
  await p.touchscreen.tap((more.l + more.r) / 2, (more.t + more.b) / 2);
  await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = s.max; s.dispatchEvent(new Event('input')); window.chalkTalk.board.selected = -1; document.getElementById('who').hidden = true; });
  const why = await box('#why'), w = why.r - why.l;
  const q = (await players()).filter(o => o.y > why.b + 20 && o.x > w / 2 + 20 && o.x < 370 - w / 2).sort((a, b) => a.y - b.y)[0];
  assert.ok(q, 'nobody to put under the Why button');
  // the button moved to just over him
  await p.evaluate(([x, y]) => {
    const el = document.getElementById('why'), b = el.getBoundingClientRect(), cv = document.getElementById('board').getBoundingClientRect();
    el.style.transform = 'none'; el.style.left = `${x - cv.left - b.width / 2}px`; el.style.top = `${y - 4 - b.height - cv.top}px`;
  }, [q.x, q.y]);
  const at = await box('#why');
  await p.touchscreen.tap(q.x, at.b + 4);
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(await p.evaluate(() => ({ picked: window.chalkTalk.board.selected, scrolled: scrollY, focus: document.activeElement.id })),
    { picked: q.i, scrolled: 0, focus: '' }, `a tap 4 px under the Why button, on the ${q.label}`);
  await p.touchscreen.tap((at.l + at.r) / 2, (at.t + at.b) / 2);
  await until(() => p.evaluate(() => document.activeElement.id === 'resHead' && scrollY > 0), 3000, 'a tap on the Why button did nothing');
  // Just off the button over empty field, with nobody there to pick, the tap is still the button's. (Back at the top
  // once the smooth scroll down to the result has finished.)
  for (let a = -1, b = -2; a !== b;) { a = await p.evaluate(() => scrollY); await new Promise(r => setTimeout(r, 200)); b = await p.evaluate(() => scrollY); }
  await p.evaluate(() => { scrollTo(0, 0); document.activeElement.blur(); window.chalkTalk.board.selected = -1; document.getElementById('who').hidden = true; });
  await until(() => p.evaluate(() => scrollY === 0), 3000, 'the page didn\'t go back to the top');
  const empty = await p.evaluate(() => {
    const { board, state } = window.chalkTalk, cv = board.cv.getBoundingClientRect(), el = document.getElementById('why'), b = el.getBoundingClientRect();
    const marks = state.play.players.map(q => { const z = board.pos(board.t, q.i); return [cv.left + board.sx(z.x), cv.top + board.sy(z.y)]; });
    for (let y = cv.top + 8; y < cv.bottom - b.height - 16; y += 4) for (let x = cv.left + b.width / 2 + 8; x < cv.right - b.width / 2 - 8; x += 4) {
      if (marks.every(([X, Y]) => Math.hypot(X - x, Y - (y + b.height + 4)) > 40)) {
        el.style.transform = 'none'; el.style.left = `${x - cv.left - b.width / 2}px`; el.style.top = `${y - cv.top}px`;
        return { x, y: y + b.height + 4 };
      }
    }
    return null;
  });
  assert.ok(empty, 'no empty field to put the Why button over');
  await p.touchscreen.tap(empty.x, empty.y);
  await until(() => p.evaluate(() => document.activeElement.id === 'resHead' && scrollY > 0), 3000, 'a tap just off the Why button, over empty field, did nothing');
  await c.close();
}
// On a crowded line a fingertip covers two or three players: tapping the same spot again picks the next one there,
// nearest first, instead of closing the card. A tap that lands a little off a lineman reaches him in two taps, or three
// where two others are nearer still (under center the quarterback is 4.5 px behind the center on a phone).
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.iform.power.0.over.c3.four.15');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  await p.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
  const spots = await p.evaluate(() => {
    const { board, state } = window.chalkTalk, r = board.cv.getBoundingClientRect();
    return state.play.players.filter(q => ['ol', 'dl', 'de'].includes(q.cls)).map(q => { const at = board.pos(0, q.i); return { i: q.i, label: q.label, x: r.left + board.sx(at.x), y: r.top + board.sy(at.y) }; });
  });
  assert.ok(spots.length >= 8, 'the linemen');
  const picked = () => p.evaluate(() => window.chalkTalk.board.selected);
  const c = spots.find(q => q.label === 'C');
  await p.mouse.click(c.x, c.y);
  const first = await picked();
  await p.mouse.click(c.x, c.y);
  const second = await picked();
  assert.ok(second >= 0 && second !== first && await p.isVisible('#who'), 'tapping the same spot on the line again picks a neighbour and keeps the card open');
  const missed = [];
  for (const q of spots) for (let k = 0; k < 8; k++) {
    const x = q.x + 6 * Math.cos(k * Math.PI / 4), y = q.y + 6 * Math.sin(k * Math.PI / 4);
    await p.evaluate(() => { window.chalkTalk.board.selected = -1; document.getElementById('who').hidden = true; });
    await p.mouse.click(x, y);
    for (let n = 1; n < 3 && await picked() !== q.i; n++) await p.mouse.click(x, y);
    if (await picked() !== q.i) missed.push(`${q.label} from ${k * 45}°`);
  }
  assert.deepEqual(missed, [], 'linemen not picked in three taps 6 px off them');
  await p.close();
}

// On a bigger board the card stays through the snap and says what the player is doing, once their call is out.
{
  const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await wide.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.evaluate(() => { const { board, state } = window.chalkTalk; const i = state.play.players.findIndex(q => q.label === 'FS'); const r = board.cv.getBoundingClientRect(), q = board.pos(0, i); window.fsAt = { x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) }; });
  const at = await p.evaluate(() => window.fsAt);
  await p.mouse.click(at.x, at.y);
  assert.match(await p.textContent('#whoJob'), /hidden until the snap/, 'a defender\'s job is hidden before the snap');
  await p.click('#snap');
  assert.match(await p.textContent('#whoJob'), /^On this play:/, 'the card shows his job once the play is snapped');
  assert.equal(await p.isVisible('#whoMore'), false, 'a bigger board shows the whole card');
  assert.equal(await p.isVisible('#whoAbout'), true);
  // The quarterback's card goes at the deep end of the board, away from him, where the caption and the button down to
  // the explanation are: on a bigger board it stands clear of both, so they can still be read and tapped.
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.262');
  await p.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  const qb = await p.evaluate(() => {
    const { state, board, pause } = window.chalkTalk, s = document.getElementById('scrub');
    pause();
    const ev = state.play.events.find(e => e.kind !== 'shed');
    s.value = String(Math.round((ev.t + 0.05) / board.duration() * +s.max)); s.dispatchEvent(new Event('input'));
    const i = state.play.players.findIndex(q => q.label === 'QB');
    const r = board.cv.getBoundingClientRect(), q = board.pos(board.t, i);
    return { x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) };
  });
  await p.mouse.click(qb.x, qb.y);
  const clear = await p.evaluate(() => {
    const { state, board, finish } = window.chalkTalk, who = document.getElementById('who');
    const under = el => { const b = el.getBoundingClientRect(), c = who.getBoundingClientRect(); return b.left < c.right && c.left < b.right && b.top < c.bottom && c.top < b.bottom; };
    const seen = { card: document.getElementById('whoPos').textContent.split(' ')[0], top: who.classList.contains('top'), caption: under(document.querySelector('#caption span')) };
    state.t = board.duration(); finish();
    const b = document.getElementById('why').getBoundingClientRect();
    return { ...seen, open: !who.hidden, why: !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('#why') };
  });
  assert.deepEqual(clear, { card: 'QB', top: true, caption: false, open: true, why: true }, 'on a bigger board the card at the deep end hides the caption or the button down to the explanation');
  // The chart's button stays beside its heading while it runs, its longest words included, so the chart under it
  // doesn't jump down and back up.
  const chartHead = () => p.evaluate(() => Math.round(document.querySelector('.chart-head').getBoundingClientRect().height));
  const idleHead = await chartHead();
  await p.click('#runChart');
  await p.waitForFunction(() => document.getElementById('runChart').textContent.startsWith('Running… 100 of 100'), null, { timeout: 30000 });
  assert.equal(await chartHead(), idleHead, `at 1280 px the chart's button goes under its heading while it reads "${await p.textContent('#runChart')}"`);
  await wide.close();
}

// On a computer the result card comes up at the top of the right-hand column, beside the board, as the play ends, and
// the button on the board points across to it. A change of call takes it away and the calls are back at the top, and
// they don't jump up the screen: the chip just picked stays where it was, from the middle of the screen and from its
// foot, or as near as the page scrolls. On a phone (or a window made narrow) it comes after the calls, under the board.
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const where = () => p.evaluate(() => {
    const box = id => document.getElementById(id).getBoundingClientRect(), r = document.getElementById('result');
    return { first: r.parentElement.firstElementChild.id, after: r.previousElementSibling?.id, shown: !r.hidden, result: box('result').top + scrollY, left: box('result').left, mine: box('mine').top + scrollY, column: box('drills').top + scrollY, board: document.querySelector('.board-wrap').getBoundingClientRect() };
  });
  // (the top of the column is the drills, over your call)
  const { mine: top, column } = await where();
  await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; window.chalkTalk.snap(); state.t = board.duration(); finish(); });
  const done = await where();
  assert.ok(done.shown && done.first === 'result', `at 1280 px the result card isn't first in the right-hand column: ${JSON.stringify(done)}`);
  assert.ok(Math.abs(done.result - column) <= 1 && done.result < done.board.top + 40 && done.left >= done.board.right, `at 1280 px the result card is at ${Math.round(done.left)}, ${Math.round(done.result)} px, not at the top beside the board`);
  assert.match(await p.textContent('#why'), /Why →$/, 'the button on the board doesn\'t point across to the result');
  assert.match(await p.textContent('#say'), /beside the board/, 'a screen reader isn\'t told the result is beside the board');
  // picked from the middle of the screen, then from its foot (where the page can't scroll back far enough)
  for (const [id, foot] of [['iz', false], ['oz', true]]) {
    if (foot) await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; window.chalkTalk.snap(); state.t = board.duration(); finish(); scrollTo(0, 0); });
    const chip = p.locator(`[data-key="Play:${id}"]`);
    await chip.evaluate((el, foot) => { scrollBy(0, foot ? el.getBoundingClientRect().bottom - innerHeight + 4 : el.getBoundingClientRect().top - innerHeight / 2); }, foot);
    const before = await p.evaluate(id => ({ chip: document.querySelector(`[data-key="Play:${id}"]`).getBoundingClientRect().top, y: scrollY }), id);
    assert.ok(before.y > 0 && before.chip > 0 && before.chip < 800, `the chip for ${id} isn't on screen under the result card: ${JSON.stringify(before)}`);
    await chip.click();
    const changed = await where();
    assert.ok(!changed.shown && Math.abs(changed.mine - top) <= 1, `after a change of call at 1280 px your call is ${Math.round(changed.mine)} px down the page, not back at the top (${Math.round(top)} px)`);
    const seen = await p.evaluate(id => ({ chip: document.querySelector(`[data-key="Play:${id}"]`).getBoundingClientRect().top, mine: document.getElementById('mine').getBoundingClientRect().top, y: scrollY }), id);
    assert.ok(Math.abs(seen.chip - before.chip) <= 2 || (seen.y === 0 && seen.mine >= 0), `the chip just picked went from ${Math.round(before.chip)} px to ${Math.round(seen.chip)} px on the screen (scrolled ${seen.y} px)`);
  }
  await p.setViewportSize({ width: 800, height: 900 }); // (the page hears of it at its next frame)
  await until(async () => (await where()).after === 'jobs', 3000, 'in a narrow window the result card isn\'t after the calls and every player\'s job');
  await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; window.chalkTalk.snap(); state.t = board.duration(); finish(); });
  assert.match(await p.textContent('#why'), /Why ↓$/, 'in a narrow window the button on the board doesn\'t point down to the result');
  await p.setViewportSize({ width: 1280, height: 800 });
  await until(async () => (await where()).first === 'result', 3000, 'back at 1280 px the result card isn\'t first in the right-hand column');
  await c.close();
}

// The smallest phones (320 px wide): after the first snap, when the button reads "Snap again", every control under
// the board still fits, and nothing scrolls sideways.
for (const width of [320, 360, 375]) {
  const small = await browser.newContext({ viewport: { width, height: 568 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await small.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  let tall = 0;
  for (const when of ['before', 'after']) {
    if (when === 'after') await p.evaluate(() => { window.chalkTalk.snap(); window.chalkTalk.finish(); scrollTo(0, 0); });
    const fit = await p.evaluate(() => ({
      wide: document.documentElement.scrollWidth - innerWidth,
      out: [...document.querySelectorAll('.transport > *')].filter(el => { const b = el.getBoundingClientRect(); return b.left < 0 || b.right > innerWidth || b.width < 24; }).map(el => el.id || el.className),
      scrub: document.getElementById('scrub').getBoundingClientRect().width,
      tall: document.querySelector('.transport').offsetHeight,
    }));
    if (when === 'before') tall = fit.tall;
    else assert.equal(fit.tall, tall, `${width} px wide: the controls take another row after the snap`);
    assert.equal(fit.wide, 0, `${width} px wide, ${when} the snap: the page scrolls sideways`);
    assert.deepEqual(fit.out, [], `${width} px wide, ${when} the snap: controls cut off`);
    assert.ok(fit.scrub > width / 2, `${width} px wide, ${when} the snap: the scrubber is ${Math.round(fit.scrub)} px`);
  }
  await small.close();
}

// On a touch screen the things to tap are 44 px or so (the chips 42), and the speed buttons' 31 px pills, and the
// 30 px Key beside the scrubber on a phone, take a tap 44 px tall.
{
  const sizes = await page.evaluate(() => {
    const short = (sel, min) => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length && e.id !== 'keyOpen').map(e => e.getBoundingClientRect()).filter(b => b.height < min).length;
    const reaches = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return [-21, 21].every(dy => document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2 + dy)?.closest(sel)); };
    return { coarse: matchMedia('(pointer: coarse)').matches, chips: short('.chip', 40), buttons: short('.ghost, .side-pick button, .tool, .switch', 44), reach: reaches('[data-speed="1"]') && reaches('#keyOpen') };
  });
  assert.ok(sizes.coarse, 'the phone context has a touch screen');
  assert.deepEqual(sizes, { coarse: true, chips: 0, buttons: 0, reach: true }, 'tap targets on a touch screen');
}

// The playbook's technique numbers: listed in order across the line, each one explained once without repeating its
// name, and the diagram's 5, 7 and 6 far enough apart not to read as "57".
{
  const tech = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.pb')].find(x => x.querySelector('summary').textContent === 'Fronts and techniques');
    const rows = [...d.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]).filter(([t]) => /technique|2i/.test(t));
    const x = Object.fromEntries([...d.querySelectorAll('svg text:not(.gap):not(.pos)')].map(t => [t.textContent, +t.getAttribute('x')]));
    return { terms: rows.map(([t]) => t), repeats: rows.filter(([t, v]) => v.toLowerCase().includes(t.toLowerCase())).map(([t]) => t), gaps: [x[7] - x[5], x[6] - x[7]] };
  });
  assert.deepEqual(tech.terms, ['0-technique', '1-technique', '2-technique', '3-technique', '4-technique', '5-technique', 'Wide 5-technique', '7-technique', '6-technique', '9-technique', '2i and 4i']);
  assert.deepEqual(tech.repeats, [], 'a technique explained by its own name');
  assert.ok(tech.gaps.every(g => g >= 12), `the diagram's 5, 7 and 6 are ${tech.gaps} apart`);
}

// The playbook's routes: a route tree draws every one from where its man lines up, a receiver's and a back's, each with
// its name, none of the names on another or off the drawing, and the ones no play runs (out, curl, wheel) faint. Each
// route says which plays run it.
{
  const tree = await page.evaluate(() => {
    const d = [...document.querySelectorAll('.pb')].find(x => x.querySelector('summary').textContent === 'Routes');
    d.open = true;
    const svgs = [...d.querySelectorAll('svg.tree')];
    const words = svgs.map(svg => {
      const box = svg.getBoundingClientRect();
      return [...svg.querySelectorAll('text:not(.pos)')].map(t => { const b = t.getBoundingClientRect(); return { name: t.textContent, faint: !!t.closest('.unused'), l: b.left, r: b.right, t: b.top, b: b.bottom, inside: b.left >= box.left - 0.5 && b.right <= box.right + 0.5 && b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5 }; });
    });
    const rows = Object.fromEntries([...d.querySelectorAll('dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
    const out = { words, rows, caption: d.querySelector('figcaption').textContent };
    d.open = false;
    return out;
  });
  assert.deepEqual(tree.words.map(w => w.map(x => x.name)), [['go', 'seam', 'post', 'corner', 'out', 'sail', 'dig', 'deep over', 'slant', 'hitch', 'curl', 'flat', 'drag', 'sit'], ['wheel', 'swing', 'flat', 'check-down', 'screen']]);
  assert.deepEqual(tree.words.flat().filter(x => x.faint).map(x => x.name), ['out', 'curl', 'wheel'], 'the routes no play runs, drawn faint');
  for (const w of tree.words) {
    for (const x of w) assert.ok(x.inside, `the route tree's "${x.name}" is off the drawing`);
    for (const [k, a] of w.entries()) for (const b of w.slice(k + 1)) assert.ok(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `the route tree's "${a.name}" and "${b.name}" are on each other`);
  }
  assert.match(tree.caption, /Drawn faint: out, curl and wheel, which no play here runs, but a man can be given one: tap him on the board before the snap, then Change his route\.$/);
  assert.match(tree.rows.Hitch, / Run in Smash\.$/);
  assert.match(tree.rows.Corner, / Run in Smash and Mesh\.$/);
  assert.match(tree.rows.Flat, / Run in Flood, Slant-Flat and Play-Action Shot\.$/, 'a receiver\'s flat and a back\'s are one route');
  assert.match(tree.rows.Drag, / Run in Mesh\.$/);
  for (const r of ['Out', 'Curl']) assert.match(tree.rows[r], / No play here runs it, but a receiver can: tap him before the snap and change his route\.$/);
  assert.match(tree.rows.Wheel, / No play here runs it, but a back can: tap him before the snap and change his route\.$/);
}

// The words a learner meets, each explained where he can find it: what the personnel digits mean, what the strong side
// is (on a balanced formation, the side you call), and a playbook section for the rest, the zones as the cards name them.
{
  const said = await page.evaluate(async () => {
    const blurb = name => [...document.querySelectorAll('#mineBody .pick')].find(p => p.querySelector('.pick-label').textContent === name)?.querySelector('.blurb')?.textContent;
    const chip = name => [...document.querySelectorAll('#mineBody .chip')].find(b => b.textContent.startsWith(name));
    const out = {};
    for (const f of ['Gun Trips', 'Gun Doubles', 'I-Form', 'Singleback']) { chip(f).click(); out[f] = { formation: blurb('Formation'), strong: blurb('Strong side') }; }
    const d = [...document.querySelectorAll('.pb')].find(x => x.querySelector('summary').textContent === 'Words coaches use');
    out.words = d ? [...d.querySelectorAll('dt')].map(dt => dt.textContent) : [];
    const { ZONES } = await import('./js/playbook.js');
    out.zones = [...new Set(Object.values(ZONES).filter(z => !z.deep).map(z => z.name))];
    return out;
  });
  assert.match(said['Gun Trips'].formation, / 11 personnel: one back, one tight end\.$/);
  assert.match(said['I-Form'].formation, / 21 personnel: two backs, one tight end\.$/);
  assert.match(said['Gun Doubles'].formation, / 10 personnel: one back, no tight ends\.$/);
  assert.match(said['Gun Trips'].strong ?? '', /^The strong side is the tight end's side, or the side with more receivers\./, 'the strong side is explained');
  assert.match(said['Gun Doubles'].strong ?? '', /^Gun Doubles is balanced, two receivers on each side, so the strong side is whichever side you call\./);
  assert.match(said.Singleback.strong ?? '', /^Singleback is balanced, a tight end and a receiver on each side, so/);
  for (const w of ['Strong side and weak side', 'Play side and back side', 'The box', 'Shotgun', 'Press', 'Leverage', 'Over the top', 'Three-step and five-step drop', 'Check-down', 'Hot route', 'Deep thirds, halves and quarters', 'Down and distance', 'Success', 'Turnover on downs', 'Big play', 'Takeaway']) {
    assert.ok(said.words.includes(w), `the playbook's words don't explain "${w}"`);
  }
  for (const z of said.zones) assert.ok(said.words.some(w => w.toLowerCase().startsWith(z.replace(/ \(.*/, ''))), `the playbook's words don't explain the ${z}`);
}

// A phone turned sideways: the board, Snap and the scrubber all on screen at once, with the calls beside the board,
// and they stay there while the calls scroll.
for (const [width, height] of [[844, 390], [667, 375]]) {
  const side = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await side.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const at = () => p.evaluate(() => {
    const box = sel => { const b = document.querySelector(sel).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    return { board: box('#board'), transport: box('.transport'), panel: box('#mine'), wide: document.documentElement.scrollWidth - innerWidth };
  });
  const check = (m, when) => {
    assert.equal(m.wide, 0, `${width}x${height} ${when}: the page scrolls sideways`);
    assert.ok(m.board.t >= 0 && m.transport.b <= height && m.transport.r <= width, `${width}x${height} ${when}: the board and its controls don't fit on screen (${JSON.stringify(m.transport)})`);
    assert.ok(m.panel.l >= m.board.r, `${width}x${height} ${when}: the calls aren't beside the board`);
    assert.ok(m.board.b - m.board.t > height * 0.55, `${width}x${height} ${when}: the board is ${Math.round(m.board.b - m.board.t)} px tall`);
  };
  check(await at(), 'at the top');
  await p.evaluate(() => scrollTo(0, 600));
  check(await at(), 'scrolled down');
  await side.close();
}

// Once the board has stuck to the top of a phone, a soft edge under it, so what scrolls under it goes under something;
// none at the top of the page, and none beside a board fixed at the side of a phone turned sideways.
for (const [width, height, edge] of [[390, 844, true], [844, 390, false]]) {
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const shadow = () => p.evaluate(() => getComputedStyle(document.querySelector('.stage')).boxShadow);
  assert.equal(await shadow(), 'none', `${width}x${height}: an edge under the board at the top of the page`);
  await p.evaluate(() => scrollTo(0, 700));
  if (edge) await until(async () => await shadow() !== 'none', 3000, `${width}x${height}: no edge under the board once it has stuck`);
  else { await new Promise(r => setTimeout(r, 300)); assert.equal(await shadow(), 'none', `${width}x${height}: an edge under the board fixed at the side`); }
  await c.close();
}

// A phone shorter than 700 px held upright (an iPhone SE, or a phone with its browser's toolbars showing) keeps the
// board at the top too, drawn a little flatter, so the calls have room under it; a taller phone keeps the board it had.
// Tabbing down the page, the focus doesn't go behind it.
for (const [width, height, tall] of [[375, 667, [215, 230]], [390, 844, [262, 276]]]) {
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.evaluate(() => scrollTo(0, 700));
  await new Promise(r => setTimeout(r, 300));
  const at = await p.evaluate(() => {
    const board = document.getElementById('board').getBoundingClientRect(), stage = document.querySelector('.stage');
    return { top: stage.getBoundingClientRect().top, bottom: stage.getBoundingClientRect().bottom, board: board.height, stuck: stage.classList.contains('stuck'), scrolled: scrollY };
  });
  assert.ok(at.scrolled > 300 && Math.abs(at.top) <= 1 && at.stuck, `${width}x${height}: the board doesn't stay at the top: ${JSON.stringify(at)}`);
  assert.ok(at.board >= tall[0] && at.board <= tall[1], `${width}x${height}: the board is ${Math.round(at.board)} px tall`);
  assert.ok(height - at.bottom >= 330, `${width}x${height}: only ${Math.round(height - at.bottom)} px under the board for the calls`);
  await p.evaluate(() => scrollTo(0, 0));
  await p.focus('#snap');
  let on = null;
  for (let k = 0; k < 20 && !on; k++) {
    await p.keyboard.press('Tab');
    on = await p.evaluate(() => { const el = document.activeElement; return el.dataset.key?.startsWith('Play:') && el.getAttribute('aria-checked') === 'true' ? el.dataset.key : null; });
  }
  assert.ok(on, `${width}x${height}: Tab from Snap never reached the play picked`);
  const seen = await p.evaluate(() => ({ chip: document.activeElement.getBoundingClientRect().top, stage: document.querySelector('.stage').getBoundingClientRect().bottom }));
  assert.ok(seen.chip >= seen.stage, `${width}x${height}: the focused chip (${on}) is at ${Math.round(seen.chip)} px, behind the board, which ends at ${Math.round(seen.stage)} px`);
  await c.close();
}

// A tablet held upright keeps the board at the top too, over more than half the screen. Tabbing down the page, the
// focus doesn't go behind it (WCAG 2.2, 2.4.11 Focus Not Obscured): the page scrolls a focused chip to below the board.
{
  const c = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.focus('#snap');
  let on = null;
  for (let k = 0; k < 20 && !on; k++) {
    await p.keyboard.press('Tab');
    on = await p.evaluate(() => { const el = document.activeElement; return el.dataset.key?.startsWith('Play:') && el.getAttribute('aria-checked') === 'true' ? el.dataset.key : null; });
  }
  assert.ok(on, 'Tab from Snap never reached the play picked');
  const seen = await p.evaluate(() => ({ chip: document.activeElement.getBoundingClientRect().top, stage: document.querySelector('.stage').getBoundingClientRect().bottom }));
  assert.ok(seen.chip >= seen.stage, `at 768x1024 the focused chip (${on}) is at ${Math.round(seen.chip)} px, behind the board, which ends at ${Math.round(seen.stage)} px`);
  await c.close();
}

// A phone of its own, with its own saved calls, watched for problems like the first.
const phone = async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  return p;
};
const frames = p => p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// Every player's job, without tapping the board: a closed section under Their call, taking no room until it's opened.
// In it, the board in words (which a screen reader hears as the board's description) and a button for every player,
// left to right as the board shows them, that opens his card. Before the snap the other side's jobs stay hidden, as on
// the board. From the keyboard: Enter on a button opens his card with the focus on it, and Escape or × closes it and
// goes back to the button. Calling the defense turns the board around, and the buttons and the words with it.
{
  const p = await phone();
  const jobs = () => p.evaluate(() => {
    const { state, board } = window.chalkTalk, team = t => [...document.querySelectorAll('.jobs-team')][t === 'O' ? 0 : 1];
    const names = t => [...team(t).querySelectorAll('button')].map(b => b.textContent);
    // the order the board shows them in: by where each man is drawn, left to right
    const drawn = t => state.play.players.filter(q => q.team === t).sort((a, b) => board.sx(a.x) - board.sx(b.x) || Math.abs(a.y) - Math.abs(b.y)).map(q => q.label);
    return { open: document.getElementById('jobs').open, tall: document.getElementById('jobs').getBoundingClientRect().height, off: names('O'), def: names('D'), drawnOff: drawn('O'), drawnDef: drawn('D'), words: document.getElementById('boardWords').textContent };
  });
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'trips', play: 'smash', flip: false, motion: 'none' }); Object.assign(state.def, { front: 'nickel', coverage: 'c2', pressure: 'four', disguise: false }); lineUp(); });
  let j = await jobs();
  assert.ok(!j.open && j.tall < 70, `every player's job takes ${Math.round(j.tall)} px before it's opened`);
  assert.equal(j.off.length, 11);
  assert.equal(j.def.length, 11);
  assert.deepEqual(j.off.map(t => t.split(' · ')[0]), j.drawnOff, 'the offense isn\'t left to right as the board shows it');
  assert.deepEqual(j.def.map(t => t.split(' · ')[0]), j.drawnDef, 'the defense isn\'t left to right as the board shows it');
  assert.equal(j.off[0], 'X · Split end (X)');
  assert.ok(j.off.includes('LT · Left tackle') && j.def.includes('FS · Free safety'), `the buttons: ${j.off.join(', ')} / ${j.def.join(', ')}`);
  assert.match(j.words, /^1st & 10, the line to gain 10 yards up the field\. Gun Trips, strong right: a tight end and two receivers right, a receiver left; the quarterback in the shotgun, a back beside him\. The defense: two safeties deep, \d in the box against \d blockers, both corners about 5 yards off\.$/, `the board in words: ${j.words}`);
  assert.match(await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; state.sit = '4and1'; lineUp(); const w = document.getElementById('boardWords').textContent; state.sit = '1and10'; lineUp(); return w; }),
    /^4th & 1, the line to gain 1 yard up the field\. Gun Trips, strong right: /);
  // what a screen reader hears for the board: its name, and the same words as its description
  const cdp = await p.context().newCDPSession(p);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#board' });
  const ax = (await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes[0];
  assert.equal(ax.description?.value, j.words, 'a screen reader doesn\'t hear the board in words as its description');
  await cdp.detach();
  // open it from the keyboard and use a button: the free safety's card, his job hidden before the snap
  await p.focus('#jobs summary');
  await p.keyboard.press('Enter');
  assert.equal((await jobs()).open, true, 'Enter on the summary doesn\'t open every player\'s job');
  const fs = p.locator('.jobs-team button', { hasText: 'FS · Free safety' });
  await fs.focus();
  await p.keyboard.press('Enter');
  const card = () => p.evaluate(() => ({ open: !document.getElementById('who').hidden, pos: document.getElementById('whoPos').textContent, job: document.getElementById('whoJob').textContent, focus: document.activeElement.id || document.activeElement.textContent }));
  let seen = await card();
  assert.deepEqual([seen.open, seen.pos, seen.focus], [true, 'FS · Free safety', 'who'], `the free safety's button: ${JSON.stringify(seen)}`);
  assert.match(seen.job, /hidden until the snap/, 'the other side\'s job shows before the snap');
  await p.keyboard.press('Escape');
  seen = await card();
  assert.deepEqual([seen.open, seen.focus], [false, 'FS · Free safety'], 'Escape doesn\'t close the card and go back to his button');
  // after the snap his job is out; × closes the card and goes back to the button too
  await p.evaluate(() => { const { snap, finish } = window.chalkTalk; snap(); finish(); });
  await p.locator('.jobs-team button', { hasText: 'FS · Free safety' }).focus();
  await p.keyboard.press('Enter');
  assert.match((await card()).job, /^On this play:/, 'the free safety\'s job isn\'t out after the snap');
  await p.keyboard.press('Tab');
  assert.equal(await p.evaluate(() => document.activeElement.id), 'whoClose', 'Tab from the card doesn\'t go to its close button');
  await p.keyboard.press('Enter');
  seen = await card();
  assert.deepEqual([seen.open, seen.focus], [false, 'FS · Free safety'], '× doesn\'t close the card and go back to his button');
  // calling the defense: the board turned around, the buttons and the words with it
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; document.querySelector('[data-side="D"]').click(); Object.assign(state.off, { formation: 'trips', play: 'smash', flip: false, motion: 'none' }); lineUp(); });
  j = await jobs();
  assert.deepEqual(j.off.map(t => t.split(' · ')[0]), j.drawnOff, 'calling the defense, the offense isn\'t left to right as the board shows it');
  assert.equal(j.off[0], 'Z · Flanker (Z)', 'calling the defense, the offense\'s right isn\'t on the board\'s left');
  assert.match(j.words, /^1st & 10, the line to gain 10 yards up the field\. Gun Trips, strong left: a tight end and two receivers left, a receiver right;/, `calling the defense, the board in words: ${j.words}`);
  await p.context().close();
}

// Where the board doesn't stay in view (a laptop's window made small, 700 by 600, and a small phone turned sideways,
// 568 by 320), a player's button brings the page up to his card, rather than opening it out of sight, and Escape takes
// it back down to the button.
for (const [width, height, mobile] of [[700, 600, false], [568, 320, true]]) {
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.click('#jobs summary');
  const fs = p.locator('.jobs-team button', { hasText: 'FS · Free safety' });
  await fs.scrollIntoViewIfNeeded();
  const card = () => p.evaluate(() => { const r = document.getElementById('who').getBoundingClientRect(); return { open: !document.getElementById('who').hidden, top: r.top, bottom: r.bottom, h: innerHeight }; });
  assert.ok((await card()).open === false && (await p.evaluate(() => document.getElementById('board').getBoundingClientRect().bottom)) < 0, `${width}x${height}: the board was still in view at the free safety's button`);
  await fs.click();
  await until(async () => { const k = await card(); return k.open && k.top >= 0 && k.bottom <= k.h; }, 3000, `${width}x${height}: the free safety's button opened his card out of sight: ${JSON.stringify(await card())}`);
  await p.keyboard.press('Escape');
  await until(async () => p.evaluate(() => { const el = document.activeElement, r = el.getBoundingClientRect(); return el.textContent === 'FS · Free safety' && r.top >= 0 && r.bottom <= innerHeight; }), 3000, `${width}x${height}: Escape didn't go back to the free safety's button`);
  await c.close();
}

// Playback: Pause holds the clock where it is, and ▶ goes on from there. Half speed plays about half a second of the
// play each second, and Snap again from the result card snaps the same two calls with a new roll of the dice.
{
  const p = await phone();
  await p.click('#snap');
  await p.waitForFunction(() => window.chalkTalk.state.t > 0.8, null, { timeout: 10000 });
  await p.click('#play');
  const held = await p.evaluate(() => window.chalkTalk.state.t);
  await new Promise(r => setTimeout(r, 400));
  assert.deepEqual(await p.evaluate(() => ({ t: window.chalkTalk.state.t, phase: window.chalkTalk.state.phase, button: document.getElementById('play').getAttribute('aria-label') })),
    { t: held, phase: 'paused', button: 'Play' }, 'Pause doesn\'t hold the play where it is');
  await p.click('#play');
  const resumed = await p.evaluate(() => window.chalkTalk.state.t);
  assert.ok(resumed >= held && resumed < held + 0.5, `▶ after a pause at ${held.toFixed(2)} s went on from ${resumed.toFixed(2)} s`);
  await p.waitForFunction(t => window.chalkTalk.state.t > t, held, { timeout: 5000 });
  // how many seconds of the play go by in a second, at each speed
  const rate = speed => p.evaluate(async speed => {
    const { state, lineUp, play } = window.chalkTalk, wait = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector(`[data-speed="${speed}"]`).click();
    lineUp(); play();
    await wait(300);
    const t0 = state.t, w0 = performance.now();
    await wait(1000);
    return (state.t - t0) / ((performance.now() - w0) / 1000);
  }, speed);
  const [half, full] = [await rate(0.5), await rate(1)];
  assert.ok(half > 0.3 && half < 0.6 && full / half > 1.6 && full / half < 2.5, `half speed played ${half.toFixed(2)} s of the play a second, and full speed ${full.toFixed(2)} s`);
  await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; state.t = board.duration(); finish(); });
  const calls = () => p.evaluate(() => { const { state } = window.chalkTalk; return { off: { ...state.off }, def: { ...state.def }, seed: state.seed, phase: state.phase }; });
  const before = await calls();
  await p.click('#again');
  const after = await calls();
  assert.deepEqual({ off: after.off, def: after.def, phase: after.phase }, { off: before.off, def: before.def, phase: 'playing' }, 'Snap again changed a call');
  assert.notEqual(after.seed, before.seed, 'Snap again replayed the same snap');
  await p.context().close();
}

// Calling the defense, the offense's play is hidden until the snap: the board says so, and a receiver's card keeps
// his job back.
{
  const p = await phone();
  await p.click('[data-side="D"]');
  assert.match(await p.textContent('#matchup'), /^1st & 10 · [^·]+ · play hidden  vs  /, 'calling the defense, the board gives the play away');
  const wr = await p.evaluate(() => {
    const { board, state } = window.chalkTalk, q = state.play.players.find(o => o.cls === 'wr'), r = board.cv.getBoundingClientRect(), z = board.pos(0, q.i);
    return { i: q.i, x: r.left + board.sx(z.x), y: r.top + board.sy(z.y) };
  });
  for (let n = 0; n < 4 && await p.evaluate(() => window.chalkTalk.board.selected) !== wr.i; n++) await p.mouse.click(wr.x, wr.y);
  assert.equal(await p.textContent('#whoJob'), 'His job on this play is hidden until the snap. Read the alignment: where he stands gives some of it away.');
  await p.context().close();
}

// The scrubber counts the play's frames, so an arrow key steps one frame (a twentieth of a second) and the far end is
// the end of the play; a screen reader hears the time and what's happening ("1.9 of 4.1 seconds: The quarterback
// throws..."), not "one thousand".
{
  const p = await phone();
  await p.evaluate(() => { const { snap, finish } = window.chalkTalk; snap(); finish(); });
  const now = () => p.evaluate(() => {
    const s = document.getElementById('scrub'), { state } = window.chalkTalk;
    return { value: +s.value, max: +s.max, frames: state.play.frames.length, t: state.t, dt: state.play.frames[1].t, text: s.getAttribute('aria-valuetext'), phase: state.phase };
  });
  await p.focus('#scrub');
  await p.keyboard.press('Home');
  const start = await now();
  await p.keyboard.press('ArrowRight');
  const step = await now();
  assert.equal(start.max, start.frames - 1, 'the scrubber counts frames');
  assert.deepEqual([start.value, start.t, step.value], [0, 0, 1]);
  assert.ok(Math.abs(step.t - step.dt) < 1e-6, `an arrow press moved the play ${step.t.toFixed(3)} s`);
  assert.match(step.text ?? '', /^0\.\d of \d+\.\d seconds$/, 'the scrubber says the time');
  const thrown = await p.evaluate(() => {
    const s = document.getElementById('scrub'), { state } = window.chalkTalk, e = state.play.events.find(x => x.kind !== 'shed');
    s.value = String(state.play.frames.findIndex(f => f.t >= e.t)); s.dispatchEvent(new Event('input'));
    return { text: s.getAttribute('aria-valuetext'), line: e.text };
  });
  assert.ok(thrown.text.endsWith(`: ${thrown.line}`), `"${thrown.text}" doesn't say "${thrown.line}"`);
  await p.keyboard.press('End');
  const end = await now();
  assert.equal(end.phase, 'done', 'End on the scrubber finishes the play');
  assert.ok(end.text.endsWith(`: ${await p.textContent('#resHead')}`), `at the end the scrubber says "${end.text}"`);
  await p.context().close();
}

// Each time in the play-by-play is a button that watches that moment again: from a second before it to a second after,
// at half speed whatever the speed is set to, and then it stops there with that line on the board and its man ringed.
// Where two more lines would come up within the second and push it off, it stops short of the second of them (and where
// they come in the same frame, it stays up with the newest); a line about a block shed, which the board doesn't put up
// as it plays, is up while it's the moment watched. ▶ then plays on at your speed. Once the play has been seen to the
// whistle (not as it first runs, when it would give away how it comes out, nor before the snap, when it would give away
// a hidden play), the scrubber has a mark at the handoff, the throw and the catch. The board's frames are stepped by hand
// here, a tenth of a second each, so the speeds can be counted.
{
  const p = await phone();
  await p.evaluate(() => {
    const queue = new Map();
    let id = 0, now = 0;
    window.requestAnimationFrame = cb => { queue.set(++id, cb); return id; };
    window.cancelAnimationFrame = n => queue.delete(n);
    // (never behind the page's own clock, which the board starts each run from)
    window.stepFrames = (n = 1) => { for (let k = 0; k < n; k++) { const due = [...queue.values()]; queue.clear(); now = Math.max(now, performance.now()) + 100; for (const cb of due) cb(now); } };
  });
  const open = link => p.evaluate(link => {
    const { state, board, pause } = window.chalkTalk;
    location.hash = link;
    return new Promise(r => setTimeout(r, 50)).then(() => {
      pause();
      const s = document.getElementById('scrub');
      s.value = s.max; s.dispatchEvent(new Event('input'));
      return { phase: state.phase, duration: board.duration() };
    });
  }, link);
  const now = () => p.evaluate(() => {
    const { state } = window.chalkTalk;
    return { t: +state.t.toFixed(3), phase: state.phase, speed: state.speed, caption: [...document.getElementById('caption').children].map(s => s.textContent),
      label: document.getElementById('play').getAttribute('aria-label'), why: !document.getElementById('why').hidden, clock: document.getElementById('clock').textContent };
  });
  const untilStopped = async () => { for (let k = 0; k < 400 && (await now()).phase === 'playing'; k++) await p.evaluate(() => window.stepFrames()); return now(); };

  assert.equal((await open('p=O.trips.smash.0.nickel.c2.four.15')).phase, 'done');
  const story = await p.evaluate(() => window.chalkTalk.state.play.events.map(e => ({ t: e.t, kind: e.kind, text: e.text })));
  const times = await p.$$eval('#story .t', b => b.map(x => [x.tagName, x.textContent, x.getAttribute('aria-label')]));
  assert.deepEqual(times, story.map(e => ['BUTTON', `${e.t.toFixed(1)}s`, `${e.t.toFixed(1)}s: watch it again`]), 'each time in the play-by-play is a button');
  const k = story.findIndex(e => e.kind === 'throw'), thrown = story[k];
  await p.locator('#story .t').nth(k).click();
  const started = await now();
  assert.ok(Math.abs(started.t - (thrown.t - 1)) < 1e-3 && started.phase === 'playing', `the moment at ${thrown.t} s started at ${started.t} s (${started.phase})`);
  assert.deepEqual([started.label, started.why], ['Pause', false], 'while the moment plays, ▶ pauses it, and the button to the explanation is out of the way');
  await p.evaluate(() => window.stepFrames(2));
  const slow = await now();
  assert.ok(Math.abs(slow.t - started.t - 0.05) < 1e-3, `two frames of a tenth of a second moved it ${(slow.t - started.t).toFixed(3)} s, not 0.05 s (half speed)`);
  assert.equal(slow.speed, 1, 'watching a moment again changed the speed setting');
  const stopped = await untilStopped();
  assert.equal(stopped.phase, 'paused', 'it doesn\'t stop after the moment');
  assert.ok(Math.abs(stopped.t - (thrown.t + 1)) < 1e-3, `it stopped at ${stopped.t} s, not a second after the moment (${thrown.t} s)`);
  assert.ok(stopped.caption.includes(thrown.text), `"${thrown.text}" isn't on the board where it stopped: ${stopped.caption.join(' / ')}`);
  assert.deepEqual([stopped.label, stopped.clock], ['Play', `${stopped.t.toFixed(1)}s`]);
  await p.click('#play');
  const on = await now();
  await p.evaluate(() => window.stepFrames(2));
  assert.ok(Math.abs((await now()).t - on.t - 0.1) < 1e-3, '▶ after the moment plays on at full speed');
  // the scrubber's marks: the throw and the catch, where the thumb is at those moments
  const marks = await p.evaluate(() => {
    const { state, board, lineUp } = window.chalkTalk, F = state.play.frames, s = document.getElementById('scrub');
    const out = { snapped: [...document.querySelectorAll('#marks i')].map(i => [i.dataset.kind, +i.style.getPropertyValue('--at')]) };
    out.want = state.play.events.filter(e => ['hand', 'throw', 'catch', 'int'].includes(e.kind)).map(e => [e.kind, Math.round(e.t / 0.05) / (F.length - 1)]);
    lineUp();
    out.before = document.querySelectorAll('#marks i').length;
    return out;
  });
  assert.deepEqual(marks.snapped, marks.want, 'the scrubber\'s marks are at the handoff, the throw and the catch');
  assert.deepEqual(marks.snapped.map(m => m[0]), ['throw', 'catch']);
  assert.equal(marks.before, 0, 'the scrubber has marks before the snap');
  // As the snap runs the first time there are none (a second mark would say the pass is caught); at the whistle, they come.
  await p.evaluate(() => { window.chalkTalk.play(); window.stepFrames(30); });
  assert.deepEqual([(await now()).phase, await p.$$eval('#marks i', m => m.length)], ['playing', 0], 'the scrubber\'s marks give the play away as it runs');
  await untilStopped();
  assert.equal(await p.$$eval('#marks i', m => m.length), 2, 'at the whistle the scrubber has no marks');

  // Power, where the cut and the miss just after it come 0.1 s apart and the hole opens 0.3 s later: the cut, watched
  // again, stops a frame before the hole, while it's still up. Then the tackler's shed block, which the board leaves
  // out as the play runs.
  await open('p=O.iform.power.0.over.c3.four.41');
  const run = await p.evaluate(() => window.chalkTalk.state.play.events.map(e => ({ t: e.t, kind: e.kind, text: e.text })));
  const cut = run.findIndex(e => e.kind === 'cut'), shed = run.findIndex(e => e.kind === 'shed');
  assert.deepEqual(run.slice(cut, cut + 3).map(e => e.kind), ['cut', 'miss', 'hole'], `the play changed: ${run.map(e => `${e.t} ${e.kind}`).join(', ')}`);
  await p.locator('#story .t').nth(cut).click();
  const short = await untilStopped();
  assert.ok(Math.abs(short.t - (run[cut + 2].t - 0.05)) < 1e-3, `the cut at ${run[cut].t} s, watched again, stopped at ${short.t} s, not a frame before the hole at ${run[cut + 2].t} s`);
  assert.deepEqual(short.caption, [run[cut].text, run[cut + 1].text], 'the cut isn\'t on the board where it stopped');
  // the man the watched line names is the one ringed, not the newer line's (the man who missed the tackle)
  assert.equal(await p.evaluate(() => window.chalkTalk.board.spot), await p.evaluate(i => window.chalkTalk.state.play.events[i].who, cut), 'the back who cut isn\'t ringed where the cut stopped');
  assert.ok(shed > 0, 'no shed block in the play');
  await p.locator('#story .t').nth(shed).click();
  const shedAt = await untilStopped();
  assert.equal(shedAt.caption.at(-1), run[shed].text, 'the shed block isn\'t on the board where it stopped');
  assert.equal(await p.evaluate(() => window.chalkTalk.board.spot), await p.evaluate(i => window.chalkTalk.state.play.events[i].who, shed), 'the man who shed the block isn\'t ringed');
  await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = String(+s.value); s.dispatchEvent(new Event('input')); });
  assert.ok(!(await now()).caption.includes(run[shed].text), 'scrubbed to the same place, the shed block is on the board as the play runs');

  // A catch with a missed tackle and the tackle in the same frame: watched again, the catch stays on the board, the
  // newest line under it, and the receiver is ringed.
  await open('p=O.single.slants.0.under.c1.blitz.1065');
  const quick = await p.evaluate(() => window.chalkTalk.state.play.events.map(e => ({ t: e.t, kind: e.kind, text: e.text, who: e.who })));
  const caught = quick.findIndex(e => e.kind === 'catch');
  assert.deepEqual(quick.slice(caught, caught + 3).map(e => [e.kind, e.t]), [['catch', quick[caught].t], ['miss', quick[caught].t], ['tackle', quick[caught].t]], `the play changed: ${quick.map(e => `${e.t} ${e.kind}`).join(', ')}`);
  await p.locator('#story .t').nth(caught).click();
  const same = await untilStopped();
  assert.deepEqual(same.caption, [quick[caught].text, quick[caught + 2].text], 'a catch with two more lines in its frame, watched again, isn\'t on the board');
  assert.equal(await p.evaluate(() => window.chalkTalk.board.spot), quick[caught].who, 'the receiver isn\'t ringed');
  await p.context().close();
}

// Before the snap the quarterback's reads are numbered in chalk on his routes, 1 for his first, in the order his card
// lists them: past the arrowhead, or beside the route where its end is up under the words over the deep end (a go
// route), and always on the board, clear of those words and of every player's mark. Not once the play runs, not on a
// run, and not on a play that's still hidden (calling the defense, before the snap), at any width.
{
  const p = await phone();
  const numbers = () => p.evaluate(() => {
    const { board, state } = window.chalkTalk, ctx = board.ctx, fill = ctx.fillText, seen = [];
    ctx.fillText = function (text, x, y) { if (/Patrick Hand/.test(ctx.font) && /^\d$/.test(text)) seen.push({ text, x, y, fs: parseFloat(ctx.font.replace(/^\d+ /, '')) }); return fill.apply(this, arguments); };
    board.render();
    ctx.fillText = fill;
    const r = board.radius(), P = state.play;
    const marks = P.players.map(q => { const at = board.pos(board.t, q.i); return [board.sx(at.x), board.sy(at.y)]; });
    const routes = Object.fromEntries(P.overlay.filter(o => o.read).map(o => [o.read, { who: P.players[o.i].label, pts: o.pts.map(q => [board.sx(q.x), board.sy(q.y)]) }]));
    const qb = P.players.find(q => q.cls === 'qb');
    return { seen, r, marks, routes, w: board.w, h: board.h, flip: board.flip, card: P.jobs[qb.i] };
  });
  // the distance from a point to a polyline
  const off = (pts, [x, y]) => Math.min(...pts.slice(1).map((b, n) => {
    const a = pts[n], dx = b[0] - a[0], dy = b[1] - a[1], u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(a[0] + u * dx - x, a[1] + u * dy - y);
  }));
  for (const [link, width] of [['p=O.trips.smash.0.nickel.c2.four.15', 390], ['p=O.doubles.verts.0.nickel.c3.four.3', 390], ['p=D.iform.flood.1.over.c3.four.9', 390], ['p=O.trips.smash.0.nickel.c2.four.15', 1280]]) {
    await p.setViewportSize({ width, height: width > 900 ? 800 : 844 });
    await p.evaluate(link => { location.hash = link; }, link);
    await p.waitForFunction(() => window.chalkTalk.state.phase === 'playing');
    await p.evaluate(() => window.chalkTalk.lineUp());
    const d = await numbers();
    const card = d.card.match(/His reads: (.+)\.$/)[1].split(', ').map(r => r.replace(/ \(.+\)$/, ''));
    assert.deepEqual(Object.entries(d.routes).map(([n, r]) => `${n}. ${r.who}`), card, `${link}: the routes aren't numbered as the quarterback's card lists his reads`);
    assert.deepEqual(d.seen.map(s => s.text), Object.keys(d.routes), `${link} at ${width}: the numbers drawn aren't his reads`);
    const band = d.flip ? [d.h - 72, d.h] : [0, 72];
    for (const s of d.seen) {
      const route = d.routes[s.text], end = route.pts.at(-1), half = s.fs * 0.42;
      assert.ok(s.x > 3 && s.x < d.w - 3 && s.y - half > 2 && s.y + half < d.h - 2, `${link} at ${width}: read ${s.text} is off the board at ${s.x.toFixed(0)}, ${s.y.toFixed(0)}`);
      assert.ok(s.y + half < band[0] || s.y - half > band[1], `${link} at ${width}: read ${s.text} is under the words at the deep end (y ${s.y.toFixed(0)})`);
      for (const [x, y] of d.marks) assert.ok(Math.abs(x - s.x) > d.r + 1 || Math.abs(y - s.y) > d.r + 1, `${link} at ${width}: read ${s.text} is on a player at ${x.toFixed(0)}, ${y.toFixed(0)}`);
      const inBand = end[1] < band[1] + 4 && end[1] > band[0] - 4;
      assert.ok(inBand ? off(route.pts, [s.x, s.y]) < s.fs * 1.6 : Math.hypot(end[0] - s.x, end[1] - s.y) < s.fs * 2, `${link} at ${width}: read ${s.text} (the ${route.who}) is ${Math.hypot(end[0] - s.x, end[1] - s.y).toFixed(0)} px from the end of his route`);
    }
    await p.evaluate(() => { window.chalkTalk.play(); window.chalkTalk.pause(); const s = document.getElementById('scrub'); s.value = '10'; s.dispatchEvent(new Event('input')); });
    assert.equal((await numbers()).seen.length, 0, `${link}: the reads are still numbered once the play runs`);
  }
  // a run, and a hidden play
  await p.evaluate(() => { location.hash = 'p=O.iform.power.0.over.c3.four.41'; });
  await p.waitForFunction(() => window.chalkTalk.state.play.call.play === 'power');
  await p.evaluate(() => window.chalkTalk.lineUp());
  assert.equal((await numbers()).seen.length, 0, 'a run has its reads numbered');
  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('[data-side="D"]');
  await p.click('#auto');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; state.off.play = 'smash'; lineUp(); });
  assert.equal(await p.evaluate(() => window.chalkTalk.state.auto && window.chalkTalk.state.side === 'D'), true);
  assert.equal((await numbers()).seen.length, 0, 'a hidden pass play has its reads numbered before the snap');
  await p.context().close();
}

// Zoom to the line, on a phone: off until it's asked for, with a magnifier in the corner at the backfield's end (the
// top when calling the defense turns the board around), and none on a computer. Zoomed in, the board is twice as big,
// centred on the ball, so the linemen are about 19 px apart rather than 10, and a tap still finds the man under the
// finger. Through the play the view follows the ball, so it never leaves the board, deep passes and long runs too. The
// magnifier again zooms back out, and a reload starts with the whole field.
{
  const p = await phone();
  const look = () => p.evaluate(() => {
    const { board, state } = window.chalkTalk, z = document.getElementById('zoom'), b = z.getBoundingClientRect(), cv = board.cv.getBoundingClientRect();
    board.render();
    const at = label => { const q = state.play.players.find(x => x.label === label), w = board.pos(board.t, q.i); return [board.sx(w.x), board.sy(w.y)]; };
    const ball = board.ballAt(board.t);
    return { pressed: z.getAttribute('aria-pressed'), shown: b.width > 0, corner: [Math.round(cv.right - b.right), Math.round(cv.bottom - b.bottom), Math.round(b.top - cv.top)],
      u: board.zoomU, k: board.k, k0: board.k0, w: board.w, h: board.h, gap: Math.hypot(at('LG')[0] - at('C')[0], at('LG')[1] - at('C')[1]), ball: [board.sx(ball[0]), board.sy(ball[1])], c: at('C') };
  });
  const out = await look();
  assert.deepEqual([out.pressed, out.shown, out.u], ['false', true, 0], 'on a phone the magnifier isn\'t there, or the board starts zoomed');
  assert.ok(out.corner[0] < 12 && out.corner[1] < 12, `the magnifier isn't in the bottom right corner: ${out.corner}`);
  assert.ok(Math.abs(out.k - out.k0) < 1e-6 && out.gap < 12, `unzoomed, the linemen are ${out.gap.toFixed(1)} px apart`);
  await p.click('#zoom');
  await p.waitForFunction(() => window.chalkTalk.board.zoomU === 1, null, { timeout: 3000 });
  const zoomed = await look();
  assert.equal(zoomed.pressed, 'true');
  assert.ok(Math.abs(zoomed.k - 2 * zoomed.k0) < 1e-6, `zoomed, the board is ${(zoomed.k / zoomed.k0).toFixed(2)} times as big`);
  assert.ok(zoomed.gap > 17 && zoomed.gap < 22, `zoomed, the linemen are ${zoomed.gap.toFixed(1)} px apart`);
  assert.ok(Math.abs(zoomed.ball[0] - zoomed.w / 2) < 2 && Math.abs(zoomed.ball[1] - 0.57 * zoomed.h) < 2, `zoomed, the ball is at ${zoomed.ball.map(Math.round)} on a ${zoomed.w}x${Math.round(zoomed.h)} board`);
  // a tap on the center, zoomed in, opens his card
  const c = await p.evaluate(([x, y]) => { const r = window.chalkTalk.board.cv.getBoundingClientRect(); return [r.left + x, r.top + y]; }, zoomed.c);
  await p.mouse.click(c[0], c[1]);
  assert.match(await p.textContent('#whoPos'), /^C · Center/, 'a tap on the center, zoomed in, didn\'t open his card');
  // the ball stays on the board through the play, on deep passes and long runs, calling either side
  const lost = await p.evaluate(() => {
    const { board, state, lineUp, simulate } = window.chalkTalk, out = [];
    const calls = [['O', 'doubles', 'verts', 'c2'], ['O', 'single', 'oz', 'c0'], ['D', 'trips', 'pa', 'c3'], ['O', 'iform', 'power', 'c1'], ['D', 'single', 'smash', 'c2']];
    for (const [side, formation, play, coverage] of calls) for (let seed = 1; seed <= 12; seed++) {
      board.flip = side === 'D';
      board.setPlay(simulate({ formation, play, flip: false, front: 'over', coverage, pressure: 'four' }, seed));
      const F = board.play.frames;
      for (const f of F) {
        board.frame(f.t);
        const x = board.sx(f.ball[0]), y = board.sy(f.ball[1]);
        if (x < 0 || x > board.w || y < 0 || y > board.h) { out.push(`${side} ${formation} ${play} ${coverage} seed ${seed} at ${f.t.toFixed(2)} s: ${Math.round(x)}, ${Math.round(y)}`); break; }
      }
    }
    board.flip = state.side === 'D';
    lineUp();
    return out;
  });
  assert.deepEqual(lost, [], 'zoomed in, the ball left the board');
  await p.click('#zoom');
  await p.waitForFunction(() => window.chalkTalk.board.zoomU === 0, null, { timeout: 3000 });
  const back = await look();
  assert.ok(back.pressed === 'false' && Math.abs(back.k - back.k0) < 1e-6, 'the magnifier again didn\'t zoom back out');
  // calling the defense, it's at the top; a reload starts unzoomed; a computer has none
  await p.click('#zoom');
  await p.click('[data-side="D"]');
  const flipped = await look();
  assert.ok(flipped.corner[0] < 12 && flipped.corner[2] < 12, `calling the defense, the magnifier isn't in the top right corner: ${flipped.corner}`);
  assert.equal(flipped.pressed, 'true', 'calling the other side zoomed back out');
  await p.reload();
  assert.deepEqual((await look()).pressed, 'false', 'a reload started zoomed in');
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.waitForFunction(() => window.chalkTalk.board.w > 700);
  assert.equal((await look()).shown, false, 'a computer has the magnifier');
  await p.context().close();
}

// The board draws the line to gain, the yards to go past the line of scrimmage, in yellow (a dark gold on the
// whiteboard) right across the field: at 10 yards on 1st & 10, at 2 on 3rd & 2, before the snap and as the play runs.
{
  for (const colorScheme of ['light', 'dark']) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme });
    const p = await c.newPage();
    p.on('pageerror', e => problems.push(e.message));
    await p.goto(base);
    // How near the board's pixels round a spot (yards) come to its yellow, 0 for the same colour, and whether the
    // yellow line's colour is 3:1 against the board.
    const look = () => p.evaluate(() => {
      const { board } = window.chalkTalk, ctx = board.cv.getContext('2d'), dpr = board.dpr;
      const rgb = v => { const s = document.createElement('span'); s.style.color = v; document.body.append(s); const m = getComputedStyle(s).color.match(/\d+/g).map(Number); s.remove(); return m; };
      const want = rgb(board.colors.first);
      const near = (x, y) => {
        const d = ctx.getImageData(Math.round(board.sx(x) * dpr) - 3, Math.round(board.sy(y) * dpr) - 3, 7, 7).data;
        let best = 999;
        for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) best = Math.min(best, Math.hypot(d[i] - want[0], d[i + 1] - want[1], d[i + 2] - want[2]));
        return Math.round(best);
      };
      const lum = c => { const [r, g, b] = c.map(v => v / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const a = lum(want), b = lum(rgb(board.colors.board));
      return { togo: board.togo, on: near(-23.5, board.togo), off: near(-23.5, board.togo + 2.5), contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
    });
    const first = await look();
    assert.equal(first.togo, 10, `${colorScheme}: 1st & 10`);
    assert.ok(first.on < 40 && first.off > 80, `${colorScheme}: no yellow line at 10 yards before the snap: ${JSON.stringify(first)}`);
    assert.ok(first.contrast >= 3, `${colorScheme}: the yellow line is ${first.contrast.toFixed(2)}:1 against the board`);
    await p.getByRole('radio', { name: '3rd & 2' }).click();
    const short = await look();
    assert.equal(short.togo, 2, `${colorScheme}: 3rd & 2`);
    assert.ok(short.on < 40 && short.off > 80, `${colorScheme}: no yellow line at 2 yards on 3rd & 2: ${JSON.stringify(short)}`);
    await p.evaluate(() => { const { snap, pause, board, state } = window.chalkTalk; snap(); pause(); state.t = board.t = 1; board.render(); });
    const playing = await look();
    assert.ok(playing.on < 40, `${colorScheme}: the yellow line went as the play ran: ${JSON.stringify(playing)}`);
    await c.close();
  }
}

// How to read the board has a drawing of each mark, in the board's own colours in both looks (and on the chalkboard,
// its chalk dust), with rows for the line of scrimmage and the ball. It's in the playbook, and Key, under the board,
// opens it in a card: on a phone just under the board, which stays at the top of the screen, and on a computer at the
// top of the column beside the board, under the result. Key again, or ×, puts it away, and × takes the focus back to Key.
for (const colorScheme of ['light', 'dark']) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const key = await p.evaluate(() => {
    const sec = [...document.querySelectorAll('#pbGrid details')].find(d => d.querySelector('summary').textContent === 'How to read the board');
    const rows = [...sec.querySelectorAll('.key-row')].map(r => ({ term: r.querySelector('dt').lastChild.textContent, art: !!r.querySelector('dt .key-art[aria-hidden="true"] svg'), words: r.querySelector('dd').textContent }));
    const { board } = window.chalkTalk, col = n => { const s = document.createElement('span'); s.style.color = board.colors[n]; document.body.append(s); const v = getComputedStyle(s).color; s.remove(); return v; };
    const first = cls => sec.querySelector(`.key-art .${cls}`), cs = el => getComputedStyle(el);
    return {
      rows,
      paint: { o: cs(first('o')).stroke, d: cs(first('d')).stroke, l: cs(first('l')).stroke, h: cs(first('h')).stroke, y: cs(first('y')).stroke, ball: cs(first('fb')).fill, board: cs(sec.querySelector('.key-art')).backgroundColor },
      want: { o: col('off'), d: col('def'), l: col('los'), h: col('hot'), y: col('first'), ball: col('ball'), board: col('board') },
      dust: cs(sec.querySelector('.key-art svg')).maskImage || cs(sec.querySelector('.key-art svg')).webkitMaskImage,
      card: document.getElementById('keyBody').textContent === sec.querySelector('.key-list').textContent,
    };
  });
  assert.ok(key.rows.length >= 12 && key.rows.every(r => r.art && r.words.length > 5), `${colorScheme}: a row of the key without a drawing: ${JSON.stringify(key.rows.filter(r => !r.art))}`);
  for (const term of ['O and X', 'The line of scrimmage', 'The yellow line', 'The ball', 'Lines with arrows', 'A dashed line with an arrow', 'Numbers on routes', 'A line with a bar across the end', 'Dashed line to a bubble', 'Dotted line to a receiver', 'Arrows from the defense', 'Trails', 'Dotted line from the quarterback', 'At the whistle']) {
    assert.ok(key.rows.some(r => r.term === term), `${colorScheme}: the key has no row for ${term}`);
  }
  assert.deepEqual(key.paint, key.want, `${colorScheme}: the key's drawings aren't in the board's colours`);
  assert.equal(key.dust !== 'none', colorScheme === 'dark', `${colorScheme}: the chalk dust on the key's drawings is ${key.dust}`);
  assert.ok(key.card, 'the card by the board isn\'t the playbook\'s key');
  if (colorScheme === 'dark') { await c.close(); continue; }

  const at = () => p.evaluate(() => {
    const r = id => { const b = document.getElementById(id).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    return { board: r('board'), button: r('keyOpen'), key: document.getElementById('key').hidden ? null : r('key'), stage: document.querySelector('.stage').getBoundingClientRect().bottom,
      expanded: document.getElementById('keyOpen').getAttribute('aria-expanded'), focus: document.activeElement.id, result: document.getElementById('result').hidden ? null : r('result') };
  });
  const shut = await at();
  assert.ok(shut.button.t >= shut.board.b && shut.button.b <= shut.stage, `the Key button isn't under the board: ${JSON.stringify(shut)}`);
  assert.equal(shut.key, null, 'the key is open before it\'s asked for');
  assert.equal(shut.expanded, 'false');
  assert.ok(await p.evaluate(() => { const b = document.getElementById('keyOpen'), s = getComputedStyle(b, '::before'); return b.getBoundingClientRect().height - 2 * parseFloat(s.top); }) >= 44, 'the Key button is less than 44 px tall to tap');
  await p.click('#keyOpen');
  await until(async () => { const a = await at(); return a.key && Math.abs(a.key.t - a.stage) < 12; }, 3000, `the key didn't open just under the board: ${JSON.stringify(await at())}`);
  const open = await at();
  assert.ok(open.board.t >= -1 && open.board.b <= 844, 'the board went off the screen as the key opened');
  assert.deepEqual([open.expanded, open.focus], ['true', 'keyTitle'], 'the key opened without saying so, or without the focus');
  await p.click('#keyOpen');
  assert.equal((await at()).key, null, 'Key again didn\'t put the key away');
  await p.click('#keyOpen');
  await p.click('#keyClose');
  const closed = await at();
  assert.deepEqual([closed.key, closed.expanded, closed.focus], [null, 'false', 'keyOpen'], '× didn\'t put the key away and go back to Key');

  // a computer: beside the board, under the result
  await p.setViewportSize({ width: 1280, height: 800 });
  await p.evaluate(() => { const { snap, finish } = window.chalkTalk; snap(); finish(); });
  await p.click('#keyOpen');
  await until(async () => { const a = await at(); return a.key && a.key.t >= 0 && a.key.t < 40; }, 3000, `on a computer the key didn't come up at the top: ${JSON.stringify(await at())}`);
  const wide = await at();
  assert.ok(wide.key.l >= wide.board.r && wide.result && wide.result.b <= wide.key.t, `on a computer the key isn't beside the board, under the result: ${JSON.stringify(wide)}`);
  assert.ok(wide.board.t >= 0 && wide.board.b <= 800, 'on a computer the board went off the screen as the key opened');
  await c.close();
}

// The end of the play is chalked on the board: at the whistle (not before) the gain is written in marker by the ball,
// as the headline counts it ("+30", "Sack −7", "Incomplete" by an × where it came down, "Picked off"), bigger for a big
// play, with a line across the field at the spot of a run, a catch or a sack. The throw leaves a dotted line from his
// hand to the catch. The drawn-up play fades over the first half second, and the football is a little bigger on a
// phone than a player's mark would make it.
{
  const p = await phone();
  const seen = await p.evaluate(() => {
    const { state, board, lineUp, finish } = window.chalkTalk, ctx = board.ctx;
    const marker = () => { const out = []; const ft = ctx.fillText; ctx.fillText = function (t, x, y) { if (/Marker/.test(ctx.font)) out.push({ t, size: parseFloat(ctx.font.replace(/^\d+ /, '')) }); return ft.apply(this, arguments); }; board.render(); ctx.fillText = ft; return out; };
    const at = t => { board.t = t; return marker(); };
    const show = (off, def, seed) => { state.auto = false; Object.assign(state, { off, def, seed }); lineUp(); return state.play; };
    const out = { kinds: {}, bad: [] };
    // a catch for 30 yards: nothing written before the whistle, "+30" at it, in big writing
    let P = show({ formation: 'trips', play: 'smash', flip: false }, { front: 'nickel', coverage: 'c2', pressure: 'four' }, 15);
    out.before = at(P.result.t - 0.1);
    out.after = at(board.duration());
    out.head = (() => { state.t = board.duration(); finish(); return document.getElementById('resHead').textContent; })();
    // the throw: dotted, from where the ball left his hand to where it was caught
    const F = P.frames, a = F.findIndex(f => f.air);
    let b = a; while (F[b + 1].air) b++;
    const lines = [], poly = board.poly;
    board.poly = function (pts) { lines.push(pts.map(q => [+q.x.toFixed(2), +q.y.toFixed(2)])); return poly.call(this, pts); };
    board.t = F[a - 1].t; board.throwLine(); out.throwBefore = lines.length;
    board.t = board.duration(); board.throwLine(); out.throwAfter = lines.at(-1);
    board.poly = poly;
    out.throwWant = [[+F[a - 1].ball[0].toFixed(2), +F[a - 1].ball[1].toFixed(2)], [+F[b + 1].ball[0].toFixed(2), +F[b + 1].ball[1].toFixed(2)]];
    // the drawn-up play fades over half a second at the snap
    const alphas = [], asg = board.assignments;
    board.assignments = function (al) { alphas.push(+al.toFixed(3)); return asg.call(this, al); };
    for (const t of [0, 0.25, 0.5, 2]) { board.t = t; board.render(); }
    board.assignments = asg;
    out.alphas = alphas;
    // the football, a little bigger than a player's mark on a phone
    const el = ctx.ellipse, sizes = [];
    ctx.ellipse = function (x, y, rx) { sizes.push(rx); return el.apply(this, arguments); };
    board.t = 1; board.ballDraw(); ctx.ellipse = el;
    out.ball = { rx: Math.max(...sizes), mark: board.radius() };
    // every kind of ending, over many snaps: what's written, against the headline. With no spot to chalk a line at (an
    // incomplete pass, an interception), the writing stays by the × or the man, not across the board from him.
    const PL = ['iz', 'power', 'verts', 'smash', 'flood', 'mesh', 'pa', 'screen'];
    const spot = board.markSpot;
    let placed = null;
    board.markSpot = function (X, Y, w, fs) { const r = spot.apply(this, arguments); placed = { X, Y, w, fs, x: r[0], y: r[1] }; return r; };
    for (let k = 0; k < 160; k++) {
      P = show({ formation: ['iform', 'single', 'doubles', 'trips'][k % 4], play: PL[k % PL.length], flip: k % 2 === 1 }, { front: ['over', 'nickel', '34', 'under'][k % 4], coverage: ['c0', 'c1', 'c2', 'c3', 'c4'][k % 5], pressure: k % 3 ? 'four' : 'blitz' }, 300 + k);
      state.t = board.duration(); finish();
      const head = document.getElementById('resHead').textContent, w = at(board.duration()).map(x => x.t), res = P.result;
      const n = head.match(/(\d+)\+? yards?/)?.[1];
      const want = res.kind === 'incomplete' ? 'Incomplete' : res.kind === 'throwaway' ? 'Thrown away' : res.kind === 'int' ? 'Picked off'
        : res.kind === 'sack' ? (n ? `Sack −${n}` : 'Sack') : res.long ? `${n}+` : /^Gain/.test(head) ? `+${n}` : /^Loss/.test(head) ? `−${n}` : 'No gain';
      if (w.length !== 1 || w[0] !== want) out.bad.push(`${head}: wrote ${JSON.stringify(w)}, not "${want}"`);
      if (['incomplete', 'throwaway', 'int'].includes(res.kind)) {
        const { X, Y, w: tw, fs, x, y } = placed, far = Math.hypot(Math.max(x - X, 0, X - (x + tw)), Math.max(y - fs / 2 - Y, 0, Y - (y + fs / 2)));
        if (far > 4 * fs + 0.5) out.bad.push(`seed ${300 + k}, ${head}: "${want}" written ${Math.round(far)} px from ${res.kind === 'int' ? 'the man who has it' : 'where it came down'}`);
      }
      out.kinds[res.kind] = (out.kinds[res.kind] || 0) + 1;
    }
    board.markSpot = spot;
    return out;
  });
  assert.deepEqual(seen.before, [], 'something is written at the spot before the whistle');
  assert.equal(seen.head, 'Gain of 30 yards and a first down');
  assert.equal(seen.after.length, 1);
  assert.equal(seen.after[0].t, '+30');
  assert.ok(seen.after[0].size >= 18 * 1.4 - 0.01, `a big play's writing is ${seen.after[0].size} px`);
  assert.equal(seen.throwBefore, 0, 'a throw line before the throw');
  assert.deepEqual(seen.throwAfter, seen.throwWant, 'the throw line isn\'t from his hand to the catch');
  assert.deepEqual(seen.alphas, [1, 0.675, 0.35, 0.35], 'the drawn-up play at the snap and after it');
  assert.ok(seen.ball.rx >= 7 * 0.62 - 0.01 && seen.ball.mark < 7, `on a phone the football is ${seen.ball.rx} px across a half, with a player's mark ${seen.ball.mark}`);
  assert.deepEqual(seen.bad, [], 'what\'s written at the whistle, against the headline');
  assert.ok(['catch', 'incomplete', 'run', 'sack'].every(k => seen.kinds[k]), `only these endings came up: ${JSON.stringify(seen.kinds)}`);
  assert.match(await p.evaluate(() => [...document.querySelectorAll('.pb dt')].find(dt => dt.lastChild.textContent === 'At the whistle').nextElementSibling.textContent), /"Incomplete" by an ×/);
  await p.context().close();
}

// At the whistle of a play that ended past the line, the board pulls back over half a second to show the whole play:
// from just behind the backfield to past the spot, with the spot clear of the words along the top. Scrubbed back
// before the whistle, it follows the ball again; with reduced motion asked for, it goes there at once; a play that
// ended behind the line, or where the board shows it all anyway, keeps its camera. Taps find the players where they're
// drawn.
{
  const p = await phone();
  const view = (t, link) => p.evaluate(({ t, link }) => {
    const { state, board, lineUp } = window.chalkTalk;
    if (link) { state.auto = false; Object.assign(state, link); lineUp(); }
    const res = state.play.result, T = t === 'end' ? board.duration() : res.t + t;
    board.t = T; board.render();
    const P = state.play.players, h = P.findIndex(q => q.label === 'H'), at = board.pos(T, Math.max(0, h));
    return { k: board.k, k0: board.k0, top: board.top, bottom: board.top - board.h / board.k, spot: res.yards, kind: res.kind, spotPx: board.sy(res.yards), h: board.h, low: board.sy(-12),
      tap: h >= 0 && board.hit(board.sx(at.x), board.sy(at.y))[0] === h };
  }, { t, link });
  const catch30 = { off: { formation: 'trips', play: 'smash', flip: false }, def: { front: 'nickel', coverage: 'c2', pressure: 'four' }, seed: 15 };
  const before = await view(-0.05, catch30), half = await view(0.25), end = await view('end');
  assert.equal(end.kind, 'catch');
  assert.ok(Math.abs(before.k - before.k0) < 1e-9 && before.bottom > -11.9, `before the whistle the camera isn't following the ball: ${JSON.stringify(before)}`);
  assert.ok(end.k < end.k0 && Math.abs(end.bottom + 12) < 1e-6 && end.top >= end.spot + 3, `at the end the whole play isn't in view: ${JSON.stringify(end)}`);
  assert.ok(end.spotPx >= 80 - 1e-6, `the spot is ${end.spotPx} px from the top, under the words there`);
  assert.ok(half.k < before.k && half.k > end.k, `half way through the pull back: ${half.k} between ${before.k} and ${end.k}`);
  assert.ok(end.tap, 'a tap on the H after the pull back doesn\'t find him');
  assert.ok(Math.abs((await view(-0.05)).k - before.k) < 1e-9, 'scrubbed back before the whistle, the camera stays pulled back');
  await p.emulateMedia({ reducedMotion: 'reduce' });
  assert.ok(Math.abs((await view(0.05)).k - end.k) < 1e-9, 'with reduced motion the camera eases back rather than going at once');
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  // a sack, and a short run the camera never had to follow
  const sack = await view('end', { off: { formation: 'trips', play: 'verts', flip: false }, def: { front: 'nickel', coverage: 'c1', pressure: 'blitz' }, seed: 7 });
  assert.equal(sack.kind, 'sack');
  assert.ok(Math.abs(sack.k - sack.k0) < 1e-9 && Math.abs(sack.low - sack.h) < 1e-6, `after a sack the camera moved: ${JSON.stringify(sack)}`);
  const run = await view('end', { off: { formation: 'iform', play: 'iz', flip: false }, def: { front: 'over', coverage: 'c3', pressure: 'four' }, seed: 179 });
  assert.ok(run.kind === 'run' && Math.abs(run.k - run.k0) < 1e-9, `after a short run the camera moved: ${JSON.stringify(run)}`);
  await p.context().close();
}
// After a man still running when the board stops counting, the pull back takes in the ball where he ran on to, past
// the spot, and the writing at the whistle stays out from under the words along the top (72 px: WORDS in js/board.js),
// on a computer too, where the board is wide and the view tall.
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  const got = await p.evaluate(() => {
    const { state, board, lineUp } = window.chalkTalk;
    state.auto = false;
    Object.assign(state, { off: { formation: 'doubles', play: 'verts', flip: false }, def: { front: 'nickel', coverage: 'c0', pressure: 'blitz' }, seed: 9 });
    lineUp();
    const spot = board.markSpot;
    let placed = null;
    board.markSpot = function (X, Y, w, fs) { const r = spot.apply(this, arguments); placed = { fs, y: r[1] }; return r; };
    board.t = board.duration(); board.render();
    board.markSpot = spot;
    return { long: !!state.play.result.long, text: board.mark.text, ball: board.sy(state.play.frames.at(-1).ball[1]), ...placed };
  });
  assert.ok(got.long && got.text === '60+', `not a play still running at the end: ${JSON.stringify(got)}`);
  assert.ok(got.ball >= 80 - 1e-6, `the ball is ${got.ball} px from the top, under the words there`);
  assert.ok(got.y - got.fs / 2 > 72, `"60+" is written ${got.y - got.fs / 2} px from the top, under the words there`);
  await c.close();
}

// A blitzer's arrow is told apart by its shape as well as its colour (WCAG 2.2, 1.4.1 Use of Color): a thicker line and
// a double head, against one head on every other rusher's.
{
  const p = await phone();
  const marks = await p.evaluate(() => {
    const { state, board, lineUp } = window.chalkTalk;
    document.querySelector('[data-side="D"]').click();
    Object.assign(state.off, { formation: 'doubles', play: 'verts', flip: false, motion: 'none' });
    Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'blitz', disguise: false });
    lineUp();
    const drawn = [], ctx = board.ctx, poly = board.poly, arrow = board.arrow;
    board.poly = function (pts) { drawn.push({ kind: 'line', w: ctx.lineWidth, pts: pts.length }); return poly.call(this, pts); };
    board.arrow = function (a, b) { drawn.push({ kind: 'head', w: ctx.lineWidth }); return arrow.call(this, a, b); };
    const out = [];
    for (const o of state.play.overlay.filter(q => q.kind === 'rush')) {
      drawn.length = 0;
      board.play = { ...state.play, overlay: [o] };
      board.assignments(1);
      out.push({ blitz: o.blitz, lines: drawn.filter(d => d.kind === 'line').map(d => d.w), heads: drawn.filter(d => d.kind === 'head').length });
    }
    board.play = state.play; board.poly = poly; board.arrow = arrow;
    const pb = [...document.querySelectorAll('.pb dt')].find(dt => dt.textContent === 'Arrows from the defense').nextElementSibling.textContent;
    return { out, pb };
  });
  const blitz = marks.out.filter(m => m.blitz), rush = marks.out.filter(m => !m.blitz);
  assert.ok(blitz.length >= 1 && rush.length >= 4, `${blitz.length} blitzers and ${rush.length} rushers`);
  assert.ok(blitz.every(m => m.heads === 2) && rush.every(m => m.heads === 1), `arrowheads: ${JSON.stringify(marks.out)}`);
  assert.ok(Math.min(...blitz.flatMap(m => m.lines)) >= 1.5 * Math.max(...rush.flatMap(m => m.lines)), `line widths: ${JSON.stringify(marks.out)}`);
  assert.match(marks.pb, /thicker, with a double head/);
  await p.context().close();
}

// Changing the call in the middle of a play lines the new one up from the start: none of the old play's clock is left
// over, so the new call isn't drawn faded as if it had been snapped.
{
  const p = await phone();
  const changes = [
    ['a play', () => p.getByRole('radio', { name: 'Four Verticals' }).click()],
    ['the side', () => p.click('[data-side="D"]')],
    ['New look', () => p.click('#theirsLook')],
  ];
  for (const [what, change] of changes) {
    await p.click('#snap');
    await p.waitForFunction(() => window.chalkTalk.state.t > 1, null, { timeout: 10000 });
    await change();
    await frames(p);
    // (the start is the snap, or before it when the new call has a man in motion)
    const at = await p.evaluate(() => { const { state, board } = window.chalkTalk; return { phase: state.phase, t: state.t - board.start(), board: board.t - board.start(), scrub: document.getElementById('scrub').value }; });
    assert.deepEqual(at, { phase: 'pre', t: 0, board: 0, scrub: '0' }, `changing ${what} mid-play`);
  }
  await p.context().close();
}

// Each side keeps your own call. Switch to the defense and back and the offense is the one you called, not the one the
// other coach picked while you were on defense; the same for the defense, and after a reload.
{
  const p = await phone();
  const calls = () => p.evaluate(() => { const { state } = window.chalkTalk; return { off: { ...state.off }, def: { ...state.def } }; });
  for (const name of ['Singleback', 'Left', 'Across', 'Power']) await p.getByRole('radio', { name }).click();
  const off = (await calls()).off;
  assert.deepEqual(off, { formation: 'single', play: 'power', flip: true, motion: 'across', hot: {} });
  await p.click('[data-side="D"]');
  await p.getByRole('radio', { name: 'Cover 4' }).click();
  const def = (await calls()).def;
  await p.click('[data-side="O"]');
  assert.deepEqual((await calls()).off, off, 'switching to the defense and back lost your offense');
  await p.click('[data-side="D"]');
  assert.deepEqual((await calls()).def, def, 'switching to the offense and back lost your defense');
  await p.reload();
  assert.deepEqual((await calls()).def, def, 'a reload lost your defense');
  await p.click('[data-side="O"]');
  assert.deepEqual((await calls()).off, off, 'a reload lost your offense');
  await p.context().close();
}

// Change your personnel and the other coach substitutes (nickel against three receivers, base against two backs), so a
// nickel defense rarely stays on against I-Form. Change only your play or strong side and he keeps his call: an audible.
{
  const p = await phone();
  const def = () => p.evaluate(() => ({ ...window.chalkTalk.state.def }));
  const before = await def();
  await p.getByRole('radio', { name: 'Mesh' }).click();
  await p.getByRole('radio', { name: 'Left' }).click();
  assert.deepEqual(await def(), before, 'changing your play or strong side changed their call');
  const nickel = await p.evaluate(() => {
    const { state } = window.chalkTalk, chip = name => [...document.querySelectorAll('#mineBody .chip')].find(b => b.textContent.startsWith(name));
    let n = 0;
    for (let k = 0; k < 30; k++) {
      chip('Gun Trips').click();
      Object.assign(state.def, { front: 'nickel', coverage: 'c3', pressure: 'four', disguise: false });
      chip('I-Form').click();
      if (state.def.front === 'nickel') n++;
    }
    return n;
  });
  assert.ok(nickel < 12, `a nickel defense stayed on against I-Form ${nickel} times in 30`);
  await p.context().close();
}
// His new call is hidden, so the board says he has substituted, before the snap and after it. A new play or strong side
// says nothing: he keeps his call. Turning his picking back on says he has a call, hidden until the snap.
{
  const p = await phone();
  const caption = () => p.textContent('#caption');
  await p.getByRole('radio', { name: 'I-Form' }).click();
  assert.equal(await caption(), 'New personnel: they\'ve substituted.', 'new personnel before the snap');
  for (const name of ['Power', 'Left']) {
    await p.getByRole('radio', { name }).click();
    assert.doesNotMatch(await caption(), /substituted/, `a new ${name === 'Left' ? 'strong side' : 'play'} in the same formation says they've substituted`);
  }
  await p.evaluate(() => { window.chalkTalk.snap(); window.chalkTalk.finish(); });
  await p.getByRole('radio', { name: 'Gun Doubles' }).click();
  assert.equal(await caption(), 'New personnel: they\'ve substituted.', 'new personnel after a snap');
  await p.click('#auto');
  assert.equal(await caption(), '', 'calling both sides');
  await p.click('#auto');
  assert.equal(await caption(), 'The other coach has his call. It\'s hidden until the snap.', 'turning his picking back on');
  await p.context().close();
}
// Calling both sides draws both choosers, each with all its calls, and New look goes; letting the other coach pick
// again leaves his card with only his hidden call. The same calling the defense.
{
  const p = await phone();
  const cards = () => p.evaluate(() => ({
    mine: [...document.querySelectorAll('#mineBody [role="radiogroup"]')].map(g => g.getAttribute('aria-label')),
    theirs: [...document.querySelectorAll('#theirsBody [role="radiogroup"]')].map(g => g.getAttribute('aria-label')),
    newLook: !document.getElementById('theirsLook').hidden,
  }));
  const OFF = ['Formation', 'Strong side', 'Motion', 'Play'], DEF = ['Front', 'Coverage', 'Pressure', 'Disguise'];
  assert.deepEqual(await cards(), { mine: OFF, theirs: [], newLook: true });
  await p.click('#auto');
  assert.deepEqual(await cards(), { mine: OFF, theirs: DEF, newLook: false }, 'calling both sides');
  await p.click('[data-side="D"]');
  assert.deepEqual(await cards(), { mine: DEF, theirs: OFF, newLook: false }, 'calling both sides, on defense');
  await p.click('#auto');
  assert.deepEqual(await cards(), { mine: DEF, theirs: [], newLook: true }, 'letting him pick again, on defense');
  await p.context().close();
}

// The labels button: off, the board draws no labels and the button says it's off; on, they're back.
{
  const p = await phone();
  const labels = () => p.evaluate(() => {
    const { state, board } = window.chalkTalk, drawn = [], fillText = board.ctx.fillText;
    board.ctx.fillText = function (t, ...rest) { if (state.play.players.some(q => q.label === t)) drawn.push(t); return fillText.call(this, t, ...rest); };
    board.render();
    board.ctx.fillText = fillText;
    return { state: state.labels, board: board.labels, drawn: drawn.length, pressed: document.getElementById('labels').getAttribute('aria-pressed') };
  });
  assert.deepEqual(await labels(), { state: true, board: true, drawn: 22, pressed: 'true' });
  await p.click('#labels');
  assert.deepEqual(await labels(), { state: false, board: false, drawn: 0, pressed: 'false' }, 'labels off');
  await p.click('#labels');
  assert.deepEqual(await labels(), { state: true, board: true, drawn: 22, pressed: 'true' }, 'labels on again');
  await p.context().close();
}

// A call you've seen stays seen. Change your play after a snap and their call is still shown, as the same one as last
// snap, until New look has him pick again: that one is hidden until the next snap. New look is in their card before the
// snap too, whenever he's picking.
{
  const p = await phone();
  const def = () => p.evaluate(() => ({ ...window.chalkTalk.state.def }));
  const first = await def();
  await p.click('#theirsLook');
  assert.notDeepEqual(await def(), first, 'New look before the snap kept their call');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.phase), 'pre');
  await p.evaluate(() => { window.chalkTalk.snap(); window.chalkTalk.finish(); });
  const called = (await p.textContent('#theirsHint')).match(/^They called: (.*)\.$/)?.[1];
  assert.ok(called, 'their call is out after the snap');
  await p.getByRole('radio', { name: 'Mesh' }).click();
  assert.equal(await p.textContent('#theirsHint'), `Same call as last snap: ${called}. New look gets you a new one.`);
  assert.doesNotMatch(await p.textContent('#matchup'), /hidden/, 'a call you have seen is hidden again on the board');
  assert.equal(await p.evaluate(() => window.chalkTalk.board.showTheirs), true, 'their drawn-up play is hidden again');
  await p.click('#theirsLook');
  assert.match(await p.textContent('#matchup'), /coverage hidden/, 'a new look is hidden until the snap');
  assert.match(await p.textContent('#theirsHint'), /^Hidden until the snap/);
  // The board says what New look did, even when it can't be seen: on defense a new play from the same formation lines up
  // just like the last one.
  assert.equal(await p.textContent('#caption'), 'New look: they\'ve changed their call.');
  await p.click('[data-side="D"]');
  const looks = await p.evaluate(() => {
    const { state } = window.chalkTalk, seen = {};
    for (let k = 0; k < 80; k++) {
      const was = `${state.off.formation} ${state.off.flip}`;
      document.getElementById('theirsLook').click();
      seen[was === `${state.off.formation} ${state.off.flip}` ? 'same' : 'new'] = document.getElementById('caption').textContent;
    }
    return seen;
  });
  assert.deepEqual(looks, { same: 'New look: same formation, a new play.', new: 'New look: they\'ve changed their call.' });
  await p.click('#auto');
  assert.equal(await p.isVisible('#theirsLook'), false, 'New look is there when you call both sides');
  await p.context().close();
}

// What did they play? Calling the offense with the other coach picking, a snap of a call you haven't seen asks, in his
// card, with the five coverages as buttons, and his call stays hidden until it's answered: the board's matchup line and
// drawn-up defense, a defender's card, the chart, and at the whistle the result card, whose coach's note gives way to
// the same question. Cover 0's blitz line doesn't name it. The answer says what gave it away, or what told it from the
// one named, and keeps a streak on this device. Snap again doesn't ask again; New look does. A reload keeps the question
// open. The switch turns it off (and lets his call out), and it isn't asked calling the defense.
{
  const c = await browser.newContext({ quiz: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  const COVS = ['Cover 0', 'Cover 1', 'Cover 2', 'Cover 3', 'Cover 4'];
  const buttons = host => p.$$eval(`${host} button`, b => b.map(x => x.textContent));
  const theirs = def => p.evaluate(def => { const { state, lineUp } = window.chalkTalk; Object.assign(state.def, { disguise: false }, def); lineUp(); }, def);
  const whistle = () => p.evaluate(() => { const { state, board, finish } = window.chalkTalk; state.t = board.duration(); finish(); });
  const saved = () => p.evaluate(() => { const s = JSON.parse(localStorage.getItem('chalk-talk.v1')); return { quiz: s.quiz, streak: s.streak, best: s.best }; });
  const verdict = host => p.textContent(`${host} .ask-verdict`);
  const streak = () => p.evaluate(() => document.querySelector('#theirsAsk .ask-streak')?.textContent ?? '');
  assert.equal(await p.isChecked('#quiz'), true, 'the question is on to start with');
  assert.equal(await p.isVisible('#askSwitch'), true, 'its switch is in their card');
  assert.equal(await p.isVisible('#theirsAsk'), false, 'asked before the snap');
  await theirs({ front: 'nickel', coverage: 'c0', pressure: 'blitz' });
  await p.click('#snap');
  assert.deepEqual(await buttons('#theirsAsk'), COVS, 'their card asks what they played, with the five coverages');
  assert.equal(await p.textContent('#theirsAsk .ask-q'), 'What did they play?');
  assert.equal(await p.isVisible('#theirsHint'), false, 'the question takes the place of their call in their card');
  assert.equal(await p.textContent('#say'), 'What did they play? Name their coverage, in their call.');
  assert.match(await p.textContent('#matchup'), /Nickel · coverage hidden$/, 'the board names the coverage before it is answered');
  assert.equal(await p.evaluate(() => window.chalkTalk.board.showTheirs), false, 'the board draws their play before it is answered');
  assert.doesNotMatch(await p.textContent('#chartHint'), /until the snap/);
  assert.match(await p.textContent('#chartHint'), /Their real call stays hidden until you name their coverage\./);
  await p.evaluate(() => { window.chalkTalk.pause(); document.querySelector('#jobsBody .jobs-team:last-child button').click(); });
  assert.match(await p.textContent('#whoJob'), /His job is hidden until you name their coverage\.$/, 'a defender\'s card gives his job away before it is answered');
  await p.click('#whoClose');
  await whistle();
  assert.equal(await p.isVisible('#result'), true);
  assert.equal(await p.textContent('#resVs'), 'On 1st & 10, Smash from Gun Trips against Nickel with a blitz.', 'the result card names the coverage before it is answered');
  assert.deepEqual(await buttons('#noteAsk'), COVS, 'the coach\'s note gives way to the question');
  assert.deepEqual(await p.$$eval('#note, #noteNow, #reads', els => els.map(e => e.hidden)), [true, true, true], 'the coach\'s note is up before it is answered');
  assert.ok(!(await p.textContent('#story')).includes('Cover 0'), 'the play-by-play names Cover 0 before it is answered');
  assert.match(await p.textContent('#story'), /The .+ blitz(es)?\./, 'the blitz line is still there');
  assert.match(await p.textContent('#say'), /Name their coverage under the board, and the coach's note says why\.$/);
  // A wrong answer, in the result card: what told it from the one named, and the call is out everywhere.
  await p.click('#noteAsk button:text-is("Cover 1")');
  assert.equal(await verdict('#noteAsk'), 'It was Cover 0: the corners were pressed, but nobody was deep. Cover 1 has one deep.');
  assert.equal(await p.evaluate(() => document.activeElement.className), 'ask-verdict', 'the focus goes to the answer');
  assert.equal(await verdict('#theirsAsk'), await verdict('#noteAsk'), 'their card says it too');
  assert.equal(await p.textContent('#theirsHint'), 'They called: Nickel, Cover 0.');
  assert.match(await p.textContent('#note'), /^How Smash does against Cover 0: /, 'the coach\'s note once it is answered');
  assert.deepEqual(await p.$$eval('#note, #noteNow, #reads', els => els.map(e => e.hidden)), [false, false, false]);
  assert.match(await p.textContent('#story'), /Cover 0: the .+ blitz/, 'the play-by-play says Cover 0 once it is answered');
  assert.match(await p.textContent('#matchup'), /Nickel · Cover 0$/);
  assert.equal(await p.evaluate(() => window.chalkTalk.board.showTheirs), true);
  assert.equal(await p.textContent('#resVs'), 'On 1st & 10, Smash from Gun Trips against Nickel, Cover 0.');
  assert.equal(await streak(), '', 'a streak before there is one');
  assert.deepEqual(await saved(), { quiz: true, streak: 0, best: 0 });
  // Snap again: the call is out, so it isn't asked.
  await p.click('#again');
  assert.equal(await p.isVisible('#theirsAsk'), false, 'Snap again asks again');
  assert.match(await p.textContent('#theirsHint'), /^They called: /);
  // New look asks again; right answers in a row, and two wrong ones that say what told them apart.
  const round = async (def, guess) => {
    await p.click('#theirsLook');
    await theirs(def);
    await p.click('#snap');
    await p.click(`#theirsAsk button:text-is("${guess}")`);
    return [await verdict('#theirsAsk'), await streak()];
  };
  assert.deepEqual(await round({ front: 'nickel', coverage: 'c2', pressure: 'four' }, 'Cover 2'), ['Right: two deep and the corners about 5 yards off, Cover 2.', '1 right in a row.']);
  assert.deepEqual(await round({ front: 'over', coverage: 'c3', pressure: 'blitz' }, 'Cover 3'), ['Right: one deep and the corners 7 yards or more off, Cover 3.', '2 right in a row.']);
  assert.deepEqual(await round({ front: 'nickel', coverage: 'c1', pressure: 'four' }, 'Cover 1'), ['Right: one deep and the corners pressed, Cover 1.', '3 right in a row.']);
  assert.deepEqual(await saved(), { quiz: true, streak: 3, best: 3 });
  assert.deepEqual(await round({ front: 'nickel', coverage: 'c2', pressure: 'four' }, 'Cover 4'),
    ['It was Cover 2: two deep, but the corners sat about 5 yards off. Cover 4 has the corners 7 yards or more off.', 'Your best: 3 in a row.']);
  assert.deepEqual(await round({ front: 'under', coverage: 'c3', pressure: 'four' }, 'Cover 4'),
    ['It was Cover 3: the corners sat 7 yards or more off, but one safety was deep. Cover 4 has two deep.', 'Your best: 3 in a row.']);
  assert.deepEqual(await round({ front: 'nickel', coverage: 'c4', pressure: 'four' }, 'Cover 4'), ['Right: two deep and the corners 7 yards or more off, Cover 4.', '1 right in a row. Your best: 3.']);
  assert.deepEqual(await saved(), { quiz: true, streak: 1, best: 3 });
  // A reload with the question open keeps it open, and the streak.
  await p.click('#theirsLook');
  await p.click('#snap');
  await p.reload();
  assert.deepEqual(await buttons('#theirsAsk'), COVS, 'a reload lost the open question');
  assert.match(await p.textContent('#matchup'), /coverage hidden$/);
  assert.equal(await streak(), '1 right in a row so far.');
  // A new play keeps the question (he keeps his call), and the snap after it is still asked.
  await p.getByRole('radio', { name: 'Mesh' }).click();
  assert.deepEqual(await buttons('#theirsAsk'), COVS, 'a new play of yours dropped the question');
  assert.match(await p.textContent('#matchup'), /coverage hidden$/, 'a new play of yours let his coverage out');
  await p.click('#snap');
  assert.deepEqual(await buttons('#theirsAsk'), COVS);
  // The switch off: the question goes and his call is out, it's kept, and the next look isn't asked.
  await p.click('#quiz');
  assert.equal(await p.isVisible('#theirsAsk'), false);
  assert.match(await p.textContent('#theirsHint'), /^They called: /, 'turning the question off let his call out');
  assert.doesNotMatch(await p.textContent('#matchup'), /hidden/);
  assert.deepEqual(await saved(), { quiz: false, streak: 1, best: 3 });
  await p.click('#theirsLook');
  await p.click('#snap');
  assert.equal(await p.isVisible('#theirsAsk'), false, 'asked with the question off');
  await p.click('#quiz');
  // Calling the defense, it isn't asked, and the switch isn't there.
  await p.click('[data-side="D"]');
  assert.equal(await p.isVisible('#askSwitch'), false, 'the switch is there calling the defense');
  await p.click('#snap');
  // (his offense can send a man in motion first: his call is out once the ball is snapped, a few seconds on)
  await p.waitForFunction(() => /^They called: /.test(document.getElementById('theirsHint').textContent), null, { timeout: 10000 });
  assert.equal(await p.isVisible('#theirsAsk'), false, 'asked calling the defense');
  // Turned off in another tab while this one is asking: the question goes here too, and his call is out.
  await p.click('[data-side="O"]');
  await p.click('#theirsLook');
  await p.click('#snap');
  assert.deepEqual(await buttons('#theirsAsk'), COVS);
  const other = await c.newPage();
  await other.goto(base);
  await other.click('#quiz');
  await p.waitForFunction(() => !document.getElementById('quiz').checked);
  assert.equal(await p.isVisible('#theirsAsk'), false, 'the question stayed up after another tab turned it off');
  assert.doesNotMatch(await p.textContent('#matchup'), /hidden/, 'his call stayed hidden after another tab turned the question off');
  await c.close();
}

// A disguise. Calling the defense, the Disguise row under Pressure is off to start with and only Cover 1 and Cover 3
// take it; picked, the board shows two deep, the play-by-play names the rotation, and the coach's note says what it
// showed and what it played. Calling the offense, a disguised call from the other coach is asked about like any other:
// the rotation line doesn't name the coverage until it's answered, and the answer says what gave it away. A shared
// link carries it, and one from before there were disguises still opens.
{
  const c = await browser.newContext({ quiz: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  const row = () => p.evaluate(() => {
    const pick = [...document.querySelectorAll('#mineBody .pick')].find(x => x.querySelector('.pick-label').textContent === 'Disguise');
    return { on: pick.querySelector('[aria-checked="true"]').textContent, disabled: pick.querySelector('.chip').disabled, blurb: pick.querySelector('.blurb').textContent };
  });
  await p.click('[data-side="D"]');
  await p.getByRole('radio', { name: 'Cover 2' }).click();
  assert.deepEqual(await row(), { on: 'None', disabled: true, blurb: 'Only Cover 1 and Cover 3 disguise here: they can line up two deep, the way Cover 4 does, and rotate a safety down at the snap.' });
  await p.getByRole('radio', { name: 'Cover 3' }).click();
  assert.deepEqual(await row(), { on: 'None', disabled: false, blurb: 'Cover 3 lines up the way it plays. Or disguise it: show two deep, the way Cover 4 lines up, and rotate a safety down at the snap.' }, 'the honest look is the default');
  await p.getByRole('radio', { name: 'Show two deep' }).click();
  assert.equal((await row()).on, 'Show two deep');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.play.box.high), 2, 'a disguised Cover 3 lines up two deep');
  assert.match(await p.textContent('#matchup'), /Cover 3 \(disguised\)/);
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  assert.match(await p.textContent('#story'), /The strong safety rotates down at the snap: Cover 3\./);
  assert.match(await p.textContent('#resVs'), /, disguised Cover 3\.$/);
  assert.equal(await p.textContent('#reads li:first-child'), 'Safeties: showed two deep, played Cover 3. The strong safety rotated down at the snap, and the free safety went to the middle.');
  assert.match(await p.textContent('#note'), /Disguised, the strong safety starts (12 yards )?deep and has to come down at the snap/);
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).def.disguise), true, 'the disguise is kept with your call');
  // The link carries it; one cut at the seed opens without it.
  await c.grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.click('#share');
  const link = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#p=D\.\w+\.\w+\.[01]\.nickel\.c3\.four\.\d+\.1\.\w+\.1and10$/, `the link is ${link}`);
  await p.goto(base + link.slice(link.indexOf('#')));
  await p.waitForFunction(() => window.chalkTalk?.state.phase !== 'pre');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def), { front: 'nickel', coverage: 'c3', pressure: 'four', disguise: true });
  await p.goto(base + link.slice(link.indexOf('#')).replace(/\.1\.\w+\.1and10$/, ''));
  await p.waitForFunction(() => window.chalkTalk?.state.phase !== 'pre');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.def.disguise), false, 'a link from before disguises opens without one');
  // The other coach's disguise, asked about.
  await p.click('[data-side="O"]');
  await p.click('#auto');
  if (!(await p.isChecked('#auto'))) await p.click('#auto');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'four', disguise: true }); lineUp(); });
  assert.match(await p.textContent('#theirsHint'), /^Hidden until the snap\./);
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  assert.match(await p.textContent('#story'), /The strong safety rotates down at the snap\./);
  assert.ok(!(await p.textContent('#story')).includes('Cover 1'), 'the rotation names the coverage before it is answered');
  assert.match(await p.textContent('#theirsAsk .ask-how'), /what the safeties did at the snap/);
  await p.click('#noteAsk button:text-is("Cover 4")');
  assert.equal(await p.textContent('#noteAsk .ask-verdict'), 'It was Cover 1, disguised: it showed two deep and the corners 7 yards or more off, the way Cover 4 lines up, then the strong safety rotated down at the snap and the corners ran with their receivers.');
  assert.match(await p.textContent('#story'), /The strong safety rotates down at the snap: Cover 1\./, 'the coverage is named once it is answered');
  assert.equal(await p.textContent('#theirsHint'), 'They called: Nickel, disguised Cover 1, rush four.');
  await p.click('#theirsLook');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.def, { front: 'nickel', coverage: 'c3', pressure: 'four', disguise: true }); lineUp(); });
  await p.click('#snap');
  await p.click('#theirsAsk button:text-is("Cover 3")');
  assert.equal(await p.textContent('#theirsAsk .ask-verdict'), 'Right: it showed two deep, then the strong safety rotated down at the snap and the corners dropped into deep thirds: Cover 3.');
  // About one of his calls in four is a disguise, always Cover 1 or Cover 3.
  const share = await p.evaluate(() => {
    const { state, rollTheirs } = window.chalkTalk;
    let n = 0, dis = 0;
    for (let k = 0; k < 800; k++) { rollTheirs(); n++; if (state.def.disguise && ['c1', 'c3'].includes(state.def.coverage)) dis++; }
    return dis / n;
  });
  assert.ok(share > 0.19 && share < 0.31, `${Math.round(share * 100)}% of his calls are disguised`);
  await c.close();
}

// Motion. A Motion row under Strong side: None to start with, Across or Jet. With one, the board plays the time before
// the snap: the clock counts it down ("−2.0s"), a mark on the scrubber is at the snap, and the play-by-play says what the
// defense did about it: in man coverage his man runs with him, in zone nobody does. Across, he's set on the other side at
// the snap; jet, he's crossing the middle at full speed. A shared link carries it, a link without it opens without it,
// it's kept with your call, and calling the defense, the other coach sends a man in motion about one snap in three.
{
  const p = await phone();
  const row = () => p.evaluate(() => {
    const pick = [...document.querySelectorAll('#mineBody .pick')].find(x => x.querySelector('.pick-label').textContent === 'Motion');
    return { chips: [...pick.querySelectorAll('.chip')].map(b => b.textContent), on: pick.querySelector('[aria-checked="true"]').textContent, blurb: pick.querySelector('.blurb').textContent };
  });
  assert.deepEqual(await row(), { chips: ['None', 'Across', 'Jet'], on: 'None', blurb: 'Everyone stays put until the snap. Or send the H across the formation first, and watch who goes with him: it shows man or zone.' });
  assert.equal(await p.evaluate(() => window.chalkTalk.board.start()), 0, 'no motion, no time before the snap');
  await p.getByRole('radio', { name: 'Across' }).click();
  assert.match((await row()).blurb, /^Before the snap the H runs across the formation, behind the line, and sets on the weak side: two receivers each side\. If a defender runs with him, it's man coverage/);
  assert.match(await p.textContent('#matchup'), /^1st & 10 · Gun Trips · H across · Smash/);
  await p.click('#auto');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'four', disguise: false }); lineUp(); });
  const t0 = await p.evaluate(() => window.chalkTalk.board.start());
  assert.ok(t0 < -2.5, `the motion takes ${-t0} s`);
  assert.equal(await p.textContent('#clock'), '–', 'before Snap');
  assert.deepEqual(await p.$$eval('#marks i', l => l.map(i => i.dataset.kind)), ['snap'], 'the snap is marked on the scrubber from the start');
  // Snapped, and caught a second and a half in, with the man in motion on his way: the clock is before the snap.
  const at = t => p.evaluate(t => {
    const { state, play, pause } = window.chalkTalk;
    if (state.phase === 'pre') play();
    pause();
    const s = document.getElementById('scrub'), F = state.play.frames;
    s.value = String(F.findIndex(f => f.t >= t - 1e-6)); s.dispatchEvent(new Event('input'));
    return { clock: document.getElementById('clock').textContent, caption: document.getElementById('caption').textContent, aria: s.getAttribute('aria-valuetext') };
  }, t);
  let now = await at(t0 + 1.5);
  assert.equal(now.clock, `\u2212${(-(t0 + 1.5)).toFixed(1)}s`);
  assert.match(now.aria, /^\d\.\d seconds before the snap: /);
  assert.match(now.caption, /The nickel back runs with him: man coverage\./);
  now = await at(0);
  assert.equal(now.clock, '0.0s');
  assert.match(now.caption, /He sets on the other side: two receivers each side now\./);
  const H = await p.evaluate(() => { const { state, board } = window.chalkTalk, i = state.play.motion.who; return board.pos(0, i); });
  assert.ok(Math.abs(H.x + 10) < 0.01, `across: set in the slot on the other side at the snap, at ${H.x}`);
  await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; state.t = board.duration(); finish(); });
  assert.match(await p.textContent('#resVs'), /^On 1st & 10, Smash from Gun Trips, the H in motion across, against Nickel, Cover 1\.$/);
  assert.ok((await p.locator('#reads li').allTextContents()).includes('Motion: the nickel back ran with the H. Someone running with a man in motion means man coverage.'));
  assert.match(await p.textContent('#note'), / Here the H went in motion first, and the play was run from where the receivers stood then: two each side\.$/);
  assert.match(await p.textContent('#boardWords'), / Before the snap the H goes in motion across to the left\. /, 'the board in words says where he goes');
  const first = await p.$eval('#story li button', b => ({ text: b.textContent, label: b.getAttribute('aria-label') }));
  assert.match(first.text, /^\u2212\d\.\ds$/, 'the play-by-play\'s times before the snap');
  assert.match(first.label, /^\d\.\d seconds before the snap: watch it again$/);
  // In a zone, nobody follows him.
  await p.evaluate(() => { const { state, lineUp, snap, finish } = window.chalkTalk; Object.assign(state.def, { coverage: 'c3' }); lineUp(); snap(); finish(); });
  assert.match(await p.textContent('#story'), /Nobody follows him: zone\./);
  assert.ok((await p.locator('#reads li').allTextContents()).includes('Motion: nobody ran with the H; the defense only slid over. That means zone.'));
  // Jet: crossing the middle at full speed at the snap.
  await p.getByRole('radio', { name: 'Jet' }).click();
  const jet = await p.evaluate(() => { const { state, board } = window.chalkTalk, i = state.play.motion.who; return { t0: board.start(), x: board.pos(0, i).x, v: (board.pos(0, i).x - board.pos(-0.05, i).x) / 0.05 }; });
  assert.ok(jet.t0 < -1 && jet.t0 > -2.5 && Math.abs(jet.x) < 1 && Math.abs(jet.v) > 7, `jet: ${JSON.stringify(jet)}`);
  // (at the snap he's still short of the middle, on the side he started from: the words say where he's going)
  assert.match(await p.textContent('#boardWords'), / Before the snap the H goes in jet motion across to the left\. /, 'the board in words says where the jet man goes');
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).off.motion), 'jet', 'the motion is kept with your call');
  // The link carries it; one from before motion opens without it.
  await p.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  await p.click('#share');
  const link = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#p=O\.trips\.smash\.0\.nickel\.c3\.four\.\d+\.0\.jet\.1and10$/, `the link is ${link}`);
  await p.goto(base + link.slice(link.indexOf('#')));
  await p.waitForFunction(() => window.chalkTalk?.state.phase !== 'pre');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.off.motion), 'jet');
  await p.goto(base + link.slice(link.indexOf('#')).replace(/\.jet\.1and10$/, ''));
  await p.waitForFunction(() => window.chalkTalk?.state.phase !== 'pre');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.off.motion), 'none', 'a link from before motion opens without it');
  await p.goto(base + link.slice(link.indexOf('#')).replace(/\.jet\.1and10$/, '.zoom.1and10'));
  await p.waitForFunction(() => location.hash === '');
  assert.equal(await p.textContent('#theirsHint'), 'That link is for a play this version doesn\'t have.');
  // Calling the defense, the other coach sends a man in motion about one snap in three.
  const share = await p.evaluate(() => {
    const { state, rollTheirs } = window.chalkTalk;
    document.querySelector('[data-side="D"]').click();
    if (!state.auto) document.getElementById('auto').click();
    let n = 0;
    for (let k = 0; k < 600; k++) { rollTheirs(); if (state.off.motion !== 'none') n++; }
    return n / 600;
  });
  assert.ok(share > 0.26 && share < 0.41, `${Math.round(share * 100)}% of his plays have motion`);
  // His play stays hidden through his motion, in words as on the board, until the ball is snapped: then it's out.
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'doubles', play: 'flood', flip: false, motion: 'jet' }); state.seen = false; lineUp(); });
  const during = await at(-0.5);
  assert.ok(during.clock.startsWith('\u2212'), `before the snap: ${during.clock}`);
  const words = () => p.evaluate(() => ({ matchup: document.getElementById('matchup').textContent, say: document.getElementById('say').textContent, jobs: document.getElementById('jobsHint').textContent, drawn: window.chalkTalk.board.shows('O') }));
  let said = await words();
  assert.match(said.matchup, /play hidden/, 'his play is named during his motion');
  assert.doesNotMatch(said.say, /They called/, 'his play is said during his motion');
  assert.match(said.jobs, /Their jobs stay hidden until the snap/);
  assert.equal(said.drawn, false, 'his routes are drawn during his motion');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.seen), false);
  await at(0.2);
  said = await words();
  assert.match(said.matchup, /Gun Doubles · H jet · Flood/, 'his play is out once the ball is snapped');
  assert.equal(said.say, 'They called: Gun Doubles, strength to your left, the H in jet motion, Flood.');
  assert.doesNotMatch(said.jobs, /stay hidden/);
  assert.equal(said.drawn, true, 'his drawn-up play is on the board once the ball is snapped');
  await p.context().close();
}

// Drills: a button for each above Your call. One takes the other coach's picking over for five snaps: his call is the
// drill's (his front set to your personnel), hidden until the first snap, with his switch, New look and the question
// after the snap out of the way. Each snap counts once at the whistle, however often it's watched or scrubbed to the
// end, and a reload keeps the count. After the fifth the drill says how it went and gives the coach's line, and his
// picking goes back to how you had it. Run it again starts over; Stop ends it sooner. The run drill is on defense, with
// a new run from I-Form each snap, and a change of side ends a drill.
{
  const c = await browser.newContext({ quiz: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  const card = () => p.evaluate(() => ({
    pressed: [...document.querySelectorAll('#drillChips button')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent),
    hint: !document.getElementById('drillsHint').hidden,
    now: document.getElementById('drillNow').hidden ? null : document.getElementById('drillNow').innerText.replace(/\s+/g, ' ').trim(),
  }));
  const his = () => p.evaluate(() => ({ auto: window.chalkTalk.state.auto, side: window.chalkTalk.state.side, switch: !document.getElementById('autoSwitch').hidden, newLook: !document.getElementById('theirsLook').hidden, ask: !document.getElementById('askSwitch').hidden }));
  // A snap played to the whistle, and whether it worked: 4 yards or more for the offense, as the result card counts.
  const down = () => p.evaluate(() => {
    const { state, board, snap, finish } = window.chalkTalk;
    snap(); state.t = board.duration(); finish();
    const r = state.play.result, n = Math.sign(r.yards) * Math.round(Math.abs(r.yards));
    return (r.kind === 'run' || r.kind === 'catch') && n >= 4;
  });
  assert.deepEqual(await p.$$eval('#drillChips button', b => b.map(x => x.textContent)), DRILLS.map(d => d.name));
  assert.deepEqual(DRILLS.map(d => d.name), ['Beat Cover 2', 'Beat Cover 3', 'Beat the blitz', 'Stop the run against I-Form']);
  assert.deepEqual(await card(), { pressed: [], hint: true, now: null });
  assert.ok(await p.evaluate(() => document.getElementById('drills').compareDocumentPosition(document.getElementById('mine')) & Node.DOCUMENT_POSITION_FOLLOWING), 'the drills are above Your call');
  await p.click('#drillChips button:text-is("Beat Cover 2")');
  const D = DRILLS[0];
  assert.deepEqual(await card(), { pressed: ['Beat Cover 2'], hint: false, now: `Beat Cover 2. ${D.brief} On 1st & 10, a snap that gains 4 yards or more counts. Snap 1 of 5. Stop the drill` });
  assert.deepEqual(await his(), { auto: true, side: 'O', switch: false, newLook: false, ask: false }, 'in a drill');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def), { front: 'nickel', coverage: 'c2', pressure: 'four', disguise: false });
  assert.equal(await p.textContent('#caption'), 'Drill: Beat Cover 2. Call a play, then Snap.');
  assert.match(await p.textContent('#matchup'), /coverage hidden$/, 'the drill\'s call isn\'t hidden before the first snap');
  // New personnel: he sets his front to it, and keeps the drill's coverage.
  await p.getByRole('radio', { name: 'I-Form' }).click();
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def), { front: 'over', coverage: 'c2', pressure: 'four', disguise: false }, 'against two backs');
  await p.getByRole('radio', { name: 'Gun Trips' }).click();
  let ok = 0;
  for (let k = 1; k <= 2; k++) {
    if (await down()) ok++;
    assert.equal(await p.isVisible('#theirsAsk'), false, 'a drill asks what they played');
    assert.equal((await card()).now, `Beat Cover 2. ${D.brief} On 1st & 10, a snap that gains 4 yards or more counts. ${k} of 5 snaps: ${ok} gained 4 yards or more. Stop the drill`);
  }
  assert.match(await p.textContent('#say'), new RegExp(`Beat Cover 2: ${ok} of 2 snaps so far gained 4 yards or more\\.$`));
  assert.equal(await p.textContent('#actionsNote'), `Snap again: the next snap of the drill. 2 of 5 snaps so far: ${ok} gained 4 yards or more.`);
  // Watched again, scrubbed back and to the end again, and reloaded, the same snap counts once.
  await p.evaluate(() => { const s = document.getElementById('scrub'); s.value = '0'; s.dispatchEvent(new Event('input')); s.value = s.max; s.dispatchEvent(new Event('input')); });
  await p.evaluate(() => { const { state, board, play, finish } = window.chalkTalk; play(); state.t = board.duration(); finish(); });
  await p.reload();
  assert.equal((await card()).now, `Beat Cover 2. ${D.brief} On 1st & 10, a snap that gains 4 yards or more counts. 2 of 5 snaps: ${ok} gained 4 yards or more. Stop the drill`, 'a snap counted twice, or a reload lost the drill');
  assert.deepEqual(await his(), { auto: true, side: 'O', switch: false, newLook: false, ask: false }, 'in a drill after a reload');
  // A change of play between snaps is part of it: the drill goes on.
  await p.getByRole('radio', { name: 'Four Verticals' }).click();
  for (let k = 3; k <= 5; k++) if (await down()) ok++;
  assert.deepEqual(await card(), { pressed: [], hint: false, now: `Beat Cover 2: ${ok} of 5 gained 4 yards or more. ${D.note} Run it again Done` });
  assert.deepEqual(await his(), { auto: true, side: 'O', switch: true, newLook: true, ask: true }, 'after the drill, his picking is back');
  assert.match(await p.textContent('#theirsHint'), /^They called: Nickel, Cover 2, rush four\.$/);
  assert.equal(await p.textContent('#actionsNote'), `That was the drill's last snap: ${ok} of 5 gained 4 yards or more. The coach's word on it is in Drills. Snap again: the same two calls, played out fresh. New look: the other coach changes his call.`);
  assert.match(await p.textContent('#say'), new RegExp(`Beat Cover 2: ${ok} of 5 gained 4 yards or more, and the coach has a word on it\\.$`));
  await down();
  assert.equal(await p.textContent('#actionsNote'), 'Snap again: the same two calls, played out fresh. New look: the other coach changes his call.', 'a snap after the drill says it was its last');
  assert.equal((await card()).now?.startsWith(`Beat Cover 2: ${ok} of 5`), true, 'a snap after the drill counted');
  // A new situation leaves the debrief saying what it counted, in the situation it ran in, after a reload too.
  await p.getByRole('radio', { name: '3rd & 8' }).click();
  assert.equal((await card()).now, `Beat Cover 2 on 1st & 10: ${ok} of 5 gained 4 yards or more. ${D.note} Run it again Done`, 'a new situation changed what the finished drill counted');
  await p.reload();
  assert.equal((await card()).now, `Beat Cover 2 on 1st & 10: ${ok} of 5 gained 4 yards or more. ${D.note} Run it again Done`, 'after a reload');
  await p.getByRole('radio', { name: '1st & 10' }).click();
  assert.equal((await card()).now, `Beat Cover 2: ${ok} of 5 gained 4 yards or more. ${D.note} Run it again Done`);
  // Run it again starts over, with the focus on the drill's button; Stop ends it, and Done puts a debrief away.
  await p.click('#drillNow button:text-is("Run it again")');
  assert.equal((await card()).now, `Beat Cover 2. ${D.brief} On 1st & 10, a snap that gains 4 yards or more counts. Snap 1 of 5. Stop the drill`);
  assert.equal(await p.evaluate(() => document.activeElement.textContent), 'Beat Cover 2');
  await p.click('#drillNow button:text-is("Stop the drill")');
  assert.deepEqual(await card(), { pressed: [], hint: true, now: null });
  assert.deepEqual(await his(), { auto: true, side: 'O', switch: true, newLook: true, ask: true });
  // What counts goes by the down, and a drill is five snaps in one situation: a new one starts it over.
  await p.click('#drillChips button:text-is("Beat Cover 2")');
  await down();
  await p.getByRole('radio', { name: '3rd & 8' }).click();
  assert.equal(await p.textContent('#caption'), '3rd & 8: the drill starts over.');
  assert.equal((await card()).now, `Beat Cover 2. ${D.brief} On 3rd & 8, a snap that makes the first down counts. Snap 1 of 5. Stop the drill`);
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def), { front: 'nickel', coverage: 'c2', pressure: 'four', disguise: false }, 'a new situation changed the drill\'s call');
  let firsts = 0;
  for (let k = 1; k <= 3; k++) {
    if (await p.evaluate(() => {
      const { state, board, snap, finish } = window.chalkTalk;
      snap(); state.t = board.duration(); finish();
      const r = state.play.result, n = Math.sign(r.yards) * Math.round(Math.abs(r.yards));
      return (r.kind === 'run' || r.kind === 'catch') && n >= 8;
    })) firsts++;
  }
  assert.equal((await card()).now, `Beat Cover 2. ${D.brief} On 3rd & 8, a snap that makes the first down counts. 3 of 5 snaps: ${firsts} made the first down. Stop the drill`);
  await p.click('#drillNow button:text-is("Stop the drill")');
  await p.getByRole('radio', { name: '1st & 10' }).click();
  // The blitz drill doesn't name its coverage before the first snap.
  await p.click('#drillChips button:text-is("Beat the blitz")');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def.coverage), 'c0');
  assert.ok(!(await card()).now.includes('Cover 0'), 'the blitz drill says which coverage');
  // The run drill: on defense, a run from I-Form each snap, hidden until it's snapped, and another after a change of
  // your defense.
  await p.click('#drillChips button:text-is("Stop the run against I-Form")');
  assert.deepEqual(await his(), { auto: true, side: 'D', switch: false, newLook: false, ask: false });
  assert.match(await p.textContent('#matchup'), /^1st & 10 · I-Form · play hidden/);
  const runs = new Set(), stops = [];
  for (let k = 0; k < 5; k++) {
    const worked = await down();
    stops.push(!worked);
    const off = await p.evaluate(() => window.chalkTalk.state.off);
    assert.equal(off.formation, 'iform');
    assert.ok(['iz', 'oz', 'power', 'draw'].includes(off.play), `the run drill called ${off.play}`);
    runs.add(`${off.play} ${off.flip}`);
    if (k === 1) {
      assert.match(await p.textContent('#actionsNote'), /^Snap again: the next snap of the drill, a new run\. 2 of 5 snaps so far: [0-2] held under 4 yards\.$/);
      await p.getByRole('radio', { name: 'Cover 1' }).click();
      assert.match(await p.textContent('#matchup'), /play hidden/, 'a change of defense in the run drill showed his next run');
    }
  }
  assert.ok(runs.size > 1, `the run drill ran the same run every snap: ${[...runs]}`);
  assert.equal((await card()).now?.split('.')[0], `Stop the run against I-Form: ${stops.filter(Boolean).length} of 5 held under 4 yards`);
  // Calling both sides of your own: a drill has him pick while it lasts, and then it's back to both sides. A change of
  // side ends a drill.
  await p.click('#drillNow button:text-is("Done")');
  assert.deepEqual(await card(), { pressed: [], hint: true, now: null });
  await p.click('#auto');
  await p.click('#drillChips button:text-is("Beat Cover 3")');
  assert.deepEqual(await his(), { auto: true, side: 'O', switch: false, newLook: false, ask: false });
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).auto), false, 'a drill saved "Let the other coach pick" as on');
  // Over, it's back to both sides with the drill's call as his, and a reload keeps that and how it went.
  for (let k = 0; k < 5; k++) await down();
  assert.deepEqual(await his(), { auto: false, side: 'O', switch: true, newLook: false, ask: false });
  const after = await card();
  await p.reload();
  assert.deepEqual(await card(), after, 'a reload after the drill, calling both sides, lost how it went');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.def.coverage), 'c3', 'a reload after the drill, calling both sides, lost the drill\'s call');
  await p.click('#drillNow button:text-is("Run it again")');
  await p.click('[data-side="D"]');
  assert.deepEqual(await card(), { pressed: [], hint: true, now: null }, 'a change of side ended the drill');
  assert.deepEqual(await his(), { auto: false, side: 'D', switch: true, newLook: false, ask: false });
  await c.close();
}

// Show on the board, from the playbook: every formation, front, coverage and play has a button beside its name that
// puts it in the call, lines it up and brings the board back into view, with Snap ready to press. Your side and "Let
// the other coach pick" stay as they are. A part of his call becomes his, and it's out (his coverage on the board and
// in his card, and no question after the snap): you asked to see it. Your own part goes in as its chip would put it,
// new personnel and all, and a drill ends when it's his call that changes.
{
  const c = await browser.newContext({ quiz: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  const { FORMATIONS, PLAYS, FRONTS, COVERAGES } = await import('../js/playbook.js');
  const buttons = await p.$$eval('#pbGrid [data-show]', b => b.map(x => [x.closest('details').querySelector('summary').textContent, x.textContent, x.getAttribute('aria-label')]));
  assert.deepEqual(buttons, [
    ...FORMATIONS.map(f => ['Formations and personnel', 'Show on the board', `Show on the board: ${f.name}`]),
    ...FRONTS.map(f => ['Fronts and techniques', 'Show on the board', `Show on the board: ${f.name}`]),
    ...COVERAGES.map(cv => ['Coverages', 'Show on the board', `Show on the board: ${cv.name}`]),
    ...PLAYS.filter(x => x.type === 'run').map(x => ['Run plays', 'Show on the board', `Show on the board: ${x.name}`]),
    ...PLAYS.filter(x => x.type === 'pass').map(x => ['Pass plays', 'Show on the board', `Show on the board: ${x.name}`]),
  ], 'a Show on the board button for every formation, front, coverage and play');
  const now = () => p.evaluate(() => {
    const { state } = window.chalkTalk, b = document.getElementById('board').getBoundingClientRect();
    return { side: state.side, auto: state.auto, switch: document.getElementById('auto').checked, off: state.off, def: state.def, caption: document.getElementById('caption').textContent, matchup: document.getElementById('matchup').textContent,
      hint: document.getElementById('theirsHint').textContent, inView: b.top >= 0 && b.bottom <= innerHeight, focus: document.activeElement.id };
  });
  const show = async name => {
    const b = p.locator(`[aria-label="Show on the board: ${name}"]`); // (in a closed section, out of the accessibility tree)
    await b.evaluate(x => { x.closest('details').open = true; });
    await b.scrollIntoViewIfNeeded();
    await b.click();
    await p.waitForFunction(() => { const b = document.getElementById('board').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; }, null, { timeout: 5000 });
    return now();
  };
  // Calling the offense with the other coach picking: his coverage, out, and no disguise; his front and pressure stay.
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.def, { front: 'over', coverage: 'c1', pressure: 'blitz', disguise: true }); lineUp(); });
  assert.match(await p.textContent('#matchup'), /coverage hidden/);
  let s = await show('Cover 3');
  assert.deepEqual({ side: s.side, auto: s.auto, switch: s.switch, def: s.def, inView: s.inView, focus: s.focus }, { side: 'O', auto: true, switch: true, def: { front: 'over', coverage: 'c3', pressure: 'blitz', disguise: false }, inView: true, focus: 'snap' });
  assert.equal(s.caption, 'From the playbook: Cover 3.');
  assert.match(s.matchup, /vs  4-3 Over · Cover 3 · Blitz$/, 'his coverage from the playbook is hidden on the board');
  assert.equal(s.hint, 'From the playbook: 4-3 Over, Cover 3, blitz. New look gets you a new one.');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.play.overlay.filter(o => o.team === 'D' && o.kind === 'zone').length > 0 && window.chalkTalk.board.showTheirs), true, 'his zone drops aren\'t drawn');
  // Snapped, it isn't asked about: it was out already, and the hint goes back to how it was.
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  assert.equal(await p.locator('#theirsAsk').isHidden(), true, 'a coverage shown from the playbook is asked about after the snap');
  assert.equal(await p.textContent('#theirsHint'), 'They called: 4-3 Over, Cover 3, blitz.');
  // Your own play: in, as its chip puts it; he keeps his call.
  s = await show('Flood');
  assert.deepEqual([s.off.play, s.def.coverage, s.caption], ['flood', 'c3', 'From the playbook: Flood.']);
  assert.equal(await p.getByRole('radio', { name: 'Flood' }).getAttribute('aria-checked'), 'true');
  // A formation with new personnel: he substitutes, and his new call is hidden.
  s = await show('I-Form');
  assert.deepEqual([s.off.formation, s.caption], ['iform', 'From the playbook: I-Form. New personnel: they\'ve substituted.']);
  assert.match(s.matchup, /coverage hidden$/);
  // Calling the defense: his play, out; your front.
  await p.click('[data-side="D"]');
  s = await show('Mesh');
  assert.deepEqual([s.side, s.auto, s.off.play, s.caption], ['D', true, 'mesh', 'From the playbook: Mesh.']);
  assert.match(s.matchup, / · Mesh  vs  /, 'his play from the playbook is hidden on the board');
  s = await show('3-4');
  assert.deepEqual([s.def.front, s.off.play, s.caption], ['34', 'mesh', 'From the playbook: 3-4.']);
  // In a drill: your own part keeps it going; his ends it, and his picking goes back to how you had it.
  await p.click('[data-side="O"]');
  await p.click('#drillChips button:text-is("Beat Cover 2")');
  s = await show('Slant-Flat');
  assert.deepEqual([s.off.play, s.def.coverage, await p.evaluate(() => document.getElementById('drillNow').hidden)], ['slants', 'c2', false], 'your own play from the playbook ended the drill');
  s = await show('Cover 4');
  assert.deepEqual([s.auto, s.def.coverage, await p.evaluate(() => document.getElementById('drillNow').hidden), s.matchup.includes('Cover 4')], [true, 'c4', true, true], 'his coverage from the playbook in a drill');
  // Calling both sides, it's simply yours.
  await p.click('#auto');
  s = await show('Cover 0');
  assert.deepEqual([s.auto, s.def.coverage, s.caption], [false, 'c0', 'From the playbook: Cover 0.']);
  await c.close();
}

// Each row of the chart, once it has its numbers, is a button that plays a typical snap of it: the other side's call
// becomes the row's, "Let the other coach pick" goes off, and the board plays the middle snap by yards gained of that
// row's snaps with the strong side it has. The chart stays up with that row marked as this call, and the result card
// says which snap it was. Calling the defense, the rows are his plays.
{
  const c = await browser.newContext({ quiz: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  assert.equal(await p.locator('#bars button').count(), 0, 'rows to tap before the chart has run');
  assert.doesNotMatch(await p.textContent('#chartHint'), /Tap a row/);
  // The middle snap of a row, by yards gained, of those with the board's strong side.
  const typical = id => p.evaluate(id => {
    const { state, chart } = window.chalkTalk, r = chart().rows.find(x => x.id === id);
    const mine = r.snaps.filter(x => x.flip === state.off.flip).sort((a, b) => a.yards - b.yards);
    return { ...mine[(mine.length - 1) >> 1], n: mine.length, of: r.snaps.length };
  }, id);
  // (all the way: rows go on adding snaps after their first numbers are up, which moves their middle one)
  const first = n => p.waitForFunction(n => document.querySelectorAll('#bars button.bar-row').length === n && document.getElementById('runChart').getAttribute('aria-disabled') !== 'true', n, { timeout: 90000 });
  await p.click('[data-side="O"]');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; state.off.flip = true; Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'blitz', disguise: true }); lineUp(); });
  await p.click('#runChart');
  await first(5);
  assert.match(await p.textContent('#chartHint'), / Tap a row to watch a typical snap of it\.$/);
  const names = await p.$$eval('#bars button.bar-row', b => b.map(x => [x.closest('[role="listitem"]') !== null, x.getAttribute('aria-label')]));
  for (const [inList, name] of names) {
    assert.ok(inList, 'a row\'s button isn\'t in the chart\'s list');
    assert.match(name, /^Cover \d: \d+% successful, −?\d+\.\d yards a play, over \d+ snaps\. Watch a typical snap against Cover \d\.$/);
  }
  const want = await typical('c3');
  assert.deepEqual([want.n, want.of], [50, 100], 'the row\'s snaps with this strong side');
  await p.click('#bars button[data-row="c3"]');
  const s = await p.evaluate(() => {
    const { state } = window.chalkTalk;
    return { auto: state.auto, switch: document.getElementById('auto').checked, off: state.off, def: state.def, seed: state.seed, phase: state.phase, focus: document.activeElement.id };
  });
  assert.deepEqual(s, { auto: false, switch: false, off: { formation: 'trips', play: 'smash', flip: true, motion: 'none', hot: {} }, def: { front: 'nickel', coverage: 'c3', pressure: 'four', disguise: false }, seed: want.seed, phase: 'playing', focus: 'snap' },
    'a typical snap against Cover 3 from the chart (before the snap the chart rushes four with no disguise)');
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).auto), false, 'the switch went off, but wasn\'t saved');
  const done = await p.evaluate(() => { const { state, board, finish } = window.chalkTalk; state.t = board.duration(); finish(); return state.play.result.yards; });
  assert.equal(done, want.yards, 'the snap played isn\'t the row\'s middle one');
  assert.match(await p.textContent('#resVs'), new RegExp(` A typical snap from the chart: of its ${want.n} snaps against Cover 3 with the strength on this side, the middle one by yards gained\\.$`));
  assert.ok(await p.evaluate(() => window.chalkTalk.chart() !== null && document.querySelectorAll('#bars button.bar-row').length === 5), 'the chart went');
  assert.deepEqual(await p.$$eval('#bars .bar-row.mine', b => b.map(x => x.querySelector('.bar-name').textContent)), ['Cover 3this call'], 'the row isn\'t marked');
  // Snap again is a fresh snap, not the typical one.
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  assert.doesNotMatch(await p.textContent('#resVs'), /typical/);
  // Calling the defense: a row is one of his plays, from his formation and the board's strong side.
  await p.click('[data-side="D"]');
  await p.click('#auto');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'iform', play: 'iz', flip: false, motion: 'none' }); state.seen = true; lineUp(); });
  await p.click('#runChart');
  await first(11);
  const run = await typical('power');
  await p.click('#bars button[data-row="power"]');
  assert.deepEqual(await p.evaluate(() => { const { state } = window.chalkTalk; return [state.side, state.auto, state.off.formation, state.off.play, state.off.flip, state.seed]; }), ['D', false, 'iform', 'power', false, run.seed]);
  assert.match(await p.getAttribute('#bars button[data-row="power"]', 'aria-label'), /\. Watch a typical snap of Power\.$/);
  await c.close();
}

// Hot routes: on your own pass play, a receiver's or a back's card has "Change his route", which opens a row under the
// board with each route he can be given (his route as called first) while the card makes way. One picked redraws his
// line and the play's name, and he keeps his place in the quarterback's reads; a man who had none is read last, and a
// back in to block is none. Done puts the row away. They're kept with your call, ride in a shared link, and go with a
// new play; a run play, the other coach's offense and the lineman have none. The result card and the chart say it's
// your version of the play.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  p.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  await p.goto(base);
  const tap = label => p.evaluate(label => {
    const { board, state } = window.chalkTalk;
    const i = state.play.players.findIndex(q => q.label === label);
    const r = board.cv.getBoundingClientRect(), q = board.pos(board.t, i);
    return { x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) };
  }, label).then(at => p.mouse.click(at.x, at.y));
  const row = () => p.evaluate(() => ({
    open: !document.getElementById('routes').hidden, card: !document.getElementById('who').hidden,
    who: document.getElementById('routesWho').textContent,
    chips: [...document.querySelectorAll('#routeChips .chip')].map(b => b.textContent.replace(/\s+/g, ' ')),
    on: document.querySelector('#routeChips [aria-checked="true"]')?.dataset.route, focus: document.activeElement.dataset.route || document.activeElement.id,
  }));
  const reads = () => p.evaluate(() => { const { state } = window.chalkTalk; return state.play.jobs[state.play.players.findIndex(q => q.label === 'QB')].replace(/^.*His reads: /, ''); });
  // (against a four-man rush the back is free to go out: against a blitz he can see a man coming and stay in)
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'trips', play: 'smash', flip: false, motion: 'none', hot: {} }); Object.assign(state.def, { front: 'nickel', coverage: 'c2', pressure: 'four', disguise: false }); lineUp(); });
  assert.equal(await reads(), '1. H (corner), 2. Z (hitch), 3. X (dig), 4. RB (check-down).');
  await tap('H');
  assert.equal(await p.isVisible('#whoRoutesOpen'), true, 'no Change his route in a receiver\'s card');
  await p.click('#whoRoutesOpen');
  assert.deepEqual(await row(), { open: true, card: false, who: 'The H\'s route. He keeps his place in the quarterback\'s reads.', chips: ['corner as called', 'go', 'seam', 'post', 'out', 'dig', 'slant', 'hitch', 'curl', 'flat', 'drag'], on: 'corner', focus: 'corner' });
  await p.click('#routeChips [data-route="slant"]');
  let r = await row();
  assert.deepEqual([r.open, r.on, r.focus], [true, 'slant', 'slant'], 'the row after a route is picked');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.off.hot), { H: 'slant' });
  assert.equal(await p.textContent('#caption'), 'Hot route: the H on a slant.');
  assert.match(await p.textContent('#matchup'), /^1st & 10 · Gun Trips · Smash \(H slant\)  vs  /);
  assert.equal(await reads(), '1. H (slant), 2. Z (hitch), 3. X (dig), 4. RB (check-down).', 'he keeps his place in the reads');
  // The tight end sits on Smash and isn't read: given a curl, he's read last.
  await tap('Y');
  assert.equal(await p.isVisible('#routes'), false, 'a tap on the board left the row up');
  await p.click('#whoRoutesOpen');
  assert.match((await row()).who, /^The Y's route\. He isn't one of the quarterback's reads as it's drawn: give him another route and he's read last\.$/);
  await p.click('#routeChips [data-route="curl"]');
  assert.equal((await row()).who, 'The Y\'s route. The quarterback reads him last.');
  assert.equal(await reads(), '1. H (slant), 2. Z (hitch), 3. X (dig), 4. RB (check-down), 5. Y (curl).');
  // A back: the back's routes, and in to block he isn't read.
  await tap('RB');
  await p.click('#whoRoutesOpen');
  assert.deepEqual((await row()).chips, ['check-down as called', 'swing', 'wheel', 'block']);
  await p.click('#routeChips [data-route="block"]');
  assert.equal((await row()).who, 'The RB\'s route. In to block, he isn\'t one of the quarterback\'s reads.');
  assert.equal(await reads(), '1. H (slant), 2. Z (hitch), 3. X (dig), 4. Y (curl).');
  await p.click('#routeChips [data-route="check"]'); // back to his route as called
  assert.equal(await p.textContent('#caption'), 'The RB runs his route as called.');
  assert.deepEqual(await p.evaluate(() => Object.entries(window.chalkTalk.state.off.hot)), [['Y', 'curl'], ['H', 'slant']], 'kept in the formation\'s order');
  await p.click('#routesDone');
  assert.deepEqual(await p.evaluate(() => [document.getElementById('routes').hidden, document.activeElement.id, window.chalkTalk.board.selected]), [true, 'snap', -1], 'Done');
  // A lineman and a defender have none.
  await tap('LG');
  assert.equal(await p.isVisible('#whoRoutesOpen'), false, 'Change his route in a lineman\'s card');
  await tap('FS');
  assert.equal(await p.isVisible('#whoRoutesOpen'), false, 'Change his route in a defender\'s card');
  await p.click('#whoClose');
  // The chart is your version.
  assert.match(await p.textContent('#chartHint'), /^How often your version of Smash \(the Y on a curl and the H on a slant\) succeeds on 1st & 10, gaining 4 yards or more, from Gun Trips /);
  // Paused part way through the play, his route can't be changed (only before the snap, or once it's over).
  await p.evaluate(() => { const { state, snap, pause } = window.chalkTalk; snap(); state.t = 1; pause(); });
  await tap('H');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.phase), 'paused');
  assert.equal(await p.isVisible('#who'), true, 'tapping the H while paused opened no card');
  assert.equal(await p.isVisible('#whoRoutesOpen'), false, 'Change his route while the play is paused part way');
  await p.click('#whoClose');
  // Snapped: the result card names your version, and the note says it's about the play as drawn.
  await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; snap(); state.t = board.duration(); finish(); });
  assert.match(await p.textContent('#resVs'), /^On 1st & 10, Smash, Y on a curl, H on a slant from Gun Trips against /);
  assert.match(await p.textContent('#note'), / That's Smash as it's drawn; yours had the Y on a curl and the H on a slant, so it can go another way\. Run it 100 times each to see how your version does against every coverage\.$/);
  // In a shared link, and back from it.
  await c.grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.click('#share');
  await p.waitForFunction(() => document.getElementById('share').textContent === 'Link copied' || !document.getElementById('shareUrl').hidden);
  const link = await p.evaluate(async () => { const box = document.getElementById('shareUrl'); return box.hidden ? navigator.clipboard.readText() : box.value; });
  assert.match(link, /#p=O\.trips\.smash\.0\.\w+\.\w+\.\w+\.\d+\.[01]\.none\.YcurlHslant\.1and10$/);
  const q = await c.newPage();
  await q.goto(base + link.slice(link.indexOf('#')));
  await q.waitForSelector('#result:not([hidden])', { timeout: 15000 });
  assert.deepEqual(await q.evaluate(() => window.chalkTalk.state.off.hot), { Y: 'curl', H: 'slant' }, 'the shared link lost the hot routes');
  assert.equal(await q.textContent('#resHead'), await p.textContent('#resHead'), 'the shared link plays another snap');
  // One naming a route he can't run is for a play this version doesn't have; one from before hot routes still opens.
  await q.evaluate(() => { location.hash = '#p=O.trips.smash.0.nickel.c2.four.15.0.none.Hwheel'; });
  await q.waitForFunction(() => location.hash === '', null, { timeout: 5000 });
  assert.equal(await q.textContent('#theirsHint'), 'That link is for a play this version doesn\'t have.');
  await q.evaluate(() => { location.hash = '#p=O.trips.smash.0.nickel.c2.four.15.0.none'; });
  await q.waitForFunction(() => window.chalkTalk.state.seed === 15, null, { timeout: 5000 });
  assert.deepEqual(await q.evaluate(() => window.chalkTalk.state.off.hot), {});
  await q.close();
  // Kept with your call: a reload keeps them; a new play starts from the play as drawn.
  await p.reload();
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.off.hot), { Y: 'curl', H: 'slant' }, 'a reload lost the hot routes');
  await p.getByRole('radio', { name: 'Flood' }).click();
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.state.off.hot), {}, 'a new play kept the old one\'s hot routes');
  assert.match(await p.textContent('#matchup'), /^1st & 10 · Gun Trips · Flood  vs  /);
  // A run play has none, and neither has the other coach's offense when you call the defense.
  await p.getByRole('radio', { name: 'Inside Zone' }).click();
  await tap('H');
  assert.equal(await p.isVisible('#whoRoutesOpen'), false, 'Change his route on a run');
  await p.click('[data-side="D"]');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'trips', play: 'smash', motion: 'none' }); state.seen = true; lineUp(); });
  await tap('H');
  assert.equal(await p.isVisible('#whoRoutesOpen'), false, 'Change his route for the other coach\'s receiver');
  // Calling both sides on defense, routes changed on the offense's play are that play's: the chart's other plays are
  // run as they're drawn, and its hint says so.
  await p.click('#whoClose');
  await p.click('#auto');
  await p.evaluate(() => { const { state, lineUp } = window.chalkTalk; Object.assign(state.off, { formation: 'trips', play: 'smash', motion: 'none', hot: { H: 'slant' } }); lineUp(); });
  await p.click('#runChart');
  assert.deepEqual(await p.evaluate(() => window.chalkTalk.chart().rows.filter(r => Object.keys(r.call.hot || {}).length).map(r => [r.id, r.call.hot])), [['smash', { H: 'slant' }]], 'the chart ran every play with the H on a slant');
  assert.match(await p.textContent('#chartHint'), /^How often each play from Gun Trips succeeds against your defense on 1st & 10, gaining 4 yards or more: Smash as you changed it \(the H on a slant\), the rest as drawn\. /);
  await c.close();
}

// Down and distance: a Situation row above your call, on 1st & 10 to start with, says what the down means. A pick is
// kept, comes back after a reload, rides in a shared link (one from before there were downs opens on 1st & 10, and one
// with a situation this version doesn't have says so), and the board's matchup line names it. With the other coach
// picking, a new situation gets a new call from him, hidden until the snap; calling both sides, both calls stay.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await c.grantPermissions(['clipboard-read', 'clipboard-write']);
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(base);
  const chips = (q = p) => q.$$eval('#sitChips [role="radio"]', bs => bs.map(b => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')));
  assert.deepEqual(await chips(), ['1st & 10*', '2nd & 6', '3rd & 2', '3rd & 8', '4th & 1']);
  assert.ok(await p.evaluate(() => !!(document.getElementById('situation').compareDocumentPosition(document.getElementById('mine')) & Node.DOCUMENT_POSITION_FOLLOWING)), 'the situation comes before your call');
  assert.match(await p.textContent('#sitBlurb'), /^Ten yards to go for a first down, and four downs to get there\. A gain of 4 yards, 40% of the 10, is a success/);
  assert.match(await p.textContent('#matchup'), /^1st & 10 · Gun Trips/);
  const was = await p.evaluate(() => JSON.stringify(window.chalkTalk.state.def));
  await p.getByRole('radio', { name: '3rd & 8' }).click();
  assert.deepEqual(await chips(), ['1st & 10', '2nd & 6', '3rd & 2', '3rd & 8*', '4th & 1']);
  assert.match(await p.textContent('#sitBlurb'), /^Third and long: only the first down, all 8 yards, is a success, and a 6-yard gain is a failure\./);
  assert.equal(await p.textContent('#caption'), '3rd & 8: they\'ve changed their call.');
  assert.match(await p.textContent('#matchup'), /^3rd & 8 · Gun Trips .*coverage hidden/);
  assert.notEqual(await p.evaluate(() => JSON.stringify(window.chalkTalk.state.def)), was, 'a new situation, and the other coach kept his call');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.play.sit.id), '3and8', 'the play lined up is for the new situation');
  assert.equal(await p.evaluate(() => JSON.parse(localStorage.getItem('chalk-talk.v1')).sit), '3and8', 'the situation is kept');
  await p.reload();
  assert.deepEqual(await chips(), ['1st & 10', '2nd & 6', '3rd & 2', '3rd & 8*', '4th & 1'], 'a reload lost the situation');
  // A shared link has it as its last field, after the hot routes, if any.
  await p.click('#snap');
  await p.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
  await p.click('#share');
  const link = await p.evaluate(() => navigator.clipboard.readText());
  assert.match(link, /#p=O\.trips\.smash\.0\.\w+\.\w+\.\w+\.\d+\.[01]\.none\.3and8$/, `the link is ${link}`);
  const q = await c.newPage();
  q.on('pageerror', e => errors.push(e.message));
  await q.goto(base + link.slice(link.indexOf('#')));
  await q.waitForSelector('#result:not([hidden])', { timeout: 15000 });
  assert.equal(await q.evaluate(() => window.chalkTalk.state.play.sit.id), '3and8', 'the shared link lost its situation');
  assert.equal(await q.textContent('#resHead'), await p.textContent('#resHead'), 'the shared link plays another snap');
  // One from before there were downs is on 1st & 10, as the board was then; one with hot routes has it after them.
  const open = async (hash, ok) => {
    await q.evaluate(hash => { location.hash = hash; }, hash);
    await q.waitForFunction(ok, null, { timeout: 5000 }).catch(() => assert.fail(`${hash} didn't open`));
  };
  await open('#p=O.trips.smash.0.nickel.c2.four.262', () => window.chalkTalk.state.seed === 262 && window.chalkTalk.state.phase !== 'pre');
  assert.equal(await q.evaluate(() => window.chalkTalk.state.sit), '1and10', 'a link from before downs is on another down');
  assert.deepEqual(await chips(q), ['1st & 10*', '2nd & 6', '3rd & 2', '3rd & 8', '4th & 1']);
  await open('#p=O.trips.smash.0.nickel.c2.four.263.0.none.Hslant.4and1', () => window.chalkTalk.state.seed === 263);
  assert.deepEqual(await q.evaluate(() => [window.chalkTalk.state.sit, window.chalkTalk.state.off.hot]), ['4and1', { H: 'slant' }]);
  assert.match(await q.textContent('#matchup'), /^4th & 1 · /);
  await q.evaluate(() => { location.hash = '#p=O.trips.smash.0.nickel.c2.four.264.0.none.2and9'; });
  await q.waitForFunction(() => location.hash === '', null, { timeout: 5000 });
  assert.equal(await q.textContent('#theirsHint'), 'That link is for a play this version doesn\'t have.', 'a link with a situation this version doesn\'t have');
  assert.equal(await q.evaluate(() => window.chalkTalk.state.seed), 263, 'a link with a situation this version doesn\'t have changed the play');
  // Calling both sides (as a shared link has it), a new situation keeps both calls.
  const calls = () => q.evaluate(() => JSON.stringify([window.chalkTalk.state.off, window.chalkTalk.state.def]));
  const both = await calls();
  await q.getByRole('radio', { name: '2nd & 6' }).click();
  assert.equal(await calls(), both, 'calling both sides, a new situation changed a call');
  assert.equal(await q.textContent('#caption'), '2nd & 6: 6 yards to go.');
  await c.close();
  // A save from before there were downs opens on 1st & 10.
  const old = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await old.addInitScript(() => { if (!sessionStorage.getItem('once')) { sessionStorage.setItem('once', '1'); localStorage.setItem('chalk-talk.v1', JSON.stringify({ side: 'D', auto: true, labels: false, quiz: false })); } });
  const o = await old.newPage();
  await o.goto(base);
  assert.deepEqual(await o.evaluate(() => [window.chalkTalk.state.side, window.chalkTalk.state.sit, window.chalkTalk.state.labels]), ['D', '1and10', false], 'a save from before downs');
  await old.close();
  assert.deepEqual(errors, []);
}

// The chart counts a success by the down, as the result card does: on 3rd & 8 a row's bar is how often it made the
// first down. A new situation once its first numbers are up takes the chart away, saying so until it's run again.
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.getByRole('radio', { name: '3rd & 8' }).click();
  await p.click('#runChart');
  assert.match(await p.textContent('#chartHint'), /^How often your play succeeds on 3rd & 8, making the first down \(8 yards\), from Gun Trips /);
  await p.waitForFunction(() => window.chalkTalk.chart()?.rows.every(r => r.avg !== undefined), null, { timeout: 60000 });
  const rows = await p.evaluate(() => window.chalkTalk.chart().rows.map(r => ({ name: r.name, n: r.n, ok: r.ok, firsts: r.snaps.filter(x => Math.round(x.yards) >= 8).length })));
  for (const r of rows) assert.equal(r.ok, r.firsts, `${r.name}: ${r.ok} successes counted on 3rd & 8, ${r.firsts} first downs`);
  assert.ok(rows.some(r => r.firsts < r.n), 'no snap fell short');
  await p.getByRole('radio', { name: '2nd & 6' }).click();
  assert.match(await p.textContent('#chartHint'), /^How often your play succeeds on 2nd & 6, gaining 4 yards or more, from Gun Trips .* The situation changed\. Run it again for Smash on 2nd & 6\.$/);
  assert.equal(await p.$$eval('#bars .bar-row.idle', r => r.length), 5, 'the chart for the last situation stayed up');
  await c.close();
}

// Calling the defense, the other coach's play leans on his personnel: I-Form runs about 60% of the time, Singleback
// 55%, Gun Trips 35 to 40% and Gun Doubles about 25%, and every play stays possible from every formation. The card says
// what to read before the snap, and so does the playbook. Calling the offense, the card doesn't.
{
  const p = await phone();
  const READ = 'Read their personnel: two backs or two tight ends lean run, four receivers lean pass.';
  assert.ok(!(await p.textContent('#theirsHint')).includes(READ), 'calling the offense, the card says to read their personnel');
  assert.ok((await p.textContent('#pbGrid')).includes('Personnel is the defense\'s first read: two backs or two tight ends lean run, four receivers lean pass.'), 'the playbook\'s formations say what personnel tells the defense');
  await p.click('[data-side="D"]');
  assert.match(await p.textContent('#theirsHint'), /^Hidden until the snap\. .*Read their personnel: two backs or two tight ends lean run, four receivers lean pass\./);
  const picks = await p.evaluate(() => {
    const { state, rollTheirs } = window.chalkTalk, runs = ['iz', 'oz', 'power', 'draw'], seen = {};
    for (let k = 0; k < 6000; k++) {
      rollTheirs();
      const f = (seen[state.off.formation] ||= { n: 0, run: 0, plays: {} });
      f.n++;
      if (runs.includes(state.off.play)) f.run++;
      f.plays[state.off.play] = true;
    }
    return Object.fromEntries(Object.entries(seen).map(([f, { n, run, plays }]) => [f, { n, run: run / n, plays: Object.keys(plays).length }]));
  });
  for (const [f, lo, hi] of [['iform', 0.54, 0.66], ['single', 0.49, 0.61], ['trips', 0.32, 0.43], ['doubles', 0.2, 0.3]]) {
    assert.ok(picks[f].run >= lo && picks[f].run <= hi, `${f} runs ${(picks[f].run * 100).toFixed(1)}% of the time (${picks[f].n} picks), not ${lo * 100}-${hi * 100}%`);
    assert.equal(picks[f].plays, 11, `${f}: only ${picks[f].plays} of the 11 plays came up`);
  }
  await p.context().close();
}

// The down moves the other coach's call the way NFL teams' calls moved from 1st & 10 in 2023: on 3rd & 8 more nickel,
// more blitzes and more Cover 1 calling the offense, and nearly all passes calling the defense; on 4th & 1 more runs and
// more Cover 0. On 1st & 10 his call is what it was before there were downs. The Situation card says he leans.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  assert.match(await p.textContent('#sitBlurb'), / The other coach's calls lean the same way\.$/);
  const roll = (side, sit) => p.evaluate(([side, sit]) => {
    const { state, rollTheirs } = window.chalkTalk, n = 3000, runs = ['iz', 'oz', 'power', 'draw'], out = { nickel: 0, blitz: 0, c0: 0, c1: 0, pass: 0 };
    Object.assign(state, { side, sit });
    state.off = { formation: 'trips', play: 'smash', flip: false, motion: 'none', hot: {} };
    for (let k = 0; k < n; k++) {
      rollTheirs();
      if (side === 'O') {
        out.nickel += state.def.front === 'nickel';
        out.c0 += state.def.coverage === 'c0';
        out.c1 += state.def.coverage === 'c1';
        out.blitz += state.def.coverage !== 'c0' && state.def.pressure === 'blitz';
      } else out.pass += !runs.includes(state.off.play);
    }
    for (const k in out) out[k] /= n;
    out.blitz /= 1 - out.c0; // of his calls that aren't Cover 0, which always blitzes
    return out;
  }, [side, sit]);
  const first = await roll('O', '1and10'), long = await roll('O', '3and8'), fourth = await roll('O', '4and1');
  const within = (v, lo, hi, what) => assert.ok(v >= lo && v <= hi, `${what}: ${(v * 100).toFixed(1)}%, not ${lo * 100}-${hi * 100}%`);
  within(first.nickel, 0.5, 0.6, 'nickel against Gun Trips on 1st & 10');
  within(long.nickel, 0.93, 0.99, 'nickel against Gun Trips on 3rd & 8');
  within(first.blitz, 0.21, 0.29, 'a blitz on 1st & 10');
  within(long.blitz, 0.34, 0.44, 'a blitz on 3rd & 8');
  within(first.c1, 0.19, 0.25, 'Cover 1 on 1st & 10');
  within(long.c1, 0.34, 0.42, 'Cover 1 on 3rd & 8');
  within(fourth.c0, 0.21, 0.3, 'Cover 0 on 4th & 1');
  const passFirst = (await roll('D', '1and10')).pass, passLong = (await roll('D', '3and8')).pass, passFourth = (await roll('D', '4and1')).pass;
  within(passFirst, 0.5, 0.61, 'passes on 1st & 10');
  within(passLong, 0.94, 0.99, 'passes on 3rd & 8');
  within(passFourth, 0.27, 0.4, 'passes on 4th & 1');
  await c.close();
}

// Snap again while reading the result card: the reader keeps his place. The last result stays where it was, faded and
// out of reach, until the new one comes in at the end of the play, rather than going and taking the page under the
// board with it. New look from the result card goes on to their card, just under the board. Where the board doesn't
// stay at the top (a laptop's window made small, 700 by 600), Snap again brings the board back into view.
{
  const still = async q => { for (let a = -1, b = -2; a !== b;) { a = await q.evaluate(() => scrollY); await new Promise(r => setTimeout(r, 150)); b = await q.evaluate(() => scrollY); } };
  const p = await phone();
  await p.evaluate(() => { const { snap, finish } = window.chalkTalk; snap(); finish(); document.querySelector('#result .actions').scrollIntoView({ block: 'end' }); });
  // (its last line, "This time": the card's height goes with the snap, and the actions are at the bottom of the screen)
  const note = () => p.evaluate(() => document.getElementById('noteNow').getBoundingClientRect().top);
  const before = await note(), seed = await p.evaluate(() => window.chalkTalk.state.seed);
  assert.ok(before > await p.evaluate(() => document.querySelector('.stage').getBoundingClientRect().bottom) && before < 844, `the coach's note is at ${Math.round(before)} px`);
  await p.click('#again');
  await new Promise(r => setTimeout(r, 300));
  const during = await p.evaluate(() => { const r = document.getElementById('result'); return { playing: window.chalkTalk.state.phase === 'playing', stale: r.classList.contains('stale'), inert: r.inert, hidden: r.getAttribute('aria-hidden') }; });
  const now = await note();
  assert.ok(Math.abs(now - before) < 100, `Snap again moved the coach's note from ${Math.round(before)} px to ${Math.round(now)} px while the play runs`);
  assert.deepEqual(during, { playing: true, stale: true, inert: true, hidden: 'true' }, 'the last result while the next snap plays');
  await p.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
  assert.equal(await p.evaluate(() => document.getElementById('result').inert || document.getElementById('result').hasAttribute('aria-hidden')), false, 'the new result is out of reach');
  assert.notEqual(await p.evaluate(() => window.chalkTalk.state.seed), seed, 'Snap again replayed the same snap');
  await p.evaluate(() => document.querySelector('#result .actions').scrollIntoView({ block: 'end' }));
  await p.click('#newLook');
  await still(p);
  const theirs = await p.evaluate(() => ({ top: document.getElementById('theirs').getBoundingClientRect().top, stage: document.querySelector('.stage').getBoundingClientRect().bottom }));
  assert.ok(theirs.top >= theirs.stage && theirs.top < theirs.stage + 30, `after New look from the result card their card is at ${Math.round(theirs.top)} px, the board ending at ${Math.round(theirs.stage)} px`);
  await p.context().close();
  const c = await browser.newContext({ viewport: { width: 700, height: 600 } });
  const q = await c.newPage();
  q.on('pageerror', e => problems.push(e.message));
  await q.goto(base);
  await q.evaluate(() => { const { snap, finish } = window.chalkTalk; snap(); finish(); document.querySelector('#result .actions').scrollIntoView({ block: 'end' }); });
  assert.ok(await q.evaluate(() => document.getElementById('board').getBoundingClientRect().bottom < 0), 'at 700x600 the board was still in view before Snap again');
  await q.click('#again');
  await still(q);
  const b = await q.evaluate(() => { const r = document.getElementById('board').getBoundingClientRect(); return { t: r.top, b: r.bottom }; });
  assert.ok(b.t >= 0 && b.b <= 600, `at 700x600 the board is at ${Math.round(b.t)}-${Math.round(b.b)} px after Snap again`);
  await c.close();
}

// The read after the snap says what the corners showed: pressed in man, about 5 yards off in Cover 2, 7 or more off in
// the deep zones (an honest look: a disguise has its own test). And the playbook's read of the shell doesn't call it a
// guess.
{
  const p = await phone();
  const reads = await p.evaluate(() => {
    const { state, lineUp, snap, finish } = window.chalkTalk, out = {};
    for (const coverage of ['c1', 'c2', 'c3', 'c4']) {
      Object.assign(state.def, { front: 'nickel', coverage, pressure: 'four', disguise: false });
      lineUp(); snap(); finish();
      out[coverage] = [...document.querySelectorAll('#reads li')].map(li => li.textContent).find(t => t.startsWith('Corners:'));
    }
    const d = [...document.querySelectorAll('.pb')].find(x => x.querySelector('summary').textContent === 'Coverages');
    out.shell = [...d.querySelectorAll('dt')].find(dt => dt.textContent === 'Reading the shell').nextElementSibling.textContent;
    return out;
  });
  assert.equal(reads.c1, 'Corners: pressed up on the receivers. Corners press in man coverage.');
  assert.equal(reads.c2, 'Corners: about 5 yards off and outside the receivers. Cover 2 corners sit there to take the flat.');
  assert.equal(reads.c3, 'Corners: 7 yards or more off. They drop deep, to a third or a quarter of the field.');
  assert.equal(reads.c4, reads.c3);
  assert.doesNotMatch(reads.shell, /the read is a guess/, 'the playbook says the read is a guess, which it never is on this board');
  assert.match(reads.shell, /The corners help too/);
  await p.context().close();
}

// Before the snap a defender's card says what his spot gives away, not the same sentence for all eleven: a pressed
// corner, the lone deep safety, a Mike creeping up to blitz.
{
  const p = await phone();
  await p.evaluate(() => {
    const { state, lineUp } = window.chalkTalk;
    Object.assign(state.off, { formation: 'doubles', play: 'verts', flip: false, motion: 'none' });
    Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'blitz', disguise: false });
    lineUp();
  });
  const spots = await p.evaluate(() => {
    const { board, state } = window.chalkTalk, r = board.cv.getBoundingClientRect();
    return state.play.players.filter(q => q.team === 'D').map(q => ({ i: q.i, label: q.label, x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) }));
  });
  const cards = {};
  for (const q of spots) {
    await p.evaluate(() => { window.chalkTalk.board.selected = -1; document.getElementById('who').hidden = true; });
    await p.mouse.click(q.x, q.y);
    for (let n = 1; n < 4 && await p.evaluate(() => window.chalkTalk.board.selected) !== q.i; n++) await p.mouse.click(q.x, q.y);
    cards[`${q.label} ${q.i}`] = await p.textContent('#whoJob');
  }
  const said = Object.values(cards);
  assert.ok(said.every(t => t.endsWith(' His job is hidden until the snap.')), `a card before the snap reads: ${said.find(t => !t.endsWith(' His job is hidden until the snap.'))}`);
  assert.ok(new Set(said).size >= 6, `${new Set(said).size} different cards for eleven defenders`);
  const card = label => Object.entries(cards).find(([k]) => k.startsWith(label + ' '))[1];
  assert.match(card('CB'), /^Up in the receiver's face, pressed: corners press in man coverage\./);
  assert.match(card('FS'), /^Alone in the middle, 1\d yards deep: one deep safety, so Cover 1 or Cover 3\./);
  assert.match(card('M'), /often blitzing\./);
  assert.match(card('NB'), /^Over the slot receiver \(/);
  assert.match(card('DE'), /^Down linemen rush on almost every play\./);
  await p.context().close();
}

// Calling the defense, their call says where the strength is on the board as you see it: turned around, the
// offense's right is on your left.
{
  const p = await phone();
  await p.click('[data-side="D"]');
  for (const flip of [false, true]) {
    const said = await p.evaluate(f => {
      const { state, lineUp, snap, finish } = window.chalkTalk;
      Object.assign(state.off, { formation: 'single', play: 'smash', flip: f, motion: 'none' });
      lineUp(); snap(); finish();
      return document.getElementById('theirsHint').textContent;
    }, flip);
    assert.equal(said, `They called: Singleback, strength to your ${flip ? 'right' : 'left'}, Smash.`, `strong side ${flip ? 'left' : 'right'}`);
  }
  await p.context().close();
}

// From the keyboard: a pick keeps focus on the chip picked (the choosers are drawn again on every pick), the result
// card's buttons hand it to Snap as the card goes away or fades out of reach, and the chart's button keeps it while it
// runs.
{
  const p = await phone();
  const focused = () => p.evaluate(() => document.activeElement.dataset.key || document.activeElement.id || document.activeElement.tagName);
  await p.getByRole('radio', { name: 'Flood' }).focus();
  await p.keyboard.press('Enter');
  assert.equal(await focused(), 'Play:flood', 'Enter on a chip lost the focus');
  assert.equal(await p.evaluate(() => window.chalkTalk.state.off.play), 'flood');
  await p.getByRole('radio', { name: 'Left' }).focus();
  await p.keyboard.press('Space');
  assert.equal(await focused(), 'Strong side:L', 'Space on a chip lost the focus');
  await p.evaluate(() => { window.chalkTalk.snap(); window.chalkTalk.finish(); });
  for (const id of ['again', 'newLook']) {
    // the play the last one snapped is still running, under a faded card: it finishes, and the card comes back
    await p.evaluate(() => { const { state, board, snap, finish } = window.chalkTalk; if (state.phase === 'pre') snap(); state.t = board.duration(); finish(); });
    assert.equal(await p.evaluate(() => document.getElementById('result').inert), false);
    await p.focus(`#${id}`);
    assert.equal(await focused(), id);
    await p.keyboard.press('Enter');
    assert.equal(await focused(), 'snap', `#${id} dropped the focus as the result card went or faded`);
  }
  await p.focus('#runChart');
  await p.keyboard.press('Enter');
  assert.equal(await focused(), 'runChart', 'the chart\'s button dropped the focus while it runs');
  assert.equal(await p.getAttribute('#runChart', 'aria-disabled'), 'true', 'the chart\'s button says it is busy');
  await p.context().close();
}

// Arrow keys in every radio group, the way the WAI-ARIA Authoring Practices' radio group has them: Right or Down picks
// the next one and Left or Up the one before, wrapping at the ends, Home and End the first and the last, and each group
// is one stop for Tab, at the one that's picked. Play is one group across the runs and the passes.
{
  const p = await phone();
  const at = () => p.evaluate(() => {
    const el = document.activeElement, { state } = window.chalkTalk;
    return { on: el.dataset.key || (el.dataset.side ? `side:${el.dataset.side}` : `speed:${el.dataset.speed}`), play: state.off.play, side: state.side, speed: state.speed };
  });
  await p.getByRole('radio', { name: 'Smash' }).focus();
  const plays = [];
  for (const key of ['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowLeft', 'End', 'ArrowDown', 'ArrowUp', 'Home']) {
    await p.keyboard.press(key);
    const now = await at();
    assert.equal(now.on, `Play:${now.play}`, `after ${key} the focus is on ${now.on} with ${now.play} picked`);
    plays.push(now.play);
  }
  assert.deepEqual(plays, ['flood', 'smash', 'verts', 'draw', 'screen', 'iz', 'screen', 'iz'], 'arrow keys through the plays');
  const stops = await p.evaluate(() => [...document.querySelectorAll('#mineBody [role="radio"]')].filter(b => b.tabIndex === 0).map(b => b.dataset.key));
  assert.deepEqual(stops, ['Formation:trips', 'Strong side:R', 'Motion:none', 'Play:iz'], 'one Tab stop for each group, at the one picked');
  await p.focus('[data-side="O"]');
  await p.keyboard.press('ArrowRight');
  assert.deepEqual(await at().then(({ on, side }) => ({ on, side })), { on: 'side:D', side: 'D' }, 'arrow keys pick the side');
  await p.keyboard.press('ArrowRight');
  assert.equal((await at()).side, 'O', 'the side pick wraps around');
  assert.deepEqual(await p.$$eval('[data-side]', b => b.map(x => x.tabIndex)), [0, -1]);
  await p.focus('[data-speed="1"]');
  await p.keyboard.press('ArrowLeft');
  assert.deepEqual(await at().then(({ on, speed }) => ({ on, speed })), { on: 'speed:0.5', speed: 0.5 }, 'arrow keys pick the speed');
  assert.deepEqual(await p.$$eval('[data-speed]', b => b.map(x => x.tabIndex)), [0, -1]);
  await p.context().close();
}

// The chart puts up every row's first numbers after 20 snaps, then keeps adding snaps until each row has 100. A change
// of call while it's on its first time round starts it again for the new call; once the first numbers are up, it stops
// and the chart goes, as a finished one does, saying so until it's run again.
{
  const p = await phone();
  const rows = () => p.$$eval('#bars .bar-row:not(.waiting):not(.idle)', r => r.length);
  const snaps = () => p.$$eval('#bars .bar-row:not(.waiting):not(.idle)', r => r.map(x => +x.title.match(/over (\d+) snaps$/)[1]));
  const ready = () => p.waitForFunction(() => document.getElementById('runChart').getAttribute('aria-disabled') !== 'true' && document.querySelectorAll('#bars .bar-row:not(.waiting):not(.idle)').length === 5, null, { timeout: 60000 });
  const settling = () => p.waitForFunction(() => /^Running… [4-8]0 of 100$/.test(document.getElementById('runChart').textContent), null, { timeout: 30000 });
  await p.click('#runChart');
  await p.getByRole('radio', { name: 'Mesh' }).click();
  assert.equal(await p.getAttribute('#runChart', 'aria-disabled'), 'true', 'changing the call stopped the chart');
  await p.waitForFunction(() => document.querySelectorAll('#bars .bar-row:not(.waiting):not(.idle)').length === 5, null, { timeout: 30000 });
  assert.equal(await p.getAttribute('#runChart', 'aria-disabled'), 'true', 'the chart stopped at its first numbers');
  await settling();
  assert.ok((await snaps()).every(n => n >= 20 && n <= 100 && n % 20 === 0), 'rows add snaps 20 at a time');
  await ready();
  assert.deepEqual(await snaps(), [100, 100, 100, 100, 100], 'every row has 100 snaps once it\'s done');
  assert.equal(await p.textContent('#runChart'), 'Run it again');
  await p.click('#runChart');
  await settling();
  await p.getByRole('radio', { name: 'Smash' }).click();
  assert.equal(await p.getAttribute('#runChart', 'aria-disabled'), null, 'a change of call once the first numbers are up stops the chart');
  assert.equal(await p.locator('#bars .bar-row.idle').count(), 5, 'and the chart goes');
  assert.match(await p.textContent('#chartHint'), / You changed the call\. Run it again for Smash\.$/);
  await p.waitForTimeout(400);
  assert.equal(await p.locator('#bars .bar-row.idle').count(), 5, 'the stopped chart carried on');
  await p.click('#runChart');
  await ready();
  await p.getByRole('radio', { name: 'Flood' }).click();
  assert.equal(await rows(), 0);
  assert.equal(await p.locator('#bars .bar-row.idle').count(), 5, 'a finished chart cleared by a change of call shows its rows waiting to run');
  assert.equal(await p.textContent('#runChart'), 'Run it 100 times each');
  assert.match(await p.textContent('#chartHint'), / You changed the call\. Run it again for Flood\.$/);
  await p.click('#theirsLook');
  assert.match(await p.textContent('#chartHint'), / They changed their call\. Run it again for Flood\.$/);
  await p.click('#snap');
  assert.match(await p.textContent('#chartHint'), /Run it again for Flood\.$/, 'the word about the chart lasts through the snap');
  await p.click('#runChart');
  assert.doesNotMatch(await p.textContent('#chartHint'), /Run it again/, 'the word about the chart stays once it runs again');
  // A shared link opened in the same tab is somebody else's play: no word about you changing the call.
  await ready();
  await p.getByRole('radio', { name: 'Mesh' }).click();
  await p.evaluate(() => { location.hash = '#p=O.trips.smash.0.nickel.c2.four.262'; });
  await p.waitForFunction(() => window.chalkTalk.state.linked);
  assert.doesNotMatch(await p.textContent('#chartHint'), /Run it again/, 'a shared link kept the word about the chart');
  await p.context().close();
}

// Snap while the chart adds snaps: their call's row is marked as soon as it's out, and every row still says how many
// snaps its numbers come from, 20 at a time, rather than how far into its next 20 the chart had got.
{
  const p = await phone();
  await p.click('#runChart');
  await p.waitForFunction(() => /^Running… [4-8]0 of 100$/.test(document.getElementById('runChart').textContent), null, { timeout: 30000 });
  await p.click('#snap');
  const seen = await p.$$eval('#bars .bar-row', r => r.map(x => ({ mine: x.classList.contains('mine'), n: +(x.title.match(/over (\d+) snaps$/) || [])[1] })));
  assert.equal(seen.filter(r => r.mine).length, 1, 'their call\'s row is marked once the snap gives it away');
  assert.ok(seen.every(r => r.n % 20 === 0), `drawn again at the snap, the rows say their numbers come from ${seen.map(r => r.n).join(', ')} snaps`);
  await p.context().close();
}

// A reload (or a phone dropping the tab while it's in the background) keeps the play you were on: before the snap the
// same hidden call, and after it the same play, finished. A new visit gets a fresh look.
{
  const p = await phone();
  const now = () => p.evaluate(() => { const { state } = window.chalkTalk; return { seed: state.seed, def: { ...state.def }, phase: state.phase, matchup: document.getElementById('matchup').textContent }; });
  const before = await now();
  await p.reload();
  assert.deepEqual(await now(), before, 'a reload before the snap changed the play or gave their call away');
  await p.click('#snap');
  await p.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
  const head = await p.textContent('#resHead'), done = await now();
  await p.reload();
  assert.deepEqual(await now(), done, 'a reload after the play lost it');
  assert.equal(await p.isVisible('#result'), true, 'the result card is back after a reload');
  assert.equal(await p.textContent('#resHead'), head);
  assert.equal(await p.evaluate(() => window.chalkTalk.board.t), await p.evaluate(() => window.chalkTalk.board.duration()), 'the board shows the end of the play');
  const fresh = await p.context().newPage();
  await fresh.goto(base);
  assert.notEqual(await fresh.evaluate(() => window.chalkTalk.state.seed), done.seed, 'a new visit kept the last one\'s play');
  await p.context().close();
}

// "Your last calls stay in your browser": the side you call, both calls (calling both sides, with the other coach's
// picking turned off), the position labels and the speed all come back after a reload, and in a new tab, which has
// only what was saved and not the tab's own play.
{
  const p = await phone();
  const kept = q => q.evaluate(() => {
    const { state } = window.chalkTalk, on = sel => document.querySelector(sel);
    return {
      side: state.side, auto: state.auto, off: { ...state.off }, def: { ...state.def }, labels: state.labels, speed: state.speed,
      shown: { side: on('[data-side][aria-checked="true"]').dataset.side, auto: on('#auto').checked, labels: on('#labels').getAttribute('aria-pressed'), speed: on('[data-speed][aria-checked="true"]').dataset.speed },
    };
  });
  await p.click('[data-side="D"]');
  await p.click('#auto');
  for (const name of ['3-4', 'Cover 4', 'Blitz', 'Gun Doubles', 'Left', 'Jet', 'Mesh']) await p.getByRole('radio', { name }).click();
  await p.click('#labels');
  await p.click('[data-speed="0.5"]');
  const want = {
    side: 'D', auto: false, off: { formation: 'doubles', play: 'mesh', flip: true, motion: 'jet', hot: {} }, def: { front: '34', coverage: 'c4', pressure: 'blitz', disguise: false }, labels: false, speed: 0.5,
    shown: { side: 'D', auto: false, labels: 'false', speed: '0.5' },
  };
  assert.deepEqual(await kept(p), want, 'the calls and settings picked');
  await p.reload();
  assert.deepEqual(await kept(p), want, 'a reload lost a call or a setting');
  const tab = await p.context().newPage();
  await tab.goto(base);
  assert.deepEqual(await kept(tab), want, 'a new tab lost a call or a setting');
  await p.context().close();
}

// Contrast, by WCAG 2.2: the yard numbers (text, 1.4.3) at 4.5:1 or more on the board as they're drawn, the sidelines and
// 10-yard lines on the whiteboard at 3:1 (graphics, 1.4.11), and the small grey words on and beside the board at 4.5:1.
// And the board takes its colours from the look it's opened in: chalk on a chalkboard, marker on a whiteboard.
const schemes = {};
for (const colorScheme of ['light', 'dark']) {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, colorScheme });
  const p = await c.newPage();
  await p.goto(base);
  const seen = await p.evaluate(() => {
    // '#5b6168', 'rgba(230, 228, 218, 0.75)', or what a color-mix() computes to, 'color(srgb 0.2 0.3 0.4 / 0.5)'
    const rgb = s => {
      if (!s) return [0, 0, 0, 0];
      if (s.startsWith('#')) return [1, 3, 5].map(k => parseInt(s.slice(k, k + 2), 16)).concat(1);
      const m = s.replace(/^color\(srgb/, '').match(/[\d.]+/g).map(Number), k = s.startsWith('color(') ? 255 : 1;
      return [m[0] * k, m[1] * k, m[2] * k, m[3] ?? 1];
    };
    const over = (fg, bg, alpha = 1) => { const [r, g, b, a] = rgb(fg), [R, G, B] = rgb(bg), k = a * alpha; return [r * k + R * (1 - k), g * k + G * (1 - k), b * k + B * (1 - k)]; };
    const lum = c => { const [r, g, b] = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const { board } = window.chalkTalk, cs = getComputedStyle(board.cv), token = n => cs.getPropertyValue(n).trim();
    const paper = token('--board'), card = token('--card');
    // the yard numbers as the board draws them
    const nums = [], fillText = board.ctx.fillText;
    board.ctx.fillText = function (t, ...rest) { if (/^\d+$/.test(t)) nums.push(ratio(over(this.fillStyle, paper, this.globalAlpha), rgb(paper))); return fillText.call(this, t, ...rest); };
    board.render();
    board.ctx.fillText = fillText;
    // words in the page: their colour at their opacity, over what's behind them
    const word = (el, bg) => { const s = getComputedStyle(el); return ratio(over(s.color, bg, +s.opacity * +getComputedStyle(el.parentElement).opacity), rgb(bg)); };
    return {
      nums: Math.min(...nums), count: nums.length,
      lines: ['--field-side', '--field-ten'].map(n => ratio(over(token(n), paper), rgb(paper))),
      dim: word(document.querySelector('#matchup .dim'), paper),
      matchup: word(document.getElementById('matchup'), paper),
      group: word(document.querySelector('.group-label'), card),
    };
  });
  assert.ok(seen.count >= 4 && seen.nums >= 4.5, `${colorScheme}: the yard numbers are ${seen.nums.toFixed(2)}:1`);
  if (colorScheme === 'light') assert.ok(seen.lines.every(r => r >= 3), `light: the sidelines and 10-yard lines are ${seen.lines.map(r => r.toFixed(2))}:1`);
  for (const k of ['dim', 'matchup', 'group']) assert.ok(seen[k] >= 4.5, `${colorScheme}: ${k} is ${seen[k].toFixed(2)}:1`);
  schemes[colorScheme] = await p.evaluate(() => {
    const { board } = window.chalkTalk, x = document.createElement('canvas').getContext('2d');
    const norm = c => { x.fillStyle = '#000'; x.fillStyle = c; return x.fillStyle; };
    return { colors: { ...board.colors }, board: norm(board.colors.board), wrap: norm(getComputedStyle(board.cv.parentElement).backgroundColor) };
  });
  assert.equal(schemes[colorScheme].board, schemes[colorScheme].wrap, `${colorScheme}: the labels' knock-outs aren't the board's colour`);
  // On the chalkboard the result and the chart are in each team's chalk, as the board draws the teams: a win for the
  // offense, and the chart's bars (how often the offense succeeds), in its white; a win for the defense in its yellow.
  if (colorScheme === 'dark') {
    const team = await p.evaluate(() => {
      const { board } = window.chalkTalk, x = document.createElement('canvas').getContext('2d');
      const norm = c => { x.fillStyle = '#000'; x.fillStyle = c; return x.fillStyle; };
      const kicker = document.getElementById('resKicker'), bar = document.createElement('span');
      bar.className = 'bar';
      document.getElementById('bars').append(bar);
      const win = w => { kicker.dataset.win = w; return norm(getComputedStyle(kicker).color); };
      const seen = { o: win('O'), d: win('D'), bar: norm(getComputedStyle(bar).backgroundColor), off: norm(board.colors.off), def: norm(board.colors.def) };
      bar.remove();
      delete kicker.dataset.win;
      return seen;
    });
    assert.equal(team.o, team.off, 'dark: "A win for the offense" isn\'t in the offense\'s chalk');
    assert.equal(team.d, team.def, 'dark: "A win for the defense" isn\'t in the defense\'s chalk');
    assert.equal(team.bar, team.off, 'dark: the chart\'s bars aren\'t in the offense\'s chalk');
  }
  await c.close();
}
for (const k of ['board', 'line', 'off', 'def', 'los', 'hot']) assert.notEqual(schemes.light.colors[k], schemes.dark.colors[k], `the board's ${k} colour is the same in both looks`);
assert.deepEqual([schemes.light.colors.chalk, schemes.dark.colors.chalk], [false, true], 'chalk dust on the whiteboard, or none on the chalkboard');

// In forced colours (Windows High Contrast), which replace every background, what's picked still shows: a picked chip,
// side and speed, and the labels toggle when it's on, against the ones that aren't (WCAG 2.2, 1.4.11).
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, forcedColors: 'active' });
  const p = await c.newPage();
  await p.goto(base);
  const seen = await p.evaluate(() => {
    // the colour you see behind it: its own background, or the first one behind it that isn't see-through
    const bg = el => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/^rgba\(.*, 0\)$|transparent/.test(c)) return c; } return 'none'; };
    const pair = sel => { const on = document.querySelector(`${sel}[aria-checked="true"]`), off = document.querySelector(`${sel}[aria-checked="false"]`); return [bg(on), bg(off)]; };
    const labels = document.getElementById('labels'), pressed = bg(labels);
    labels.click(); const released = bg(labels); labels.click();
    // the drill under way, pressed, against one that isn't
    document.querySelector('#drillChips button').click();
    const drill = [bg(document.querySelector('#drillChips [aria-pressed="true"]')), bg(document.querySelector('#drillChips [aria-pressed="false"]'))];
    return { forced: matchMedia('(forced-colors: active)').matches, chip: pair('#mineBody .chip'), side: pair('[data-side]'), speed: pair('[data-speed]'), labels: [pressed, released], drill, snap: getComputedStyle(document.getElementById('snap')).borderTopWidth };
  });
  assert.ok(seen.forced, 'forced colours are on');
  for (const k of ['chip', 'side', 'speed', 'labels', 'drill']) assert.notEqual(seen[k][0], seen[k][1], `in forced colours a picked ${k} looks like one that isn't (${seen[k][0]})`);
  assert.notEqual(seen.snap, '0px', 'in forced colours Snap has no outline');
  await c.close();
}

// Names a screen reader says, from the accessibility tree: the labels toggle, the speeds, a formation with its personnel,
// the card's close button and the board as a picture. And with reduced motion asked for, nothing scrolls smoothly, with
// the board stuck at the top of a phone, short or tall, or in a window where it doesn't stay at the top.
for (const [width, height, stuck] of [[390, 844, true], [375, 667, true], [700, 600, false]]) {
  const c = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: true, reducedMotion: 'reduce' });
  const p = await c.newPage();
  await p.goto(base);
  const named = async (role, name) => (await p.getByRole(role, { name, exact: true }).count()) === 1;
  for (const [role, name] of [['button', 'Position labels'], ['radio', 'Half speed'], ['radio', 'Full speed'], ['radio', 'I-Form 21 personnel'],
    ['radio', 'Gun Trips 11 personnel'], ['img', 'The field, with the offense drawn as circles and the defense as Xs']]) {
    assert.ok(await named(role, name), `no ${role} named "${name}"`);
  }
  await p.evaluate(() => { const { state, board } = window.chalkTalk, i = state.play.players.findIndex(q => q.label === 'QB'), r = board.cv.getBoundingClientRect(), q = board.pos(0, i); window.qbAt = { x: r.left + board.sx(q.x), y: r.top + board.sy(q.y) }; });
  const qb = await p.evaluate(() => window.qbAt);
  await p.mouse.click(qb.x, qb.y);
  assert.ok(await named('button', 'Close the player card'), 'the card\'s close button has no name of its own');
  const smooth = await p.evaluate(() => {
    const asked = [], into = Element.prototype.scrollIntoView, to = window.scrollTo;
    Element.prototype.scrollIntoView = function (o) { asked.push(o?.behavior); };
    window.scrollTo = o => { asked.push(o?.behavior); };
    const { snap, finish } = window.chalkTalk;
    for (const id of ['again', 'newLook', 'why']) { snap(); finish(); document.getElementById(id).click(); }
    Element.prototype.scrollIntoView = into; window.scrollTo = to;
    return asked;
  });
  // Where the board stays at the top, Snap again and New look leave the page where it is; the Why button scrolls it.
  // And the Why button comes up without its fade.
  assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById('why')).animationName), 'none', `${width}x${height}: with reduced motion the button to the explanation fades in`);
  assert.ok(smooth.length >= (stuck ? 2 : 3) && smooth.every(b => b !== 'smooth'), `${width}x${height}: with reduced motion the page scrolled: ${smooth}`);
  await c.close();
}

// Dragged to a screen with another pixel density (an external monitor to a laptop's), the board is drawn again for it
// rather than left soft: nothing about its size in CSS pixels changes, so only a watch on the density catches it. (The
// density is changed through the DevTools protocol, which in headless Chromium doesn't send the media query's change
// event a real screen change does, so the test sends it.)
{
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const p = await c.newPage();
  await p.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.densityWatch = [];
    window.matchMedia = q => { const m = mm(q); if (/resolution/.test(q)) window.densityWatch.push(m); return m; };
  });
  await p.goto(base);
  const sharp = () => p.evaluate(() => { const { board } = window.chalkTalk; return board.cv.width / board.w; });
  assert.ok(Math.abs(await sharp() - 1) < 0.01);
  const cdp = await c.newCDPSession(p);
  for (const dpr of [2, 1]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: dpr, mobile: false });
    await p.evaluate(() => window.densityWatch.at(-1)?.dispatchEvent(new Event('change')));
    await until(async () => Math.abs(await sharp() - dpr) < 0.01, 3000, `on a screen with ${dpr}x density the board is drawn at ${(await sharp()).toFixed(2)}x`);
  }
  await c.close();
}

// Two tabs keep each other's settings: labels turned off in one and half speed picked in the other are both still so
// after a reload, and each tab takes the other's change as it's made. Calls stay each tab's own.
{
  const a = await phone(), b = await a.context().newPage();
  await b.goto(base);
  const settings = q => q.evaluate(() => { const { state, board } = window.chalkTalk; return { labels: state.labels, drawn: board.labels, speed: state.speed, pressed: document.getElementById('labels').getAttribute('aria-pressed') }; });
  await a.click('#labels');
  await b.click('[data-speed="0.5"]');
  await until(async () => (await settings(a)).speed === 0.5, 3000, 'the first tab didn\'t take half speed from the second');
  assert.deepEqual(await settings(a), { labels: false, drawn: false, speed: 0.5, pressed: 'false' });
  assert.deepEqual(await settings(b), { labels: false, drawn: false, speed: 0.5, pressed: 'false' }, 'the second tab didn\'t take labels off from the first');
  await a.reload();
  assert.deepEqual(await settings(a), { labels: false, drawn: false, speed: 0.5, pressed: 'false' }, 'a reload lost a setting the other tab saved over');
  await a.context().close();
}

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Nothing went wrong while using it: no errors, no failed requests, nothing loaded from anywhere else. (From here on
// the connection goes down on purpose, so failed requests are expected.)
assert.deepEqual(problems, [], 'problems while using it');

// Installable, as the browser sees it: Chromium finds nothing in the way of installing it to a home screen, and reads
// the manifest without an error, as an app of its own (by name, opening on its own screen at the start page) with
// the 192 and 512 px icons a home screen asks for, all there. (Chromium would install almost any page now, so the
// manifest is what says it installs as the app. Asked after the page has been used: what the check fetches is seen
// below.)
{
  const cdp = await ctx.newCDPSession(page);
  assert.deepEqual((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], 'Chromium says it can\'t be installed');
  const manifest = await cdp.send('Page.getAppManifest'), app = manifest.manifest;
  assert.equal(manifest.url, base + 'manifest.webmanifest', 'the manifest Chromium found');
  assert.deepEqual(manifest.errors, [], 'Chromium found errors in the manifest');
  assert.equal(app.name, 'Chalk Talk');
  assert.match(app.display, /standalone/i, `it opens as ${app.display}, not on a screen of its own`);
  assert.equal(app.startUrl, base, 'it starts somewhere else');
  for (const size of ['192x192', '512x512']) assert.ok(app.icons.some(i => i.sizes === size && i.type === 'image/png'), `no ${size} PNG icon`);
  for (const i of app.icons) assert.equal((await fetch(i.url)).status, 200, `the manifest's icon ${i.url} isn't there`);
  await cdp.detach();
}

// The offline copy has every file a page asked for. One left out of SHELL is never kept (the copy is only ever what
// SHELL lists), and offline the page opens without it. sw.js is the worker itself. The PNG icons the manifest and the page's
// apple-touch-icon name are fetched by the browser when the app is installed, online, never by the page, so they stay
// out of the copy (and if a browser's install fetch shows up here, it doesn't count).
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const copy = new Set(shell.map(f => '/' + (f === './' ? '' : f)));
const forInstalling = new Set([
  ...JSON.parse(await readFile(join(root, 'manifest.webmanifest'), 'utf8')).icons.map(i => '/' + i.src).filter(f => f.endsWith('.png')),
  '/' + (await readFile(join(root, 'index.html'), 'utf8')).match(/rel="apple-touch-icon" href="([^"]+)"/)[1],
]);
assert.ok(asked.has('/fonts/patrick-hand.woff2') && asked.has('/js/sim.js'), `the pages' requests weren't all seen: ${[...asked].join(' ')}`);
for (const path of asked) {
  if (path === '/sw.js' || forInstalling.has(path)) continue;
  assert.ok(copy.has(path), `the page asked for ${path}, which sw.js doesn't keep for offline: add it to SHELL`);
}

// Works offline after one visit: a phone that opened it once, online, then opens it with no signal, and then on a
// connection that's up but not answering (a train, a captive wifi), where it opens from the copy after the worker's
// few seconds' wait for the network. It opens as the app, not just its page: the app runs, the board says the
// matchup, and every font the page used online is loaded, from the copy. (The server goes down as well as the
// browser: in some Chromium builds the browser's offline switch alone doesn't stop the service worker's own
// requests, and this passed with no copy at all.)
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base);
  await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
  await p.evaluate(() => document.fonts.ready);
  const title = await p.title();
  const faces = () => p.evaluate(() => [...document.fonts].map(f => [`${f.family} ${f.weight}`, f.status]));
  const used = (await faces()).filter(([, st]) => st === 'loaded').map(([f]) => f);
  assert.ok(used.length >= 4, `only ${used.length} fonts loaded online: ${used.join(', ')}`);
  const opened = async how => {
    assert.equal(await p.title(), title, `the page did not open ${how}`);
    assert.equal(await p.evaluate(() => !!window.chalkTalk), true, `the app didn't start ${how}`);
    assert.ok((await p.textContent('#matchup')).trim(), `the board doesn't say the matchup ${how}`);
    let now;
    for (const end = Date.now() + 5000; ; await new Promise(r => setTimeout(r, 100))) {
      now = new Map(await faces());
      if (used.every(f => now.get(f) === 'loaded') || Date.now() > end) break;
    }
    assert.ok(used.every(f => now.get(f) === 'loaded'), `${how}, the fonts the page uses didn't all load: ${[...now].map(f => f.join(': ')).join(', ')}`);
  };
  net = 'down';
  await c.setOffline(true);
  await p.reload();
  await opened('offline');
  await c.setOffline(false);
  net = 'stalled';
  const t0 = Date.now();
  await p.reload({ timeout: 10000 }).catch(() => {});
  const took = Date.now() - t0;
  assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
  await opened('on a stalled connection');
  net = 'up';
  for (const [req, res] of held.splice(0)) serve(req, res);
  await c.close();
}

// A signal that drops partway through loading the page. On the release the copy has, the page gets the rest from the
// copy and works. When it's a new release, the page doesn't take the old copy's files to go with the new ones it has:
// it says it didn't finish loading, with a Reload button, and the copy stays one whole release, never half old and half
// new. With no signal, Reload opens that copy, and it works. Once the signal is back, the new release goes into the
// copy whole, every file at once.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(base);
  await p.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
  // Each copy this site keeps: how many files, and whether its page (at both its addresses) and its simulator are the
  // next release's.
  const copies = () => p.evaluate(async () => Promise.all((await caches.keys()).filter(k => k.startsWith('chalk-talk')).map(async k => {
    const cache = await caches.open(k), next = async f => !!(await (await cache.match(f))?.text())?.includes('the next release');
    return { k, n: (await cache.keys()).length, page: await next('./'), index: await next('index.html'), sim: await next('js/sim.js') };
  })));
  const whole = list => list.every(x => x.n === 0 || (x.n === shell.length && x.page === x.index && x.page === x.sim)) && list.filter(x => x.n).length === 1;
  const works = async how => {
    await p.waitForFunction(() => window.chalkTalk && document.getElementById('matchup').textContent.trim(), null, { timeout: 10000 }).catch(() => {});
    const seen = await p.evaluate(() => ({ app: !!window.chalkTalk, unloaded: !document.getElementById('unloaded').hidden }));
    assert.deepEqual(seen, { app: true, unloaded: false }, `the app didn't start ${how}`);
  };
  // the same release, the signal going right after the app's first file
  cut = '/js/app.js';
  await p.reload().catch(() => {});
  await works('when the signal went partway through loading the release the copy has');
  assert.deepEqual(errors, [], 'errors on the page that loaded from the copy partway');
  cut = null; net = 'up';
  // a new release, the same
  release = true; cut = '/js/app.js';
  await p.reload().catch(() => {});
  await p.waitForFunction(() => !document.getElementById('unloaded').hidden, null, { timeout: 10000 }).catch(() => {});
  const half = await p.evaluate(() => ({ app: !!window.chalkTalk, says: document.getElementById('unloaded').textContent.replace(/\s+/g, ' ').trim(), button: !!document.getElementById('reload').offsetHeight }));
  assert.deepEqual(half, { app: false, says: 'Chalk Talk didn\'t finish loading. Reload', button: true }, 'a page caught half-loaded by a new release');
  const after = await copies();
  assert.ok(whole(after), `the offline copy isn't one whole release after the signal dropped: ${JSON.stringify(after)}`);
  errors.length = 0; // a page that didn't load can say so in the console too
  await c.setOffline(true);
  await p.click('#reload');
  await works('from the copy with no signal, after Reload');
  // the signal back: the new release goes into the copy whole, and the page opens it
  await c.setOffline(false);
  cut = null; net = 'up';
  await p.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  let now;
  for (const end = Date.now() + 10000; !(whole(now = await copies()) && now.some(x => x.n && x.page)) && Date.now() < end;) await new Promise(r => setTimeout(r, 100));
  assert.ok(whole(now) && now.some(x => x.n && x.page), `the new release didn't go into the copy whole: ${JSON.stringify(now)}`);
  await p.reload();
  await works('on the new release');
  assert.deepEqual(errors, [], 'errors on a page that did load');
  release = false;
  await c.close();
}

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
release = true;
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
await until(() => page.evaluate(async () => !!(await (await caches.match('index.html'))?.text())?.includes('<!-- the next release -->')),
  10000, "the new release's offline copy kept the old index.html");
release = false;

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems offline or in the new release');
await browser.close();
server.close();

// sw.js changes whenever a file it keeps does, so a release replaces the whole offline copy at once: FILES in sw.js is
// a fingerprint of every file in SHELL (sha1 of each, in the list's order, an address like './' read as its
// index.html; the first 8 hex of the sha1 of those).
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
