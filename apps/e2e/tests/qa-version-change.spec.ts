import { expect, test, type Page, type Request as BrowserRequest } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createServer, request as upstreamRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { testWebDirectory } from '../web-build';
import { startStack, type Stack } from '../stack';
import { createDatabase, openTable, signIn, type SeededDatabase, visit } from '../helpers';
import { waitForVersionServerShutdown } from './qa-version-change-server';

// Each case owns both deployments and its server.  No browser request is intercepted.
test.use({ serviceWorkers: 'allow' });
test.setTimeout(120_000);

type Manifest = Record<string, { file: string; imports?: string[]; css?: string[] }>;
let temporary: string;
let active: string;
let next: string;
let manifest: Manifest;
let renamed: Map<string, string>;
let server: ChildProcess | undefined;
let ended: Promise<void>;
let address: string;
let stack: Stack | undefined;
let stackStopped = false;
let originalBase: string | undefined;

function versions(previousRelease = false) {
  const scratch = resolve(import.meta.dirname, '../../web/.unit-logs');
  mkdirSync(scratch, { recursive: true });
  temporary = mkdtempSync(join(scratch, 'rio-version-change-'));
  active = join(temporary, 'web');
  next = join(temporary, 'next');
  const current = process.env.RIOSOMA_VERSION_CHANGE_BASELINE ?? testWebDirectory();
  cpSync(previousRelease ? process.env.RIOSOMA_VERSION_CHANGE_PREVIOUS! : current, active, {
    recursive: true,
  });
  manifest = JSON.parse(readFileSync(join(active, '.vite/manifest.json'), 'utf8')) as Manifest;
  const shell = manifest['index.html']!.file;
  if (!previousRelease)
    writeFileSync(
      join(active, shell),
      readFileSync(join(active, shell), 'utf8') + '\nwindow.__rioTestVersion = "first";\n',
    );
  cpSync(current, next, { recursive: true });
  const currentManifest = JSON.parse(readFileSync(join(next, '.vite/manifest.json'), 'utf8')) as Manifest;
  const nextShell = currentManifest['index.html']!.file;
  writeFileSync(
    join(next, nextShell),
    readFileSync(join(next, nextShell), 'utf8') + '\nwindow.__rioTestVersion = "second";\n',
  );
  renamed = new Map(
    readdirSync(join(next, 'assets')).map((file) => [file, file.replace(/(\.[^.]+)$/, '-v2$1')]),
  );
  const references = new RegExp(
    [...renamed.keys()]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  for (const file of readdirSync(next, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(?:js|css|html|json|map|svg)$/.test(file)) continue;
    const path = join(next, file);
    let content = readFileSync(path, 'utf8');
    content = content.replace(references, (file) => renamed.get(file)!);
    if (file === shell)
      content = content.replace('window.__rioTestVersion = "first"', 'window.__rioTestVersion = "second"');
    writeFileSync(path, content);
  }
  for (const [before, after] of renamed)
    renameSync(join(next, 'assets', before), join(next, 'assets', after));
  const indexRevision = createHash('md5')
    .update(readFileSync(join(next, 'index.html')))
    .digest('hex');
  const script = join(next, 'sw.js');
  writeFileSync(
    script,
    readFileSync(script, 'utf8').replace(
      /url:"index\.html",revision:"[^"]+"/,
      `url:"index.html",revision:"${indexRevision}"`,
    ),
  );
}

function swap() {
  renameSync(active, join(temporary, 'previous'));
  renameSync(next, active);
}

async function ready(page: Page) {
  await page.goto(`${address}/sign-in`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__rioTestVersion'))).toBe('first');
  await page.waitForLoadState('networkidle');
}

async function navigate(page: Page) {
  await page.evaluate(() => {
    history.pushState({}, '', '/sign-in/forgot-password');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

async function repaired(page: Page, loads: () => number, screen = 'Forgot password') {
  await expect(page.getByRole('heading', { name: screen, exact: true })).toBeVisible();
  await currentVersion(page);
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  expect(loads()).toBeLessThanOrEqual(1);
}

async function currentVersion(page: Page) {
  // Repair deliberately navigates.  This wait resumes in the new document instead of reading a torn-down one.
  await page.waitForFunction(() => Reflect.get(window, '__rioTestVersion') === 'second', undefined, {
    timeout: 5_000,
  });
}

function countLoads(page: Page) {
  let loads = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads++;
  });
  return () => loads;
}

async function disconnectServer(page: Page) {
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await page.waitForLoadState('networkidle');
  await stopServer();
  // Keep the browser's network available so the worker can serve caches and recovery must probe the server.
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
}

async function stopServer() {
  const stopped = async () => {
    if (stack) {
      if (!stackStopped) await stack.stop();
      stackStopped = true;
    } else if (server) {
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
      // Exit can precede close, so always wait for the process and its output streams to finish.
      await ended;
    }
  };
  await waitForVersionServerShutdown(stopped(), server);
}

async function precached(page: Page, key: string) {
  const files = new Set<string>();
  const visit = (key: string) => {
    const entry = manifest[key]!;
    if (files.has(entry.file)) return;
    files.add(entry.file);
    for (const css of entry.css ?? []) files.add(css);
    for (const dependency of entry.imports ?? []) visit(dependency);
  };
  visit(key);
  await expect
    .poll(() =>
      page.evaluate(
        async (files) => {
          const names = (await caches.keys()).filter((name) => name.includes('precache'));
          for (const file of files) {
            const matches = await Promise.all(
              names.map(async (name) => (await caches.open(name)).match(`/${file}`, { ignoreSearch: true })),
            );
            if (!matches.some((response) => response?.ok)) return false;
          }
          return true;
        },
        [...files],
      ),
    )
    .toBe(true);
}

function failedAsset(page: Page, key: string) {
  return page.waitForEvent('requestfailed', {
    predicate: (request) => new URL(request.url()).pathname === `/${manifest[key]!.file}`,
  });
}

async function readyTable(page: Page, database: SeededDatabase) {
  // Firefox can finish navigation before the policy's required import and query have settled.
  // Finish those startup reads before removing files or stopping the server for a feature failure.
  const policy = page.waitForResponse(`${address}/api/databases/${database.id}/trash-window`);
  const grid = await openTable(page, database, 'Records');
  const response = await policy;
  expect(response.ok()).toBe(true);
  await response.finished();
  return grid;
}

test.beforeEach(async ({ browserName }, info) => {
  server = undefined;
  stackStopped = false;
  const previousRelease = info.title === 'a previous release recovers into the current deployment';
  test.skip(
    previousRelease && !process.env.RIOSOMA_VERSION_CHANGE_PREVIOUS,
    'Set RIOSOMA_VERSION_CHANGE_PREVIOUS to an unchanged web build from an older commit.',
  );
  versions(previousRelease);
  if (
    info.title.startsWith('a hover preload') ||
    info.title.startsWith('an offline lazy') ||
    info.title.startsWith('a caught PDF') ||
    info.title.startsWith('a failed Home') ||
    info.title.startsWith('a directly loaded Home') ||
    info.title.startsWith('a reload during a lazy screen')
  ) {
    const previousWeb = process.env.RIOSOMA_E2E_WEB_DIR;
    process.env.RIOSOMA_E2E_WEB_DIR = active;
    try {
      stack = await startStack();
    } finally {
      process.env.RIOSOMA_E2E_WEB_DIR = previousWeb;
    }
    address = stack.baseURL;
    originalBase = process.env[`RIOSOMA_E2E_BASE_URL_${browserName}`];
    process.env[`RIOSOMA_E2E_BASE_URL_${browserName}`] = address;
    return;
  }
  const child = spawn(
    process.execPath,
    [resolve(import.meta.dirname, '../../server/dist/demo/browser.test-helpers.js')],
    {
      env: { ...process.env, RIOSOMA_E2E_WEB_DIR: active },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  server = child;
  ended = new Promise((done) => child.once('close', () => done()));
  address = await new Promise<string>((done, fail) => {
    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.once('error', fail);
    child.once('close', () => fail(new Error(stderr || 'Version test server exited')));
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => {
      done((JSON.parse(line) as { address: string }).address);
      lines.close();
    });
  });
});

test.afterEach(async ({ browserName, context }) => {
  // Release the page's connections before asking its backend to drain outstanding requests.
  await context.close();
  await stopServer();
  if (stack) {
    stack = undefined;
    process.env[`RIOSOMA_E2E_BASE_URL_${browserName}`] = originalBase;
  }
  if (temporary) {
    try {
      rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      console.warn('Could not remove version test files after server shutdown', error);
    }
  }
});

test('an old page opens a screen it has never loaded', async ({ page }) => {
  await ready(page);
  const loads = countLoads(page);
  swap();
  await navigate(page);
  await repaired(page, loads);
});

test('a cached module loses a static import after deployment', async ({ page }) => {
  await ready(page);
  const route = manifest['src/screens/PasswordResetScreen.tsx']!;
  const file = `/${route.file}`;
  const dependency = route
    .imports!.map((key) => manifest[key]!.file)
    .find((name) => name.includes('/password-'))!;
  expect(dependency).toBeTruthy();
  await page.evaluate(
    async ({ file, dependency }) => {
      const cache = await caches.open('rio-app-assets');
      await cache.put(file, await fetch(file));
      await cache.delete(`/${dependency}`);
    },
    { file, dependency },
  );
  const loads = countLoads(page);
  swap();
  const missing = page.waitForEvent('request', {
    predicate: (request) => request.url().endsWith(`/${dependency}`),
  });
  await page.evaluate((file) => {
    history.replaceState({}, '', '/sign-in/forgot-password');
    // Native import skips Vite's preload helper, so the missing request comes from static linking.
    void import(/* @vite-ignore */ file);
  }, file);
  await missing;
  await repaired(page, loads);
});

test('a plain reload uses the current deployment', async ({ page }) => {
  await ready(page);
  swap();
  const loads = countLoads(page);
  await page.reload();
  await repaired(page, () => loads() - 1, 'Sign in');
  // Wait for the newer worker's answer, including the fallback limit, before checking the notice.
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.installing))
    .toBeNull();
  await page.waitForTimeout(1_500);
  await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Update', exact: true })).toBeHidden();
});

test('a reload during a lazy screen load leaves no errors', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'WebKit rejects module loads canceled by document navigation.');
  await signIn(page);
  const database = await createDatabase(page, 'Reload during screen loading', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Original' }] },
  ]);
  const screen = `/${manifest['src/screens/database/DatabaseScreen.tsx']!.file}`;
  let started!: () => void;
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const sockets = new Set<Duplex>();
  // A real delayed network response exercises native import cancellation without browser routing.
  const proxy = createServer((incoming, outgoing) => {
    const forward = () => {
      if (outgoing.destroyed) return;
      const upstream = upstreamRequest(
        new URL(incoming.url!, address),
        {
          method: incoming.method,
          headers: { ...incoming.headers, host: new URL(address).host },
        },
        (response) => {
          outgoing.writeHead(response.statusCode!, response.headers);
          response.pipe(outgoing);
        },
      );
      upstream.on('error', () => outgoing.destroy());
      outgoing.on('close', () => upstream.destroy());
      incoming.pipe(upstream);
    };
    if (!held && incoming.url === screen) {
      held = true;
      started();
      void gate.then(forward);
    } else forward();
  });
  // The delayed document still uses the real database connection after its screen mounts.
  proxy.on('upgrade', (incoming, socket, head) => {
    sockets.add(socket);
    const upstream = upstreamRequest(new URL(incoming.url!, address), {
      headers: { ...incoming.headers, host: new URL(address).host, origin: address },
    });
    upstream.on('upgrade', (response, connection, received) => {
      sockets.add(connection);
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          Object.entries(response.headers)
            .map(([name, value]) => `${name}: ${String(value)}\r\n`)
            .join('') +
          '\r\n',
      );
      connection.write(head);
      socket.write(received);
      socket.pipe(connection).pipe(socket);
      connection.on('error', () => socket.destroy());
      socket.on('error', () => connection.destroy());
      socket.on('close', () => connection.destroy());
      connection.on('close', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', () => socket.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const endpoint = proxy.address();
  if (!endpoint || typeof endpoint === 'string') throw new Error('Lazy screen server has no address');
  const errors: string[] = [];
  const inFlight = new Set<BrowserRequest>();
  page.on('request', (request) => inFlight.add(request));
  page.on('requestfinished', (request) => inFlight.delete(request));
  page.on('requestfailed', (request) => inFlight.delete(request));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const table = database.tables.Records!;
    await page.goto(`http://127.0.0.1:${endpoint.port}/`);
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    // Mount the signed-in shell and finish its reads before interrupting only the lazy screen.
    await page.evaluate((path) => {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, `/${database.id}/${table.id}/${table.viewId}`);
    await loading;
    await expect(page.getByRole('status')).toBeVisible();
    // Only the held module should be canceled.  Background API reads finish before navigation.
    await expect
      .poll(() => [...inFlight].filter((request) => new URL(request.url()).pathname !== screen).length)
      .toBe(0);
    expect([...inFlight].some((request) => new URL(request.url()).pathname === screen)).toBe(true);
    const canceled = failedAsset(page, 'src/screens/database/DatabaseScreen.tsx');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await canceled;
    release();
    await expect(page.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(errors).toEqual([]);
  } finally {
    release();
    for (const socket of sockets) socket.destroy();
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
  }
});

test('a plain reload repairs HTML stored at a script address', async ({ page }) => {
  await ready(page);
  const shell = `/${manifest['src/locales/en-US/messages.po?shell']!.file}`;
  await page.evaluate(async (file) => {
    const cache = await caches.open('rio-app-assets');
    await cache.put(
      file,
      new Response('<html>wrong answer</html>', { headers: { 'content-type': 'text/html' } }),
    );
  }, shell);
  swap();
  const loads = countLoads(page);
  await page.reload();
  await repaired(page, () => loads() - 1, 'Sign in');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const cache = await caches.open('rio-app-assets');
        for (const key of await cache.keys()) {
          const response = await cache.match(key);
          if (
            new URL(key.url).pathname.endsWith('.js') &&
            response?.headers.get('content-type')?.includes('text/html')
          )
            return false;
        }
        return true;
      }),
    )
    .toBe(true);
});

test('a deployment that truly lacks a screen shows Reload without looping', async ({ page }) => {
  await ready(page);
  const route = manifest['src/screens/PasswordResetScreen.tsx']!.file;
  swap();
  rmSync(join(active, 'assets', renamed.get(basename(route))!));
  const loads = countLoads(page);
  await navigate(page);
  await repaired(page, loads, "This screen couldn't load");
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  // Keep watching after update activation and all of its fetches have completed.
  await page.waitForTimeout(5_000);
  expect(loads()).toBe(1);
});

test('a page with no missing requests stays open and offers the update', async ({ page }) => {
  await ready(page);
  const loads = countLoads(page);
  swap();
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.getRegistration())!.update();
  });
  await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting === null),
    )
    .toBe(true);
  expect(loads()).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, '__rioTestVersion'))).toBe('first');
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Update', exact: true }).click();
  await repaired(page, loads, 'Sign in');
  expect(loads()).toBe(1);
});

test('a directly loaded Home offers an update without requesting an old feature catalog', async ({
  page: signedIn,
  context,
  browser,
}) => {
  await signIn(signedIn);
  // Cookies restore the person, while a separate context leaves both asset caches cold.
  const cold = await browser.newContext({
    storageState: await context.storageState(),
    serviceWorkers: 'allow',
  });
  try {
    const page = await cold.newPage();
    await visit(page, `${address}/`);
    const create = page.getByRole('button', { name: 'New database', exact: true });
    await expect(create).toBeVisible();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await page.waitForLoadState('networkidle');
    const catalog = `/${manifest['src/locales/en-US/messages.po']!.file}`;
    expect(
      await page.evaluate(
        (file) =>
          performance.getEntriesByType('resource').some((entry) => new URL(entry.name).pathname === file),
        catalog,
      ),
    ).toBe(false);
    const loads = countLoads(page);
    swap();
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(loads()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, '__rioTestVersion'))).toBe('first');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await currentVersion(page);
    await expect(create).toBeVisible();
    expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
    expect(loads()).toBe(1);
  } finally {
    await cold.close();
  }
});

test('a deployment missing its entry script keeps a readable recovery screen', async ({ page }) => {
  await ready(page);
  const entry = manifest['index.html']!.file;
  swap();
  rmSync(join(active, 'assets', renamed.get(basename(entry))!));
  const loads = countLoads(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: "This screen couldn't load", exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  await page.waitForTimeout(5_000);
  expect(loads()).toBeLessThanOrEqual(2);
});

test('a first visit with a missing entry script shows recovery without an error event', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const entry = manifest['index.html']!.file;
  swap();
  rmSync(join(active, 'assets', renamed.get(basename(entry))!));
  const loads = countLoads(page);
  await page.goto(`${address}/sign-in`);
  await expect(page.getByRole('heading', { name: "This screen couldn't load", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const reload = page.getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(reload).toBeFocused();
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.waitForTimeout(5_000);
  expect(loads()).toBe(2);
});

test('an app repair into a deployment missing its entry script loads only once', async ({ page }) => {
  await ready(page);
  const entry = manifest['index.html']!.file;
  swap();
  rmSync(join(active, 'assets', renamed.get(basename(entry))!));
  const loads = countLoads(page);
  // Updating a worker with an incomplete precache must finish before repair navigates this document.
  await Promise.all([page.waitForEvent('domcontentloaded'), navigate(page)]);
  await expect(page.getByRole('heading', { name: "This screen couldn't load", exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.installing))
    .toBeNull();
  expect(loads()).toBe(1);
});

test('an unhandled offline import leaves the mounted screen available', async ({ page }) => {
  await ready(page);
  await precached(page, 'src/shell/ToastRegion.tsx');
  const loads = countLoads(page);
  await disconnectServer(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new TypeError('Failed to fetch dynamically imported module'),
      }),
    );
  });
  await expect(page.getByText("That part couldn't load", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(loads()).toBe(0);
});

test('a deployment missing its startup catalog keeps readable recovery text', async ({ page }) => {
  await ready(page);
  const catalog = manifest['src/locales/en-US/messages.po?shell']!.file;
  swap();
  rmSync(join(active, 'assets', renamed.get(basename(catalog))!));
  const loads = countLoads(page);
  await page.reload();
  await repaired(page, () => loads() - 1, "This screen couldn't load");
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.locator('#root')).not.toContainText('app.load.');
});

test('a hover preload offers an update and only opening the screen repairs it', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Version change', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  const grid = await readyTable(page, database);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  swap();
  const control = page.getByRole('button', { name: 'Sync out', exact: true });
  await control.hover();
  await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(loads()).toBe(0);
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  await control.click();
  await currentVersion(page);
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sync out', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sync out', exact: true })).toBeVisible();
  expect(loads()).toBe(1);
});

test('an offline lazy feature leaves the working grid and its outbox available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Offline feature', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  const grid = await readyTable(page, database);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  await disconnectServer(page);
  // Use keyboard intent so the unopened feature is requested only after the server has stopped.
  const missing = failedAsset(page, 'src/features/sync-out/SyncOutDialog.tsx');
  const control = page.getByRole('button', { name: 'Sync out', exact: true });
  if (await control.isVisible()) {
    await control.focus();
    await control.press('Enter');
  } else {
    await page.locator('.rio-view-toolbar').getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sync out', exact: true }).click();
  }
  await missing;
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeHidden();
  await expect(
    page
      .getByRole('grid', { name: 'Grid', includeHidden: true })
      .getByRole('gridcell', { name: 'Original', exact: true, includeHidden: true }),
  ).toBeVisible();
  const dialog = page.getByRole('dialog', { name: "This screen couldn't load", exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await dialog.getByRole('button', { name: 'Close', exact: true }).focus();
  await expect(page.getByRole('tooltip')).toHaveText('Close');
  for (let index = 0; index < 3; index++) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page
    .getByRole('dialog', { name: "This screen couldn't load", exact: true })
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
  const input = page.locator('.rio-grid__input');
  await input.fill('Queued after feature failure');
  await input.press('Enter');
  await expect(
    grid.getByRole('gridcell', { name: 'Queued after feature failure', exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('rio-data-outbox');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise<number>((resolve, reject) => {
            const request = database.transaction('commands').objectStore('commands').count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        } finally {
          database.close();
        }
      }),
    )
    .toBeGreaterThan(0);
  expect(loads()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

for (const order of ['newest', 'oldest'] as const) {
  test(`a failed Home overlay keeps recovery accessible when the ${order} dialog closes first`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    // Load the control used to prove that the page is interactive again after offline recovery.
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    await precached(page, 'src/shell/FeatureErrorDialog.tsx');
    const original = await page.locator('#root').evaluate((root) => ({
      inert: root.getAttribute('inert'),
      hidden: root.getAttribute('aria-hidden'),
      overflow: document.documentElement.style.overflow,
    }));
    await disconnectServer(page);
    const open = async (search: string) => {
      await page.evaluate((search) => {
        history.pushState({}, '', `/${search}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, search);
    };
    if (order === 'oldest') {
      await open('?shortcuts=1');
      await expect(page.locator('dialog.rio-feature-error-dialog')).toHaveCount(1);
    }
    await open('?shortcuts=1&appearance=1');
    const dialogs = page.locator('dialog.rio-feature-error-dialog');
    await expect(dialogs).toHaveCount(2);
    const active = page.getByRole('dialog', { name: "This screen couldn't load", exact: true });
    await expect(active).toHaveCount(1);
    await expect(active).not.toHaveAttribute('inert');
    await expect(page.locator('#root')).toHaveAttribute('inert', '');
    await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
    for (const key of ['Tab', 'Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(await active.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    }
    expect(await active.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true);
    if (order === 'oldest') await open('?appearance=1');
    else await active.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialogs).toHaveCount(1);
    await expect(active).not.toHaveAttribute('inert');
    expect(await active.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
    await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
    await page.keyboard.press('Escape');
    await expect(dialogs).toHaveCount(0);
    expect(
      await page.locator('#root').evaluate((root) => ({
        inert: root.getAttribute('inert'),
        hidden: root.getAttribute('aria-hidden'),
        overflow: document.documentElement.style.overflow,
      })),
    ).toEqual(original);
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: /: Personal menu$/ }).click();
    await expect(page.getByRole('menu')).toBeVisible();
  });
}

test('a previous release recovers into the current deployment', async ({ page }) => {
  await page.goto(`${address}/sign-in`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  swap();
  await navigate(page);
  await repaired(page, loads);
});

test('a caught PDF import repairs the page and keeps the help deep link', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  const help = page.getByRole('complementary', { name: 'Help', exact: true });
  await help.getByRole('link', { name: 'Welcome to Riosoma', exact: true }).click();
  await expect(help.getByRole('heading', { name: 'Welcome to Riosoma', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  swap();
  await help.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await currentVersion(page);
  await expect(help.getByRole('heading', { name: 'Welcome to Riosoma', exact: true })).toBeVisible();
  expect(await page.locator('#root').evaluate((root) => root.childElementCount)).toBeGreaterThan(0);
  await page.waitForLoadState('networkidle');
  expect(loads()).toBe(1);
});

test('a caught PDF import while offline offers Reload and keeps help available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  const help = page.getByRole('complementary', { name: 'Help', exact: true });
  await help.getByRole('link', { name: 'Welcome to Riosoma', exact: true }).click();
  await expect(help.getByRole('heading', { name: 'Welcome to Riosoma', exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  await disconnectServer(page);
  const missing = failedAsset(page, 'src/docs/pdf.ts');
  await help.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await missing;
  await expect(page.getByText("That part couldn't load", { exact: true })).toBeVisible();
  const reload = page.getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeVisible();
  await reload.focus();
  await expect(reload).toBeFocused();
  await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeHidden();
  await expect(help.getByRole('heading', { name: 'Welcome to Riosoma', exact: true })).toBeVisible();
  expect(loads()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('a failed Home dialog closes and leaves another dialog available', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const create = page.getByRole('button', { name: 'New database', exact: true });
  await create.click();
  const creation = page.getByRole('dialog', { name: 'New database', exact: true });
  await expect(creation).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(creation).toBeHidden();
  await page.waitForLoadState('networkidle');
  const loads = countLoads(page);
  await disconnectServer(page);
  const missing = failedAsset(page, 'src/screens/trash/DeletedDatabasesDialog.tsx');
  const trash = page.getByRole('button', { name: 'Trash', exact: true });
  await trash.focus();
  await trash.press('Enter');
  await missing;
  const failed = page.getByRole('dialog', { name: "This screen couldn't load", exact: true });
  await expect(failed.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await failed.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(failed).toBeHidden();
  await create.focus();
  await create.press('Enter');
  await expect(creation).toBeVisible();
  expect(loads()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
