/**
 * Riosoma's service worker.  The build (`build/service-worker.ts`) writes `sw.js` from this file
 * after a short header that imports the listener scripts and sets `self.rioWorker`:
 *
 * - `cacheName`: this registration's versioned Riosoma precache name.
 * - `precache`: the files a new install downloads before it takes over, each `{ url, revision }`.
 *   A file whose name already changes with its contents has a `null` revision.
 * - `navigationFallback`: the page that answers app navigations.
 * - `navigationDenylist`: paths whose navigations always go to the network.
 *
 * The listener scripts register first.  `notification-worker.js` answers build assets, themes,
 * and app navigations itself and stops the event there, so the routes below answer the rest:
 * precached shell files and navigations the listener leaves alone.
 */
(() => {
  const { cacheName, precache, navigationFallback, navigationDenylist } = self.rioWorker;
  // Marketing parameters never change a file, so a request carrying them still finds it.
  const ignoredParameters = [/^utm_/, /^fbclid$/];

  /** Each precached address, without a hash, mapped to the key its response is stored under. */
  const precached = new Map();
  for (const entry of precache) {
    const url = new URL(entry.url, self.location.href);
    url.hash = '';
    const key = new URL(url.href);
    // A revision in the key makes a changed file a new entry, so a new build replaces it.
    if (entry.revision) key.searchParams.set('__rio_revision', entry.revision);
    precached.set(url.href, { key: key.href, revision: entry.revision });
  }

  /** A redirected response cannot answer a navigation, so store a plain copy instead. */
  async function storable(response) {
    if (!response.redirected) return response;
    return new Response(await response.blob(), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Downloads run one at a time, skipping files whose revision is already stored.  `self.fetch`
  // is the notification listener's validating fetch, so a stale or mistyped asset fails the install.
  async function install() {
    const cache = await caches.open(cacheName);
    for (const [url, { key, revision }] of precached) {
      if (await cache.match(key)) continue;
      // A revisioned file can share its address with an older copy, so skip the browser cache.
      const request = new Request(url, {
        cache: revision ? 'reload' : 'default',
        credentials: 'same-origin',
      });
      const response = await self.fetch(request);
      if (response.status >= 400) throw new Error(`Precache request failed: ${url} (${response.status})`);
      await cache.put(key, await storable(response));
    }
  }

  // Remove what this build no longer lists, and earlier precaches for this registration.
  // Old open pages keep their assets in the notification listener's separate runtime cache,
  // which its install step fills first.
  async function activate() {
    const cache = await caches.open(cacheName);
    const expected = new Set([...precached.values()].map((entry) => entry.key));
    for (const request of await cache.keys()) {
      if (!expected.has(request.url)) await cache.delete(request);
    }
    for (const name of await caches.keys()) {
      const outdated = name.startsWith('rio-precache-')
        ? name.endsWith(`-${self.registration.scope}`)
        : name.includes('-precache-') && name.includes(self.registration.scope);
      if (name !== cacheName && outdated) await caches.delete(name);
    }
  }

  /**
   * The stored key for a request.  It tries the address as asked, then without marketing
   * parameters, then as a folder's `index.html`, and then with `.html` added.
   */
  function precacheKey(address) {
    const url = new URL(address);
    url.hash = '';
    const candidates = [url.href];
    for (const name of [...url.searchParams.keys()]) {
      if (ignoredParameters.some((pattern) => pattern.test(name))) url.searchParams.delete(name);
    }
    candidates.push(url.href);
    if (url.pathname.endsWith('/')) {
      const index = new URL(url.href);
      index.pathname += 'index.html';
      candidates.push(index.href);
    }
    const page = new URL(url.href);
    page.pathname += '.html';
    candidates.push(page.href);
    for (const candidate of candidates) {
      const entry = precached.get(candidate);
      if (entry) return entry.key;
    }
    return null;
  }

  /** A precached file answers from the cache, and from the network if the cache lost it. */
  async function fromPrecache(request, key) {
    const stored = key ? await (await caches.open(cacheName)).match(key) : undefined;
    return stored || self.fetch(request);
  }

  /** Whether a navigation may receive the precached app page. */
  function fallsBack(request) {
    if (request.mode !== 'navigate') return false;
    const url = new URL(request.url);
    return !navigationDenylist.some((pattern) => pattern.test(url.pathname + url.search));
  }

  // The first install must protect the page already open when the connection drops, so a new
  // worker activates at once and claims open pages.  Pages still choose when to load new code:
  // `src/pwa.ts` offers the update and reloads only when a person accepts it.
  self.skipWaiting();
  self.addEventListener('install', (event) => {
    event.waitUntil(install());
  });
  self.addEventListener('activate', (event) => {
    event.waitUntil(activate());
  });
  self.addEventListener('activate', () => {
    self.clients.claim();
  });
  self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET' || !request.url.startsWith('http')) return;
    const key = precacheKey(request.url);
    if (key) {
      event.respondWith(fromPrecache(request, key));
      return;
    }
    if (!fallsBack(request)) return;
    const fallback = new URL(navigationFallback, self.location.href).href;
    event.respondWith(fromPrecache(new Request(fallback), precached.get(fallback)?.key));
  });
})();
