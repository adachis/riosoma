import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';

test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

test('table creation asks on the shortcut, keeps by default, moves to trash after yes, and redoes', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Major table undo', [
    { name: 'Records', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Records');
  await page.getByRole('button', { name: 'Add a table', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Blank table'), exact: true }).click();
  const link = page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Table 2', exact: true });
  await expect(link).toBeVisible();
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  await expect(history.getByRole('option', { name: /Added the Table 2 table/ })).toBeVisible();
  await expect(history.getByText('Asks first')).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  const confirmation = page.getByRole('dialog', { name: 'Undo creating the table Table 2?' });
  await expect(confirmation.getByText('It and its 0 records go to the trash.')).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Keep it' }).click();
  await expect(link).toBeVisible();
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await confirmation.getByRole('button', { name: 'Move to trash' }).click();
  await expect(link).toHaveCount(0);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Trash', exact: true });
  await expect(trash.getByRole('button', { name: 'Restore Table 2' })).toBeVisible();
  await trash.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(link).toBeVisible();
  await expect(confirmation).toHaveCount(0);
});

test('an imported database asks on the shortcut, keeps, trashes the whole database, and restores its records with redo', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New database from a CSV or Excel file', exact: true }).click();
  await page.getByRole('button', { name: 'Choose a CSV or Excel file', exact: true }).setInputFiles({
    name: 'Projects.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Name\nFirst project\nSecond project'),
  });
  const importing = page.getByRole('dialog', { name: 'Import Projects.csv' });
  await importing.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Second project', exact: true })).toBeVisible();
  const databaseId = new URL(page.url()).pathname.split('/')[1]!;
  await page.reload();
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  const confirmation = page.getByRole('dialog', { name: 'Undo creating the database Projects?' });
  await expect(confirmation.getByText('It and its 1 table and 2 records go to the trash.')).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.getByRole('gridcell', { name: 'Second project', exact: true })).toBeVisible();
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await confirmation.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page).toHaveURL(base() + '/');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog', { name: 'Deleted databases' });
  await expect(trash.getByRole('button', { name: 'Restore Projects' })).toBeVisible();
  await trash.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect
    .poll(async () =>
      (await asOwner<Array<{ id: string }>>(page, 'GET', '/api/databases')).map((item) => item.id),
    )
    .toContain(databaseId);
  const schema = await asOwner<{ tables: Array<{ id: string }>; views: Array<{ id: string }> }>(
    page,
    'GET',
    `/api/databases/${databaseId}/schema`,
  );
  await page.goto(`${base()}/${databaseId}/${schema.tables[0]!.id}/${schema.views[0]!.id}`);
  await expect(page.getByRole('gridcell', { name: 'Second project', exact: true })).toBeVisible();
  await expect(confirmation).toHaveCount(0);
});

test('a line-items field has no asks-first mark and undoes and redoes with one shortcut', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Line-items field undo', [
    { name: 'Invoices', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  const grid = await openTable(page, database, 'Invoices');
  await page.getByRole('button', { name: 'Add field', exact: true }).click();
  const field = page.getByRole('dialog', { name: 'New field', exact: true });
  await field.getByRole('button', { name: /Type$/ }).click();
  await page.getByRole('option', { name: labelName('Line items'), exact: true }).click();
  await field.getByRole('textbox', { name: 'Name', exact: true }).fill('Lines');
  await field.getByRole('button', { name: 'Add column', exact: true }).click();
  await field.getByRole('textbox', { name: 'Column name', exact: true }).fill('Description');
  await field.getByRole('button', { name: 'Create field', exact: true }).click();
  const column = grid.getByRole('columnheader', { name: 'Lines', exact: true });
  await expect(column).toBeVisible();
  await page.getByRole('button', { name: 'Undo history', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'Undo history' });
  const entry = history.getByRole('option', { name: /Added the Lines field to Invoices/ });
  await expect(entry).toBeVisible();
  await expect(entry.getByText('Asks first')).toHaveCount(0);
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.locator('.rio-grid__input').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(column).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: /Undo creating/ })).toHaveCount(0);
    await page.locator('.rio-grid__input').focus();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(column).toBeVisible();
  }
});

test('undoing a linked table duplicate asks only about its parent and preserves inverse fields through redo', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Linked table undo', [
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }] },
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text' },
        {
          name: 'Lines',
          type: 'lineItems',
          options: { columns: [{ id: newId('fld'), name: 'Description', type: 'text' }] },
        },
      ],
    },
  ]);
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: database.tables.Tasks!.id,
      field: {
        id: newId('fld'),
        name: 'Project',
        type: 'link',
        options: { linkedTableId: database.tables.Projects!.id },
      },
    },
  ]);
  await openTable(page, database, 'Tasks');
  await page.getByRole('button', { name: 'More for Tasks', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Duplicate table'), exact: true }).click();
  const duplicate = page.getByRole('dialog', { name: 'Duplicate table', exact: true });
  await duplicate.getByRole('button', { name: 'Duplicate table', exact: true }).click();
  const copy = page.getByRole('link', { name: 'Tasks copy', exact: true });
  await expect(copy).toBeVisible();
  const inverseFields = async () => {
    const schema = await asOwner<{ fields: Array<{ id: string; tableId: string }> }>(
      page,
      'GET',
      `/api/databases/${database.id}/schema`,
    );
    return schema.fields.filter((field) => field.tableId === database.tables.Projects!.id);
  };
  const before = await inverseFields();
  expect(before).toHaveLength(3);
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  const confirmation = page.getByRole('dialog', { name: 'Undo creating the table Tasks copy?' });
  await expect(confirmation).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(confirmation.getByRole('button', { name: 'Keep it' })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.getByRole('dialog', { name: /Undo creating/ })).toHaveCount(0);
  expect(await inverseFields()).toEqual(before);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(copy).toHaveCount(0);
  await page.locator('.rio-grid__input').focus();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(copy).toBeVisible();
  expect(await inverseFields()).toEqual(before);
});
