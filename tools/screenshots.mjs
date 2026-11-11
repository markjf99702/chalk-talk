// Renders the README screenshots (docs/*.png) and the link preview (og.png):  node tools/screenshots.mjs
// Every picture is one fixed play (Smash from Gun Trips against Nickel Cover 2, seed 148), opened from its share
// link, so the same pictures come out every time.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIM_VERSION } from '../js/sim.js';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let body;
  try { body = await readFile(join(root, path === '/' ? 'index.html' : path)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' });
  res.end(body);
}).listen(0);
const base = `http://localhost:${server.address().port}/`;
// A link made with this version of the simulator, so the result card doesn't say it was made with another.
const PLAY = `#p=O.trips.smash.0.nickel.c2.four.148.v${SIM_VERSION}`;
const browser = await pw.chromium.launch();
await mkdir(join(root, 'docs'), { recursive: true });

async function open(viewport, deviceScaleFactor, colorScheme = 'dark', hash = PLAY) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor, colorScheme, hasTouch: viewport.width < 600, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(base + hash);
  await page.evaluate(() => document.fonts.ready);
  // the link starts the play on its own; take over the clock instead
  await page.waitForFunction(() => window.chalkTalk?.state.phase === 'playing');
  return page;
}
// Hold the play at a moment the way the page shows it when you scrub there: the board, the caption and the scrubber.
const hold = (page, t) => page.evaluate(async t => {
  const { board, pause } = window.chalkTalk;
  pause();
  await new Promise(r => requestAnimationFrame(r));
  const scrub = document.getElementById('scrub');
  scrub.value = String(Math.round(t / board.duration() * +scrub.max));
  scrub.dispatchEvent(new Event('input'));
}, t);

// Phone screenshots for the README.
{
  const page = await open({ width: 390, height: 844 }, 2);
  // before the snap, with the Snap button
  await page.evaluate(() => { const { pause, lineUp } = window.chalkTalk; pause(); lineUp(); });
  await page.screenshot({ path: join(root, 'docs/phone-call.png') });
  await hold(page, 2.2);
  await page.screenshot({ path: join(root, 'docs/phone-play.png') });
  // the end of the play as the page shows it: the headline on the board where the caption was, and the result card
  await page.evaluate(() => {
    const { state, board, finish } = window.chalkTalk;
    state.t = board.t = board.duration(); board.render();
    finish();
  });
  // the button fades in: wait for it to finish
  await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished)));
  await page.evaluate(() => { const r = document.getElementById('result'); window.scrollTo(0, r.getBoundingClientRect().top + scrollY - document.querySelector('.stage').offsetHeight - 8); });
  await page.screenshot({ path: join(root, 'docs/phone-result.png') });
  await page.context().close();
}

// Link preview, 1200 x 630: the name and one line on the left, the board from the running app on the right.
{
  const page = await open({ width: 1280, height: 860 }, 2);
  await hold(page, 2.35);
  await page.evaluate(() => { document.getElementById('caption').textContent = ''; document.getElementById('matchup').textContent = ''; });
  const shot = await page.locator('.board-wrap').screenshot();
  await page.context().close();
  const font = async f => `data:font/woff2;base64,${(await readFile(join(root, 'fonts', f))).toString('base64')}`;
  const card = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await card.setContent(`<!doctype html><style>
    @font-face { font-family: M; src: url(${await font('permanent-marker.woff2')}); }
    @font-face { font-family: B; src: url(${await font('barlow-400.woff2')}); }
    @font-face { font-family: H; src: url(${await font('patrick-hand.woff2')}); }
    html, body { margin: 0; width: 1200px; height: 630px; background: #18201c; color: #ece9df; overflow: hidden; }
    .wrap { display: grid; grid-template-columns: 430px 1fr; height: 100%; align-items: center; }
    .words { padding: 0 20px 0 64px; }
    h1 { font: 400 78px/1 M; margin: 0; }
    p { font: 400 30px/1.3 B; color: #c4c9bf; margin: 22px 0 0; }
    .tag { font: 400 26px H; color: #f2d36b; margin-top: 30px; }
    img { width: 760px; display: block; border-radius: 14px; box-shadow: 0 24px 60px -20px #000; }
  </style><div class="wrap"><div class="words"><h1>Chalk Talk</h1><p>Call a play, snap it, and see why it worked.</p><div class="tag">Smash vs. Cover 2</div></div>
  <div><img src="data:image/png;base64,${shot.toString('base64')}"></div></div>`);
  await card.evaluate(() => document.fonts.ready);
  await card.screenshot({ path: join(root, 'og.png') });
  await card.close();
}

await browser.close();
server.close();
console.log('screenshots written');
