import { openNewField } from '../grid-fields';
import { expect, test, type Locator, type Page } from '../accessibility';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { jsonLines, unpack } from '../../server/src/data/organization-archives/container.js';
import { base } from '../base';
import {
  labelName,
  asOwner,
  createDatabase,
  createView,
  newId,
  offlineMap,
  openTable,
  runCommands,
  signIn,
  visit,
} from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

test('downloads an organization archive with both external link directions and their records', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await signIn(page);
  const target = await createDatabase(page, 'Archived directory', [
    { name: 'Contacts', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Morgan' }] },
  ]);
  const source = await createDatabase(page, 'Archived planning', [
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
  ]);
  const projects = source.tables.Projects!,
    contacts = target.tables.Contacts!;
  const ids = [newId('fld'), newId('fld')];
  for (const [index, fieldId] of ids.entries())
    await runCommands(page, source.id, [
      {
        kind: 'field.create',
        tableId: projects.id,
        field: {
          id: fieldId,
          name: index ? 'One-way contact' : 'Paired contact',
          type: 'link',
          options: { linkedTableId: contacts.id, oneWay: Boolean(index) },
        },
      },
      {
        kind: 'record.update',
        tableId: projects.id,
        records: [{ id: projects.records[0], values: { [fieldId]: contacts.records } }],
      },
    ]);
  await visit(page, `${base()}/settings/export-and-import`);
  const exported = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/organization-archives/export') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start export', exact: true }).click();
  const response = await exported;
  expect(response.ok()).toBe(true);
  const job = (await response.json()) as { id: string };
  const link = page.locator(`a[href="/api/organization-archives/${job.id}/download"]`);
  await expect(link).toBeVisible({ timeout: 60_000 });
  const downloading = page.waitForEvent('download');
  await link.click();
  const downloaded = await downloading;
  const bytes = await readFile((await downloaded.path())!);
  const { directory } = await unpack(
    Readable.from([bytes]),
    Number.MAX_SAFE_INTEGER,
    info.outputPath('archive-work'),
  );
  try {
    const entries: Array<{ kind: string; catalog?: string; table?: string; row?: Record<string, unknown> }> =
      [];
    for await (const item of jsonLines(directory.read(`databases/${source.id}.jsonl`)))
      entries.push(item as (typeof entries)[number]);
    for (const fieldId of ids) {
      const junctions = entries.filter(
        (item) => item.catalog === 'links' && item.row?.left_field_id === fieldId,
      );
      expect(junctions).toHaveLength(1);
      expect(
        entries.filter((item) => item.kind === 'links' && item.table === junctions[0]!.row!.id),
      ).toHaveLength(1);
    }
  } finally {
    await directory.close();
  }
});

const viewTypes = [
  'grid',
  'kanban',
  'gallery',
  'calendar',
  'form',
  'timeline',
  'gantt',
  'chart',
  'pivot',
  'list',
  'map',
  'orgChart',
] as const;

test('opens every view type with filters and sorts over an external rollup', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page);
  await offlineMap(page);
  const target = await createDatabase(page, 'View directory', [
    {
      name: 'Contacts',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [{ Name: 'Morgan', Amount: 27 }],
    },
  ]);
  const source = await createDatabase(page, 'View planning', [
    {
      name: 'Projects',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Stage', type: 'singleSelect', choices: ['Open'] },
        { name: 'Due', type: 'date' },
        { name: 'Site', type: 'location' },
      ],
      records: [
        {
          Name: 'Harbor',
          Stage: 'Open',
          Due: '2026-10-02',
          Site: { lat: 47.6062, lng: -122.3321, label: 'Seattle' },
        },
        { Name: 'Empty links' },
      ],
    },
  ]);
  const projects = source.tables.Projects!;
  const contacts = target.tables.Contacts!;
  const linkId = newId('fld'),
    totalId = newId('fld'),
    parentId = newId('fld'),
    formulaId = newId('fld');
  await runCommands(page, source.id, [
    {
      kind: 'field.create',
      tableId: projects.id,
      field: { id: linkId, name: 'Contact', type: 'link', options: { linkedTableId: contacts.id } },
    },
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: totalId,
        name: 'Total',
        type: 'rollup',
        options: { linkFieldId: linkId, targetFieldId: contacts.fields.Amount, fn: 'sum' },
      },
    },
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: parentId,
        name: 'Parent',
        type: 'link',
        options: { linkedTableId: projects.id, oneWay: true },
      },
    },
    {
      kind: 'record.update',
      tableId: projects.id,
      records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
    },
  ]);
  await openTable(page, source, 'Projects');
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  await page.getByRole('button', { name: 'Create function', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name', exact: true }).fill('DOUBLE');
  await page.getByRole('textbox', { name: 'Parameters (comma separated)', exact: true }).fill('amount');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 2');
  await page.getByRole('button', { name: 'Save function', exact: true }).click();
  await runCommands(page, source.id, [
    {
      kind: 'field.create',
      tableId: projects.id,
      field: {
        id: formulaId,
        name: 'Doubled total',
        type: 'formula',
        options: { expression: `DOUBLE({${totalId}})` },
      },
    },
  ]);
  const viewIds = new Map<string, string>();
  for (const type of viewTypes)
    viewIds.set(
      type,
      await createView(page, source, 'Projects', {
        name: `Linked ${type}`,
        type,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'total', fieldId: totalId, operator: 'gt', value: 20 }],
          },
          sorts: [{ fieldId: totalId, direction: 'desc' }],
          groups: [{ fieldId: linkId, direction: 'asc' }],
          kanban: { stackFieldId: projects.fields.Stage },
          list: { groupFieldId: linkId },
          calendar: { startFieldId: projects.fields.Due },
          timeline: { startFieldId: projects.fields.Due, groupFieldId: linkId },
          gantt: { startFieldId: projects.fields.Due },
          map: { locationFieldId: projects.fields.Site },
          chart: { groupBy: { fieldId: linkId }, value: { fn: 'sum', fieldId: totalId } },
          pivot: { rows: [{ fieldId: linkId }], values: [{ fn: 'sum', fieldId: totalId }] },
          orgChart: { parentFieldId: parentId },
        },
      }),
    );
  await openTable(page, source, 'Projects');
  const containers: Record<string, string> = {
    grid: '.rio-grid-view',
    kanban: '.rio-kanban',
    gallery: '.rio-gallery-view',
    calendar: '.rio-calendar-view',
    form: '.rio-form-view',
    timeline: '.rio-timeline-chart',
    gantt: '.rio-gantt',
    chart: '.rio-chart-view',
    // The view and shared dashboard renderer each provide a layout wrapper around one table.
    pivot: '.rio-pivot__table',
    list: '.rio-list-view',
    map: '.rio-map-view',
    orgChart: '.rio-org-chart',
  };
  for (const type of viewTypes) {
    await page.getByRole('link', { name: `Linked ${type}`, exact: true }).click();
    const view = page.locator(containers[type]!);
    await expect(view).toBeVisible();
    if (['grid', 'kanban', 'gallery', 'list', 'orgChart'].includes(type)) {
      await expect(view).toContainText('Harbor');
      await expect(view).not.toContainText('Empty links');
    }
    const rows = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${viewIds.get(type)!}/rows`,
    );
    expect(rows.rows.map((row) => row.id)).toEqual([projects.records[0]]);
    expect(rows.rows[0]!.values[totalId]).toBe(27);
    expect(rows.rows[0]!.values[formulaId]).toBe(54);
  }
});

async function choose(page: Page, dialog: Locator, label: string, option: string) {
  await dialog.getByRole('button', { name: new RegExp(`${label}$`) }).click();
  await page.getByRole('option', { name: labelName(option), exact: true }).click();
}

test('creates lookups and conditional rollups from an external destination in the field dialog', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const target = await createDatabase(page, 'Directory 東京 🌊', [
    {
      name: 'Contacts مرحبا',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number' },
      ],
      records: [
        { Name: 'Morgan 東京 🌊', Amount: 17 },
        { Name: 'Taylor', Amount: 27 },
      ],
    },
  ]);
  const source = await createDatabase(page, 'Planning', [
    { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
  ]);
  const projects = source.tables.Projects!;
  const contacts = target.tables['Contacts مرحبا']!;
  const linkId = newId('fld');
  await runCommands(page, source.id, [
    {
      kind: 'field.create',
      tableId: projects.id,
      field: { id: linkId, name: 'Contact', type: 'link', options: { linkedTableId: contacts.id } },
    },
    {
      kind: 'record.update',
      tableId: projects.id,
      records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
    },
  ]);
  const grid = await openTable(page, source, 'Projects');
  for (const type of ['Lookup', 'Rollup']) {
    await openNewField(page);
    const dialog = page.getByRole('dialog', { name: 'New field' });
    await choose(page, dialog, 'Type', type);
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill(`${type} amount`);
    const label = type === 'Lookup' ? 'Field to look up' : 'Field to summarize';
    await expect(dialog.getByRole('button', { name: new RegExp(`${label}$`) })).toBeEnabled();
    await choose(page, dialog, label, 'Amount');
    if (type === 'Rollup') {
      await choose(page, dialog, 'Summary', 'Sum');
      await dialog.getByRole('button', { name: 'Add condition', exact: true }).click();
      const condition = dialog.getByRole('group', { name: 'Condition', exact: true });
      await choose(page, condition, 'Field', 'Amount');
      await choose(page, condition, 'Condition', '>');
      await condition.getByRole('textbox', { name: 'Value', exact: true }).fill('20');
    }
    await dialog.getByRole('button', { name: 'Create field' }).click();
    await expect(dialog).toBeHidden();
    await expect(grid.getByRole('columnheader', { name: `${type} amount`, exact: true })).toBeVisible();
  }
  await runCommands(page, source.id, [
    {
      kind: 'namedFunction.create',
      functionId: `fnc${newId('fld').slice(3)}`,
      definition: { name: 'DOUBLE', parameters: ['value'], body: 'value * 2' },
    },
  ]);
  await openNewField(page);
  const formula = page.getByRole('dialog', { name: 'New field' });
  await choose(page, formula, 'Type', 'Formula');
  await formula.getByRole('textbox', { name: 'Name', exact: true }).fill('Calculated total');
  await formula.getByRole('textbox', { name: 'Formula', exact: true }).fill('DOUBLE({Rollup amount})');
  await expect(formula.getByText('Result: Number')).toBeVisible();
  await formula.getByRole('button', { name: 'Create field', exact: true }).click();
  await expect(formula).toBeHidden();
  await grid
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
    .getByRole('button', { name: /^Expand row/ })
    .click();
  let card = page.getByRole('dialog', { name: 'Harbor', exact: true });
  await expect(card.getByRole('group', { name: 'Lookup amount', exact: true })).toContainText('17');
  await expect(card.getByRole('group', { name: 'Rollup amount', exact: true })).toHaveText('27');
  await expect(card.getByRole('group', { name: 'Calculated total', exact: true })).toHaveText('54');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  card = page.getByRole('dialog', { name: 'Harbor', exact: true });
  await expect(card.getByRole('group', { name: 'Rollup amount', exact: true })).toHaveText('27');
  const schema = await asOwner<{ fields: Array<{ name: string; options: { targetFieldId?: string } }> }>(
    page,
    'GET',
    `/api/databases/${source.id}/schema`,
  );
  expect(schema.fields.find((field) => field.name === 'Rollup amount')!.options.targetFieldId).toBe(
    contacts.fields.Amount,
  );
});

for (const oneWay of [true, false]) {
  for (const text of ['', 'Private contact']) {
    test(`converts a ${oneWay ? 'one-way' : 'paired'} external link to text and back with ${text ? 'a hidden destination' : 'cleared records'}`, async ({
      page,
      browser,
    }) => {
      test.setTimeout(120_000);
      await signIn(page);
      const person = await invite(page, browser, 'Conversion editor');
      try {
        const target = await createDatabase(page, 'Conversion directory', [
          {
            name: 'Contacts',
            fields: [{ name: 'Name', type: 'text' }],
            records: [{ Name: 'Morgan' }, { Name: 'Private contact' }],
          },
        ]);
        const source = await createDatabase(page, 'Conversion planning', [
          { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
        ]);
        const projects = source.tables.Projects!;
        const contacts = target.tables.Contacts!;
        const linkId = newId('fld');
        await runCommands(page, source.id, [
          {
            kind: 'field.create',
            tableId: projects.id,
            field: {
              id: linkId,
              name: 'Contact',
              type: 'link',
              options: { linkedTableId: contacts.id, oneWay },
            },
          },
          {
            kind: 'record.update',
            tableId: projects.id,
            records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
          },
        ]);
        await share(page, source.id, person, 'owner');
        await share(page, target.id, person, oneWay ? 'editor' : 'creator');
        await asOwner(page, 'PUT', `/api/tables/${contacts.id}/record-rules`, {
          rules: [
            {
              id: newId('rul'),
              roles: [oneWay ? 'editor' : 'creator'],
              users: [],
              condition: {
                conjunction: 'and',
                conditions: [
                  { id: 'visible', fieldId: contacts.fields.Name, operator: 'is', value: 'Morgan' },
                ],
              },
            },
          ],
        });
        const grid = await openTable(person.page, source, 'Projects');
        async function edit() {
          await grid.getByRole('columnheader', { name: 'Contact', exact: true }).click({ button: 'right' });
          await person.page.getByRole('menuitem', { name: labelName('Edit field'), exact: true }).click();
          return person.page.getByRole('dialog', { name: 'Edit field' });
        }
        let dialog = await edit();
        await choose(person.page, dialog, 'Type', 'Text');
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toBeHidden();
        const converted = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${projects.id}/records/${projects.records[0]}`,
        );
        expect(converted.values[linkId]).toBe('Morgan');
        await expect(grid.getByRole('gridcell', { name: 'Morgan', exact: true })).toBeVisible();
        await runCommands(person.page, source.id, [
          {
            kind: 'record.update',
            tableId: projects.id,
            records: [{ id: projects.records[0], values: { [linkId]: text } }],
          },
        ]);
        dialog = await edit();
        await choose(person.page, dialog, 'Type', 'Link to another record');
        await choose(person.page, dialog, 'Link to', 'Contacts');
        if (text) {
          const preview = await asOwner<{ converted: number; emptied: number }>(
            person.page,
            'POST',
            `/api/fields/${linkId}/conversion-preview`,
            {
              to: { type: 'link', options: { linkedTableId: contacts.id, oneWay } },
              dateOrder: 'mdy',
              timeZone: 'UTC',
            },
          );
          expect(preview).toMatchObject({ converted: 0, emptied: 1 });
        }
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toBeHidden();
        await grid
          .getByRole('row')
          .filter({ has: person.page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
          .getByRole('button', { name: /^Expand row/ })
          .click();
        let card = person.page.getByRole('dialog', { name: 'Harbor', exact: true });
        await expect(card.getByRole('button', { name: 'Morgan', exact: true })).toHaveCount(0);
        const stored = await asOwner<{ values: Record<string, unknown> }>(
          page,
          'GET',
          `/api/tables/${projects.id}/records/${projects.records[0]}`,
        );
        expect(stored.values[linkId]).toEqual([]);
        await person.page.setViewportSize({ width: 390, height: 844 });
        await person.page.reload();
        card = person.page.getByRole('dialog', { name: 'Harbor', exact: true });
        await expect(card.getByRole('button', { name: 'Morgan', exact: true })).toHaveCount(0);
        await card.getByRole('button', { name: 'Link a record', exact: true }).press('Enter');
        await expect(card.getByRole('option', { name: labelName('Morgan'), exact: true })).toBeVisible();
        await card.getByRole('searchbox').press('Enter');
        await expect(card.getByRole('button', { name: 'Morgan', exact: true })).toBeVisible();
      } finally {
        await person.context.close();
      }
    });
  }
}

for (const failure of ['server', 'connection'] as const) {
  test(`recovers from an external field metadata ${failure} error`, async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    const target = await createDatabase(page, `Unavailable directory ${failure}`, [
      {
        name: 'Contacts',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Amount', type: 'number' },
        ],
      },
    ]);
    const source = await createDatabase(page, `Unavailable planning ${failure}`, [
      { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
    ]);
    await runCommands(page, source.id, [
      {
        kind: 'field.create',
        tableId: source.tables.Projects!.id,
        field: {
          id: newId('fld'),
          name: 'Contact',
          type: 'link',
          options: { linkedTableId: target.tables.Contacts!.id },
        },
      },
    ]);
    await openTable(page, source, 'Projects');
    if (failure === 'connection') await page.setViewportSize({ width: 390, height: 844 });
    const address = `**/api/databases/${target.id}/schema`;
    await page.route(address, async (route) => {
      if (failure === 'connection') await route.abort('connectionfailed');
      else
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'unavailable', messageKey: 'errors.offline', userFault: false },
          }),
        });
    });
    await openNewField(page);
    let dialog = page.getByRole('dialog', { name: 'New field' });
    await choose(page, dialog, 'Type', 'Lookup');
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.unroute(address);
    await openNewField(page);
    dialog = page.getByRole('dialog', { name: 'New field' });
    await choose(page, dialog, 'Type', 'Lookup');
    await choose(page, dialog, 'Field to look up', 'Amount');
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Recovered amount');
    await dialog.getByRole('button', { name: 'Create field', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    const grid = page.getByRole('grid');
    await grid
      .getByRole('row')
      .filter({ has: page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
      .getByRole('button', { name: /^Expand row/ })
      .click();
    await expect(
      page
        .getByRole('dialog', { name: 'Harbor', exact: true })
        .getByRole('group', { name: 'Recovered amount', exact: true }),
    ).toBeVisible();
  });
}

test('updates external derived values live for another person through edits, trash, restore, and sharing', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const person = await invite(page, browser, 'Live reader');
  try {
    const target = await createDatabase(page, 'Live directory', [
      {
        name: 'Contacts',
        fields: [
          { name: 'Name', type: 'text' },
          { name: 'Amount', type: 'number' },
        ],
        records: [{ Name: 'Morgan', Amount: 17 }],
      },
    ]);
    const source = await createDatabase(page, 'Live planning', [
      { name: 'Projects', fields: [{ name: 'Name', type: 'text' }], records: [{ Name: 'Harbor' }] },
    ]);
    const projects = source.tables.Projects!;
    const contacts = target.tables.Contacts!;
    const linkId = newId('fld');
    await runCommands(page, source.id, [
      {
        kind: 'field.create',
        tableId: projects.id,
        field: { id: linkId, name: 'Contact', type: 'link', options: { linkedTableId: contacts.id } },
      },
      {
        kind: 'field.create',
        tableId: projects.id,
        field: {
          id: newId('fld'),
          name: 'Total',
          type: 'rollup',
          options: { linkFieldId: linkId, targetFieldId: contacts.fields.Amount, fn: 'sum' },
        },
      },
      {
        kind: 'record.update',
        tableId: projects.id,
        records: [{ id: projects.records[0], values: { [linkId]: contacts.records } }],
      },
    ]);
    await share(page, source.id, person, 'reader');
    await share(page, target.id, person, 'reader');
    await person.page.setViewportSize({ width: 390, height: 844 });
    const sourceGrid = await openTable(person.page, source, 'Projects');
    await sourceGrid
      .getByRole('row')
      .filter({ has: person.page.getByRole('gridcell', { name: 'Harbor', exact: true }) })
      .getByRole('button', { name: /^Expand row/ })
      .click();
    const card = person.page.getByRole('dialog', { name: 'Harbor', exact: true });
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('17');
    let releaseSchema!: () => void;
    const waitingSchema = new Promise<void>((resolve) => {
      releaseSchema = resolve;
    });
    const schemaAddress = `**/api/databases/${target.id}/schema`;
    await page.route(schemaAddress, async (route) => {
      await waitingSchema;
      await route.continue();
    });
    const openingTarget = openTable(page, target, 'Contacts');
    try {
      await expect(page.getByRole('group', { name: 'Loading record', exact: true })).toHaveAttribute(
        'aria-busy',
        'true',
      );
    } finally {
      releaseSchema();
    }
    const targetGrid = await openingTarget;
    await page.unroute(schemaAddress);
    await targetGrid.getByRole('gridcell', { name: '17', exact: true }).dblclick();
    const input = page.locator('.rio-grid__input');
    await input.fill('invalid');
    await input.press('Enter');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await input.press('Escape');
    await targetGrid.getByRole('gridcell', { name: '17', exact: true }).dblclick();
    await input.fill('27');
    await input.press('Enter');
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('27');
    await targetGrid.getByRole('gridcell', { name: 'Morgan', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: labelName('Delete record'), exact: true }).click();
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('0');
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    const trash = page.getByRole('dialog', { name: 'Trash', exact: true });
    await trash.getByRole('button', { name: '1 deleted record in Contacts', exact: true }).click();
    await trash.getByRole('button', { name: 'Restore Morgan', exact: true }).click();
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('27');
    await page.keyboard.press('Escape');
    await asOwner(page, 'DELETE', `/api/databases/${target.id}/grants`, {
      principal: { kind: 'user', id: person.id },
    });
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveCount(0);
    await share(page, target.id, person, 'reader');
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('27');
    await person.page.reload();
    await expect(card.getByRole('group', { name: 'Total', exact: true })).toHaveText('27');
  } finally {
    await person.context.close();
  }
});
