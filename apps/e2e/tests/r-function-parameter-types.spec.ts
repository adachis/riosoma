import { openNewField } from '../grid-fields';
import { expect, test } from '../accessibility';
import { asOwner, createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('named calls retain date-only and date-and-time parameter types in the editor and saved records', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Date parameters', [
    {
      name: 'Events',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Day', type: 'date' },
        { name: 'Moment', type: 'date', options: { includeTime: true } },
      ],
      records: [{ Name: 'Event', Day: '2026-10-01', Moment: '2026-10-01T12:00:00.000Z' }],
    },
  ]);
  const table = database.tables.Events!;
  await openTable(page, database, 'Events');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('IDENTITY');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('value');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('value');
  await page.getByRole('textbox', { name: 'Sample argument: value' }).fill('TODAY()');
  await page.getByRole('button', { name: 'Run test', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Result: "\d{4}-\d{2}-\d{2}"$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await openTable(page, database, 'Events');
  for (const [source, type] of [
    ['Day', 'Date'],
    ['Moment', 'Date and time'],
  ] as const) {
    await openNewField(page);
    const dialog = page.getByRole('dialog', { name: 'New field' });
    await dialog.getByRole('button', { name: /Type/ }).click();
    await page.getByRole('option', { name: 'Formula', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`Copied ${source}`);
    await dialog.getByRole('textbox', { name: 'Formula', exact: true }).fill(`IDENTITY({${source}})`);
    await expect(dialog.getByText(`Result: ${type}`, { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Create field', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  const schema = await asOwner<{ fields: Array<{ id: string; name: string }> }>(
    page,
    'GET',
    `/api/databases/${database.id}/schema`,
  );
  const record = await asOwner<{ values: Record<string, unknown> }>(
    page,
    'GET',
    `/api/tables/${table.id}/records/${table.records[0]}`,
  );
  expect(record.values[schema.fields.find((field) => field.name === 'Copied Day')!.id]).toBe('2026-10-01');
  expect(record.values[schema.fields.find((field) => field.name === 'Copied Moment')!.id]).toBe(
    '2026-10-01T12:00:00.000Z',
  );
});
