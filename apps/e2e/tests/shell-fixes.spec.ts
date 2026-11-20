import type { Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, OWNER, runCommands, signIn, visit } from '../helpers';
import { testWebDirectory } from '../web-build';
import { invite } from '../people';

test.use({ serviceWorkers: 'block' });

test('keeps Rio controls inside a narrow tablet panel beside Help with history and monthly usage', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const conversations = Array.from({ length: 11 }, (_, index) => ({
    id: `conversation-${index}`,
    title: `Planning reference material and implementation requirements ${index}`,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-01T12:00:00Z',
  }));
  await page.route('**/api/rio/status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        paused: false,
        tiers: ['everyday', 'power'],
        autonomy: 'previewBig',
        diagnose: true,
        routines: false,
        routineRunLimitUsd: 1,
      },
    }),
  );
  await page.route('**/api/rio/conversations', (route) => route.fulfill({ json: conversations }));
  await page.route('**/api/rio/active-conversation', (route) =>
    route.fulfill({ json: { conversation: conversations[0], messages: [] } }),
  );
  await page.route('**/api/ai/footprint/mine', (route) =>
    route.fulfill({
      json: {
        used: true,
        month: '2026-10-01',
        calls: 1,
        estimatedCalls: 0,
        pricedCalls: 1,
        costUsd: 12.34,
        energyWh: { min: 0.1, max: 0.1 },
        gwpG: { min: 0.06, max: 0.06 },
        byFeature: [],
      },
    }),
  );
  await signIn(page);
  await visit(page, `${base()}/`);
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  const help = page.locator('.rio-shell__dock');
  await expect(help).toBeVisible();
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const panel = page.locator('.rio-assistant__panel');
  await expect(panel.getByRole('button', { name: /^Your AI use this month:/ })).toBeVisible();
  const history = panel.getByRole('button', { name: /Past conversations$/ });
  await expect(history).toBeVisible();
  expect((await panel.locator('.rio-assistant__header').boundingBox())!.height).toBeLessThanOrEqual(80);
  await expect
    .poll(() =>
      panel.locator('.rio-assistant__header button:visible').evaluateAll((buttons) => {
        const bounds = buttons[0]!.closest('.rio-assistant__panel')!.getBoundingClientRect();
        return buttons
          .filter((button) => {
            const box = button.getBoundingClientRect();
            return box.left < bounds.left || box.right > Math.min(bounds.right, innerWidth);
          })
          .map((button) => button.getAttribute('aria-label'));
      }),
    )
    .toEqual([]);
  const close = panel.getByRole('button', { name: 'Close Rio', exact: true });
  await separate(close, history);
  const mascot = panel.locator('.rio-assistant__mascot');
  await separate(mascot, panel.getByRole('textbox'));
  for (const label of ['Quick', 'Thorough']) {
    const control = panel.getByRole('button', { name: label, exact: true });
    const box = (await control.boundingBox())!;
    const bounds = (await panel.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.width).toBeLessThanOrEqual(Math.min(bounds.x + bounds.width, 768));
    await separate(mascot, control);
  }
  await history.click();
  await expect(page.getByRole('option')).toHaveCount(12);
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: 'More Rio actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'New conversation', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await close.focus();
  await expect(close).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(help).toBeVisible();
});

async function separate(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(
    a!.x + a!.width <= b!.x + 0.5 ||
      b!.x + b!.width <= a!.x + 0.5 ||
      a!.y + a!.height <= b!.y + 0.5 ||
      b!.y + b!.height <= a!.y + 0.5,
  ).toBe(true);
}

for (const width of [1440, 900, 390]) {
  for (const scheme of ['grove', 'night-grove']) {
    test(`keeps personal actions, Rio, and shortcut groups clear at ${width} pixels in ${scheme}`, async ({
      page: owner,
      browser,
    }, info) => {
      test.setTimeout(120_000);
      await signIn(owner);
      // Personal preferences belong to this case even while other files use the owner's account.
      const person = await invite(owner, browser, 'Shell appearance reader');
      const page = person.page;
      try {
        await page.setViewportSize({ width, height: 900 });
        await asOwner(page, 'PATCH', '/api/me/preferences', {
          theme: 'nature',
          scheme,
          locale: 'en-US',
          level: 'advanced',
          recordLayout: 'card',
        });
        const database = await createDatabase(page, 'A database with a long name for narrow toolbars', [
          {
            name: 'Records',
            fields: [
              { name: 'Name', type: 'text' },
              ...Array.from({ length: 12 }, (_, index) => ({ name: `Column ${index + 1}`, type: 'text' })),
            ],
            records: Array.from({ length: 45 }, (_, index) => ({ Name: `Record ${index + 1}` })),
          },
        ]);
        const table = database.tables.Records!;
        const address = `${base()}/${database.id}/${table.id}/${table.viewId}`;
        await visit(page, address);
        await expect(page.locator('.rio-db-header')).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
        const personal = page.getByRole('button', { name: /: Personal menu$/ });
        await expect(
          page.locator('.rio-shell__header').getByRole('button', { name: 'Help', exact: true }),
        ).toHaveCount(0);
        await expect(
          page.locator('.rio-shell__header').getByRole('button', { name: 'Sign out', exact: true }),
        ).toHaveCount(0);
        await page
          .locator('.rio-shell__header')
          .screenshot({ path: info.outputPath(`after-header-${width}-${scheme}.png`) });
        await page
          .locator('.rio-shell__footer')
          .screenshot({ path: info.outputPath(`after-footer-platform-${width}-${scheme}.png`) });
        await personal.click();
        await expect(page.getByRole('menu')).toContainText(person.name);
        await expect(page.getByRole('menu')).toContainText(person.email);
        await page.screenshot({ path: info.outputPath(`after-personal-menu-${width}-${scheme}.png`) });
        await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
        const appearance = page.getByRole('dialog', { name: 'Appearance', exact: true });
        await appearance.getByRole('button', { name: /Theme/ }).click();
        await page.getByRole('option', { name: 'Bauhaus', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'bauhaus');
        await expect
          .poll(
            async () =>
              (await asOwner<{ preferences: { theme: string } }>(page, 'GET', '/api/auth/session'))
                .preferences.theme,
          )
          .toBe('bauhaus');
        await appearance.getByRole('button', { name: /Color scheme/ }).click();
        await page.getByRole('option', { name: 'Midnight', exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-scheme', 'midnight');
        await appearance.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page).toHaveURL(address);
        await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme });
        await page.reload();
        await expect(page.locator('html')).toHaveAttribute('data-scheme', scheme);
        await personal.click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        await expect(page).toHaveURL(/returnTo=/);
        await page.getByRole('link', { name: 'Experience level', exact: true }).click();
        await page.getByRole('button', { name: 'Close settings', exact: true }).click();
        await expect(page).toHaveURL(address);
        await personal.click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        await page.goBack();
        await expect(page).toHaveURL(address);
        const launcher = page.locator('.rio-assistant__trigger button');
        const footer = page.locator('.rio-shell__footer');
        const scroller = page.locator('.rio-grid__scroller');
        await expect(scroller).toBeVisible();
        await scroller.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
          element.scrollLeft = element.scrollWidth;
        });
        await separate(launcher, scroller);
        const gridBox = (await scroller.boundingBox())!;
        const footerBox = (await footer.boundingBox())!;
        const launcherBox = (await launcher.boundingBox())!;
        expect(footerBox.height).toBeCloseTo(32, 0);
        expect(gridBox.y + gridBox.height).toBeLessThanOrEqual(footerBox.y + 0.5);
        // The AI button that opens Rio sits in the header at every width, never over the grid or the footer.
        const headerBox = (await page.locator('.rio-shell__header').boundingBox())!;
        expect(launcherBox.y).toBeGreaterThanOrEqual(headerBox.y);
        expect(launcherBox.y + launcherBox.height).toBeLessThanOrEqual(headerBox.y + headerBox.height);
        await expect(footer.locator('.rio-assistant__trigger')).toHaveCount(0);
        await expect(launcher.locator('.rio-avatar')).toHaveCount(0);
        if (width >= 768) await expect(launcher).toContainText('AI');
        await separate(launcher, page.getByRole('button', { name: /: Personal menu$/ }));
        await launcher.click();
        const panel = page.locator('.rio-assistant__panel');
        await expect(panel).toBeVisible();
        // A larger Rio stands at the corner of the conversation, clear of the text box and its buttons.
        const mascot = panel.locator('.rio-assistant__mascot .rio-avatar');
        await expect(mascot).toBeVisible();
        const mascotBox = (await mascot.boundingBox())!;
        expect(mascotBox.width).toBeGreaterThanOrEqual(width >= 768 ? 140 : 84);
        await expect(panel.locator('.rio-assistant__header .rio-avatar')).toHaveCount(0);
        await separate(mascot, panel.getByRole('textbox'));
        for (const control of await panel.locator('.rio-assistant__composer button:visible').all())
          await separate(mascot, control);
        const panelBox = (await panel.boundingBox())!;
        expect(mascotBox.x + mascotBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width);
        await page.screenshot({ path: info.outputPath(`after-rio-footer-${width}-${scheme}.png`) });
        await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
        await personal.click();
        await page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true }).click();
        const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true });
        await expect(shortcuts.getByRole('heading', { name: 'Grid', exact: true })).toBeVisible();
        const groups = shortcuts.locator('.rio-shortcuts-group');
        await expect.poll(() => groups.count()).toBeGreaterThan(2);
        const columns = await groups.evaluateAll(
          (elements) =>
            new Set(elements.map((element) => Math.round(element.getBoundingClientRect().left))).size,
        );
        expect(columns).toBe(width === 390 ? 1 : width === 900 ? 2 : 3);
        const dialogBox = (await shortcuts.boundingBox())!;
        expect(dialogBox.width).toBeLessThanOrEqual(width);
        expect(dialogBox.height).toBeLessThanOrEqual(900);
        const body = shortcuts.locator('.rio-shortcuts-body');
        const groupsBox = (await shortcuts.locator('.rio-shortcuts-groups').boundingBox())!;
        const bodyBox = (await body.boundingBox())!;
        expect(groupsBox.width).toBeGreaterThanOrEqual(bodyBox.width - 20);
        await page.screenshot({ path: info.outputPath(`after-keyboard-shortcuts-${width}-${scheme}.png`) });
        const filter = shortcuts.getByRole('searchbox', { name: 'Filter shortcuts' });
        await filter.fill('Save settings');
        await filter.press('Enter');
        await expect(shortcuts.locator('.rio-shortcuts-row')).toHaveCount(1);
        await expect(shortcuts.locator('.rio-shortcuts-row')).toContainText('Save settings changes');
        await filter.fill('Ctrl+K');
        // Desktop browser projects use the platform of the device they emulate.
        const apple = await page.evaluate(
          () => /mac|iphone|ipad|ipod/i.test(navigator.userAgent) || /^mac/i.test(navigator.platform),
        );
        if (apple) await filter.fill('⌘K');
        await expect(shortcuts.locator('.rio-shortcuts-row')).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(shortcuts).toHaveCount(0);
        await expect(personal).toBeFocused();
        if (width >= 768) {
          await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
          const recordAddress = `${address}/${table.records[0]}`;
          await visit(page, recordAddress);
          const recordPanel = page.locator('.rio-record-surface--panel');
          await expect(recordPanel).toBeVisible();
          await separate(launcher, recordPanel);
          await personal.click();
          await page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true }).click();
          await expect(shortcuts.locator('.rio-shortcuts-group h3').first()).toHaveText('Records');
          await page.keyboard.press('Escape');
          await expect(shortcuts).toHaveCount(0);
          await launcher.click();
          await expect(panel).toBeVisible();
          await separate(recordPanel, page.locator('.rio-assistant__dock'));
          await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
          await personal.click();
          await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
          await page.getByRole('button', { name: 'Close settings', exact: true }).click();
          await expect(page).toHaveURL(recordAddress);
          await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'card' });
          await visit(page, address);
        }
        await personal.click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        const saveBar = page.getByRole('region', { name: 'Save changes', exact: true });
        await expect(saveBar).toBeVisible();
        await separate(saveBar.getByRole('status'), saveBar.locator('.rio-settings-save-bar__actions'));
        if (width >= 768) await separate(launcher, saveBar);
        await launcher.click();
        await expect(panel).toBeVisible();
        await separate(launcher, panel.locator('.rio-assistant__composer'));
        if (width >= 768) await separate(saveBar, page.locator('.rio-assistant__dock'));
        await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
        for (const action of ['Save', 'Discard']) {
          const box = (await saveBar.getByRole('button', { name: action, exact: true }).boundingBox())!;
          expect(box.y).toBeGreaterThanOrEqual((await footer.boundingBox())!.y);
          expect(box.y + box.height).toBeLessThanOrEqual(900);
        }
      } finally {
        await person.context.close();
      }
    });
  }
}

test('keeps the startup shell below its compressed size budget', async () => {
  const info = test.info();
  // The release budget measures shipped English assets, including the visible wordmark.
  const directory = resolve(import.meta.dirname, '../../web/dist');
  const report = JSON.parse(readFileSync(`${directory}/bundle-report.json`, 'utf8')) as {
    shell: { largest: { files: string[] }; locales: Array<{ locale: string }> };
  };
  expect(report.shell.locales.map(({ locale }) => locale)).toEqual(['en-US']);
  expect(report.shell.largest.files).toContain('brand/riosoma-wordmark-mask.svg');
  const sizes = report.shell.largest.files.map((path) => ({
    path,
    bytes: gzipSync(readFileSync(`${directory}/${path}`)).length,
  }));
  const bytes = sizes.reduce((sum, asset) => sum + asset.bytes, 0);
  await info.attach('startup-assets', {
    body: JSON.stringify({ bytes, sizes }),
    contentType: 'application/json',
  });
  expect(bytes).toBeLessThan(250_000);
});

test('renders an existing custom database icon on Home', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Existing custom icon files', [
    { name: 'Items', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await visit(page, base());
  const card = page.locator(`a[href="/${database.id}"]`);
  const path = card.locator('.rio-database-icon svg path');
  await expect(path).toBeVisible();
  const defaultPath = await path.getAttribute('d');
  expect(defaultPath).toBeTruthy();
  await runCommands(page, database.id, [{ kind: 'database.update', icon: 'book-open' }]);
  await page.reload();
  await expect(path).not.toHaveAttribute('d', defaultPath!);
  // Keep this card on the shared Home so the next case also covers existing custom icons.
});

test('loads custom database icons on demand and keeps Home usable if their catalog is unavailable', async ({
  page: owner,
  browser,
}) => {
  await signIn(owner);
  // Other specs can leave custom-icon cards on the owner's Home.
  const person = await invite(owner, browser, 'Database icon reader');
  const page = person.page;
  try {
    // Duplicate names keep the card lookup tied to its database.
    const sameName = await createDatabase(page, 'Named icon files', [
      { name: 'Items', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const database = await createDatabase(page, 'Named icon files', [
      { name: 'Items', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const home = await asOwner<{ databases: Array<{ id: string }> }>(page, 'GET', '/api/home');
    const created = [sameName.id, database.id].sort();
    expect(
      home.databases
        .map(({ id }) => id)
        .filter((id) => created.includes(id))
        .sort(),
    ).toEqual(created);
    const manifest = JSON.parse(
      readFileSync(resolve(testWebDirectory(), '.vite/manifest.json'), 'utf8'),
    ) as Record<string, { file: string }>;
    const catalog = manifest['src/screens/home/databaseIcons.ts']!.file;
    const requested: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/${catalog}`) requested.push(request.url());
    });
    await visit(page, base());
    const card = page
      .getByRole('link', { name: /^Named icon files Updated/ })
      .and(page.locator(`[href="/${database.id}"]`));
    const icon = card.locator('.rio-database-icon svg');
    await expect(icon).toBeVisible();
    const defaultPath = await icon.locator('path').getAttribute('d');
    expect(defaultPath).toBeTruthy();
    expect(requested).toEqual([]);
    const box = await icon.boundingBox();
    try {
      await runCommands(page, database.id, [{ kind: 'database.update', icon: 'book-open' }]);
      await page.reload();
      await expect(icon.locator('path')).not.toHaveAttribute('d', defaultPath!);
      expect(new Set(requested).size).toBe(1);
      const namedBox = await icon.boundingBox();
      expect(namedBox!.width).toBe(box!.width);
      expect(namedBox!.height).toBe(box!.height);
      // WebKit can reuse a loaded module across reloads, so block it before a fresh context visits Home.
      const unavailable = await browser.newContext({
        serviceWorkers: 'block',
        storageState: await person.context.storageState(),
      });
      try {
        const blocked: string[] = [];
        await unavailable.route(`**/${catalog}`, (route) => {
          blocked.push(new URL(route.request().url()).pathname);
          return route.abort();
        });
        const fallbackPage = await unavailable.newPage();
        await visit(fallbackPage, base());
        const fallbackCard = fallbackPage
          .getByRole('link', { name: /^Named icon files Updated/ })
          .and(fallbackPage.locator(`[href="/${database.id}"]`));
        await expect.poll(() => blocked).toEqual([`/${catalog}`]);
        await expect(fallbackCard.locator('.rio-database-icon svg path')).toHaveAttribute('d', defaultPath!);
        await expect(fallbackCard).toBeVisible();
        await fallbackCard.click();
        await expect(fallbackPage.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
      } finally {
        await unavailable.close();
      }
    } finally {
      await runCommands(page, database.id, [{ kind: 'database.update', icon: null }]);
    }
  } finally {
    await person.context.close();
  }
});

for (const scheme of ['grove', 'night-grove']) {
  test(`keeps organization branding and settings actions clear of the AI button and the Rio panel in ${scheme}`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await signIn(page);
    await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'nature', scheme });
    await asOwner(page, 'POST', '/api/org/admin-commands', {
      kind: 'organization.logo',
      main: {
        type: 'image/svg+xml',
        data: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50"><path d="M0 5H195V45H0Z"/></svg>',
        ).toString('base64'),
      },
      compact: null,
      mode: 'theme',
    });
    try {
      for (const width of [1440, 900, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await visit(page, `${base()}/`);
        const footer = page.locator('.rio-shell__footer');
        const brand = footer.locator('.rio-shell__footer-brand');
        const launcher = page.getByRole('button', { name: 'AI: Ask Rio', exact: true });
        await expect(
          page.locator('.rio-shell__brand').getByRole('img', { name: OWNER.org, exact: true }),
        ).toBeVisible();
        await expect(brand.getByRole('img', { name: 'Riosoma', exact: true })).toBeVisible();
        await expect(brand).toContainText('Version');
        await separate(brand, launcher);
        await page
          .locator('.rio-shell__header')
          .screenshot({ path: info.outputPath(`after-header-organization-${width}-${scheme}.png`) });
        await footer.screenshot({
          path: info.outputPath(`after-footer-organization-${width}-${scheme}.png`),
        });
        await page.getByRole('button', { name: /: Personal menu$/ }).click();
        await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
        const bar = page.getByRole('region', { name: 'Save changes', exact: true });
        await expect(bar).toBeVisible();
        await expect(brand.getByText(/^Version /)).toBeVisible();
        await separate(brand, bar);
        await separate(brand, bar.locator('.rio-settings-save-bar__actions'));
        await separate(bar.getByRole('status'), bar.locator('.rio-settings-save-bar__actions'));
        for (const action of ['Save', 'Discard']) {
          const box = (await bar.getByRole('button', { name: action, exact: true }).boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        if (width >= 768) await separate(bar, launcher);
        await footer.screenshot({
          path: info.outputPath(`after-footer-organization-settings-${width}-${scheme}.png`),
        });
        await launcher.click();
        const panel = page.locator('.rio-assistant__panel');
        await expect(panel).toBeVisible();
        await separate(launcher, panel.locator('.rio-assistant__composer'));
        if (width >= 768) {
          await separate(brand, page.locator('.rio-assistant__dock'));
          await separate(bar, page.locator('.rio-assistant__dock'));
        }
        await page.screenshot({
          path: info.outputPath(`after-assistant-organization-${width}-${scheme}.png`),
        });
        await panel.getByRole('button', { name: 'Close Rio', exact: true }).click();
      }
    } finally {
      await asOwner(page, 'POST', '/api/org/admin-commands', {
        kind: 'organization.logo',
        main: null,
        compact: null,
        mode: 'theme',
      });
    }
  });
}

test('explains a forced database theme while saving personal appearance for the next screen', async ({
  page,
}) => {
  await signIn(page);
  await asOwner(page, 'PATCH', '/api/me/preferences', { theme: 'bauhaus', scheme: 'werkbund' });
  const database = await createDatabase(page, 'Fixed appearance', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Records!;
  await runCommands(page, database.id, [
    { kind: 'database.update', theme: { id: 'bauhaus', scheme: 'werkbund' } },
  ]);
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'bauhaus');
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Appearance', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await expect(dialog.getByRole('note')).toContainText('This database uses a fixed theme.');
  await dialog.getByRole('button', { name: /Theme/ }).click();
  await page.getByRole('option', { name: 'Nature', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await asOwner<{ preferences: { theme: string } }>(page, 'GET', '/api/auth/session')).preferences
          .theme,
    )
    .toBe('nature');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'bauhaus');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'nature');
});

test('keeps a long conversation title and header controls clear in narrow panels', async ({
  page: owner,
  browser,
}) => {
  await signIn(owner);
  const person = await invite(owner, browser, 'Rio header reader');
  const page = person.page;
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { locale: 'en-US', level: 'advanced' });
    await page.route('**/api/rio/status', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...(await response.json()), routines: true } });
    });
    // Monthly usage is an intentional fifth header control and must not depend on earlier Rio calls.
    await page.route('**/api/ai/footprint/mine', (route) =>
      route.fulfill({
        json: {
          used: true,
          month: new Date().toISOString().slice(0, 7),
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
    const timestamp = new Date().toISOString();
    const conversation = {
      id: crypto.randomUUID(),
      title: 'A conversation about a database with a long name '.repeat(4).trim(),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const history = [
      conversation,
      ...Array.from({ length: 10 }, (_, index) => ({
        ...conversation,
        id: crypto.randomUUID(),
        title: `Conversation ${index + 1}`,
      })),
    ];
    await page.route('**/api/rio/conversations', (route) => route.fulfill({ json: history }));
    await page.route('**/api/rio/active-conversation', (route) =>
      route.fulfill({ json: { conversation, messages: [] } }),
    );
    await visit(page, base());
    for (const [width, panelWidth] of [
      [900, 480],
      [390, 390],
      [900, 265],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.rio-assistant__trigger button').click();
      const panel = page.locator('.rio-assistant__panel');
      await expect(panel).toBeVisible();
      if (panelWidth === 265)
        await panel.evaluate((element) => {
          element.style.inlineSize = '265px';
        });
      const header = panel.locator('.rio-assistant__header');
      await expect(header.locator('.rio-select__value')).toHaveText(conversation.title);
      await expect(header.getByRole('button', { name: /^Your AI use this month:/ })).toBeVisible();
      const headerBox = (await header.boundingBox())!;
      expect(headerBox.height).toBeLessThanOrEqual(80);
      const controls = header.locator('button:visible');
      const count = await controls.count();
      for (let index = 0; index < count; index++) {
        const control = controls.nth(index);
        const box = (await control.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(headerBox.x);
        expect(box.x + box.width).toBeLessThanOrEqual(headerBox.x + headerBox.width);
        for (let next = index + 1; next < count; next++) await separate(control, controls.nth(next));
      }
      await expect(controls).toHaveCount(panelWidth === 265 ? 4 : 5);
      if (panelWidth === 265) {
        await header.getByRole('button', { name: 'More Rio actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Routines', exact: true }).click();
        await expect(panel.locator('.rio-assistant__composer')).toBeHidden();
      } else await expect(header.getByRole('button', { name: 'Routines', exact: true })).toBeVisible();
      await header.getByRole('button', { name: 'Close Rio', exact: true }).click();
    }
  } finally {
    await person.context.close();
  }
});

test('keeps personal actions inside a phone header with updates and monthly usage', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.route('**/api/admin/updates', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      json: { ...(await response.json()), security: true, available: [{ version: '99.0.0' }] },
    });
  });
  await page.route('**/api/ai/footprint/mine', (route) =>
    route.fulfill({
      json: {
        used: true,
        month: new Date().toISOString().slice(0, 7),
        calls: 123,
        pricedCalls: 123,
        estimatedCalls: 123,
        costUsd: 123.45,
        energyWh: { min: 10, max: 20 },
        gwpG: { min: 10, max: 20 },
        byFeature: [],
      },
    }),
  );
  await visit(page, `${base()}/settings/ai`);
  const personal = page.getByRole('button', { name: /: Personal menu$/ });
  await page.screenshot({ path: info.outputPath('packed-phone-header.png') });
  const box = (await personal.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const brand = page.locator('.rio-shell__brand');
  const brandBox = (await brand.boundingBox())!;
  const markBox = (await brand.getByRole('img').boundingBox())!;
  expect(markBox.x + markBox.width).toBeLessThanOrEqual(brandBox.x + brandBox.width + 0.5);
  await separate(brand, personal);
  await page.getByRole('button', { name: 'More header controls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Security update: Riosoma 99.0.0' })).toBeVisible();
  // AI spending is part of Rio's panel, not of the app's header or its overflow.
  await expect(page.getByRole('button', { name: /^Your AI use this month:/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
  const rioHeader = page.locator('.rio-assistant__header');
  const usage = rioHeader.getByRole('button', { name: /^Your AI use this month:/ });
  const closeRio = rioHeader.getByRole('button', { name: 'Close Rio', exact: true });
  await expect(usage).toBeInViewport({ ratio: 1 });
  await expect(closeRio).toBeInViewport({ ratio: 1 });
  await separate(usage, closeRio);
  await page.screenshot({ path: info.outputPath('phone-rio-header-usage.png') });
  await closeRio.click();
  await personal.click();
  await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
});

test('keeps phone settings actions at their touch height after editing', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await visit(page, `${base()}/settings/files`);
  await page.getByRole('textbox', { name: 'Maximum upload size (bytes)' }).fill('1024');
  const bar = page.getByRole('region', { name: 'Save changes', exact: true });
  await expect(bar.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath('phone-settings-actions.png') });
  for (const name of ['Save', 'Discard']) {
    const box = (await bar.getByRole('button', { name, exact: true }).boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const footer = (await page.locator('.rio-shell__footer').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(footer.y);
    expect(box.y + box.height).toBeLessThanOrEqual(footer.y + footer.height);
  }
  await bar.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(bar.getByRole('status')).toHaveText('No unsaved changes');
});

test('shows grid command keys in the palette and opens find through the registered action', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Registered grid commands', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'First' }] },
  ]);
  const table = database.tables.Records!;
  await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`);
  await page.getByRole('button', { name: /^Search (?:⌘K|Ctrl\+K)$/ }).click();
  const palette = page.getByRole('dialog', { name: 'Search and commands', exact: true });
  const find = palette.getByRole('option', { name: labelName('Find in the grid'), exact: true });
  await expect(find.locator('kbd')).toContainText('F');
  await expect(
    palette.getByRole('option', { name: labelName('Undo the last change'), exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('option', { name: labelName('Redo the last change'), exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('option', { name: labelName('Select all cells'), exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('option', { name: labelName('Fill selected cells down'), exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('option', { name: labelName('Fill selected cells right'), exact: true }),
  ).toBeVisible();
  await expect(
    palette.getByRole('option', { name: labelName('Find and replace in the grid'), exact: true }),
  ).toBeVisible();
  await find.click();
  await expect(page.getByRole('textbox', { name: 'Find', exact: true })).toBeFocused();
});
