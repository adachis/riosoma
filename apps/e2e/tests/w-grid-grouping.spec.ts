import { expect, test } from '../accessibility';
import {
  labelName,
  asOwner,
  createDatabase,
  newId,
  openTable,
  pasteText,
  runCommands,
  signIn,
} from '../helpers';

test.use({ serviceWorkers: 'block' });

test('groups records, collapses by keyboard, adds within a group, and updates counts from another page', async ({
  page,
  context,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grouped projects', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['Ready', 'Done'] },
      ],
      records: [
        { Name: 'First project', Status: 'Ready' },
        { Name: 'Finished project', Status: 'Done' },
      ],
    },
  ]);
  const table = database.tables.Projects!;
  await openTable(page, database, 'Projects');
  await page.getByRole('button', { name: 'Group', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Group', exact: true });
  await panel.getByRole('button', { name: 'Add group', exact: true }).click();
  await page.getByRole('menuitem', { name: labelName('Status'), exact: true }).click();
  await panel.press('Escape');
  await expect(panel).toBeHidden();
  const grid = page.getByRole('treegrid');
  const ready = grid.getByRole('row', { name: 'Ready, 1 record', exact: true });
  await expect(ready).toHaveAttribute('aria-level', '1');
  await ready.getByRole('button', { name: 'Ready, 1 record', exact: true }).focus();
  await expect(ready.getByRole('button', { name: 'Ready, 1 record', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(ready).toHaveAttribute('aria-expanded', 'false');
  await expect(grid.getByRole('gridcell', { name: 'First project', exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(ready).toHaveAttribute('aria-expanded', 'true');
  await grid.getByRole('button', { name: 'Add record in Ready', exact: true }).click();
  await expect(grid.getByRole('row', { name: 'Ready, 2 records', exact: true })).toBeVisible();
  const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?offset=0&limit=200&refresh=1`,
  );
  expect(
    saved.rows.filter((row) => row.values[table.fields.Status!] === table.choices.Status!.Ready),
  ).toHaveLength(2);

  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await runCommands(other, database.id, [
      {
        kind: 'record.create',
        tableId: table.id,
        records: [
          {
            id: newId('rec'),
            values: {
              [table.fields.Name!]: 'Another project',
              [table.fields.Status!]: table.choices.Status!.Ready,
            },
          },
        ],
      },
    ]);
    await expect(grid.getByRole('row', { name: 'Ready, 3 records', exact: true })).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('treegrid').getByRole('row', { name: 'Ready, 3 records', exact: true }),
    ).toBeVisible();
  } finally {
    await other.close();
  }
});

test('keeps collapsed records unchanged when a clipboard extends beyond the selected cell', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grouped paste', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'singleSelect', choices: ['First', 'Middle', 'Last'] },
      ],
      records: [
        { Name: 'Visible first', Status: 'First' },
        { Name: 'Hidden middle', Status: 'Middle' },
        { Name: 'Visible last', Status: 'Last' },
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
  await grid.getByRole('button', { name: 'Middle, 1 record', exact: true }).click();
  await expect(grid.getByRole('row', { name: 'Middle, 1 record', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await grid.getByRole('gridcell', { name: 'Visible first', exact: true }).click();
  const paste = (text: string) => pasteText(page.locator('.rio-grid__input'), text);
  await paste('first replacement\nsecond replacement');
  await paste('safe replacement');
  await expect(grid.getByRole('gridcell', { name: 'safe replacement', exact: true })).toBeVisible();
  await grid.getByRole('button', { name: 'Middle, 1 record', exact: true }).click();
  await expect(grid.getByRole('gridcell', { name: 'Hidden middle', exact: true })).toBeVisible();
  const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows?refresh=1`,
  );
  expect(saved.rows.map((row) => row.values[table.fields.Name!])).toEqual([
    'safe replacement',
    'Hidden middle',
    'Visible last',
  ]);
});

test('pastes new records into an empty ungrouped grid', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Empty paste', [
    {
      name: 'Projects',
      fields: [{ name: 'Name', type: 'text' }],
      records: [],
    },
  ]);
  await openTable(page, database, 'Projects');
  await pasteText(page.locator('.rio-grid__input'), 'First pasted project\nSecond pasted project');
  const preview = page.getByRole('dialog', { name: 'Paste 2 cells?' });
  await preview.getByRole('button', { name: 'Paste', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Grid', exact: true });
  await expect(grid.getByRole('gridcell', { name: 'First pasted project', exact: true })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Second pasted project', exact: true })).toBeVisible();
});

test('stops double-click fill before a collapsed group', async ({ page }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grouped fill', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Status', type: 'text' },
      ],
      records: [
        { Name: 'First', Amount: 10, Status: 'A' },
        { Name: 'Second', Amount: 11, Status: 'A' },
        { Name: 'Hidden', Amount: 12, Status: 'B' },
        { Name: 'Last', Amount: 13, Status: 'C' },
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
  await grid.getByRole('button', { name: 'B, 1 record', exact: true }).click();
  await grid.getByRole('gridcell', { name: '10', exact: true }).click();
  await page.locator('.rio-grid__fill-handle').dblclick();
  await expect(grid.getByRole('gridcell', { name: '10', exact: true })).toHaveCount(2);
  await expect
    .poll(async () => {
      const saved = await asOwner<{ rows: Array<{ values: Record<string, unknown> }> }>(
        page,
        'GET',
        `/api/views/${table.viewId}/rows?refresh=1`,
      );
      return saved.rows.map((row) => row.values[table.fields.Amount!]);
    })
    .toEqual([10, 10, 12, 13]);
});

test('preserves a draft and selected record through realtime group updates', async ({ page, context }) => {
  await signIn(page);
  const database = await createDatabase(page, 'Grouped selection', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Status', type: 'text' },
      ],
      records: [
        { Name: 'First', Status: 'A' },
        { Name: 'Second', Status: 'A' },
        { Name: 'Third', Status: 'B' },
        { Name: 'Selected', Status: 'B' },
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
  const saved = await asOwner<{ rows: Array<{ id: string }> }>(
    page,
    'GET',
    `/api/views/${table.viewId}/rows`,
  );
  const other = await context.newPage();
  try {
    await other.goto(page.url());
    await grid.getByRole('gridcell', { name: 'Selected', exact: true }).dblclick();
    const input = page.locator('.rio-grid__input');
    await input.fill('Draft');
    await runCommands(other, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: saved.rows[0]!.id, values: { [table.fields.Name!]: 'Updated first' } }],
      },
    ]);
    await expect(grid.getByRole('gridcell', { name: 'Updated first', exact: true })).toBeVisible();
    await expect(input).toHaveAttribute('data-editing', '');
    await expect(input).toHaveValue('Draft');
    await input.press('Enter');
    await expect(grid.getByRole('gridcell', { name: 'Draft', exact: true })).toBeVisible();
    await grid.getByRole('gridcell', { name: 'Draft', exact: true }).click();
    await runCommands(other, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: saved.rows[1]!.id, values: { [table.fields.Status!]: 'AB' } }],
      },
    ]);
    await expect(grid.getByRole('row', { name: 'AB, 1 record', exact: true })).toBeVisible();
    await input.press('F2');
    await input.fill('Still selected');
    await input.press('Enter');
    await expect
      .poll(async () => {
        const after = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
          page,
          'GET',
          `/api/views/${table.viewId}/rows?refresh=1`,
        );
        return [3, 2].map(
          (index) => after.rows.find((row) => row.id === saved.rows[index]!.id)?.values[table.fields.Name!],
        );
      })
      .toEqual(['Still selected', 'Third']);
  } finally {
    await other.close();
  }
});
