import { expect, test } from '../accessibility';
import { asOwner, createDatabase, openTable, signIn, visit } from '../helpers';
import type { Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
test.setTimeout(90_000);
interface Schema {
  tables: Array<{ id: string; name: string }>;
  fields: Array<{ id: string; tableId: string; name: string }>;
  views: Array<{ id: string; tableId: string; type: string }>;
}
async function undoToast(page: Page, asksFirst = false) {
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  if (asksFirst) await page.getByRole('button', { name: 'Move to trash', exact: true }).click();
  await expect(page.getByText('Undone', { exact: true }).last()).toBeVisible();
}

test('duplicates from the grid, record panel, and expanded page, then undoes each copy', async ({ page }) => {
  await signIn(page);
  const { preferences } = await asOwner<{ preferences: { recordLayout?: 'card' | 'panel' } }>(
    page,
    'GET',
    '/api/auth/session',
  );
  try {
    await asOwner(page, 'PATCH', '/api/me/preferences', { recordLayout: 'panel' });
    const database = await createDatabase(page, 'Record duplication', [
      {
        name: 'Tasks',
        fields: [{ name: 'Name', type: 'text' }],
        records: [{ Name: 'Original' }, { Name: 'Neighbor' }],
      },
    ]);
    const table = database.tables.Tasks!;
    const grid = await openTable(page, database, 'Tasks');
    const ids = async () =>
      (
        await asOwner<{ rows: Array<{ id: string }> }>(
          page,
          'GET',
          `/api/views/${table.viewId}/rows?refresh=1`,
        )
      ).rows.map((row) => row.id);
    await grid.getByRole('rowheader').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate record', exact: true }).click();
    await expect.poll(async () => (await ids()).length).toBe(3);
    expect((await ids())[0]).toBe(table.records[0]);
    expect((await ids())[2]).toBe(table.records[1]);
    await expect(page.getByRole('region', { name: 'Original', exact: true })).toHaveCount(0);
    await undoToast(page);
    await expect.poll(ids).toEqual(table.records);
    await grid.getByRole('button', { name: 'Expand row 1', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Original', exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'More for this record' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate record', exact: true }).click();
    await expect.poll(async () => (await ids()).length).toBe(3);
    await expect(panel).toBeVisible();
    await undoToast(page);
    await expect.poll(ids).toEqual(table.records);
    await visit(
      page,
      new URL(`/${database.id}/${table.id}/${table.viewId}/${table.records[0]}/page`, page.url()).href,
    );
    await page.getByRole('button', { name: 'More for this record' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate record', exact: true }).click();
    await expect.poll(async () => (await ids()).length).toBe(3);
    await undoToast(page);
    await expect.poll(ids).toEqual(table.records);
  } finally {
    // Layout is saved on the shared account, so later specs must inherit its original choice.
    await asOwner(page, 'PATCH', '/api/me/preferences', {
      recordLayout: preferences.recordLayout ?? 'card',
    });
  }
});

for (const withValues of [false, true])
  test(`duplicates a field with values=${withValues} and undoes its placement`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Field duplication', [
      {
        name: 'Tasks',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Amount', type: 'number' },
        ],
        records: [{ Name: 'Original', Amount: 17 }],
      },
    ]);
    const table = database.tables.Tasks!;
    const grid = await openTable(page, database, 'Tasks');
    if (withValues) {
      await grid.getByRole('columnheader', { name: 'Amount', exact: true }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate field', exact: true }).click();
    } else {
      await visit(page, `${page.url()}?fieldRules=${table.fields.Amount}`);
      await page
        .getByRole('dialog', { name: 'Edit field' })
        .getByRole('button', { name: 'Duplicate field', exact: true })
        .click();
    }
    const dialog = page.getByRole('dialog', { name: 'Duplicate field', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Amount copy');
    if (withValues) {
      const option = dialog.getByRole('checkbox', { name: 'Copy field values' });
      await option.press('Space');
      await expect(option).toBeChecked();
    }
    await dialog.getByRole('button', { name: 'Duplicate field', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(grid.getByRole('columnheader', { name: 'Amount copy', exact: true })).toBeVisible();
    const schema = await asOwner<Schema>(page, 'GET', `/api/databases/${database.id}/schema`);
    const copied = schema.fields.find((field) => field.name === 'Amount copy')!;
    const rows = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
    expect(rows.rows[0]!.values[copied.id]).toBe(withValues ? 17 : null);
    await undoToast(page);
    await expect(grid.getByRole('columnheader', { name: 'Amount copy', exact: true })).toHaveCount(0);
  });

for (const withRecords of [false, true])
  test(`duplicates a table with records=${withRecords} and undoes its fields and views`, async ({ page }) => {
    await signIn(page);
    const database = await createDatabase(page, 'Table duplication', [
      { name: 'Tasks', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Original' }] },
    ]);
    await openTable(page, database, 'Tasks');
    await page.getByRole('button', { name: 'More for Tasks', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Duplicate table', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Duplicate table', exact: true });
    await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('Tasks copy');
    if (withRecords) {
      const option = dialog.getByRole('checkbox', { name: 'Include records' });
      await option.press('Space');
      await expect(option).toBeChecked();
    }
    await dialog.getByRole('button', { name: 'Duplicate table', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('link', { name: 'Tasks copy', exact: true })).toBeVisible();
    const schema = await asOwner<Schema>(page, 'GET', `/api/databases/${database.id}/schema`);
    const copied = schema.tables.find((table) => table.name === 'Tasks copy')!;
    const view = schema.views.find((view) => view.tableId === copied.id)!;
    const rows = await asOwner<{ total: number }>(page, 'GET', `/api/views/${view.id}/rows?refresh=1`);
    expect(rows.total).toBe(withRecords ? 1 : 0);
    await undoToast(page, true);
    await expect(page.getByRole('link', { name: 'Tasks copy', exact: true })).toHaveCount(0);
    const undone = await asOwner<Schema>(page, 'GET', `/api/databases/${database.id}/schema`);
    expect(undone.fields.some((field) => field.tableId === copied.id)).toBe(false);
    expect(undone.views.some((view) => view.tableId === copied.id)).toBe(false);
  });
