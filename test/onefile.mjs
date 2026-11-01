// Builds the one-file copy and uses it in Chromium, opened from a file the way someone would open it after
// downloading it:  node test/onefile.mjs  (needs esbuild, from npm install, and Playwright)
import { createRequire } from 'node:module';
import { execSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try { await import('esbuild'); } catch {
  console.log('onefile: skipped, esbuild isn\'t installed (npm install)');
  process.exit(0);
}
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require(join(execSync('npm root -g').toString().trim(), 'playwright')); }

// The build reads exact text out of css/app.css (the dark palette, the sticky board's rule), and fails if it isn't there.
execFileSync(process.execPath, [join(root, 'scripts/build.mjs')], { stdio: ['ignore', 'ignore', 'inherit'] });
const SITE = 'https://chalk-talk.junkdrawer.works/';
const dir = await mkdtemp(join(tmpdir(), 'chalk-talk-onefile-'));
const browser = await pw.chromium.launch();
try {
  await copyFile(join(root, 'dist/chalk-talk.html'), join(dir, 'chalk-talk.html'));
  // A phone, with no other file to reach: everything it needs is in the page.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const url = pathToFileURL(join(dir, 'chalk-talk.html')).href;
  const problems = [], asked = [];
  page.on('pageerror', e => problems.push(e.message));
  page.on('console', m => { if (m.type() === 'error') problems.push(m.text()); });
  page.on('request', r => { if (!r.url().startsWith('data:')) asked.push(r.url()); });
  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-single')), true, 'the copy doesn\'t say it\'s the one-file copy');

  // A snap plays out to a result, and the chart runs every coverage.
  await page.click('#snap');
  await page.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
  assert.ok((await page.textContent('#resHead')).trim().length > 3, 'the result has a headline');
  await page.click('#runChart');
  await page.waitForFunction(() => document.getElementById('runChart').getAttribute('aria-disabled') !== 'true' && document.querySelectorAll('#bars .bar-row:not(.waiting)').length === 5, null, { timeout: 30000 });

  // Every font it used came from inside the page.
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    const faces = [...document.fonts].map(f => ({ family: f.family.replace(/"/g, ''), weight: f.weight, status: f.status }));
    return { faces, used: faces.filter(f => f.status !== 'unloaded') };
  });
  assert.deepEqual(fonts.used.filter(f => f.status !== 'loaded'), [], 'fonts that didn\'t load from the page');
  for (const family of ['Barlow', 'Barlow Condensed', 'Patrick Hand', 'Permanent Marker']) {
    assert.ok(fonts.used.some(f => f.family === family), `${family} didn't load (${JSON.stringify(fonts.faces)})`);
  }

  // A shared link goes to the real site, not to the file.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await page.click('#share');
  const link = await page.inputValue('#shareUrl');
  assert.ok(link.startsWith(`${SITE}#p=`), `the copy's share link is ${link}`);

  // A host page with its own light and dark switch sets data-theme on <html>: the page follows it.
  const bg = theme => page.evaluate(t => { document.documentElement.dataset.theme = t; return getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(); }, theme);
  const light = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const dark = await bg('dark');
  assert.notEqual(dark, light, 'data-theme="dark" left the colours as they were');
  assert.equal(await bg('light'), light, 'data-theme="light" didn\'t bring the light colours back');

  assert.deepEqual(asked, [url], 'the copy asked for something besides itself');
  assert.deepEqual(problems, [], 'problems in the one-file copy');
  await ctx.close();

  // Served from a web address, it still keeps no offline copy: that's the site's, and the file has nothing to keep.
  const server = createServer(async (req, res) => {
    try { const body = await readFile(join(dir, new URL(req.url, 'http://x').pathname)); res.writeHead(200, { 'content-type': 'text/html' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  }).listen(0);
  try {
    const served = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await served.newPage();
    const got = [];
    p.on('request', r => { if (!r.url().startsWith('data:')) got.push(new URL(r.url()).pathname); });
    await p.goto(`http://localhost:${server.address().port}/chalk-talk.html`);
    await p.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(await p.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0, 'the one-file copy registered a service worker');
    assert.deepEqual(got, ['/chalk-talk.html'], 'served, the copy asked for something besides itself');
    await served.close();
  } finally { server.close(); }

  // The copy without its document wrapper, for hosts that supply their own <html>, <head> and <body>: in a bare one, a
  // snap plays out.
  const fragment = await readFile(join(root, 'dist/artifact.html'), 'utf8');
  await writeFile(join(dir, 'artifact.html'), `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>A host</title>\n</head>\n<body>\n${fragment}</body>\n</html>\n`);
  const host = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const a = await host.newPage();
  const wrong = [];
  a.on('pageerror', e => wrong.push(e.message));
  a.on('console', m => { if (m.type() === 'error') wrong.push(m.text()); });
  await a.goto(pathToFileURL(join(dir, 'artifact.html')).href);
  await a.click('#snap');
  await a.waitForSelector('#result:not([hidden]):not(.stale)', { timeout: 15000 });
  assert.equal(await a.evaluate(() => getComputedStyle(document.querySelector('.stage')).position), 'sticky', 'in a host, the board doesn\'t stay at the top of a phone');
  assert.deepEqual(wrong, [], 'problems in the copy without its wrapper');
  await host.close();
  console.log('onefile: all good');
} finally {
  await browser.close();
  await rm(dir, { recursive: true, force: true });
}
