import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

async function openBases(page: Page, count = 300, workspaces = false) {
  const bases = Array.from({ length: count }, (_, index) => ({
    id: `app${String(index).padStart(14, '0')}`,
    name: index === 299 ? 'Café planning 299' : `Base ${String(index).padStart(4, '0')}`,
    permissionLevel: ['create', 'edit', 'comment', 'read'][index % 4],
    ...(workspaces ? { workspace: { id: `wsp${index % 3}`, name: `Workspace ${index % 3}` } } : {}),
  }));
  await page.route('**/api/imports/airtable/bases', (route) => route.fulfill({ json: { bases } }));
  await page.route('**/api/imports/airtable', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { imports: [] } })
      : route.fulfill({
          status: 422,
          json: { error: { code: 'validation_failed', messageKey: 'import.airtable.baseUnavailable' } },
        }),
  );
  await page.goto(`${base()}/?new=airtable`);
  const dialog = page.getByRole('dialog', { name: 'Import from Airtable' });
  await dialog.getByLabel('Personal access token').fill(randomBytes(24).toString('hex'));
  await dialog.getByRole('button', { name: 'Find bases' }).click();
  await expect(dialog.getByRole('listbox', { name: 'Base', exact: true })).toBeVisible();
  return dialog;
}

async function fitsViewport(page: Page, dialog: Locator) {
  const rect = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height);
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeInViewport();
}

for (const viewport of [
  { width: 375, height: 667 },
  { width: 1280, height: 900 },
]) {
  test.describe(`${viewport.width} pixel viewport`, () => {
    test.use({ viewport });
    test('300 bases scroll with fixed actions and support filtering, collapse, and keyboard selection', async ({
      page,
    }, info) => {
      await signIn(page);
      const submissions: string[] = [];
      page.on('request', (request) => {
        if (request.url() === `${base()}/api/imports/airtable` && request.method() === 'POST')
          submissions.push(request.postData() ?? '');
      });
      const dialog = await openBases(page);
      await fitsViewport(page, dialog);
      const footer = dialog.locator('.rio-dialog__footer');
      const heading = dialog.getByRole('heading', { name: 'Import from Airtable' });
      const before = await footer.boundingBox();
      const headingBefore = await heading.boundingBox();
      const last = dialog.getByRole('option', { name: 'Café planning 299' });
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      expect(await footer.boundingBox()).toEqual(before);
      expect(await heading.boundingBox()).toEqual(headingBefore);
      await expect(heading).toBeInViewport();
      await fitsViewport(page, dialog);
      await info.attach('300-base-dialog', { body: await page.screenshot(), contentType: 'image/png' });
      await dialog.getByRole('button', { name: 'Read only (75)' }).click();
      await expect(last).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Back', exact: true }).click();
      await dialog.getByRole('button', { name: 'Find bases' }).click();
      await expect(dialog.getByRole('button', { name: 'Read only (75)' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      const filter = dialog.getByRole('searchbox', { name: 'Filter items' });
      await filter.fill('afe planning');
      await expect(dialog.getByRole('option')).toHaveCount(1);
      await expect(dialog.getByRole('status')).toContainText('1 matching item');
      await filter.clear();
      await expect(last).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: 'Read only (75)' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await filter.fill('afe planning');
      await filter.press('Enter');
      expect(submissions).toEqual([]);
      await expect(dialog.getByLabel('Database name')).toHaveValue('Café planning 299');
      await expect(last).toHaveAttribute('aria-selected', 'true');
      await filter.clear();
      await filter.press('Enter');
      await expect(dialog.getByLabel('Database name')).toHaveValue('Café planning 299');
      expect(submissions).toEqual([]);
      const submitted = page.waitForRequest(
        (request) => request.url() === `${base()}/api/imports/airtable` && request.method() === 'POST',
      );
      await dialog.getByRole('button', { name: 'Import', exact: true }).click();
      expect((await submitted).postDataJSON().baseId).toBe('app00000000000299');
    });
  });
}

test('workspace groups and thousands of virtual rows remain reachable', async ({ page }) => {
  await signIn(page);
  const dialog = await openBases(page, 3000, true);
  await expect(dialog.getByRole('button', { name: 'Workspace 0 (1000)' })).toBeVisible();
  expect(await dialog.getByRole('option').count()).toBeLessThan(100);
  const list = dialog.getByRole('listbox', { name: 'Base', exact: true });
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(dialog.getByRole('option', { name: 'Base 2999' })).toBeVisible();
  await dialog.getByRole('searchbox').fill('2998');
  await dialog.getByRole('option', { name: 'Base 2998' }).click();
  await expect(dialog.getByLabel('Database name')).toHaveValue('Base 2998');
});

test('popover arrows remain outside the scrolling surface', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${base()}/gallery`);
  await expect(page.getByRole('button', { name: 'With an arrow', exact: true })).toBeVisible();
  // Close the gallery's initially open examples through their screen-reader dismiss controls
  await page.getByRole('button', { name: 'Dismiss', includeHidden: true }).evaluateAll((buttons) => {
    for (const button of buttons) (button as HTMLButtonElement).click();
  });
  await expect(page.locator('.rio-date-picker__popover')).toHaveCount(0);
  // Isolate the example so unrelated gallery sections do not extend past the app's frame
  await page.locator('.rio-gallery__entry').evaluateAll((entries) => {
    for (const entry of entries) if (entry.id !== 'ui.popover') (entry as HTMLElement).style.display = 'none';
  });
  await page.getByRole('button', { name: 'With an arrow', exact: true }).click();
  const popover = page.locator('.rio-popover').filter({ has: page.locator('.rio-popover__arrow') });
  await expect(popover).toBeVisible();
  expect(await popover.evaluate((element) => getComputedStyle(element).overflowY)).toBe('visible');
  await expect(popover.locator('.rio-popover__arrow svg')).toBeInViewport();
  await popover.locator('p').evaluate((element) => {
    element.textContent = Array.from({ length: 300 }, (_, index) => `Item ${index}`).join(' ');
  });
  const apply = popover.getByRole('button', { name: 'Apply', exact: true });
  await apply.scrollIntoViewIfNeeded();
  await apply.focus();
  const clearance = await apply.evaluate((element) => {
    const control = element.getBoundingClientRect();
    const scroller = element.closest('.rio-popover__content')!.getBoundingClientRect();
    return Math.min(
      control.left - scroller.left,
      scroller.right - control.right,
      control.top - scroller.top,
      scroller.bottom - control.bottom,
    );
  });
  expect(clearance).toBeGreaterThanOrEqual(4);
  await expect(popover.getByRole('button', { name: 'Apply', exact: true })).toBeInViewport();
  await expect(popover.locator('.rio-popover__arrow svg')).toBeInViewport();
  await info.attach('popover-arrow', { body: await page.screenshot(), contentType: 'image/png' });
});

test('attachment previews keep navigation reachable on a landscape phone', async ({ page }, info) => {
  await signIn(page);
  const database = await createDatabase(page, 'Preview sizing', [
    {
      name: 'Images',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Files', type: 'attachment' },
      ],
      records: [{ Name: 'Preview record' }],
    },
  ]);
  const grid = await openTable(page, database, 'Images');
  await grid.getByRole('button', { name: 'Expand row 1' }).click();
  const card = page.getByRole('dialog', { name: 'Preview record' });
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#225577';
    context.fillRect(0, 0, 800, 800);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  await card.locator('input[type="file"]').setInputFiles(
    ['First.png', 'Second.png'].map((name) => ({
      name,
      mimeType: 'image/png',
      buffer: Buffer.from(png, 'base64'),
    })),
  );
  await card.getByRole('button', { name: /^First\.png(?: |$)/ }).click();
  await page.setViewportSize({ width: 667, height: 375 });
  const dialog = page.getByRole('dialog', { name: 'Preview of First.png' });
  await expect(dialog.getByRole('img', { name: 'First.png', exact: true })).toBeVisible();
  const rect = (await dialog.boundingBox())!;
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height).toBeLessThanOrEqual(375);
  const next = dialog.getByRole('button', { name: 'Next file' });
  await next.scrollIntoViewIfNeeded();
  await expect(next).toBeInViewport();
  await info.attach('landscape-preview', { body: await page.screenshot(), contentType: 'image/png' });
  await next.click();
  await expect(page.getByRole('dialog', { name: 'Preview of Second.png' })).toBeVisible();
});

test('calendar shadows can extend beyond their popover content', async ({ page }, info) => {
  await signIn(page);
  await page.goto(`${base()}/gallery`);
  const calendar = page.locator('.rio-date-picker__popover .rio-calendar').first();
  await expect(calendar).toBeVisible();
  const overflow = await calendar.evaluate((element) => {
    const style = getComputedStyle(element.closest('.rio-popover__content')!);
    return [style.overflowX, style.overflowY];
  });
  expect(overflow).toEqual(['visible', 'visible']);
  await info.attach('calendar-shadow', { body: await page.screenshot(), contentType: 'image/png' });
});
