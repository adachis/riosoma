import { expect, test, type Locator, type Page } from '../accessibility';
import { base } from '../base';
import { labelName, createDatabase, createView, signIn, visit } from '../helpers';

/**
 * A list keeps an order of its own that anyone can arrange: by dragging a record's body, or
 * from the keyboard with Alt and an arrow.  Everyone who opens the list sees the same order, and a
 * sort takes over from it until the sort is removed.
 */

// The service worker has specs of its own.  Here it stays off, since in Firefox its update notice
// can cover the controls a test presses.
test.use({ serviceWorkers: 'block' });

/** Records in the order they're added, which is the list's order until someone moves one. */
const ADDED = ['Engine oil', 'Anchor check', 'Deck wash', 'Bilge pump', 'Chart update'];

/** The list's lines, top to bottom. */
function lines(page: Page): Locator {
  return page.getByRole('tree', { name: 'Chores' }).getByRole('treeitem');
}

/** Drags a record onto the top quarter of another, which drops it just before that one. */
async function dragBefore(page: Page, record: string, target: string): Promise<void> {
  const tree = page.getByRole('tree', { name: 'Chores' });
  const line = tree.getByRole('treeitem', { name: record, exact: true });
  await line.hover();
  const surface = (await line.boundingBox())!;
  const onto = (await tree.getByRole('treeitem', { name: target, exact: true }).boundingBox())!;
  await page.mouse.move(surface.x + surface.width / 2, surface.y + surface.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width / 2, onto.y + onto.height / 4, { steps: 10 });
  await page.mouse.up();
}

test('a list keeps the order it’s dragged into, for everyone, until a sort takes over', async ({
  page,
  browser,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Harbor Chores', [
    {
      name: 'Tasks',
      fields: [{ name: 'Name', type: 'text' }],
      records: ADDED.map((name) => ({ Name: name })),
    },
  ]);
  const tasks = database.tables.Tasks!;
  const listId = await createView(page, database, 'Tasks', { name: 'Chores', type: 'list' });
  const address = `${base()}/${database.id}/${tasks.id}/${listId}`;
  await page.goto(address);
  await expect(lines(page)).toHaveText(ADDED);

  // Someone else has the same list open in a browser of their own.
  const other = await browser.newContext({ serviceWorkers: 'block' });
  const second = await other.newPage();
  await signIn(second);
  await visit(second, address);
  await expect(lines(second)).toHaveText(ADDED);

  // Dropped on the top of another record, a record goes just before it.
  await dragBefore(page, 'Chart update', 'Anchor check');
  const dragged = ['Engine oil', 'Chart update', 'Anchor check', 'Deck wash', 'Bilge pump'];
  await expect(lines(page)).toHaveText(dragged);
  await expect(page.getByRole('status').filter({ hasText: 'Moved before Anchor check' })).toBeAttached();
  await expect(lines(second)).toHaveText(dragged);

  // Alt with an arrow moves the record that has the focus, and says where it went.
  const pump = page.getByRole('treeitem', { name: 'Bilge pump', exact: true });
  await pump.focus();
  await page.keyboard.press('Alt+ArrowUp');
  const arranged = ['Engine oil', 'Chart update', 'Anchor check', 'Bilge pump', 'Deck wash'];
  await expect(lines(page)).toHaveText(arranged);
  await expect(page.getByRole('status').filter({ hasText: 'Moved before Deck wash' })).toBeAttached();
  await expect(pump).toBeFocused();
  // The local move is immediate, so wait for its saved order to reach the other browser before reloading.
  await expect(lines(second)).toHaveText(arranged);

  await page.reload();
  await expect(lines(page)).toHaveText(arranged);
  await second.reload();
  await expect(lines(second)).toHaveText(arranged);
  await other.close();

  // With a sort, the list follows it, says why nothing can be dragged, and has no handles.
  const controls = page.getByRole('toolbar', { name: 'View controls' });
  await controls.getByRole('button', { name: 'Sort', exact: true }).click();
  await page.getByRole('button', { name: 'Add sort' }).click();
  // Adding opens a field picker first, so the list only sorts once Name is chosen.
  await page.getByRole('menuitem', { name: labelName('Name'), exact: true }).click();
  const sorts = page.getByRole('dialog', { name: 'Sorted by Name' });
  await sorts.press('Escape');
  await expect(sorts).toBeHidden();
  const note = page.getByText(/^This list follows its sort, so records can’t be dragged/);
  await expect(note).toBeVisible();
  await expect(lines(page)).toHaveText([...ADDED].sort());
  await expect(page.locator('.rio-list-view__line[data-movable]')).toHaveCount(0);
  await page.getByRole('treeitem', { name: 'Deck wash', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(lines(page)).toHaveText([...ADDED].sort());

  // Without it, the order arranged by hand comes back as it was.
  await controls.getByRole('button', { name: 'Sorted by Name' }).click();
  await sorts.getByRole('button', { name: 'Remove sort' }).click();
  await page.getByRole('dialog', { name: 'Sort', exact: true }).press('Escape');
  await expect(note).toBeHidden();
  await expect(lines(page)).toHaveText(arranged);
  await expect(page.locator('.rio-list-view__line[data-movable]')).toHaveCount(ADDED.length);
});
