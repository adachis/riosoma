import { expect, test, type Page } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block', viewport: { width: 1920, height: 1080 } });

async function createFunction(page: Page, name: string, parameter: string, body: string) {
  await page.getByRole('button', { name: 'Create function', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill(name);
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill(parameter);
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill(body);
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name}(${parameter})`, exact: true })).toBeVisible();
}

test('named-function edits refresh lookup lists, rollups, filtered rows, and conditional colors', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const database = await createDatabase(page, 'Function dependencies', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Order' }] },
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'First item', Amount: 2 },
        { Name: 'Second item', Amount: 1 },
      ],
    },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await createFunction(page, 'MULTIPLY', 'amount', 'amount');
  await createFunction(page, 'TOTAL', 'values', 'SUM(values)');
  const orders = database.tables.Orders!;
  const items = database.tables.Items!;
  const computed = newId('fld');
  const link = newId('fld');
  const lookup = newId('fld');
  const rolled = newId('fld');
  const total = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: items.id,
      field: {
        id: computed,
        name: 'Computed amount',
        type: 'formula',
        options: { expression: `MULTIPLY({${items.fields.Amount}})` },
      },
    },
    {
      kind: 'field.create',
      tableId: orders.id,
      field: { id: link, name: 'Items', type: 'link', options: { linkedTableId: items.id } },
    },
    {
      kind: 'field.create',
      tableId: orders.id,
      field: {
        id: lookup,
        name: 'Amounts',
        type: 'lookup',
        options: { linkFieldId: link, targetFieldId: computed },
      },
    },
    {
      kind: 'field.create',
      tableId: orders.id,
      field: {
        id: rolled,
        name: 'Rolled amount',
        type: 'rollup',
        options: { linkFieldId: link, targetFieldId: computed, fn: 'sum' },
      },
    },
    {
      kind: 'field.create',
      tableId: orders.id,
      field: { id: total, name: 'Total', type: 'formula', options: { expression: `TOTAL({${lookup}})` } },
    },
    {
      kind: 'record.update',
      tableId: orders.id,
      records: [{ id: orders.records[0], values: { [link]: items.records } }],
    },
  ]);
  const filtered = await createView(page, database, 'Orders', {
    name: 'Large orders',
    type: 'grid',
    config: {
      filter: { conjunction: 'and', conditions: [{ id: 'large', fieldId: total, operator: 'gt', value: 4 }] },
      colorRules: [
        {
          id: 'large-color',
          name: 'Needs review',
          target: 'record',
          condition: { id: 'large-color-condition', fieldId: total, operator: 'gt', value: 4 },
          color: 'red',
        },
      ],
    },
  });
  const observer = await page.context().newPage();
  const watching = await page.context().newPage();
  try {
    const grid = await openTable(observer, database, 'Orders');
    await expect(grid.getByRole('gridcell', { name: '3', exact: true })).toHaveCount(2);
    await visit(watching, `${base()}/${database.id}/${orders.id}/${filtered}`);
    const filteredGrid = watching.getByRole('grid', { name: 'Large orders' });
    await expect(filteredGrid).toBeVisible();
    await expect(filteredGrid.getByRole('gridcell', { name: 'Order', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'MULTIPLY(amount)', exact: true }).click();
    await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
    await page.getByRole('button', { name: 'Save function', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: '6', exact: true })).toHaveCount(2);
    const order = filteredGrid.getByRole('gridcell', { name: 'Order', exact: true });
    await expect(order).toBeVisible();
    await expect(order).toHaveAttribute('aria-description', /Needs review/);
    await expect(filteredGrid.getByRole('gridcell', { name: '6', exact: true })).toHaveCount(2);
    await visit(observer, observer.url());
    await expect(grid.getByRole('gridcell', { name: '6', exact: true })).toHaveCount(2);
  } finally {
    await observer.close();
    await watching.close();
  }
});
