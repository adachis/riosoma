import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId, type OutboundSync, type SyncOutCommandResult, type ViewSyncOut } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { apply, createRecords, updateRecord } from '../../automations/automations.test-helpers.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';

/**
 * A whole sync against a real Airtable base, skipped unless its settings are set.  It makes a table
 * with a unique name, checks the rows through the Airtable API, edits and removes a record, syncs
 * again with nothing else changed, and deletes the rows it made.  Airtable's API can't delete a
 * table, so the empty table is left behind.
 */

const PAT = process.env.RIOSOMA_TEST_AIRTABLE_PAT;
const BASE = process.env.RIOSOMA_TEST_SYNC_OUT_AIRTABLE_BASE;
const run = PAT && BASE ? it : it.skip;

let kit: TestPostgres;
let server: ServerFixture;
let tableId: string | null = null;

beforeAll(async () => {
  if (!PAT || !BASE) return;
  // Never write to the base the inbound import tests use.
  expect(BASE).not.toBe(process.env.RIOSOMA_TEST_AIRTABLE_BASE);
  kit = await startTestPostgres();
  server = await startServer(kit, 'syncoutlive', { outboundSyncPollMs: 0, logLevel: 'silent' });
}, 120_000);

afterAll(async () => {
  if (tableId && PAT && BASE) {
    // Empty the table of everything the test made, since Airtable can't delete the table itself.
    const listed = await air(`/v0/${BASE}/${tableId}?pageSize=100`);
    const ids = (listed.records as Array<{ id: string }>).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 10) {
      const query = ids
        .slice(i, i + 10)
        .map((id) => `records[]=${id}`)
        .join('&');
      await air(`/v0/${BASE}/${tableId}?${query}`, { method: 'DELETE' });
    }
  }
  await server?.close();
  await kit?.stop();
}, 120_000);

async function air(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(`https://api.airtable.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${PAT}`, ...(init.headers ?? {}) },
  });
  if (!response.ok)
    throw new Error(`Airtable ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

run(
  'creates a table and rows, edits, removes, and reruns clean against a real base',
  async () => {
    const databaseId = newId('database');
    const dataTable = newId('table');
    const viewId = newId('view');
    const name = newId('field');
    const amount = newId('field');
    await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: {
        id: databaseId,
        name: 'Live',
        table: {
          id: dataTable,
          name: 'Projects',
          fields: [
            { id: name, name: 'Name', type: 'text' },
            { id: amount, name: 'Amount', type: 'number' },
          ],
          view: { id: viewId, name: 'All' },
        },
      },
    });
    const records = await createRecords(server, databaseId, dataTable, [
      { [name]: 'Alpha', [amount]: 100 },
      { [name]: 'Beta', [amount]: 200 },
      { [name]: 'Gamma', [amount]: 300 },
    ]);
    const outsideName = `Riosoma sync out ${randomUUID().slice(0, 8)}`;

    const created = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/sync-out/commands`,
      headers: server.owner.headers,
      payload: {
        id: newId('command'),
        action: {
          kind: 'create',
          input: {
            viewId,
            name: 'Live sync',
            destination: {
              kind: 'airtable',
              baseId: BASE,
              baseName: 'Live base',
              table: { mode: 'new', name: outsideName },
            },
            credential: { token: PAT },
            settings: {
              everyMinutes: null,
              removeMissing: true,
              createColumns: true,
              timeZone: 'UTC',
              locale: 'en-US',
            },
          },
        },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const syncId = created.json<SyncOutCommandResult>().sync!.id;
    await server.ctx.outboundSyncs!.drain();

    const sync = await viewSync(viewId, syncId);
    expect(sync.status.state).toBe('idle');
    tableId = sync.destination.table.id;
    expect(tableId).toBeTruthy();

    const first = await air(`/v0/${BASE}/${tableId}?returnFieldsByFieldId=true&pageSize=100`);
    expect((first.records as unknown[]).length).toBe(3);

    // Edit one, remove one, and sync again.
    await updateRecord(server, databaseId, dataTable, records[0]!, { [amount]: 999 });
    await apply(server, databaseId, [{ kind: 'record.trash', tableId: dataTable, recordIds: [records[2]!] }]);
    await syncNow(databaseId, syncId);
    const afterEdit = await air(`/v0/${BASE}/${tableId}?pageSize=100`);
    expect((afterEdit.records as unknown[]).length).toBe(2);

    // A rerun with nothing changed writes nothing new.
    await syncNow(databaseId, syncId);
    const afterClean = await air(`/v0/${BASE}/${tableId}?pageSize=100`);
    expect((afterClean.records as unknown[]).length).toBe(2);

    const runs = (await viewSync(viewId, syncId)).status;
    expect(runs.stats).not.toBeNull();
  },
  180_000,
);

async function viewSync(viewId: string, syncId: string): Promise<OutboundSync> {
  const response = await server.app.inject({
    method: 'GET',
    url: `/api/views/${viewId}/sync-out`,
    headers: server.owner.headers,
  });
  return response.json<ViewSyncOut>().syncs.find((s) => s.id === syncId)!;
}

async function syncNow(databaseId: string, syncId: string): Promise<void> {
  await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/sync-out/commands`,
    headers: server.owner.headers,
    payload: { id: newId('command'), action: { kind: 'run', syncId } },
  });
  await server.ctx.outboundSyncs!.drain();
}
