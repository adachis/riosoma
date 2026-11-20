import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, runCommands, signIn, visit, type SeededDatabase } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.  Charts draw at once without their animation.
test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const dashboardId = () =>
  `dsh${[...randomBytes(14)].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;

/** A table of tasks, two of them done, and a dashboard with a column chart of them by status. */
async function seed(page: Page, category?: string): Promise<{ database: SeededDatabase; dashboard: string }> {
  await signIn(page);
  const database = await createDatabase(page, 'Release Plan', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Done', 'Open'] },
        { name: 'Category', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'Write notes', Status: 'Done', Category: category ?? 'Done', Amount: 10 },
        { Name: 'Tag build', Status: 'Done', Category: category ?? 'Done', Amount: 20 },
        { Name: 'Announce', Status: 'Open', Category: 'Open', Amount: 1000 },
      ],
    },
  ]);
  const tasks = database.tables.Tasks!;
  const dashboard = dashboardId();
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: tasks.viewId,
      config: { dataBars: [{ fieldId: tasks.fields.Amount, color: 'blue' }] },
    },
    {
      kind: 'dashboard.create',
      dashboard: {
        id: dashboard,
        name: 'Progress',
        config: {
          tiles: [
            {
              id: 'tileStatus01',
              kind: 'chart',
              title: 'Tasks by status',
              place: { x: 0, y: 0, w: 6, h: 4 },
              source: { tableId: tasks.id },
              chart: 'column',
              groupBy: { fieldId: category ? tasks.fields.Category : tasks.fields.Status },
              value: { fn: 'count' },
            },
          ],
        },
      },
    },
  ]);
  await visit(page, `${base()}/${database.id}/dashboards/${dashboard}`);
  return { database, dashboard };
}

/** Clicks the first of two columns: halfway up, a quarter of the way across the chart. */
async function clickDoneColumn(page: Page) {
  const chart = page
    .getByRole('article', { name: 'Tasks by status' })
    .getByRole('img', { name: 'Tasks by status' });
  await expect(chart.locator('canvas')).toBeVisible();
  const box = (await chart.boundingBox())!;
  await chart.click({ position: { x: box.width * 0.27, y: box.height * 0.55 } });
}

test('clicking a column lists its records in a sheet, and its link opens them in a narrowed grid', async ({
  page,
}) => {
  const { database, dashboard } = await seed(page);
  await clickDoneColumn(page);
  const sheet = page.getByRole('dialog', { name: 'Status is Done, 2 records' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Write notes' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Tag build' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Announce' })).toHaveCount(0);
  // The address keeps the open part, so reloading reopens the same list.
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard}\\?drill=`));
  await visit(page, page.url());
  await expect(page.getByRole('dialog', { name: 'Status is Done, 2 records' })).toBeVisible();

  const rangesRequest = page.waitForRequest((request) => request.url().includes('/ranges?'));
  await page.getByRole('dialog').getByRole('link', { name: 'Open in Grid' }).click();
  const tasks = database.tables.Tasks!;
  await expect(page).toHaveURL(new RegExp(`/${tasks.id}/${tasks.viewId}\\?where=`));
  await expect(
    page.getByText(/^This view shows only the records behind part of a dashboard chart\./),
  ).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Grid' });
  const cell = (name: string) => grid.getByRole('gridcell', { name, exact: true });
  await expect(cell('Write notes')).toBeVisible();
  await expect(cell('Tag build')).toBeVisible();
  await expect(cell('Announce')).toHaveCount(0);
  const where = new URL(page.url()).searchParams.get('where');
  expect(new URL((await rangesRequest).url()).searchParams.get('where')).toBe(where);
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More for Grid' }).click();
  await page.getByRole('menuitem', { name: 'Download CSV' }).click();
  const download = await downloaded;
  const csv = await readFile((await download.path())!, 'utf8');
  expect(csv).toContain('Write notes');
  expect(csv).toContain('Tag build');
  expect(csv).not.toContain('Announce');
  // A pending save can refresh the narrowed range before the click changes the address.
  // Inspect the first range request from the unnarrowed page, including its filter payload.
  const allRangesRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === `/api/views/${tasks.viewId}/ranges` &&
      !new URL(request.frame().url()).searchParams.has('where'),
  );
  await page.getByRole('button', { name: 'Show all records' }).click();
  expect(new URL((await allRangesRequest).url()).searchParams.has('where')).toBe(false);
  await expect(cell('Announce')).toBeVisible();
  await expect(page).not.toHaveURL(/where=/);
});

test('a long Unicode category opens from the keyboard and reopens from its deep link', async ({ page }) => {
  const category = '日'.repeat(300);
  const { dashboard } = await seed(page, category);
  const tile = page.getByRole('article', { name: 'Tasks by status' });
  await tile.getByRole('button', { name: 'Show as table' }).click();
  await tile.getByRole('button', { name: `${category}, 2` }).focus();
  await page.keyboard.press('Enter');
  const name = `Category is ${category}, 2 records`;
  await expect(page.getByRole('dialog', { name })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/dashboards/${dashboard}\\?drill=`));
  await visit(page, page.url());
  const sheet = page.getByRole('dialog', { name });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Write notes' })).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'Announce' })).toHaveCount(0);
});

test('the chart’s table opens the same records from the keyboard, and Escape gives focus back', async ({
  page,
}) => {
  await seed(page);
  const tile = page.getByRole('article', { name: 'Tasks by status' });
  await tile.getByRole('button', { name: 'Show as table' }).click();
  const done = tile.getByRole('button', { name: 'Done, 2' });
  await done.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Status is Done, 2 records' });
  await expect(sheet).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(done).toBeFocused();
  await expect(page).not.toHaveURL(/drill=/);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a tap on a column opens the records across the whole screen', async ({ page }) => {
    await seed(page);
    await clickDoneColumn(page);
    const sheet = page.getByRole('dialog', { name: 'Status is Done, 2 records' });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    // Wider than the sheet's own width on a larger screen, so it spans the phone.
    expect(box.width).toBeGreaterThan(385);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toBeHidden();
  });
});
