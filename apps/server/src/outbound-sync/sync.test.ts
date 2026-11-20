import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncOutCommandResult, type SyncOutRuns, type ViewSyncOut } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { LightMyRequestResponse } from 'fastify';
import { apply, createRecords, grant, updateRecord } from '../automations/automations.test-helpers.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { startFakeAirtable, type FakeAirtable, type FakeTable } from '../test/fake-airtable.js';

/**
 * A whole sync against the fake Airtable, through the real engine, worker, commands, and routes:
 * a first run that makes the table and its rows, a rerun that writes nothing, edits, new and
 * removed records, a field that stops being sent, a creator who loses access, the removal guard,
 * a dropped answer that still converges, and the route access rules.
 */

const BASE_ID = `app${'b'.repeat(14)}`;
let kit: TestPostgres;
let server: ServerFixture;
let fake: FakeAirtable;
let token: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'syncout', {
    outboundSyncPollMs: 0,
    automationsAllowPrivateHosts: true,
    logLevel: 'silent',
  });
  token = `pat${randomUUID().replace(/-/g, '')}`;
  fake = await startFakeAirtable({
    token,
    bases: [{ id: BASE_ID, name: 'Fake base', permissionLevel: 'create', tables: [] }],
  });
  server.ctx.outboundSyncs!.addresses.airtable = fake.url;
  // A clock whose waits cost nothing, so a retry's backoff doesn't slow the test.
  server.ctx.outboundSyncs!.clock = { now: () => Date.now(), sleep: async () => {} };
}, 120_000);

beforeEach(() => {
  fake.bases[0]!.tables.length = 0;
  fake.requests.length = 0;
  fake.reset();
});

afterAll(async () => {
  await fake?.close();
  await server?.close();
  await kit?.stop();
});

function call(
  who: SignedIn | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return server.app.inject({
    method,
    url,
    headers: who?.headers ?? {},
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

interface Fixture {
  databaseId: string;
  tableId: string;
  viewId: string;
  fields: { name: string; amount: string; stage: string; note: string };
  records: string[];
}

async function makeDatabase(who: SignedIn = server.owner): Promise<Fixture> {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const fields = {
    name: newId('field'),
    amount: newId('field'),
    stage: newId('field'),
    note: newId('field'),
  };
  const choice1 = newId('choice');
  const choice2 = newId('choice');
  const created = await call(who, 'POST', '/api/databases', {
    id: databaseId,
    name: 'Projects db',
    table: {
      id: tableId,
      name: 'Projects',
      fields: [
        { id: fields.name, name: 'Name', type: 'text' },
        { id: fields.amount, name: 'Amount', type: 'number' },
        {
          id: fields.stage,
          name: 'Stage',
          type: 'singleSelect',
          options: {
            choices: [
              { id: choice1, name: 'Open', color: 'green' },
              { id: choice2, name: 'Won', color: 'blue' },
            ],
          },
        },
        { id: fields.note, name: 'Note', type: 'longText' },
      ],
      view: { id: viewId, name: 'All projects' },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const records = await createRecords(server, databaseId, tableId, [
    { [fields.name]: 'Alpha', [fields.amount]: 100, [fields.stage]: choice1, [fields.note]: 'First' },
    { [fields.name]: 'Beta', [fields.amount]: 200, [fields.stage]: choice2, [fields.note]: 'Second' },
    { [fields.name]: 'Gamma', [fields.amount]: 300, [fields.stage]: choice1, [fields.note]: 'Third' },
  ]);
  return { databaseId, tableId, viewId, fields, records };
}

function createInput(fixture: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    id: newId('command'),
    action: {
      kind: 'create' as const,
      input: {
        viewId: fixture.viewId,
        name: 'Projects to Airtable',
        destination: {
          kind: 'airtable',
          baseId: BASE_ID,
          baseName: 'Fake base',
          table: { mode: 'new', name: 'Projects' },
        },
        credential: { token },
        settings: {
          everyMinutes: null,
          removeMissing: true,
          createColumns: true,
          timeZone: 'UTC',
          locale: 'en-US',
          ...((overrides.settings as object) ?? {}),
        },
      },
    },
  };
}

async function createSync(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
  who: SignedIn = server.owner,
): Promise<string> {
  const response = await call(
    who,
    'POST',
    `/api/databases/${fixture.databaseId}/sync-out/commands`,
    createInput(fixture, overrides),
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SyncOutCommandResult>().sync!.id;
}

async function drain(): Promise<void> {
  await server.ctx.outboundSyncs!.drain();
}

async function syncNow(databaseId: string, syncId: string, who: SignedIn = server.owner): Promise<void> {
  const response = await call(who, 'POST', `/api/databases/${databaseId}/sync-out/commands`, {
    id: newId('command'),
    action: { kind: 'run', syncId },
  });
  expect(response.statusCode, response.body).toBe(200);
  await drain();
}

function outsideTable(): FakeTable {
  return fake.bases[0]!.tables[0]!;
}

function valueOf(table: FakeTable, recordId: string, columnName: string): unknown {
  const field = table.fields.find((f) => f.name === columnName)!;
  const key = table.fields.find((f) => f.name === 'Riosoma record ID')!;
  const record = table.records.find((r) => r.fields[key.id] === recordId)!;
  return record?.fields[field.id];
}

const writeCount = () =>
  fake.requests.filter((r) => r.method === 'PATCH' || r.method === 'DELETE' || r.method === 'POST').length;

describe('a sync against Airtable', () => {
  it('makes the table with the view fields in order, the key column last, and every row', async () => {
    const fixture = await makeDatabase();
    await createSync(fixture);
    await drain();

    const table = outsideTable();
    expect(table.fields.map((f) => f.name)).toEqual(['Name', 'Amount', 'Stage', 'Note', 'Riosoma record ID']);
    expect(table.records).toHaveLength(3);
    expect(valueOf(table, fixture.records[0]!, 'Name')).toBe('Alpha');
    expect(valueOf(table, fixture.records[1]!, 'Amount')).toBe(200);
    // Every row carries its record ID in the key column, so a rerun finds it again.
    expect(
      table.records.every(
        (r) => typeof r.fields[table.fields.find((f) => f.name === 'Riosoma record ID')!.id] === 'string',
      ),
    ).toBe(true);
  });

  it('writes nothing on a rerun when nothing changed', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture);
    await drain();
    const before = writeCount();
    await syncNow(fixture.databaseId, syncId);
    expect(writeCount()).toBe(before);
  });

  it('sends one update, one create, and one removal for the changes since the last run', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture);
    await drain();

    await updateRecord(server, fixture.databaseId, fixture.tableId, fixture.records[0]!, {
      [fixture.fields.amount]: 999,
    });
    const [added] = await createRecords(server, fixture.databaseId, fixture.tableId, [
      { [fixture.fields.name]: 'Delta', [fixture.fields.amount]: 400 },
    ]);
    await apply(server, fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.records[2]!] },
    ]);
    await syncNow(fixture.databaseId, syncId);

    const table = outsideTable();
    const runs = (await call(server.owner, 'GET', `/api/sync-out/${syncId}/runs`)).json<SyncOutRuns>().runs;
    expect(valueOf(table, fixture.records[0]!, 'Amount')).toBe(999);
    expect(valueOf(table, added!, 'Name')).toBe('Delta');
    expect(table.records).toHaveLength(3);
    expect(runs[0]!.stats).toMatchObject({ created: 1, updated: 1, removed: 1 });
  });

  it('keeps a removed record’s row when removal is off and updates it in place when it returns', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture, { settings: { removeMissing: false } });
    await drain();

    await apply(server, fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.records[0]!] },
    ]);
    await syncNow(fixture.databaseId, syncId);
    expect(outsideTable().records).toHaveLength(3);

    await apply(server, fixture.databaseId, [
      { kind: 'record.restore', tableId: fixture.tableId, recordIds: [fixture.records[0]!] },
    ]);
    await updateRecord(server, fixture.databaseId, fixture.tableId, fixture.records[0]!, {
      [fixture.fields.name]: 'Alpha again',
    });
    await syncNow(fixture.databaseId, syncId);
    // Still three rows: the record came back into the same row rather than a duplicate.
    expect(outsideTable().records).toHaveLength(3);
    expect(valueOf(outsideTable(), fixture.records[0]!, 'Name')).toBe('Alpha again');
  });

  it('clears a field’s cells and keeps its column when the field stops being sent', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture);
    await drain();
    expect(valueOf(outsideTable(), fixture.records[0]!, 'Note')).toBe('First');

    await apply(server, fixture.databaseId, [
      { kind: 'field.trash', tableId: fixture.tableId, fieldId: fixture.fields.note },
    ]);
    await syncNow(fixture.databaseId, syncId);

    const table = outsideTable();
    // The column is still there, and its cells are cleared.
    expect(table.fields.some((f) => f.name === 'Note')).toBe(true);
    expect(valueOf(table, fixture.records[0]!, 'Note') ?? null).toBeNull();
  });

  it('stops the sync and sends nothing when its creator loses access', async () => {
    const creator = await server.addMember({ name: 'Casey Creator' });
    const fixture = await makeDatabase();
    await grant(server, fixture.databaseId, creator, 'creator');
    const syncId = await createSync(fixture, {}, creator);
    await drain();
    fake.requests.length = 0;

    await grant(server, fixture.databaseId, creator, null);
    await updateRecord(server, fixture.databaseId, fixture.tableId, fixture.records[0]!, {
      [fixture.fields.amount]: 1,
    });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'outbound_syncs')} SET next_run_at = now() - interval '1 minute' WHERE id = ${syncId}`,
    );
    await drain();

    const row = await syncRow(syncId);
    expect(row.enabled).toBe(false);
    expect(row.stopped_because).toBe('syncOut.stopped.creatorLostAccess');
    expect(fake.requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
  });

  it('holds back a removal that would take more than half of a table’s rows', async () => {
    const fixture = await makeDatabase();
    // Enough rows that losing most of them trips the guard.
    const ids = await createRecords(
      server,
      fixture.databaseId,
      fixture.tableId,
      Array.from({ length: 40 }, (_, n) => ({ [fixture.fields.name]: `Row ${n}` })),
    );
    const syncId = await createSync(fixture);
    await drain();
    expect(outsideTable().records.length).toBeGreaterThanOrEqual(43);

    await apply(server, fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: ids },
    ]);
    await syncNow(fixture.databaseId, syncId);

    // The rows are still there, and the run says why instead of removing them.
    expect(outsideTable().records.length).toBeGreaterThanOrEqual(43);
    const runs = (await call(server.owner, 'GET', `/api/sync-out/${syncId}/runs`)).json<SyncOutRuns>().runs;
    expect(runs[0]!.outcome).toBe('partial');
    expect(runs[0]!.error?.messageKey).toBe('syncOut.removal.tooMany');
  });

  it('never leaves two rows with one key after a dropped answer', async () => {
    const fixture = await makeDatabase();
    // The create write lands, then the socket drops before the answer; the idempotent retry resends
    // the same upsert, which merges on the key column, so no record ends up with two rows.
    fake.dropAnswer(`/v0/${BASE_ID}`, 1);
    const syncId = await createSync(fixture);
    await drain();

    await syncNow(fixture.databaseId, syncId);
    expect(outsideTable().records).toHaveLength(3);
  });

  it('fails before any write when the view has more rows than Airtable takes', async () => {
    const fixture = await makeDatabase();
    const adapter = (await import('./destination.js')).destinationFor('airtable')!;
    const original = adapter.limits.rows;
    // Lower the ceiling first, so the sync the command kicks off already finds too many rows.
    (adapter.limits as { rows: number }).rows = 1;
    try {
      const syncId = await createSync(fixture);
      await drain();
      expect(fake.bases[0]!.tables[0]?.records ?? []).toHaveLength(0);
      const runs = (await call(server.owner, 'GET', `/api/sync-out/${syncId}/runs`)).json<SyncOutRuns>().runs;
      expect(runs[0]!.outcome).toBe('failed');
      expect(runs[0]!.error?.messageKey).toBe('syncOut.airtable.rows');
    } finally {
      (adapter.limits as { rows: number }).rows = original;
    }
  });
});

describe('the routes’ access rules', () => {
  it('lists syncs only for people who can change the view, and names the creator', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture);
    const reader = await server.addMember({ name: 'Riley Reader' });
    await grant(server, fixture.databaseId, reader, 'reader');

    const asOwner = (
      await call(server.owner, 'GET', `/api/views/${fixture.viewId}/sync-out`)
    ).json<ViewSyncOut>();
    expect(asOwner.syncs.map((s) => s.id)).toContain(syncId);
    expect(asOwner.kinds).toEqual(['airtable']);

    const asReader = (await call(reader, 'GET', `/api/views/${fixture.viewId}/sync-out`)).json<ViewSyncOut>();
    expect(asReader.syncs).toHaveLength(0);
    expect(asReader.unavailable).toBe('syncOut.unavailable.role');

    const stranger = await server.addMember({ name: 'Olive Outside' });
    expect((await call(stranger, 'GET', `/api/views/${fixture.viewId}/sync-out`)).statusCode).toBe(404);
  });

  it('applies a command once for a repeated ID and refuses the wrong person', async () => {
    const fixture = await makeDatabase();
    const command = createInput(fixture);
    const first = await call(
      server.owner,
      'POST',
      `/api/databases/${fixture.databaseId}/sync-out/commands`,
      command,
    );
    expect(first.json<SyncOutCommandResult>().status).toBe('applied');
    const again = await call(
      server.owner,
      'POST',
      `/api/databases/${fixture.databaseId}/sync-out/commands`,
      command,
    );
    expect(again.json<SyncOutCommandResult>().status).toBe('duplicate');
    expect(again.json<SyncOutCommandResult>().sync!.id).toBe(first.json<SyncOutCommandResult>().sync!.id);

    const guest = await server.addMember({ name: 'Gale Guest', kind: 'guest' });
    const refused = await call(
      guest,
      'POST',
      `/api/databases/${fixture.databaseId}/sync-out/commands`,
      createInput(fixture),
    );
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('refuses the eleventh sync on a view', async () => {
    const fixture = await makeDatabase();
    for (let i = 0; i < 10; i += 1) await createSync(fixture);
    const response = await call(
      server.owner,
      'POST',
      `/api/databases/${fixture.databaseId}/sync-out/commands`,
      createInput(fixture),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { messageKey: string } }>().error.messageKey).toBe('syncOut.limit.perView');
  });

  it('keeps the token out of every answer, log line, and audit event', async () => {
    const fixture = await makeDatabase();
    const syncId = await createSync(fixture);
    await drain();
    const answer = await call(server.owner, 'GET', `/api/views/${fixture.viewId}/sync-out`);
    expect(answer.body).not.toContain(token);
    const audits = await query<{ metadata: unknown }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action LIKE 'data.outboundSync%'`,
    );
    expect(JSON.stringify(audits.rows)).not.toContain(token);
    const stored = await syncRow(syncId);
    // The credential is sealed, so even its stored form never holds the raw token.
    expect(stored.sealed_credential).not.toContain(token);
  });
});

async function syncRow(syncId: string) {
  const result = await query<{ enabled: boolean; stopped_because: string | null; sealed_credential: string }>(
    server.pool,
    sql`SELECT enabled, stopped_because, sealed_credential FROM ${ident(server.schemas.app, 'outbound_syncs')} WHERE id = ${syncId}`,
  );
  return result.rows[0]!;
}
