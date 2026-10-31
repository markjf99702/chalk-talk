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

// Snap a play: it runs, and the result card explains it.
await page.click('#snap');
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
assert.ok((await page.textContent('#resHead')).trim().length > 3, 'the result has a headline');
assert.ok(await page.$$eval('#story li', li => li.length) >= 1, 'the play-by-play has at least one line');
assert.ok((await page.textContent('#note')).trim().length > 40, 'the coach\'s note is there');
assert.match(await page.textContent('#theirsHint'), /They called/, 'their call is shown after the snap');

// Tap a player: his card says who he is and what he did.
const qb = await page.evaluate(() => {
  const { board, state } = window.chalkTalk;
  const i = state.play.players.findIndex(p => p.label === 'QB');
  const r = board.cv.getBoundingClientRect(), p = board.pos(board.t, i);
  return { x: r.left + board.sx(p.x), y: r.top + board.sy(p.y) };
});
await page.mouse.click(qb.x, qb.y);
assert.match(await page.textContent('#whoPos'), /Quarterback/, 'tapping the quarterback opens his card');
await page.click('#whoClose');

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

// A shared link opens the exact same play.
await page.click('[data-side="O"]');
await page.click('#snap');
await page.waitForSelector('#result:not([hidden])', { timeout: 15000 });
const head = await page.textContent('#resHead');
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
await page.click('#share');
await page.waitForFunction(() => document.getElementById('shareMsg').textContent.length > 0);
const link = await page.evaluate(async () => { try { return await navigator.clipboard.readText(); } catch { return document.getElementById('shareMsg').textContent; } });
assert.match(link, /#p=O\./, 'the share link has the play in it');
const page2 = await ctx.newPage();
page2.on('pageerror', e => problems.push(e.message));
await page2.goto(base + link.slice(link.indexOf('#')));
await page2.waitForSelector('#result:not([hidden])', { timeout: 15000 });
assert.equal(await page2.textContent('#resHead'), head, 'the shared link replays the same result');
await page2.close();

// Fits a phone: nothing scrolls sideways.
assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the page scrolls sideways on a phone');

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

assert.deepEqual(problems.filter(p => !p.startsWith('failed:')), [], 'problems while using it');
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
