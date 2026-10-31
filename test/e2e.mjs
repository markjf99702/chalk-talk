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
// The first thing to do, before the first snap: until a player is tapped or the play is snapped.
const HINT = 'Tap any player to see his job, then Snap.';
assert.equal(await page.textContent('#caption'), HINT, 'the board says what to do first');
await page.getByRole('radio', { name: 'Four Verticals' }).click();
assert.equal(await page.textContent('#caption'), HINT, 'the first hint stays when the call changes');
await page.getByRole('radio', { name: 'Smash' }).click();
await page.click('#runChart');
assert.match(await page.textContent('#runChart'), /^Running… [1-5] of 5$/, 'the chart says how far along it is');
await page.waitForFunction(() => !document.getElementById('runChart').disabled && document.querySelectorAll('#bars .bar-row:not(.waiting)').length === 5, null, { timeout: 30000 });
assert.equal(await page.locator('#bars .bar-row.mine').count(), 0, 'the chart gives away their coverage before the snap');
await tapOn('FS');
assert.match(await page.textContent('#whoPos'), /Free safety/, 'tapping the free safety opens his card');
assert.equal(await page.textContent('#caption'), '', 'the first hint goes once a player is tapped');
assert.match(await page.textContent('#whoJob'), /hidden until the snap/, 'a defender\'s job is hidden before the snap');

// Snap a play: it runs, and the result card explains it. Their call is out: the chart marks it. On a phone the
// tapped player's card closes, so the play can be seen (on a bigger board it says what he's doing: see below).
await page.click('#snap');
assert.equal(await page.locator('#bars .bar-row.mine').count(), 1, 'the chart marks their coverage once it is out');
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
// The board shows the headline, and a button down to the explanation.
assert.ok(await page.isVisible('#why'), 'the board points to the explanation when the play ends');
assert.equal((await page.textContent('#why')).replace(/\s+/g, ' ').trim(), `${await page.textContent('#resHead')} · Why ↓`);

// The scrubber reaches the whole play: halfway is halfway, and the far end is the end of the play.
const scrub = to => page.evaluate(to => {
  const s = document.getElementById('scrub'), { state, board } = window.chalkTalk;
  s.value = String(to === 'max' ? s.max : to * s.max);
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
assert.equal(await page2.evaluate(() => window.chalkTalk.state.off.play), 'power', 'a bad link changes the play');
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
      if (t) { s.disabled = false; s.value = String(Math.round(t / board.duration() * 1000)); s.dispatchEvent(new Event('input')); }
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
      s.disabled = false; s.value = String(t / board.duration() * 1000); s.dispatchEvent(new Event('input'));
      return [...document.querySelectorAll('#caption span')].map(x => x.textContent);
    };
    return { a: a.text, b: b.text, both: at(b.t + 0.1), before: at((a.t + b.t) / 2), later: at(a.t + 2.3), again: at(b.t + 0.1) };
  });
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
    if (t) await p.evaluate(t => { const s = document.getElementById('scrub'), { board } = window.chalkTalk; s.value = String(t / board.duration() * 1000); s.dispatchEvent(new Event('input')); }, t);
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
  await wide.close();
}

// The smallest phones (320 px wide): after the first snap, when the button reads "Run it again", every control under
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
