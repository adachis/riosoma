import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TRASH_RETENTION_DAYS,
  newId,
  type DatabaseTrash,
  type GovernanceResult,
  type TrashedDatabases,
  type TrashWindow,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import {
  exportArchive,
  importArchive,
  target,
} from './organization-archives/organization-archives.test-support.js';
import { checkIntegrity } from './organization-admin/store.js';
import { retentionFor } from './governance.js';
import { lockRetention, purgeRetained, RETENTION_BATCH_SIZE } from './retention.js';
import { purgeTrash } from './purge.js';
import { purgeSyncHistory } from '../sources/history.js';
import { apply, automate, engine } from '../automations/automations.test-helpers.js';

let kit: TestPostgres;
let server: ServerFixture;
let orgId: string;

/** The organization's chain, read the way the audit screen reads it. */
const integrity = () =>
  checkIntegrity({
    db: server.pool,
    schemas: server.schemas,
    actor: {
      orgId,
      userId: server.owner.userId,
      kind: 'owner',
      adminRoles: [],
      sessionId: '',
      csrfToken: '',
    },
  });

async function policy(databaseId: string | null, auditDays: number) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: {
      kind: 'governance.apply',
      id: newId('command'),
      action: { kind: 'retention.set', databaseId, policy: { auditDays }, legalHold: false },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<GovernanceResult>().status, response.body).toBe('applied');
}

async function database() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Retention review',
      table: {
        id: tableId,
        name: 'Records',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return databaseId;
}

/** An event dated in the past, the way an event that has aged looks. */
async function agedEvent(databaseId: string, action: string, days: number) {
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.audit, 'events')} (org_id, action, at, metadata)
    VALUES (${orgId}, ${action}, now() - ${days} * interval '1 day',
    ${JSON.stringify({ databaseId, marker: randomUUID() })}::jsonb)`,
  );
}

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'retention', { automationsPollMs: 0 });
  orgId = server.owner.info.org.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('keeps the audit chain verifiable after a retention pass removes events', async () => {
  const databaseId = await database();
  expect((await integrity()).firstBreak).toBeNull();
  await policy(null, 365);
  await policy(databaseId, 365);
  await agedEvent(databaseId, 'test.expired', 400);
  await agedEvent(databaseId, 'test.kept', 100);
  expect((await integrity()).firstBreak).toBeNull();
  await purgeRetained(server.ctx);
  const left = await query(
    server.pool,
    sql`SELECT action FROM ${ident(server.schemas.audit, 'events')}
    WHERE org_id = ${orgId} AND action IN ('test.expired', 'test.kept') ORDER BY action`,
  );
  expect(left.rows).toEqual([{ action: 'test.kept' }]);
  // The removed event leaves its place and its hash behind, so the chain still verifies end to end.
  const after = await integrity();
  expect(after.firstBreak).toBeNull();
  expect(after.checked).toBeGreaterThan(0);
});

it('still finds an event that went missing without a retention pass', async () => {
  const client = await server.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE "${server.schemas.audit}".events DISABLE TRIGGER events_no_update`);
    await client.query(
      `DELETE FROM "${server.schemas.audit}".events WHERE org_id = $1 AND action = 'test.kept'`,
      [orgId],
    );
    const broken = await checkIntegrity({
      db: client,
      schemas: server.schemas,
      actor: {
        orgId,
        userId: server.owner.userId,
        kind: 'owner',
        adminRoles: [],
        sessionId: '',
        csrfToken: '',
      },
    });
    expect(broken.firstBreak).not.toBeNull();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect((await integrity()).firstBreak).toBeNull();
});

it('never keeps audit events for shorter than the unit policy floor', async () => {
  const databaseId = await database();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')}
    SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{unitPolicy}',
      ${JSON.stringify({ values: { auditRetentionDays: 2555 } })}::jsonb)
    WHERE id = ${orgId}`,
  );
  await policy(null, 365);
  expect((await retentionFor(server.pool, server.schemas, orgId)).effective.auditDays).toBe(2555);
  await agedEvent(databaseId, 'test.floored', 400);
  await purgeRetained(server.ctx);
  const kept = () =>
    query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.audit, 'events')}
      WHERE org_id = ${orgId} AND action = 'test.floored'`,
    );
  expect((await kept()).rowCount).toBe(1);
  // The log itself refuses the removal too, so a window shorter than the floor cannot be applied
  // by another path.
  const client = await server.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('riosoma.retention_purge', 'on', true)`);
    await expect(
      client.query(
        `DELETE FROM "${server.schemas.audit}".events WHERE org_id = $1 AND action = 'test.floored'`,
        [orgId],
      ),
    ).rejects.toThrow('append-only');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  expect((await kept()).rowCount).toBe(1);
  expect((await integrity()).firstBreak).toBeNull();
});

/** A retention policy for the organization or one database, the way an administrator saves it. */
async function retain(databaseId: string | null, policy: Record<string, number | null>, legalHold = false) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/admin/governance/commands',
    headers: server.owner.headers,
    payload: {
      kind: 'governance.apply',
      id: newId('command'),
      action: { kind: 'retention.set', databaseId, policy, legalHold },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json<GovernanceResult>().status, response.body).toBe('applied');
}

it('reports the trash window the countdowns and confirmations name', async () => {
  const databaseId = await database();
  const other = await database();
  const window = async (id = databaseId) => {
    const response = await server.app.inject({
      url: `/api/databases/${id}/trash-window`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<TrashWindow>();
  };
  expect(await window()).toEqual({ days: TRASH_RETENTION_DAYS, legalHold: false });
  await retain(null, { trashDays: 90 });
  expect(await window()).toEqual({ days: 90, legalHold: false });
  expect(await window(other)).toEqual({ days: 90, legalHold: false });
  await retain(databaseId, { trashDays: 7 });
  expect(await window()).toEqual({ days: 7, legalHold: false });
  expect(await window(other)).toEqual({ days: 90, legalHold: false });
  await retain(databaseId, { trashDays: null });
  expect(await window()).toEqual({ days: null, legalHold: false });
  // A hold stops purging altogether, so nothing counts down while it is on.
  await retain(databaseId, { trashDays: 7 }, true);
  expect(await window()).toEqual({ days: null, legalHold: true });
  // Both trash lists carry the same window, so a countdown needs no request of its own.
  const listed = await server.app.inject({
    url: `/api/databases/${databaseId}/trash`,
    headers: server.owner.headers,
  });
  expect(listed.statusCode, listed.body).toBe(200);
  expect(listed.json<DatabaseTrash>().retention).toEqual({ days: null, legalHold: true });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET trashed_at = now() WHERE id = ${other}`,
  );
  const trashed = await server.app.inject({ url: '/api/trash', headers: server.owner.headers });
  expect(trashed.statusCode, trashed.body).toBe(200);
  expect(trashed.json<TrashedDatabases>().databases.map((row) => row.retention)).toEqual([
    { days: 90, legalHold: false },
  ]);
  // A person who cannot open the database learns nothing about its window.
  const member = await server.addMember();
  const refused = await server.app.inject({
    url: `/api/databases/${databaseId}/trash-window`,
    headers: member.headers,
  });
  expect(refused.statusCode).toBe(404);
});

async function sourceHistory(databaseId: string, days: number, size = 1) {
  const table = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const runId = randomUUID();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sync_runs')}
    (id, table_id, started_at, ended_at, outcome) VALUES (${runId}, ${table.rows[0]!.id},
    now() - ${days} * interval '1 day', now() - ${days} * interval '1 day', 'succeeded')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'sync_record_changes')}
    (run_id, record_id, before_values, after_values)
    SELECT ${runId}, n::text, '{}'::jsonb, '{}'::jsonb FROM generate_series(1, ${size}) n`,
  );
  const remaining = async () => {
    const result = await query<{ runs: number; changes: number }>(
      server.pool,
      sql`SELECT
      (SELECT count(*)::int FROM ${ident(server.schemas.app, 'sync_runs')} WHERE id = ${runId}) AS runs,
      (SELECT count(*)::int FROM ${ident(server.schemas.app, 'sync_record_changes')} WHERE run_id = ${runId}) AS changes`,
    );
    return result.rows[0]!;
  };
  return { runId, tableId: table.rows[0]!.id, remaining };
}

it('keeps source history within the table window and honors legal holds during maintenance', async () => {
  const databaseId = await database();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'tables')} SET history_retention_days = 365 WHERE database_id = ${databaseId}`,
  );
  const history = await sourceHistory(databaseId, 100);
  await retain(databaseId, { historyDays: 1 }, true);
  await purgeSyncHistory(server.pool, server.schemas);
  expect.soft(await history.remaining()).toEqual({ runs: 1, changes: 1 });
  await retain(databaseId, { historyDays: null });
  await purgeSyncHistory(server.pool, server.schemas);
  expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
});

it.each(['governance', 'source'] as const)(
  'expires source history in bounded batches through %s retention',
  async (worker) => {
    const databaseId = await database();
    const history = await sourceHistory(databaseId, 3, RETENTION_BATCH_SIZE + 1);
    await retain(databaseId, { historyDays: 1 });
    const purge = () =>
      worker === 'governance' ? purgeRetained(server.ctx) : purgeSyncHistory(server.pool, server.schemas);
    await purge();
    expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
    await purge();
    expect(await history.remaining()).toEqual({ runs: 0, changes: 0 });
    const counts = await query<{ runs: number; changes: number }>(
      server.pool,
      sql`SELECT
    sum((metadata->'counts'->>'syncRuns')::int)::int AS runs,
    sum((metadata->'counts'->>'syncRecordChanges')::int)::int AS changes
    FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'governance.retention.purged'
      AND metadata->>'databaseId' = ${databaseId}`,
    );
    expect(counts.rows[0]).toEqual({ runs: 1, changes: RETENTION_BATCH_SIZE + 1 });
  },
);

it('serializes source purging with a newly applied legal hold', async () => {
  const databaseId = await database();
  const history = await sourceHistory(databaseId, 100);
  await retain(databaseId, { historyDays: 1 });
  const client = await server.pool.connect();
  let purging: Promise<unknown> | undefined;
  try {
    await client.query('BEGIN');
    await lockRetention(client, server.schemas, orgId, databaseId);
    await query(
      client,
      sql`UPDATE ${ident(server.schemas.app, 'databases')} SET legal_hold = true WHERE id = ${databaseId}`,
    );
    purging = purgeSyncHistory(server.pool, server.schemas);
    await client.query('COMMIT');
    await purging;
    expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await purging;
  }
});

it.each([null, 200, 30])(
  'expires source values at the shorter table or governance window of %s days',
  async (days) => {
    const databaseId = await database();
    const history = await sourceHistory(databaseId, days === 30 ? 45 : 100);
    await retain(databaseId, { historyDays: days }, true);
    await purgeRetained(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
    await retain(databaseId, { historyDays: days });
    await purgeRetained(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 0, changes: 0 });
  },
);

async function localHistory(databaseId: string, size: number) {
  const table = (
    await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
    )
  ).rows[0]!;
  const seq = 1_000_000;
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'changes')}
    (database_id, seq, org_id, table_id, command_id, group_id, kind, body, at)
    VALUES (${databaseId}, ${seq}, ${orgId}, ${table.id}, ${newId('command')}, ${newId('action')},
      'record.updated', '{}'::jsonb, now() - interval '3 days')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'record_changes')}
    (database_id, table_id, record_id, seq)
    SELECT ${databaseId}, ${table.id}, n::text, ${seq} FROM generate_series(1, ${size}) n`,
  );
  const remaining = async () =>
    (
      await query<{ history: number; records: number }>(
        server.pool,
        sql`SELECT
    (SELECT count(*)::int FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${databaseId} AND seq = ${seq}) AS history,
    (SELECT count(*)::int FROM ${ident(server.schemas.app, 'record_changes')} WHERE database_id = ${databaseId} AND seq = ${seq}) AS records`,
      )
    ).rows[0]!;
  return { remaining };
}

it('counts and bounds record history references before removing their parent change', async () => {
  const databaseId = await database();
  const history = await localHistory(databaseId, RETENTION_BATCH_SIZE + 1);
  await retain(databaseId, { historyDays: 1 });
  await purgeRetained(server.ctx);
  expect(await history.remaining()).toEqual({ history: 1, records: 1 });
  await purgeRetained(server.ctx);
  expect(await history.remaining()).toEqual({ history: 0, records: 0 });
  const counts = await query<{ records: number }>(
    server.pool,
    sql`SELECT
    sum((metadata->'counts'->>'recordChanges')::int)::int AS records
    FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'governance.retention.purged' AND metadata->>'databaseId' = ${databaseId}`,
  );
  expect(counts.rows[0]!.records).toBe(RETENTION_BATCH_SIZE + 1);
});

it.each([30, null])('preserves log windows of %s days after trashing their database', async (days) => {
  const databaseId = await database();
  const automationId = newId('automation');
  const routineId = randomUUID();
  const automationRun = randomUUID();
  const routineRun = randomUUID();
  const history = await localHistory(databaseId, RETENTION_BATCH_SIZE + 1);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'automations')}
    (id, org_id, database_id, name, position, config, webhook_secret_hash, webhook_salt)
    VALUES (${automationId}, ${orgId}, ${databaseId}, 'Retained', 0, '{}'::jsonb, ${randomUUID()}, ${randomUUID()})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
    (id, automation_id, org_id, database_id, state, trigger_kind, queued_at)
    SELECT ${automationRun} || n::text, ${automationId}, ${orgId}, ${databaseId}, 'succeeded', 'manual', now() - interval '3 days'
      FROM generate_series(1, ${RETENTION_BATCH_SIZE + 1}) n`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'rio_routines')}
    (id, org_id, database_id, owner_id, name, instructions, plan, schedule, time_zone, locale, cost_cap_usd)
    VALUES (${routineId}, ${orgId}, ${databaseId}, ${server.owner.userId}, 'Retained', '', '{}'::jsonb, '{}'::jsonb, 'UTC', 'en-US', 1)`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'rio_routine_runs')}
    (id, routine_id, org_id, trigger, state, finished_at)
    SELECT ${routineRun} || n::text, ${routineId}, ${orgId}, 'manual', 'done', now() - interval '3 days'
      FROM generate_series(1, ${RETENTION_BATCH_SIZE + 1}) n`,
  );
  await retain(databaseId, {
    trashDays: 1,
    historyDays: days,
    automationRunsDays: days,
    routineRunsDays: days,
  });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'databases')} SET trashed_at = now() - interval '3 days' WHERE id = ${databaseId}`,
  );
  const runs = async () =>
    (
      await query<{ automations: number; routines: number }>(
        server.pool,
        sql`SELECT
    (SELECT count(*)::int FROM ${ident(server.schemas.app, 'automation_runs')} WHERE automation_id = ${automationId}) AS automations,
    (SELECT count(*)::int FROM ${ident(server.schemas.app, 'rio_routine_runs')} WHERE routine_id = ${routineId}) AS routines`,
      )
    ).rows[0]!;
  await purgeTrash(server.ctx);
  expect.soft(await history.remaining()).toEqual({ history: 1, records: RETENTION_BATCH_SIZE + 1 });
  expect
    .soft(await runs())
    .toEqual({ automations: RETENTION_BATCH_SIZE + 1, routines: RETENTION_BATCH_SIZE + 1 });
  // Later organization edits do not shorten the promises attached to retired databases.
  await retain(null, { historyDays: 1, automationRunsDays: 1, routineRunsDays: 1 });
  await purgeRetained(server.ctx);
  expect.soft(await history.remaining()).toEqual({ history: 1, records: RETENTION_BATCH_SIZE + 1 });
  expect
    .soft(await runs())
    .toEqual({ automations: RETENTION_BATCH_SIZE + 1, routines: RETENTION_BATCH_SIZE + 1 });
  const later = new Date(Date.now() + 31 * 86_400_000);
  await purgeRetained(server.ctx, later);
  expect
    .soft(await history.remaining())
    .toEqual({ history: 1, records: days === null ? RETENTION_BATCH_SIZE + 1 : 1 });
  expect.soft(await runs()).toEqual({
    automations: days === null ? RETENTION_BATCH_SIZE + 1 : 1,
    routines: days === null ? RETENTION_BATCH_SIZE + 1 : 1,
  });
  await purgeRetained(server.ctx, later);
  expect(await history.remaining()).toEqual({
    history: days === null ? 1 : 0,
    records: days === null ? RETENTION_BATCH_SIZE + 1 : 0,
  });
  expect(await runs()).toEqual({
    automations: days === null ? RETENTION_BATCH_SIZE + 1 : 0,
    routines: days === null ? RETENTION_BATCH_SIZE + 1 : 0,
  });
  if (days !== null) {
    const totals = await query(
      server.pool,
      sql`SELECT sum((metadata->'counts'->>'automationRuns')::int)::int AS automations,
      sum((metadata->'counts'->>'routineRuns')::int)::int AS routines
      FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'governance.retention.purged' AND metadata->>'databaseId' = ${databaseId}`,
    );
    expect(totals.rows[0]).toEqual({
      automations: RETENTION_BATCH_SIZE + 1,
      routines: RETENTION_BATCH_SIZE + 1,
    });
  }
  await retain(null, {});
});

it.each(['table', 'database'] as const)(
  'purges a synced %s while retaining its history in counted batches',
  async (parent) => {
    const databaseId = await database();
    const history = await sourceHistory(databaseId, 3, RETENTION_BATCH_SIZE + 1);
    await retain(databaseId, { trashDays: 1, historyDays: 30 });
    const fieldId = newId('field');
    const attachmentId = newId('attachment');
    const storageKey = randomUUID();
    await apply(server, databaseId, [
      {
        kind: 'field.create',
        tableId: history.tableId,
        field: { id: fieldId, name: 'Attachment', type: 'attachment' },
      },
      { kind: 'record.create', tableId: history.tableId, records: [{ id: newId('record'), values: {} }] },
    ]);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'files')}
      (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key)
      VALUES (${attachmentId}, ${orgId}, ${history.tableId}, ${fieldId}, 'Attachment', 1, 'text/plain', ${randomUUID()}, 'postgres', ${storageKey})`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'file_chunks')} (storage_key, position, bytes)
      VALUES (${storageKey}, 0, ${Buffer.from('x')})`,
    );
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, parent === 'table' ? 'tables' : 'databases')} SET trashed_at = now() - interval '3 days'
      WHERE ${ident(parent === 'table' ? 'database_id' : 'id')} = ${databaseId}`,
    );
    await purgeTrash(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 1, changes: RETENTION_BATCH_SIZE + 1 });
    const fields = await query(
      server.pool,
      sql`SELECT f.id FROM ${ident(server.schemas.app, 'fields')} f
    JOIN ${ident(server.schemas.app, 'tables')} t ON t.id = f.table_id WHERE t.database_id = ${databaseId}`,
    );
    expect(fields.rowCount).toBe(0);
    const physical = await query(
      server.pool,
      sql`SELECT to_regclass(format('%I.%I', ${server.schemas.data}::text, ${history.tableId}::text)) AS name`,
    );
    expect(physical.rows[0]!.name).toBeNull();
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE id = ${attachmentId}`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_chunks')} WHERE storage_key = ${storageKey}`,
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT id FROM ${ident(server.schemas.app, 'views')} WHERE table_id = ${history.tableId}`,
        )
      ).rowCount,
    ).toBe(0);
    await retain(databaseId, { trashDays: 30, historyDays: 30 });
    await purgeTrash(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 1, changes: RETENTION_BATCH_SIZE + 1 });
    const restore = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: parent === 'table' ? 'table.restore' : 'database.restore',
            ...(parent === 'table' ? { tableId: history.tableId } : {}),
          },
        ],
      },
    });
    expect(restore.json().results?.[0]?.status).not.toBe('applied');
    const exported = await server.app.inject({
      method: 'POST',
      url: '/api/organization-archives/export',
      headers: server.owner.headers,
      payload: { files: false, audit: false },
    });
    expect(exported.statusCode, exported.body).toBe(200);
    await server.ctx.organizationArchives!.settled(exported.json().id);
    const job = await server.app.inject({
      url: `/api/organization-archives/${exported.json().id}`,
      headers: server.owner.headers,
    });
    expect(job.json().state, job.body).toBe('finished');
    await retain(databaseId, { trashDays: 1, historyDays: 1 });
    await purgeTrash(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
    await purgeTrash(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 0, changes: 0 });
  },
);

it.each(['automation', 'database'] as const)('ends active runs before purging their %s', async (parent) => {
  const databaseId = await database();
  const table = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
  );
  const automationId = await automate(server, databaseId, {
    trigger: { kind: 'recordCreated', tableId: table.rows[0]!.id },
    steps: [],
  });
  const ids = ['queued', 'waiting', 'running'].map(() => newId('job'));
  for (const [index, state] of ['queued', 'waiting', 'running'].entries()) {
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
      (id, automation_id, database_id, org_id, state, trigger_kind, queued_at, wake_at, lease_at)
      VALUES (${ids[index]}, ${automationId}, ${databaseId}, ${orgId}, ${state}, 'recordCreated', now() - interval '3 days', now(), now() - interval '1 hour')`,
    );
  }
  await retain(databaseId, { trashDays: 1, automationRunsDays: 30 });
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, parent === 'automation' ? 'automations' : 'databases')} SET trashed_at = now() - interval '3 days' WHERE id = ${parent === 'automation' ? automationId : databaseId}`,
  );
  await purgeTrash(server.ctx);
  const rows = await query(
    server.pool,
    sql`SELECT state, finished_at IS NOT NULL AS finished, lease_token, wake_at FROM ${ident(server.schemas.app, 'automation_runs')} WHERE id = ANY(${ids}::text[])`,
  );
  expect(rows.rows).toEqual(
    ids.map(() => ({ state: 'skipped', finished: true, lease_token: null, wake_at: null })),
  );
  await purgeRetained(server.ctx, new Date(Date.now() + 31 * 86_400_000));
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'automation_runs')} WHERE id = ANY(${ids}::text[])`,
      )
    ).rowCount,
  ).toBe(0);
});

it.each(['waiting', 'running', 'queued'] as const)(
  'claims live %s runs behind orphaned runs',
  async (state) => {
    const databaseId = await database();
    const table = await query<{ id: string }>(
      server.pool,
      sql`SELECT id FROM ${ident(server.schemas.app, 'tables')} WHERE database_id = ${databaseId}`,
    );
    const automationId = await automate(server, databaseId, {
      trigger: { kind: 'recordCreated', tableId: table.rows[0]!.id },
      steps: [],
    });
    const ids: string[] = [];
    for (let index = 0; index < 17; index++) {
      const id = newId('job');
      ids.push(id);
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
      (id, automation_id, database_id, org_id, state, trigger_kind, wake_at, lease_at)
      VALUES (${id}, ${index === 16 ? automationId : newId('automation')}, ${databaseId}, ${orgId}, ${state}, 'recordCreated', now() - interval '1 day' + ${index} * interval '1 second', now() - interval '1 hour' + ${index} * interval '1 second')`,
      );
    }
    try {
      expect((await engine(server).claim(4)).map((row) => row.id)).toContain(ids[16]);
    } finally {
      await query(
        server.pool,
        sql`DELETE FROM ${ident(server.schemas.app, 'automation_runs')} WHERE id = ANY(${ids}::text[])`,
      );
    }
  },
);

it.each(['table', 'database'] as const)('expires abandoned sync runs on a trashed %s', async (parent) => {
  const databaseId = await database();
  const history = await sourceHistory(databaseId, 3);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'sync_runs')} SET outcome = 'running', ended_at = NULL WHERE id = ${history.runId}`,
  );
  await retain(databaseId, { trashDays: 1, historyDays: 1 }, true);
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, parent === 'table' ? 'tables' : 'databases')} SET trashed_at = now() - interval '3 days' WHERE id = ${parent === 'table' ? history.tableId : databaseId}`,
  );
  await purgeTrash(server.ctx);
  expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
  await retain(databaseId, { trashDays: 1, historyDays: 1 });
  await purgeTrash(server.ctx);
  expect(await history.remaining()).toEqual({ runs: 0, changes: 0 });
});

it('expires orphaned active automation runs left by an earlier purge', async () => {
  const databaseId = await database();
  const id = newId('job');
  await retain(databaseId, { automationRunsDays: 1 });
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'automation_runs')}
    (id, automation_id, database_id, org_id, trigger_kind, state, queued_at)
    VALUES (${id}, ${newId('automation')}, ${databaseId}, ${orgId}, 'recordCreated', 'waiting', now() - interval '3 days')`,
  );
  await purgeRetained(server.ctx);
  expect(
    (
      await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'automation_runs')} WHERE id = ${id}`,
      )
    ).rowCount,
  ).toBe(0);
});

it.each(['table', 'database'] as const)(
  'round trips organization archives after purging a synced %s and its dependents',
  async (parent) => {
    const databaseId = await database();
    const history = await sourceHistory(databaseId, 3);
    const tableId = history.tableId;
    const recordId = newId('record');
    const commentId = newId('comment');
    const folderId = newId('folder');
    const pageId = newId('view');
    await apply(server, databaseId, [
      { kind: 'record.create', tableId, records: [{ id: recordId, values: {} }] },
    ]);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'folders')}
      (id, org_id, name) VALUES (${folderId}, ${orgId}, 'Retained folder')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'folder_databases')}
      (org_id, folder_id, database_id) VALUES (${orgId}, ${folderId}, ${databaseId})`,
    );
    const dependents = async () => {
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'record_rules')}
        (id, org_id, database_id, table_id, position, condition)
        VALUES (${randomUUID()}, ${orgId}, ${databaseId}, ${tableId}, 0, '{"op":"and","conditions":[]}'::jsonb)`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'record_locks')}
        (org_id, database_id, table_id, record_id) VALUES (${orgId}, ${databaseId}, ${tableId}, ${recordId})`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'booking_pages')}
        (id, org_id, database_id, table_id, settings)
        VALUES (${pageId}, ${orgId}, ${databaseId}, ${tableId}, '{}'::jsonb)`,
      );
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'payment_pages')}
        (target_id, kind, table_id, settings) VALUES (${pageId}, 'booking', ${tableId}, '{}'::jsonb)`,
      );
    };
    await dependents();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'comments')}
      (id, org_id, database_id, table_id, record_id, body)
      VALUES (${commentId}, ${orgId}, ${databaseId}, ${tableId}, ${recordId}, 'Retained comment')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'embedding_tables')}
      (org_id, database_id, table_id, user_id) VALUES (${orgId}, ${databaseId}, ${tableId}, ${server.owner.userId})`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'embeddings')}
      (org_id, database_id, table_id, source_id, model_key, digest, value)
      VALUES (${orgId}, ${databaseId}, ${tableId}, ${recordId}, ${randomUUID()}, ${randomUUID()}, ARRAY[1.0])`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'data_indexes')}
      (index_name, table_id, field_ids) VALUES (${randomUUID()}, ${tableId}, '{}'::text[])`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'column_backups')}
      (table_id, column_name, field_id) VALUES (${tableId}, 'retired', ${newId('field')})`,
    );
    const field = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'fields')} WHERE table_id = ${tableId}`,
      )
    ).rows[0]!;
    const view = (
      await query<{ id: string }>(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, 'views')} WHERE table_id = ${tableId}`,
      )
    ).rows[0]!;
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'field_permissions')}
      (field_id, org_id, database_id, table_id, locked)
      VALUES (${field.id}, ${orgId}, ${databaseId}, ${tableId}, '{"roles":["owner"],"users":[]}'::jsonb)`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'payment_fields')}
      (table_id, currency, status_field, amount_field, reference_field, choices)
      VALUES (${tableId}, 'usd', ${field.id}, ${field.id}, ${field.id}, '{}'::jsonb)`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'file_uploads')}
      (id, org_id, created_by, table_id, field_id, record_id, name, metadata, length, storage)
      VALUES (${randomUUID()}, ${orgId}, ${server.owner.userId}, ${tableId}, ${field.id}, ${recordId},
        'Pending', '', 1, 'postgres')`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'signature_requests')}
      (id, org_id, database_id, table_id, field_id, record_id, source_id, name, original_hash, expires_at, input, pages, signers)
      VALUES (${randomUUID()}, ${orgId}, ${databaseId}, ${tableId}, ${field.id}, ${recordId},
        ${randomUUID()}, 'Signature', ${randomUUID()}, now() + interval '1 day', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    );
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'report_schedules')}
      (id, org_id, database_id, table_id, view_id, owner_id, name, format, frequency, time_zone)
      VALUES (${randomUUID()}, ${orgId}, ${databaseId}, ${tableId}, ${view.id}, ${server.owner.userId},
        'Report', 'csv', '{}'::jsonb, 'UTC')`,
    );
    await retain(databaseId, { trashDays: 1, historyDays: 30, deletedCommentsDays: 30 });
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, parent === 'table' ? 'tables' : 'databases')}
      SET trashed_at = now() - interval '3 days' WHERE id = ${parent === 'table' ? tableId : databaseId}`,
    );
    await purgeTrash(server.ctx);
    expect(await history.remaining()).toEqual({ runs: 1, changes: 1 });
    for (const catalog of [
      'record_rules',
      'record_locks',
      'field_permissions',
      'booking_pages',
      'payment_pages',
      'payment_fields',
      'signature_requests',
      'report_schedules',
      'file_uploads',
      'embedding_tables',
      'embeddings',
      'data_indexes',
      'column_backups',
    ]) {
      const remaining = await query(
        server.pool,
        sql`SELECT 1 FROM ${ident(server.schemas.app, catalog)} WHERE table_id = ${tableId}`,
      );
      expect.soft(remaining.rowCount, catalog).toBe(0);
    }
    const comment = await query(
      server.pool,
      sql`SELECT table_id FROM ${ident(server.schemas.app, 'comments')} WHERE id = ${commentId}`,
    );
    expect.soft(comment.rows).toEqual([{ table_id: null }]);
    const folders = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'folder_databases')} WHERE database_id = ${databaseId}`,
    );
    expect.soft(folders.rowCount).toBe(parent === 'database' ? 0 : 1);
    const roundTrip = async () => {
      const archive = await exportArchive(server, { files: false, audit: false });
      const destination = await target(kit, 'retention_archive');
      try {
        await importArchive(destination.server, archive.bytes);
        for (const catalog of ['record_rules', 'record_locks', 'booking_pages', 'payment_pages']) {
          const restored = await query(
            destination.server.pool,
            sql`SELECT 1 FROM ${ident(destination.server.schemas.app, catalog)}`,
          );
          expect(restored.rowCount, catalog).toBe(0);
        }
      } finally {
        await destination.server.close();
      }
    };
    await roundTrip();
    // Archives also exclude remnants left by purges that ran before dependent cleanup existed.
    await dependents();
    if (parent === 'database')
      await query(
        server.pool,
        sql`INSERT INTO ${ident(server.schemas.app, 'folder_databases')}
        (org_id, folder_id, database_id) VALUES (${orgId}, ${folderId}, ${databaseId})`,
      );
    await roundTrip();
  },
);
