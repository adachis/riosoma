import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { SessionInfo } from '../../../packages/contracts/src';
import { expect, test, type BrowserContext, type Page } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, signIn, visit } from '../helpers';
import { invite } from '../people';
import { testWebDirectory } from '../web-build';

function editorGeometry(element: Element) {
  return [
    ...element.querySelectorAll(
      '.rio-rich-text__toolbar, .rio-rich-text__tool, .rio-rich-text__content, .rio-rich-text__content > *',
    ),
  ].map((node) => ({
    tag: node.tagName,
    class: node.className,
    text: node.textContent,
    box: node.getBoundingClientRect().toJSON(),
    sizing: getComputedStyle(node).boxSizing,
  }));
}

async function backgroundUpdates(context: BrowserContext, denied: boolean, used: boolean) {
  if (used)
    await context.route('**/api/ai/footprint/mine', (route) =>
      route.fulfill({
        json: {
          used: true,
          month: '2026-10-01',
          calls: 1,
          pricedCalls: 1,
          estimatedCalls: 0,
          costUsd: 12.34,
          energyWh: { min: 0, max: 0 },
          gwpG: { min: 0, max: 0 },
          byFeature: [],
        },
      }),
    );
  let requests = 0;
  if (denied)
    await context.route('**/api/admin/updates', async (route) => {
      requests++;
      await route.fulfill({
        status: 403,
        json: { error: { code: 'forbidden', messageKey: 'updates.ownerOnly', userFault: true } },
      });
    });
  return () => requests;
}

function isStartupAsset(file: string) {
  return (
    /^assets\/[^/]+\.(?:js|css)$/.test(file) ||
    /^brand\/[^/]+\.svg$/.test(file) ||
    ['boot.js', 'layers.css', 'pressable.css', 'startup-recovery.js', 'startup-recovery.css'].includes(file)
  );
}

async function precachedAssets(page: Page) {
  return page.evaluate(async () => {
    const assets: Record<string, { bytes: number; sha256: string }> = {};
    for (const name of await caches.keys()) {
      if (!name.includes('precache')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.origin !== location.origin) continue;
        const response = await cache.match(request);
        if (!response?.ok) throw new Error(`Missing successful precache response: ${request.url}`);
        const body = await response.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', body);
        assets[url.pathname.slice(1)] = {
          bytes: body.byteLength,
          sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
        };
      }
    }
    return assets;
  });
}

function startupRequests(context: BrowserContext) {
  const requested = { page: new Set<string>(['index.html']), worker: new Set<string>() };
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(base()).origin) return;
    const file = url.pathname.slice(1);
    if (isStartupAsset(file)) requested[request.serviceWorker() ? 'worker' : 'page'].add(file);
  });
  return requested;
}

async function releaseShell(page: Page, context: BrowserContext, denied: boolean, used: boolean) {
  // The release budget protects shipped startup bytes.  Language and cache coverage use the
  // all-language artifact separately, since its language picker changes the static shell graph.
  const directory = resolve(import.meta.dirname, '../../web/dist');
  const report = JSON.parse(readFileSync(resolve(directory, 'bundle-report.json'), 'utf8')) as {
    shell: { budget: number; locales: Array<{ locale: string; files: string[] }> };
  };
  expect(report.shell.locales.map((locale) => locale.locale)).toEqual(['en-US']);
  const allowed = new Set(report.shell.locales[0]!.files);
  await context.route(`${base()}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (allowed.has(path) || /^brand\/riosoma-(?:lockup|wordmark|mascot)(?:-mask)?\.svg$/.test(path))
      await route.fulfill({ path: resolve(directory, path) });
    else await route.fallback();
  });
  const deniedRequests = await backgroundUpdates(context, denied, used);
  // The default first screen must include its visible wordmark even after a branding spec runs.
  await context.route('**/api/auth/session', async (route) => {
    const response = await route.fetch();
    const session = (await response.json()) as SessionInfo;
    delete session.org.settings.logo;
    await route.fulfill({ response, json: session });
  });
  const requested = startupRequests(context).page;
  await visit(page, base());
  await expect(page.locator('.rio-home-databases')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US');
  await expect(page.locator('.rio-shell__brand .rio-brand')).toBeVisible();
  await expect(page.locator('.rio-shell__brand .rio-brand')).toHaveAttribute('data-variant', 'wordmark');
  // Spending appears when Rio opens in release builds too.
  await expect(page.locator('.rio-footprint-pill')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  if (denied) expect(deniedRequests()).toBeGreaterThan(0);
  expect(requested.has('brand/riosoma-wordmark-mask.svg')).toBe(true);
  expect([...requested].sort()).toEqual([...allowed].sort());
  const sizes = [...requested].map((file) => ({
    file,
    gzip: gzipSync(readFileSync(resolve(directory, file))).length,
  }));
  await test.info().attach('release-cold-shell-assets', {
    body: JSON.stringify(sizes),
    contentType: 'application/json',
  });
  expect(sizes.reduce((sum, asset) => sum + asset.gzip, 0)).toBeLessThanOrEqual(report.shell.budget);
}

for (const [denied, used] of [
  [false, false],
  [true, false],
  [false, true],
] as const) {
  test(`a cold home screen stays within the shell budget with background updates ${denied ? 'denied' : 'available'}${used ? ' and monthly AI use' : ''}`, async ({
    page: owner,
    browser,
    browserName,
  }) => {
    await signIn(owner);
    // A fresh person's language cannot race with appearance and help specs on the owner's account.
    const person = await invite(owner, browser, 'Cold home reader');
    const page = person.page;
    await asOwner(owner, 'PATCH', `/api/org/members/${person.id}/role`, { role: 'owner' });
    await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'fr' });
    const context = await browser.newContext({ storageState: await page.context().storageState() });
    const deniedRequests = await backgroundUpdates(context, denied, used);
    const requested = startupRequests(context);
    try {
      const home = await context.newPage();
      await visit(home, base());
      await expect(home.locator('.rio-home-databases')).toBeVisible();
      await expect(home.locator('html')).toHaveAttribute('lang', 'fr');
      // AI spending lives in Rio's panel, so a cold home screen neither shows nor loads it.
      await expect(home.locator('.rio-footprint-pill')).toHaveCount(0);
      await home.evaluate(async () => {
        await navigator.serviceWorker.ready;
      });
      await home.waitForLoadState('networkidle');
      if (denied) expect(deniedRequests()).toBeGreaterThan(0);
      const directory = testWebDirectory();
      const report = JSON.parse(readFileSync(resolve(directory, 'bundle-report.json'), 'utf8')) as {
        shell: { budget: number; locales: Array<{ locale: string; files: string[] }> };
        precache: { budget: number; gzip: number; files: string[] };
      };
      const manifest = JSON.parse(readFileSync(resolve(directory, '.vite/manifest.json'), 'utf8')) as Record<
        string,
        { file: string }
      >;
      const catalogs = new Set(
        Object.entries(manifest)
          .filter(([key]) => key.includes('/locales/'))
          .map(([, value]) => value.file),
      );
      expect([...requested.page].filter((file) => catalogs.has(file))).toEqual([
        manifest['src/locales/fr/messages.po?shell']!.file,
      ]);
      await home.waitForFunction(async (file) => {
        const cache = await caches.open('rio-app-assets');
        return Boolean(await cache.match(new URL(file, location.origin)));
      }, manifest['src/locales/fr/messages.po?shell']!.file);
      const allowed = new Set(report.shell.locales.find((locale) => locale.locale === 'fr')!.files);
      expect([...requested.page].sort()).toEqual([...allowed].sort());
      expect(report.precache.files.filter((file) => requested.page.has(file))).toEqual([]);
      // Playwright exposes service-worker request owners only in Chromium.  Every engine must
      // install the exact recovery graph with the actual built contents in its precache.
      const cached = await precachedAssets(home);
      const workerExtras = Object.keys(cached)
        .filter((file) => isStartupAsset(file) && !allowed.has(file))
        .sort();
      expect(workerExtras).toEqual(report.precache.files);
      if (browserName === 'chromium')
        expect([...requested.worker].filter((file) => !allowed.has(file)).sort()).toEqual(workerExtras);
      const recoverySizes = workerExtras.map((file) => {
        const contents = readFileSync(resolve(directory, file));
        expect(cached[file]).toEqual({
          bytes: contents.length,
          sha256: createHash('sha256').update(contents).digest('hex'),
        });
        return { file, gzip: gzipSync(contents).length };
      });
      const recoveryGzip = recoverySizes.reduce((sum, asset) => sum + asset.gzip, 0);
      expect(recoveryGzip).toBe(report.precache.gzip);
      expect(recoveryGzip).toBeLessThanOrEqual(report.precache.budget);
      const sizes = [...requested.page].map((file) => ({
        file,
        gzip: gzipSync(readFileSync(resolve(directory, file))).length,
      }));
      await test.info().attach('cold-shell-assets', {
        body: JSON.stringify({ page: sizes, workerPrecache: recoverySizes }),
        contentType: 'application/json',
      });
      await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'en-US' });
      const release = await browser.newContext({
        storageState: await page.context().storageState(),
        serviceWorkers: 'block',
      });
      try {
        await releaseShell(await release.newPage(), release, denied, used);
      } finally {
        await release.close();
      }
    } finally {
      await context.close();
      await asOwner(owner, 'PATCH', `/api/org/members/${person.id}/role`, { role: 'member' });
      await person.context.close();
    }
  });
}

for (const width of [390, 1280]) {
  test(`a fresh attachment menu loads cloud drives at ${width} pixels`, async ({ page, browser }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Cloud attachments', [
      {
        name: 'Records',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Files', type: 'attachment' },
        ],
        records: [{ Name: 'Cloud record' }],
      },
    ]);
    const context = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width, height: 844 },
      serviceWorkers: 'block',
    });
    let requests = 0;
    await context.route('**/api/connections', async (route) => {
      requests++;
      await route.fulfill({ json: { providers: [{ provider: 'dropbox', available: true, account: null }] } });
    });
    try {
      const record = await context.newPage();
      const table = database.tables.Records!;
      await visit(record, `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`);
      await record.getByRole('button', { name: 'More ways to add' }).click();
      await expect(record.getByRole('menuitem', { name: 'From Dropbox' })).toBeVisible();
      expect(requests).toBe(1);
    } finally {
      await context.close();
    }
  });

  test(`Rio stays closed after navigation at ${width} pixels`, async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await page.getByRole('button', { name: 'Close Rio', exact: true }).click();
    await page.getByRole('link', { name: 'Recent', exact: true }).click();
    await expect(page).toHaveURL(`${base()}/home/recent`);
    await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'AI: Ask Rio', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close Rio', exact: true })).toBeVisible();
  });
}

test.describe('editor loading', () => {
  // The request must reach the route handler so the test can hold the editor chunk open.
  test.use({ serviceWorkers: 'block' });
  for (const width of [390, 1280]) {
    test(`a directly opened rich-text record reserves its editor height at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      await signIn(page);
      const database = await createDatabase(page, 'Editor geometry', [
        {
          name: 'Records',
          fields: [
            { name: 'Name', type: 'text' },
            { name: 'Notes', type: 'longText', options: { richText: true } },
            { name: 'After notes', type: 'text' },
          ],
          records: [
            {
              Name: 'Geometry record',
              Notes:
                '## Heading\n\nA paragraph with **strong text** and a [link](https://example.com).\n\n- [x] First item\n- [ ] Second item\n\nAnother paragraph.',
              'After notes': 'Still here',
            },
          ],
        },
      ]);
      const manifest = JSON.parse(
        readFileSync(resolve(testWebDirectory(), '.vite/manifest.json'), 'utf8'),
      ) as Record<string, { file: string }>;
      const editor = manifest['src/fields/richText/RichTextInput.tsx']!;
      let release!: () => void;
      const pending = new Promise<void>((done) => {
        release = done;
      });
      await page.route(`${base()}/${editor.file}`, async (route) => {
        await pending;
        await route.continue();
      });
      const table = database.tables.Records!;
      const navigation = page.goto(
        `${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`,
      );
      try {
        // Navigation checks the old document first.  Let the replacement app screen finish booting
        // before starting the preview assertion while its editor chunk is held open.
        await page.waitForURL(`${base()}/${database.id}/${table.id}/${table.viewId}/${table.records[0]}`, {
          waitUntil: 'commit',
        });
        await page.locator('.rio-database-screen:not([aria-busy="true"])').waitFor();
        const preview = page.locator('.rio-rich-text-preview');
        await expect(preview).toBeVisible();
        await expect(preview.locator('h2')).toHaveText('Heading');
        await expect(page.locator('[data-entering], [data-exiting]')).toHaveCount(0);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        const before = await preview.boundingBox();
        const beforeDetails = await preview.evaluate(editorGeometry);
        const following = page.getByRole('textbox', { name: 'After notes', exact: true });
        const followingBefore = await following.boundingBox();
        release();
        await navigation;
        await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toBeVisible();
        const after = await page.locator('.rio-rich-text').boundingBox();
        const followingAfter = await following.boundingBox();
        await test.info().attach('editor-geometry', {
          body: JSON.stringify({
            before: beforeDetails,
            after: await page.locator('.rio-rich-text').evaluate(editorGeometry),
          }),
          contentType: 'application/json',
        });
        expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
        expect(Math.abs(followingAfter!.y - followingBefore!.y)).toBeLessThanOrEqual(1);
      } finally {
        release();
        await navigation;
      }
    });
  }
});
