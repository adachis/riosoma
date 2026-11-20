// This script runs before the generated routes, so validation also covers precached build files.
const rioRetryMs = 30_000;
const rioRepairs = new Map();
function rioValid(url, response) {
  if (!response?.ok || response.headers.has('x-riosoma-stale-asset')) return false;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const path = new URL(typeof url === 'string' ? url : url.url, self.location.origin).pathname;
  if (/\.css$/.test(path)) return type === 'text/css';
  if (path.startsWith('/assets/')) {
    if (/\.m?js$/.test(path))
      return /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(type);
  }
  return type !== 'text/html' || path.endsWith('.html');
}
// Generated precache requests do not dispatch a fetch event.  Validate their network answers too.
const rioNetworkFetch = fetch.bind(self);
async function rioFetchAsset(input, init) {
  try {
    return await rioNetworkFetch(input, init);
  } catch (error) {
    // Only a read is safe to send twice, and a canceled request stays canceled.
    const method = (init?.method ?? input?.method ?? 'GET').toUpperCase();
    if ((init?.signal ?? input?.signal)?.aborted || (method !== 'GET' && method !== 'HEAD')) throw error;
    // A network change can abort a healthy asset fetch.  Retry once before failing the module
    // graph and forcing an interactive page to reload, losing its open panels and drafts.
    return rioNetworkFetch(input, init);
  }
}
self.fetch = async (input, init) => {
  const response = await rioFetchAsset(input, init);
  const url = new URL(typeof input === 'string' ? input : input.url, self.location.origin);
  if (url.pathname.startsWith('/assets/') && !rioValid(url.href, response))
    throw new TypeError('assets.invalidResponse');
  return response;
};
async function rioPut(cache, url, response, limit) {
  if (!cache || !rioValid(url, response)) return;
  try {
    const headers = new Headers(response.headers);
    headers.set('x-rio-cached-at', String(Date.now()));
    await cache.put(
      url,
      new Response(response.body, { status: response.status, statusText: response.statusText, headers }),
    );
    if (limit) {
      const keys = await cache.keys();
      await Promise.all(keys.slice(0, Math.max(0, keys.length - limit)).map((key) => cache.delete(key)));
    }
  } catch {
    // Persistence is optional.  A full cache must not block a working asset or a repair.
  }
}
async function rioPurge() {
  for (const name of await caches.keys()) {
    if (!name.startsWith('rio-') && !name.includes('precache')) continue;
    const cache = await caches.open(name);
    for (const key of await cache.keys()) {
      const response = await cache.match(key);
      if (name === 'rio-asset-repairs') {
        if (Date.now() - Number(response?.headers.get('x-rio-cached-at')) >= rioRetryMs)
          await cache.delete(key);
      } else if (!rioValid(key, response)) await cache.delete(key);
      else if (
        name !== 'rio-asset-repairs' &&
        name.startsWith('rio-') &&
        !name.startsWith('rio-precache-') &&
        !response.headers.has('x-rio-cached-at')
      )
        await rioPut(cache, key, response);
    }
  }
}
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const runtime = await caches.open('rio-app-assets');
      // Activation removes old precache entries.  Open pages still need their version's update controls.
      for (const name of await caches.keys()) {
        if (!name.includes('precache')) continue;
        const cache = await caches.open(name);
        for (const key of await cache.keys()) {
          const url = new URL(key.url);
          if (url.origin !== self.location.origin || !/^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname))
            continue;
          await rioPut(runtime, url.origin + url.pathname, await cache.match(key), 800);
        }
      }
    })(),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(rioPurge());
});
async function rioAsk(client, message) {
  const channel = new MessageChannel();
  const reply = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 1_500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data);
    };
    client.postMessage(message, [channel.port2]);
  });
  channel.port1.close();
  return reply;
}
async function rioRepair(clientId) {
  if (!clientId) return;
  for (const [id, stamp] of rioRepairs) if (Date.now() - stamp >= rioRetryMs) rioRepairs.delete(id);
  const repairs = await caches.open('rio-asset-repairs').catch(() => null);
  const address = (id) => new URL('/__asset-repair/' + encodeURIComponent(id), self.location.origin).href;
  const saved = await repairs?.match(address(clientId)).catch(() => undefined);
  const last = Math.max(rioRepairs.get(clientId) || 0, Number(saved?.headers.get('x-rio-cached-at')) || 0);
  if (Date.now() - last < rioRetryMs) return;
  rioRepairs.set(clientId, Date.now());
  await rioPut(repairs, address(clientId), new Response(''));
  const client = await self.clients.get(clientId);
  if (!client || client.type !== 'window') return;
  // A reload changes the client ID.  The plain startup script retains the tab's app repair guard.
  const guard = await rioAsk(client, { type: 'asset-repair-guard' });
  if (Date.now() - (Number(guard?.lastAttempt) || 0) < rioRetryMs) return;
  const handled = await rioAsk(client, { type: 'repair-stale-assets' });
  if (handled?.handled === true || handled?.deferred === true) return;
  const started = await rioAsk(client, { type: 'asset-repair-guard', start: true });
  if (started?.started === false) return;
  // A page whose module graph never linked has no app listener.  Navigate only that window.
  const navigated = await client.navigate(client.url);
  if (navigated) {
    rioRepairs.set(navigated.id, Date.now());
    await rioPut(repairs, address(navigated.id), new Response(''));
  }
}
async function rioAsset(event, name, limit) {
  const request = event.request;
  const cache = await caches.open(name);
  const stored = await cache.match(request);
  if (stored) {
    const stamp = Number(stored.headers.get('x-rio-cached-at'));
    if (rioValid(request, stored) && (!stamp || Date.now() - stamp < 30 * 24 * 60 * 60 * 1_000))
      return stored;
    await cache.delete(request);
  }
  // Common shell files still have a precached offline copy, even if the runtime cache was trimmed.
  for (const cacheName of await caches.keys()) {
    if (!cacheName.includes('precache')) continue;
    const common = await (await caches.open(cacheName)).match(request, { ignoreSearch: true });
    if (rioValid(request, common)) return common;
  }
  const response = await rioFetchAsset(request);
  if (rioValid(request, response)) {
    event.waitUntil(rioPut(cache, request, response.clone(), limit));
    return response;
  }
  if (new URL(request.url).pathname.startsWith('/assets/')) {
    event.waitUntil(rioRepair(event.clientId));
    // Never execute the server's recovery module in parallel with this window's shared recovery.
    return Response.error();
  }
  return response;
}
async function rioNavigation(request) {
  let timer;
  try {
    const response = await Promise.race([
      rioNetworkFetch(request, { cache: 'no-store' }).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), 3_000);
      }),
    ]);
    if (response && response.status < 500) return response;
    return (await caches.match('/index.html', { ignoreSearch: true })) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;
  const build = /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname);
  const theme = url.pathname.startsWith('/themes/');
  const navigation =
    event.request.mode === 'navigate' && !/^\/(?:sites|api|themes|healthz|readyz)(?:\/|$)/.test(url.pathname);
  if (!build && !theme && !navigation) return;
  event.stopImmediatePropagation();
  if (navigation) {
    // Network first makes a plain reload use the current deployment instead of an older shell.
    // A slow connection or a restarting server still gets the precached app within three seconds.
    event.respondWith(rioNavigation(event.request));
    return;
  }
  const styles = theme && /\.(?:css|json)$/.test(url.pathname);
  const name = build ? 'rio-app-assets' : styles ? 'rio-theme-styles' : 'rio-theme-assets';
  if (styles) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(name);
        const stored = await cache.match(event.request);
        const refresh = rioFetchAsset(event.request).then(async (response) => {
          event.waitUntil(rioPut(cache, event.request, response.clone()));
          return /\.css$/.test(url.pathname) && !rioValid(event.request, response)
            ? Response.error()
            : response;
        });
        if (rioValid(event.request, stored)) {
          event.waitUntil(refresh.catch(() => undefined));
          return stored;
        }
        if (stored) await cache.delete(event.request);
        return refresh;
      })(),
    );
  } else event.respondWith(rioAsset(event, name, build ? 800 : 400));
});
/* Push messages contain only localized summaries and links within this installation. */
// Only assets already requested by this client join the runtime cache during a first install.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'check-page-build') {
    let entry;
    try {
      entry = new URL(event.data.entry);
    } catch {
      return;
    }
    // The build supplies this worker's precache list.  Shared caches can also contain older files.
    if (!Array.isArray(self.rioBuildFiles)) return;
    event.ports[0]?.postMessage({
      current: entry.origin === self.location.origin && self.rioBuildFiles.includes(entry.pathname.slice(1)),
    });
    return;
  }
  // Older pages and the server's recovery module can still encounter the brief installed state.
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  if (event.data?.type !== 'cache-loaded-assets' || !Array.isArray(event.data.assets)) return;
  const assets = event.data.assets.slice(0, 200).flatMap((name) => {
    if (typeof name !== 'string') return [];
    let url;
    try {
      url = new URL(name);
    } catch {
      return [];
    }
    if (url.origin !== self.location.origin || url.username || url.password) return [];
    const cache = /^\/assets\/[^/]+\.(?:js|css)$/.test(url.pathname)
      ? 'rio-app-assets'
      : url.pathname.startsWith('/themes/')
        ? /\.(?:css|json)$/.test(url.pathname)
          ? 'rio-theme-styles'
          : 'rio-theme-assets'
        : null;
    return cache ? [{ url: url.href, cache }] : [];
  });
  event.waitUntil(
    (async () => {
      await Promise.allSettled(
        [...new Map(assets.map((asset) => [asset.url, asset])).values()].map(async ({ url, cache: name }) => {
          const cache = await caches.open(name);
          const stored = await cache.match(url);
          if (rioValid(url, stored)) return;
          if (stored) await cache.delete(url);
          const response = await rioFetchAsset(url, { cache: 'force-cache' });
          await rioPut(
            cache,
            url,
            response,
            name === 'rio-app-assets' ? 800 : name === 'rio-theme-assets' ? 400 : undefined,
          );
        }),
      );
    })(),
  );
});
self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (
    !payload ||
    typeof payload.title !== 'string' ||
    typeof payload.body !== 'string' ||
    typeof payload.url !== 'string'
  )
    return;
  let url;
  try {
    url = new URL(payload.url, self.location.origin);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin || url.username || url.password) return;
  event.waitUntil(
    self.registration.showNotification(payload.title.slice(0, 100), {
      body: payload.body.slice(0, 200),
      data: { url: url.href },
      silent: true,
    }),
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url;
  try {
    url = new URL(event.notification.data?.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin || url.username || url.password) return;
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if (new URL(client.url).origin !== url.origin) continue;
        const navigated = await client.navigate(url.href);
        if (navigated) {
          await navigated.focus();
          return;
        }
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
