import { openNewField } from '../grid-fields';
import { expect, test } from '../accessibility';
import {
  asOwner,
  createDatabase,
  createView,
  newId,
  openTable,
  runCommands,
  signIn,
  visit,
} from '../helpers';
import { invite, share } from '../people';
import { base } from '../base';

test.use({ serviceWorkers: 'block' });

test('named-function completion preserves arguments when correcting an existing call', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Function completion', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Order' }] },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page.getByRole('button', { name: 'Save function' }).click();

  const grid = await openTable(page, database, 'Orders');
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await dialog.getByRole('button', { name: /Type/ }).click();
  await page.getByRole('option', { name: 'Formula', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Total');
  const formula = dialog.getByRole('textbox', { name: 'Formula', exact: true });
  await formula.fill('DO(5)');
  await formula.press('ArrowLeft');
  await formula.press('ArrowLeft');
  await formula.press('ArrowLeft');
  await formula.press('u');
  await expect(page.getByRole('option', { name: 'DOUBLE(amount)', exact: true })).toBeVisible();
  await formula.press('Enter');
  await expect(formula).toHaveValue('DOUBLE(5)');
  await expect(dialog.getByText('Result: Number', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create field', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: '10', exact: true })).toBeVisible();
});

test('a long function body reports its calculation limit and remains manageable', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Long function body', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('LONG_TOTAL');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('1+'.repeat(4_000) + '1');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'This calculation exceeds the formula’s limits.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await expect(page.getByRole('button', { name: 'LONG_TOTAL()', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'LONG_TOTAL()', exact: true }).click();
  await page.getByRole('button', { name: 'Delete function', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete LONG_TOTAL?' });
  await dialog.getByRole('button', { name: 'Delete function', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'LONG_TOTAL()', exact: true })).toHaveCount(0);
});

test('a function draft survives a server refusal and saves after the connection returns', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Function recovery', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await expect(page.getByText('No named functions yet.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Create function' }).click();
  const name = 'F'.repeat(64);
  const description = '漢字 😀 مرحبا '.repeat(250);
  await page.getByRole('textbox', { name: 'Function name' }).fill(name);
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill(description);
  const formula = page.getByRole('textbox', { name: 'Formula', exact: true });
  await formula.fill('value');
  const commands = `**/api/databases/${database.id}/commands`;
  await page.route(commands, async (route) => {
    const batch = route.request().postDataJSON() as { commands: Array<{ id: string }> };
    await route.fulfill({
      json: {
        results: batch.commands.map(({ id }) => ({
          id,
          status: 'rejected',
          error: { code: 'internal', messageKey: 'errors.internal', userFault: false },
        })),
      },
    });
  });
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await expect(page.getByText('Something went wrong on the server.', { exact: true })).toBeVisible();
  await expect(formula).toHaveValue('value');
  await expect(page.getByRole('textbox', { name: 'Function name' })).toHaveValue(name);
  await page.unroute(commands);
  await page.context().setOffline(true);
  try {
    await page.getByRole('button', { name: 'Save function', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save function', exact: true })).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Offline' })).toBeVisible();
    await expect(formula).toHaveValue('value');
  } finally {
    await page.context().setOffline(false);
  }
  await expect(page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `${name}(value)`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Description', exact: true })).toHaveValue(description);
  await visit(page, page.url());
  await expect(formula).toHaveValue('value');
});

test('renaming a used function leaves its formula readable for repair', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Function rename', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'Order', Amount: 5 }],
    },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page.getByRole('button', { name: 'Save function' }).click();
  const table = database.tables.Orders!;
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: newId('fld'),
        name: 'Total',
        type: 'formula',
        options: { expression: `DOUBLE({${table.fields.Amount}})` },
      },
    },
  ]);
  await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('TRIPLE');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 3');
  await page.getByRole('button', { name: 'Save function' }).click();
  const grid = await openTable(page, database, 'Orders');
  await grid.getByRole('columnheader', { name: 'Total', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  const formula = dialog.getByRole('textbox', { name: 'Formula', exact: true });
  await expect(formula).toHaveValue('DOUBLE({Amount})');
  await expect(dialog.getByText('There’s no function named DOUBLE.', { exact: true })).toBeVisible();
  await formula.fill('TRIPLE({Amount})');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: '15', exact: true })).toBeVisible();
});

test('a reader sees another person’s edits to an open named function', async ({ page, browser }) => {
  test.setTimeout(150_000);
  await signIn(page);
  const database = await createDatabase(page, 'Function collaboration', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page.getByRole('button', { name: 'Save function' }).click();
  await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
  const link = page.url();
  const reader = await invite(page, browser, 'Function reader');
  try {
    await visit(reader.page, link);
    await expect(
      reader.page.getByText('This database doesn’t exist, or you don’t have access to it.', { exact: true }),
    ).toBeVisible();
    await expect(reader.page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
    await share(page, database.id, reader, 'reader');
    await reader.page.setViewportSize({ width: 390, height: 844 });
    await visit(reader.page, link);
    const name = reader.page.getByRole('textbox', { name: 'Function name' });
    await expect(name).toHaveValue('DOUBLE');
    await expect(name).toHaveAttribute('readonly', '');
    await expect(reader.page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Function name' }).fill('TRIPLE');
    await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 3');
    await page.getByRole('button', { name: 'Save function' }).click();
    await expect(reader.page.getByRole('button', { name: 'TRIPLE(amount)', exact: true })).toBeVisible();
    await expect(name).toHaveValue('TRIPLE');
    await expect(reader.page.getByRole('textbox', { name: 'Formula', exact: true })).toHaveValue(
      'amount * 3',
    );
    await share(page, database.id, reader, 'commenter');
    await visit(reader.page, link);
    await expect(name).toHaveAttribute('readonly', '');
    await expect(reader.page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
    await share(page, database.id, reader, 'editor');
    await visit(reader.page, link);
    const draft = reader.page.getByRole('textbox', { name: 'Formula', exact: true });
    await draft.fill('amount * 4');
    await page.getByRole('button', { name: 'TRIPLE(amount)', exact: true }).click();
    await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 5');
    await page.getByRole('button', { name: 'Save function', exact: true }).click();
    await reader.page.getByRole('button', { name: 'Save function', exact: true }).click();
    await expect(
      reader.page.getByText('Someone else changed this at the same time.  Try again.', { exact: true }),
    ).toBeVisible();
    await expect(draft).toHaveValue('amount * 4');
    await reader.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await reader.page.getByRole('button', { name: 'TRIPLE(amount)', exact: true }).click();
    await expect(draft).toHaveValue('amount * 5');
    await draft.fill('amount * 4');
    await reader.page.getByRole('button', { name: 'Save function', exact: true }).click();
    await expect(reader.page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
  } finally {
    await reader.context.close();
  }
  const guest = await invite(page, browser, 'Function guest', 'guest');
  try {
    await share(page, database.id, guest, 'reader');
    await visit(guest.page, link);
    await expect(guest.page.getByRole('textbox', { name: 'Function name' })).toHaveValue('TRIPLE');
    await expect(guest.page.getByRole('textbox', { name: 'Function name' })).toHaveAttribute('readonly', '');
    await expect(guest.page.getByRole('textbox', { name: 'Formula', exact: true })).toHaveValue('amount * 4');
    await expect(guest.page.getByRole('button', { name: 'Save function', exact: true })).toHaveCount(0);
  } finally {
    await guest.context.close();
  }
});

test('function deletion, undo, redo, and database copying preserve dependent calculations', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Function lifecycle', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'Order', Amount: 3 }],
    },
  ]);
  const table = database.tables.Orders!;
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page.getByRole('button', { name: 'Save function' }).click();
  const total = newId('fld');
  const dependent = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: total,
        name: 'Total',
        type: 'formula',
        options: { expression: `DOUBLE({${table.fields.Amount}})` },
      },
    },
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: dependent,
        name: 'Next total',
        type: 'formula',
        options: { expression: `{${total}} + 1` },
      },
    },
  ]);
  await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
  await page.getByRole('button', { name: 'Delete function', exact: true }).click();
  const warning = page.getByRole('dialog', { name: 'Delete DOUBLE?' });
  await expect(warning).toContainText('Orders: Total');
  await warning.getByRole('button', { name: 'Delete function', exact: true }).click();
  await expect(warning).toBeHidden();
  const record = () =>
    asOwner<{ values: Record<string, unknown>; errors?: Record<string, string> }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${table.records[0]}`,
    );
  expect(await record()).toMatchObject({
    values: { [total]: null, [dependent]: null },
    errors: { [total]: 'formula.function.unknown', [dependent]: 'formula.function.unknown' },
  });
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  const reverse = async (direction: 'undo' | 'redo') => {
    const response = page.waitForResponse((response) =>
      response.url().endsWith(`/api/databases/${database.id}/${direction}`),
    );
    await history
      .getByRole('listbox', {
        name: direction === 'undo' ? 'Changes to undo, newest first' : 'Changes to redo, next first',
      })
      .getByRole('option')
      .first()
      .click();
    expect(await (await response).json()).toMatchObject({ status: 'applied' });
  };
  await reverse('undo');
  expect(await record()).toMatchObject({ values: { [total]: 6, [dependent]: 7 } });
  await reverse('redo');
  expect(await record()).toMatchObject({ values: { [total]: null, [dependent]: null } });
  await reverse('undo');
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();
  const grid = await openTable(page, database, 'Orders');
  await expect(grid.getByRole('gridcell', { name: '6', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate database', exact: true }).click();
  const copy = page.getByRole('dialog', { name: 'Duplicate Function lifecycle' });
  await copy.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await copy.getByRole('button', { name: 'Open the new database', exact: true }).click({ timeout: 30_000 });
  await expect(page.getByRole('gridcell', { name: '6', exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'DOUBLE(amount)', exact: true })).toBeVisible();

  await openTable(page, database, 'Orders');
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: 'Snapshots', exact: true }).click();
  let snapshot = page.getByRole('dialog', { name: 'Snapshots', exact: true });
  await snapshot.getByRole('textbox', { name: 'Snapshot name' }).fill('Before function edit');
  await snapshot.getByRole('button', { name: 'Take a snapshot', exact: true }).click();
  await expect(snapshot.getByRole('button', { name: 'More for Before function edit' })).toBeVisible();
  await snapshot.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 4');
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  const changed = await openTable(page, database, 'Orders');
  await expect(changed.getByRole('gridcell', { name: '12', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Database settings' }).click();
  await page.getByRole('menuitem', { name: 'Snapshots', exact: true }).click();
  snapshot = page.getByRole('dialog', { name: 'Snapshots', exact: true });
  await snapshot.getByRole('button', { name: 'More for Before function edit' }).click();
  await page.getByRole('menuitem', { name: 'Restore as a new database', exact: true }).click();
  await snapshot.getByRole('button', { name: 'Restore as a new database', exact: true }).click();
  await snapshot
    .getByRole('button', { name: 'Open the new database', exact: true })
    .click({ timeout: 30_000 });
  await expect(page.getByRole('gridcell', { name: '6', exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Formula', exact: true })).toHaveValue('amount * 2');
});

test('the function test panel handles scalar types, invalid arguments, and recursion', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Function arguments', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('IDENTITY');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value');
  const formula = page.getByRole('textbox', { name: 'Formula', exact: true });
  await formula.fill('value');
  for (const [sample, result] of [
    ['42', '42'],
    ['"漢字 😀 مرحبا"', '"漢字 😀 مرحبا"'],
    ['TRUE()', 'true'],
    ['BLANK()', 'null'],
    ['DATETIME_PARSE("2026-10-01T12:00:00Z")', '"2026-10-01T12:00:00.000Z"'],
  ]) {
    await page.getByRole('textbox', { name: 'Sample argument: value' }).fill(sample!);
    await page.getByRole('button', { name: 'Run test', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: `Result: ${result}` })).toBeVisible();
  }
  await formula.fill('IDENTITY(value)');
  await expect(page.getByRole('button', { name: 'Save function' })).toBeDisabled();
  await expect(page.locator('.rio-formula-editor__error')).toHaveText(
    'Named functions cannot call themselves, even through another function.',
  );
  await formula.fill('missing');
  await expect(page.getByRole('button', { name: 'Save function' })).toBeDisabled();
  await expect(page.locator('.rio-formula-editor__error')).toContainText('missing');
  await formula.fill('value');
  await page.getByRole('textbox', { name: 'Sample argument: value' }).fill('1 / 0');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'zero' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Sample argument: value' }).fill('7');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Result: 7' })).toBeVisible();
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await page.getByRole('button', { name: 'Create function', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('WRAPPER');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value');
  await formula.fill('IDENTITY(value)');
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await page.getByRole('button', { name: 'IDENTITY(value)', exact: true }).click();
  await formula.fill('WRAPPER(value)');
  await expect(page.getByRole('button', { name: 'Save function', exact: true })).toBeDisabled();
  await expect(page.locator('.rio-formula-editor__error')).toHaveText(
    'Named functions cannot call themselves, even through another function.',
  );
  await formula.fill('value');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value, value');
  await expect(page.getByRole('button', { name: 'Save function', exact: true })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value');
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await page.getByRole('button', { name: 'WRAPPER(value)', exact: true }).click();
  await page.getByRole('textbox', { name: 'Sample argument: value' }).fill('9');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Result: 9' })).toBeVisible();
});

test('every supported field default reaches grid records, record cards, and public forms', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const a = { id: newId('cho'), name: 'First', color: 'blue' };
  const b = { id: newId('cho'), name: 'Second', color: 'red' };
  const specs = [
    {
      name: 'Name',
      type: 'text',
      options: { defaultValue: { kind: 'value', value: '漢字 😀 مرحبا' }, validation: { required: {} } },
    },
    { name: 'Count', type: 'number', options: { defaultValue: { kind: 'value', value: 0 } } },
    { name: 'Price', type: 'currency', options: { defaultValue: { kind: 'value', value: 12.5 } } },
    { name: 'Share', type: 'percent', options: { defaultValue: { kind: 'value', value: 0.25 } } },
    { name: 'Stars', type: 'rating', options: { defaultValue: { kind: 'value', value: 4 } } },
    { name: 'Approved', type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
    {
      name: 'Priority',
      type: 'singleSelect',
      options: { choices: [a, b], defaultValue: { kind: 'firstChoice' } },
    },
    {
      name: 'Tags',
      type: 'multipleSelect',
      options: { choices: [a, b], defaultValue: { kind: 'value', value: [a.id, b.id] } },
    },
    { name: 'Date', type: 'date', options: { defaultValue: { kind: 'value', value: '2026-10-01' } } },
    {
      name: 'Today',
      type: 'date',
      options: { timeZone: 'Pacific/Kiritimati', defaultValue: { kind: 'today' } },
    },
    { name: 'Now', type: 'date', options: { includeTime: true, defaultValue: { kind: 'now' } } },
    {
      name: 'Website',
      type: 'url',
      options: { defaultValue: { kind: 'value', value: 'https://example.test' } },
    },
    {
      name: 'Email',
      type: 'email',
      options: { defaultValue: { kind: 'value', value: 'team@example.test' } },
    },
    { name: 'Phone', type: 'phone', options: { defaultValue: { kind: 'value', value: '555-0100' } } },
    { name: 'Person', type: 'user', options: { defaultValue: { kind: 'creator' } } },
  ];
  const database = await createDatabase(page, 'All defaults', [
    {
      name: 'Tasks',
      fields: specs,
      records: [
        Object.fromEntries(specs.map((field) => [field.name, field.name === 'Name' ? 'Existing' : null])),
      ],
    },
  ]);
  const table = database.tables.Tasks!;
  const expected = Object.fromEntries(
    Object.entries({
      Name: '漢字 😀 مرحبا',
      Count: 0,
      Price: 12.5,
      Share: 0.25,
      Stars: 4,
      Approved: true,
      Priority: a.id,
      Tags: [a.id, b.id],
      Date: '2026-10-01',
      Website: 'https://example.test',
      Email: 'team@example.test',
      Phone: '555-0100',
    }).map(([name, value]) => [table.fields[name], value]),
  );
  const rows = () =>
    asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
  const grid = await openTable(page, database, 'Tasks');
  await grid.getByRole('button', { name: 'Add record', exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: '漢字 😀 مرحبا', exact: true })).toBeVisible();
  const added = (await rows()).rows.find((row) => row.id !== table.records[0])!;
  expect(added.values).toMatchObject(expected);
  expect(added.values[table.fields.Today!]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(added.values[table.fields.Now!]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(added.values[table.fields.Person!]).toEqual([expect.any(String)]);
  await grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: '漢字 😀 مرحبا', exact: true }) })
    .getByRole('button', { name: /^Expand row/ })
    .click();
  const card = page.getByRole('dialog', { name: '漢字 😀 مرحبا', exact: true });
  await expect(card.getByRole('combobox', { name: 'Priority', exact: true })).toHaveValue('First');
  await expect(card.getByRole('group', { name: 'Person', exact: true })).toContainText('Ada Lovelace');
  await page.keyboard.press('Escape');
  const viewId = await createView(page, database, 'Tasks', {
    name: 'Form',
    type: 'form',
    config: {
      form: {
        allowEdits: true,
        questions: specs
          .filter((field) => field.name !== 'Person')
          .map((field) => ({ fieldId: table.fields[field.name], required: true })),
      },
    },
  });
  const shared = await asOwner<{ path: string }>(page, 'PUT', `/api/views/${viewId}/public-form`);
  const visitor = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 390, height: 844 },
  });
  try {
    const form = await visitor.newPage();
    await visit(form, `${base()}${shared.path}`);
    await form.getByRole('button', { name: 'Submit', exact: true }).click();
    const edit = form.getByRole('link', { name: 'Edit your response', exact: true });
    await expect(edit).toBeVisible();
    const submitted = (await rows()).rows.find((row) => row.id !== table.records[0] && row.id !== added.id)!;
    expect(submitted.values).toMatchObject(expected);
    expect(submitted.values[table.fields.Person!]).toBeNull();
    await runCommands(page, database.id, [
      {
        kind: 'field.update',
        fieldId: table.fields.Name,
        options: { ...specs[0]!.options, defaultValue: { kind: 'value', value: 'Changed default' } },
      },
    ]);
    await edit.click();
    await expect(form.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('漢字 😀 مرحبا');
    await form.getByRole('button', { name: 'Save response', exact: true }).click();
    await expect(form.getByText('Your response was updated.', { exact: true })).toBeVisible();
    expect((await rows()).rows.find((row) => row.id === submitted.id)!.values).toMatchObject(expected);
    expect((await rows()).rows.find((row) => row.id === table.records[0])!.values[table.fields.Name!]).toBe(
      'Existing',
    );
  } finally {
    await visitor.close();
  }
});

test.describe('date defaults in imports', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati' });

  test('grid and imported records take today from the person’s time zone', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const database = await createDatabase(page, 'Import defaults', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text', options: { defaultValue: { kind: 'value', value: 'Grid record' } } },
          { name: 'Date', type: 'date', options: { timeZone: 'client', defaultValue: { kind: 'today' } } },
        ],
        records: [{ Name: 'Existing', Date: null }],
      },
    ]);
    const table = database.tables.Tasks!;
    const rows = () =>
      asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${table.viewId}/rows?refresh=1`,
      );
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
    const grid = await openTable(page, database, 'Tasks');
    await grid.getByRole('button', { name: 'Add record', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: 'Grid record', exact: true })).toBeVisible();
    expect(
      (await rows()).rows.find((row) => row.values[table.fields.Name!] === 'Grid record')!.values,
    ).toMatchObject({
      [table.fields.Date!]: today,
    });
    await page.getByRole('button', { name: 'More for Tasks', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import into this table', exact: true }).click();
    await page.getByLabel('Choose a CSV or Excel file', { exact: true }).setInputFiles({
      name: 'records.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Name\nImported record\n'),
    });
    const dialog = page.getByRole('dialog', { name: 'Import records.csv into Tasks' });
    await expect(dialog.getByRole('table', { name: 'Preview' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    expect(
      (await rows()).rows.find((row) => row.values[table.fields.Name!] === 'Imported record')!.values,
    ).toMatchObject({
      [table.fields.Date!]: today,
    });
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(dialog.getByText('The import was undone.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    expect((await rows()).rows).toHaveLength(2);
  });
});
