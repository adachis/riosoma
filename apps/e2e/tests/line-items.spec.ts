import { expect, test } from '../accessibility';
import { createDatabase, newId, openTable, pasteText, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });

for (const width of [1500, 390]) {
  test(`adds, edits, totals, and reorders lines at width ${width}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1000 });
    await signIn(page);
    const description = newId('fld');
    const amount = newId('fld');
    const database = await createDatabase(page, 'Line items', [
      {
        name: 'Invoices',
        fields: [
          { name: 'Name', type: 'text' },
          {
            name: 'Rows',
            type: 'lineItems',
            options: {
              columns: [
                { id: description, name: 'Description', type: 'text' },
                { id: amount, name: 'Amount', type: 'currency' },
              ],
            },
          },
        ],
        records: [{ Name: 'Invoice 1' }],
      },
    ]);
    const grid = await openTable(page, database, 'Invoices');
    await grid.getByRole('gridcell', { name: 'Invoice 1', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description, line 1', exact: true }).fill('Labor');
    await page.getByRole('textbox', { name: 'Description, line 1', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Description, line 1', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Amount, line 1', exact: true }).fill('12.50');
    await page.getByRole('textbox', { name: 'Amount, line 1', exact: true }).press('Enter');
    await expect(page.getByRole('textbox', { name: 'Amount, line 1', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Add line', exact: true }).click();
    await page.getByRole('textbox', { name: 'Description, line 2', exact: true }).fill('Parts');
    await page.getByRole('textbox', { name: 'Description, line 2', exact: true }).press('Enter');
    await page.getByRole('textbox', { name: 'Amount, line 2', exact: true }).fill('7.50');
    await page.getByRole('textbox', { name: 'Amount, line 2', exact: true }).press('Enter');
    const editor = page.getByRole('table', { name: 'Rows', exact: true });
    await expect(editor.locator('tfoot')).toContainText('$20.00');
    await page.getByRole('button', { name: 'Reorder line 2', exact: true }).press('Alt+ArrowUp');
    await expect(page.getByRole('textbox', { name: 'Description, line 1', exact: true })).toHaveValue(
      'Parts',
    );
    const first = editor.locator('tbody tr').first();
    await first.hover();
    const handle = (await page.getByRole('button', { name: 'Reorder line 1', exact: true }).boundingBox())!;
    const second = (await editor.locator('tbody tr').nth(1).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 8, handle.y + handle.height / 2);
    await expect(page.locator('.rio-sortable-overlay')).toBeVisible();
    await page.mouse.move(second.x + 8, second.y + second.height - 4, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByRole('textbox', { name: 'Description, line 1', exact: true })).toHaveValue(
      'Labor',
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: /2 lines.*20/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('gridcell', { name: /2 lines.*20/ })).toBeVisible();
  });
}

for (const width of [1500, 390]) {
  test(`pastes blank and populated linked cells at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const database = await createDatabase(page, 'Linked lines', [
      { name: 'Invoices', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Invoice 1' }] },
      { name: 'Products', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Widget' }] },
    ]);
    const description = newId('fld');
    const amount = newId('fld');
    const product = newId('fld');
    await runCommands(page, database.id, [
      {
        kind: 'field.create',
        tableId: database.tables.Invoices!.id,
        field: {
          id: newId('fld'),
          name: 'Rows',
          type: 'lineItems',
          options: {
            columns: [
              { id: description, name: 'Description', type: 'text' },
              { id: amount, name: 'Amount', type: 'currency' },
              {
                id: product,
                name: 'Product',
                type: 'link',
                options: { linkedTableId: database.tables.Products!.id },
              },
            ],
          },
        },
      },
    ]);
    const grid = await openTable(page, database, 'Invoices');
    await grid.getByRole('gridcell', { name: 'Invoice 1', exact: true }).click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const editor = page.getByRole('table', { name: 'Rows', exact: true });
    await expect(page.getByRole('button', { name: 'Add line', exact: true })).toBeVisible();
    for (const text of ['Parts\t12.50\t', 'Shipping\t7.50\tWidget']) {
      await pasteText(editor, text);
    }
    await expect(editor.locator('tbody tr')).toHaveCount(2);
    await expect(editor.locator('tfoot')).toContainText('$20.00');
    await expect(editor.getByText('Widget', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('gridcell', { name: /2 lines.*20/ })).toBeVisible();
  });
}
