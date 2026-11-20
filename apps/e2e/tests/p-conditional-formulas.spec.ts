import { openNewField } from '../grid-fields';
import { expect, test, type Locator, type Page } from '../accessibility';
import { labelName, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });

async function choose(page: Page, dialog: Locator, label: string, value: string) {
  await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await page.getByRole('option', { name: labelName(value), exact: true }).click();
}
async function addField(page: Page, name: string, type: string) {
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await expect(dialog).toBeVisible();
  await choose(page, dialog, 'Type', type);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  return dialog;
}

test('creates a conditional rollup and a structured SUMIFS through the editor', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Conditional orders', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'First' }] },
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'First', Amount: 4 },
        { Name: 'First', Amount: 9 },
      ],
    },
  ]);
  const orders = database.tables.Orders!,
    items = database.tables.Items!;
  const link = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: orders.id,
      field: { id: link, name: 'Items', type: 'link', options: { linkedTableId: items.id } },
    },
    {
      kind: 'record.update',
      tableId: orders.id,
      records: [{ id: orders.records[0], values: { [link]: items.records } }],
    },
  ]);
  const grid = await openTable(page, database, 'Orders');
  await expect(grid.getByRole('gridcell', { name: 'First', exact: true })).toBeVisible();
  let dialog = await addField(page, 'Large amounts', 'Rollup');
  await choose(page, dialog, 'Field to summarize', 'Amount');
  await choose(page, dialog, 'Summary', 'Sum');
  await dialog.getByRole('button', { name: 'Add condition', exact: true }).click();
  const condition = dialog.getByRole('group', { name: 'Condition', exact: true });
  await condition.getByRole('button', { name: / Field$/ }).click();
  await page.getByRole('option', { name: labelName('Amount'), exact: true }).click();
  await condition.getByRole('button', { name: / Condition$/ }).click();
  await page.getByRole('option', { name: labelName('>'), exact: true }).click();
  await condition.getByRole('textbox', { name: 'Value', exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: '9', exact: true })).toBeVisible();
  dialog = await addField(page, 'Matching total', 'Formula');
  await dialog.getByRole('textbox', { name: 'Formula' }).fill('SUMIFS(Items[Amount], Items[Name], {Name})');
  await expect(dialog.getByText('Result: Number')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: '13', exact: true })).toBeVisible();
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: items.id,
      records: [{ id: items.records[1], values: { [items.fields.Amount!]: 10 } }],
    },
  ]);
  await expect(grid.getByRole('gridcell', { name: '14', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('gridcell', { name: '14', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await openNewField(page);
  await expect(page.getByRole('dialog', { name: 'New field' })).toBeVisible();
});
