import { expect, test, type Page } from '../accessibility';
import { createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

/** How far the page reaches past the bottom of the window, which is 0 when it doesn't scroll */
const overflow = (page: Page) =>
  page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight);

test('fits a phone’s window without scrolling the page, on Home and in a grid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  expect(await page.evaluate(() => window.innerHeight)).toBe(844);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const database = await createDatabase(page, 'Phone fit', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
      ],
      records: Array.from({ length: 40 }, (_, index) => ({
        Name: `Project ${index}`,
        Status: index % 2 ? 'Ready' : 'Done',
      })),
    },
  ]);
  await openTable(page, database, 'Projects');
  await expect(page.getByRole('gridcell', { name: 'Project 1', exact: true })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  const table = database.tables.Projects!;
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: { groups: [{ fieldId: table.fields.Status!, direction: 'asc' }] },
    },
  ]);
  await expect(page.getByRole('treegrid').getByRole('row', { name: 'Done, 20 records' })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
});

// Safari is where a click whose pressed text left the page goes missing, so these run in WebKit at
// a phone's width too.  A single select draws its group's value as a chip, which has a renderer of
// its own, and a change to a record hands the grid new lists of fields and a new format.
for (const { type, width } of [
  { type: 'text', width: 1280 },
  { type: 'singleSelect', width: 1280 },
  { type: 'text', width: 390 },
  { type: 'singleSelect', width: 390 },
] as const) {
  test(`keeps a ${type} group’s buttons and their text in place while the grid redraws during a press, ${width}px wide`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    await signIn(page);
    const database = await createDatabase(page, 'Grouped presses', [
      {
        name: 'Projects',
        fields: [
          { name: 'Name', type: 'text' },
          type === 'singleSelect'
            ? { name: 'Status', type: 'singleSelect', choices: ['Ready', 'Done'] }
            : { name: 'Status', type: 'text' },
        ],
        records: [
          { Name: 'First project', Status: 'Ready' },
          { Name: 'Second project', Status: 'Ready' },
          { Name: 'Finished project', Status: 'Done' },
        ],
      },
    ]);
    const table = database.tables.Projects!;
    await openTable(page, database, 'Projects');
    await runCommands(page, database.id, [
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: { groups: [{ fieldId: table.fields.Status!, direction: 'asc' }] },
      },
    ]);
    const grid = page.getByRole('treegrid');
    const ready = grid.getByRole('row', { name: 'Ready, 2 records', exact: true });
    const toggle = ready.getByRole('button', { name: 'Ready, 2 records', exact: true });
    const add = ready.getByRole('button', { name: 'Add record in Ready', exact: true });
    await expect(add).toBeVisible();
    // Every text node inside the group's buttons, as the page holds them before the press
    const texts = await toggle.evaluateHandle((button) => {
      const found: Node[] = [];
      for (const root of [button, button.parentElement!.querySelector('.rio-grid-group-add')!]) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) found.push(walker.currentNode);
      }
      return found;
    });
    expect(await texts.evaluate((nodes) => nodes.map((node) => node.textContent))).toEqual([
      'Ready',
      ' ',
      '2 records',
    ]);
    const icons = await ready.evaluateHandle((row) => [...row.querySelectorAll('button svg')]);
    expect(await icons.evaluate((nodes) => nodes.length)).toBe(2);
    const label = toggle.locator('.rio-grid-group-value');
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Someone else adds a record to the group while the button is held, so its count changes and
    // every row draws again before the release.
    await runCommands(page, database.id, [
      {
        kind: 'record.create',
        tableId: table.id,
        records: [
          {
            id: newId('rec'),
            values: {
              [table.fields.Name!]: 'Third project',
              [table.fields.Status!]: type === 'singleSelect' ? table.choices.Status!.Ready : 'Ready',
            },
          },
        ],
      },
    ]);
    const three = grid.getByRole('row', { name: 'Ready, 3 records', exact: true });
    await expect(three).toBeVisible();
    expect(await texts.evaluate((nodes) => nodes.map((node) => node.isConnected))).toEqual([
      true,
      true,
      true,
    ]);
    expect(await icons.evaluate((nodes) => nodes.map((node) => node.isConnected))).toEqual([true, true]);
    expect(await texts.evaluate((nodes) => nodes.map((node) => node.textContent))).toEqual([
      'Ready',
      ' ',
      '3 records',
    ]);
    await page.mouse.up();
    await expect(three).toHaveAttribute('aria-expanded', 'false');
    await expect(grid.getByRole('gridcell', { name: 'First project', exact: true })).toHaveCount(0);
  });
}
