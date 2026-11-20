// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/notification-worker.js', import.meta.url), 'utf8');
function worker(stored = new Map<string, Map<string, Response>>(), buildFiles = ['assets/entry-current.js']) {
  const listeners = new Map<string, (event: unknown) => void>();
  const origin = new URL('https://example.test').origin;
  const showNotification = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  const navigate = vi.fn(async () => ({ focus }));
  const openWindow = vi.fn(async () => undefined);
  const fetch = vi.fn(
    async (url: string | Request) =>
      new Response('asset', {
        headers: {
          'content-type': String(typeof url === 'string' ? url : url.url).endsWith('.css')
            ? 'text/css'
            : String(url).endsWith('.json')
              ? 'application/json'
              : String(url).endsWith('.woff2')
                ? 'font/woff2'
                : 'text/javascript',
        },
      }),
  );
  const address = (url: string | Request) => (typeof url === 'string' ? url : url.url);
  const write = vi.fn(async () => {});
  const caches = {
    match: async () => new Response('cached shell', { headers: { 'content-type': 'text/html' } }),
    keys: async () => [...stored.keys()],
    open: async (name: string) => {
      let cache = stored.get(name);
      if (!cache) stored.set(name, (cache = new Map()));
      return {
        match: async (url: string | Request) => cache.get(address(url)),
        keys: async () => [...cache.keys()].map((url) => new Request(url)),
        delete: async (url: string | Request) => cache.delete(address(url)),
        put: async (url: string, response: Response) => {
          await write();
          cache.set(address(url), response);
        },
      };
    },
  };
  const clients = [
    {
      id: 'one',
      type: 'window',
      url: `${origin}/screen?draft=1`,
      navigate,
      postMessage: (_message: unknown, ports: Array<{ reply: () => void }>) => ports[0]!.reply(),
    },
    { id: 'two', type: 'window', url: `${origin}/`, navigate: vi.fn(), postMessage: vi.fn() },
  ];
  class MessageChannel {
    port1 = { onmessage: (_event: unknown) => {}, close: vi.fn() };
    port2 = { reply: (data: unknown = { handled: false }) => this.port1.onmessage({ data }) };
  }
  const self = {
    rioBuildFiles: buildFiles,
    skipWaiting: vi.fn(async () => undefined),
    location: { origin },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
    registration: { showNotification },
    clients: {
      get: async (id: string) => clients.find((client) => client.id === id),
      matchAll: async () => [{ url: `${origin}/`, navigate }],
      openWindow,
    },
  };
  const rules = runInNewContext(
    source +
      '\n({ valid: rioValid, purge: rioPurge, repair: rioRepair, asset: rioAsset, put: rioPut, precacheFetch: self.fetch });',
    { self, URL, caches, fetch, Request, Response, Headers, MessageChannel, setTimeout, clearTimeout, Date },
  );
  return {
    listeners,
    origin,
    showNotification,
    focus,
    navigate,
    openWindow,
    stored,
    fetch,
    rules,
    clients,
    write,
    skipWaiting: self.skipWaiting,
  };
}

describe('notification service worker', () => {
  it('checks the page entry against its own build instead of retained runtime assets', () => {
    const w = worker(
      new Map([
        ['rio-app-assets', new Map([['https://example.test/assets/entry-old.js', new Response('old')]])],
      ]),
    );
    const reply = vi.fn();
    for (const entry of [
      `${w.origin}/assets/entry-current.js`,
      `${w.origin}/assets/entry-old.js`,
      'https://other.test/assets/entry-current.js',
      'invalid',
    ]) {
      w.listeners.get('message')!({
        data: { type: 'check-page-build', entry },
        ports: [{ postMessage: reply }],
      });
    }
    expect(reply.mock.calls).toEqual([[{ current: true }], [{ current: false }], [{ current: false }]]);
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it('honors takeover messages from an older app or the server recovery module', async () => {
    const w = worker();
    let pending: Promise<unknown> | undefined;
    w.listeners.get('message')!({
      data: { type: 'SKIP_WAITING' },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(w.skipWaiting).toHaveBeenCalledTimes(1);
  });
  it('keeps already loaded theme files for a first offline reload without caching API responses', async () => {
    const w = worker();
    let pending: Promise<unknown> | undefined;
    const assets = [
      `${w.origin}/assets/catalog.js`,
      `${w.origin}/themes/nature/theme.css`,
      `${w.origin}/themes/nature/theme.json`,
      `${w.origin}/themes/nature/fonts/body.woff2`,
      `${w.origin}/api/auth/session`,
      'https://example.org/themes/nature/theme.css',
    ];
    w.listeners.get('message')!({
      data: { type: 'cache-loaded-assets', assets },
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    expect(w.stored.get('rio-app-assets')?.has(assets[0]!)).toBe(true);
    expect(w.stored.get('rio-theme-styles')?.has(assets[1]!)).toBe(true);
    expect(w.stored.get('rio-theme-styles')?.has(assets[2]!)).toBe(true);
    expect(w.stored.get('rio-theme-assets')?.has(assets[3]!)).toBe(true);
    expect(w.fetch).toHaveBeenCalledTimes(4);
  });

  it('shows a silent notification and opens its same-origin deep link', async () => {
    const w = worker();
    let pending: Promise<unknown> | undefined;
    const waitUntil = (promise: Promise<unknown>) => {
      pending = promise;
    };
    const payload = {
      title: 'Notification',
      body: 'Unread',
      url: `${w.origin}/settings/notifications#digest`,
    };
    w.listeners.get('push')!({ data: { json: () => payload }, waitUntil });
    await pending;
    expect(w.showNotification).toHaveBeenCalledWith(payload.title, {
      body: payload.body,
      data: { url: payload.url },
      silent: true,
    });
    const close = vi.fn();
    w.listeners.get('notificationclick')!({ notification: { data: { url: payload.url }, close }, waitUntil });
    await pending;
    expect(close).toHaveBeenCalled();
    expect(w.navigate).toHaveBeenCalledWith(payload.url);
    expect(w.focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });
  it('ignores malformed payloads and links outside the installation', () => {
    const w = worker();
    const waitUntil = vi.fn();
    for (const payload of [null, {}, { title: 'Notification', body: 'Unread', url: 'https://example.org/' }])
      w.listeners.get('push')!({ data: { json: () => payload }, waitUntil });
    expect(waitUntil).not.toHaveBeenCalled();
    expect(w.showNotification).not.toHaveBeenCalled();
  });
});

describe('navigation fallback', () => {
  async function navigation(w: ReturnType<typeof worker>) {
    let answer!: Promise<Response>;
    w.listeners.get('fetch')!({
      request: { url: `${w.origin}/screen`, method: 'GET', mode: 'navigate' },
      stopImmediatePropagation: vi.fn(),
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    });
    return answer;
  }
  it('uses the current shell when the network answers promptly', async () => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response('current shell'));
    expect(await (await navigation(w)).text()).toBe('current shell');
  });
  it('uses the cached shell after three seconds without a network answer', async () => {
    vi.useFakeTimers();
    try {
      const w = worker();
      w.fetch.mockImplementation(() => new Promise(() => {}));
      const answer = navigation(w);
      let settled = false;
      void answer.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await (await answer).text()).toBe('cached shell');
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([502, 503])('uses the cached shell for status %s', async (status) => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response('proxy error', { status }));
    expect(await (await navigation(w)).text()).toBe('cached shell');
  });
  it('uses the cached shell after an offline rejection', async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError('offline'));
    expect(await (await navigation(w)).text()).toBe('cached shell');
  });
});

it('keeps differently labeled theme assets and leaves optional theme 404s as ordinary responses', async () => {
  const w = worker();
  for (const [file, type] of [
    ['body.ttf', 'font/sfnt'],
    ['body.otf', 'application/vnd.ms-fontobject'],
    ['icon.ico', 'image/x-icon'],
    ['icon.ico', 'image/vnd.microsoft.icon'],
  ])
    expect(
      w.rules.valid(
        `${w.origin}/themes/${file}`,
        new Response('asset', {
          headers: { 'content-type': type! },
        }),
      ),
    ).toBe(true);
  expect(
    w.rules.valid(
      `${w.origin}/themes/unknown.bin`,
      new Response('<html>', {
        headers: { 'content-type': 'text/html' },
      }),
    ),
  ).toBe(false);
  w.fetch.mockResolvedValue(new Response('optional asset', { status: 404 }));
  expect((await w.rules.precacheFetch(`${w.origin}/themes/optional.ttf`)).status).toBe(404);
});

describe('build asset recovery', () => {
  it.each(['/assets/chunk.js', '/themes/test/body.woff2', '/themes/test/theme.css'])(
    'retries a transient network failure for %s without repairing the page',
    async (file) => {
      const w = worker();
      w.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      let answer!: Promise<Response>;
      const pending: Promise<unknown>[] = [];
      w.listeners.get('fetch')!({
        request: new Request(w.origin + file),
        clientId: 'one',
        stopImmediatePropagation: vi.fn(),
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      expect(await (await answer).text()).toBe('asset');
      await Promise.all(pending);
      expect(w.fetch).toHaveBeenCalledTimes(2);
      expect(w.navigate).not.toHaveBeenCalled();
    },
  );

  it('bounds network retries when an asset stays unavailable', async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      w.rules.asset(
        { request: new Request(`${w.origin}/assets/chunk.js`), clientId: '', waitUntil: vi.fn() },
        'rio-app-assets',
        800,
      ),
    ).rejects.toThrow('Failed to fetch');
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry an asset request canceled by navigation', async () => {
    const w = worker();
    const controller = new AbortController();
    const request = new Request(`${w.origin}/assets/chunk.js`, { signal: controller.signal });
    w.fetch.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('Navigation canceled the request', 'AbortError');
    });
    await expect(
      w.rules.asset({ request, clientId: '', waitUntil: vi.fn() }, 'rio-app-assets', 800),
    ).rejects.toThrow('Navigation canceled the request');
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not resend a write that failed on the network', async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      w.rules.precacheFetch(`${w.origin}/api/ping`, { method: 'POST', body: 'x' }),
    ).rejects.toThrow('Failed to fetch');
    expect(w.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network failure before the generated precache validates the response', async () => {
    const w = worker();
    w.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await (await w.rules.precacheFetch(`${w.origin}/assets/shell.js`)).text()).toBe('asset');
    expect(w.fetch).toHaveBeenCalledTimes(2);
  });

  it('leaves health requests to the network even when a cache contains a healthy answer', () => {
    const w = worker();
    w.stored.set('rio-app-assets', new Map([[`${w.origin}/healthz`, new Response('{"status":"ok"}')]]));
    const respondWith = vi.fn();
    const stopImmediatePropagation = vi.fn();
    w.listeners.get('fetch')!({
      request: new Request(`${w.origin}/healthz`, { cache: 'no-store' }),
      respondWith,
      stopImmediatePropagation,
    });
    expect(respondWith).not.toHaveBeenCalled();
    expect(stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it.each(['/assets/chunk.js', '/themes/test/body.woff2', '/themes/test/theme.css'])(
    'delivers a valid network response for %s when cache writes fail',
    async (file) => {
      const w = worker();
      w.write.mockRejectedValue(new DOMException('Storage is full', 'QuotaExceededError'));
      let answer!: Promise<Response>;
      w.listeners.get('fetch')!({
        request: new Request(w.origin + file),
        stopImmediatePropagation: vi.fn(),
        waitUntil: vi.fn(),
        respondWith: (response: Promise<Response>) => {
          answer = response;
        },
      });
      expect(await (await answer).text()).toBe('asset');
      expect(w.write).toHaveBeenCalledTimes(1);
    },
  );

  it('repairs only the requesting window once when guard persistence fails', async () => {
    const w = worker();
    w.write.mockRejectedValue(new DOMException('Storage is full', 'QuotaExceededError'));
    await w.rules.repair('one');
    await w.rules.repair('one');
    expect(w.navigate).toHaveBeenCalledTimes(1);
    expect(w.navigate).toHaveBeenCalledWith(w.clients[0]!.url);
    expect(w.clients[1]!.navigate).not.toHaveBeenCalled();
  });

  it('delivers network assets before cache persistence completes', async () => {
    const w = worker();
    let finish!: () => void;
    w.write.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending: Promise<unknown>[] = [];
    let delivered = false;
    const answer = w.rules
      .asset(
        {
          request: new Request(`${w.origin}/assets/chunk.js`),
          clientId: '',
          waitUntil: (write: Promise<unknown>) => pending.push(write),
        },
        'rio-app-assets',
        800,
      )
      .then(() => {
        delivered = true;
      });
    await vi.waitFor(() => expect(w.write).toHaveBeenCalledTimes(1));
    try {
      expect(delivered).toBe(true);
      expect(pending).toHaveLength(1);
    } finally {
      finish();
      await answer;
      await Promise.all(pending);
    }
  });

  it('keeps the previous precached controls available before activation removes old entries', async () => {
    const w = worker();
    const good = `${w.origin}/assets/notice-old.js?__rio_revision=first`;
    const bad = `${w.origin}/assets/bad.js`;
    w.stored.set(
      `rio-precache-v1-${w.origin}/`,
      new Map([
        [good, new Response('notice', { headers: { 'content-type': 'text/javascript' } })],
        [bad, new Response('<html>', { headers: { 'content-type': 'text/html' } })],
      ]),
    );
    let pending: Promise<unknown> | undefined;
    w.listeners.get('install')?.({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    w.stored.get(`rio-precache-v1-${w.origin}/`)!.clear();
    expect(await w.stored.get('rio-app-assets')?.get(`${w.origin}/assets/notice-old.js`)?.text()).toBe(
      'notice',
    );
    expect(w.stored.get('rio-app-assets')?.has(bad)).toBe(false);
  });
  it('validates theme CSS during activation, network fetches, and first-install caching', async () => {
    const w = worker();
    const file = `${w.origin}/themes/test/theme.css`;
    const invalid = () => new Response('{}', { headers: { 'content-type': 'application/json' } });
    w.stored.set('rio-theme-styles', new Map([[file, invalid()]]));
    await w.rules.purge();
    expect(w.stored.get('rio-theme-styles')?.has(file)).toBe(false);
    w.fetch.mockImplementation(async () => invalid());
    let response!: Promise<Response>;
    w.listeners.get('fetch')!({
      request: new Request(file),
      stopImmediatePropagation: vi.fn(),
      waitUntil: vi.fn(),
      respondWith: (answer: Promise<Response>) => {
        response = answer;
      },
    });
    expect((await response).type).toBe('error');
    expect(w.stored.get('rio-theme-styles')?.has(file)).toBe(false);
    let caching!: Promise<unknown>;
    w.listeners.get('message')!({
      data: { type: 'cache-loaded-assets', assets: [file] },
      waitUntil: (pending: Promise<unknown>) => {
        caching = pending;
      },
    });
    await caching;
    expect(w.stored.get('rio-theme-styles')?.has(file)).toBe(false);
  });

  it('honors an app repair remembered by the replacement document before its entry links', async () => {
    const w = worker();
    const stamp = Date.now();
    w.clients[0]!.postMessage = (message: unknown, ports: Array<{ reply: () => void }>) => {
      if ((message as { type: string }).type === 'asset-repair-guard')
        (ports[0] as unknown as { reply: (data: unknown) => void }).reply({ lastAttempt: stamp });
      else ports[0]!.reply();
    };
    await w.rules.repair('one');
    expect(w.navigate).not.toHaveBeenCalled();
    expect(w.clients[1]!.navigate).not.toHaveBeenCalled();
  });
  it('requires success, the matching content type, and no stale header', () => {
    const { rules, origin } = worker();
    const response = (type: string, status = 200, stale = false) =>
      new Response('body', {
        status,
        headers: { 'content-type': type, ...(stale ? { 'x-riosoma-stale-asset': '1' } : {}) },
      });
    expect(rules.valid(`${origin}/assets/chunk.js`, response('text/javascript; charset=utf-8'))).toBe(true);
    expect(rules.valid(`${origin}/assets/chunk.js`, response('application/javascript'))).toBe(true);
    expect(rules.valid(`${origin}/assets/chunk.css`, response('text/css'))).toBe(true);
    for (const invalid of [
      response('text/html'),
      response('text/css'),
      response('text/javascript', 404),
      response('text/javascript', 200, true),
    ])
      expect(rules.valid(`${origin}/assets/chunk.js`, invalid)).toBe(false);
    expect(rules.valid(`${origin}/assets/chunk.css`, response('text/javascript'))).toBe(false);
  });

  it('purges poisoned entries on activation, including theme styles and the precache', async () => {
    const w = worker();
    for (const name of ['rio-app-assets', 'rio-theme-styles', `rio-precache-v1-${w.origin}/`]) {
      w.stored.set(
        name,
        new Map([
          [`${w.origin}/assets/bad.js`, new Response('<html>', { headers: { 'content-type': 'text/html' } })],
          [`${w.origin}/themes/bad.css`, new Response('gone', { status: 404 })],
          [
            `${w.origin}/assets/good.js`,
            new Response('export default 1', { headers: { 'content-type': 'text/javascript' } }),
          ],
        ]),
      );
    }
    let pending: Promise<unknown> | undefined;
    w.listeners.get('activate')!({
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
    });
    await pending;
    for (const entries of w.stored.values())
      expect([...entries.keys()]).toEqual([`${w.origin}/assets/good.js`]);
  });

  it('leaves valid precache responses unstamped while stamping runtime assets', async () => {
    const w = worker();
    const precache = `rio-precache-v1-${w.origin}/`;
    const asset = `${w.origin}/assets/good.js`;
    for (const name of [precache, 'rio-app-assets'])
      w.stored.set(
        name,
        new Map([[asset, new Response('asset', { headers: { 'content-type': 'text/javascript' } })]]),
      );
    await w.rules.purge();
    expect(w.stored.get(precache)!.get(asset)!.headers.has('x-rio-cached-at')).toBe(false);
    expect(w.stored.get('rio-app-assets')!.get(asset)!.headers.has('x-rio-cached-at')).toBe(true);
  });

  it('repairs only the requesting window once per 30 seconds, even across a worker restart', async () => {
    const w = worker();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      await Promise.all([w.rules.repair('one'), w.rules.repair('one')]);
      expect(w.navigate).toHaveBeenCalledTimes(1);
      expect(w.navigate).toHaveBeenCalledWith(w.clients[0]!.url);
      expect(w.clients[1]!.navigate).not.toHaveBeenCalled();
      const restarted = worker(w.stored);
      await restarted.rules.repair('one');
      expect(restarted.navigate).not.toHaveBeenCalled();
      clock.mockReturnValue(130_001);
      await restarted.rules.repair('one');
      expect(restarted.navigate).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('rejects stale network modules and first-install HTML without storing either', async () => {
    const w = worker();
    w.fetch.mockResolvedValue(
      new Response('fallback', {
        headers: { 'content-type': 'text/javascript', 'x-riosoma-stale-asset': '1' },
      }),
    );
    let repair: Promise<unknown> | undefined;
    const response = await w.rules.asset(
      {
        request: new Request(`${w.origin}/assets/gone.js`),
        clientId: 'one',
        waitUntil: (promise: Promise<unknown>) => {
          repair = promise;
        },
      },
      'rio-app-assets',
      800,
    );
    expect(response.type).toBe('error');
    await repair;
    expect(w.stored.get('rio-app-assets')?.size).toBe(0);
    w.fetch.mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    w.listeners.get('message')!({
      data: { type: 'cache-loaded-assets', assets: [`${w.origin}/assets/poison.js`] },
      waitUntil: (promise: Promise<unknown>) => {
        repair = promise;
      },
    });
    await repair;
    expect(w.stored.get('rio-app-assets')?.size).toBe(0);
  });
});

it('preserves the runtime cache limits and expires build files after 30 days', async () => {
  const w = worker();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    w.stored.set('rio-app-assets', new Map());
    const request = new Request(`${w.origin}/assets/chunk.js`);
    await w.rules.asset({ request, clientId: '', waitUntil: vi.fn() }, 'rio-app-assets', 800);
    w.fetch.mockClear();
    await w.rules.asset({ request, clientId: '', waitUntil: vi.fn() }, 'rio-app-assets', 800);
    expect(w.fetch).not.toHaveBeenCalled();
    clock.mockReturnValue(100_000 + 31 * 24 * 60 * 60 * 1_000);
    await w.rules.asset({ request, clientId: '', waitUntil: vi.fn() }, 'rio-app-assets', 800);
    expect(w.fetch).toHaveBeenCalledTimes(1);
    for (const [name, limit] of [
      ['rio-app-assets', 800],
      ['rio-theme-assets', 400],
    ] as const) {
      const entries = new Map(
        Array.from({ length: limit }, (_, index) => [
          `${w.origin}/assets/file-${index}.js`,
          new Response('code', { headers: { 'content-type': 'text/javascript' } }),
        ]),
      );
      w.stored.set(name, entries);
      const cache = {
        put: async (url: string, response: Response) => {
          entries.set(url, response);
        },
        keys: async () => [...entries.keys()],
        delete: async (url: string) => entries.delete(url),
      };
      await w.rules.put(
        cache,
        `${w.origin}/assets/new.js`,
        new Response('code', { headers: { 'content-type': 'text/javascript' } }),
        limit,
      );
      expect(entries.size).toBe(limit);
      expect(entries.has(`${w.origin}/assets/file-0.js`)).toBe(false);
      expect(entries.has(`${w.origin}/assets/new.js`)).toBe(true);
    }
  } finally {
    clock.mockRestore();
  }
});

it('rejects invalid answers before the generated precache can store them', async () => {
  const w = worker();
  for (const response of [
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response('export default undefined', {
      headers: { 'content-type': 'text/javascript', 'x-riosoma-stale-asset': '1' },
    }),
    new Response('gone', { status: 404 }),
  ]) {
    w.fetch.mockResolvedValue(response);
    await expect(w.rules.precacheFetch(`${w.origin}/assets/shell.js`)).rejects.toThrow(
      'assets.invalidResponse',
    );
  }
  expect(w.stored.size).toBe(0);
});
