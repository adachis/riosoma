import { readFileSync } from 'node:fs';
import { expect, test, type Locator } from '../accessibility';
import { asOwner, createDatabase, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

for (const width of [1200, 390]) {
  test(`maps three joined tables, edits precedence, filters, groups, and exports at ${width} pixels`, async ({
    page,
  }) => {
    await signIn(page);
    await page.setViewportSize({ width, height: 900 });
    const values = ['Ana', 'Bo', 'Cam', 'Dee'];
    const database = await createDatabase(page, 'Joined column mapping', [
      {
        name: 'Orders',
        fields: [
          { name: 'cust_id', type: 'text' },
          { name: 'cust_name', type: 'text' },
          { name: 'sku', type: 'text' },
          { name: 'addr', type: 'text' },
        ],
        records: values.map((name, index) => ({
          cust_id: `C${index}`,
          cust_name: name,
          sku: `P${index}`,
          addr: 'Boston',
        })),
      },
      {
        name: 'Customers',
        fields: [
          { name: 'id', type: 'text' },
          { name: 'customer_name', type: 'text' },
          { name: 'product_code', type: 'text' },
          { name: 'address', type: 'text' },
          { name: 'cust_name', type: 'text' },
        ],
        records: values.map((name, index) => ({
          id: `C${index}`,
          customer_name: name,
          product_code: `P${index}`,
          address: 'Boston',
          cust_name: name,
        })),
      },
      {
        name: 'Shipments',
        fields: [
          { name: 'customer_id', type: 'text' },
          { name: 'CustomerName', type: 'text' },
          { name: 'productCode', type: 'text' },
          { name: 'Address', type: 'text' },
        ],
        records: values.map((name, index) => ({
          customer_id: `C${index}`,
          CustomerName: name,
          productCode: `P${index}`,
          Address: 'Boston',
        })),
      },
    ]);
    await openTable(page, database, 'Orders');
    await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create joined table', exact: true });
    const choose = async (scope: Locator, label: string, value: string) => {
      await scope.getByRole('button', { name: new RegExp(`${label}$`) }).click();
      await page.getByRole('option', { name: value, exact: true }).click();
    };
    const first = dialog.getByRole('group', { name: 'Join 1', exact: true });
    await choose(first, 'Next table', 'Customers');
    await choose(first, 'Key from an earlier table', 'Orders cust_id');
    await choose(first, 'Key from the next table', 'id');
    await dialog.getByRole('button', { name: 'Add another table', exact: true }).click();
    const second = dialog.getByRole('group', { name: 'Join 2', exact: true });
    await choose(second, 'Next table', 'Shipments');
    await choose(second, 'Key from an earlier table', 'Orders cust_id');
    await choose(second, 'Key from the next table', 'customer_id');
    await dialog.getByLabel('Table name', { exact: true }).fill('Customer deliveries');
    await dialog.getByRole('button', { name: 'Accept all mappings', exact: true }).click();
    const mapping = dialog.getByRole('group', { name: 'cust_name', exact: true });
    await mapping.getByLabel('Output column name').fill('Customer');
    await dialog
      .getByRole('group', { name: 'Customer', exact: true })
      .getByRole('button', { name: 'Move Customers customer_name up', exact: true })
      .click();
    await expect(
      dialog.getByRole('group', { name: 'Customer', exact: true }).getByRole('listitem').first(),
    ).toContainText('Customers customer_name');
    await dialog.getByRole('button', { name: 'Create joined table', exact: true }).click();
    await expect(dialog).toBeHidden();
    const heading = page.getByRole('columnheader', { name: 'Customer', exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveAttribute(
      'title',
      /Mapped from Customers customer_name, Orders cust_name, Customers cust_name, Shipments CustomerName/,
    );
    await expect(page.getByRole('gridcell', { name: 'Ana', exact: true })).toBeVisible();
    const schema = await asOwner<{
      tables: Array<{ id: string; name: string; joined?: { fields: unknown[] } }>;
      fields: Array<{ id: string; tableId: string; name: string }>;
      views: Array<{ id: string; tableId: string }>;
    }>(page, 'GET', `/api/databases/${database.id}/schema`);
    const table = schema.tables.find((table) => table.name === 'Customer deliveries')!;
    const view = schema.views.find((view) => view.tableId === table.id)!;
    const fields = schema.fields.filter((field) => field.tableId === table.id);
    expect(fields).toHaveLength(4);
    const customer = fields.find((field) => field.name === 'Customer')!;
    const address = fields.find((field) => field.name === 'addr')!;
    await runCommands(page, database.id, [
      {
        kind: 'view.update',
        viewId: view.id,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'customer', fieldId: customer.id, operator: 'is', value: 'Ana' }],
          },
        },
      },
    ]);
    await expect(page.getByRole('gridcell', { name: 'Bo', exact: true })).toHaveCount(0);
    await expect(page.getByRole('gridcell', { name: 'Ana', exact: true })).toBeVisible();
    await runCommands(page, database.id, [
      {
        kind: 'view.update',
        viewId: view.id,
        config: { groups: [{ fieldId: address.id, direction: 'asc' }] },
      },
    ]);
    await expect(
      page.getByRole('treegrid').getByRole('row', { name: 'Boston, 1 record', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: width === 390 ? 'More' : 'More for Grid', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'Download CSV', exact: true }).click(),
    ]);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv).toContain('Customer');
    expect(csv).toContain('Ana');
    expect(csv).not.toContain('customer_name');
    expect(csv.trim().split(/\r?\n/)).toEqual(['cust_id,Customer,sku,addr', 'C0,Ana,P0,Boston']);
    await page.getByRole('button', { name: 'Map corresponding columns', exact: true }).click();
    await expect(page).toHaveURL(/dataPanel=mapping/);
    await page.reload();
    const settings = page.getByRole('dialog', { name: 'Map corresponding columns', exact: true });
    await settings.getByRole('button', { name: 'Split Customer into separate columns', exact: true }).click();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings).toBeHidden();
    await page.reload();
    const after = await asOwner<{ fields: Array<{ tableId: string }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
    expect(after.fields.filter((field) => field.tableId === table.id)).toHaveLength(7);
    expect(await page.locator('body').evaluate((body) => body.scrollWidth <= innerWidth)).toBe(true);
  });
}
