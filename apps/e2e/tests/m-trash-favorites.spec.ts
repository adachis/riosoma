import { expect, test, type Page } from '../accessibility';
import { createDatabase, openTable, signIn } from '../helpers';

/** Starring and recent databases on the home screen, and getting deleted things back from the trash. */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** The home screen's card for a database, found by the name on its link. */
function card(page: Page, name: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('link', { name }) });
}

test('a starred database leads Favorites, and one just opened is under Recent', async ({ page }) => {
  await signIn(page);
  await createDatabase(page, 'Harbor Inventory', [
    { name: 'Crates', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await createDatabase(page, 'Pier Schedules', [
    { name: 'Sailings', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await page.reload();

  await card(page, 'Harbor Inventory').getByRole('button', { name: 'Add to favorites' }).click();
  await expect(
    card(page, 'Harbor Inventory').getByRole('button', { name: 'Remove from favorites' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('navigation', { name: 'Files' }).getByRole('link', { name: 'Favorites' }).click();
  await expect(page).toHaveURL(/\/home\/favorites$/);
  await expect(page.getByRole('heading', { name: 'Favorites', level: 2 })).toBeVisible();
  await expect(page.getByRole('link', { name: /Harbor Inventory/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Pier Schedules/ })).toHaveCount(0);

  await page.getByRole('link', { name: /Harbor Inventory/ }).click();
  await expect(page.getByRole('grid', { name: 'Grid' })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await page
    .getByRole('link', { name: /Pier Schedules/ })
    .first()
    .click();
  await expect(page.getByRole('grid', { name: 'Grid' })).toBeVisible();
  await page.getByRole('link', { name: 'Home', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Files' }).getByRole('link', { name: 'Recent' }).click();
  await expect(page).toHaveURL(/\/home\/recent$/);
  await expect(page.getByRole('heading', { name: 'Recent', level: 2 })).toBeVisible();
  const recent = page.getByRole('list').filter({ has: page.getByRole('link', { name: /Pier Schedules/ }) });
  await expect(recent.getByRole('link', { name: /Pier Schedules/ })).toBeVisible();
  await expect(recent.getByRole('link', { name: /Harbor Inventory/ })).toBeVisible();
});

test('a database deleted from its card comes back from the trash', async ({ page }) => {
  await signIn(page);
  await createDatabase(page, 'Old Ledger', [{ name: 'Entries', fields: [{ name: 'Name', type: 'text' }] }]);
  await page.reload();

  await card(page, 'Old Ledger').getByRole('button', { name: 'More for Old Ledger' }).click();
  await page.getByRole('menuitem', { name: 'Delete database' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete Old Ledger?' });
  await confirm.getByRole('button', { name: 'Delete database' }).click();
  await expect(page.getByText('Deleted Old Ledger')).toBeVisible();
  await expect(page.getByRole('link', { name: /Old Ledger/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Deleted databases' });
  await trash.getByRole('button', { name: 'Restore Old Ledger' }).click();
  await expect(page.getByText('Restored Old Ledger')).toBeVisible();
  await expect(trash.getByRole('button', { name: 'Restore Old Ledger' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(trash).toBeHidden();
  await expect(card(page, 'Old Ledger')).toBeVisible();
});

test('a deleted field and a deleted record come back from the table’s trash', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Dock Manifest', [
    {
      name: 'Crates',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Contents', type: 'text' },
      ],
      records: [
        { Name: 'Crate A', Contents: 'Rope' },
        { Name: 'Crate B', Contents: 'Lanterns' },
      ],
    },
  ]);
  const grid = await openTable(page, database, 'Crates');

  await grid.getByRole('columnheader', { name: 'Contents' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete field' }).click();
  await page
    .getByRole('dialog', { name: 'Delete Contents?' })
    .getByRole('button', { name: 'Delete field' })
    .click();
  await expect(grid.getByRole('columnheader', { name: 'Contents' })).toHaveCount(0);

  await grid.getByRole('gridcell', { name: 'Crate B' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete record' }).click();
  await expect(grid.getByRole('gridcell', { name: 'Crate B' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Trash' });
  await trash.getByRole('button', { name: 'Restore Contents' }).click();
  await expect(page.getByText('Restored Contents')).toBeVisible();
  await expect(grid.getByRole('columnheader', { name: 'Contents' })).toBeVisible();

  await trash.getByRole('button', { name: '1 deleted record in Crates' }).click();
  await trash.getByRole('button', { name: 'Restore Crate B' }).click();
  await expect(page.getByText('Restored Crate B')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trash).toBeHidden();
  await expect(grid.getByRole('gridcell', { name: 'Crate B' })).toBeVisible();
  // The restored field kept its values.
  await expect(grid.getByRole('gridcell', { name: 'Lanterns' })).toBeVisible();
});
