import { expect, test } from '../accessibility';
import { labelName, createDatabase, openTable, signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** A new dashboard gets a number tile that sums a field across the table's records. */
test('a number tile on a new dashboard shows its total', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Warehouse Metrics', [
    {
      name: 'Pallets',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Weight', type: 'number' },
      ],
      records: [
        { Name: 'Pallet 1', Weight: 40 },
        { Name: 'Pallet 2', Weight: 55 },
        { Name: 'Pallet 3', Weight: 25 },
      ],
    },
  ]);
  await openTable(page, database, 'Pallets');

  await page.getByRole('button', { name: 'Add a dashboard' }).click();
  const dashboard = page.getByRole('region', { name: 'Untitled dashboard' });
  await expect(dashboard.getByRole('heading', { name: 'Untitled dashboard', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Untitled dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await dashboard.getByRole('button', { name: 'Add a tile' }).click();
  const editor = page.getByRole('dialog', { name: 'Add a tile' });
  await editor.getByRole('textbox', { name: 'Title' }).fill('Total weight');
  await editor.getByRole('button', { name: /Field$/ }).click();
  await page.getByRole('option', { name: labelName('Weight') }).click();
  // Choosing a number field sums it.
  await expect(editor.getByRole('button', { name: /Value$/ })).toContainText('Sum');
  await editor.getByRole('button', { name: 'Save tile' }).click();
  await expect(editor).toBeHidden();

  const tile = dashboard.getByRole('article', { name: 'Total weight' });
  await expect(tile.getByText('120', { exact: true })).toBeVisible();
  await expect(tile.getByText('3 records')).toBeVisible();
});
