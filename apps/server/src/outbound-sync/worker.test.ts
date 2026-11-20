import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId, type SyncOutCommandResult } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { createRecords } from '../automations/automations.test-helpers.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { startFakeAirtable, type FakeAirtable } from '../test/fake-airtable.js';
import { OutboundSyncWorker } from './worker.js';

/**
 * The worker's guarantees: two servers claim one due sync once, a schedule moves the next run on,
 * a crashed server's run is reclaimed, only the last 50 runs are kept, and a sync whose policy was
 * turned off stops the next time it runs.
 */

const BASE_ID = `app${'w'.repeat(14)}`;
let kit: TestPostgres;
let server: ServerFixture;
let fake: FakeAirtable;
let token: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'syncoutwk', {
    outboundSyncPollMs: 0,
    automationsAllowPrivateHosts: true,
    logLevel: 'silent',
  });
  token = `pat${randomUUID().replace(/-/g, '')}`;
  fake = await startFakeAirtable({
    token,
    bases: [{ id: BASE_ID, name: 'Base', permissionLevel: 'create', tables: [] }],
  });
  server.ctx.outboundSyncs!.addresses.airtable = fake.url;
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

const t = () => ident(server.schemas.app, 'outbound_syncs');

async function makeSync(
  overrides: Record<string, unknown> = {},
): Promise<{ syncId: string; databaseId: string }> {
  const databaseId = newId('database');
  const tableId = newId('table');
  const viewId = newId('view');
  const name = newId('field');
  await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'D',
      table: {
        id: tableId,
        name: 'T',
        fields: [{ id: name, name: 'Name', type: 'text' }],
        view: { id: viewId, name: 'V' },
      },
    },
  });
  await createRecords(server, databaseId, tableId, [{ [name]: 'A' }, { [name]: 'B' }]);
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/sync-out/commands`,
    headers: server.owner.headers,
    payload: {
      id: newId('command'),
      action: {
        kind: 'create',
        input: {
          viewId,
          name: 'Sync',
          destination: {
            kind: 'airtable',
            baseId: BASE_ID,
            baseName: 'Base',
            table: { mode: 'new', name: `T ${newId('view')}` },
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
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return { syncId: response.json<SyncOutCommandResult>().sync!.id, databaseId };
}

const syncRow = async (syncId: string) =>
  (
    await query<{
      enabled: boolean;
      stopped_because: string | null;
      next_run_at: Date | null;
      lease_token: string | null;
      queued_again: boolean;
    }>(
      server.pool,
      sql`SELECT enabled, stopped_because, next_run_at, lease_token, queued_again FROM ${t()} WHERE id = ${syncId}`,
    )
  ).rows[0]!;

async function due(syncId: string): Promise<void> {
  await query(
    server.pool,
    sql`UPDATE ${t()} SET next_run_at = now() - interval '1 minute', lease_at = NULL, lease_token = NULL WHERE id = ${syncId}`,
  );
}

describe('the outbound sync worker', () => {
  it('lets two servers claim one due sync only once', async () => {
    const { syncId } = await makeSync();
    await server.ctx.outboundSyncs!.drain();
    await due(syncId);

    const other = new OutboundSyncWorker(server.app);
    const [a, b] = await Promise.all([server.ctx.outboundSyncs!.claim(5), other.claim(5)]);
    const claimed = [...a, ...b].filter((job) => job.id === syncId);
    expect(claimed).toHaveLength(1);
  });

  it('moves the next run on by the schedule after a run', async () => {
    const { syncId } = await makeSync({ settings: { everyMinutes: 15 } });
    await server.ctx.outboundSyncs!.drain();
    const row = await syncRow(syncId);
    expect(row.next_run_at).not.toBeNull();
    const minutes = (row.next_run_at!.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThan(16);
  });

  it('reclaims a run whose server went away', async () => {
    const { syncId } = await makeSync();
    await server.ctx.outboundSyncs!.drain();
    await query(
      server.pool,
      sql`UPDATE ${t()} SET lease_at = now() - interval '31 minutes', lease_token = 'stale', next_run_at = NULL WHERE id = ${syncId}`,
    );
    const claimed = await server.ctx.outboundSyncs!.claim(5);
    expect(claimed.some((job) => job.id === syncId)).toBe(true);
  });

  it('keeps only the newest 50 runs', async () => {
    const { syncId } = await makeSync();
    await server.ctx.outboundSyncs!.drain();
    const ids = Array.from({ length: 55 }, () => newId('job'));
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'outbound_sync_runs')} (id, sync_id, org_id, trigger, outcome)
      SELECT x, ${syncId}, ${server.owner.info.org.id}, 'schedule', 'succeeded' FROM unnest(${ids}::text[]) AS x`,
    );
    await due(syncId);
    await server.ctx.outboundSyncs!.drain();
    const count = (
      await query<{ n: number }>(
        server.pool,
        sql`SELECT count(*)::int AS n FROM ${ident(server.schemas.app, 'outbound_sync_runs')} WHERE sync_id = ${syncId}`,
      )
    ).rows[0]!.n;
    expect(count).toBeLessThanOrEqual(50);
  });

  it('sets queued_again when Sync now lands while a run is under way', async () => {
    const { syncId, databaseId } = await makeSync();
    await server.ctx.outboundSyncs!.drain();
    // Stand in for a run in flight by holding the lease.
    await query(
      server.pool,
      sql`UPDATE ${t()} SET lease_token = 'running', lease_at = now(), next_run_at = NULL WHERE id = ${syncId}`,
    );
    await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/sync-out/commands`,
      headers: server.owner.headers,
      payload: { id: newId('command'), action: { kind: 'run', syncId } },
    });
    const row = await syncRow(syncId);
    expect(row.queued_again).toBe(true);
    // The run in flight still owns the schedule, so the next run isn't moved yet.
    expect(row.next_run_at).toBeNull();
  });

  it('stops a sync whose organization turned Sync out off', async () => {
    const { syncId } = await makeSync();
    await server.ctx.outboundSyncs!.drain();
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')}
      SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{unitPolicy}', '{"values":{"syncOut":false},"overridable":[]}'::jsonb)
      WHERE id = ${server.owner.info.org.id}`,
    );
    await due(syncId);
    await server.ctx.outboundSyncs!.drain();
    const row = await syncRow(syncId);
    expect(row.enabled).toBe(false);
    expect(row.stopped_because).toBe('syncOut.stopped.policy');
    // Put the policy back for any later test.
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'unitPolicy' WHERE id = ${server.owner.info.org.id}`,
    );
  });
});
