import { expect, test } from '../accessibility';
import { labelName, asOwner, createDatabase, flip, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('an automation creates a record with defaults and a named-function result', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Automation defaults', [
    {
      name: 'Requests',
      fields: [
        { name: 'Name', type: 'text', options: { defaultValue: { kind: 'value', value: 'New request' } } },
      ],
    },
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number', options: { defaultValue: { kind: 'value', value: 7 } } },
        { name: 'Approved', type: 'checkbox', options: { defaultValue: { kind: 'value', value: true } } },
        { name: 'Person', type: 'user', options: { defaultValue: { kind: 'creator' } } },
      ],
    },
  ]);
  const orders = database.tables.Orders!;
  await runCommands(page, database.id, [
    {
      kind: 'namedFunction.create',
      functionId: newId('fnc'),
      definition: { name: 'DOUBLE', parameters: ['amount'], body: 'amount * 2' },
    },
    {
      kind: 'field.create',
      tableId: orders.id,
      field: {
        id: newId('fld'),
        name: 'Total',
        type: 'formula',
        options: { expression: `DOUBLE({${orders.fields.Amount}})` },
      },
    },
  ]);
  await openTable(page, database, 'Requests');
  await page.getByRole('button', { name: 'Add an automation', exact: true }).click();
  const name = page.getByRole('textbox', { name: 'Name', exact: true });
  await name.fill('Create an order');
  await name.press('Enter');
  await page.getByRole('button', { name: 'Add a step', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Create a record'), exact: true }).click();
  const step = page.getByRole('region', { name: 'Create a record', exact: true });
  await step.getByRole('button', { name: /Table$/ }).click();
  await page.getByRole('option', { name: labelName('Orders'), exact: true }).click();
  await step.getByRole('button', { name: 'Set a field', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Name'), exact: true }).click();
  const value = step.getByRole('textbox', { name: 'Name', exact: true });
  await value.fill('Automated order');
  await value.blur();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Draft: not live yet', { exact: true })).toBeHidden();
  await flip(page.getByRole('switch', { name: 'Off', exact: true }));
  await expect(page.getByRole('switch', { name: 'On', exact: true })).toBeChecked();
  const requests = await openTable(page, database, 'Requests');
  const ordersPage = await page.context().newPage();
  let snapshotTaken!: () => void;
  const snapshotReady = new Promise<void>((resolve) => {
    snapshotTaken = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  await ordersPage.route(`**/api/views/${orders.viewId}/rows?**`, async (route) => {
    if (held) {
      await route.continue();
      return;
    }
    held = true;
    const response = await route.fetch();
    snapshotTaken();
    await blocked;
    await route.fulfill({ response });
  });
  const opening = openTable(ordersPage, database, 'Orders');
  try {
    await snapshotReady;
    await requests.getByRole('button', { name: 'Add record', exact: true }).click();
    await expect(async () => {
      const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${orders.viewId}/rows?offset=0&limit=50&tz=UTC`,
      );
      expect(saved.rows.some((row) => row.values[orders.fields.Name!] === 'Automated order')).toBe(true);
    }).toPass();
  } finally {
    release();
  }
  const grid = await opening;
  const created = grid.getByRole('gridcell', { name: 'Automated order', exact: true });
  // The first page must reconcile changes received before its snapshot starts being watched.
  await expect(created).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '7', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: '14', exact: true })).toBeVisible();
  await grid
    .getByRole('button', { name: /^Expand row/ })
    .first()
    .click();
  const card = ordersPage.getByRole('dialog', { name: 'Automated order', exact: true });
  await expect(card.getByRole('checkbox', { name: 'Approved', exact: true })).toBeChecked();
  await expect(card.getByRole('group', { name: 'Person', exact: true })).toContainText('Ada Lovelace');
  await ordersPage.close();
});
