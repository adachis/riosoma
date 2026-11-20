import { openNewField } from '../grid-fields';
import { expect, test, type Locator, type Page } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

/**
 * Formulas over lookups, typed into the field editor as a person would.  A line item multiplies its
 * product's looked-up price by its quantity, an order adds up its lines' totals with SUM, and a
 * formula that would read its own result back through the other table is refused.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.  The screen is wide enough for the grid to draw every column.
test.use({ serviceWorkers: 'block', viewport: { width: 1920, height: 1080 } });

/** Picks an option from one of the field editor's selects, named by its label. */
async function choose(page: Page, dialog: Locator, label: string, option: string): Promise<void> {
  await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Opens the editor for a new field from the grid's header. */
async function newField(page: Page, name: string, type: string): Promise<Locator> {
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await choose(page, dialog, 'Type', type);
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  return dialog;
}

/** A grid row, found by its record's name. */
function row(grid: Locator, name: string): Locator {
  return grid.getByRole('row').filter({ has: grid.page().getByRole('gridcell', { name, exact: true }) });
}

test('formulas multiply a looked-up price, total a lookup, and refuse a loop through another table', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await signIn(page);
  const database = await createDatabase(page, 'Chandlery Orders', [
    {
      name: 'Line items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Quantity', type: 'number' },
      ],
      records: [
        { Name: 'Chain for 1001', Quantity: 3 },
        { Name: 'Lamps for 1001', Quantity: 4 },
      ],
    },
    {
      name: 'Products',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Price', type: 'number' },
      ],
      records: [
        { Name: 'Anchor chain', Price: 40 },
        { Name: 'Deck lamp', Price: 12.5 },
      ],
    },
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Order 1001' }] },
  ]);
  const lines = database.tables['Line items']!;
  const products = database.tables.Products!;
  const orders = database.tables.Orders!;
  // Each line links to one product and one order, and looks up its product's price.
  const product = newId('fld');
  const order = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: lines.id,
      field: { id: product, name: 'Product', type: 'link', options: { linkedTableId: products.id } },
    },
    {
      kind: 'field.create',
      tableId: lines.id,
      field: { id: order, name: 'Order', type: 'link', options: { linkedTableId: orders.id } },
    },
    {
      kind: 'field.create',
      tableId: lines.id,
      field: {
        id: newId('fld'),
        name: 'Unit price',
        type: 'lookup',
        options: { linkFieldId: product, targetFieldId: products.fields.Price },
      },
    },
  ]);
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: lines.id,
      records: [
        { id: lines.records[0], values: { [product]: [products.records[0]], [order]: [orders.records[0]] } },
        { id: lines.records[1], values: { [product]: [products.records[1]], [order]: [orders.records[0]] } },
      ],
    },
  ]);

  // A lookup with one value reads as that value in arithmetic, and the editor says so.
  let grid = await openTable(page, database, 'Line items');
  await expect(row(grid, 'Chain for 1001').getByRole('gridcell', { name: '40', exact: true })).toBeVisible();
  let dialog = await newField(page, 'Line total', 'Formula');
  await dialog.getByRole('textbox', { name: 'Formula' }).fill('{Unit price} * {Quantity}');
  await expect(dialog.getByText('Result: Number')).toBeVisible();
  await expect(dialog.getByText(/^Unit price reads as its one value here/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(grid, 'Chain for 1001').getByRole('gridcell', { name: '120', exact: true })).toBeVisible();
  await expect(row(grid, 'Lamps for 1001').getByRole('gridcell', { name: '50', exact: true })).toBeVisible();

  // An order looks up its lines' totals, and SUM adds up every value the lookup holds.
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
  grid = page.getByRole('grid', { name: 'Grid' });
  await expect(grid.getByRole('gridcell', { name: 'Order 1001' })).toBeVisible();
  dialog = await newField(page, 'Line totals', 'Lookup');
  await choose(page, dialog, 'Linked field', 'Line items');
  await choose(page, dialog, 'Field to look up', 'Line total');
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  dialog = await newField(page, 'Order total', 'Formula');
  await dialog.getByRole('textbox', { name: 'Formula' }).fill('SUM({Line totals})');
  await expect(dialog.getByText('Result: Number')).toBeVisible();
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(grid, 'Order 1001').getByRole('gridcell', { name: '170', exact: true })).toBeVisible();

  // Back on the lines, a lookup of the order's total is fine on its own, but the line total can't
  // read it: the order's total already reads the line total.
  await page.getByRole('link', { name: 'Line items', exact: true }).click();
  grid = page.getByRole('grid', { name: 'Grid' });
  dialog = await newField(page, 'Order sum', 'Lookup');
  await choose(page, dialog, 'Linked field', 'Order');
  await choose(page, dialog, 'Field to look up', 'Order total');
  await dialog.getByRole('button', { name: 'Create field' }).click();
  await expect(dialog).toBeHidden();
  await expect(row(grid, 'Chain for 1001').getByRole('gridcell', { name: '170', exact: true })).toBeVisible();

  await grid.getByRole('columnheader', { name: 'Line total' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit field' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit field' });
  await dialog.getByRole('textbox', { name: 'Formula' }).fill('{Unit price} * {Quantity} + {Order sum}');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('This formula refers back to itself.')).toBeVisible();
  // Nothing changed: each line's total, and the order's total it looks up, are what they were.
  await expect(row(grid, 'Chain for 1001').getByRole('gridcell', { name: '120', exact: true })).toBeVisible();
  await page.reload();
  await expect(row(grid, 'Chain for 1001').getByRole('gridcell', { name: '120', exact: true })).toBeVisible();
  await expect(row(grid, 'Lamps for 1001').getByRole('gridcell', { name: '50', exact: true })).toBeVisible();
  await expect(row(grid, 'Lamps for 1001').getByRole('gridcell', { name: '170', exact: true })).toBeVisible();
});

test('a record card that’s open when a lookup is added shows the lookup’s value', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Chandlery Stock', [
    { name: 'Line items', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Chain for 1002' }] },
    {
      name: 'Products',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Price', type: 'number' },
      ],
      records: [{ Name: 'Anchor chain', Price: 40 }],
    },
  ]);
  const lines = database.tables['Line items']!;
  const products = database.tables.Products!;
  const product = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: lines.id,
      field: { id: product, name: 'Product', type: 'link', options: { linkedTableId: products.id } },
    },
  ]);
  await runCommands(page, database.id, [
    {
      kind: 'record.update',
      tableId: lines.id,
      records: [{ id: lines.records[0], values: { [product]: [products.records[0]] } }],
    },
  ]);
  const grid = await openTable(page, database, 'Line items');
  await row(grid, 'Chain for 1002')
    .getByRole('button', { name: /^Expand row/ })
    .click();
  const card = page.getByRole('dialog', { name: 'Chain for 1002' });
  await expect(card.getByRole('group', { name: 'Product' })).toContainText('Anchor chain');

  // Someone else adds a lookup of the product's price while the card is open.  Its field shows up on
  // the card, and its value should too.
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: lines.id,
      field: {
        id: newId('fld'),
        name: 'Unit price',
        type: 'lookup',
        options: { linkFieldId: product, targetFieldId: products.fields.Price },
      },
    },
  ]);
  const price = card.getByRole('group', { name: 'Unit price' });
  await expect(price).toBeVisible();
  await expect(price).toHaveText('40');
});
