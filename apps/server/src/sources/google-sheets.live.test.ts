/**
 * Google Sheets sources against the real Google.  It runs only when both of these are set, and
 * skips otherwise:
 *
 * - `RIOSOMA_TEST_GOOGLE_SA_KEY`, a service account's whole JSON key, whose project has the Google
 *   Sheets API turned on
 * - `RIOSOMA_TEST_GOOGLE_SHEET_ID`, the ID or address of a spreadsheet a person created and shared
 *   with the service account as an Editor, since a service account can't own a new file itself
 *
 * The suite adds a tab of its own to the front of that spreadsheet with a few typed columns, syncs
 * the tab into a throwaway database, overrides a value, changes cells in the tab, syncs again, and
 * checks the override survived and the key never reached the logs, the change history, the audit
 * log, or any answer.  It deletes its tab at the end, and leaves the rest of the spreadsheet as it
 * was.  The source itself only ever reads.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  newId,
  spreadsheetIdOf,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { GOOGLE_TOKEN_URL, readServiceAccountKey, serviceAccountAssertion } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../logger.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { claimSyncs, runSync } from './sync.js';

const logs = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../logger.js', async (original) => {
  const actual = await original<typeof Logger>();
  return {
    ...actual,
    loggerOptions: (level: string, production: boolean) => ({
      ...actual.loggerOptions(level, production),
      stream: {
        write(line: string) {
          logs.lines.push(line);
        },
      },
    }),
  };
});

const keyJson = process.env.RIOSOMA_TEST_GOOGLE_SA_KEY || undefined;
const sharedSheet = process.env.RIOSOMA_TEST_GOOGLE_SHEET_ID || undefined;

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Adding, filling, and deleting the suite's own tab needs more than a source ever asks for. */
const WRITE_SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

/** A token that may write, for the suite's own setup and cleanup, never for the source. */
async function writeToken(): Promise<string> {
  const key = readServiceAccountKey(keyJson!);
  expect(key, 'RIOSOMA_TEST_GOOGLE_SA_KEY is not a service account key').not.toBeNull();
  const assertion = serviceAccountAssertion(
    key!,
    WRITE_SCOPES,
    GOOGLE_TOKEN_URL,
    Math.floor(Date.now() / 1_000),
  );
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe.skipIf(!keyJson || !sharedSheet)('Google Sheets sources against the real Google', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let databaseId: string;
  let token = '';
  const spreadsheetId = spreadsheetIdOf(sharedSheet ?? '') ?? sharedSheet ?? '';
  /** The suite's own tab, which it adds and deletes */
  const title = `Riosoma live test ${randomBytes(4).toString('hex')}`;
  let sheetId: number | undefined;

  async function google(method: string, url: string, body?: unknown) {
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect(response.ok, `${method} ${url}: ${response.status} ${text}`).toBe(true);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  async function writeCells(range: string, values: unknown[][]) {
    await google(
      'PUT',
      `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { range, majorDimension: 'ROWS', values },
    );
  }

  async function request<T>(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
    const response = await server.app.inject({
      method,
      url,
      headers: server.owner.headers,
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
    expect(response.statusCode, response.body).toBe(200);
    return { json: response.json<T>(), body: response.body };
  }

  async function applied(input: Record<string, unknown>) {
    const { json } = await request<CommandBatchResult>('POST', `/api/databases/${databaseId}/commands`, {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    });
    expect(json.results[0], JSON.stringify(json.results[0])).toMatchObject({ status: 'applied' });
  }

  async function sync(tableId: string): Promise<TableMeta> {
    await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
    for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
    return (await loadTable(server.pool, server.schemas, tableId))!;
  }

  async function rows(tableId: string): Promise<RowData[]> {
    const ids = await query<{ __id: string }>(
      server.pool,
      sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
    );
    return fetchRowsById(
      server.pool,
      server.schemas.data,
      tableId,
      await loadFields(server.pool, server.schemas, [tableId]),
      ids.rows.map((row) => row.__id),
    );
  }

  /** The parts of the key that must never leave the server. */
  function keyParts(): string[] {
    const key = JSON.parse(keyJson!) as { private_key: string; private_key_id?: string };
    return [
      key.private_key,
      ...key.private_key.split('\n').filter((line) => line.length > 20),
      ...(key.private_key_id ? [key.private_key_id] : []),
    ];
  }

  beforeAll(async () => {
    expect(
      spreadsheetIdOf(spreadsheetId),
      'RIOSOMA_TEST_GOOGLE_SHEET_ID names no spreadsheet',
    ).not.toBeNull();
    token = await writeToken();
    // The tab goes first, since a connection test reads the first sheet's header.
    const added = await google('POST', `${SHEETS}/${spreadsheetId}:batchUpdate`, {
      requests: [
        {
          addSheet: {
            properties: { title, index: 0, gridProperties: { rowCount: 50, columnCount: 6 } },
          },
        },
      ],
    });
    sheetId = (added.replies as Array<{ addSheet: { properties: { sheetId: number } } }>)[0]!.addSheet
      .properties.sheetId;
    await writeCells(`'${title}'!A1:E4`, [
      ['SKU', 'Plant', 'Price', 'Planted', 'Organic'],
      ['P-1', 'Basil', 3.5, '2026-04-02', true],
      ['P-2', 'Thyme', 4, '2026-04-09', false],
      ['P-3', 'Sage', 5.25, '2026-04-16', true],
    ]);
    kit = await startTestPostgres();
    server = await startServer(kit, 'sheets_live', { logLevel: 'info' });
    const database = await request<DatabaseSchema>('POST', '/api/databases', {
      id: newId('database'),
      name: 'Sheets live',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    });
    databaseId = database.json.database.id;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    if (sheetId !== undefined)
      await google('POST', `${SHEETS}/${spreadsheetId}:batchUpdate`, {
        requests: [{ deleteSheet: { sheetId } }],
      });
  }, 60_000);

  it(
    'syncs a sheet, keeps an override when cells change, and keeps the key to itself',
    { timeout: 300_000 },
    async () => {
      const source = await request<SourceMeta>('POST', '/api/sources', {
        name: 'Live sheets',
        connection: { kind: 'google-sheets', spreadsheets: [spreadsheetId] },
        secrets: { serviceAccountJson: keyJson },
      });
      expect(source.json.connection).toMatchObject({
        serviceAccountEmail: JSON.parse(keyJson!).client_email,
      });
      const tested = await request<SourceTestResult>('POST', `/api/sources/${source.json.id}/test`);
      expect(
        tested.json.steps.map((step) => [step.step, step.status]),
        tested.body,
      ).toEqual([
        ['resolve', 'ok'],
        ['connect', 'ok'],
        ['tls', 'ok'],
        ['authenticate', 'ok'],
        ['sheets', 'ok'],
        ['rows', 'ok'],
      ]);
      const objects = await request<SourceObject[]>('GET', `/api/sources/${source.json.id}/objects`);
      // The suite's tab first, then whatever else the spreadsheet holds.
      expect(objects.json[0]).toMatchObject({
        schema: spreadsheetId,
        name: String(sheetId),
        label: title,
        type: 'sheet',
      });
      const select = { kind: 'object' as const, object: { schema: spreadsheetId, name: String(sheetId) } };
      const preview = await request<SourcePreview>('POST', `/api/sources/${source.json.id}/preview`, {
        select,
      });
      expect(preview.json.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
        ['SKU', 'text'],
        ['Plant', 'text'],
        ['Price', 'number'],
        ['Planted', 'date'],
        ['Organic', 'checkbox'],
        ['Row number', 'number'],
      ]);
      expect(preview.json.keyCandidates[0]).toEqual(['SKU']);

      const tableId = newId('table');
      const field = Object.fromEntries(preview.json.columns.map((column) => [column.name, newId('field')]));
      await applied({
        kind: 'table.create',
        table: {
          id: tableId,
          name: 'Plants',
          source: { sourceId: source.json.id, select, keyColumns: ['SKU'], everyMinutes: null },
          fields: ['Plant', 'SKU', 'Price', 'Planted', 'Organic'].map((name) => {
            const column = preview.json.columns.find((entry) => entry.name === name)!;
            return {
              id: field[name],
              name,
              type: column.suggested!.type,
              options: column.suggested!.options,
              source: { column: name, sourceType: column.sourceType },
            };
          }),
          view: { id: newId('view'), name: 'Grid' },
          records: [],
        },
      });
      const first = await sync(tableId);
      expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
        state: 'idle',
        stats: { added: 3 },
      });
      const thyme = (await rows(tableId)).find((row) => row.values[field.SKU!] === 'P-2')!;
      expect(thyme.values).toMatchObject({
        [field.Plant!]: 'Thyme',
        [field.Price!]: 4,
        [field.Planted!]: '2026-04-09',
        [field.Organic!]: false,
      });
      await applied({
        kind: 'record.update',
        tableId,
        records: [{ id: thyme.id, values: { [field.Plant!]: 'Lemon thyme' } }],
      });

      await writeCells(`'${title}'!B3:C3`, [['Common thyme', 4.5]]);
      const second = await sync(tableId);
      expect(second.source!.status.stats, JSON.stringify(second.source!.status)).toMatchObject({
        added: 0,
        changed: 1,
        removed: 0,
      });
      const kept = (await rows(tableId)).find((row) => row.id === thyme.id)!;
      expect(kept.values).toMatchObject({ [field.Plant!]: 'Lemon thyme', [field.Price!]: 4.5 });
      expect(kept.overrides![field.Plant!]).toMatchObject({ source: 'Common thyme' });

      const changes = await query<{ body: unknown }>(
        server.pool,
        sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
      );
      const events = await query<{ detail: unknown }>(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
      );
      const listed = await request<SourceMeta[]>('GET', '/api/sources');
      for (const text of [
        JSON.stringify(changes.rows),
        JSON.stringify(events.rows),
        JSON.stringify(second.source),
        listed.body,
        tested.body,
        preview.body,
        logs.lines.join('\n'),
      ])
        for (const part of keyParts()) expect(text).not.toContain(part);
    },
  );
});
