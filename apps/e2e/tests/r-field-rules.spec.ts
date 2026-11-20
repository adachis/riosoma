import { expect, test } from '../accessibility';
import { createDatabase, openTable, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

test('a refused grid edit keeps its value and a locked record explains its lock', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Field rules', [
    {
      name: 'Entries',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Approved' }],
    },
  ]);
  const table = database.tables.Entries!;
  await openTable(page, database, 'Entries');
  await page.goto(`${page.url()}?fieldRules=${table.fields.Name}`);
  const settings = page.getByRole('dialog');
  await settings.getByRole('spinbutton', { name: 'Minimum length', exact: true }).fill('3');
  await settings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(settings).toBeHidden();
  let grid = page.getByRole('grid');
  const cell = grid.getByRole('gridcell', { name: 'Approved', exact: true });
  await cell.dblclick();
  const editor = page.locator('textarea[data-editing]');
  await editor.fill('No');
  await editor.press('Enter');
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  await expect(editor).toHaveAccessibleDescription('The text is too short.');
  await editor.press('Escape');
  await expect(cell).toHaveText('Approved');

  await grid.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  await page.getByRole('button', { name: 'Lock record', exact: true }).click();
  await page.getByRole('textbox', { name: 'Lock reason', exact: true }).fill('Reviewed');
  await page.getByRole('button', { name: 'Confirm lock', exact: true }).click();
  await expect(page.getByText('Locked: Reviewed', { exact: true })).toBeVisible();
  await openTable(page, database, 'Entries');
  await page.goto(`${page.url()}?recordLocks=${table.id}`);
  const access = page.getByRole('dialog', { name: 'Record access for Entries' });
  await access.getByRole('button', { name: /Who can change locked records/ }).click();
  await page.getByRole('option', { name: 'Nobody', exact: true }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/databases/${database.id}/commands`) &&
      response.request().method() === 'POST',
  );
  await access.getByRole('button', { name: 'Apply record locks', exact: true }).click();
  expect((await saved).ok()).toBe(true);
  await expect(access.getByRole('button', { name: 'Apply record locks', exact: true })).toBeEnabled();
  grid = await openTable(page, database, 'Entries');
  await expect(grid.getByRole('img', { name: 'Locked: Reviewed' })).toBeVisible();
  await grid.getByRole('gridcell', { name: 'Approved', exact: true }).dblclick();
  await expect(editor).toHaveCount(0);
  await grid.getByRole('button', { name: 'Expand row 1', exact: true }).click();
  await expect(page.getByText('Locked: Reviewed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Unlock record', exact: true })).toHaveCount(0);

  await openTable(page, database, 'Entries');
  await page.getByRole('button', { name: 'Lock view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unlock view', exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Unlock view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lock view', exact: true })).toBeVisible();
});
