import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from './test/fixture.js';
import {
  STALE_ASSET_HEADER,
  STALE_ASSET_RETRY_MS,
  STALE_ASSET_SCRIPT,
  STALE_ASSET_STATEMENTS,
} from './stale-assets.js';

let kit: TestPostgres;
let server: ServerFixture;
let webDir: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  // A stand-in for one built version of the web app: its page and the build files it names.
  webDir = mkdtempSync(join(tmpdir(), 'rio-stale-assets-web-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>Riosoma</title><div id="root"></div>');
  writeFileSync(join(webDir, 'assets', 'settings-Bq3xK9aa.js'), 'export default 1;');
  writeFileSync(join(webDir, 'assets', 'settings-Bq3xK9aa.css'), '.rio { color: red }');
  server = await startServer(kit, 'stale_assets', { webDir });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  if (webDir) rmSync(webDir, { recursive: true, force: true });
});

const get = (url: string, method: 'GET' | 'HEAD' = 'GET') => server.app.inject({ method, url });

describe('build files this version does not have', () => {
  it('serves the build files it has, to be kept for good', async () => {
    const script = await get('/assets/settings-Bq3xK9aa.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(script.headers[STALE_ASSET_HEADER]).toBeUndefined();
    expect(script.body).toBe('export default 1;');
  });

  it('answers a missing script with the module that moves the page to this version, never with the page', async () => {
    for (const url of ['/assets/server-D7YEPrYG.js', '/assets/server-D7YEPrYG.js?v=2', '/assets/chunk.mjs']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toBe('text/javascript; charset=utf-8');
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers[STALE_ASSET_HEADER], url).toBe('1');
      expect(response.body, url).toBe(STALE_ASSET_SCRIPT);
      expect(response.body, url).not.toContain('<!doctype');
    }
    const head = await get('/assets/server-D7YEPrYG.js', 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(head.headers['cache-control']).toBe('no-store');
  });

  it('answers any other missing build file with a 404 that nothing may keep', async () => {
    for (const url of [
      '/assets/settings-OLD.css',
      '/assets/font-OLD.woff2',
      '/assets/',
      '/assets/nested/gone.png',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.headers['cache-control'], url).toBe('no-store');
      expect(response.headers[STALE_ASSET_HEADER], url).toBe('1');
      expect(response.body, url).not.toContain('<!doctype');
    }
  });

  it('still answers a deep link into the app with the page', async () => {
    for (const url of ['/settings/ai', '/home/shared', '/assets-and-more']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['content-type'], url).toMatch(/text\/html/);
      expect(response.headers[STALE_ASSET_HEADER], url).toBeUndefined();
      expect(response.body, url).toContain('<div id="root">');
    }
  });
});

/** Runs the module's statements against a stand-in page, the way a browser would on import. */
function page(
  options: { worker?: 'waiting' | 'installing' | 'none'; registered?: boolean; last?: number } = {},
) {
  const stored = new Map<string, string>();
  if (options.last !== undefined) stored.set('rio.stale-asset', String(options.last));
  const posted: unknown[] = [];
  const deleted: string[] = [];
  const reload = vi.fn();
  let controllerChanged: (() => void) | undefined;
  let stateChanged: (() => void) | undefined;
  const worker = {
    state: options.worker === 'installing' ? 'installing' : 'installed',
    postMessage(message: unknown) {
      posted.push(message);
      // The newer worker takes over once it is asked to.
      queueMicrotask(() => controllerChanged?.());
    },
    addEventListener(_: string, listener: () => void) {
      stateChanged = listener;
    },
  };
  const kind = options.worker ?? 'waiting';
  const registration = {
    update: vi.fn(async () => undefined),
    waiting: kind === 'waiting' ? worker : null,
    installing: kind === 'installing' ? worker : null,
  };
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
    ...parts: string[]
  ) => (...values: unknown[]) => Promise<void>;
  const run = new AsyncFunction(
    'sessionStorage',
    'caches',
    'navigator',
    'location',
    'setTimeout',
    'window',
    `${STALE_ASSET_STATEMENTS}\nreturn retrying;`,
  );
  // One page keeps one window through every file it asks for.
  const window: Record<string, unknown> = {};
  const start = () =>
    run(
      {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
      { delete: async (name: string) => deleted.push(name) },
      {
        serviceWorker: {
          getRegistration: async () => (options.registered === false ? undefined : registration),
          addEventListener: (_: string, listener: () => void) => {
            controllerChanged = listener;
          },
        },
      },
      { reload },
      // The wait for a worker that never takes over is not what these tests time.
      (callback: () => void) => setTimeout(callback, 20),
      window,
    ) as unknown as Promise<boolean>;
  return {
    start,
    posted,
    deleted,
    reload,
    stored,
    registration,
    finishInstalling() {
      worker.state = 'installed';
      stateChanged?.();
    },
  };
}

describe('the module a missing script is answered with', () => {
  it('drops the cached build files, wakes the waiting worker, and loads the page again', async () => {
    const tab = page();
    await tab.start();
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
    expect(tab.deleted).toEqual(['rio-app-assets']);
    expect(tab.registration.update).toHaveBeenCalledTimes(1);
    expect(tab.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(Number(tab.stored.get('rio.stale-asset'))).toBeGreaterThan(0);
  });

  it('waits for a worker that is still installing before asking it to take over', async () => {
    const tab = page({ worker: 'installing' });
    await tab.start();
    expect(tab.posted).toEqual([]);
    tab.finishInstalling();
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
    expect(tab.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('loads the page again when there is no newer worker or no worker at all', async () => {
    for (const options of [{ worker: 'none' as const }, { registered: false }]) {
      const tab = page(options);
      await tab.start();
      await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
      expect(tab.posted).toEqual([]);
    }
  });

  it('does nothing a second time within the retry window, so a build that lacks a file cannot loop', async () => {
    const tab = page({ last: Date.now() - STALE_ASSET_RETRY_MS + 5_000 });
    await tab.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.deleted).toEqual([]);
    expect(tab.posted).toEqual([]);
  });

  it('tries again once the retry window has passed', async () => {
    const tab = page({ last: Date.now() - STALE_ASSET_RETRY_MS - 1_000 });
    await tab.start();
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
  });

  it('lets a second missing file of the same page wait for the move the first one started', async () => {
    const tab = page();
    expect(await tab.start()).toBe(true);
    // The page asks for another file that is gone before it has loaded again.
    expect(await tab.start()).toBe(true);
    await vi.waitFor(() => expect(tab.reload).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(tab.deleted).toEqual(['rio-app-assets']);
    expect(tab.posted).toEqual([{ type: 'SKIP_WAITING' }]);
  });

  it('is a module with a default export and no HTML', () => {
    expect(STALE_ASSET_SCRIPT).toContain('export default undefined;');
    expect(STALE_ASSET_SCRIPT).not.toMatch(/<\w/);
  });

  it('leaves the import unfinished only while the page is on its way to this version', () => {
    // An older page that got nothing from a finished import would show an error just before it
    // loads again.  After a try that did not help, the import has to finish so the page can say so.
    const afterStatements = STALE_ASSET_SCRIPT.slice(
      STALE_ASSET_SCRIPT.indexOf(STALE_ASSET_STATEMENTS) + STALE_ASSET_STATEMENTS.length,
    );
    expect(afterStatements.trim()).toBe(
      'if (retrying) await new Promise(() => undefined);\nexport default undefined;',
    );
    expect(STALE_ASSET_STATEMENTS).toContain('let retrying = window.__rioStaleAssetRetry === true;');
    expect(STALE_ASSET_STATEMENTS.indexOf('retrying = true;')).toBeGreaterThan(
      STALE_ASSET_STATEMENTS.indexOf('if (Date.now() - last >'),
    );
  });

  it('says whether it started a retry', async () => {
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...parts: string[]
    ) => (...values: unknown[]) => Promise<boolean>;
    const run = (last: number) =>
      new AsyncFunction(
        'sessionStorage',
        'caches',
        'navigator',
        'location',
        'setTimeout',
        'window',
        `${STALE_ASSET_STATEMENTS}\nreturn retrying;`,
      )(
        { getItem: () => String(last), setItem: () => undefined },
        { delete: async () => true },
        { serviceWorker: { getRegistration: async () => undefined, addEventListener: () => undefined } },
        { reload: () => undefined },
        setTimeout,
        {},
      );
    expect(await run(Date.now() - STALE_ASSET_RETRY_MS - 1_000)).toBe(true);
    expect(await run(Date.now())).toBe(false);
  });
});
