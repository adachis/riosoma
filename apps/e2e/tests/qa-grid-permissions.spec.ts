import { expect, test } from '../accessibility';
import { createDatabase, openTable, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

test('grid access keeps readers, commenters, guests, and an unshared person within their permissions', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grid access', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Notes', type: 'text' },
      ],
      records: [{ Name: 'Private record 東京 🦋', Notes: 'Original' }],
    },
  ]);
  const ownerGrid = await openTable(page, database, 'Records');
  const url = page.url();
  const person = await invite(page, browser, 'Grid reader');
  const guest = await invite(page, browser, 'Grid guest', 'guest');
  try {
    const refused = person.page.waitForResponse((response) =>
      response.url().endsWith(`/api/databases/${database.id}/schema`),
    );
    await visit(person.page, url);
    expect((await refused).ok()).toBe(false);
    await expect(person.page.getByRole('grid')).toHaveCount(0);
    await expect(person.page.getByText('Private record 東京 🦋', { exact: true })).toHaveCount(0);
    for (const role of ['reader', 'commenter'] as const) {
      await share(page, database.id, person, role);
      const grid = await openTable(person.page, database, 'Records');
      await grid.getByRole('gridcell', { name: 'Private record 東京 🦋', exact: true }).click();
      const input = person.page.locator('.rio-grid__input');
      await input.press('ArrowRight');
      await input.press('Enter');
      await expect(input).not.toHaveAttribute('data-editing');
      await expect(grid.locator('[data-rio-row="0"][data-rio-col="1"]')).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await input.press('Delete');
      await expect(grid.getByRole('gridcell', { name: 'Original', exact: true })).toBeVisible();
      await expect(person.page.getByRole('button', { name: 'Add field', exact: true })).toHaveCount(0);
    }
    await share(page, database.id, person, 'editor');
    const editable = await openTable(person.page, database, 'Records');
    await editable.getByRole('gridcell', { name: 'Original', exact: true }).dblclick();
    const input = person.page.locator('.rio-grid__input');
    await input.fill('Editor changed');
    await input.press('Enter');
    await expect(ownerGrid.getByRole('gridcell', { name: 'Editor changed', exact: true })).toBeVisible();
    await share(page, database.id, guest, 'reader');
    await guest.page.setViewportSize({ width: 390, height: 844 });
    const guestGrid = await openTable(guest.page, database, 'Records');
    await guestGrid.getByRole('gridcell', { name: 'Private record 東京 🦋', exact: true }).click();
    await guest.page.locator('.rio-grid__input').press('Enter');
    await expect(guest.page.locator('.rio-grid__input')).not.toHaveAttribute('data-editing');
    await expect(guestGrid.getByRole('gridcell', { name: 'Editor changed', exact: true })).toBeVisible();
  } finally {
    await person.context.close();
    await guest.context.close();
  }
});
