import { openNewField } from '../grid-fields';
import { expect, test } from '../accessibility';
import { labelName, createDatabase, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);

test('toolbar settings, summaries, field changes, and row deletion retain their undo behavior', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grid controls', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Notes', type: 'text' },
      ],
      records: [
        { Name: 'First', Amount: 20, Notes: '東京 🦋 مرحبا '.repeat(30) },
        { Name: 'Second', Amount: 10 },
      ],
    },
  ]);
  const grid = await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  const undo = async () => {
    const response = page.waitForResponse((response) => response.url().endsWith('/undo'));
    await input.focus();
    await input.press('ControlOrMeta+z');
    expect((await response).ok()).toBe(true);
  };
  await grid.locator('[data-rio-footer="1"]').click();
  await page.getByRole('menuitemradio', { name: 'Sum', exact: true }).click();
  await expect(grid.locator('[data-rio-footer="1"]')).toContainText('30');
  const amountHeader = grid.getByRole('columnheader', { name: 'Amount', exact: true });
  const beforeWidth = (await amountHeader.boundingBox())!.width;
  const resize = (await amountHeader.locator('[data-rio-resize]').boundingBox())!;
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + resize.width / 2 + 60, resize.y + resize.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await amountHeader.boundingBox())!.width).toBe(beforeWidth + 60);
  await undo();
  await expect.poll(async () => (await amountHeader.boundingBox())!.width).toBe(beforeWidth);
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  const sort = page.getByRole('dialog', { name: /^(Sort|Sorted by)/ });
  await sort.getByRole('button', { name: 'Add sort', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Amount'), exact: true }).click();
  await sort.press('Escape');
  await expect(grid.locator('[data-rio-row="0"][data-rio-col="0"]')).toHaveText('Second');
  await undo();
  await expect(grid.locator('[data-rio-row="0"][data-rio-col="0"]')).toHaveText('First');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  const filter = page.getByRole('dialog', { name: /^(Filter|Filtered by)/ });
  await filter.getByRole('button', { name: 'Add condition', exact: true }).click();
  await filter.getByRole('textbox', { name: 'Value', exact: true }).fill('First');
  await filter.press('Escape');
  await expect(grid.getByRole('gridcell', { name: 'Second', exact: true })).toHaveCount(0);
  await expect(grid.locator('[data-rio-footer="1"]')).toContainText('20');
  await undo();
  await expect(grid.getByRole('gridcell', { name: 'Second', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Row height', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Tall', exact: true }).click();
  await expect(grid.locator('[data-rio-row="0"][data-rio-col="2"] .rio-cell-value')).toHaveAttribute(
    'data-row-height',
    'tall',
  );
  await grid.getByRole('columnheader', { name: 'Notes', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Hide field'), exact: true }).click();
  await expect(grid.getByRole('columnheader', { name: 'Notes', exact: true })).toHaveCount(0);
  await undo();
  await expect(grid.getByRole('columnheader', { name: 'Notes', exact: true })).toBeVisible();
  await openNewField(page);
  const field = page.getByRole('dialog', { name: 'New field', exact: true });
  await field.getByRole('textbox', { name: 'Name', exact: true }).fill('備考 🦋');
  await field.getByRole('button', { name: 'Create field', exact: true }).click();
  await expect(grid.getByRole('columnheader', { name: '備考 🦋', exact: true })).toBeVisible();
  await grid.getByRole('columnheader', { name: '備考 🦋', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Delete field'), exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Delete 備考 🦋?', exact: true })
    .getByRole('button', { name: 'Delete field', exact: true })
    .click();
  await expect(grid.getByRole('columnheader', { name: '備考 🦋', exact: true })).toHaveCount(0);
  await undo();
  await expect(grid.getByRole('columnheader', { name: '備考 🦋', exact: true })).toBeVisible();
  await undo();
  await expect(grid.getByRole('columnheader', { name: '備考 🦋', exact: true })).toHaveCount(0);
  await grid.getByRole('gridcell', { name: 'First', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: labelName('Delete record'), exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: 'First', exact: true })).toHaveCount(0);
  await undo();
  await expect(grid.getByRole('gridcell', { name: 'First', exact: true })).toBeVisible();
});

test('fill series and conditional formatting follow edits, undo, and redo', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Series and colors', [
    {
      name: 'Records',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'First', Amount: 1 },
        { Name: 'Second', Amount: 2 },
        { Name: 'Third' },
        { Name: 'Fourth' },
      ],
    },
  ]);
  const table = database.tables.Records!;
  await runCommands(page, database.id, [
    {
      kind: 'view.update',
      viewId: table.viewId,
      config: {
        colorRules: [
          {
            id: 'large',
            name: 'At least three',
            target: 'cell',
            color: 'green',
            condition: { id: 'large', fieldId: table.fields.Amount!, operator: 'gte', value: 3 },
          },
        ],
      },
    },
  ]);
  const grid = await openTable(page, database, 'Records');
  const input = page.locator('.rio-grid__input');
  const cell = (row: number) => grid.locator(`[data-rio-row="${row}"][data-rio-col="1"]`);
  await cell(0).click();
  await input.press('Shift+ArrowDown');
  const handle = (await page.locator('.rio-grid__fill-handle').boundingBox())!;
  const target = (await cell(3).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(cell(2)).toHaveText('3');
  await expect(cell(3)).toHaveText('4');
  await expect(cell(2)).toHaveAttribute('style', /green/);
  await cell(2).dblclick();
  await input.fill('0');
  await input.press('Enter');
  await expect(cell(2)).not.toHaveAttribute('style', /green/);
  await input.press('ControlOrMeta+z');
  await expect(cell(2)).toHaveText('3');
  await expect(cell(2)).toHaveAttribute('style', /green/);
  await input.press('ControlOrMeta+z');
  await expect(cell(2)).toHaveText('');
  await expect(cell(3)).toHaveText('');
  await input.press('ControlOrMeta+Shift+z');
  await expect(cell(3)).toHaveText('4');
});
