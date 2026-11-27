import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '../accessibility';
import { downloadNamedBlob } from '../downloads';
import { base } from '../base';
import { csvRows, part, slides, tableRows, texts, unzip, workbookRows } from '../files';
import { asOwner, createDatabase, createView, openTable, runCommands, signIn } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

async function chooseFile(page: Page, name: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Choose a CSV or Excel file', exact: true }).setInputFiles({
    name,
    mimeType: 'text/csv',
    buffer,
  });
}

async function intoTable(page: Page) {
  await page.getByRole('button', { name: 'More for Records', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import into this table', exact: true }).click();
}

async function download(page: Page, name: 'Download CSV' | 'Download Excel') {
  await page.getByRole('button', { name: 'More for Grid', exact: true }).click();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name, exact: true }).click(),
  ]);
  return readFileSync((await file.path())!);
}

test('imports Unicode and quoted newlines, updates by key, skips repeats, and undoes after reload', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Import review', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Note', type: 'longText' },
      ],
      records: [{ Name: '東京 😀', Amount: 1, Note: 'Original' }],
    },
  ]);
  const table = database.tables.Records!;
  const grid = await openTable(page, database, 'Records');
  await intoTable(page);
  await chooseFile(
    page,
    'quoted.csv',
    Buffer.from(
      '\uFEFFName;Amount;Note\r\n東京 😀;12,50;"First\r\nsecond, with a ""quote"""\r\nمرحبا;0;New\r\nمرحبا;99;Repeated\r\n',
    ),
  );
  const dialog = page.getByRole('dialog', { name: 'Import quoted.csv into Records' });
  await expect(dialog.getByRole('table', { name: 'Preview' })).toBeVisible();
  await dialog.getByRole('button', { name: /Match records on/ }).click();
  await page.getByRole('option', { name: 'Name', exact: true }).click();
  const summary = dialog.getByRole('region', { name: 'What the import will do' });
  await expect(summary).toContainText('1 record to update');
  await expect(summary).toContainText('1 record to add');
  await dialog.getByText('Stop, and import nothing', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await dialog.getByText('The first one wins', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: 'مرحبا', exact: true })).toBeVisible();
  const records = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(records.rows.map((row) => row.values[table.fields.Amount!])).toEqual([12.5, 0]);
  expect(records.rows[0]!.values[table.fields.Note!]).toBe('First\nsecond, with a "quote"');
  const csv = csvRows(await download(page, 'Download CSV'));
  expect(csv).toEqual([
    ['Name', 'Amount', 'Note'],
    ['東京 😀', '12.5', 'First\nsecond, with a "quote"'],
    ['مرحبا', '0', 'New'],
  ]);
  expect((await workbookRows(await download(page, 'Download Excel')))[0]).toEqual([
    ['Name', 'Amount', 'Note'],
    ['東京 😀', 12.5, 'First\nsecond, with a "quote"'],
    ['مرحبا', 0, 'New'],
  ]);
  await page.reload();
  await grid.getByRole('gridcell', { name: '東京 😀', exact: true }).click();
  await page.locator('.rio-grid__input').press('ControlOrMeta+z');
  await expect(grid.getByRole('gridcell', { name: 'مرحبا', exact: true })).toHaveCount(0);
  await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  await page.locator('.rio-grid__input').press('ControlOrMeta+Shift+z');
  await expect(grid.getByRole('gridcell', { name: 'مرحبا', exact: true })).toBeVisible();
});

test('reads Windows-1252 text and UTF-16 files without changing their characters', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'File encodings', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  const inputs = [
    {
      name: 'western.csv',
      buffer: Buffer.concat([
        Buffer.from('Name\r\nCaf'),
        Buffer.from([0xe9, 0x20, 0x80, 0x20, 0x93]),
        Buffer.from('quoted'),
        Buffer.from([0x94]),
        Buffer.from('\r\n'),
      ]),
      value: 'Café € “quoted”',
    },
    {
      name: 'little.csv',
      buffer: Buffer.from('\uFEFFName\r\n東京 😀 مرحبا\r\n', 'utf16le'),
      value: '東京 😀 مرحبا',
    },
    {
      name: 'big.csv',
      buffer: Buffer.from('\uFEFFName\r\n漢字 🦋\r\n', 'utf16le').swap16(),
      value: '漢字 🦋',
    },
    { name: 'unmarked.csv', buffer: Buffer.from('Name\r\nPlain UTF-8 雪\r\n'), value: 'Plain UTF-8 雪' },
  ];
  for (const input of inputs) {
    await intoTable(page);
    await chooseFile(page, input.name, input.buffer);
    const dialog = page.getByRole('dialog', { name: `Import ${input.name} into Records` });
    await expect(dialog.getByRole('cell', { name: input.value, exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByRole('gridcell', { name: input.value, exact: true })).toBeVisible();
  }
});

test('detects a pipe delimiter when a long value has hundreds of commas', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Delimiter detection', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Note', type: 'longText' },
      ],
    },
  ]);
  await openTable(page, database, 'Records');
  await intoTable(page);
  const note = Array.from({ length: 250 }, (_, index) => `item ${index}`).join(',');
  await chooseFile(page, 'pipes.csv', Buffer.from(`Name|Note\nSynthetic|${note}\n`));
  const dialog = page.getByRole('dialog', { name: 'Import pipes.csv into Records' });
  await expect(dialog.getByRole('columnheader')).toHaveCount(2);
  await expect(dialog.getByRole('cell', { name: note, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  expect(csvRows(await download(page, 'Download CSV'))).toEqual([
    ['Name', 'Note'],
    ['Synthetic', note],
  ]);
});

test('imports ragged pipe rows without treating commas in values as separators', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Ragged delimiter', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import a CSV or Excel file', exact: true }).click();
  await chooseFile(
    page,
    'Ragged.csv',
    Buffer.from(
      'Name|Note, label|Amount|Optional\nAlpha|One, two|1|extra\nBeta|Three, four|2\nGamma|Five, six|3\n',
    ),
  );
  const dialog = page.getByRole('dialog', { name: 'Import Ragged.csv' });
  await expect(dialog.getByRole('columnheader')).toHaveCount(4);
  await expect(dialog.getByRole('cell', { name: 'Three, four', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'Gamma', exact: true })).toBeVisible();
  expect(csvRows(await download(page, 'Download CSV'))).toEqual([
    ['Name', 'Note, label', 'Amount', 'Optional'],
    ['Alpha', 'One, two', '1', 'extra'],
    ['Beta', 'Three, four', '2', ''],
    ['Gamma', 'Five, six', '3', ''],
  ]);
});

test('notification Undo works after leaving a database and preserves redo history', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Import notification history', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import a CSV or Excel file', exact: true }).click();
  await chooseFile(page, 'Retained.csv', Buffer.from('Name\nSynthetic retained'));
  const dialog = page.getByRole('dialog', { name: 'Import Retained.csv' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'Synthetic retained', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }),
  ).toBeVisible();
  await page
    .locator('.rio-toast')
    .filter({ hasText: 'Imported 1 record.' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect
    .poll(async () => {
      const schema = await asOwner<{ tables: Array<{ name: string }> }>(
        page,
        'GET',
        `/api/databases/${database.id}/schema`,
      );
      return schema.tables.map((table) => table.name);
    })
    .not.toContain('Retained');
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  await expect(
    history.getByRole('listbox', { name: 'Changes to undo, newest first' }).getByRole('option'),
  ).toHaveCount(0);
  await history
    .getByRole('listbox', { name: 'Changes to redo, next first' })
    .getByRole('option')
    .first()
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: 'Retained', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Retained', exact: true })
    .click();
  await expect(page.getByRole('gridcell', { name: 'Synthetic retained', exact: true })).toBeVisible();
});

test('notification Undo explains when the import cannot be reversed after navigation', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Unavailable import reversal', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import a CSV or Excel file', exact: true }).click();
  await chooseFile(page, 'Unchanged.csv', Buffer.from('Name\nSynthetic unchanged'));
  const dialog = page.getByRole('dialog', { name: 'Import Unchanged.csv' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'Synthetic unchanged', exact: true })).toBeVisible();
  await page.route(`**/api/databases/${database.id}/undo`, (route) =>
    route.fulfill({
      json: { status: 'nothing', state: 'done', skipped: 0 },
    }),
  );
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }),
  ).toBeVisible();
  await page
    .locator('.rio-toast')
    .filter({ hasText: 'Imported 1 record.' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(
    page.locator('.rio-toast').filter({ hasText: 'The import could not be undone.' }),
  ).toBeVisible();
  const schema = await asOwner<{ tables: Array<{ name: string }> }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  expect(schema.tables.map((table) => table.name)).toContain('Unchanged');
});

test('a new database ignores blank lines and preserves the first row when headers are off on a phone', async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }).click();
  await chooseFile(page, 'Blank lines.csv', Buffer.from('Alpha\n\nBeta\n   \nGamma\n'));
  const dialog = page.getByRole('dialog', { name: 'Import Blank lines.csv' });
  await dialog
    .getByRole('checkbox', { name: 'Use the first row as field names', exact: true })
    .press('Space');
  await expect(dialog.getByRole('table', { name: 'Preview' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole('gridcell', { name: 'Gamma', exact: true })).toBeVisible();
  const viewId = new URL(page.url()).pathname.split('/')[3]!;
  const rows = await asOwner<{ rows: unknown[] }>(page, 'GET', `/api/views/${viewId}/rows?refresh=1`);
  expect(rows.rows).toHaveLength(3);
  expect(csvRows(await download(page, 'Download CSV'))).toEqual([
    ['Field 1'],
    ['Alpha'],
    ['Beta'],
    ['Gamma'],
  ]);
  expect(page.url()).toContain(base());
});

test('reimports an exported workbook with real numbers, dates, and checkboxes', async ({ page }) => {
  await signIn(page);
  const fields = [
    { name: 'Name', type: 'text' },
    { name: 'Amount', type: 'number' },
    { name: 'Date', type: 'date', options: { dateFormat: 'iso' } },
    { name: 'Done', type: 'checkbox' },
  ];
  const database = await createDatabase(page, 'Workbook round trip', [
    {
      name: 'Records',
      fields,
      records: [
        { Name: '漢字 🦋', Amount: 1234.5, Date: '2026-09-27', Done: false },
        { Name: 'مرحبا', Amount: 0, Date: '2026-10-03', Done: true },
      ],
    },
  ]);
  await openTable(page, database, 'Records');
  const bytes = await download(page, 'Download Excel');
  const destination = await createDatabase(page, 'Workbook destination', [{ name: 'Records', fields }]);
  await openTable(page, destination, 'Records');
  await intoTable(page);
  await chooseFile(page, 'round-trip.xlsx', bytes);
  const dialog = page.getByRole('dialog', { name: 'Import round-trip.xlsx into Records' });
  await expect(dialog.getByRole('cell', { name: '2026-09-27', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  const table = destination.tables.Records!;
  const result = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(
    result.rows.map((row) =>
      ['Name', 'Amount', 'Date', 'Done'].map((name) => row.values[table.fields[name]!]),
    ),
  ).toEqual([
    ['漢字 🦋', 1234.5, '2026-09-27', false],
    ['مرحبا', 0, '2026-10-03', true],
  ]);
});

test('each view exports its filtered records and visible fields in all four file formats', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const database = await createDatabase(page, 'View exports', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Hidden', type: 'text' },
      ],
      records: [
        { Name: '東京 😀 مرحبا', Amount: 12.5, Hidden: 'Private sentinel' },
        { Name: 'Filtered sentinel', Amount: 0 },
      ],
    },
  ]);
  const table = database.tables.Records!;
  const config = {
    hiddenFieldIds: [table.fields.Hidden],
    filter: {
      conjunction: 'and',
      conditions: [{ id: 'positive', fieldId: table.fields.Amount, operator: 'gt', value: 0 }],
    },
  };
  await runCommands(page, database.id, [{ kind: 'view.update', viewId: table.viewId, config }]);
  const names = ['Grid'];
  for (const type of [
    'kanban',
    'gallery',
    'calendar',
    'form',
    'timeline',
    'gantt',
    'chart',
    'pivot',
    'list',
    'map',
    'orgChart',
  ]) {
    await createView(page, database, 'Records', { name: type, type, config });
    names.push(type);
  }
  await openTable(page, database, 'Records');
  for (const name of names) {
    for (const format of ['csv', 'xlsx', 'docx', 'pptx']) {
      await page
        .getByRole('navigation', { name: 'Views' })
        .getByRole('button', { name: `More for ${name}`, exact: true })
        .click();
      const item = {
        csv: 'Download CSV',
        xlsx: 'Download Excel',
        docx: 'Word document',
        pptx: 'PowerPoint deck',
      }[format]!;
      let press = page.getByRole('menuitem', { name: item, exact: true });
      if (format === 'docx' || format === 'pptx') {
        await press.click();
        press = page
          .getByRole('dialog', {
            name: format === 'docx' ? 'Download a Word document' : 'Download a PowerPoint deck',
          })
          .getByRole('button', { name: 'Download', exact: true });
      }
      const file = await downloadNamedBlob(page, press, `Records - ${name}.${format}`);
      const bytes = readFileSync((await file.path())!);
      let values: unknown[][];
      if (format === 'csv') values = csvRows(bytes);
      else if (format === 'xlsx') values = (await workbookRows(bytes))[0]!;
      else if (format === 'docx') values = tableRows(part(unzip(bytes), 'word/document.xml'));
      else values = slides(unzip(bytes)).map((slide) => texts(slide, 'a:t'));
      if (format !== 'pptx') {
        expect(values).toHaveLength(2);
        expect(values[0]).toEqual(['Name', 'Amount']);
      }
      expect(values.flat()).toContain('東京 😀 مرحبا');
      expect(values.flat().join(' ')).toContain('12.5');
      for (const sentinel of ['Private sentinel', 'Filtered sentinel', 'Hidden'])
        expect(values.flat().join(' ')).not.toContain(sentinel);
    }
  }
});

test('new-table imports enter undo history and undo and redo together after reload', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Imported table history', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Import a CSV or Excel file', exact: true }).click();
  await chooseFile(page, 'Added.csv', Buffer.from('Name\nSynthetic one\nSynthetic two'));
  const dialog = page.getByRole('dialog', { name: 'Import Added.csv' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'Synthetic two', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  await history
    .getByRole('listbox', { name: 'Changes to undo, newest first' })
    .getByRole('option')
    .first()
    .click();
  await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(
    page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: 'Added', exact: true }),
  ).toHaveCount(0);
  await history
    .getByRole('listbox', { name: 'Changes to redo, next first' })
    .getByRole('option')
    .first()
    .click();
  await expect(
    page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: 'Added', exact: true }),
  ).toBeVisible();
});

test('an editor imports validated rows with defaults and live sync while read-only roles cannot import', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Import access', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text', options: { unique: true } },
        { name: 'Amount', type: 'number', options: { validation: { min: { value: 0 } } } },
        { name: 'State', type: 'text', options: { defaultValue: { kind: 'value', value: 'New' } } },
      ],
      records: [{ Name: 'Existing', Amount: 1, State: 'Original' }],
    },
  ]);
  const table = database.tables.Records!;
  const ownerGrid = await openTable(page, database, 'Records');
  const person = await invite(page, browser, 'Import Guest', 'guest');
  try {
    await asOwner(person.page, 'PATCH', '/api/me/preferences', { level: 'standard' });
    const session = await person.page.request.get(`${base()}/api/auth/session`);
    const { csrfToken } = (await session.json()) as { csrfToken: string };
    const match = () =>
      person.page.request.post(`${base()}/api/tables/${table.id}/import/records`, {
        headers: { 'x-csrf-token': csrfToken },
        data: { fieldIds: [table.fields.Name] },
      });
    expect((await match()).status()).toBe(404);
    for (const role of ['reader', 'commenter'] as const) {
      await share(page, database.id, person, role);
      await openTable(person.page, database, 'Records');
      await expect(person.page.getByRole('button', { name: 'More for Records', exact: true })).toHaveCount(0);
      await expect(
        person.page.getByRole('menuitem', { name: 'Import into this table', exact: true }),
      ).toHaveCount(0);
      expect((await match()).status()).toBe(403);
    }
    await share(page, database.id, person, 'editor');
    await openTable(person.page, database, 'Records');
    await intoTable(person.page);
    await chooseFile(
      person.page,
      'validated.csv',
      Buffer.from('Name,Amount\nExisting,9\nSynthetic guest,3\nInvalid,-4\n'),
    );
    const dialog = person.page.getByRole('dialog', { name: 'Import validated.csv into Records' });
    await dialog.getByRole('button', { name: /Match records on/ }).click();
    await person.page.getByRole('option', { name: 'Name', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'What the import will do' })).toContainText(
      '1 row skipped',
    );
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await page.bringToFront();
    await expect(ownerGrid.getByRole('gridcell', { name: '9', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '1 new record', exact: true }).click();
    await expect(ownerGrid.getByRole('gridcell', { name: 'Synthetic guest', exact: true })).toBeVisible();
    const read = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
    expect(read.rows).toHaveLength(2);
    expect(read.rows[1]!.values[table.fields.State!]).toBe('New');
    await person.page.bringToFront();
    await dialog.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(dialog.getByText('The import was undone.', { exact: true })).toBeVisible();
    await page.bringToFront();
    await expect(ownerGrid.getByRole('gridcell', { name: '1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'View changed', exact: true }).click();
    await expect(ownerGrid.getByRole('gridcell', { name: 'Synthetic guest', exact: true })).toHaveCount(0);
  } finally {
    await person.context.close();
  }
});

test('a wide file spans schema and record batches and both exported formats contain every row', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await signIn(page);
  const columns = Array.from({ length: 53 }, (_, index) => `Column ${index}`);
  const lines = [
    columns.join('\t'),
    ...Array.from({ length: 2001 }, (_, row) => columns.map((_, col) => `r${row}c${col}`).join('\t')),
  ];
  await page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }).click();
  await chooseFile(page, 'Wide.tsv', Buffer.from(lines.join('\n')));
  const dialog = page.getByRole('dialog', { name: 'Import Wide.tsv' });
  await expect(dialog.getByRole('columnheader')).toHaveCount(columns.length);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: 'r0c0', exact: true })).toBeVisible();
  for (const item of ['Download CSV', 'Download Excel'] as const) {
    const bytes = await download(page, item);
    const rows = item === 'Download CSV' ? csvRows(bytes) : (await workbookRows(bytes))[0]!;
    expect(rows).toHaveLength(2002);
    expect(rows[0]).toEqual(columns);
    expect(rows[1]).toEqual(columns.map((_, col) => `r0c${col}`));
    expect(rows.at(-1)).toEqual(columns.map((_, col) => `r2000c${col}`));
  }
});

test('unreadable files, unique values, locks, and lost connections report errors and allow recovery', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Import failures', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text', options: { unique: true } },
        { name: 'Note', type: 'text' },
      ],
      records: [{ Name: 'Existing', Note: 'Original' }],
    },
  ]);
  await openTable(page, database, 'Records');
  await intoTable(page);
  await chooseFile(page, 'broken.csv', Buffer.from('Name\n"Unclosed'));
  let dialog = page.getByRole('dialog', { name: 'Import broken.csv into Records' });
  await expect(dialog).toContainText('This file couldn’t be read.');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await chooseFile(page, 'duplicate.csv', Buffer.from('Name\nExisting\n'));
  dialog = page.getByRole('dialog', { name: 'Import duplicate.csv into Records' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Rows 2 were refused');
  await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await intoTable(page);
  await chooseFile(page, 'valid.csv', Buffer.from('Name\nSynthetic recovery\n'));
  dialog = page.getByRole('dialog', { name: 'Import valid.csv into Records' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('status', { name: 'What the import did' })).toContainText('Added 1 record.');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Synthetic recovery', exact: true })).toBeVisible();
  const table = database.tables.Records!;
  await runCommands(page, database.id, [
    {
      kind: 'record.setLock',
      tableId: table.id,
      recordIds: [table.records[0]],
      locked: true,
      reason: 'Reviewed synthetic record',
    },
    {
      kind: 'table.update',
      tableId: table.id,
      recordLock: { bypass: 'nobody', condition: null, reason: '' },
    },
  ]);
  await intoTable(page);
  await chooseFile(page, 'locked.csv', Buffer.from('Name,Note\nExisting,Attempted\n'));
  dialog = page.getByRole('dialog', { name: 'Import locked.csv into Records' });
  await dialog.getByRole('button', { name: /Match records on/ }).click();
  await page.getByRole('option', { name: 'Name', exact: true }).click();
  await expect(dialog.getByRole('region', { name: 'What the import will do' })).toContainText(
    '1 record to update',
  );
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Rows 2 were refused');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
  await page.route(`**/api/databases/${database.id}/commands`, (route) => route.abort());
  await intoTable(page);
  await chooseFile(page, 'connection.csv', Buffer.from('Name\nUnsent synthetic\n'));
  dialog = page.getByRole('dialog', { name: 'Import connection.csv into Records' });
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(dialog).toContainText('The import stopped');
  await expect(dialog.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.unroute(`**/api/databases/${database.id}/commands`);
  const saved = await asOwner<{ rows: unknown[] }>(page, 'GET', `/api/views/${table.viewId}/rows?refresh=1`);
  expect(saved.rows).toHaveLength(2);
});
