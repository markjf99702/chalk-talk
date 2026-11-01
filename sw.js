// Offline support: keep a copy of the app so it works with no signal.
// Anything the person saves lives in localStorage, not here.
// Network first, so a new version shows up as soon as you're online, but a page the network hasn't answered in a few
// seconds opens from the copy instead (see page()).

// The copy is one whole release. It's made only when a new version of this file installs: every file in SHELL at once,
// all of them or none, into a copy of its own, which then takes the last one's place. Nothing a page loads goes into
// it, so a signal that drops partway through loading a new release can't leave it half old and half new. FILES is a
// fingerprint of every file in SHELL: change any of them and test/e2e.mjs fails until FILES is changed to match (it says
// what to), which changes this file, so the browser installs it and makes the new copy.
const FILES = '1723bf4b'; // test/e2e.mjs checks this
const CACHE = `chalk-talk-v2-${FILES}`; // one copy per release
const SHELL = [
  './', 'index.html', 'icon.svg', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/sim.js', 'js/board.js', 'js/playbook.js', 'js/rng.js',
  'fonts/barlow-400.woff2', 'fonts/barlow-600.woff2', 'fonts/barlow-700.woff2', 'fonts/barlow-condensed-700.woff2',
  'fonts/permanent-marker.woff2', 'fonts/patrick-hand.woff2',
];

// Each file straight from the server (a quick "not modified" for one that hasn't changed), not from the browser's own
// copies, which can be ten minutes old (see fresh() below): a copy made from those could mix in the last release. If
// any file doesn't come, nothing goes in, this version doesn't install, and the last copy stays as it was.
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // Only this project's own old copies, by exact name: the tools at junkdrawer.works/REPO/ share one Cache Storage,
    // and a looser match would delete another project's copy (all of them, or one whose name starts with this one's).
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && /^chalk-talk-v[0-9]+(-[0-9a-z]+)?$/.test(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// How long a page waits for the network before it opens from the copy instead.
const PATIENCE = 4000; // ms

// Each page (by its client id) takes all its files from one release, so it never runs half of one and half of another:
// - 'copy' once it has had a file from the copy: the rest come from the copy too.
// - 'net' once the network has sent it a file that isn't the copy's (a new release the copy hasn't got yet): the rest
//   come from the network only. If the signal goes before they're in, the page didn't finish loading, and it says so
//   (see the end of index.html).
// Until either, what the network sends is what the copy has, and either will do. (The browser stops the worker once it
// has been idle a while, and the list goes with it.)
const source = new Map();
function pin(id, from) {
  if (!id || source.get(id) === from) return;
  source.set(id, from);
  if (source.size > 50) source.delete(source.keys().next().value); // the oldest, long gone
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(e.request.mode === 'navigate' ? page(e) : file(e.request, e.clientId));
});

// A page, from the network. On a connection that's up but not answering (a train, a captive wifi, one bar of signal),
// it opens from the copy after PATIENCE instead, if the copy has it. With no copy of the page, it waits on for the
// network. With no network at all, it opens from the copy straight away, as it always has.
function page(e) {
  const id = e.resultingClientId;
  const net = fresh(e.request);
  // Safari before 16 doesn't say which page a load becomes (no resultingClientId), so the page's files couldn't come
  // from the copy too, and would wait on the network anyway. There a page waits for the network, as it always has.
  if (!id) return net.catch(() => offline(e.request));
  return new Promise((resolve, reject) => {
    let answered = false;
    // from: where the rest of the page's files come from (see source)
    const answer = (res, from) => {
      if (answered) return;
      answered = true;
      clearTimeout(slow);
      pin(id, from);
      resolve(res);
    };
    const slow = setTimeout(() => kept(e.request).then(copy => { if (copy) answer(copy, 'copy'); }), PATIENCE);
    net.then(async res => {
      const copy = await kept(e.request);
      answer(res, copy && !(await same(res, copy)) ? 'net' : undefined);
    }, () => offline(e.request).then(res => (res ? answer(res, 'copy') : reject(new TypeError('No network, and no copy'))), reject));
  });
}

// Anything else a page loads, from the network or the copy, whichever its page is taking its files from (see source).
// Everything it has to go on is in hand before it decides, so two files the page asked for at once are decided one
// after the other, each against what the page has had so far.
async function file(request, id) {
  const copy = kept(request);
  if (source.get(id) === 'copy') return (await copy) || fresh(request);
  const [res, mine] = await Promise.all([fresh(request).catch(() => null), copy]);
  const differs = res && mine && !(await same(res, mine));
  const from = source.get(id);
  if (from === 'copy' && mine) return mine; // it turned to the copy while this one was on its way
  if (!res) {
    if (from === 'net' || !mine) return Response.error();
    pin(id, 'copy');
    return mine;
  }
  if (differs && from !== 'copy') pin(id, 'net');
  return res;
}

// Whether the network's answer for a file is the copy's: by the server's tag for the file when they share one (GitHub
// Pages gives each file one, new with every release of the site), and otherwise by what's in them.
async function same(res, copy) {
  const tag = res.headers.get('etag');
  if (tag && tag === copy.headers.get('etag')) return true;
  if (res.status !== copy.status) return false;
  const [a, b] = await Promise.all([res.clone().arrayBuffer(), copy.clone().arrayBuffer()]);
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return false;
  return true;
}

// A file from the copy, marked like the network's (see askAgainNextTime() below), so a reload once the network is
// back asks again rather than reusing it.
const kept = request => caches.open(CACHE).then(c => c.match(request, { ignoreSearch: true })).then(r => r && askAgainNextTime(r));
// With no network: the page from the copy, or for an address it hasn't got, the app's page.
const offline = request => kept(request).then(r => r || kept(new Request('index.html')));

// GitHub Pages lets browsers keep files for ten minutes, so without this an update can take that long to show up.
// Ask the server every time instead; a file that hasn't changed comes back as a quick "not modified".
function fresh(request) {
  const got = request.mode === 'navigate'
    // A page load can't be answered with a redirected response, so fall back to the plain request if there was one.
    ? fetch(request.url, { cache: 'no-cache' }).then(res => (res.redirected ? fetch(request) : res))
    : fetch(request, { cache: 'no-cache' });
  return got.then(askAgainNextTime);
}

// The open tab keeps its own copy of each file too, and would reuse it on a reload without asking.
// Marking the copy it gets from here no-cache sends that reload back through fresh() as well.
function askAgainNextTime(res) {
  if (res.status !== 200 || res.type !== 'basic' || res.redirected) return res;
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'no-cache');
  headers.delete('content-encoding'); // the body here is already unpacked
  headers.delete('content-length');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
