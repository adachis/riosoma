import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, createDatabase, openTable, signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** The palette opens from the keyboard anywhere in the app and jumps straight to a table. */
test('the keyboard opens the palette and jumps to another table', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Palette Depot', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Order 1001' }] },
    { name: 'Suppliers', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Kestrel Mills' }] },
  ]);
  const grid = await openTable(page, database, 'Orders');
  await expect(grid.getByRole('gridcell', { name: 'Order 1001' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Search and commands' });
  const search = palette.getByRole('searchbox');
  await expect(search).toBeFocused();
  await page.keyboard.type('suppl');
  const option = palette.getByRole('option', { name: labelName('Suppliers') });
  await expect(option).toBeVisible();
  // The typing stays in the field while the best match is the active row.
  await expect(search).toHaveAttribute('aria-activedescendant', (await option.getAttribute('id'))!);
  await page.keyboard.press('Enter');

  await expect(palette).toBeHidden();
  const suppliers = database.tables.Suppliers!;
  await expect(page).toHaveURL(`${base()}/${database.id}/${suppliers.id}/${suppliers.viewId}`);
  await expect(page.getByRole('link', { name: 'Suppliers' })).toHaveAttribute('aria-current', 'page');
  await expect(grid.getByRole('gridcell', { name: 'Kestrel Mills' })).toBeVisible();
});
