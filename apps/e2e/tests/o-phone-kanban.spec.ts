import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, createDatabase, createView, signIn } from '../helpers';

/**
 * On a phone, a table's views sit behind one button that opens a sheet of them, and a kanban shows
 * one stack at a time.  A card moves to another stack from its own menu, since a phone has no room
 * to drag it across.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({
  serviceWorkers: 'block',
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
});

test('a phone switches views through the sheet and moves a card by its menu', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Ferry Crew', [
    {
      name: 'Chores',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['To do', 'Doing', 'Done'] },
      ],
      records: [
        { Name: 'Coil the lines', Status: 'To do' },
        { Name: 'Check the life rings', Status: 'To do' },
        { Name: 'Swab the deck', Status: 'Doing' },
      ],
    },
  ]);
  const chores = database.tables.Chores!;
  await createView(page, database, 'Chores', {
    name: 'Board',
    type: 'kanban',
    config: { kanban: { stackFieldId: chores.fields.Status } },
  });
  await page.goto(`${base()}/${database.id}/${chores.id}/${chores.viewId}`);
  await expect(page.getByRole('grid', { name: 'Grid' })).toBeVisible();

  // One button names the view and opens the sheet, where each view is a link.
  const views = page.getByRole('navigation', { name: 'Views' });
  await expect(views.getByRole('link')).toHaveCount(0);
  await views.getByRole('button', { name: 'Grid', exact: true }).tap();
  const sheet = page.getByRole('dialog', { name: 'Views' });
  await expect(sheet.getByRole('link', { name: 'Grid', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await sheet.getByRole('link', { name: 'Board', exact: true }).tap();
  await expect(sheet).toBeHidden();
  await expect(views.getByRole('button', { name: 'Board', exact: true })).toBeVisible();

  // The first stack fills the screen, and its card moves to another stack from its menu.  A stack
  // for cards with no status comes after the three options.
  const stacks = page.getByRole('group', { name: 'Stacks' });
  await expect(stacks).toContainText('Stack 1 of 4');
  const toDo = page.getByRole('region', { name: 'To do' });
  const done = page.getByRole('region', { name: 'Done' });
  await expect(toDo).toBeInViewport({ ratio: 0.9 });
  const card = 'Coil the lines';
  await toDo.getByRole('button', { name: `More for ${card}` }).tap();
  await page.getByRole('menuitem', { name: 'Move to Done' }).tap();
  await expect(toDo.getByRole('button', { name: labelName(card) })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Moved to Done' })).toBeVisible();

  // The arrows turn to the Done stack, where the card now is, and it stays there after a reload.
  await stacks.getByRole('button', { name: 'Next stack' }).tap();
  await expect(stacks).toContainText('Stack 2 of 4');
  await stacks.getByRole('button', { name: 'Next stack' }).tap();
  await expect(stacks).toContainText('Stack 3 of 4');
  await expect(done).toBeInViewport({ ratio: 0.9 });
  await expect(page.getByRole('status').filter({ hasText: 'Showing Done' })).toHaveText(
    'Showing Done, 1 record',
  );
  await expect(done.getByRole('button', { name: labelName(card) })).toBeVisible();
  await page.reload();
  await expect(done.getByRole('button', { name: labelName(card) })).toBeAttached();

  // Back to the grid through the sheet, which shows the card's new status.
  await views.getByRole('button', { name: 'Board', exact: true }).tap();
  await sheet.getByRole('link', { name: 'Grid', exact: true }).tap();
  await expect(sheet).toBeHidden();
  const grid = page.getByRole('grid', { name: 'Grid' });
  const row = grid.getByRole('row').filter({ has: page.getByRole('gridcell', { name: card }) });
  await expect(row.getByRole('gridcell', { name: 'Done' })).toBeVisible();
});
