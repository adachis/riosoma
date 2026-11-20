import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('keeps restricted input fields out of a public joined table on a phone', async ({ page, browser }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Shared joined values', [
    {
      name: 'People',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Salary', type: 'number' },
      ],
      records: [{ Name: 'Ana', Salary: 987654.25 }],
    },
    { name: 'Keys', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Ana' }] },
  ]);
  const people = database.tables.People!;
  const keys = database.tables.Keys!;
  const tableId = newId('tbl');
  const viewId = newId('viw');
  const nameId = newId('fld');
  const salaryId = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'Joined people',
        fields: [
          { id: nameId, name: 'Name', type: 'text' },
          { id: salaryId, name: 'Salary', type: 'number' },
        ],
        view: { id: viewId, name: 'Grid' },
        joined: {
          baseTableId: people.id,
          steps: [
            {
              tableId: keys.id,
              leftTableId: people.id,
              leftFieldId: people.fields.Name,
              rightFieldId: keys.fields.Name,
              kind: 'inner',
            },
          ],
          fields: [
            { tableId: people.id, fieldId: people.fields.Name, outputFieldId: nameId },
            { tableId: people.id, fieldId: people.fields.Salary, outputFieldId: salaryId },
          ],
        },
      },
    },
  ]);
  await asOwner(page, 'PUT', `/api/fields/${people.fields.Salary}/permissions`, {
    restricted: { roles: [], users: [] },
    locked: null,
  });
  const shared = await asOwner<{ linkId: string }>(page, 'PUT', `/api/views/${viewId}/shared-view`);
  const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const publicPage = await visitor.newPage();
    await visit(publicPage, new URL(`/v/${shared.linkId}`, page.url()).toString());
    await expect(publicPage.getByRole('gridcell', { name: 'Ana', exact: true })).toBeVisible();
    await expect(publicPage.getByRole('columnheader', { name: 'Salary', exact: true })).toHaveCount(0);
    await expect(publicPage.locator('body')).not.toContainText('987');
    await publicPage.reload();
    await expect(publicPage.getByRole('gridcell', { name: 'Ana', exact: true })).toBeVisible();
    await expect(publicPage.getByRole('columnheader', { name: 'Salary', exact: true })).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});

test('creates a joined table using suggestions and retains its setup deep link on a phone', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Joined orders', [
    {
      name: 'Orders',
      fields: [{ name: 'Customer', type: 'text' }],
      records: [{ Customer: 'A' }, { Customer: 'B' }],
    },
    {
      name: 'Customers',
      fields: [
        { name: 'Customer', type: 'text' },
        { name: 'City', type: 'text' },
      ],
      records: [
        { Customer: 'A', City: 'Boston' },
        { Customer: 'B', City: 'Seattle' },
      ],
    },
  ]);
  await openTable(page, database, 'Orders');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
  await expect(page).toHaveURL(/dataPanel=join/);
  await page.reload();
  const dialog = page.getByRole('dialog', { name: 'Create joined table' });
  await dialog.getByRole('button', { name: 'Match Customer with Customer in Customers' }).click();
  await dialog.getByLabel('Table name').fill('Orders with cities');
  // A checkbox row is its label, so the text is what a person taps.
  const included = dialog.getByRole('group', { name: 'Fields to include' });
  await included.getByText('Orders Customer', { exact: true }).click();
  await included.getByText('Customers City', { exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: 'Orders Customer', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Customers City', exact: true })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create joined table', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Joined table—values can be pinned, and rows follow their source tables.'),
  ).toBeVisible();
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(page.getByRole('gridcell', { name: 'Boston', exact: true })).toBeVisible();
});

test('enables computed pins, changes a value, and clears it from a record', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Computed pins', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'First', Amount: 2 }],
    },
  ]);
  const table = database.tables.Items!;
  const formulaId = newId('fld');
  await asOwner(page, 'POST', `/api/databases/${database.id}/commands`, {
    clientId: newId('cli'),
    commands: [
      {
        id: newId('cmd'),
        groupId: newId('act'),
        kind: 'field.create',
        tableId: table.id,
        field: {
          id: formulaId,
          name: 'Twice',
          type: 'formula',
          options: { expression: `{${table.fields.Amount}} * 2` },
        },
      },
    ],
  });
  const grid = await openTable(page, database, 'Items');
  await page.getByRole('button', { name: 'Overrides and history' }).click();
  await page.getByText('Allow pins on formulas, lookups, and rollups', { exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Allow pins on formulas, lookups, and rollups' }),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await grid.getByRole('gridcell', { name: 'First', exact: true }).click();
  await page.keyboard.press('Shift+Space');
  await page.getByLabel('Pinned value for Twice').fill('12');
  await page.getByRole('button', { name: 'Pin value', exact: true }).click();
  await expect(page.getByText('Changed here.  The source says 4.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Use the source value', exact: true }).click();
  await expect(page.getByText('Changed here.  The source says 4.', { exact: true })).toBeHidden();
});

test('opens sync history by deep link and navigates between pages with the keyboard', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Run history', [
    { name: 'Items', fields: [{ name: 'Name', type: 'text' }], records: [] },
  ]);
  const table = database.tables.Items!;
  await page.route(`**/api/tables/${table.id}/sync-history*`, async (route) => {
    const older = new URL(route.request().url()).searchParams.has('cursor');
    await route.fulfill({
      json: {
        runs: [
          {
            id: newId('act'),
            tableId: table.id,
            startedAt: '2026-01-01T00:00:00Z',
            endedAt: '2026-01-01T00:00:02Z',
            outcome: older ? 'failed' : 'succeeded',
            stats: null,
            errorKey: null,
          },
        ],
        next: older ? null : 'older',
      },
    });
  });
  await openTable(page, database, 'Items');
  const url = new URL(page.url());
  url.searchParams.set('dataPanel', 'sync-history');
  await page.goto(url.toString());
  const dialog = page.getByRole('dialog', { name: 'Sync history' });
  await expect(dialog.getByText('Completed', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Older runs' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/syncCursor=older/);
  await page.reload();
  await expect(dialog.getByText('Failed', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Newest runs' }).click();
  await expect(dialog.getByText('Completed', { exact: true })).toBeVisible();
});
