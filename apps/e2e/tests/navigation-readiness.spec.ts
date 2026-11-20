import { expect, test } from '../accessibility';
import { base } from '../base';
import { createDatabase, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('a fresh context rejects navigation when app startup never becomes ready', async ({ page, browser }) => {
  await signIn(page);
  const context = await browser.newContext({
    storageState: await page.context().storageState(),
    serviceWorkers: 'block',
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    const fresh = await context.newPage();
    fresh.setDefaultTimeout(1_000);
    await fresh.route('**/api/setup/status', async (route) => {
      await held;
      await route.continue();
    });
    try {
      await expect(visit(fresh, base())).rejects.toThrow('page.waitForFunction: Timeout');
    } finally {
      release();
    }
    await expect(fresh.getByRole('heading', { name: 'Databases', level: 1 })).toBeVisible();
  } finally {
    release();
    await context.close();
  }
});

test('a visit waits for the database schema by default', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Visit readiness', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const table = database.tables.Orders!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let requested!: () => void;
  const schemaRequested = new Promise<void>((resolve) => (requested = resolve));
  let released = false;
  await page.route(`**/api/databases/${database.id}/schema`, async (route) => {
    requested();
    await held;
    await route.continue();
  });
  const visiting = visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`).then(() => {
    expect(released, 'A visit must wait for the schema unless the caller opts out').toBe(true);
  });
  void visiting.catch(() => {});
  try {
    await schemaRequested;
    await expect(page.getByRole('group', { name: 'Loading record', exact: true })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
  } finally {
    released = true;
    release();
  }
  await visiting;
  await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
});
