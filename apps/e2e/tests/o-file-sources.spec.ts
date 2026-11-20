import AxeBuilder from '@axe-core/playwright';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';

/**
 * A synced table from a CSV file at a web address.  An admin adds the file as a data source, the
 * wizard syncs it into a table, and a value changed by hand stays changed when the file changes
 * and syncs again.  The file comes from a small web server on this machine, which the test server
 * may reach because it allows private hosts.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** What the web server answers with, which a test changes between syncs */
let csv = '';
let server: Server;
let address = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/harbor/vessels.csv') {
      response.writeHead(404).end();
      return;
    }
    const body = Buffer.from(csv, 'utf8');
    response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-length': body.length });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/harbor/vessels.csv`;
});

test.afterAll(async () => {
  await new Promise((done) => server.close(done));
});

test('an admin adds a file at a web address as a data source, and its test reads the file', async ({
  page,
}) => {
  csv = 'id,name,port\n1,Albatross,Lisbon\n';
  await signIn(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('link', { name: 'Data sources' }).click();
  await page.getByRole('button', { name: 'Add a data source' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Add a data source' });
  await dialog.getByRole('option', { name: 'File at a web address', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Harbor vessels list');
  await dialog.getByRole('textbox', { name: 'Address' }).fill(address);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Connected.')).toBeVisible();
  await expect(dialog.getByText('Failed', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Harbor vessels list' }) });
  await expect(row).toContainText('File at a web address');
  await expect(row).toContainText(address);
});

test('a synced file keeps a value changed by hand when the file changes', async ({ page }) => {
  // File reads and their apply finish before assertions compare source values and local overrides.
  test.setTimeout(120_000);
  const sync = { timeout: 45_000 };
  csv = 'id,name,port\n1,Albatross,Lisbon\n2,Bluefin,Oslo\n3,Cormorant,Genoa\n';
  await signIn(page);
  // A separate source keeps this sync independent of the dialog test.
  await asOwner(page, 'POST', '/api/sources', {
    name: 'Harbor vessels file',
    connection: { kind: 'file-url', url: address },
    secrets: {},
  });

  // The wizard syncs the file into a new table.
  const database = await createDatabase(page, 'Harbor Registry', [
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Notes');
  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
  const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
  await wizard.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: 'Harbor vessels file' }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('textbox', { name: 'Search files' }).fill('vessels');
  await wizard.getByRole('option', { name: /vessels\.csv/ }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await expect(wizard.getByRole('table', { name: 'Preview' }).getByText('Albatross')).toBeVisible();
  // The id column holds a different value on every line, so it's the key from the start.
  const keys = wizard.getByRole('group', { name: 'Key columns' });
  await expect(keys.getByRole('checkbox', { name: 'id', exact: true })).toBeChecked();
  await expect(keys.getByRole('checkbox', { name: 'name', exact: true })).not.toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();
  // A file's table is named after the file.
  await expect(wizard.getByRole('textbox', { name: 'Table name' })).toHaveValue('vessels');
  await wizard.getByRole('textbox', { name: 'Table name' }).fill('Vessels');
  await wizard.getByRole('button', { name: 'Create synced table' }).click();
  await expect(wizard).toBeHidden();

  await expect(page.getByRole('link', { name: 'Vessels' })).toHaveAttribute('aria-current', 'page');
  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: 'Albatross' })).toBeVisible(sync);
  await expect(page.getByText('Synced from Harbor vessels file')).toBeVisible();

  // A port changed here is marked with what the file says.
  await grid.getByRole('gridcell', { name: 'Lisbon' }).click();
  await page.keyboard.type('Porto');
  await page.keyboard.press('Enter');
  const porto = grid.getByRole('gridcell', { name: 'Porto' });
  await expect(porto).toHaveAccessibleDescription('Changed here.  The source says Lisbon.');

  // The file changes: a new port for two vessels, and a fourth vessel.  After the next sync, the
  // table has the file's new values, and the port changed here stays, marked with the file's new one.
  csv = 'id,name,port\n1,Albatross,Faro\n2,Bluefin,Bergen\n3,Cormorant,Genoa\n4,Dolphin,Naples\n';
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(grid.getByRole('gridcell', { name: 'Bergen' })).toBeVisible(sync);
  await expect(grid.getByRole('gridcell', { name: 'Dolphin' })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Oslo' })).toHaveCount(0);
  await expect(porto).toHaveAccessibleDescription('Changed here.  The source says Faro.');
  await page.reload();
  await expect(porto).toHaveAccessibleDescription('Changed here.  The source says Faro.');
  await expect(grid.getByRole('gridcell', { name: 'Bergen' })).toBeVisible();
});

test.describe('choosing a source kind on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  for (const input of ['keyboard', 'touch'] as const) {
    test(`chooses a file source with ${input} and exposes named options`, async ({ page }) => {
      await signIn(page);
      await page.goto(new URL('/settings/sources', page.url()).href);
      await page.getByRole('button', { name: 'Add a data source' }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Add a data source' });
      const kinds = dialog.getByRole('listbox', { name: 'What do you want to connect?' });
      const filter = dialog.getByRole('searchbox', { name: 'Filter sources' });
      await filter.fill('File at a web address');
      const option = kinds.getByRole('option', { name: 'File at a web address', exact: true });
      await expect(option).toBeVisible();
      await expect(kinds.getByRole('option')).toHaveCount(1);
      // Audit the settled dialog colors after its entrance animation finishes
      await expect(page.locator('[data-entering], [data-exiting]')).toHaveCount(0);
      const audit = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
      expect(audit.violations).toEqual([]);
      if (input === 'keyboard') {
        await filter.press('ArrowDown');
        await expect(filter).toHaveAttribute(
          'aria-activedescendant',
          (await option.getAttribute('id')) ?? '',
        );
        await filter.press('Enter');
      } else {
        await option.tap();
      }
      await expect(dialog.getByRole('textbox', { name: 'Address', exact: true })).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    });
  }
});
