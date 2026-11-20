import { expect, test, type Locator, type Page } from '../accessibility';
import { labelName, asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

async function choose(page: Page, container: Locator, label: string, option: string, key?: string) {
  await container.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  const choice = page.getByRole('option', {
    name: label === 'Condition' ? option : labelName(option),
    exact: true,
  });
  await (key ? choice.and(page.locator(`[data-key="${key}"]`)) : choice).click();
}

async function editContact(page: Page, grid: Locator) {
  await grid.getByRole('columnheader', { name: 'Contact text', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: labelName('Edit field'), exact: true }).click();
  return page.getByRole('dialog', { name: 'Edit field' });
}

async function fixtures(page: Page) {
  const target = await createDatabase(page, 'Conversion directory', [
    {
      name: 'Contacts',
      fields: [{ name: 'Name', type: 'text' }],
      records: [{ Name: 'Allowed' }, { Name: 'Excluded' }],
    },
  ]);
  const source = await createDatabase(page, 'Conversion planning', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Contact text', type: 'text' },
      ],
      records: [
        { Name: 'Visible', 'Contact text': 'Allowed' },
        { Name: 'Hidden', 'Contact text': 'Hidden confidential payload' },
      ],
    },
  ]);
  return { target, source, contacts: target.tables.Contacts!, projects: source.tables.Projects! };
}

test('keeps hidden source values out of the conversion dialog', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const { source, target, projects, contacts } = await fixtures(page);
  const person = await invite(page, browser, 'Restricted creator');
  try {
    await share(page, source.id, person, 'creator');
    await share(page, target.id, person, 'creator');
    await asOwner(page, 'PUT', `/api/tables/${projects.id}/record-rules`, {
      rules: [
        {
          id: newId('rul'),
          roles: ['creator'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible', fieldId: projects.fields.Name, operator: 'is', value: 'Visible' }],
          },
        },
      ],
    });
    const grid = await openTable(person.page, source, 'Projects');
    const dialog = await editContact(person.page, grid);
    await choose(person.page, dialog, 'Type', 'Link to another record');
    const previewed = person.page.waitForResponse(
      (response) =>
        response.url().endsWith('/conversion-preview') &&
        response.request().postDataJSON().to.options.linkedTableId === contacts.id,
    );
    await choose(person.page, dialog, 'Link to', 'Contacts', contacts.id);
    const preview = await previewed;
    expect(preview.status()).toBe(403);
    expect(await preview.text()).not.toContain('Hidden confidential payload');
    await expect(dialog.getByRole('alert')).toContainText(
      'You can’t change a record you don’t have access to.',
    );
    await expect(dialog).not.toContainText('Hidden confidential payload');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const stored = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${projects.id}/records/${projects.records[1]}`,
    );
    expect(stored.values[projects.fields['Contact text']!]).toBe('Hidden confidential payload');
    await person.page.setViewportSize({ width: 390, height: 844 });
    await person.page.reload();
    await expect(person.page.getByRole('gridcell', { name: 'Hidden', exact: true })).toHaveCount(0);
  } finally {
    await person.context.close();
  }
});

for (const side of ['source', 'destination'] as const) {
  test(`refuses conversion when the ${side} record is locked`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const { source, target, projects, contacts } = await fixtures(page);
    const locked = side === 'source' ? projects : contacts;
    await runCommands(page, side === 'source' ? source.id : target.id, [
      {
        kind: 'record.setLock',
        tableId: locked.id,
        recordIds: [locked.records[0]],
        locked: true,
        reason: 'Reviewed',
      },
      {
        kind: 'table.update',
        tableId: locked.id,
        recordLock: { bypass: 'nobody', condition: null, reason: '' },
      },
    ]);
    const grid = await openTable(page, source, 'Projects');
    const dialog = await editContact(page, grid);
    await choose(page, dialog, 'Type', 'Link to another record');
    await choose(page, dialog, 'Link to', 'Contacts', contacts.id);
    await expect(dialog.getByText(/1 value can’t be converted and will be cleared/)).toBeVisible();
    const saved = page.waitForResponse((response) =>
      response.url().endsWith(`/api/databases/${source.id}/commands`),
    );
    await dialog.getByRole('button', { name: 'Save', exact: true }).press('Enter');
    expect(await (await saved).json()).toMatchObject({
      results: [
        { status: 'rejected', error: { messageKey: 'data.locks.recordLocked' } },
        { status: 'applied' },
      ],
    });
    await expect(dialog.getByRole('alert').filter({ hasText: 'This record is locked.' })).toContainText(
      'This record is locked.',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: 'Allowed', exact: true })).toBeVisible();
    const schema = await asOwner<{ fields: Array<{ tableId: string; type: string }> }>(
      page,
      'GET',
      `/api/databases/${target.id}/schema`,
    );
    expect(schema.fields.filter((field) => field.type === 'link')).toEqual([]);
    await page.reload();
    await expect(page.getByRole('gridcell', { name: 'Allowed', exact: true })).toBeVisible();
  });
}

for (const restriction of ['filter', 'view'] as const) {
  test(`converts only choices allowed by the ${restriction} in the field dialog`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page);
    const { source, target, projects, contacts } = await fixtures(page);
    await runCommands(page, source.id, [
      {
        kind: 'record.update',
        tableId: projects.id,
        records: [{ id: projects.records[0], values: { [projects.fields['Contact text']!]: 'Excluded' } }],
      },
    ]);
    const filter = {
      conjunction: 'and',
      conditions: [{ id: 'allowed', fieldId: contacts.fields.Name, operator: 'is', value: 'Allowed' }],
    };
    if (restriction === 'view')
      await runCommands(page, target.id, [
        { kind: 'view.update', viewId: contacts.viewId, config: { filter } },
      ]);
    const grid = await openTable(page, source, 'Projects');
    const dialog = await editContact(page, grid);
    await choose(page, dialog, 'Type', 'Link to another record');
    await choose(page, dialog, 'Link to', 'Contacts', contacts.id);
    await choose(
      page,
      dialog,
      'Limit choices',
      restriction === 'filter' ? 'Records matching a filter' : 'Records in a view',
    );
    if (restriction === 'filter') {
      await dialog.getByRole('button', { name: 'Add condition', exact: true }).click();
      const condition = dialog.getByRole('group', { name: 'Condition', exact: true });
      await choose(page, condition, 'Field', 'Name');
      await choose(page, condition, 'Condition', 'is');
      await condition.getByRole('textbox', { name: 'Value', exact: true }).fill('Allowed');
    }
    await expect(dialog.getByText(/2 values can’t be converted and will be cleared/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    const stored = await asOwner<{ values: Record<string, unknown> }>(
      page,
      'GET',
      `/api/tables/${projects.id}/records/${projects.records[0]}`,
    );
    expect(stored.values[projects.fields['Contact text']!]).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.getByRole('gridcell', { name: 'Excluded', exact: true })).toHaveCount(0);
  });
}

test('shows external formula lookups using the destination named function', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const { source, target, projects, contacts } = await fixtures(page);
  const formulaId = newId('fld');
  const lookupId = newId('fld');
  const linkId = newId('fld');
  await runCommands(page, target.id, [
    {
      kind: 'namedFunction.create',
      functionId: `fnc${newId('fld').slice(3)}`,
      definition: { name: 'TRIPLE', parameters: ['amount'], body: 'amount * 3' },
    },
    {
      kind: 'field.create',
      tableId: contacts.id,
      field: { id: formulaId, name: 'Tripled', type: 'formula', options: { expression: 'TRIPLE(7)' } },
    },
  ]);
  await runCommands(page, source.id, [
    {
      kind: 'namedFunction.create',
      functionId: `fnc${newId('fld').slice(3)}`,
      definition: { name: 'TRIPLE', parameters: ['amount'], body: 'amount * 100' },
    },
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: linkId,
        name: 'Contact',
        type: 'link',
        options: { linkedTableId: contacts.id, oneWay: true },
      },
    },
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: lookupId,
        name: 'Tripled contact amount',
        type: 'lookup',
        options: { linkFieldId: linkId, targetFieldId: formulaId },
      },
    },
    {
      kind: 'record.update',
      tableId: projects.id,
      records: [{ id: projects.records[0], values: { [linkId]: [contacts.records[0]] } }],
    },
  ]);
  const grid = await openTable(page, source, 'Projects');
  await grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Visible', exact: true }) })
    .getByRole('button', { name: /^Expand row/ })
    .click();
  let card = page.getByRole('dialog', { name: 'Visible', exact: true });
  await expect(card.getByRole('group', { name: 'Tripled contact amount', exact: true })).toHaveText('21');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  card = page.getByRole('dialog', { name: 'Visible', exact: true });
  await expect(card.getByRole('group', { name: 'Tripled contact amount', exact: true })).toHaveText('21');
});
