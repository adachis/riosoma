import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../accessibility';
import { base } from '../base';
import { labelName, asOwner, createDatabase, newId, openTable, runCommands, signIn } from '../helpers';
import { invite, share } from '../people';
import { connection, sql } from '../sql';

test.use({ serviceWorkers: 'block' });

/** Each source reads only the outside tables made for its test in the suite's PostgreSQL server. */
async function source(page: Page, schema: string, name: string): Promise<{ id: string }> {
  const { password: _password, ...address } = connection();
  return asOwner(page, 'POST', '/api/sources', {
    name,
    access: 'creators',
    connection: { kind: 'postgres', ...address, schema, tls: { mode: 'disable' } },
    secrets: { password: randomBytes(24).toString('hex') },
  });
}

async function wizard(page: Page, name: string, object: string, schema: string): Promise<Locator> {
  const database = await createDatabase(page, `Source sweep ${object}`, [
    { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
  ]);
  await openTable(page, database, 'Notes');
  const menu = page.getByRole('button', { name: 'Menu', exact: true });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Add a table' }).click();
  await page.getByRole('menuitem', { name: 'Sync from a data source' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sync from a data source' });
  await dialog.getByRole('button', { name: /Choose a data source/ }).click();
  await page.getByRole('option', { name: labelName(name), exact: true }).click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  const search = dialog.getByLabel('Search tables and views', { exact: true });
  await search.fill(object);
  await search.press('Enter');
  await expect(dialog.getByRole('heading', { name: 'Choose what to sync' })).toBeVisible();
  await dialog
    .getByRole('group', { name: schema, exact: true })
    .getByRole('option', { name: labelName(object), exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByRole('group', { name: 'Key columns' })).toBeVisible();
  return dialog;
}

async function readFailureHistory(page: Page, tableId: string) {
  const token = await asOwner<{ id: string; token: string }>(page, 'POST', '/api/tokens', {
    name: 'Source history checks',
    scopes: ['data.records:read'],
    databases: [new URL(page.url()).pathname.split('/')[1]],
  });
  const headers = { authorization: `Bearer ${token.token}` };
  const require = createRequire(new URL('../../server/package.json', import.meta.url));
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as {
    Client: new (info: { name: string; version: string }) => {
      connect(transport: unknown): Promise<void>;
      callTool(input: { name: string; arguments: object }): Promise<{
        isError?: boolean;
        structuredContent?: unknown;
      }>;
      close(): Promise<void>;
    };
  };
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as {
    StreamableHTTPClientTransport: new (
      address: URL,
      options: { requestInit: { headers: object } },
    ) => unknown;
  };
  const client = new Client({ name: 'source-history-checks', version: '1.0.0' });
  try {
    const rest = await page.request.get(`${base()}/api/v1/tables/${tableId}/sync-history`, { headers });
    expect(rest.ok()).toBe(true);
    expect(await rest.json()).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ outcome: 'failed', errorKey: 'sources.sync.columnMissing' }),
      ]),
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base()}/mcp`), { requestInit: { headers } }),
    );
    const history = await client.callTool({ name: 'get_sync_history', arguments: { tableId } });
    expect(history.isError).not.toBe(true);
    expect(history.structuredContent).toMatchObject({
      runs: expect.arrayContaining([
        expect.objectContaining({ outcome: 'failed', errorKey: 'sources.sync.columnMissing' }),
      ]),
    });
  } finally {
    await client.close();
    await asOwner(page, 'DELETE', `/api/tokens/${token.id}`);
  }
}

async function askAboutFailure(page: Page, tableId: string) {
  let history = '';
  const server = createServer((request, response) => {
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
      const input = JSON.parse(body) as { messages: Array<{ role: string; content?: string }> };
      const tool = input.messages.findLast((message) => message.role === 'tool');
      if (tool) history = tool.content ?? '';
      const delta = tool
        ? { content: 'The source column is missing.' }
        : {
            tool_calls: [
              {
                index: 0,
                id: randomUUID(),
                type: 'function',
                function: { name: 'get_history', arguments: JSON.stringify({ tableId }) },
              },
            ],
          };
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = await asOwner<{ providers: Array<{ providerId: string; local: boolean }> }>(
      page,
      'GET',
      '/api/ai/settings',
    );
    const providerId = settings.providers.find((provider) => provider.local)!.providerId;
    await asOwner(page, 'PUT', '/api/ai/settings', {
      enabled: true,
      providers: [
        {
          providerId,
          baseUrl: `http://${new URL(base()).hostname}:${(server.address() as AddressInfo).port}/v1`,
        },
      ],
      models: { everyday: { providerId, model: 'fixture' }, power: null },
      autonomy: 'ask',
      monthlyBudgetUsd: null,
    });
    await page.reload();
    await page.getByRole('button', { name: 'AI: Ask Rio', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Ask Rio anything about your data' })
      .fill('Explain the last sync failure');
    await page.getByRole('textbox', { name: 'Ask Rio anything about your data' }).press('Enter');
    await expect(page.getByText('The source column is missing.', { exact: true })).toBeVisible();
    expect(history).toContain('sources.sync.columnMissing');
  } finally {
    await asOwner(page, 'PUT', '/api/ai/settings', { enabled: false });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

for (const width of [1200, 390]) {
  test(`explains the field limit for a wide source and continues at width ${width}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page);
    const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
    const object = 'wide_items';
    await sql(`CREATE SCHEMA "${schema}";
      CREATE TABLE "${schema}"."${object}" (id integer PRIMARY KEY, ${Array.from({ length: 500 }, (_, index) => `"Field ${index}" text`).join(', ')});`);
    try {
      // Repeated runs keep their source records, so each exact option name must be unique.
      const name = `Wide source ${width} ${randomBytes(4).toString('hex')}`;
      await source(page, schema, name);
      const dialog = await wizard(page, name, object, schema);
      await expect(dialog.getByRole('button', { name: 'Next' })).toBeDisabled();
      await expect(dialog.getByRole('alert')).toContainText(
        'Choose up to 500 fields to create this table.  Clear some selections to continue.',
      );
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await dialog.locator('.rio-synced-column').count()).toBeLessThan(20);
      const editors = dialog.getByRole('region', { name: 'Choose fields', exact: true });
      await editors.focus();
      await page.keyboard.press('End');
      await expect(dialog.getByRole('group', { name: 'Field 499', exact: true })).toBeInViewport();
      await dialog.getByRole('searchbox', { name: 'Search fields', exact: true }).fill('Field 499');
      await dialog.getByText('Include Field 499', { exact: true }).click();
      await expect(
        dialog.getByRole('checkbox', { name: 'Include Field 499', exact: true }),
      ).not.toBeChecked();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      if (width === 1200) {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('checkbox', { name: 'Include Field 499', exact: true }),
        ).not.toBeChecked();
      }
      await dialog.getByRole('button', { name: 'Next' }).click();
      await expect(dialog.getByRole('textbox', { name: 'Table name' })).toHaveValue(object);
      await dialog.getByRole('button', { name: 'Create synced table', exact: true }).click();
      await expect(dialog).toBeHidden();
      const navigation = page.getByRole('dialog', { name: 'Menu', exact: true });
      if (await navigation.isVisible()) await navigation.press('Escape');
      await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.getByText(`Synced from ${name}`)).toBeVisible();
      const scrolling = page.locator('.rio-grid__scroller');
      await scrolling.focus();
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => scrolling.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    } finally {
      await sql(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
}

test('explains a missing PostgreSQL database and checks the repaired connection', async ({ page }) => {
  await signIn(page);
  const address = connection();
  await page.goto(`${base()}/settings/sources?source=new&kind=postgres`);
  const dialog = page.getByRole('dialog', { name: 'Add a data source' });
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Outside PostgreSQL');
  await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill(address.host);
  await dialog.getByRole('textbox', { name: 'Port', exact: true }).fill(String(address.port));
  await dialog
    .getByRole('textbox', { name: 'Database', exact: true })
    .fill(`missing_timeout_${randomBytes(8).toString('hex')}`);
  await dialog.getByRole('textbox', { name: 'User', exact: true }).fill(address.user);
  await dialog
    .getByLabel('Password', { exact: true })
    .and(dialog.locator('input'))
    .fill(randomBytes(24).toString('hex'));
  await dialog.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('button', { name: /Secure connection/ }).click();
  await page.getByRole('option', { name: labelName('Off'), exact: true }).click();
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(
    dialog.getByText('The database could not be found.  Check the database name.', { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Database', exact: true }).fill(address.database);
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(dialog.getByText(/Connected to PostgreSQL/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  const saved = page
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Outside PostgreSQL', exact: true }) });
  await saved.getByRole('button', { name: 'Edit Outside PostgreSQL', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Outside PostgreSQL' });
  await expect(edit.getByText('Stored', { exact: true })).toBeVisible();
  await expect(edit.getByLabel('Password', { exact: true }).and(edit.locator('input'))).toHaveCount(0);
  await edit.getByRole('button', { name: 'Replace', exact: true }).first().click();
  await edit
    .getByLabel('Password', { exact: true })
    .and(edit.locator('input'))
    .fill(randomBytes(24).toString('hex'));
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeHidden();
  await saved.getByRole('button', { name: 'Edit Outside PostgreSQL', exact: true }).click();
  await expect(edit.getByText('Stored', { exact: true })).toBeVisible();
  await expect(edit.getByLabel('Password', { exact: true }).and(edit.locator('input'))).toHaveCount(0);
  await edit.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(edit.getByText(/Connected to PostgreSQL/)).toBeVisible();
});

test('names a renamed source column, preserves the copy, and retries after the column returns', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  // Earlier sync specs retain outside objects, so this column-rename check owns its names.
  const object = `column_rename_vessels_${randomBytes(4).toString('hex')}`;
  const sourceName = `Port registry ${schema}`;
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}"."${object}" (id integer PRIMARY KEY, name text, port text);
    INSERT INTO "${schema}"."${object}" VALUES (1, '海鳥🚢', 'مرفأ');`);
  try {
    await source(page, schema, sourceName);
    const dialog = await wizard(page, sourceName, object, schema);
    await expect(dialog.getByRole('table', { name: 'Preview' })).toContainText('海鳥🚢');
    await expect(
      dialog.getByRole('group', { name: 'Key columns' }).getByRole('checkbox', { name: 'id', exact: true }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByRole('button', { name: /Every hour Sync/ }).click();
    await page.getByRole('option', { name: 'Only when asked' }).click();
    await dialog.getByRole('button', { name: 'Create synced table' }).click();
    await expect(dialog).toBeHidden();
    const grid = page.getByRole('grid', { name: 'Grid' });
    await expect(grid.getByRole('gridcell', { name: 'مرفأ', exact: true })).toBeVisible({ timeout: 45_000 });
    await sql(`ALTER TABLE "${schema}"."${object}" RENAME COLUMN port TO harbor`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByText('The source no longer has the column port.', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(grid.getByRole('gridcell', { name: 'مرفأ', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByText('The source no longer has the column port.', { exact: true })).toBeVisible();
    await expect(page.getByText('The source no longer has the column port.', { exact: true })).toBeInViewport(
      {
        ratio: 1,
      },
    );
    await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.reload();
    await expect(page.getByText('The source no longer has the column port.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sync history', exact: true }).click();
    await expect(page).toHaveURL(/dataPanel=sync-history/);
    await expect(page.getByRole('dialog', { name: 'Sync history' })).toContainText('Failed');
    await expect(page.getByRole('dialog', { name: 'Sync history' })).toContainText(
      'A column used by this table is missing from the source.',
    );
    await readFailureHistory(page, new URL(page.url()).pathname.split('/')[2]!);
    await page
      .getByRole('dialog', { name: 'Sync history' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await askAboutFailure(page, new URL(page.url()).pathname.split('/')[2]!);
    await page.reload();
    await sql(`ALTER TABLE "${schema}"."${object}" RENAME COLUMN harbor TO port`);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(page.getByText('The source no longer has the column port.', { exact: true })).toHaveCount(0);
    const sources = await asOwner<Array<{ id: string; name: string }>>(page, 'GET', '/api/sources');
    const saved = sources.find((item) => item.name === sourceName)!;
    const checked = await asOwner<{ ok: boolean }>(page, 'POST', `/api/sources/${saved.id}/test`);
    expect(checked.ok).toBe(true);
    expect(page.url().startsWith(base())).toBe(true);
  } finally {
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('shares overrides, clears matching values, holds row drops, and preserves returning records', async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".items (id integer PRIMARY KEY, name text, port text);
    INSERT INTO "${schema}".items SELECT n, 'Vessel ' || n, 'Source port ' || n FROM generate_series(1, 25) n;`);
  const editor = await invite(page, browser, 'Source editor');
  try {
    const remote = await source(page, schema, 'Fleet source');
    const database = await createDatabase(page, 'Fleet sync', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const table = {
      id: newId('tbl'),
      viewId: newId('viw'),
      fields: { Name: newId('fld'), ID: newId('fld'), Port: newId('fld'), Note: newId('fld') },
      choices: {},
      records: [],
    };
    await runCommands(page, database.id, [
      {
        kind: 'table.create',
        table: {
          id: table.id,
          name: 'Vessels',
          fields: [
            {
              id: table.fields.Name,
              name: 'Name',
              type: 'text',
              source: { column: 'name', sourceType: 'text' },
            },
            {
              id: table.fields.ID,
              name: 'ID',
              type: 'number',
              source: { column: 'id', sourceType: 'integer' },
            },
            {
              id: table.fields.Port,
              name: 'Port',
              type: 'text',
              source: { column: 'port', sourceType: 'text' },
            },
            { id: table.fields.Note, name: 'Note', type: 'text' },
          ],
          view: { id: table.viewId, name: 'Grid' },
          source: {
            sourceId: remote.id,
            select: { kind: 'object', object: { schema, name: 'items' } },
            keyColumns: ['id'],
            everyMinutes: null,
          },
        },
      },
    ]);
    database.tables.Vessels = table;
    const grid = await openTable(page, database, 'Vessels');
    await expect(grid.getByRole('gridcell', { name: 'Source port 1', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await share(page, database.id, editor, 'editor');
    const other = await openTable(editor.page, database, 'Vessels');
    await expect(other.getByRole('gridcell', { name: 'Source port 1', exact: true })).toBeVisible();
    await expect(editor.page.getByRole('button', { name: 'Sync now', exact: true })).toHaveCount(0);
    await other.getByRole('gridcell', { name: 'Source port 1', exact: true }).click();
    await editor.page.keyboard.type('Porto');
    await editor.page.keyboard.press('Enter');
    const pinned = grid.getByRole('gridcell', { name: 'Porto', exact: true });
    await expect(pinned).toHaveAccessibleDescription('Changed here.  The source says Source port 1.');
    await pinned.click({ button: 'right' });
    await page.getByRole('menuitem', { name: labelName('Use the source value'), exact: true }).click();
    await expect(other.getByRole('gridcell', { name: 'Source port 1', exact: true })).toBeVisible();
    await grid.getByRole('gridcell', { name: 'Source port 1', exact: true }).click();
    await page.keyboard.type('Porto');
    await page.keyboard.press('Enter');
    await expect(pinned).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(grid.getByRole('gridcell', { name: 'Source port 1', exact: true })).toBeVisible();
    await expect(other.getByRole('gridcell', { name: 'Source port 1', exact: true })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(pinned).toBeVisible();
    await expect(other.getByRole('gridcell', { name: 'Porto', exact: true })).toBeVisible();
    const read = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    const first = read.rows.find((row) => row.values[table.fields.Name] === 'Vessel 1')!;
    await runCommands(page, database.id, [
      {
        kind: 'record.update',
        tableId: table.id,
        records: [{ id: first.id, values: { [table.fields.Note]: 'Local note' } }],
      },
      {
        kind: 'view.update',
        viewId: table.viewId,
        config: {
          filter: {
            conjunction: 'and',
            conditions: [{ id: 'port', fieldId: table.fields.Port, operator: 'is', value: 'Porto' }],
          },
          sorts: [{ fieldId: table.fields.Port, direction: 'desc' }],
        },
      },
    ]);
    await expect(grid.getByRole('gridcell', { name: 'Porto', exact: true })).toBeVisible();
    const filtered = await asOwner<{ total: number }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    expect(filtered.total).toBe(1);
    const exported = await page.request.get(
      `${base()}/api/views/${table.viewId}/export?format=csv&timeZone=UTC&locale=en-US`,
    );
    expect(exported.ok()).toBe(true);
    expect(await exported.text()).toContain('Porto');
    await runCommands(page, database.id, [
      { kind: 'view.update', viewId: table.viewId, config: { filter: null, sorts: [] } },
    ]);
    await sql(`UPDATE "${schema}".items SET port = 'Porto' WHERE id = 1;
      ALTER TABLE "${schema}".items ADD COLUMN extra text;`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(pinned).toHaveAccessibleDescription('');
    const caughtUp = await asOwner<{ rows: Array<{ id: string; overrides?: object }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    expect(caughtUp.rows.find((row) => row.id === first.id)?.overrides).toBeUndefined();
    await sql(`DELETE FROM "${schema}".items WHERE id > 4`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByText('This sync would remove 21 of 25 records.', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    const held = await asOwner<{ total: number }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    expect(held.total).toBe(25);
    await page.getByRole('button', { name: 'Remove them', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Remove 21 records?' });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('This sync would remove 21 of 25 records.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Remove them', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Remove them', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    const reduced = await asOwner<{ total: number }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    expect(reduced.total).toBe(4);
    const history = await asOwner<{ entries: unknown[] }>(
      page,
      'GET',
      `/api/tables/${table.id}/records/${first.id}/history`,
    );
    expect(JSON.stringify(history)).toContain('Source port 1');
    expect(JSON.stringify(history)).toContain('Porto');
    await sql(
      `INSERT INTO "${schema}".items (id, name, port) SELECT n, 'Vessel ' || n, 'Source port ' || n FROM generate_series(5, 25) n;`,
    );
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    const returned = await asOwner<{
      total: number;
      rows: Array<{ id: string; values: Record<string, unknown> }>;
    }>(page, 'GET', `/api/views/${table.viewId}/rows?offset=0&limit=100`);
    expect(returned.total).toBe(25);
    expect(returned.rows.map((row) => row.id)).toEqual(read.rows.map((row) => row.id));
    expect(returned.rows.find((row) => row.id === first.id)?.values[table.fields.Note]).toBe('Local note');
    await sql(`ALTER TABLE "${schema}".items ALTER COLUMN port TYPE integer USING id + 1000`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: '1001', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(grid.getByRole('gridcell', { name: 'Local note', exact: true })).toBeVisible();
    const changedType = await asOwner<{ rows: Array<{ id: string; values: Record<string, unknown> }> }>(
      page,
      'GET',
      `/api/views/${table.viewId}/rows?offset=0&limit=100`,
    );
    expect(changedType.rows.find((row) => row.id === first.id)?.values[table.fields.Port]).toBe('1001');
    await sql(`ALTER TABLE "${schema}".items ALTER COLUMN port TYPE text USING port::text`);
    await page.getByRole('button', { name: 'Sync settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Sync settings' });
    await settings.getByRole('radio', { name: 'Live', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(settings.getByRole('radio', { name: 'Live', exact: true })).toBeChecked();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Live from Fleet source', { exact: true })).toBeVisible();
    await sql(`UPDATE "${schema}".items SET port = 'Live harbor' WHERE id = 1`);
    await page.getByRole('button', { name: 'Read again', exact: true }).click();
    await expect(grid.getByRole('gridcell', { name: 'Live harbor', exact: true })).toBeVisible();
    await expect(grid.getByRole('gridcell', { name: 'Local note', exact: true })).toBeVisible();
    const listed = await asOwner<Array<{ id: string; connection: unknown }>>(
      editor.page,
      'GET',
      '/api/sources',
    );
    expect(listed.find((item) => item.id === remote.id)?.connection).toBeNull();
    for (const role of ['commenter', 'reader'] as const) {
      await share(page, database.id, editor, role);
      await editor.page.reload();
      await expect(other.getByRole('gridcell', { name: 'Live harbor', exact: true })).toBeVisible();
      await expect(editor.page.getByRole('button', { name: 'Sync now', exact: true })).toHaveCount(0);
      const refused = await asOwner<{ results: Array<{ status: string }> }>(
        editor.page,
        'POST',
        `/api/databases/${database.id}/commands`,
        {
          clientId: newId('cli'),
          commands: [
            {
              id: newId('cmd'),
              groupId: newId('act'),
              kind: 'record.update',
              tableId: table.id,
              records: [{ id: first.id, values: { [table.fields.Port]: 'Refused override' } }],
            },
          ],
        },
      );
      expect(refused.results).toMatchObject([{ status: 'rejected' }]);
      await expect(grid.getByRole('gridcell', { name: 'Live harbor', exact: true })).toBeVisible();
    }
    await page.goto(`${base()}/settings/sources`);
    await page.getByRole('button', { name: 'Delete Fleet source', exact: true }).click();
    const remove = page.getByRole('dialog', { name: 'Delete Fleet source?' });
    await remove.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(remove.getByRole('alert')).toBeVisible();
    await expect(remove).toBeVisible();
  } finally {
    await editor.context.close();
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('withholds duplicate keys from restricted readers in sync messages, reloads, and realtime', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  const publicKey = randomBytes(24).toString('hex');
  const privateKey = randomBytes(24).toString('hex');
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".items (id text, name text);
    INSERT INTO "${schema}".items VALUES ('${publicKey}', 'Public record'), ('${privateKey}', 'Private record');`);
  const reader = await invite(page, browser, 'Restricted source reader');
  try {
    const remote = await source(page, schema, 'Private source keys');
    const database = await createDatabase(page, 'Restricted source messages', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const table = {
      id: newId('tbl'),
      viewId: newId('viw'),
      fields: { Name: newId('fld'), ID: newId('fld') },
      choices: {},
      records: [],
    };
    await runCommands(page, database.id, [
      {
        kind: 'table.create',
        table: {
          id: table.id,
          name: 'Copied records',
          fields: [
            {
              id: table.fields.Name,
              name: 'Name',
              type: 'text',
              source: { column: 'name', sourceType: 'text' },
            },
            { id: table.fields.ID, name: 'ID', type: 'text', source: { column: 'id', sourceType: 'text' } },
          ],
          view: { id: table.viewId, name: 'Grid' },
          source: {
            sourceId: remote.id,
            select: { kind: 'object', object: { schema, name: 'items' } },
            keyColumns: ['id'],
            everyMinutes: null,
          },
        },
      },
    ]);
    database.tables.Copied = table;
    const grid = await openTable(page, database, 'Copied');
    await expect(grid.getByRole('gridcell', { name: 'Private record', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await share(page, database.id, reader, 'reader');
    await asOwner(page, 'PUT', `/api/tables/${table.id}/record-rules`, {
      rules: [
        {
          id: newId('rul'),
          roles: ['reader'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [
              { id: 'public', fieldId: table.fields.Name, operator: 'is', value: 'Public record' },
            ],
          },
        },
      ],
    });
    const restricted = await openTable(reader.page, database, 'Copied');
    await expect(restricted.getByRole('gridcell', { name: 'Public record', exact: true })).toBeVisible();
    await expect(restricted.getByRole('gridcell', { name: 'Private record', exact: true })).toHaveCount(0);
    await sql(`INSERT INTO "${schema}".items VALUES ('${privateKey}', 'Repeated private record')`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    const explanation = 'Some rows share a key.  Choose key columns that are unique.';
    await expect(reader.page.getByText(explanation, { exact: true })).toBeVisible({ timeout: 45_000 });
    const ownerStatus = page.getByRole('status').filter({ hasText: 'Two rows share the key' });
    await expect(ownerStatus).toContainText(privateKey);
    await expect(reader.page.locator('body')).not.toContainText(privateKey);
    const checkSchema = async () => {
      const schema = await asOwner<{
        tables: Array<{ id: string; source?: { status: { error: unknown } } }>;
      }>(reader.page, 'GET', `/api/databases/${database.id}/schema`);
      expect(schema.tables.find((item) => item.id === table.id)?.source?.status.error).toEqual({
        messageKey: 'sources.sync.keyDuplicate',
      });
      expect(JSON.stringify(schema)).not.toContain(privateKey);
    };
    await checkSchema();
    await reader.page.reload();
    await expect(reader.page.getByText(explanation, { exact: true })).toBeVisible();
    await expect(reader.page.locator('body')).not.toContainText(privateKey);
    await asOwner(page, 'PUT', `/api/fields/${table.fields.ID}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    await asOwner(page, 'PUT', `/api/tables/${table.id}/record-rules`, { rules: [] });
    const reconnected = reader.page.waitForEvent('websocket');
    await reader.page.reload();
    const socket = await reconnected;
    await expect(restricted.getByRole('gridcell', { name: 'Private record', exact: true })).toBeVisible();
    await expect(reader.page.getByText(explanation, { exact: true })).toBeVisible();
    await checkSchema();
    const lastSyncAt = async () => {
      const schema = await asOwner<{
        tables: Array<{ id: string; source?: { status: { state: string; lastSyncAt: string | null } } }>;
      }>(reader.page, 'GET', `/api/databases/${database.id}/schema`);
      return schema.tables.find((item) => item.id === table.id)!.source!.status;
    };
    const previous = (await lastSyncAt()).lastSyncAt;
    const retrying = socket.waitForEvent('framereceived', {
      predicate: ({ payload }) => {
        const message = payload.toString();
        return message.includes(table.id) && /"state":"(?:queued|running)"/.test(message);
      },
    });
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    const retry = await retrying;
    expect(retry.payload.toString()).not.toContain(privateKey);
    await expect
      .poll(
        async () => {
          const status = await lastSyncAt();
          return status.state === 'failed' && status.lastSyncAt !== previous;
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    await expect(reader.page.getByText(explanation, { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(reader.page.locator('body')).not.toContainText(privateKey);
    await expect(ownerStatus).toContainText(privateKey);
    await checkSchema();
  } finally {
    await reader.context.close();
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('withholds restricted column names in notifications after a source creator becomes a reader', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  const column = `private_${randomBytes(16).toString('hex')}`;
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".items (id integer PRIMARY KEY, name text, "${column}" text);
    INSERT INTO "${schema}".items VALUES (1, 'Visible record', 'Restricted value');`);
  const creator = await invite(page, browser, 'Downgraded source creator');
  try {
    const remote = await source(page, schema, 'Notification source');
    const database = await createDatabase(page, 'Source notifications', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    await share(page, database.id, creator, 'creator');
    const table = {
      id: newId('tbl'),
      viewId: newId('viw'),
      fields: { Name: newId('fld'), ID: newId('fld'), Private: newId('fld') },
      choices: {},
      records: [],
    };
    await runCommands(creator.page, database.id, [
      {
        kind: 'table.create',
        table: {
          id: table.id,
          name: 'Copied notification records',
          fields: [
            {
              id: table.fields.Name,
              name: 'Name',
              type: 'text',
              source: { column: 'name', sourceType: 'text' },
            },
            {
              id: table.fields.ID,
              name: 'ID',
              type: 'number',
              source: { column: 'id', sourceType: 'integer' },
            },
            { id: table.fields.Private, name: column, type: 'text', source: { column, sourceType: 'text' } },
          ],
          view: { id: table.viewId, name: 'Grid' },
          source: {
            sourceId: remote.id,
            select: { kind: 'object', object: { schema, name: 'items' } },
            keyColumns: ['id'],
            everyMinutes: null,
          },
        },
      },
    ]);
    database.tables.Copied = table;
    const ownerGrid = await openTable(page, database, 'Copied');
    await expect(ownerGrid.getByRole('gridcell', { name: 'Visible record', exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await asOwner(page, 'PUT', `/api/fields/${table.fields.Private}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    await share(page, database.id, creator, 'reader');
    await openTable(creator.page, database, 'Copied');
    await expect(creator.page.locator('body')).not.toContainText(column);
    await sql(`ALTER TABLE "${schema}".items RENAME COLUMN "${column}" TO renamed`);
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The last sync failed.' })).toContainText(
      column,
      { timeout: 45_000 },
    );
    await creator.page.reload();
    await creator.page.setViewportSize({ width: 390, height: 844 });
    await creator.page.getByRole('button', { name: /^Notifications/ }).click();
    const notifications = creator.page.getByRole('dialog', { name: 'Notifications', exact: true });
    await expect(
      notifications.getByRole('link', { name: /Copied notification records stopped syncing/ }),
    ).toBeVisible();
    await expect(notifications).not.toContainText(column);
    await expect(notifications).toContainText('A column used by this table is missing from the source.');
    const notices = await asOwner<{
      notifications: Array<{ kind: string; target: { tableId?: string; reason?: unknown } }>;
    }>(creator.page, 'GET', '/api/notifications');
    expect(
      notices.notifications.find(
        (notice) => notice.kind === 'syncFailed' && notice.target.tableId === table.id,
      )?.target.reason,
    ).toEqual({ messageKey: 'sources.sync.columnMissing' });
    await runCommands(page, database.id, [{ kind: 'table.trash', tableId: table.id }]);
    await openTable(creator.page, database, 'Notes');
    await creator.page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(
      notifications.getByRole('link', { name: /Copied notification records stopped syncing/ }),
    ).toHaveCount(0);
  } finally {
    await creator.context.close();
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('withholds hidden live keys when a reader refreshes a source with duplicate rows', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  const key = randomBytes(24).toString('hex');
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".items (id text, name text);
    INSERT INTO "${schema}".items VALUES ('${key}', 'Visible live record');`);
  const reader = await invite(page, browser, 'Hidden live key reader');
  try {
    const remote = await source(page, schema, 'Hidden live keys');
    const database = await createDatabase(page, 'Live key messages', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    const table = {
      id: newId('tbl'),
      viewId: newId('viw'),
      fields: { Name: newId('fld'), ID: newId('fld') },
      choices: {},
      records: [],
    };
    await runCommands(page, database.id, [
      {
        kind: 'table.create',
        table: {
          id: table.id,
          name: 'Live records',
          fields: [
            {
              id: table.fields.Name,
              name: 'Name',
              type: 'text',
              source: { column: 'name', sourceType: 'text' },
            },
            { id: table.fields.ID, name: 'ID', type: 'text', source: { column: 'id', sourceType: 'text' } },
          ],
          view: { id: table.viewId, name: 'Grid' },
          source: {
            sourceId: remote.id,
            select: { kind: 'object', object: { schema, name: 'items' } },
            keyColumns: ['id'],
            everyMinutes: null,
            freshness: 'live',
          },
        },
      },
    ]);
    database.tables.Live = table;
    await share(page, database.id, reader, 'reader');
    await asOwner(page, 'PUT', `/api/fields/${table.fields.ID}/permissions`, {
      restricted: { roles: ['owner'], users: [] },
      locked: null,
    });
    const grid = await openTable(reader.page, database, 'Live');
    await expect(grid.getByRole('gridcell', { name: 'Visible live record', exact: true })).toBeVisible();
    await expect(reader.page.locator('body')).not.toContainText(key);
    await reader.page.setViewportSize({ width: 390, height: 844 });
    await sql(`INSERT INTO "${schema}".items VALUES ('${key}', 'Duplicate live record')`);
    const explanation = 'Some rows share a key.  Choose key columns that are unique.';
    const readAgain = async () => {
      const response = reader.page.waitForResponse(
        (response) => response.url().includes(`/api/views/${table.viewId}/rows`) && response.status() === 422,
      );
      await reader.page.getByRole('button', { name: 'Read again', exact: true }).click();
      const error = await (await response).json();
      expect(error.error).toEqual({
        code: 'validation_failed',
        messageKey: 'sources.sync.keyDuplicate',
        userFault: true,
      });
      await expect(reader.page.getByText(explanation, { exact: true })).toBeVisible();
      await expect(reader.page.locator('body')).not.toContainText(key);
    };
    await readAgain();
    await reader.page.reload();
    await expect(reader.page.locator('body')).not.toContainText(key);
    // A reload can reuse the last successful live snapshot, so request a fresh order again.
    await readAgain();
    await openTable(page, database, 'Live');
    await expect(page.getByText(/Two rows share the key/)).toContainText(key);
  } finally {
    await reader.context.close();
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('joins two outside sources with repeated keys and keeps unmatched rows on a phone', async ({ page }) => {
  test.setTimeout(150_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".departures (id integer PRIMARY KEY, name text, port text);
    CREATE TABLE "${schema}".ports (id integer PRIMARY KEY, name text, city text);
    INSERT INTO "${schema}".departures VALUES (1, 'First departure', 'A'), (2, 'Second departure', 'A'), (3, 'Third departure', 'B'), (4, 'Missing🚢', 'C');
    INSERT INTO "${schema}".ports VALUES (1, 'A', 'Boston'), (2, 'A', 'Oslo'), (3, 'B', '港');`);
  try {
    const departures = await source(page, schema, 'Departure source');
    const ports = await source(page, schema, 'Port source');
    const database = await createDatabase(page, 'Two sources', [
      { name: 'Notes', fields: [{ name: 'Name', type: 'text' }] },
    ]);
    for (const [name, object, remote, columns] of [
      ['Departures', 'departures', departures, ['name', 'id', 'port']],
      ['Ports', 'ports', ports, ['name', 'id', 'city']],
    ] as const) {
      const table = {
        id: newId('tbl'),
        viewId: newId('viw'),
        fields: Object.fromEntries(columns.map((column) => [column, newId('fld')])),
        choices: {},
        records: [],
      };
      await runCommands(page, database.id, [
        {
          kind: 'table.create',
          table: {
            id: table.id,
            name,
            fields: columns.map((column) => ({
              id: table.fields[column]!,
              name: column,
              type: column === 'id' ? 'number' : 'text',
              source: { column, sourceType: column === 'id' ? 'integer' : 'text' },
            })),
            view: { id: table.viewId, name: 'Grid' },
            source: {
              sourceId: remote.id,
              select: { kind: 'object', object: { schema, name: object } },
              keyColumns: ['id'],
              freshness: 'live',
              everyMinutes: null,
            },
          },
        },
      ]);
      database.tables[name] = table;
      await openTable(page, database, name);
      await expect(page.getByRole('grid', { name: 'Grid' }).getByRole('row')).toHaveCount(
        name === 'Ports' ? 5 : 6,
      );
    }
    await openTable(page, database, 'Departures');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Create joined table', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create joined table' });
    await expect(page).toHaveURL(/dataPanel=join/);
    await dialog.getByRole('button', { name: /Next table/ }).click();
    await page.getByRole('option', { name: labelName('Ports'), exact: true }).click();
    await dialog.getByRole('button', { name: /Key from an earlier table/ }).click();
    await page.getByRole('option', { name: labelName('Departures port'), exact: true }).click();
    await dialog.getByRole('button', { name: /Key from the next table/ }).click();
    await page.getByRole('option', { name: labelName('name'), exact: true }).click();
    await dialog.getByLabel('Table name', { exact: true }).fill('Departure cities');
    const included = dialog.getByRole('group', { name: 'Fields to include' });
    await included.getByText('Departures name', { exact: true }).click();
    await included.getByText('Ports city', { exact: true }).click();
    await dialog.getByRole('button', { name: 'Create joined table', exact: true }).click();
    await expect(dialog).toBeHidden();
    const grid = page.getByRole('grid', { name: 'Grid' });
    await expect(grid.getByRole('gridcell', { name: 'First departure', exact: true })).toHaveCount(2);
    await expect(grid.getByRole('gridcell', { name: 'Second departure', exact: true })).toHaveCount(2);
    await expect(grid.getByRole('gridcell', { name: 'Third departure', exact: true })).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: 'Missing🚢', exact: true })).toHaveCount(1);
    await expect(grid.getByRole('gridcell', { name: '港', exact: true })).toHaveCount(1);
    await page.reload();
    await expect(grid.getByRole('gridcell', { name: 'Missing🚢', exact: true })).toHaveCount(1);
  } finally {
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});

test('reads a long source live and reaches its last record with the keyboard', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  const schema = `qa_sources_${randomBytes(8).toString('hex')}`;
  await sql(`CREATE SCHEMA "${schema}";
    CREATE TABLE "${schema}".long_items (id integer PRIMARY KEY, name text);
    INSERT INTO "${schema}".long_items SELECT n, 'Vessel ' || n FROM generate_series(1, 10001) n;`);
  try {
    await source(page, schema, 'Long source');
    const dialog = await wizard(page, 'Long source', 'long_items', schema);
    await dialog.getByRole('button', { name: 'Next', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Live', exact: true }).focus();
    await page.keyboard.press('Space');
    await expect(dialog.getByRole('radio', { name: 'Live', exact: true })).toBeChecked();
    await dialog.getByRole('button', { name: 'Create synced table', exact: true }).click();
    await expect(dialog).toBeHidden();
    const grid = page.getByRole('grid', { name: 'Grid' });
    await expect(grid.getByRole('gridcell', { name: 'Vessel 1', exact: true })).toBeVisible();
    await grid.getByRole('gridcell', { name: 'Vessel 1', exact: true }).click();
    await page.keyboard.press('ControlOrMeta+End');
    await expect(grid.getByRole('gridcell', { name: 'Vessel 10001', exact: true })).toBeVisible();
    await page.reload();
    await expect(grid.getByRole('gridcell', { name: 'Vessel 1', exact: true })).toBeVisible();
  } finally {
    await sql(`DROP SCHEMA "${schema}" CASCADE`);
  }
});
