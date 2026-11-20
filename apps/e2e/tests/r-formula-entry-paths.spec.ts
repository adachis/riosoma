import { openNewField } from '../grid-fields';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { asOwner, createDatabase, newId, openTable, runCommands, signIn, visit } from '../helpers';
import { invite, share } from '../people';

test.use({ serviceWorkers: 'block' });

test('a phone loading a formula database exposes its labeled loading group', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const database = await createDatabase(page, 'Loading formulas', [
    { name: 'Orders', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/databases/${database.id}/schema`, async (route) => {
    const response = await route.fetch();
    await blocked;
    await route.fulfill({ response });
  });
  const table = database.tables.Orders!;
  try {
    await visit(page, `${base()}/${database.id}/${table.id}/${table.viewId}`, { waitForAppLoaded: false });
    const loading = page.getByRole('group', { name: 'Loading record', exact: true });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('aria-busy', 'true');
  } finally {
    release();
  }
  await expect(page.getByRole('grid', { name: 'Grid', exact: true })).toBeVisible();
});

test('a full function list remains usable with list parameters and keyboard navigation on a phone', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signIn(page);
  const choices = ['漢字', 'مرحبا', '😀'].map((name) => ({ id: newId('cho'), name, color: 'blue' }));
  const database = await createDatabase(page, 'Function catalog', [
    {
      name: 'Items',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Tags', type: 'multipleSelect', options: { choices } },
      ],
      records: [{ Name: 'List values', Tags: choices.map((choice) => choice.id) }],
    },
  ]);
  await runCommands(page, database.id, [
    ...Array.from({ length: 99 }, (_, index) => ({
      kind: 'namedFunction.create',
      functionId: newId('fnc'),
      definition: { name: `FUNCTION_${index}`, parameters: [], body: String(index) },
    })),
    {
      kind: 'namedFunction.create',
      functionId: newId('fnc'),
      definition: { name: 'JOIN_VALUES', parameters: ['values'], body: 'ARRAYJOIN(values, " / ")' },
    },
  ]);
  await openTable(page, database, 'Items');
  await openNewField(page);
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await dialog.getByRole('button', { name: /Type/ }).click();
  await page.getByRole('option', { name: 'Formula', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Joined tags');
  const formula = dialog.getByRole('textbox', { name: 'Formula', exact: true });
  await formula.fill('JOIN');
  await formula.press('ArrowDown');
  await formula.press('Enter');
  await expect(formula).toHaveValue('JOIN_VALUES(');
  await formula.fill('JOIN_VALUES({Tags})');
  await expect(dialog.getByText('Result: Text', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Create field', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('gridcell', { name: '漢字 / مرحبا / 😀', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('link', { name: 'Named functions', exact: true }).click();
  const functions = page.getByRole('navigation', { name: 'Functions', exact: true });
  await expect(functions.getByRole('button')).toHaveCount(100);
  const last = functions.getByRole('button', { name: 'JOIN_VALUES(values)', exact: true });
  await last.focus();
  await last.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Formula', exact: true })).toHaveValue(
    'ARRAYJOIN(values, " / ")',
  );
  const link = page.url();
  await visit(page, link);
  await expect(page.getByRole('textbox', { name: 'Function name' })).toHaveValue('JOIN_VALUES');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Create function', exact: true }).click();
  await page.getByRole('textbox', { name: 'Function name' }).fill('OVER_LIMIT');
  await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('1');
  await expect(page.getByRole('button', { name: 'Save function', exact: true })).toBeDisabled();
});

test('an editor receives locked defaults on creation while explicit changes remain refused', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Locked defaults', [
    {
      name: 'Tasks',
      fields: [
        { name: 'Name', type: 'text', options: { defaultValue: { kind: 'value', value: 'New task' } } },
        {
          name: 'Status',
          type: 'text',
          options: { defaultValue: { kind: 'value', value: 'Pending' }, validation: { required: {} } },
        },
      ],
      records: [{ Name: 'Existing', Status: 'Existing status' }],
    },
  ]);
  const table = database.tables.Tasks!;
  await asOwner(page, 'PUT', `/api/fields/${table.fields.Status}/permissions`, {
    restricted: null,
    locked: { roles: [], users: [] },
  });
  const editor = await invite(page, browser, 'Default editor');
  try {
    await share(page, database.id, editor, 'editor');
    await editor.page.setViewportSize({ width: 390, height: 844 });
    const grid = await openTable(editor.page, database, 'Tasks');
    const addRecord = async () => {
      // Defaults appear optimistically, so a persisted read waits for the create command to commit.
      const saved = editor.page.waitForResponse(
        (response) =>
          response.url().endsWith(`/api/databases/${database.id}/commands`) &&
          response.request().method() === 'POST' &&
          response
            .request()
            .postDataJSON()
            .commands.some(
              (command: { kind: string; tableId?: string }) =>
                command.kind === 'record.create' && command.tableId === table.id,
            ),
      );
      await grid.getByRole('button', { name: 'Add record', exact: true }).click();
      const response = await saved;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ results: [{ status: 'applied' }] });
    };
    await addRecord();
    await expect(grid.getByRole('gridcell', { name: 'Pending', exact: true })).toBeVisible();
    const rows = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?refresh=1`,
    );
    const created = rows.rows.find((row) => row.values[table.fields.Name!] === 'New task');
    expect(created).toMatchObject({
      values: { [table.fields.Name!]: 'New task', [table.fields.Status!]: 'Pending' },
    });
    const refused = await asOwner(editor.page, 'POST', `/api/databases/${database.id}/commands`, {
      clientId: newId('cli'),
      commands: [
        {
          id: newId('cmd'),
          groupId: newId('act'),
          kind: 'record.update',
          tableId: table.id,
          records: [{ id: created!.id, values: { [table.fields.Status!]: 'Changed' } }],
        },
      ],
    });
    expect(refused).toMatchObject({
      results: [{ status: 'rejected', error: { messageKey: 'data.access.fieldLocked' } }],
    });
    await visit(editor.page, editor.page.url());
    await expect(grid.getByRole('gridcell', { name: 'Pending', exact: true })).toBeVisible();
    await grid
      .getByRole('row')
      .filter({ has: editor.page.getByRole('gridcell', { name: 'New task', exact: true }) })
      .getByRole('button', { name: /^Expand row/ })
      .click();
    const card = editor.page.getByRole('dialog', { name: 'New task', exact: true });
    await expect(card.getByRole('textbox', { name: 'Status', exact: true })).toHaveCount(0);
    await expect(card.getByRole('group', { name: 'Status', exact: true })).toHaveText('Pending');
    await runCommands(page, database.id, [
      {
        kind: 'field.update',
        fieldId: table.fields.Status,
        options: { defaultValue: { kind: 'value', value: 'Review' }, validation: { required: {} } },
      },
    ]);
    await expect(card.getByRole('group', { name: 'Status', exact: true })).toHaveText('Pending');
    await editor.page.keyboard.press('Escape');
    await addRecord();
    await expect(grid.getByRole('gridcell', { name: 'Review', exact: true })).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: 'Existing status', exact: true })).toBeVisible();
  } finally {
    await editor.context.close();
  }
});

test('Rio creates a named-call formula and defaulted records that follow later function edits', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await signIn(page);
  const database = await createDatabase(page, 'Proposed formulas', [
    {
      name: 'Orders',
      fields: [
        { name: 'Name', type: 'text' },
        { name: 'Amount', type: 'number', options: { defaultValue: { kind: 'value', value: 7 } } },
      ],
      records: [{ Name: 'Existing', Amount: 3 }],
    },
  ]);
  const table = database.tables.Orders!;
  await runCommands(page, database.id, [
    {
      kind: 'namedFunction.create',
      functionId: newId('fnc'),
      definition: { name: 'DOUBLE', parameters: ['amount'], body: 'amount * 2' },
    },
  ]);
  const total = newId('fld');
  let proposed = false;
  const receiver = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on('end', () => {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ models: [{ name: 'fixture' }], data: [{ id: 'fixture' }] }));
        return;
      }
      JSON.parse(body);
      const delta = proposed
        ? { content: 'The formula and record are saved.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: {
                  name: 'propose_changes',
                  arguments: JSON.stringify({
                    databaseId: database.id,
                    summary: 'Add the total and a new order',
                    steps: ['Add the formula field', 'Add the order'],
                    commands: [
                      {
                        kind: 'field.create',
                        tableId: table.id,
                        field: {
                          id: total,
                          name: 'Total',
                          type: 'formula',
                          options: { expression: `DOUBLE({${table.fields.Amount}})` },
                        },
                      },
                      {
                        kind: 'record.create',
                        tableId: table.id,
                        records: [{ values: { [table.fields.Name!]: 'Proposed order' } }],
                      },
                    ],
                  }),
                },
              },
            ],
          };
      const finish = proposed ? 'stop' : 'tool_calls';
      proposed = true;
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, resolve));
  try {
    const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
      page,
      'GET',
      '/api/ai/settings',
    );
    const providerId = settings.providers.find((entry) => entry.local)!.providerId;
    const port = (receiver.address() as AddressInfo).port;
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [{ providerId, baseUrl: `http://${new URL(base()).hostname}:${port}/v1` }],
      models: { everyday: { providerId, model: 'fixture' }, power: null },
      autonomy: 'instant',
      monthlyBudgetUsd: null,
    });
    const grid = await openTable(page, database, 'Orders');
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Rio', exact: true });
    const input = panel.getByRole('textbox', { name: 'Ask Rio anything about your data' });
    await input.fill('Add a Total formula using DOUBLE and an order with the default amount');
    await input.press('Enter');
    await expect(panel.getByText('The formula and record are saved.', { exact: true })).toBeVisible();
    const added = grid.getByRole('gridcell', { name: '14', exact: true });
    const prompt = page.getByRole('button', { name: '1 new record', exact: true });
    // A snapshot opened after the commit already includes the new record.
    await expect(added.or(prompt)).toBeVisible();
    if (await prompt.isVisible()) await prompt.click();
    await expect(grid.getByRole('gridcell', { name: '14', exact: true })).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: '6', exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Named functions', exact: true }).click();
    await page.getByRole('button', { name: 'DOUBLE(amount)', exact: true }).click();
    await page.getByRole('textbox', { name: 'Formula', exact: true }).fill('amount * 3');
    await page.getByRole('button', { name: 'Save function', exact: true }).click();
    await openTable(page, database, 'Orders');
    await expect(grid.getByRole('gridcell', { name: '21', exact: true })).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: '9', exact: true })).toBeVisible();
  } finally {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
  }
});
