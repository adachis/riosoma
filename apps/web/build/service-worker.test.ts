// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  linkManifest,
  listFiles,
  revisioned,
  selectPrecache,
  workerScript,
  type PrecacheEntry,
} from './service-worker';
import { measureShell, precacheFiles, type Manifest } from './shell-budget';

const runtime = readFileSync(resolve(import.meta.dirname, 'service-worker-runtime.js'), 'utf8');
const origin = 'https://example.test';
const cacheName = `rio-precache-v1-${origin}/`;
const denylist = [/^\/sites(?:\/|$)/, /^\/api\//, /^\/themes\//, /^\/healthz/, /^\/readyz/];
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('precache list', () => {
  const files = [
    'index.html',
    'boot.js',
    'layers.css',
    'pressable.css',
    // Still copied from public/, but the shell runs it inline, so it is never precached.
    'startup-recovery.js',
    'startup-recovery.css',
    'notification-worker.js',
    'manifest.webmanifest',
    'bundle-report.json',
    'assets/index-a.js',
    'assets/index-a.js.map',
    'assets/index-b.css',
    'assets/ToastRegion-c.js',
    'assets/messages-fr-d.js',
    'assets/Chart-e.js',
    'assets/fonts/body-f.css',
    'icons/icon.svg',
    'icons/icon-192.png',
    'icons/notes.txt',
    'brand/riosoma-wordmark-mask.svg',
    'brand/other.svg',
    'pdf-renderer/worker.js',
  ];
  const common = new Set([
    'index.html',
    'boot.js',
    'layers.css',
    'pressable.css',
    'startup-recovery.css',
    'assets/index-a.js',
    'assets/index-b.css',
    'assets/ToastRegion-c.js',
    'brand/riosoma-wordmark-mask.svg',
    // A measured file outside the candidate folders is still left out.
    'pdf-renderer/worker.js',
  ]);

  it('keeps the measured shell, recovery files, and every icon, and leaves locales and features out', () => {
    expect(selectPrecache(files, common)).toEqual([
      'index.html',
      'boot.js',
      'layers.css',
      'pressable.css',
      'startup-recovery.css',
      'assets/index-a.js',
      'assets/index-b.css',
      'assets/ToastRegion-c.js',
      'icons/icon.svg',
      'icons/icon-192.png',
      'brand/riosoma-wordmark-mask.svg',
    ]);
  });

  it('lists nested files with forward slashes in a stable order', () => {
    const directory = mkdtempSync(join(tmpdir(), 'service-worker-'));
    try {
      mkdirSync(join(directory, 'assets', 'fonts'), { recursive: true });
      for (const file of ['index.html', 'assets/b.js', 'assets/a.js', 'assets/fonts/c.css'])
        writeFileSync(join(directory, file), file);
      expect(listFiles(directory)).toEqual([
        'assets/a.js',
        'assets/b.js',
        'assets/fonts/c.css',
        'index.html',
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const output = resolve(import.meta.dirname, '../dist');
  it('writes the measured shell, recovery files, icons, and manifest into the built worker', () => {
    const built = JSON.parse(readFileSync(resolve(output, '.vite/manifest.json'), 'utf8')) as Manifest;
    const shell = measureShell(built, (file) => readFileSync(resolve(output, file)));
    const expected = selectPrecache(listFiles(output), new Set(precacheFiles(built, shell)));
    const worker = readFileSync(resolve(output, 'sw.js'), 'utf8');
    const entries = [...worker.matchAll(/\{url:("[^"]+"),revision:(null|"[0-9a-f]{32}")\}/g)].map(
      (match) => JSON.parse(match[1]!) as string,
    );
    expect(entries).toEqual([...expected, 'manifest.webmanifest']);
    expect(entries).toContain('index.html');
    expect(entries.some((file) => file.startsWith('icons/'))).toBe(true);
    // The listener's build list names the same files, without the manifest.
    const listener = readFileSync(resolve(output, 'notification-worker.js'), 'utf8');
    expect(JSON.parse(listener.match(/self\.rioBuildFiles = (\[.*\]);/)![1]!)).toEqual(expected);
    expect(worker).not.toContain('importScripts(');
    expect(worker).toContain(listener.trim());
    expect(worker.indexOf(listener.trim())).toBeGreaterThanOrEqual(0);
    expect(worker.indexOf(listener.trim())).toBeLessThan(worker.indexOf('self.rioWorker'));
    const page = readFileSync(resolve(output, 'index.html'), 'utf8');
    expect(page.match(/<link rel="manifest" href="\/manifest\.webmanifest">/g)).toHaveLength(1);
  });
});

describe('revisions', () => {
  it('keys hashed assets by name and every other file by its contents', () => {
    const contents = new Map([
      ['index.html', '<html>one</html>'],
      ['assets/index-a.js', 'code'],
      ['icons/icon.svg', '<svg/>'],
    ]);
    const read = (file: string) => Buffer.from(contents.get(file)!);
    const entries = revisioned(['index.html', 'assets/index-a.js', 'icons/icon.svg', 'index.html'], read);
    expect(entries).toEqual([
      { url: 'index.html', revision: md5('<html>one</html>') },
      { url: 'assets/index-a.js', revision: null },
      { url: 'icons/icon.svg', revision: md5('<svg/>') },
    ]);
    contents.set('index.html', '<html>two</html>');
    const next = revisioned(['index.html', 'icons/icon.svg'], read);
    expect(next[0]!.revision).not.toBe(entries[0]!.revision);
    expect(next[1]!.revision).toBe(entries[2]!.revision);
  });

  it('writes each entry as a plain literal that names its file and revision', () => {
    const script = workerScript(
      {
        importScripts: ['/notification-worker.js'],
        precache: [
          { url: 'index.html', revision: 'abc' },
          { url: 'assets/a.js', revision: null },
        ],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: denylist,
      },
      '/* runtime */',
      () => '/* listener */',
    );
    expect(script).toContain('{url:"index.html",revision:"abc"},{url:"assets/a.js",revision:null}');
    expect(script).toContain(
      String.raw`[/^\/sites(?:\/|$)/, /^\/api\//, /^\/themes\//, /^\/healthz/, /^\/readyz/]`,
    );
    expect(script.trimEnd().endsWith('/* runtime */')).toBe(true);
  });

  it('links the manifest once, at the end of the page head', () => {
    expect(linkManifest('<html><head><title>x</title></head><body></body></html>')).toBe(
      '<html><head><title>x</title><link rel="manifest" href="/manifest.webmanifest"></head><body></body></html>',
    );
  });
});

type Listener = (event: Record<string, unknown>) => void;

/** Runs the worker source against in-memory caches and a stubbed network. */
function worker(
  precache: PrecacheEntry[],
  stored = new Map<string, Map<string, Response>>(),
  scope = `${origin}/`,
) {
  const listeners = new Map<string, Listener[]>();
  const address = (url: string | Request) => (typeof url === 'string' ? url : url.url);
  const network = new Map<string, () => Response>();
  const fetch = vi.fn(async (input: string | Request) => {
    const url = new URL(address(input), origin);
    url.search = '';
    const answer = network.get(url.pathname);
    return answer ? answer() : new Response('missing', { status: 404 });
  });
  const open = async (name: string) => {
    let cache = stored.get(name);
    if (!cache) stored.set(name, (cache = new Map()));
    return {
      // A real cache answers each match with a fresh copy.
      match: async (url: string | Request) => cache.get(address(url))?.clone(),
      keys: async () => [...cache.keys()].map((url) => new Request(url)),
      delete: async (url: string | Request) => cache.delete(address(url)),
      put: async (url: string | Request, response: Response) => {
        cache.set(address(url), response);
      },
    };
  };
  const caches = {
    open,
    keys: async () => [...stored.keys()],
    delete: async (name: string) => stored.delete(name),
  };
  const self = {
    registration: { scope },
    location: { href: `${scope}sw.js`, origin },
    fetch,
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    addEventListener: (name: string, listener: Listener) =>
      listeners.set(name, [...(listeners.get(name) ?? []), listener]),
  };
  const script = workerScript(
    {
      importScripts: [],
      precache,
      navigateFallback: '/index.html',
      navigateFallbackDenylist: denylist,
    },
    runtime,
    () => {
      throw new Error('No listener imports expected');
    },
  );
  runInNewContext(script, { self, caches, URL, Request, Response });

  async function lifecycle(name: 'install' | 'activate') {
    const pending: Promise<unknown>[] = [];
    for (const listener of listeners.get(name) ?? [])
      listener({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  /** The response the worker gives, or null when it leaves the request to the browser. */
  async function request(path: string, init: { mode?: string; method?: string } = {}) {
    let answer = null as Promise<Response> | null;
    const event = {
      request: {
        url: new URL(path, origin).href,
        method: init.method ?? 'GET',
        mode: init.mode ?? 'cors',
      },
      respondWith: (response: Promise<Response>) => {
        answer = response;
      },
    };
    for (const listener of listeners.get('fetch') ?? []) listener(event);
    return answer;
  }
  return { self, fetch, network, stored, lifecycle, request };
}

const shell: PrecacheEntry[] = [
  { url: 'index.html', revision: 'one' },
  { url: 'boot.js', revision: 'two' },
  { url: 'assets/index-a.js', revision: null },
];
const answer = (body: string, type: string) => () =>
  new Response(body, { headers: { 'content-type': type } });

function served(precache = shell) {
  const w = worker(precache);
  w.network.set('/index.html', answer('app page', 'text/html'));
  w.network.set('/boot.js', answer('boot', 'text/javascript'));
  w.network.set('/assets/index-a.js', answer('entry', 'text/javascript'));
  return w;
}

describe('service worker runtime', () => {
  it('takes over at once and claims open pages when it activates', async () => {
    const w = served();
    expect(w.self.skipWaiting).toHaveBeenCalledTimes(1);
    await w.lifecycle('install');
    expect(w.self.clients.claim).not.toHaveBeenCalled();
    await w.lifecycle('activate');
    expect(w.self.clients.claim).toHaveBeenCalledTimes(1);
  });

  it('stores revisioned files under their revision and fetches them past the browser cache', async () => {
    const w = served();
    await w.lifecycle('install');
    const cache = w.stored.get(cacheName)!;
    expect([...cache.keys()].sort()).toEqual([
      `${origin}/assets/index-a.js`,
      `${origin}/boot.js?__rio_revision=two`,
      `${origin}/index.html?__rio_revision=one`,
    ]);
    const modes = Object.fromEntries(
      w.fetch.mock.calls.map(([request]) => [(request as Request).url, (request as Request).cache]),
    );
    expect(modes).toEqual({
      [`${origin}/index.html`]: 'reload',
      [`${origin}/boot.js`]: 'reload',
      [`${origin}/assets/index-a.js`]: 'default',
    });
  });

  it('downloads only files whose revision changed in a new build', async () => {
    const w = served();
    await w.lifecycle('install');
    const next = served([{ url: 'index.html', revision: 'three' }, ...shell.slice(1)]);
    for (const [name, cache] of w.stored) next.stored.set(name, cache);
    await next.lifecycle('install');
    expect(next.fetch.mock.calls.map(([request]) => (request as Request).url)).toEqual([
      `${origin}/index.html`,
    ]);
    await next.lifecycle('activate');
    expect([...next.stored.get(cacheName)!.keys()].sort()).toEqual([
      `${origin}/assets/index-a.js`,
      `${origin}/boot.js?__rio_revision=two`,
      `${origin}/index.html?__rio_revision=three`,
    ]);
  });

  it('fails the install when a precached file cannot be downloaded', async () => {
    const w = served();
    w.network.delete('/boot.js');
    await expect(w.lifecycle('install')).rejects.toThrow(/Precache request failed: .*\/boot\.js \(404\)/);
  });

  it('removes precaches from earlier workers on activation and keeps runtime caches', async () => {
    const legacy = new Map([[`${origin}/index.html?__rio_revision=old`, new Response('old page')]]);
    const runtimeAssets = new Map([[`${origin}/assets/old-a.js`, new Response('old')]]);
    const w = served();
    w.stored.set(`workbox-precache-v2-${origin}/`, legacy);
    w.stored.set('rio-app-assets', runtimeAssets);
    await w.lifecycle('install');
    await w.lifecycle('activate');
    expect([...w.stored.keys()].sort()).toEqual(['rio-app-assets', cacheName]);
  });

  it.each(['/', '/app/'])('isolates precache cleanup for registration scope %s', async (path) => {
    const scope = `${origin}${path}`;
    const current = `rio-precache-v1-${scope}`;
    const preserved = [
      'other-app-precache-v1',
      'unrelated-precache',
      'precache',
      'rio-app-assets',
      'rio-theme-styles',
      `rio-precache-v1-${scope}other/`,
      `rio-precache-v0-${scope}other/`,
      `workbox-runtime-${scope}`,
      `precache-${scope}`,
    ];
    if (path !== '/') preserved.push(`workbox-precache-v2-${origin}/other/`);
    const stored = new Map(preserved.map((name) => [name, new Map([[`${scope}kept`, new Response(name)]])]));
    const w = worker([], stored, scope);
    for (const name of [`rio-precache-v0-${scope}`, `workbox-precache-v2-${scope}`])
      stored.set(name, new Map([[`${scope}old`, new Response('old')]]));
    await w.lifecycle('install');
    await w.lifecycle('activate');
    expect([...stored.keys()].sort()).toEqual([...preserved, current].sort());
    for (const name of preserved) {
      expect([...stored.get(name)!.keys()]).toEqual([`${scope}kept`]);
      expect(await stored.get(name)!.get(`${scope}kept`)!.text()).toBe(name);
    }
  });

  it('keeps the active offline shell when a changed build fails after caching its page', async () => {
    const w = served();
    await w.lifecycle('install');
    await w.lifecycle('activate');
    const next = served([
      { url: 'index.html', revision: 'three' },
      ...shell.slice(1),
      { url: 'manifest.webmanifest', revision: 'missing' },
    ]);
    for (const [name, cache] of w.stored) next.stored.set(name, cache);
    next.network.set('/index.html', answer('new page', 'text/html'));
    await expect(next.lifecycle('install')).rejects.toThrow(/Precache request failed/);
    expect(await next.stored.get(cacheName)!.get(`${origin}/index.html?__rio_revision=three`)!.text()).toBe(
      'new page',
    );
    w.fetch.mockRejectedValue(new TypeError('offline'));
    expect(await (await w.request('/settings', { mode: 'navigate' }))!.text()).toBe('app page');
  });

  it('answers precached files from the cache, ignoring marketing parameters and folder indexes', async () => {
    const w = served();
    await w.lifecycle('install');
    w.fetch.mockClear();
    expect(await (await w.request('/boot.js'))!.text()).toBe('boot');
    expect(await (await w.request('/boot.js?utm_source=mail&fbclid=1#top'))!.text()).toBe('boot');
    expect(await (await w.request('/'))!.text()).toBe('app page');
    expect(await (await w.request('/index'))!.text()).toBe('app page');
    expect(w.fetch).not.toHaveBeenCalled();
    // Other parameters address a different resource, which stays with the browser.
    expect(await w.request('/boot.js?v=2')).toBeNull();
    expect(await w.request('/boot.js', { method: 'POST' })).toBeNull();
  });

  it('falls back to the network when the cache lost a precached file', async () => {
    const w = served();
    await w.lifecycle('install');
    w.stored.get(cacheName)!.delete(`${origin}/boot.js?__rio_revision=two`);
    expect(await (await w.request('/boot.js'))!.text()).toBe('boot');
    expect(w.fetch).toHaveBeenLastCalledWith(expect.objectContaining({ url: `${origin}/boot.js` }));
  });

  it('answers app navigations with the precached page', async () => {
    const w = served();
    await w.lifecycle('install');
    w.fetch.mockClear();
    for (const path of ['/settings', '/databases/1?view=grid', '/sitesmap', '/apis', '/api', '/themes'])
      expect(await (await w.request(path, { mode: 'navigate' }))!.text()).toBe('app page');
    expect(w.fetch).not.toHaveBeenCalled();
  });

  it('leaves denylisted navigations and other requests to the network', async () => {
    const w = served();
    await w.lifecycle('install');
    for (const path of [
      '/sites',
      '/sites/blog/post',
      '/api/auth/session',
      '/themes/nature/theme.css',
      '/healthz',
      '/healthzx',
      '/readyz',
    ])
      expect(await w.request(path, { mode: 'navigate' })).toBeNull();
    expect(await w.request('/settings')).toBeNull();
  });

  it('loads the page from the network when the precached page is missing', async () => {
    const w = served();
    expect(await (await w.request('/settings', { mode: 'navigate' }))!.text()).toBe('app page');
    expect(w.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: `${origin}/index.html` }));
  });
});
