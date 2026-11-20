import { test, expect, chromium, type BrowserContext, type Page } from '../accessibility';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../../../', import.meta.url));
let server: Server;
let origin: string;
let context: BrowserContext;
let scratch: string;
let extensionId: string;
let writes: { fields: Record<string, unknown> }[] = [];
let uploads = 0;
let refuseUpload = false;
let tokenRequests = 0;
const credential = randomUUID();
const database = 'dbs00000000000001';
const table = 'tbl00000000000001';
const view = 'viw00000000000001';
const fields = [
  { id: 'title', name: 'Title', type: 'text' },
  { id: 'url', name: 'Address', type: 'url' },
  { id: 'text', name: 'Passage', type: 'longText' },
  { id: 'image', name: 'Screenshot', type: 'attachment' },
];

// Extensions load only in Chromium, so the other engines' nightly projects skip this file.
test.skip(({ browserName }) => browserName !== 'chromium');

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin);
    response.setHeader('Content-Type', 'application/json');
    const json = (value: unknown) => response.end(JSON.stringify(value));
    if (url.pathname === '/oauth/token') {
      tokenRequests++;
      return json({ access_token: credential, refresh_token: randomUUID(), expires_in: 3600 });
    }
    if (url.pathname === '/oauth/revoke') return json({});
    if (request.headers.authorization !== `Bearer ${credential}`) {
      response.statusCode = 401;
      return json({});
    }
    if (url.pathname === '/api/v1/databases')
      return json({ databases: [{ id: database, name: 'Research' }] });
    if (url.pathname.endsWith('/tables'))
      return json({ tables: [{ id: table, name: 'Pages', fields, views: [{ id: view, name: 'All' }] }] });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (url.pathname.endsWith('/files')) {
      uploads++;
      if (refuseUpload) response.statusCode = 403;
      return json({ id: 'attachment' });
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    writes.push(...body.records);
    return json({ records: [{ id: 'record', fields: body.records[0].fields }] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server');
  origin = `http://${address.address}:${address.port}`;
  // One build serves every Riosoma address, so nothing about this server goes into it.
  execFileSync(process.execPath, ['integrations/shared/build.mjs', 'clipper'], { cwd: root, stdio: 'pipe' });
  scratch = await mkdtemp(join(tmpdir(), 'clipper-browser-'));
  // A headless browser can't show the permission prompt, so the loaded copy is granted this server
  // up front, as if the person had accepted it.  The popup's request is still checked below.
  const extension = join(scratch, 'extension');
  await cp(resolve(root, 'integrations/clipper/dist'), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  await writeFile(
    join(extension, 'manifest.json'),
    JSON.stringify({ ...manifest, host_permissions: [`${origin}/*`] }),
  );
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--mute-audio',
      '--disable-speech-synthesis-api',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    const browser = (
      globalThis as unknown as {
        chrome: {
          identity: {
            getRedirectURL(): string;
            launchWebAuthFlow(options: { url: string }): Promise<string>;
          };
        };
      }
    ).chrome;
    browser.identity.launchWebAuthFlow = async ({ url }) => {
      const authorize = new URL(url);
      const callback = new URL(browser.identity.getRedirectURL());
      callback.search = new URLSearchParams({
        code: crypto.randomUUID(),
        state: authorize.searchParams.get('state')!,
        iss: authorize.origin,
      }).toString();
      return callback.href;
    };
  });
});
test.beforeEach(async () => {
  writes = [];
  uploads = 0;
  refuseUpload = false;
  tokenRequests = 0;
  const worker = context.serviceWorkers()[0]!;
  await expect
    .poll(() =>
      worker.evaluate(() =>
        (
          globalThis as unknown as { chrome: { runtime: { onMessage: { hasListeners(): boolean } } } }
        ).chrome.runtime.onMessage.hasListeners(),
      ),
    )
    .toBe(true);
  await worker.evaluate(async () => {
    const chrome = (
      globalThis as unknown as {
        chrome: { storage: { session: { clear(): Promise<void> }; local: { clear(): Promise<void> } } };
      }
    ).chrome;
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();
  });
});

test.afterAll(async () => {
  await context?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
/** The popup, with the browser's own capture and prompt answered locally.  `grant` is the person's answer. */
async function popup(grant = true): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(
    ({ origin, grant }) => {
      const browser = (
        globalThis as unknown as {
          chrome: {
            tabs: { query: unknown; captureVisibleTab: unknown };
            scripting: { executeScript: unknown };
            permissions: { request: unknown };
          };
        }
      ).chrome;
      const requested: unknown[] = [];
      Object.assign(globalThis, { requested });
      browser.tabs.query = async () => [
        { id: 19, windowId: 1, title: 'A useful page', url: `${origin}/article` },
      ];
      browser.tabs.captureVisibleTab = async () =>
        `data:image/png;base64,${btoa(String.fromCharCode(137, 80, 78, 71))}`;
      browser.scripting.executeScript = async () => [{ result: 'The selected passage' }];
      browser.permissions.request = async (permissions: unknown) => {
        requested.push(permissions);
        return grant;
      };
    },
    { origin, grant },
  );
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'commit' });
  await expect(page.getByLabel('Riosoma address')).toBeVisible();
  return page;
}
const requested = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { requested: unknown[] }).requested);
async function enter(page: Page, address = origin) {
  await page.getByLabel('Riosoma address').fill(address);
  await page.getByLabel('OAuth client ID').fill('client');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
async function signIn(page: Page) {
  await enter(page);
  await expect(async () => {
    if (!(await page.getByLabel('Database', { exact: true }).isVisible())) {
      throw new Error((await page.getByRole('status').textContent()) || 'sign_in_pending');
    }
  }).toPass({ timeout: 5000 });
}
async function choose(page: Page) {
  await page.getByLabel('Database', { exact: true }).selectOption(database);
  await page.getByLabel('Table', { exact: true }).selectOption(table);
  await page.getByLabel('Title field', { exact: true }).selectOption('title');
  await page.getByLabel('URL field', { exact: true }).selectOption('url');
  await page.getByLabel('Selected text field', { exact: true }).selectOption('text');
  await page.getByLabel('Screenshot field', { exact: true }).selectOption('image');
}

test.beforeEach(({ accessibilityChecks }) => accessibilityChecks(context));

test('signs in, maps fields, saves by keyboard, and restores a deep link on a phone', async () => {
  const page = await popup();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--rio-bg').trim()),
  ).not.toBe('#fbfbf9');
  await signIn(page);
  expect(await requested(page)).toEqual([{ origins: [`${origin}/*`] }]);
  await choose(page);
  await expect(page.getByLabel('Page title', { exact: true })).toHaveValue('A useful page');
  await expect(page.getByLabel('Selected text', { exact: true })).toHaveValue('The selected passage');
  await page.getByLabel('Page title', { exact: true }).press('Enter');
  expect(writes).toHaveLength(0);
  const link = page.url();
  await page.getByRole('link', { name: 'Help', exact: true }).click();
  await expect(page.getByText('Then choose a database and table', { exact: false })).toBeVisible();
  await page.getByRole('link', { name: 'Back to the page' }).click();
  await page.getByLabel('Include a screenshot').check();
  await page.getByRole('button', { name: 'Save page' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Page saved.');
  expect(writes).toEqual([
    {
      fields: {
        title: 'A useful page',
        url: `${origin}/article`,
        text: 'The selected passage',
        image: ['attachment'],
      },
    },
  ]);
  expect(uploads).toBe(1);
  await expect(page.getByRole('link', { name: 'Open record' })).toHaveAttribute(
    'href',
    `${origin}/${database}/${table}/${view}/record`,
  );
  await expect(page.getByRole('button', { name: 'Save page' })).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto(link, { waitUntil: 'commit' });
  await expect(page.getByLabel('Title field', { exact: true })).toHaveValue('title');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByLabel('Riosoma address')).toHaveValue(origin);
  await page.close();
});

test('asks for the address only from the sign-in button and stops when the person refuses', async () => {
  const page = await popup(false);
  await enter(page, `${origin.replace('127.0.0.1', 'riosoma.example.com')}/`);
  await expect(page.getByRole('status')).toHaveText(
    'Enter an address that starts with https:// and has no path, query, or password.',
  );
  expect(await requested(page)).toEqual([]);
  await enter(page);
  await expect(page.getByRole('status')).toHaveText(
    'Allow the clipper to reach your Riosoma address, then sign in again.',
  );
  expect(await requested(page)).toEqual([{ origins: [`${origin}/*`] }]);
  expect(tokenRequests).toBe(0);
  await expect(page.getByLabel('Database', { exact: true })).toBeHidden();
  await page.close();
});

test('keeps the draft after a rejected screenshot and allows an explicit retry without it', async () => {
  writes = [];
  refuseUpload = true;
  const page = await popup();
  await signIn(page);
  await choose(page);
  await page.getByLabel('Include a screenshot').check();
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('status')).toContainText('The request failed.');
  expect(writes).toHaveLength(0);
  await expect(page.getByLabel('Selected text', { exact: true })).toHaveValue('The selected passage');
  await page.getByLabel('Include a screenshot').uncheck();
  await page.getByRole('button', { name: 'Save page' }).click();
  await expect(page.getByRole('status')).toHaveText('Page saved.');
  expect(writes).toHaveLength(1);
  expect(writes[0]!.fields).not.toHaveProperty('image');
  await page.close();
});
