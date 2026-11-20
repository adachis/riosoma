import { expect, test } from '../accessibility';
import { createDatabase, openTable, signIn } from '../helpers';

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** "Find links" spots a field whose values name records in another table, and links them. */
test('a suggested link joins two tables by their matching values', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Order Desk', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Customer', type: 'text' },
      ],
      records: [
        { Name: 'Order 1001', Customer: 'Grace Hopper' },
        { Name: 'Order 1002', Customer: 'Alan Turing' },
        { Name: 'Order 1003', Customer: 'Grace Hopper' },
      ],
    },
    {
      name: 'Customers',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Grace Hopper' }, { Name: 'Alan Turing' }, { Name: 'Katherine Johnson' }],
    },
  ]);
  const grid = await openTable(page, database, 'Orders');

  await page.getByRole('button', { name: 'More for Orders' }).click();
  await page.getByRole('menuitem', { name: 'Find links' }).click();
  const dialog = page.getByRole('dialog', { name: 'Suggested links' });
  const suggestion = dialog.getByRole('listitem').filter({
    hasText: 'From Customer in Orders to Name in Customers',
  });
  await expect(suggestion.getByRole('meter')).toBeVisible();
  await expect(suggestion).toContainText('100% of values found');
  await suggestion.getByRole('button', { name: 'Link them' }).click();
  await expect(page.getByText('Linked Orders to Customers')).toBeVisible();
  await expect(suggestion).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();

  // The new link field follows the values, so each order already links to one customer.
  await expect(grid.getByRole('columnheader', { name: 'Customers' })).toBeVisible();
  const follows = 'These links follow matching values, so they change when the values do.';
  for (const order of ['Order 1001', 'Order 1002', 'Order 1003']) {
    const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: order }) });
    await expect(row.getByRole('gridcell', { description: follows }).getByRole('img')).toHaveCount(1);
  }
});
