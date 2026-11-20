import { openNewField } from '../grid-fields';
import { expect, test, type Locator, type Page } from '../accessibility';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';

test.use({ serviceWorkers: 'block', viewport: { width: 2560, height: 1080 } });

async function choose(page: Page, dialog: Locator, label: string, option: string) {
  await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('preserves a newline separator through keyboard edits, saving, and reopening on a phone', async ({
  page,
}) => {
  await signIn(page);
  const database = await createDatabase(page, 'Multiline computed fields', [
    {
      name: 'People',
      fields: [
        { name: 'First', type: 'text' },
        { name: 'Last', type: 'text' },
      ],
      records: [{ First: 'Ada', Last: 'Lovelace' }],
    },
  ]);
  const people = database.tables.People!;
  const combined = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: people.id,
      field: {
        id: combined,
        name: 'Combined',
        type: 'formula',
        options: {
          expression: `CONCATENATE({${people.fields.First}}, "\\n", {${people.fields.Last}})`,
        },
      },
    },
  ]);
  await openTable(page, database, 'People');
  await page.setViewportSize({ width: 390, height: 844 });
  const fieldLink = `${page.url().split('?')[0]}?fieldRules=${combined}`;
  await visit(page, fieldLink);
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  const separator = dialog.getByRole('textbox', { name: 'Separator' });
  await expect(separator).toHaveValue('\n');
  await separator.press('ControlOrMeta+A');
  await separator.press('ArrowRight');
  await separator.press('x');
  await separator.press('Enter');
  await separator.press('y');
  await expect(separator).toHaveValue('\nx\ny');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await visit(page, fieldLink);
  await expect(separator).toHaveValue('\nx\ny');
  await choose(page, dialog, 'Edit as', 'Formula');
  await expect(dialog.getByRole('textbox', { name: 'Formula' })).toHaveValue(
    'CONCATENATE({First}, "\\nx\\ny", {Last})',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('all computed builders save formulas, reopen from a field link, and allow custom expressions on a phone', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const database = await createDatabase(page, 'Computed fields', [
    {
      name: 'People',
      fields: [
        { name: 'First', type: 'text' },
        { name: 'Last', type: 'text' },
        { name: 'Amount', type: 'number' },
        { name: 'Start', type: 'date' },
        { name: 'End', type: 'date' },
        { name: 'Date range', type: 'dateRange' },
      ],
      records: [{ First: 'Ada', Last: 'Lovelace', Amount: 12, Start: '2026-09-29', End: '2026-10-01' }],
    },
    {
      name: 'Contacts',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Grace' }, { Name: 'Katherine' }],
    },
  ]);
  const people = database.tables.People!,
    contacts = database.tables.Contacts!;
  const link = newId('fld');
  await runCommands(page, database.id, [
    {
      kind: 'field.create',
      tableId: people.id,
      field: { id: link, name: 'Contacts', type: 'link', options: { linkedTableId: contacts.id } },
    },
    {
      kind: 'record.update',
      tableId: people.id,
      records: [{ id: people.records[0], values: { [link]: contacts.records } }],
    },
  ]);
  const grid = await openTable(page, database, 'People');
  const cases = [
    { builder: 'Combine text', name: 'Full name', expected: 'Ada / Lovelace' },
    { builder: 'Date difference', name: 'Elapsed', expected: '2' },
    { builder: 'If-then mapping', name: 'Mapped', expected: 'Matched' },
    { builder: 'Bucket a number', name: 'Bucketed', expected: 'High' },
    { builder: 'Pick from links', name: 'Picked', expected: 'Katherine' },
  ];
  for (const item of cases) {
    await openNewField(page);
    const dialog = page.getByRole('dialog', { name: 'New field' });
    await choose(page, dialog, 'Type', 'Formula');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(item.name);
    await choose(page, dialog, 'Edit as', item.builder);
    if (item.builder === 'Combine text') {
      await choose(page, dialog, 'First field', 'First');
      await choose(page, dialog, 'Second field', 'Last');
      await dialog.getByRole('textbox', { name: 'Separator' }).fill(' / ');
    } else if (item.builder === 'Date difference') {
      await choose(page, dialog, 'Start date', 'Start');
      await choose(page, dialog, 'End date', 'End');
      await choose(page, dialog, 'Unit', 'Hours');
      await choose(page, dialog, 'Unit', 'Days');
    } else if (item.builder === 'Pick from links') {
      await choose(page, dialog, 'Source field', 'Contacts');
      const position = dialog.getByRole('textbox', { name: 'Link position (starts at 1)' });
      await position.fill('0');
      await expect(dialog.getByRole('button', { name: 'Create field' })).toBeDisabled();
      await position.fill('2');
    } else {
      await dialog.getByRole('button', { name: /Source field$/ }).click();
      await expect(page.getByRole('option', { name: 'Date range', exact: true })).toHaveCount(0);
      await page
        .getByRole('option', { name: item.builder === 'Bucket a number' ? 'Amount' : 'First', exact: true })
        .click();
      await dialog
        .getByRole('textbox', {
          name: item.builder === 'Bucket a number' ? 'If the number is below' : 'If the value equals',
        })
        .fill(item.builder === 'Bucket a number' ? '10' : 'Ada');
      await dialog
        .getByRole('textbox', { name: 'Then return' })
        .fill(item.builder === 'Bucket a number' ? 'Low' : 'Matched');
      await dialog
        .getByRole('textbox', { name: 'Otherwise return' })
        .fill(item.builder === 'Bucket a number' ? 'High' : 'Other');
    }
    await expect(dialog.getByRole('textbox', { name: 'Formula' })).toHaveAttribute('readonly', '');
    await dialog.getByRole('button', { name: 'Create field' }).click();
    await expect(dialog).toBeHidden();
    await expect(grid.getByRole('gridcell', { name: item.expected, exact: true })).toBeVisible();
  }
  const schema = await asOwner<{
    fields: Array<{ id: string; name: string; type: string; options: { expression?: string } }>;
  }>(page, 'GET', `/api/databases/${database.id}/schema`);
  for (const item of cases) {
    const saved = schema.fields.find((field) => field.name === item.name)!;
    expect(saved.type).toBe('formula');
    expect(saved.options.expression).toContain('{');
    await visit(page, `${page.url().split('?')[0]}?fieldRules=${saved.id}`);
    const dialog = page.getByRole('dialog', { name: 'Edit field' });
    await expect(dialog.getByRole('button', { name: new RegExp(`${item.builder} Edit as$`) })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  }
  const fullName = schema.fields.find((field) => field.name === 'Full name')!;
  await page.setViewportSize({ width: 390, height: 844 });
  await visit(page, `${page.url().split('?')[0]}?fieldRules=${fullName.id}`);
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  await dialog.getByRole('textbox', { name: 'Separator' }).fill(' + ');
  const bounds = await dialog.boundingBox();
  expect(bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('computed-builder-phone.png') });
  await dialog.getByRole('button', { name: /Edit as$/ }).press('ArrowDown');
  await page.getByRole('option', { name: 'Formula', exact: true }).press('Home');
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('textbox', { name: 'Formula' })).toHaveValue(
    'CONCATENATE({First}, " + ", {Last})',
  );
  await dialog.getByRole('textbox', { name: 'Formula' }).fill('UPPER({First}) & "!"');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await visit(page, `${page.url().split('?')[0]}?fieldRules=${fullName.id}`);
  await expect(
    page.getByRole('dialog', { name: 'Edit field' }).getByRole('textbox', { name: 'Formula' }),
  ).toHaveValue('(UPPER({First}) & "!")');
  await expect(page.getByRole('textbox', { name: 'Separator' })).toHaveCount(0);
});
