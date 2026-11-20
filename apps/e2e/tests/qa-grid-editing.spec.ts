import { expect, test } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

for (const width of [1440, 390]) {
  test(`Tab leaves an unchanged single select intact at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Choice navigation', [
      {
        name: 'Records',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Status', type: 'singleSelect', choices: ['Alpha', 'Beta'] },
          { name: 'Notes', type: 'text' },
        ],
        records: [{ Name: 'First', Status: 'Alpha' }, { Name: 'Second', Status: 'Beta' }, { Name: 'Empty' }],
      },
    ]);
    const table = database.tables.Records!;
    const grid = await openTable(page, database, 'Records');
    const input = page.locator('.rio-grid__input');
    for (let row = 0; row < 3; row++) {
      await grid.locator(`[data-rio-row="${row}"][data-rio-col="0"]`).click();
      await input.press('ArrowRight');
      await input.press('Enter');
      await expect(page.locator('.rio-cell-editor')).toBeVisible();
      await page.getByRole('searchbox', { name: 'Find an option' }).press('Tab');
      await expect(page.locator('.rio-cell-editor')).toHaveCount(0);
      await expect(grid.locator(`[data-rio-row="${row}"][data-rio-col="2"]`)).toHaveAttribute(
        'aria-selected',
        'true',
      );
    }
    const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
    expect(saved.rows.map((row) => row.values[table.fields.Status!] ?? null)).toEqual([
      table.choices.Status!.Alpha,
      table.choices.Status!.Beta,
      null,
    ]);
  });
}

for (const field of [
  { name: 'Status', type: 'singleSelect', choices: ['Alpha', 'Beta'] },
  { name: 'Tags', type: 'multipleSelect', choices: ['Alpha', 'Beta'] },
  { name: 'Score', type: 'rating' },
  { name: 'Person', type: 'user' },
]) {
  test(`Shift+Tab moves backward out of the ${field.type} editor`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Backward navigation', [
      {
        name: 'Records',
        fields: [{ name: 'Name', type: 'text' }, field, { name: 'Notes', type: 'text' }],
        records: [{ Name: 'First' }],
      },
    ]);
    const grid = await openTable(page, database, 'Records');
    const input = page.locator('.rio-grid__input');
    await grid.locator('[data-rio-row="0"][data-rio-col="0"]').click();
    await input.press('ArrowRight');
    await input.press('Enter');
    const editor = page.locator('.rio-cell-editor');
    await expect(editor).toBeVisible();
    const focus =
      field.type === 'rating'
        ? editor.getByRole('button', { name: '1 of 5' })
        : editor.getByRole('searchbox');
    await focus.evaluate((node) =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect(editor).toBeVisible();
    await focus.press('Shift+Tab');
    await expect(editor).toHaveCount(0);
    await expect(grid.locator('[data-rio-row="0"][data-rio-col="0"]')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(input).toBeFocused();
  });
}

test('Shift+Tab leaves the link editor for the previous cell', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Linked navigation', [
    {
      name: 'Records',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'First' }],
    },
    { name: 'Targets', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Target' }] },
  ]);
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: database.tables.Records!.id,
      field: {
        id: newId('fld'),
        name: 'Related',
        type: 'link',
        options: { linkedTableId: database.tables.Targets!.id },
      },
    },
  ]);
  const grid = await openTable(page, database, 'Records');
  await grid.locator('[data-rio-row="0"][data-rio-col="1"]').dblclick();
  const editor = page.locator('.rio-cell-editor');
  await editor.getByRole('searchbox').press('Shift+Tab');
  await expect(editor).toHaveCount(0);
  await expect(grid.locator('[data-rio-row="0"][data-rio-col="0"]')).toHaveAttribute('aria-selected', 'true');
});
