import { saveUploadPolicy } from '../settings-policy';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, createView, openTable, signIn, visit } from '../helpers';
import { invite, share } from '../people';
import { createHash } from 'node:crypto';
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
import { startStack } from '../stack';
import { testWebDirectory } from '../web-build';

test.use({ hasTouch: true, reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });

async function controlled(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
}

async function fits(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
}

async function disconnect(page: Page, browserName: string): Promise<() => Promise<void>> {
  const context = page.context();
  if (browserName !== 'chromium') {
    // Native offline mode bypasses navigation workers in these engines.  WebKit also intercepts
    // navigation before its worker, so fail its API fetches while checking worker-served reloads.
    if (browserName === 'firefox') await context.route('**/*', (route) => route.abort());
    const applyOffline = () => {
      const originalFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = input instanceof Request ? input.url : new URL(String(input), location.href).href;
        if (
          sessionStorage.getItem('test-network-offline') === 'true' &&
          new URL(url).pathname.startsWith('/api/')
        )
          return Promise.reject(new TypeError('Connection unavailable'));
        return originalFetch(input, init);
      };
      if (sessionStorage.getItem('test-network-offline') === 'true') {
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      }
    };
    await page.addInitScript(applyOffline);
    await page.evaluate(applyOffline);
    await page.evaluate(() => {
      sessionStorage.setItem('test-network-offline', 'true');
      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
      window.dispatchEvent(new Event('offline'));
    });
    return async () => {
      if (browserName === 'firefox') await context.unroute('**/*');
      await page.evaluate(() => {
        sessionStorage.removeItem('test-network-offline');
        Reflect.deleteProperty(navigator, 'onLine');
        window.dispatchEvent(new Event('online'));
      });
    };
  }
  // An offline browser may still answer from its HTTP cache.  These API reads must fail.
  await context.route('**/api/**', (route) => route.abort());
  await context.setOffline(true);
  return async () => {
    await context.unroute('**/api/**');
    await context.setOffline(false);
  };
}

test('first installation controls the open page and preserves its theme on an offline reload', async ({
  page: owner,
  browser,
  browserName,
}) => {
  await signIn(owner);
  const context = await browser.newContext({
    hasTouch: true,
    reducedMotion: 'reduce',
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await visit(page, `${base()}/sign-in`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await controlled(page);
  await expect
    .poll(() => page.evaluate(async () => Boolean(await caches.match('/themes/nature/theme.css'))))
    .toBe(true);
  const manifest = await (await page.request.get(`${base()}/manifest.webmanifest`)).json();
  for (const icon of manifest.icons as Array<{ src: string }>) {
    const response = await page.request.get(`${base()}${icon.src}`);
    expect(response.ok()).toBe(true);
    expect(response.headers()['content-type']).toContain('image/');
  }
  const original = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const reconnect = await disconnect(page, browserName);
  try {
    await visit(page, `${base()}/sign-in`);
    await expect(page.getByRole('heading', { name: "Riosoma can't reach its server" })).toBeVisible();
    // Firefox omits worker timing, and its network requests are already blocked above.
    if (browserName === 'webkit') {
      expect(
        await page.evaluate(
          () => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).workerStart,
        ),
      ).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(original);
  } finally {
    await reconnect();
  }
  await page.getByRole('button', { name: 'Try again', exact: true }).tap();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await context.close();
});

test('an installed update waits for an explicit choice before reloading the open page', async ({
  page,
  browserName,
}) => {
  // A deployment changes entry files and build membership, including every lazy chunk's shell import.
  const scratch = resolve(import.meta.dirname, '../../web/.unit-logs');
  mkdirSync(scratch, { recursive: true });
  const temporary = mkdtempSync(join(scratch, 'offline-update-'));
  const active = join(temporary, 'web');
  const next = join(temporary, 'next');
  cpSync(testWebDirectory(), active, { recursive: true });
  cpSync(active, next, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(next, '.vite/manifest.json'), 'utf8')) as Record<
    string,
    { file: string }
  >;
  const entry = manifest['index.html']!.file;
  const before = basename(entry);
  const renamed = new Map(
    readdirSync(join(next, 'assets')).map((file) => [file, file.replace(/(\.[^.]+)$/, '-v2$1')]),
  );
  const after = renamed.get(before)!;
  const references = new RegExp(
    [...renamed.keys()]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'g',
  );
  for (const file of readdirSync(next, { recursive: true, encoding: 'utf8' })) {
    if (!/\.(?:js|css|html|json|map)$/.test(file)) continue;
    const target = join(next, file);
    writeFileSync(
      target,
      readFileSync(target, 'utf8').replace(references, (file) => renamed.get(file)!),
    );
  }
  for (const [before, after] of renamed)
    renameSync(join(next, 'assets', before), join(next, 'assets', after));
  const nextEntry = join(next, 'assets', after);
  writeFileSync(nextEntry, readFileSync(nextEntry, 'utf8') + '\nwindow.__rioTestVersion = "second";\n');
  const revision = createHash('md5')
    .update(readFileSync(join(next, 'index.html')))
    .digest('hex');
  const worker = join(next, 'sw.js');
  writeFileSync(
    worker,
    readFileSync(worker, 'utf8').replace(
      /url:"index\.html",revision:"[^"]+"/,
      `url:"index.html",revision:"${revision}"`,
    ),
  );
  const previousWeb = process.env.RIOSOMA_E2E_WEB_DIR;
  process.env.RIOSOMA_E2E_WEB_DIR = active;
  const stack = await startStack().finally(() => {
    process.env.RIOSOMA_E2E_WEB_DIR = previousWeb;
  });
  const baseKey = `RIOSOMA_E2E_BASE_URL_${browserName}`;
  const previousBase = process.env[baseKey];
  process.env[baseKey] = stack.baseURL;
  try {
    await signIn(page);
    await controlled(page);
    const started = await page.evaluate(() => performance.timeOrigin);
    let loads = 0;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) loads++;
    });
    renameSync(active, join(temporary, 'previous'));
    renameSync(next, active);
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.getRegistration())!.update();
    });
    await expect(page.getByText('A new version of Riosoma is ready', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(started);
    expect(await page.evaluate(() => Reflect.get(window, '__rioTestVersion'))).toBeUndefined();
    expect(await page.locator('script[type="module"][src]').getAttribute('src')).toBe(`/${entry}`);
    expect(loads).toBe(0);
    await page.getByRole('button', { name: 'Update', exact: true }).tap();
    await expect.poll(() => page.evaluate(() => performance.timeOrigin)).not.toBe(started);
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, '__rioTestVersion'))).toBe('second');
    expect(await page.locator('script[type="module"][src]').getAttribute('src')).toBe(`/assets/${after}`);
    expect(loads).toBe(1);
  } finally {
    process.env[baseKey] = previousBase;
    await stack.stop();
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const width of [390, 768]) {
  test.describe(`touch at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test('slow saves keep later edits in order without duplicate commands', async ({ page }) => {
      await signIn(page);
      const database = await createDatabase(page, 'Slow connection', [
        {
          name: 'Records',
          fields: [{ name: 'Name', type: 'text' }],
          records: [{ Name: 'Original' }],
        },
      ]);
      const grid = await openTable(page, database, 'Records');
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sent: string[] = [];
      await page.exposeFunction('waitForSlowSave', async (ids: string[]) => {
        sent.push(...ids);
        await held;
      });
      // A controlled page can send outside page routing.  Delay its real fetch before it leaves.
      await page.evaluate((path) => {
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = input instanceof Request ? input.url : new URL(String(input), location.href).href;
          if (new URL(url).pathname === path && init?.method === 'POST') {
            const batch = JSON.parse(String(init.body)) as { commands: Array<{ id: string }> };
            await (
              window as unknown as { waitForSlowSave: (ids: string[]) => Promise<void> }
            ).waitForSlowSave(batch.commands.map((command) => command.id));
          }
          return originalFetch(input, init);
        };
      }, `/api/databases/${database.id}/commands`);
      try {
        await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
        await page.locator('.rio-grid__input').fill('First edit');
        await page.locator('.rio-grid__input').press('Enter');
        await expect(page.getByRole('status').filter({ hasText: /^Saving/ })).toBeVisible();
        await grid.getByRole('gridcell', { name: 'First edit', exact: true }).dblclick();
        await page.locator('.rio-grid__input').fill('Second edit 東京 🦋 مرحبا');
        await page.locator('.rio-grid__input').press('Enter');
        release();
        await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
        expect(sent).toHaveLength(2);
        expect(new Set(sent).size).toBe(2);
        await visit(page, page.url());
        await expect(
          grid.getByRole('gridcell', { name: 'Second edit 東京 🦋 مرحبا', exact: true }),
        ).toBeVisible();
      } finally {
        release();
      }
    });

    test('connection loss shows immediately, queued edits survive an offline reload, and reconnect replays once', async ({
      page,
      browserName,
    }) => {
      await signIn(page);
      const database = await createDatabase(page, 'Offline 東京 🦋 مرحبا', [
        {
          name: 'Records',
          fields: [{ name: 'Name', type: 'text' }],
          records: [{ Name: 'Original' }],
        },
      ]);
      // Initial rows can arrive after the save badge and worker are ready.
      await page.addInitScript(() => {
        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
          const url = input instanceof Request ? input.url : new URL(String(input), location.href).href;
          if (/^\/api\/views\/[^/]+\/rows$/.test(new URL(url).pathname))
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          return originalFetch(input, init);
        };
      });
      const grid = await openTable(page, database, 'Records');
      await controlled(page);
      await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
      await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
      const reconnect = await disconnect(page, browserName);
      try {
        await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeVisible();
        await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
        const input = page.locator('.rio-grid__input');
        await input.fill('Queued 東京 🦋 مرحبا');
        await input.press('Enter');
        await expect(grid.getByRole('gridcell', { name: 'Queued 東京 🦋 مرحبا', exact: true })).toBeVisible();
        await visit(page, page.url());
        await expect(page.getByRole('heading', { name: "Riosoma can't reach its server" })).toBeVisible();
        if (browserName === 'webkit') {
          expect(
            await page.evaluate(
              () =>
                (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).workerStart,
            ),
          ).toBeGreaterThan(0);
        }
      } finally {
        await reconnect();
      }
      await page.getByRole('button', { name: 'Try again', exact: true }).tap();
      await expect(grid.getByRole('gridcell', { name: 'Queued 東京 🦋 مرحبا', exact: true })).toBeVisible();
      await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
      await visit(page, page.url());
      await expect(grid.getByRole('gridcell', { name: 'Queued 東京 🦋 مرحبا', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Undo history', exact: true }).tap();
      await page
        .getByRole('dialog', { name: 'Undo history' })
        .getByRole('listbox', { name: 'Changes to undo, newest first' })
        .getByRole('option')
        .first()
        .tap();
      await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
      await page
        .getByRole('dialog', { name: 'Undo history' })
        .getByRole('listbox', { name: 'Changes to redo, next first' })
        .getByRole('option')
        .first()
        .tap();
      await expect(grid.getByRole('gridcell', { name: 'Queued 東京 🦋 مرحبا', exact: true })).toBeVisible();
    });

    test('record fields stay above the keyboard when only the visual viewport shrinks', async ({ page }) => {
      await signIn(page);
      const fields = Array.from({ length: 15 }, (_, index) => ({
        name: `Field ${index + 1}`,
        type: 'text',
      }));
      const database = await createDatabase(page, 'Keyboard editing', [
        { name: 'Records', fields, records: [{ 'Field 1': 'Long record', 'Field 15': 'Original' }] },
      ]);
      const table = database.tables.Records!;
      await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`);
      const card = page.getByRole('dialog', { name: 'Long record', exact: true });
      const input = card.getByRole('textbox', { name: 'Field 15', exact: true });
      await input.tap();
      await expect(input).toBeFocused();
      const layoutHeight = await page.evaluate(() => window.innerHeight);
      const originalHeight = (await card.boundingBox())!.height;
      // Desktop engines do not open a phone keyboard.  Preserve the layout viewport while
      // simulating the visible area and its panning, as a phone keyboard does.
      for (const offsetTop of [0, 45]) {
        await page.evaluate((top) => {
          const viewport = window.visualViewport!;
          Object.defineProperty(viewport, 'height', { configurable: true, value: 390 });
          Object.defineProperty(viewport, 'offsetTop', { configurable: true, value: top });
          viewport.dispatchEvent(new Event(top ? 'scroll' : 'resize'));
        }, offsetTop);
        await expect
          .poll(async () => {
            const bounds = await input.boundingBox();
            return Boolean(bounds && bounds.y >= offsetTop && bounds.y + bounds.height <= offsetTop + 390);
          })
          .toBe(true);
        await expect(input).toBeFocused();
        expect(await page.evaluate(() => window.innerHeight)).toBe(layoutHeight);
      }
      await input.fill('Edited above the keyboard 東京 🦋 مرحبا');
      await input.press('Enter');
      await page.evaluate(() => {
        const viewport = window.visualViewport!;
        Reflect.deleteProperty(viewport, 'height');
        Reflect.deleteProperty(viewport, 'offsetTop');
        viewport.dispatchEvent(new Event('resize'));
      });
      await expect.poll(async () => (await card.boundingBox())!.height).toBe(originalHeight);
      await page.keyboard.press('Escape');
      await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`);
      await expect(input).toHaveValue('Edited above the keyboard 東京 🦋 مرحبا');
    });

    test('a queued text conflict retains both drafts and syncs the chosen text after reconnect', async ({
      page,
      browser,
      context,
    }) => {
      await signIn(page);
      const peer = await invite(page, browser, 'Offline Editor');
      try {
        await peer.page.setViewportSize({ width, height: 844 });
        const database = await createDatabase(page, 'Offline conflict', [
          {
            name: 'Records',
            fields: [
              { name: 'Name', type: 'text' },
              { name: 'Notes', type: 'longText' },
            ],
            records: [{ Name: 'Shared record', Notes: 'red green blue' }],
          },
        ]);
        await share(page, database.id, peer, 'editor');
        await openTable(page, database, 'Records');
        await openTable(peer.page, database, 'Records');
        const cell = page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]');
        const other = peer.page.locator('[role="gridcell"][data-rio-row="0"][data-rio-col="1"]');
        await page.bringToFront();
        await context.setOffline(true);
        await page.getByRole('gridcell', { name: 'Shared record', exact: true }).tap();
        await page.locator('.rio-grid__input').press('ArrowRight');
        await page.locator('.rio-grid__input').press('Enter');
        const editor = page.locator('.rio-cell-editor');
        await editor.getByRole('textbox', { name: 'Notes', exact: true }).fill('red purple blue');
        await editor.getByRole('button', { name: 'Save', exact: true }).tap();
        await expect(page.getByRole('status').filter({ hasText: /^Offline$/ })).toBeVisible();
        await peer.page.bringToFront();
        await peer.page.getByRole('gridcell', { name: 'Shared record', exact: true }).click();
        await peer.page.locator('.rio-grid__input').press('ArrowRight');
        await peer.page.locator('.rio-grid__input').press('Enter');
        const peerEditor = peer.page.locator('.rio-cell-editor');
        await peerEditor.getByRole('textbox', { name: 'Notes', exact: true }).fill('red yellow blue');
        await peerEditor.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(other).toContainText('red yellow blue');
        await page.bringToFront();
        await context.setOffline(false);
        const conflict = page.getByRole('dialog', { name: 'Resolve text conflict' });
        await expect(conflict).toBeVisible();
        await expect(conflict.getByRole('textbox', { name: 'Your text' })).toHaveValue('red purple blue');
        await expect(conflict.getByRole('textbox', { name: 'Their text' })).toHaveValue('red yellow blue');
        await conflict.getByRole('button', { name: 'Keep mine', exact: true }).tap();
        await expect(conflict).toHaveCount(0);
        await peer.page.bringToFront();
        await expect(other).toContainText('red purple blue');
        await page.bringToFront();
        await expect(cell).toContainText('red purple blue');
      } finally {
        await context.setOffline(false);
        await peer.context.close();
      }
    });

    test('home, grid, record, views, Rio, automations, and settings stay usable with touch', async ({
      page,
    }) => {
      await signIn(page);
      await fits(page, width);
      const database = await createDatabase(page, 'Mobile 東京 🦋 مرحبا', [
        {
          name: 'Records',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Notes', type: 'text' },
          ],
          records: [{ Name: 'A long record name 東京 🦋 مرحبا '.repeat(5), Notes: 'Editable' }],
        },
      ]);
      const table = database.tables.Records!;
      const gallery = await createView(page, database, 'Records', { name: 'Gallery', type: 'gallery' });
      await openTable(page, database, 'Records');
      await fits(page, width);
      await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`);
      const card = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('textbox', { name: 'Notes', exact: true }) });
      await expect(card).toBeVisible();
      await page.setViewportSize({ width, height: 430 });
      await card.getByRole('textbox', { name: 'Notes', exact: true }).tap();
      await expect(card.getByRole('textbox', { name: 'Notes', exact: true })).toBeInViewport({ ratio: 1 });
      await card.getByRole('textbox', { name: 'Notes', exact: true }).fill('Edited with touch');
      await card.getByRole('textbox', { name: 'Notes', exact: true }).press('Enter');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: 844 });
      await visit(page, `${base()}/${database.id}/${table.id}/${gallery}`);
      await expect(page.getByRole('grid', { name: 'Gallery' })).toBeVisible();
      await fits(page, width);
      await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).tap();
      await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toBeInViewport();
      await page.getByRole('button', { name: 'Close Rio', exact: true }).tap();
      if (width < 768) await page.getByRole('button', { name: 'Menu', exact: true }).tap();
      await page.getByRole('button', { name: 'Add an automation', exact: true }).tap();
      await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
        'Untitled automation',
      );
      await fits(page, width);
      await visit(page, `${base()}/settings/files`);
      const input = page.getByLabel('Maximum upload size (bytes)', { exact: true });
      await input.fill('4096');
      await page.setViewportSize({ width, height: 430 });
      await input.tap();
      await expect(input).toBeInViewport({ ratio: 1 });
      const bar = page.getByRole('region', { name: 'Save changes', exact: true });
      await expect(bar).toBeInViewport();
      await bar.getByRole('button', { name: 'Save', exact: true }).tap();
      await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
      expect(await asOwner(page, 'GET', '/api/org/files')).toEqual({
        maxUploadBytes: 4096,
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      await saveUploadPolicy(page, null);
      await fits(page, width);
    });
  });
}

test('an explicit dark scheme stays readable when the device switches its appearance', async ({ page }) => {
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme: 'night-grove' });
  try {
    await visit(page, `${base()}/`);
    await expect(page.locator('html')).toHaveAttribute('data-scheme', 'night-grove');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
    await page.emulateMedia({ colorScheme: 'light' });
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(background);
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
    await fits(page, 390);
  } finally {
    await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme: 'grove' });
  }
});
