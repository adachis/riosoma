import { expect, test } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';

test('creates a named function, recomputes its formula field, and warns before deletion', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const database = await createDatabase(page, 'Named functions', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'Order', Amount: 10 }],
    },
  ]);
  await openTable(page, database, 'Orders');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function' }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)' }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page
    .getByRole('textbox', { name: 'Sample argument: amount' })
    .fill(Array.from({ length: 10_000 }, () => '1').join('+'));
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'This calculation exceeds the formula’s limits.' }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Sample argument: amount' }).fill('10');
  await page.getByRole('button', { name: 'Run test' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Result: 20' })).toBeVisible();
  await page.getByRole('button', { name: 'Save function' }).click();
  await page.getByRole('button', { name: 'DOUBLE(amount)' }).click();
  const deepLink = page.url();
  await visit(page, deepLink);
  await expect(page.getByRole('textbox', { name: 'Function name' })).toHaveValue('DOUBLE');
  const orders = database.tables.Orders!;
  const total = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: orders.id,
      field: {
        id: total,
        name: 'Doubled amount',
        type: 'formula',
        options: { expression: `DOUBLE({${orders.fields.Amount}})` },
      },
    },
  ]);
  const grid = await openTable(page, database, 'Orders');
  await expect(grid.getByRole('gridcell', { name: '20', exact: true })).toBeVisible();
  // Keep the row visible in another tab so the edit also exercises realtime recomputation.
  const editor = await page.context().newPage();
  await visit(editor, deepLink);
  await editor.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 3');
  await editor.getByRole('button', { name: 'Save function' }).click();
  await expect(grid.getByRole('gridcell', { name: '30', exact: true })).toBeVisible();
  await editor.setViewportSize({ width: 390, height: 844 });
  await editor.getByRole('button', { name: 'DOUBLE(amount)' }).click();
  await editor.getByRole('button', { name: 'Delete function', exact: true }).click();
  const warning = editor.getByRole('dialog', { name: 'Delete DOUBLE?' });
  await expect(warning).toContainText('Orders: Doubled amount');
  await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Function name' })).toHaveValue('DOUBLE');
  await editor.close();
});

test.describe('navigation readiness', () => {
  // Route interception must see module requests rather than service worker responses.
  test.use({ serviceWorkers: 'block' });

  test('waits for app startup when the root contains only hidden recovery markup', async ({ page }) => {
    await signIn(page);
    let requested!: () => void;
    let resume!: () => void;
    const requestedSetup = new Promise<void>((resolve) => (requested = resolve));
    const resumeSetup = new Promise<void>((resolve) => (resume = resolve));
    let released = false;
    await page.route('**/api/setup/status', async (route) => {
      requested();
      await resumeSetup;
      await route.continue();
    });
    const visiting = visit(page, page.url()).then(() => {
      expect(released, 'A visit must not finish before the app mounts').toBe(true);
    });
    void visiting.catch(() => {});
    try {
      await requestedSetup;
      await page.waitForFunction(() => {
        const root = document.getElementById('root');
        return (
          document.readyState === 'complete' &&
          root?.children.length === 1 &&
          root.firstElementChild?.id === 'rio-startup-error' &&
          root.firstElementChild.hasAttribute('hidden')
        );
      });
      // Keep this pre-mount document available across readiness polls before releasing startup.
      await page.waitForTimeout(250);
    } finally {
      released = true;
      resume();
    }
    await visiting;
    await expect(page.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  });

  test('waits for the database route to load before completing a visit', async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Delayed database route', [
      { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const orders = database.tables.Orders!;
    let requested!: () => void;
    let resume!: () => void;
    const requestedModule = new Promise<void>((resolve) => (requested = resolve));
    const resumeModule = new Promise<void>((resolve) => (resume = resolve));
    let released = false;
    await page.route(/\/assets\/DatabaseScreen-[^/]+\.js$/, async (route) => {
      requested();
      await resumeModule;
      await route.continue();
    });
    const visiting = visit(
      page,
      new URL(`/${database.id}/${orders.id}/${orders.viewId}`, page.url()).href,
    ).then(() => {
      expect(released, 'A visit must not finish while the route module is still loading').toBe(true);
    });
    // The assertion can reject before the held request is released.
    void visiting.catch(() => {});
    try {
      await requestedModule;
      await page.waitForFunction(
        () =>
          document.readyState !== 'loading' &&
          !!document.querySelector('.rio-feature-loading--page[aria-busy="true"]'),
      );
      // Let the document-readiness poll finish while the route remains behind its loading status.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
    } finally {
      released = true;
      resume();
    }
    await visiting;
    await expect(page.getByRole('grid', { name: 'Grid' })).toBeVisible();
  });
});
