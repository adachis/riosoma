import { expect, test } from '../accessibility';
import { labelName, asOwner, createDatabase, openTable, signIn } from '../helpers';
import { connection, sql } from '../sql';

/**
 * A synced table from a PostgreSQL source: made with the wizard, overridden by hand, and caught up
 * by the source.  The source is the test database itself, holding a schema of its own.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

// Both the first copy and Sync now read the source, so assertions wait for their applied records.
test.setTimeout(120_000);
const SYNC = { timeout: 45_000 };

test('an override shows its mark until the source catches up to it', async ({ page }) => {
  await sql(`
    DROP SCHEMA IF EXISTS harbor CASCADE;
    CREATE SCHEMA harbor;
    CREATE TABLE harbor.vessels (id integer PRIMARY KEY, name text NOT NULL, port text);
    INSERT INTO harbor.vessels VALUES (1, 'Albatross', 'Lisbon'), (2, 'Bluefin', 'Oslo'), (3, 'Cormorant', 'Genoa');
  `);
  await signIn(page);
  const { password, ...target } = connection();
  await asOwner(page, 'POST', '/api/sources', {
    name: 'Harbor records',
    connection: { kind: 'postgres', ...target, tls: { mode: 'disable' } },
    secrets: { password },
  });
  const database = await createDatabase(page, 'Harbor Office', [
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Notes');

  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: labelName('Sync from a data source') }).click();
  const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
  await wizard.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: labelName('Harbor records') }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('searchbox', { name: 'Search tables and views' }).fill('vessels');
  await wizard.getByRole('option', { name: labelName('vessels') }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  // The preview reads the source, and the primary key becomes the key column.
  await expect(wizard.getByRole('table', { name: 'Preview' }).getByText('Albatross')).toBeVisible();
  await expect(wizard.getByRole('checkbox', { name: 'id', exact: true })).toBeChecked();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('textbox', { name: 'Table name' }).fill('Vessels');
  await wizard.getByRole('button', { name: 'Create synced table' }).click();
  await expect(wizard).toBeHidden();

  await expect(page.getByRole('link', { name: 'Vessels' })).toHaveAttribute('aria-current', 'page');
  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: 'Albatross' })).toBeVisible(SYNC);
  await expect(page.getByText('Synced from Harbor records')).toBeVisible();

  // Changing a source value here overrides it, and the cell says what the source holds.
  await grid.getByRole('gridcell', { name: 'Lisbon' }).click();
  await page.keyboard.type('Porto');
  await page.keyboard.press('Enter');
  const porto = grid.getByRole('gridcell', { name: 'Porto' });
  const mark = 'Changed here.  The source says Lisbon.';
  await expect(porto).toHaveAccessibleDescription(mark);
  await porto.hover();
  await expect(page.getByRole('tooltip')).toHaveText(mark);

  // Once the source says the same, the next sync clears the override.
  await sql(`UPDATE harbor.vessels SET port = 'Porto' WHERE id = 1`);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(porto).toHaveAccessibleDescription('', SYNC);
  await grid.getByRole('gridcell', { name: 'Bluefin' }).hover();
  await porto.hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
});

test('a column of numbers syncs as money when its field type is Currency', async ({ page }) => {
  await sql(`
    DROP SCHEMA IF EXISTS box_office CASCADE;
    CREATE SCHEMA box_office;
    CREATE TABLE box_office.sales (id integer PRIMARY KEY, title text NOT NULL, gross_rev_usd numeric(14,2), units integer);
    INSERT INTO box_office.sales VALUES (1, 'Starfall', 929.19, 77), (2, 'Atlas Road', 1234567.5, 1200), (3, 'Copper Canyon', NULL, 3);
  `);
  await signIn(page);
  const { password, ...target } = connection();
  await asOwner(page, 'POST', '/api/sources', {
    name: 'Box office',
    connection: { kind: 'postgres', ...target, tls: { mode: 'disable' } },
    secrets: { password },
  });
  const database = await createDatabase(page, 'Box Office Reports', [
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Notes');

  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: labelName('Sync from a data source') }).click();
  const wizard = page.getByRole('dialog', { name: 'Sync from a data source' });
  await wizard.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: labelName('Box office') }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('searchbox', { name: 'Search tables and views' }).fill('sales');
  await wizard.getByRole('option', { name: labelName('sales') }).click();
  await wizard.getByRole('button', { name: 'Next' }).click();
  // A column of numbers starts as a number, and can be money or a percentage instead.
  const revenue = wizard.getByRole('group', { name: 'gross_rev_usd', exact: true });
  await expect(revenue.getByRole('button', { name: /Field type/ })).toContainText('Number');
  await revenue.getByRole('button', { name: /Field type/ }).click();
  await expect(page.getByRole('option').filter({ visible: true })).toHaveText([
    'Number',
    'Currency',
    'Percent',
    'Text',
    'Long text',
  ]);
  await page.getByRole('option', { name: labelName('Currency'), exact: true }).click();
  // Text has no such choice.
  await wizard
    .getByRole('group', { name: 'title', exact: true })
    .getByRole('button', { name: /Field type/ })
    .click();
  await expect(page.getByRole('option', { name: labelName('Long text'), exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: labelName('Currency'), exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await wizard.getByRole('button', { name: 'Next' }).click();
  await wizard.getByRole('textbox', { name: 'Table name' }).fill('Sales');
  await wizard.getByRole('button', { name: 'Create synced table' }).click();
  await expect(wizard).toBeHidden();

  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: '$929.19', exact: true })).toBeVisible(SYNC);
  await expect(grid.getByRole('gridcell', { name: '$1,234,567.50', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '1,200', exact: true })).toBeVisible();

  // A second sync finds the same money and changes nothing, and a new amount arrives as money too.
  await sql(`UPDATE box_office.sales SET gross_rev_usd = 12.5 WHERE id = 3`);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(grid.getByRole('gridcell', { name: '$12.50', exact: true })).toBeVisible(SYNC);
  await expect(grid.getByRole('gridcell', { name: '$929.19', exact: true })).toBeVisible();
  const stored = await asOwner<{
    tables: Array<{
      name: string;
      source?: { status: { stats: { changed: number; unchanged: number } | null } };
    }>;
    fields: Array<{ name: string; type: string; options: { code?: string } }>;
  }>(page, 'GET', `/api/databases/${database.id}/schema`);
  expect(stored.tables.find((table) => table.name === 'Sales')!.source!.status.stats).toMatchObject({
    changed: 1,
    unchanged: 2,
  });
  expect(stored.fields.find((field) => field.name === 'gross_rev_usd')).toMatchObject({
    type: 'currency',
    options: { code: 'USD' },
  });
});
