import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, createView, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('a filtered view recovers after a function edit and a failed snapshot refresh', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Snapshot recovery', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: Array.from({ length: 4 }, (_, index) => ({ Name: `Order ${index + 1}`, Amount: index + 1 })),
    },
  ]);
  const table = database.tables.Orders!;
  const computed = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'namedFunction.create',
      functionId: newId('fnc'),
      definition: { name: 'MULTIPLY', parameters: ['amount'], body: 'amount' },
    },
    {
      kind: 'field.create',
      tableId: table.id,
      field: {
        id: computed,
        name: 'Computed amount',
        type: 'formula',
        options: { expression: `MULTIPLY({${table.fields.Amount}})` },
      },
    },
  ]);
  const filtered = await createView(page, database, 'Orders', {
    name: 'Large orders',
    type: 'grid',
    config: {
      filter: {
        conjunction: 'and',
        conditions: [{ id: 'large', fieldId: computed, operator: 'gt', value: 4 }],
      },
    },
  });
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'MULTIPLY(amount)', exact: true }).click();
  const observer = await page.context().newPage();
  let refreshes = 0;
  await observer.route(`**/api/views/${filtered}/rows?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') === '1' && ++refreshes === 1) {
      await route.fulfill({
        status: 500,
        json: { error: { code: 'internal', messageKey: 'errors.internal', userFault: false } },
      });
    } else await route.continue();
  });
  try {
    await visit(observer, `${base()}/${database.id}/${table.id}/${filtered}`);
    const grid = observer.getByRole('grid', { name: 'Large orders', exact: true });
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: /^Order \d$/ })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 10');
    await page.getByRole('button', { name: 'Save function', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: /^Order \d$/ })).toHaveCount(4, { timeout: 15_000 });
    expect(refreshes).toBe(2);
  } finally {
    await observer.close();
  }
});

test('a phone recovers a creation during initial loading after a failed snapshot refresh', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Loading recovery', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Orders!;
  const observer = await page.context().newPage();
  await observer.setViewportSize({ width: 390, height: 844 });
  let snapshotTaken!: () => void;
  const snapshotReady = new Promise<void>((resolve) => {
    snapshotTaken = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  let refreshes = 0;
  await observer.route(`**/api/views/${table.viewId}/rows?**`, async (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') === '1') {
      if (++refreshes === 1) {
        await route.fulfill({
          status: 500,
          json: { error: { code: 'internal', messageKey: 'errors.internal', userFault: false } },
        });
      } else await route.continue();
    } else if (!held) {
      held = true;
      const response = await route.fetch();
      snapshotTaken();
      await blocked;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    const connected = observer.waitForEvent('websocket');
    await visit(observer, `${base()}/${database.id}/${table.id}/${table.viewId}`);
    await snapshotReady;
    const socket = await connected;
    const recordId = newId('rec');
    const received = socket.waitForEvent('framereceived', {
      predicate: ({ payload }) => payload.toString().includes(recordId),
    });
    await runCommands(page, database.id, [
      {
        kind: 'record.create',
        tableId: table.id,
        records: [{ id: recordId, values: { [table.fields.Name!]: 'New order' } }],
      },
    ]);
    // Wait until this page receives the creation before releasing its older snapshot.
    await received;
    release();
    const grid = observer.getByRole('grid', { name: 'Grid', exact: true });
    await expect(grid.getByRole('gridcell', { name: 'New order', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    expect(refreshes).toBe(2);
  } finally {
    release();
    await observer.close();
  }
});
