import { expect, test, type Locator, type Page } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn, type SeededDatabase } from '../helpers';

/**
 * Snapshots and copies.  The owner takes a snapshot, changes a record, and restores the snapshot as
 * a new database, which has the value from before the change and its automation turned off, while
 * the database itself keeps the change.  Duplicating a database without its records makes the same
 * tables and fields with no records in them.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

const READINGS = [
  { Name: 'Harbor mouth', Sea: 'Calm' },
  { Name: 'Outer buoy', Sea: 'Swell' },
  { Name: 'North jetty', Sea: 'Calm' },
];

/** A grid row, found by its record's name. */
function row(grid: Locator, name: string): Locator {
  return grid.getByRole('row').filter({ has: grid.page().getByRole('gridcell', { name, exact: true }) });
}

/** A tide log with an automation that's on, which a copy should turn off. */
async function tideLog(page: Page): Promise<SeededDatabase> {
  const database = await createDatabase(page, 'Tide Log', [
    {
      name: 'Readings',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Sea', type: 'text' },
      ],
      records: READINGS,
    },
  ]);
  const readings = database.tables.Readings!;
  const automation = newId('aut');
  await runCommands(page, database.id, [
    {
      kind: 'automation.create',
      automation: {
        id: automation,
        name: 'Mark new readings',
        config: {
          trigger: { kind: 'recordCreated', tableId: readings.id },
          steps: [
            {
              id: 'mark-new',
              kind: 'updateRecord',
              tableId: readings.id,
              record: 'trigger',
              values: { [readings.fields.Sea!]: 'Unchecked' },
            },
          ],
        },
      },
    },
  ]);
  await runCommands(page, database.id, [
    { kind: 'automation.update', automationId: automation, enabled: true },
  ]);
  return database;
}

/** Opens the database's settings menu in its header and chooses an item. */
async function settingsMenu(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Opens the automation in the sidebar and returns its on and off switch. */
async function automationSwitch(page: Page, name: string): Promise<Locator> {
  await page.getByRole('link', { name }).click();
  await expect(page.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  return page.getByRole('switch', { name: /^(On|Off)$/ });
}

test('a snapshot restored as a new database has the value from before, with its automation off', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await tideLog(page);
  let grid = await openTable(page, database, 'Readings');
  await expect(row(grid, 'Harbor mouth').getByRole('gridcell', { name: 'Calm', exact: true })).toBeVisible();

  // The owner takes a snapshot from the database's settings menu.
  await settingsMenu(page, 'Snapshots');
  let dialog = page.getByRole('dialog', { name: 'Snapshots' });
  await dialog.getByRole('textbox', { name: 'Snapshot name' }).fill('Before the storm');
  await dialog.getByRole('button', { name: 'Take a snapshot' }).click();
  await expect(page.getByText('Took the snapshot Before the storm')).toBeVisible();
  const snapshots = dialog.getByRole('list', { name: 'Snapshots' });
  await expect(snapshots.getByRole('listitem').filter({ hasText: 'Before the storm' })).toContainText(
    '3 records',
  );
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // Then the sea at the harbor mouth changes.
  const saved = page.waitForResponse((response) =>
    response.url().endsWith(`/api/databases/${database.id}/commands`),
  );
  await row(grid, 'Harbor mouth').getByRole('gridcell', { name: 'Calm', exact: true }).click();
  await page.keyboard.type('Storm surge');
  await page.keyboard.press('Enter');
  expect((await saved).ok()).toBe(true);
  await expect(
    row(grid, 'Harbor mouth').getByRole('gridcell', { name: 'Storm surge', exact: true }),
  ).toBeVisible();

  // The snapshot restores as a new database, and the one it came from stays as it is.
  await settingsMenu(page, 'Snapshots');
  dialog = page.getByRole('dialog', { name: 'Snapshots' });
  await dialog.getByRole('button', { name: 'More for Before the storm' }).click();
  await page.getByRole('menuitem', { name: 'Restore as a new database' }).click();
  await expect(dialog.getByText('Restoring Before the storm makes a new database from it.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'New database name' })).toHaveValue('Tide Log (restored)');
  await dialog.getByRole('button', { name: 'Restore as a new database' }).click();
  await expect(dialog.getByText('Made Tide Log (restored) with 1 table and 3 records.')).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    dialog.getByText('Its automation is turned off, so nothing runs until you turn it on.'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Open the new database' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tide Log (restored)');

  // The copy has the sea from before the change, and its automation waits, turned off.
  grid = page.getByRole('grid', { name: 'Grid' });
  await expect(row(grid, 'Harbor mouth').getByRole('gridcell', { name: 'Calm', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Storm surge', exact: true })).toHaveCount(0);
  const restoredSwitch = await automationSwitch(page, 'Mark new readings');
  await expect(restoredSwitch).toHaveAccessibleName('Off');
  await expect(restoredSwitch).not.toBeChecked();

  // The original still has the change, and its automation is still on.
  grid = await openTable(page, database, 'Readings');
  await expect(
    row(grid, 'Harbor mouth').getByRole('gridcell', { name: 'Storm surge', exact: true }),
  ).toBeVisible();
  const originalSwitch = await automationSwitch(page, 'Mark new readings');
  await expect(originalSwitch).toHaveAccessibleName('On');
  await expect(originalSwitch).toBeChecked();
});

test('a database duplicated without its records has its tables, fields, and automation, and no records', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await tideLog(page);
  await openTable(page, database, 'Readings');

  await settingsMenu(page, 'Duplicate database');
  const dialog = page.getByRole('dialog', { name: 'Duplicate Tide Log' });
  await expect(dialog.getByRole('textbox', { name: 'New database name' })).toHaveValue('Tide Log copy');
  await dialog.getByRole('textbox', { name: 'New database name' }).fill('Tide Log template');
  const withRecords = dialog.getByRole('checkbox', { name: 'Include records, files, and comments' });
  await expect(withRecords).toBeChecked();
  await dialog.getByText('Include records, files, and comments', { exact: true }).click();
  await expect(withRecords).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByText('Made Tide Log template with 1 table and 0 records.')).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole('button', { name: 'Open the new database' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Tide Log template');

  const grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('columnheader', { name: 'Name' })).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Sea' })).toBeVisible();
  await expect(grid.getByText('0 records', { exact: true })).toBeVisible();
  for (const reading of READINGS)
    await expect(grid.getByRole('gridcell', { name: reading.Name })).toHaveCount(0);
  const copied = await automationSwitch(page, 'Mark new readings');
  await expect(copied).not.toBeChecked();

  // The database it came from keeps its records.
  const original = await openTable(page, database, 'Readings');
  await expect(original.getByText('3 records', { exact: true })).toBeVisible();
});
