import { expect, test } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { recordLayoutAudit } from '../tight-space-audit';

test.use({ serviceWorkers: 'block', reducedMotion: 'reduce' });

test('a text-only dialog body remains reachable and scrollable by keyboard on a phone', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Keyboard dialog checks', [
    { name: 'Items', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const folderId = newId('act');
  await runCommands(page, database.id, [
    {
      kind: 'database.navigation',
      change: {
        kind: 'folder.create',
        folder: { id: folderId, name: 'Planning', section: 'table', parentId: null, position: 0 },
      },
    },
    {
      kind: 'database.navigation',
      change: { kind: 'item.move', id: database.tables.Items!.id, parentId: folderId },
    },
  ]);
  await page.setViewportSize({ width: 390, height: 600 });
  await openTable(page, database, 'Items');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'More for Planning', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete folder?', exact: true });
  await expect(dialog).toBeVisible();
  await page.setViewportSize({ width: 390, height: 200 });
  const body = dialog.locator('.rio-dialog__body');
  await expect(body).toHaveAttribute('tabindex', '0');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(body).toBeFocused();
  await body.press('PageDown');
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(dialog.getByRole('button', { name: 'Delete folder', exact: true })).toBeVisible();
  await recordLayoutAudit(page, info, 'phone-dialog-scroll', dialog);
});
