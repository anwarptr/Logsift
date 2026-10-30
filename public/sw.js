// Lets Logsift open offline once it has been visited (and be installed as an app).
// Pages: network first, so a new version shows up as soon as there is a connection.
// Hashed build files (assets/*): cache first, since their names change whenever their content does.
// Nothing here ever sees log data: files are read by the page itself, not fetched.
const CACHE = 'logsift-v1';
/** Old builds' assets are dropped once the cache holds more than this many. */
const MAX_ASSETS = 40;

// On install, keep the page and the files it links to, so the next visit works offline right away.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch('./', { cache: 'no-cache' });
      if (!response.ok) return;
      const html = await response.clone().text();
      await cache.put('./', response);
      const linked = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^[a-z]+:/i.test(u));
      // The parser worker is loaded by the main script (only once a log is opened), so find it there.
      for (const src of linked.filter((u) => u.endsWith('.js'))) {
        const js = await fetch(src).then((r) => (r.ok ? r.text() : ''), () => '');
        for (const m of js.matchAll(/"([\w.-]+\.worker-[\w-]+\.js)"/g)) linked.push(new URL(m[1], new URL(src, self.location.href)).href);
      }
      await cache.addAll([...new Set(linked)]).catch(() => {});
    })().then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
    const assets = (await cache.keys()).filter((r) => new URL(r.url).pathname.includes('/assets/'));
    await Promise.all(assets.slice(0, Math.max(0, assets.length - MAX_ASSETS)).map((r) => cache.delete(r)));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(url.pathname.includes('/assets/') ? cacheFirst(request) : networkFirst(request));
});
