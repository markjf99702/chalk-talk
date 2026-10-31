// Uses the app in Chromium through the real page:  node test/e2e.mjs  (needs Playwright)
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
// The server answers the way GitHub Pages does: a browser may keep each file for ten minutes, and asks again by its
// ETag. `net` is the connection: 'up', 'down' (the server drops every connection) or 'stalled' (a train, a captive
// wifi: it takes each request and holds on to it). With `release` set it serves the next release (see the end).
let net = 'up', release = false;
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
  const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
  const head = { etag, 'cache-control': 'max-age=600', 'content-type': TYPES[extname(path)] || 'text/html' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, head); res.end(); return; }
  res.writeHead(200, head);
  res.end(body);
}
const base = `http://localhost:${server.address().port}/`;
// Waits for ok() to come true, for up to ms, or fails saying what didn't happen.
const until = async (ok, ms, what) => {
  for (const end = Date.now() + ms; !(await ok());) { assert.ok(Date.now() < end, what); await new Promise(r => setTimeout(r, 100)); }
};

const browser = await pw.chromium.launch();
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
await page.getByRole('radio', { name: 'Four Verticals' }).click();
assert.equal(await page.textContent('#caption'), HINT, 'the first hint stays when the call changes');
await page.getByRole('radio', { name: 'Smash' }).click();
await page.click('#runChart');
assert.match(await page.textContent('#runChart'), /^Running… [1-5] of 5$/, 'the chart says how far along it is');
await page.waitForFunction(() => document.getElementById('runChart').getAttribute('aria-disabled') !== 'true' && document.querySelectorAll('#bars .bar-row:not(.waiting)').length === 5, null, { timeout: 30000 });
assert.equal(await page.locator('#bars .bar-row.mine').count(), 0, 'the chart gives away their coverage before the snap');
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
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
assert.ok((await page.textContent('#resHead')).trim().length > 3, 'the result has a headline');
assert.ok(await page.$$eval('#story li', li => li.length) >= 1, 'the play-by-play has at least one line');
assert.ok((await page.textContent('#note')).trim().length > 40, 'the coach\'s note is there');
assert.match(await page.textContent('#theirsHint'), /They called/, 'their call is shown after the snap');
assert.equal(await page.textContent('#say'), `${await page.textContent('#resHead')}. ${await page.textContent('#resKicker')}. Why it worked is under the board.`);
// One name for one thing: Snap again is a new snap of the same calls, here and in the result card, and it says so. The
// play button watches this one again.
assert.equal(await page.textContent('#snap'), 'Snap again');
assert.equal(await page.textContent('#again'), 'Snap again');
assert.equal(await page.getAttribute('#play', 'aria-label'), 'Watch it again', 'at the end the play button watches it again');
assert.equal(await page.textContent('#actionsNote'), 'Snap again: the same two calls, played out fresh. New look: the other coach changes his call.');
// The board shows the headline, and a button down to the explanation.
assert.ok(await page.isVisible('#why'), 'the board points to the explanation when the play ends');
assert.equal((await page.textContent('#why')).replace(/\s+/g, ' ').trim(), `${await page.textContent('#resHead')} · Why ↓`);

// The scrubber reaches the whole play: halfway is halfway, and the far end is the end of the play.
const scrub = to => page.evaluate(to => {
  const s = document.getElementById('scrub'), { state, board } = window.chalkTalk;
  s.value = String(to === 'max' ? s.max : Math.round(to * s.max));
  s.dispatchEvent(new Event('input'));
  return { t: state.t, duration: board.duration(), phase: state.phase, result: !document.getElementById('result').hidden, why: !document.getElementById('why').hidden };
}, to);
const half = await scrub(0.5);
assert.ok(Math.abs(half.t - half.duration / 2) < 0.1, `halfway along the scrubber shows ${half.t.toFixed(2)} s of a ${half.duration.toFixed(2)} s play`);
assert.equal(half.why, false, 'the button to the explanation goes away when you scrub back into the play');
const end = await scrub('max');
assert.equal(end.t, end.duration, 'the far end of the scrubber is the end of the play');
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
    Object.assign(state.def, { front: 'nickel', coverage: 'c3', pressure: 'four' });
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

// The chart runs every play against this defense.
await page.click('#runChart');
await page.waitForFunction(() => document.querySelectorAll('#bars .bar-row:not(.waiting)').length === 11, null, { timeout: 30000 });

// The headline and the verdict over it round the same way: the simulator spots the ball to the half yard, and a
// 3.5-yard run reads "Gain of 4 yards", the line where a play counts as a win for the offense.
const close = await page.evaluate(() => {
  const { state, board, simulate, lineUp, finish } = window.chalkTalk;
  Object.assign(state.off, { formation: 'iform', play: 'iz', flip: false });
  Object.assign(state.def, { front: 'over', coverage: 'c3', pressure: 'four' });
  for (let seed = 1; seed < 3000; seed++) {
    const res = simulate({ ...state.off, ...state.def }, seed).result;
    if (res.kind !== 'run' || res.yards !== 3.5) continue;
    state.seed = seed; lineUp(); state.t = board.duration(); finish();
    return { seed, head: document.getElementById('resHead').textContent, kicker: document.getElementById('resKicker').textContent };
  }
});
assert.ok(close, 'no 3.5-yard run in 3,000 snaps of Inside Zone');
assert.equal(close.head, 'Gain of 4 yards', `seed ${close.seed}`);
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
assert.equal(short?.head, 'Gain of 3 yards');
assert.equal(short.kicker, 'A win for the defense: short of the 4\u00a0yards that make a play a success', `"Gain of 3 yards" under "${short.kicker}" (seed ${short.seed})`);

// A shared link opens the exact same play. Copying it says so on the button.
await page.click('[data-side="O"]');
await page.click('#snap');
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
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

// The man the caption names is ringed on the board while his line is up, scrubbing as well as playing: the receiver at
// the throw. Nobody is ringed before the snap or once the caption makes way for the headline.
{
  const p = await ctx.newPage();
  p.on('pageerror', e => problems.push(e.message));
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.15');
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
    Object.assign(state.off, { formation: 'iform', play: 'iz', flip: false });
    Object.assign(state.def, { front: 'over', coverage: 'c3', pressure: 'four' });
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
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.15');
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
  await p.goto(base + '#p=O.trips.smash.0.nickel.c2.four.15');
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
  await wide.close();
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

// On a touch screen the things to tap are 44 px or so (the chips 42), and the speed buttons' 31 px pills take a tap
// 44 px tall.
{
  const sizes = await page.evaluate(() => {
    const short = (sel, min) => [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect()).filter(b => b.height < min).length;
    const speed = document.querySelector('[data-speed="1"]').getBoundingClientRect();
    const reach = [-21, 21].every(dy => document.elementFromPoint(speed.left + speed.width / 2, speed.top + speed.height / 2 + dy)?.closest('[data-speed="1"]'));
    return { coarse: matchMedia('(pointer: coarse)').matches, chips: short('.chip', 40), buttons: short('.ghost, .side-pick button, .tool, .switch', 44), reach };
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
  for (const w of ['Strong side and weak side', 'Play side and back side', 'The box', 'Shotgun', 'Press', 'Leverage', 'Over the top', 'Three-step and five-step drop', 'Check-down', 'Deep thirds, halves and quarters', 'Success']) {
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

// A blitzer's arrow is told apart by its shape as well as its colour (WCAG 2.2, 1.4.1 Use of Color): a thicker line and
// a double head, against one head on every other rusher's.
{
  const p = await phone();
  const marks = await p.evaluate(() => {
    const { state, board, lineUp } = window.chalkTalk;
    document.querySelector('[data-side="D"]').click();
    Object.assign(state.off, { formation: 'doubles', play: 'verts', flip: false });
    Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'blitz' });
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
    const at = await p.evaluate(() => { const { state, board } = window.chalkTalk; return { phase: state.phase, t: state.t, board: board.t, scrub: document.getElementById('scrub').value }; });
    assert.deepEqual(at, { phase: 'pre', t: 0, board: 0, scrub: '0' }, `changing ${what} mid-play`);
  }
  await p.context().close();
}

// Each side keeps your own call. Switch to the defense and back and the offense is the one you called, not the one the
// other coach picked while you were on defense; the same for the defense, and after a reload.
{
  const p = await phone();
  const calls = () => p.evaluate(() => { const { state } = window.chalkTalk; return { off: { ...state.off }, def: { ...state.def } }; });
  for (const name of ['Singleback', 'Left', 'Power']) await p.getByRole('radio', { name }).click();
  const off = (await calls()).off;
  assert.deepEqual(off, { formation: 'single', play: 'power', flip: true });
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
      Object.assign(state.def, { front: 'nickel', coverage: 'c3', pressure: 'four' });
      chip('I-Form').click();
      if (state.def.front === 'nickel') n++;
    }
    return n;
  });
  assert.ok(nickel < 12, `a nickel defense stayed on against I-Form ${nickel} times in 30`);
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

// The read after the snap says what the corners showed: pressed in man, about 5 yards off in Cover 2, 7 or more off in
// the deep zones. And the playbook says the board's defenses line up in what they play, as they do.
{
  const p = await phone();
  const reads = await p.evaluate(() => {
    const { state, lineUp, snap, finish } = window.chalkTalk, out = {};
    for (const coverage of ['c1', 'c2', 'c3', 'c4']) {
      Object.assign(state.def, { front: 'nickel', coverage, pressure: 'four' });
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
    Object.assign(state.off, { formation: 'doubles', play: 'verts', flip: false });
    Object.assign(state.def, { front: 'nickel', coverage: 'c1', pressure: 'blitz' });
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
      Object.assign(state.off, { formation: 'single', play: 'smash', flip: f });
      lineUp(); snap(); finish();
      return document.getElementById('theirsHint').textContent;
    }, flip);
    assert.equal(said, `They called: Singleback, strength to your ${flip ? 'right' : 'left'}, Smash.`, `strong side ${flip ? 'left' : 'right'}`);
  }
  await p.context().close();
}

// From the keyboard: a pick keeps focus on the chip picked (the choosers are drawn again on every pick), the result
// card's buttons hand it to Snap as the card goes away, and the chart's button keeps it while it runs.
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
    await p.evaluate(() => { const { state, snap, finish } = window.chalkTalk; if (state.phase === 'pre') { snap(); finish(); } });
    await p.focus(`#${id}`);
    await p.keyboard.press('Enter');
    assert.equal(await focused(), 'snap', `#${id} dropped the focus as the result card went away`);
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
  assert.deepEqual(stops, ['Formation:trips', 'Strong side:R', 'Play:iz'], 'one Tab stop for each group, at the one picked');
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

// A change of call while the chart is running starts it again for the new call, and one that clears a finished chart
// says so until it's run again.
{
  const p = await phone();
  const rows = () => p.$$eval('#bars .bar-row:not(.waiting)', r => r.length);
  const ready = () => p.waitForFunction(() => document.getElementById('runChart').getAttribute('aria-disabled') !== 'true' && document.querySelectorAll('#bars .bar-row:not(.waiting)').length === 5, null, { timeout: 30000 });
  await p.click('#runChart');
  await p.getByRole('radio', { name: 'Mesh' }).click();
  assert.equal(await p.getAttribute('#runChart', 'aria-disabled'), 'true', 'changing the call stopped the chart');
  await ready();
  await p.getByRole('radio', { name: 'Flood' }).click();
  assert.equal(await rows(), 0);
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
  await p.evaluate(() => { location.hash = '#p=O.trips.smash.0.nickel.c2.four.15'; });
  await p.waitForFunction(() => window.chalkTalk.state.linked);
  assert.doesNotMatch(await p.textContent('#chartHint'), /Run it again/, 'a shared link kept the word about the chart');
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
  await p.waitForSelector('#result:not([hidden])', { timeout: 15000 });
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

// Contrast, by WCAG 2.2: the yard numbers (text, 1.4.3) at 4.5:1 or more on the board as they're drawn, the sidelines and
// 10-yard lines on the whiteboard at 3:1 (graphics, 1.4.11), and the small grey words on and beside the board at 4.5:1.
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
  await c.close();
}

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
    return { forced: matchMedia('(forced-colors: active)').matches, chip: pair('#mineBody .chip'), side: pair('[data-side]'), speed: pair('[data-speed]'), labels: [pressed, released], snap: getComputedStyle(document.getElementById('snap')).borderTopWidth };
  });
  assert.ok(seen.forced, 'forced colours are on');
  for (const k of ['chip', 'side', 'speed', 'labels']) assert.notEqual(seen[k][0], seen[k][1], `in forced colours a picked ${k} looks like one that isn't (${seen[k][0]})`);
  assert.notEqual(seen.snap, '0px', 'in forced colours Snap has no outline');
  await c.close();
}

// Names a screen reader says, from the accessibility tree: the labels toggle, the speeds, a formation with its personnel,
// the card's close button and the board as a picture. And with reduced motion asked for, nothing scrolls smoothly.
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, reducedMotion: 'reduce' });
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
  assert.ok(smooth.length >= 3 && smooth.every(b => b !== 'smooth'), `with reduced motion the page scrolled: ${smooth}`);
  await c.close();
}

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

// Nothing went wrong while using it: no errors, no failed requests, nothing loaded from anywhere else. (From here on
// the connection goes down on purpose, so failed requests are expected.)
assert.deepEqual(problems, [], 'problems while using it');

// Works offline once it has been opened. The server goes down as well as the browser: in some Chromium builds the
// browser's offline switch alone doesn't stop the service worker's own requests, and this passed with no copy at all.
await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
const title = await page.title();
net = 'down';
await ctx.setOffline(true);
await page.reload();
assert.equal(await page.title(), title, 'the page did not open offline');
await ctx.setOffline(false);

// On a connection that's up but not answering, it opens from the copy too, after the worker's few seconds' wait for
// the network: the page and every file it loads (were any of them left waiting on the network, it wouldn't open).
net = 'stalled';
const t0 = Date.now();
await page.reload({ timeout: 10000 }).catch(() => {});
const took = Date.now() - t0;
assert.ok(took < 8000, `the page took ${took} ms to open on a stalled connection`);
assert.equal(await page.title(), title, 'the page did not open on a stalled connection');
net = 'up';
for (const [req, res] of held.splice(0)) serve(req, res);

// A new release: every file in the new copy comes from the server, though the browser still has its own copies of
// the old ones for ten minutes. (The next release changes index.html, and so FILES in sw.js, as a real one does.)
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
const sw = await readFile(join(root, 'sw.js'), 'utf8');
const shell = [...sw.match(/SHELL = \[([^\]]*)\]/)[1].replace(/\/\/.*/g, '').matchAll(/'([^']*)'/g)].map(m => m[1]);
const all = createHash('sha1');
for (const f of shell) all.update(createHash('sha1').update(await readFile(join(root, f.endsWith('/') ? f + 'index.html' : f))).digest());
const files = all.digest('hex').slice(0, 8);
assert.equal(sw.match(/const FILES = '([0-9a-f]*)'/)?.[1], files, `a file sw.js keeps for offline has changed: set FILES in sw.js to '${files}'`);
console.log('all good');
