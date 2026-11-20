import { expect, test, type Locator, type Page } from '../accessibility';
import { asOwner, createDatabase, openTable, pasteText, signIn } from '../helpers';
import { rows } from '../sql';

test.use({ serviceWorkers: 'block', hasTouch: true });
test.setTimeout(90_000);

async function clipboard(input: Locator, kind: 'copy' | 'paste', data?: { text: string; html: string }) {
  return input.evaluate(
    (element, { kind, data }) => {
      const clipboardData = new DataTransfer();
      if (data) {
        clipboardData.setData('text/plain', data.text);
        clipboardData.setData('text/html', data.html);
      }
      const event = new ClipboardEvent(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: clipboardData });
      element.dispatchEvent(event);
      return { text: clipboardData.getData('text/plain'), html: clipboardData.getData('text/html') };
    },
    { kind, data },
  );
}

async function history(page: Page, redo = false) {
  const answer = page.waitForResponse((response) => response.url().endsWith(redo ? '/redo' : '/undo'));
  await page.locator('.rio-grid__input').focus();
  await page.locator('.rio-grid__input').press(redo ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+z');
  expect((await answer).ok()).toBe(true);
}

test('spreadsheet paste, copy, fill, clear, replace, and history survive table changes and reload', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Spreadsheet editing', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Status', type: 'singleSelect', choices: ['Ready'] },
      ],
      records: [{ Name: 'Original', Amount: 1, Status: 'Ready' }],
    },
    { name: 'Other', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Other original' }] },
  ]);
  const table = database.tables.Records!;
  const grid = await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  const cell = (row: number, col: number) =>
    grid.locator(`[role="gridcell"][data-rio-row="${row}"][data-rio-col="${col}"]`);
  await cell(0, 0).click();
  await clipboard(input, 'paste', {
    text: '東京 🦋\t10\tReady\r\nمرحبا\t20\tNew\r\n',
    html: '<meta charset="utf-8"><table><tbody><tr><td>東京 🦋</td><td>10</td><td>Ready</td></tr><tr><td>مرحبا</td><td>20</td><td>New</td></tr></tbody></table>',
  });
  const preview = page.getByRole('dialog', { name: 'Paste 6 cells?' });
  await expect(preview).toContainText('Adds 1 new record.');
  await expect(preview).toContainText('Adds options to Status: New');
  await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cell(0, 0)).toHaveText('Original');
  await pasteText(input, '東京 🦋\t10\tReady\r\nمرحبا\t20\tNew\r\n');
  await preview.getByRole('button', { name: 'Paste', exact: true }).click();
  await expect(cell(1, 0)).toHaveText('مرحبا');
  await expect(cell(1, 2)).toHaveText('New');
  await history(page);
  await expect(cell(0, 0)).toHaveText('Original');
  await expect(cell(1, 0)).toHaveCount(0);
  await history(page, true);
  await expect(cell(1, 0)).toHaveText('مرحبا');
  await cell(0, 0).click();
  await input.press('Shift+ArrowRight');
  const copied = await clipboard(input, 'copy');
  expect(copied.text).toBe('東京 🦋\t10\r\n');
  await cell(1, 0).click();
  await clipboard(input, 'paste', copied);
  await expect(cell(1, 0)).toHaveText('東京 🦋');
  await expect(cell(1, 1)).toHaveText('10');
  await history(page);
  await expect(cell(1, 0)).toHaveText('مرحبا');
  await cell(0, 1).click();
  await input.press('Shift+ArrowDown');
  await input.press('ControlOrMeta+d');
  await expect(cell(1, 1)).toHaveText('10');
  await history(page);
  await expect(cell(1, 1)).toHaveText('20');
  await cell(0, 0).click();
  await input.press('Shift+ArrowDown');
  await input.press('Shift+ArrowRight');
  await input.press('Delete');
  await expect(cell(0, 0)).toHaveText('');
  await expect(cell(1, 1)).toHaveText('');
  await history(page);
  await expect(cell(0, 0)).toHaveText('東京 🦋');
  await expect(cell(1, 1)).toHaveText('20');
  await cell(0, 0).click();
  await input.press('ControlOrMeta+f');
  const find = page.getByRole('search', { name: 'Find in this view' });
  await find.getByRole('textbox', { name: 'Find', exact: true }).fill('東京');
  await expect(find).toContainText('1 of 1');
  await find.getByRole('button', { name: 'Replace', exact: true }).click();
  await find.getByRole('textbox', { name: 'Replace with' }).fill('京都');
  await find.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect(cell(0, 0)).toHaveText('京都 🦋');
  await find.getByRole('button', { name: 'Close find' }).click();
  const other = await openTable(page, database, 'Other');
  await other.getByRole('gridcell', { name: 'Other original', exact: true }).dblclick();
  await input.fill('Other changed');
  await input.press('Enter');
  await expect(other.getByRole('gridcell', { name: 'Other changed', exact: true })).toBeVisible();
  await page.reload();
  await history(page);
  await expect(other.getByRole('gridcell', { name: 'Other original', exact: true })).toBeVisible();
  await history(page);
  const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(saved.rows[0]!.values[table.fields.Name!]).toBe('東京 🦋');
  await history(page, true);
  await history(page, true);
  await expect(other.getByRole('gridcell', { name: 'Other changed', exact: true })).toBeVisible();
});

test('scalar editors validate values, keep invalid drafts, and move with Enter and Tab', async ({ page }) => {
  await signIn(page);
  const fields = [
    { name: 'Name', type: 'text', text: '東京 🦋 مرحبا' },
    { name: 'Amount', type: 'number', text: '1234.5' },
    { name: 'Price', type: 'currency', text: '12.50' },
    { name: 'Progress', type: 'percent', text: '25%' },
    { name: 'Elapsed', type: 'duration', text: '1:30' },
    { name: 'Email', type: 'email', text: 'person@example.test' },
    { name: 'Website', type: 'url', text: 'https://example.test/path' },
    { name: 'Phone', type: 'phone', text: '+1 212 555 0123' },
  ];
  const database = await createDatabase(page, 'Scalar editing', [
    {
      name: 'Records',
      fields: [...fields, { name: 'Done', type: 'checkbox' }],
      records: [{ Name: 'First' }, { Name: 'Second' }],
    },
  ]);
  const table = database.tables.Records!;
  const grid = await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  await grid.locator('[data-rio-row="0"][data-rio-col="0"]').click();
  for (const field of fields) {
    await input.press('F2');
    await input.fill(field.text);
    await input.press('Tab');
  }
  await input.press('Space');
  await input.press('Home');
  await input.press('ArrowRight');
  await input.press('Enter');
  await input.fill('invalid');
  await input.press('Enter');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expect(input).toHaveValue('invalid');
  await input.press('Escape');
  await input.press('F2');
  await input.fill('42');
  await input.press('Enter');
  await expect(grid.locator('[data-rio-row="1"][data-rio-col="1"]')).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(saved.rows[0]!.values).toMatchObject({
    [table.fields.Name!]: fields[0]!.text,
    [table.fields.Amount!]: 42,
    [table.fields.Price!]: 12.5,
    [table.fields.Progress!]: 0.25,
    [table.fields.Elapsed!]: 5400,
    [table.fields.Email!]: fields[5]!.text,
    [table.fields.Website!]: fields[6]!.text,
    [table.fields.Phone!]: fields[7]!.text,
    [table.fields.Done!]: true,
  });
});

test('expanded cell editors save typed dates, multiline text, JSON, locations, and signatures', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Expanded cell editing', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Day', type: 'date' },
        { name: 'Moment', type: 'date', options: { includeTime: true, timeZone: 'UTC', timeFormat: '24h' } },
        { name: 'Notes', type: 'longText' },
        { name: 'Data', type: 'json' },
        { name: 'Site', type: 'location' },
        { name: 'Approval', type: 'signature' },
      ],
      records: [{ Name: 'First' }],
    },
  ]);
  const table = database.tables.Records!;
  await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  const open = async (column: number, name: string) => {
    await input.focus();
    await input.press('ControlOrMeta+Home');
    for (let index = 0; index < column; index++) await input.press('ArrowRight');
    await input.press('Enter');
    const editor = page.getByRole('dialog', { name, exact: true });
    await expect(editor).toBeVisible();
    return editor;
  };
  let editor = await open(1, 'Day');
  await editor.getByRole('textbox', { name: 'Day', exact: true }).fill('2026-10-02');
  await editor.getByRole('textbox', { name: 'Day', exact: true }).press('Enter');
  await expect(editor).toBeHidden();
  editor = await open(2, 'Moment');
  await editor.getByRole('textbox', { name: 'Moment', exact: true }).fill('2026-10-03');
  await editor.getByRole('textbox', { name: 'Time', exact: true }).fill('14:30');
  await editor.getByRole('textbox', { name: 'Time', exact: true }).press('Enter');
  await expect(editor).toBeHidden();
  const text = '東京 🦋\nمرحبا\n' + 'Long notes '.repeat(200);
  editor = await open(3, 'Notes');
  await editor.getByRole('textbox', { name: 'Notes', exact: true }).fill(text);
  await editor.getByRole('textbox', { name: 'Notes', exact: true }).press('ControlOrMeta+Enter');
  await expect(editor).toBeHidden();
  editor = await open(4, 'Data');
  await editor.getByRole('textbox', { name: 'Data', exact: true }).fill('{invalid');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Data', exact: true })).toHaveValue('{invalid');
  const data = { name: '東京 🦋 مرحبا', values: [1, null, true] };
  await editor.getByRole('textbox', { name: 'Data', exact: true }).fill(JSON.stringify(data));
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();
  editor = await open(5, 'Site');
  await editor.getByRole('textbox', { name: 'Place', exact: true }).fill('東京 🦋');
  await editor.getByRole('textbox', { name: 'Latitude, longitude', exact: true }).fill('91, 0');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toContainText('Latitude runs from -90 to 90');
  await editor.getByRole('textbox', { name: 'Latitude, longitude', exact: true }).fill('35.6762, 139.6503');
  await editor.getByRole('textbox', { name: 'Latitude, longitude', exact: true }).press('Enter');
  await expect(editor).toBeHidden();
  editor = await open(6, 'Approval');
  await editor.getByRole('textbox', { name: 'Your name', exact: true }).fill('署名 🦋');
  await editor.getByRole('textbox', { name: 'Your name', exact: true }).press('Enter');
  await expect(editor).toBeHidden();
  await page.reload();
  const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  const values = saved.rows[0]!.values;
  expect(values).toMatchObject({
    [table.fields.Day!]: '2026-10-02',
    [table.fields.Moment!]: '2026-10-03T14:30:00.000Z',
    [table.fields.Notes!]: text,
    [table.fields.Site!]: { lat: 35.6762, lng: 139.6503, label: '東京 🦋' },
    [table.fields.Approval!]: { name: '署名 🦋', drawing: null },
  });
  expect(JSON.parse(values[table.fields.Data!] as string)).toEqual(data);
  await history(page);
  const undone = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(undone.rows[0]!.values[table.fields.Approval!]).toBeNull();
  await history(page, true);
  editor = await open(6, 'Approval');
  await expect(editor.getByRole('button', { name: 'Sign again', exact: true })).toBeVisible();
  await editor.press('Escape');
});

test('100,000 rows stay virtualized while jumping, scrolling, and finding a distant record', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Large grid', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Records!;
  const schemas = await rows<{ table_schema: string }>(
    'SELECT table_schema FROM information_schema.tables WHERE table_name = $1',
    [table.id],
  );
  expect(schemas).toHaveLength(1);
  const physical = `"${schemas[0]!.table_schema}"."${table.id}"`;
  await rows(`INSERT INTO ${physical} (__id, "${table.fields.Name}")
    SELECT 'rec' || lpad(n::text, 14, '0'), 'Record ' || n FROM generate_series(1, 100000) AS n`);
  const grid = await openTable(page, database, 'Records');
  await expect(grid.getByRole('gridcell', { name: 'Record 1', exact: true })).toBeVisible();
  await grid.getByRole('gridcell', { name: 'Record 1', exact: true }).click();
  const input = page.locator('.rio-grid__input');
  await input.press('ControlOrMeta+End');
  await expect(grid.locator('[data-rio-row="99999"][data-rio-col="0"]')).toHaveText('Record 100000');
  expect(await grid.locator('[role="gridcell"][data-rio-row]').count()).toBeLessThan(100);
  await input.press('ControlOrMeta+Home');
  await input.press('PageDown');
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).not.toHaveText('Record 1');
  await input.press('ControlOrMeta+f');
  const find = page.getByRole('search', { name: 'Find in this view' });
  await find.getByRole('textbox', { name: 'Find', exact: true }).fill('Record 99999');
  await expect(find).toContainText('1 of 1');
  await expect(grid.locator('[role="gridcell"][aria-selected="true"]')).toHaveText('Record 99999');
  await find.getByRole('button', { name: 'Close find' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await grid.getByRole('gridcell', { name: 'Record 99999', exact: true }).tap();
  await expect(input).toBeFocused();
  expect(await grid.locator('[role="gridcell"][data-rio-row]').count()).toBeLessThan(100);
});

test('a grid edit recovers from a server error and a lost connection before reload and undo', async ({
  page,
  context,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Editing recovery', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Original' }],
    },
  ]);
  const grid = await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  let requests = 0;
  await page.route(`**/api/databases/${database.id}/commands`, async (route) => {
    if (++requests === 1)
      await route.fulfill({ status: 503, json: { error: { messageKey: 'errors.internal' } } });
    else await route.continue();
  });
  await grid.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
  await input.fill('After server recovery');
  const confirmed = page.waitForResponse((response) => response.url().endsWith('/commands') && response.ok());
  await input.press('Enter');
  await confirmed;
  expect(requests).toBeGreaterThan(1);
  await context.setOffline(true);
  await grid.getByRole('gridcell', { name: 'After server recovery', exact: true }).dblclick();
  await input.fill('After reconnect 東京 🦋');
  await input.press('Enter');
  await expect(grid.getByRole('gridcell', { name: 'After reconnect 東京 🦋', exact: true })).toBeVisible();
  const reconnected = page.waitForResponse(
    (response) => response.url().endsWith('/commands') && response.ok(),
  );
  await context.setOffline(false);
  await reconnected;
  await page.reload();
  await expect(grid.getByRole('gridcell', { name: 'After reconnect 東京 🦋', exact: true })).toBeVisible();
  await history(page);
  await expect(grid.getByRole('gridcell', { name: 'After server recovery', exact: true })).toBeVisible();
  await history(page);
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
});
