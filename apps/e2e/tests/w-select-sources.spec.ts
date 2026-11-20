import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('configures cascades and table options across the grid, forms, and phone records', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Select sources', [
    {
      name: 'Places',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Label', type: 'text' },
      ],
      records: [
        { Name: 'Place one', Label: 'North' },
        { Name: 'Place two', Label: 'South' },
      ],
    },
    {
      name: 'Entries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Country', type: 'singleSelect', choices: ['United States', 'Canada'] },
        { name: 'City', type: 'multipleSelect', choices: ['Seattle', 'Toronto'] },
        { name: 'Place', type: 'singleSelect' },
      ],
      records: [{ Name: 'Entry', Country: 'United States' }],
    },
  ]);
  const entries = database.tables.Entries!;
  const places = database.tables.Places!;
  await openTable(page, database, 'Entries');
  const tableUrl = page.url();
  await page.goto(`${tableUrl}?fieldRules=${entries.fields.City}`);
  let dialog = page.getByRole('dialog', { name: 'Edit field', exact: true });
  await dialog.getByRole('button', { name: /Option source/ }).click();
  await page.getByRole('option', { name: 'Another select in this record', exact: true }).click();
  await dialog
    .getByRole('group', { name: 'United States', exact: true })
    .getByText('Seattle', { exact: true })
    .click();
  await expect(
    dialog
      .getByRole('group', { name: 'United States', exact: true })
      .getByRole('checkbox', { name: 'Seattle', exact: true }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: /Parent option/ }).click();
  await page.getByRole('option', { name: 'Canada', exact: true }).click();
  await dialog
    .getByRole('group', { name: 'Canada', exact: true })
    .getByText('Toronto', { exact: true })
    .click();
  await expect(
    dialog
      .getByRole('group', { name: 'Canada', exact: true })
      .getByRole('checkbox', { name: 'Toronto', exact: true }),
  ).toBeChecked();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const grid = page.getByRole('grid');
  const row = grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Entry', exact: true }) });
  await row.getByRole('gridcell').nth(2).dblclick();
  await expect(page.getByRole('option', { name: 'Seattle', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Toronto', exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Find an option', exact: true }).press('Enter');
  await page.keyboard.press('Escape');
  await expect(row.getByRole('img', { name: 'Seattle', exact: true })).toBeVisible();

  await page.goto(`${tableUrl}?fieldRules=${entries.fields.Place}`);
  dialog = page.getByRole('dialog', { name: 'Edit field', exact: true });
  await dialog.getByRole('button', { name: /Option source/ }).click();
  await page.getByRole('option', { name: 'Another table', exact: true }).click();
  await dialog.getByRole('button', { name: /Option labels/ }).click();
  await page.getByRole('option', { name: 'Label', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await row.getByRole('gridcell').nth(3).dblclick();
  await page.getByRole('option', { name: 'North', exact: true }).click();
  await expect(row.getByRole('img', { name: 'North', exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: places.id,
      records: [{ id: places.records[0], values: { [places.fields.Label!]: 'Northern' } }],
    },
  ]);
  await expect(row.getByRole('img', { name: 'Northern', exact: true })).toBeVisible();
  await page.goto(`${tableUrl}?fieldRules=${entries.fields.Place}`);
  dialog = page.getByRole('dialog', { name: 'Edit field', exact: true });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Selected place');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('img', { name: 'Northern', exact: true })).toBeVisible();

  const formId = newId('viw');
  await runCommands(page, database.id, [
    {
      kind: 'view.create',
      view: {
        id: formId,
        tableId: entries.id,
        name: 'Entry form',
        type: 'form',
        config: {
          form: {
            questions: [
              { fieldId: entries.fields.Country },
              { fieldId: entries.fields.City },
              { fieldId: entries.fields.Place },
            ],
          },
        },
      },
    },
  ]);
  await page.goto(tableUrl.replace(entries.viewId, formId));
  await page.getByRole('combobox', { name: 'Country', exact: true }).fill('Canada');
  await page.getByRole('option', { name: 'Canada', exact: true }).click();
  await page.getByRole('combobox', { name: 'City', exact: true }).fill('Tor');
  await expect(page.getByRole('option', { name: 'Toronto', exact: true })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Seattle', exact: true })).toHaveCount(0);
  await page.getByRole('option', { name: 'Toronto', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Selected place', exact: true }).fill('Northern');
  await expect(page.getByRole('option', { name: 'Northern', exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(tableUrl);
  await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'City', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Selected place', exact: true }).fill('South');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/databases/${database.id}/commands`) &&
        response.request().method() === 'POST',
    ),
    page.getByRole('option', { name: 'South', exact: true }).click(),
  ]);
  await expect(page.getByRole('combobox', { name: 'Selected place', exact: true })).toHaveValue('South');
  const recordPath = `/api/tables/${entries.id}/records/${entries.records[0]}`;
  const before = await asOwner<{ values: Record<string, unknown> }>(page, 'GET', recordPath);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await runCommands(page, database.id, [
    { kind: 'record.trash', tableId: places.id, recordIds: [places.records[1]] },
  ]);
  await page.reload();
  await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  const unavailable = page.getByRole('combobox', { name: 'Selected place', exact: true });
  await expect(unavailable).toHaveAttribute('placeholder', 'Unavailable option');
  await unavailable.focus();
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const after = await asOwner<{ values: Record<string, unknown> }>(page, 'GET', recordPath);
  expect(after.values[entries.fields.Place!]).toBe(before.values[entries.fields.Place!]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('searches source options beyond the first page and keeps the selected label', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Large option source', [
    {
      name: 'Options',
      fields: [{ name: 'Name', type: 'text' }],
      records: Array.from({ length: 1000 }, (_, index) => ({ Name: `Option ${index}` })),
    },
    {
      name: 'Entries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Selection', type: 'singleSelect' },
      ],
      records: [{ Name: 'Entry' }],
    },
  ]);
  const options = database.tables.Options!;
  const entries = database.tables.Entries!;
  const later = newId('rec');
  await runCommands(page, database.id, [
    {
      kind: 'record.create',
      tableId: options.id,
      records: [{ id: later, values: { [options.fields.Name!]: 'Later choice' } }],
    },
    {
      kind: 'field.update',
      fieldId: entries.fields.Selection,
      options: { choices: [], source: { tableId: options.id } },
    },
  ]);
  const grid = await openTable(page, database, 'Entries');
  const row = grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Entry', exact: true }) });
  await row.getByRole('gridcell').nth(1).dblclick();
  await expect(
    page.getByRole('status').filter({ hasText: 'Showing the first 1,000 options.' }),
  ).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find an option', exact: true }).fill('Later');
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/databases/${database.id}/commands`) &&
        response.request().method() === 'POST',
    ),
    page.getByRole('option', { name: 'Later choice', exact: true }).click(),
  ]);
  await expect(row.getByRole('img', { name: 'Later choice', exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: options.id,
      records: [{ id: later, values: { [options.fields.Name!]: 'Renamed later' } }],
    },
  ]);
  await expect(row.getByRole('img', { name: 'Renamed later', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Selection', exact: true })).toHaveValue('Renamed later');
  const linked = newId('fld');
  const lookup = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: options.id,
      field: { id: linked, name: 'Entries link', type: 'link', options: { linkedTableId: entries.id } },
    },
    {
      kind: 'field.create',
      tableId: options.id,
      field: {
        id: lookup,
        name: 'Selection lookup',
        type: 'lookup',
        options: { linkFieldId: linked, targetFieldId: entries.fields.Selection },
      },
    },
    {
      kind: 'record.update',
      tableId: options.id,
      records: [{ id: options.records[0], values: { [linked]: [entries.records[0]] } }],
    },
  ]);
  await openTable(page, database, 'Options');
  // The lookup's first row read must finish before checking its rendered label.
  const [rows] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes(`/api/views/${options.viewId}/rows?`) &&
        response.request().method() === 'GET',
    ),
    page.reload(),
  ]);
  expect(rows.ok()).toBe(true);
  const lookedUp = page
    .getByRole('grid')
    .getByRole('row')
    .filter({
      has: page.getByRole('gridcell', { name: 'Option 0', exact: true }),
    });
  await expect(lookedUp.getByRole('gridcell', { name: 'Renamed later', exact: true })).toBeVisible();
});

test('previews a fixed select source change and preserves matching labels', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Source conversion', [
    { name: 'Labels', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Matched' }] },
    {
      name: 'Entries',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Selection', type: 'singleSelect', choices: ['Matched'] },
      ],
      records: [{ Name: 'Entry', Selection: 'Matched' }],
    },
  ]);
  const entries = database.tables.Entries!;
  await openTable(page, database, 'Entries');
  await page.goto(`${page.url()}?fieldRules=${entries.fields.Selection}`);
  const dialog = page.getByRole('dialog', { name: 'Edit field', exact: true });
  await dialog.getByRole('button', { name: /Option source/ }).click();
  await page.getByRole('option', { name: 'Another table', exact: true }).click();
  await expect(dialog.getByText('1 value checked.', { exact: true })).toBeVisible();
  await expect(dialog.getByText('0 selections will be dropped.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('grid').getByRole('img', { name: 'Matched', exact: true })).toBeVisible();
});
