import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type CommandBatchResult, type RowData, type RowsPage } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';

/**
 * An AI field run against the real provider, only when `RIOSOMA_TEST_ANTHROPIC_API_KEY` is set, so
 * an ordinary test run stays off the network and free.  It lives beside the provider settings,
 * since it names the provider and model it checks.
 */
const key = process.env.RIOSOMA_TEST_ANTHROPIC_API_KEY?.trim() || undefined;
const MODEL = 'claude-haiku-4-5-20251001';

let kit: TestPostgres;
let server: ServerFixture;

describe.skipIf(!key)('an AI field with a live provider', () => {
  beforeAll(async () => {
    kit = await startTestPostgres();
    server = await startServer(kit, 'aifl', { aiFieldsPollMs: 0 });
  }, 60_000);
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
  });

  const send = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: Record<string, unknown>) =>
    server.app.inject({ method, url, headers: server.owner.headers, ...(payload ? { payload } : {}) });
  const run = async (databaseId: string, command: Record<string, unknown>) => {
    const response = await send('POST', `/api/databases/${databaseId}/commands`, {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...command }],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
  };

  it('fills a single select from a record', async () => {
    expect((await send('PUT', '/api/ai/keys/anthropic', { key: key! })).statusCode).toBe(204);
    const saved = await send('PUT', '/api/ai/settings', {
      enabled: true,
      aiFields: true,
      providers: [{ providerId: 'anthropic' }],
      models: { everyday: { providerId: 'anthropic', model: MODEL }, power: null },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const ids = {
      databaseId: newId('database'),
      tableId: newId('table'),
      viewId: newId('view'),
      name: newId('field'),
      kind: newId('field'),
      record: newId('record'),
      fruit: newId('choice'),
      vegetable: newId('choice'),
    };
    const created = await send('POST', '/api/databases', {
      id: ids.databaseId,
      name: 'Produce',
      table: {
        id: ids.tableId,
        name: 'Produce',
        fields: [{ id: ids.name, name: 'Name', type: 'text' }],
        view: { id: ids.viewId, name: 'Grid' },
        records: [{ id: ids.record }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    await run(ids.databaseId, {
      kind: 'field.create',
      tableId: ids.tableId,
      field: {
        id: ids.kind,
        name: 'Kind',
        type: 'singleSelect',
        options: {
          choices: [
            { id: ids.fruit, name: 'Fruit', color: 'green' },
            { id: ids.vegetable, name: 'Vegetable', color: 'orange' },
          ],
        },
        ai: { prompt: 'Is {Name} a fruit or a vegetable?' },
      },
    });
    await run(ids.databaseId, {
      kind: 'record.update',
      tableId: ids.tableId,
      records: [{ id: ids.record, values: { [ids.name]: 'Banana' } }],
    });
    await server.ctx.aiFields!.drain();
    const runs = await query<{
      state: string;
      model: string;
      output_tokens: number;
      message_key: string | null;
    }>(
      server.pool,
      sql`SELECT state, model, output_tokens, message_key FROM ${ident(server.schemas.app, 'ai_field_runs')}
      WHERE field_id = ${ids.kind}`,
    );
    expect(runs.rows[0], JSON.stringify(runs.rows[0])).toMatchObject({ state: 'done', model: MODEL });
    expect(runs.rows[0]!.output_tokens).toBeGreaterThan(0);
    const rows = await send('GET', `/api/views/${ids.viewId}/rows?limit=10`);
    const row = rows.json<RowsPage>().rows.find((item): item is RowData => item?.id === ids.record);
    expect(row?.values[ids.kind]).toBe(ids.fruit);
  }, 60_000);
});
