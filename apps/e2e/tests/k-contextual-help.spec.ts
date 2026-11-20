import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, openTable, signIn, visit } from '../helpers';
import { connection } from '../sql';
import { openNewField } from '../grid-fields';

test.use({ serviceWorkers: 'block' });

async function contextual(page: Page, module: string, section?: string) {
  await page.getByRole('button', { name: /: Personal menu$/ }).click();
  await page.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('help')).toBe(module);
  if (section) {
    await expect.poll(() => new URL(page.url()).searchParams.get('helpSection')).toBe(section);
    await expect(page.locator(`#doc-section-${section}`)).toBeFocused();
  }
}

async function navigation(page: Page, width: number) {
  if (width === 390 && !(await page.getByRole('dialog', { name: 'Menu', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
}

async function dismissNavigation(page: Page, width: number) {
  const menu = page.getByRole('dialog', { name: 'Menu', exact: true });
  if (width === 390 && (await menu.isVisible()))
    await menu.getByRole('button', { name: 'Close', exact: true }).click();
}

for (const width of [1280, 390]) {
  test(`form help follows the active view and opens sharing help at ${width} pixels`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, `Form help ${width}`, [
      { name: 'Requests', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Requests');
    if (width <= 767)
      await page
        .getByRole('navigation', { name: 'Views', exact: true })
        .getByRole('button', { name: 'Grid', exact: true })
        .click();
    await page.getByRole('button', { name: 'Add view', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Form', exact: true }).click();
    await expect(page.locator('[data-anchor="view.settings.form"]')).toBeVisible();
    await contextual(page, 'forms', 'designing-the-form');
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await page.getByRole('button', { name: 'Share publicly', exact: true }).click();
    const share = page.getByRole('dialog', { name: 'Share publicly', exact: true });
    await share.getByRole('button', { name: 'Help with Share publicly', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#doc-section-sharing-a-form-by-link')).toBeFocused();
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await expect(share).toBeHidden();
  });

  test(`contextual help follows five screens and opens configuration sections at ${width} pixels`, async ({
    page,
  }, info) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, `Context ${width}`, [
      { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Records');
    await contextual(page, 'editing', 'moving-around');
    await page.screenshot({ path: info.outputPath('contextual-grid.png') });
    await expect(page.getByRole('heading', { name: 'Also about this screen' })).toBeAttached();
    await page.getByRole('button', { name: 'Close help', exact: true }).click();

    await openNewField(page);
    const field = page.getByRole('dialog', { name: 'New field', exact: true });
    await field
      .getByRole('textbox', { name: 'Name', exact: true })
      .fill('A long field name kept while reading help');
    await field.getByRole('button', { name: 'Help with New field', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#doc-section-adding-and-editing-fields')).toBeFocused();
    await page.getByRole('button', { name: 'Open in a window', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Documentation window', exact: true })).toBeVisible();
    await expect(page.locator('.rio-docs-modal-panel')).toHaveCount(0);
    await page.getByRole('button', { name: 'Dock help panel', exact: true }).click();
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await expect(field.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
      'A long field name kept while reading help',
    );
    await field.getByRole('button', { name: 'Cancel', exact: true }).click();

    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('button', { name: 'Help with Filter', exact: true }).click();
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    if (width > 767) {
      await page.getByRole('button', { name: 'Open in a window', exact: true }).click();
      await page.getByRole('button', { name: 'Search help', exact: true }).click();
      await expect(page.getByRole('searchbox', { name: 'Search help', exact: true })).toBeVisible();
      const bar = (await page.locator('.rio-docs-window__bar').boundingBox())!;
      await page.mouse.move(bar.x + 80, bar.y + 10);
      await page.mouse.down();
      await page.mouse.move(bar.x + 80, bar.y + 230, { steps: 6 });
      await page.mouse.up();
      await expect
        .poll(async () => (await page.getByRole('region', { name: 'Documentation window' }).boundingBox())!.y)
        .toBeGreaterThan(200);
      await page
        .getByRole('toolbar', { name: 'View controls', exact: true })
        .getByRole('button', { name: 'Filter', exact: true })
        .click();
      await page.getByRole('button', { name: 'Help with Filter', exact: true }).click();
      await expect(page.locator('#doc-section-filter')).toBeFocused();
      await expect(page.getByRole('searchbox', { name: 'Search help', exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Close help', exact: true }).click();

    await visit(page, `${base()}/settings/appearance`);
    await contextual(page, 'themes');
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Search and commands', exact: true });
    await palette.getByRole('searchbox').fill('Help');
    await palette.getByRole('option', { name: 'Open help', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('help')).toBe('themes');
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await visit(page, `${base()}/settings/sources`);
    await expect(page.getByRole('heading', { name: 'Data sources', exact: true, level: 1 })).toBeVisible();
    await contextual(page, 'synced-tables', 'connecting-a-data-source');
    await page.getByRole('button', { name: 'Close help', exact: true }).click();

    const { password: _password, ...address } = connection();
    await asOwner(page, 'POST', '/api/sources', {
      name: `Context source ${width}`,
      access: 'creators',
      connection: { kind: 'postgres', ...address, tls: { mode: 'disable' } },
      secrets: { password: randomBytes(24).toString('hex') },
    });
    await openTable(page, database, 'Records');
    await navigation(page, width);
    await page.getByRole('button', { name: 'Add a table', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Sync from a data source', exact: true }).click();
    await page.getByRole('button', { name: 'Help with Sync from a data source', exact: true }).click();
    await expect(page.locator('#doc-section-choose-a-source')).toBeFocused();
    await page.screenshot({ path: info.outputPath('contextual-source-wizard.png') });
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await page.keyboard.press('F1');
    await expect(page.locator('#doc-section-choose-a-source')).toBeFocused();
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Sync from a data source', exact: true })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await navigation(page, width);
    await page.getByRole('button', { name: 'Add a dashboard', exact: true }).click();
    await dismissNavigation(page, width);
    await contextual(page, 'dashboards', 'adding-a-tile');
    await page.screenshot({ path: info.outputPath('contextual-dashboard.png') });
    await page.getByRole('button', { name: 'Close help', exact: true }).click();
    await page.getByRole('button', { name: 'Help with Untitled dashboard', exact: true }).click();
    await expect(page.locator('#doc-section-adding-a-tile')).toBeFocused();
    await page.getByRole('button', { name: 'Close help', exact: true }).click();

    await navigation(page, width);
    await page.getByRole('button', { name: 'Add an automation', exact: true }).click();
    await dismissNavigation(page, width);
    await page.keyboard.press('F1');
    await expect.poll(() => new URL(page.url()).searchParams.get('help')).toBe('automations');
    await expect(page.locator('#doc-section-moving-around-the-canvas')).toBeFocused();
  });

  test(`documentation window moves, resizes, navigates, reloads, and docks at ${width} pixels`, async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, `Documentation ${width}`, [
      { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await openTable(page, database, 'Records');
    if (width <= 767)
      await page.evaluate(() =>
        localStorage.setItem(
          'rio-docs-window-position',
          JSON.stringify({ x: 200, y: 100, width: 600, height: 500 }),
        ),
      );
    await visit(page, `${page.url()}?help=views&helpSection=filter`);
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    const launch = page.getByRole('button', { name: 'Open in a window', exact: true });
    await launch.focus();
    await page.keyboard.press('Enter');
    const window = page.getByRole('region', { name: 'Documentation window', exact: true });
    await expect(window).toBeVisible();
    await expect.poll(() => new URL(page.url()).searchParams.get('helpWindow')).toBe('1');
    if (width > 767) {
      const initial = (await window.boundingBox())!;
      const bar = page.locator('.rio-docs-window__bar');
      const bounds = (await bar.boundingBox())!;
      await page.mouse.move(bounds.x + 80, bounds.y + 10);
      await page.mouse.down();
      await page.mouse.move(bounds.x - 80, bounds.y + 70, { steps: 6 });
      await page.mouse.up();
      await expect.poll(async () => (await window.boundingBox())!.x).toBeLessThan(initial.x);
      const moved = (await window.boundingBox())!;
      await page.mouse.move(moved.x + moved.width - 4, moved.y + moved.height - 4);
      await page.mouse.down();
      await page.mouse.move(moved.x + moved.width + 60, moved.y + moved.height + 60, { steps: 6 });
      await page.mouse.up();
      await expect.poll(async () => (await window.boundingBox())!.width).toBeGreaterThan(moved.width);
      await page.getByRole('button', { name: 'Move documentation window with arrow keys' }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.getByRole('button', { name: 'Resize documentation window with arrow keys' }).focus();
      await page.keyboard.press('ArrowLeft');
      await page.setViewportSize({ width: 820, height: 600 });
      // The viewport call can return before the resize event updates the window's geometry.
      await expect
        .poll(async () => {
          const fitted = (await window.boundingBox())!;
          return fitted.x + fitted.width;
        })
        .toBeLessThanOrEqual(820);
      await expect
        .poll(async () => {
          const fitted = (await window.boundingBox())!;
          return fitted.y + fitted.height;
        })
        .toBeLessThanOrEqual(600);
      const fitted = (await window.boundingBox())!;
      expect(fitted.x).toBeGreaterThanOrEqual(0);
      expect(fitted.y).toBeGreaterThanOrEqual(0);
      expect(fitted.x + fitted.width).toBeLessThanOrEqual(820);
      expect(fitted.y + fitted.height).toBeLessThanOrEqual(600);
    } else {
      expect(await window.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 900 });
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(() => window.boundingBox()).toEqual({ x: 200, y: 100, width: 600, height: 500 });
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(() => window.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 900 });
    }
    await window.getByRole('link', { name: 'Sort', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#doc-section-sort')).toBeFocused();
    await window.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    await window.getByRole('button', { name: 'Forward', exact: true }).click();
    await expect(page.locator('#doc-section-sort')).toBeFocused();
    await window.getByRole('button', { name: 'Search help', exact: true }).click();
    await window.getByRole('searchbox', { name: 'Search help', exact: true }).fill('pins close together');
    await expect(window.getByRole('link', { name: 'Working with a list or a map' })).toBeVisible();
    await window.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    await window.getByRole('link', { name: 'Sort', exact: true }).click();
    await window.getByRole('button', { name: 'Search help', exact: true }).click();
    await expect(window.getByRole('searchbox', { name: 'Search help', exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    await expect(window.getByRole('searchbox', { name: 'Search help', exact: true })).toHaveCount(0);
    if (width > 767) {
      await page.getByRole('link', { name: 'Home', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeAttached();
      await expect(window).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.get('help')).toBe('views');
    }
    await page.reload();
    await expect(window).toBeVisible();
    await expect(page.locator('#doc-section-filter')).toBeFocused();
    await page.screenshot({ path: info.outputPath('documentation-window.png') });
    await window.getByRole('button', { name: 'Dock help panel', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(window).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'Help', exact: true })).toBeVisible();
  });
}
