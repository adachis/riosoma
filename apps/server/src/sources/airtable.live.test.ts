/**
 * Airtable sources against the real Airtable.  It runs only when these are set, and skips
 * otherwise:
 *
 * - `RIOSOMA_TEST_AIRTABLE_TOKEN`, a personal access token with `data.records:read` and
 *   `schema.bases:read`
 * - `RIOSOMA_TEST_AIRTABLE_BASE`, the ID of a base that token can read
 * - `RIOSOMA_TEST_AIRTABLE_TABLE`, optionally, the name or ID of the table to sync, or the base's
 *   first table when it's left out
 *
 * The suite lists the bases the token sees, the way the source form does, and chooses that base
 * for a new source.  It tests the source, checks the source offers that base's tables and no
 * others, syncs the table into a throwaway database with every field Riosoma can hold, checks every record came across keyed by its record ID,
 * overrides a value, syncs again, and checks the override survived and the token never reached the
 * logs, the change history, the audit log, or any answer.  It only ever reads from Airtable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FieldSpec,
  type AirtableSourceBase,
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type * as Logger from '../logger.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { AIRTABLE_API_URL } from '../data/imports/airtable/api.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { RECORD_ID } from './airtable.js';
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

const token = process.env.RIOSOMA_TEST_AIRTABLE_TOKEN || undefined;
const baseId = process.env.RIOSOMA_TEST_AIRTABLE_BASE || undefined;
const tableName = process.env.RIOSOMA_TEST_AIRTABLE_TABLE || undefined;

/**
 * The suite reads Airtable straight too, to check what a sync brought across, and those requests
 * don't go through Riosoma's limiter for the base.  Airtable counts them all the same, so the suite
 * leaves a gap on each side of them, the way two separate clients of one base have to, and keeps
 * its own to four a second.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 2_000));
const spaced = () => new Promise((resolve) => setTimeout(resolve, 250));

/** The table's record IDs, read straight from Airtable, a page at a time. */
async function airtableIds(tableId: string, primaryFieldId: string): Promise<string[]> {
  const ids: string[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`${AIRTABLE_API_URL}/v0/${baseId}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.append('fields[]', primaryFieldId);
    if (offset) url.searchParams.set('offset', offset);
    const page = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(page.status).toBe(200);
    const body = (await page.json()) as { records: Array<{ id: string }>; offset?: string };
    ids.push(...body.records.map((record) => record.id));
    offset = body.offset;
    await spaced();
  } while (offset);
  return ids;
}

describe.skipIf(!token || !baseId)('Airtable sources against the real Airtable', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let databaseId: string;

  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'airtable_src_live', { logLevel: 'info' });
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: newId('database'),
        name: 'Airtable live',
        table: {
          id: newId('table'),
          name: 'Local',
          fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
          view: { id: newId('view'), name: 'Grid' },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    databaseId = created.json<DatabaseSchema>().database.id;
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  async function request<T>(method: 'GET' | 'POST', url: string, payload?: unknown) {
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

  it(
    'syncs a table keyed by record ID, keeps an override, and keeps the token to itself',
    { timeout: 900_000 },
    async () => {
      // One listing of the token's bases, however many it sees, fills the form's base picker.
      const choices = await request<AirtableSourceBase[]>('POST', '/api/sources/airtable-bases', { token });
      expect(
        choices.json.map((base) => base.id),
        'the token can’t see RIOSOMA_TEST_AIRTABLE_BASE',
      ).toContain(baseId);
      console.info('airtable live source: the token sees', choices.json.length, 'bases');
      const source = await request<SourceMeta>('POST', '/api/sources', {
        name: 'Live Airtable',
        connection: { kind: 'airtable', bases: [baseId] },
        secrets: { token },
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
        ['tables', 'ok'],
        ['rows', 'ok'],
      ]);
      const objects = await request<SourceObject[]>('GET', `/api/sources/${source.json.id}/objects`);
      // Only the chosen base's tables, never the rest of what the token reaches.
      expect(new Set(objects.json.map((object) => object.schema))).toEqual(new Set([baseId]));
      const tables = objects.json;
      expect(tables.length, objects.body).toBeGreaterThan(0);
      expect(tables[0]!.schemaLabel).toBe(choices.json.find((base) => base.id === baseId)!.name);
      const chosen = tableName
        ? tables.find((object) => object.name === tableName || object.label === tableName)
        : tables[0];
      expect(chosen, `no table named ${tableName} in ${baseId}`).toBeDefined();
      const select = { kind: 'object' as const, object: { schema: baseId!, name: chosen!.name } };
      const preview = await request<SourcePreview>('POST', `/api/sources/${source.json.id}/preview`, {
        select,
      });
      expect(preview.json.keyCandidates).toEqual([[RECORD_ID]]);
      expect(preview.json.columns.at(-1)).toMatchObject({ name: RECORD_ID, role: 'recordId' });

      // Every column Riosoma can hold, up to a table's limit, with the record ID, which is the key.
      const held = [
        ...preview.json.columns
          .filter((column) => column.role !== 'recordId')
          .filter((column) => column.suggested && FieldSpec.safeParse(column.suggested).success)
          .slice(0, 49),
        preview.json.columns.at(-1)!,
      ];
      const primary = held.find((column) =>
        ['text', 'email', 'url', 'phone'].includes(column.suggested!.type),
      )!;
      expect(primary, 'the table needs a text field to be its primary field').toBeDefined();
      const ordered = [primary, ...held.filter((column) => column !== primary)];
      const field = Object.fromEntries(ordered.map((column) => [column.name, newId('field')]));
      const tableId = newId('table');
      await applied({
        kind: 'table.create',
        table: {
          id: tableId,
          name: chosen!.label ?? chosen!.name,
          source: { sourceId: source.json.id, select, keyColumns: [RECORD_ID], everyMinutes: null },
          fields: ordered.map((column) => ({
            id: field[column.name],
            name: column.name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: column.name, sourceType: column.sourceType },
          })),
          view: { id: newId('view'), name: 'Grid' },
          records: [],
        },
      });
      const first = await sync(tableId);
      expect(first.source!.status.state, JSON.stringify(first.source!.status)).toBe('idle');
      const synced = await rows(tableId);
      await settle();
      const primaryFieldId = await (async () => {
        const meta = await fetch(`${AIRTABLE_API_URL}/v0/meta/bases/${baseId}/tables`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const { tables: all } = (await meta.json()) as {
          tables: Array<{ id: string; primaryFieldId: string }>;
        };
        return all.find((table) => table.id === chosen!.name)!.primaryFieldId;
      })();
      await spaced();
      const expected = await airtableIds(chosen!.name, primaryFieldId);
      await settle();
      expect(synced.map((row) => row.values[field[RECORD_ID]!]).sort()).toEqual(expected.sort());

      if (synced.length) {
        const target = synced[0]!;
        await applied({
          kind: 'record.update',
          tableId,
          records: [{ id: target.id, values: { [field[primary.name]!]: 'Overridden here' } }],
        });
        const second = await sync(tableId);
        expect(second.source!.status, JSON.stringify(second.source!.status)).toMatchObject({
          state: 'idle',
          stats: { added: 0, removed: 0 },
        });
        const kept = (await rows(tableId)).find((row) => row.id === target.id)!;
        expect(kept.values[field[primary.name]!]).toBe('Overridden here');
        expect(kept.overrides![field[primary.name]!]).toBeDefined();
      }

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
        JSON.stringify((await loadTable(server.pool, server.schemas, tableId))!.source),
        listed.body,
        choices.body,
        tested.body,
        preview.body,
        logs.lines.join('\n'),
      ])
        expect(text).not.toContain(token);

      // What came across and how, for whoever runs this by hand.
      console.info(
        'airtable live source',
        preview.json.columns.map((column) => ({
          name: column.name,
          type: column.suggested?.type ?? null,
          notes: (column.notes ?? []).map((note) => note.messageKey),
        })),
      );
    },
  );
});
