import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import {
  newId,
  type RowsPage,
  type SqlAccess,
  type SqlHistory,
  type SqlLogin,
  type SqlResult,
} from '@riosoma/contracts';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import {
  applied,
  command,
  permissionFixture,
  inject,
  SALARY,
  type PermissionFixture,
} from '../data/permissions/permissions.test-helpers.js';
import { purgeTrash } from '../data/purge.js';
import { closeLogins, refreshLogins, withoutBlockers } from './login.js';
import { forgetQueryRole, queryRole } from './role.js';
import { publicSchemaCreates, REVOKE_PUBLIC_CREATE } from './schema.js';
import { SQL_VIEWS_REFRESH } from './refresh.js';

let kit: TestPostgres;
let server: ServerFixture;
let fixture: PermissionFixture;
const settings = { roles: ['owner', 'creator', 'editor', 'reader'], timeoutMs: 15_000, rowCap: 10_000 };
const SLOW =
  'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n';
const refreshEveryMs = SQL_VIEWS_REFRESH.everyMs;
beforeAll(async () => {
  // These cases drive refresh explicitly, so scheduled passes cannot race their view assertions.
  SQL_VIEWS_REFRESH.everyMs = 60 * 60_000;
  kit = await startTestPostgres();
  // The per-minute limit has its own server below, so the many runs here never reach it.
  server = await startServer(kit, 'sqlaccess', { sqlMinuteLimit: 1_000_000, sqlOutsideLogins: true });
  fixture = await permissionFixture(server);
  const response = await inject(server, server.owner, 'PUT', base('/settings'), settings);
  expect(response.statusCode, response.body).toBe(200);
}, 120_000);
afterAll(async () => {
  try {
    await server?.close();
    await kit?.stop();
  } finally {
    SQL_VIEWS_REFRESH.everyMs = refreshEveryMs;
  }
});
const base = (path = '') => `/api/databases/${fixture.databaseId}/sql${path}`;
const run = (who: SignedIn, source: string, id = randomUUID()) =>
  inject(server, who, 'POST', base('/run'), { id, query: source });

const adminRoles = (who: SignedIn, roles: string[]) =>
  query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'memberships')} SET admin_roles = ${roles}::text[] WHERE user_id = ${who.userId}`,
  );
const westRule = (change: 'add' | 'remove', who: SignedIn) =>
  query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'record_rules')}
    SET users = ${change === 'add' ? sql`array_append(users, ${who.userId}::text)` : sql`array_remove(users, ${who.userId}::text)`}
    WHERE table_id = ${fixture.people.tableId} AND roles = ARRAY['editor']::text[]`,
  );

/**
 * A connection as a login.  The server ends a login's sessions when it closes the login, which is
 * no failure of the test that held one.
 */
async function outsideClient(target: ServerFixture, login: SqlLogin): Promise<pg.Client> {
  const client = new pg.Client({ ...target.pool.options, user: login.role, password: login.password });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}
const loginClient = (login: SqlLogin) => outsideClient(server, login);

const backendOf = async (client: pg.Client) =>
  (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
/** Waits until PostgreSQL has ended a session.  Ending one is asked for, and then takes a moment. */
const ended = (target: ServerFixture, pid: number) =>
  expect
    .poll(
      async () =>
        (await target.pool.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid])).rowCount,
      { timeout: 20_000, interval: 25 },
    )
    .toBe(0);

/** A new person with a role in the fixture's database, for tests that delete people. */
async function member(role: string): Promise<SignedIn> {
  const who = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${server.owner.info.org.id}, 'database', ${fixture.databaseId}, 'user', ${who.userId}, ${role})`,
  );
  return who;
}

/** A connection of its own, so what it sees never waits on the server's pools. */
async function observer<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ ...server.pool.options });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Which SQL runs hold connections of the app's pool.  Requests sent inside `as` carry their run's
 * ID, so the server's own workers, which share that pool, never count as a run's.
 */
function appPoolHolders(pool: pg.Pool) {
  type Done = (release?: unknown) => void;
  type Callback = (error: Error | undefined, client: pg.PoolClient | undefined, done: Done) => void;
  const runs = new AsyncLocalStorage<string>();
  const holders = new Map<pg.PoolClient, string>();
  const connect = pool.connect;
  const withCallback = connect as unknown as (this: pg.Pool, callback: Callback) => void;
  const promised = connect as unknown as (this: pg.Pool) => Promise<pg.PoolClient>;
  const hold = (id: string | undefined, client: pg.PoolClient | undefined) => {
    if (id !== undefined && client) holders.set(client, id);
  };
  pool.connect = function (this: pg.Pool, callback?: Callback) {
    const id = runs.getStore();
    if (callback)
      return withCallback.call(this, (error, client, done) => {
        hold(id, client);
        callback(error, client, done);
      });
    return promised.call(this).then((client) => {
      hold(id, client);
      return client;
    });
  } as pg.Pool['connect'];
  const released = (_error: unknown, client: pg.PoolClient) => holders.delete(client);
  pool.on('release', released);
  return {
    as: <T>(id: string, work: () => T): T => runs.run(id, work),
    /** How many of the app pool's connections these runs hold right now */
    heldBy: (ids: readonly string[]) => [...holders.values()].filter((id) => ids.includes(id)).length,
    stop() {
      pool.connect = connect;
      pool.off('release', released);
    },
  };
}

const loginObjects = (login: SqlLogin) =>
  observer(
    async (client) =>
      (
        await client.query<{ count: number }>(
          `SELECT ((SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname = $1)
          + (SELECT count(*) FROM pg_catalog.pg_namespace WHERE nspname = $2))::int AS count`,
          [login.role, login.schema],
        )
      ).rows[0]!.count,
  );

/**
 * Gives PUBLIC back what a new PostgreSQL database grants every role, the way a database stands
 * before any setup SQL has run in it.
 */
async function restorePublicDefaults(admin: pg.Pool): Promise<void> {
  const routines = await admin.query<{ name: string }>(
    `SELECT format('pg_catalog.%I(%s)', proname, pg_catalog.oidvectortypes(proargtypes)) AS name
    FROM pg_catalog.pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace
    AND (proname ~ '^pg_(try_)?advisory_' OR proname ~ '^(lo_(?!import|export).*|loread|lowrite)$'
      OR proname IN ('pg_get_viewdef', 'pg_get_ruledef', 'pg_logical_emit_message'))`,
  );
  await admin.query(
    `GRANT EXECUTE ON FUNCTION ${routines.rows.map((routine) => routine.name).join(', ')} TO PUBLIC`,
  );
  await admin.query('GRANT SELECT ON pg_catalog.pg_rewrite TO PUBLIC');
  const database = (await admin.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
  await admin.query(`GRANT TEMPORARY ON DATABASE "${database}" TO PUBLIC`);
}

/**
 * Runs with the server connected as an account that owns its schemas' objects but can't create
 * roles, the way a minimal-privilege installation connects.  PUBLIC holds its defaults again, so
 * the account has only what such an installation gives it until the administrator SQL runs.
 */
async function asLimitedAccount(
  fn: (role: string, limited: pg.Pool) => Promise<void>,
  target: ServerFixture = server,
): Promise<void> {
  const role = `sql_app_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomUUID();
  const admin = target.pool;
  await restorePublicDefaults(admin);
  await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);
  for (const schema of Object.values(target.schemas)) {
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "${schema}" TO "${role}"`);
  }
  const limited = new pg.Pool({ ...admin.options, user: role, password });
  target.ctx.pool = limited;
  try {
    await fn(role, limited);
  } finally {
    target.ctx.pool = admin;
    await limited.end();
    await admin.query(`DROP OWNED BY "${role}" CASCADE`);
    await admin.query(`DROP ROLE "${role}"`);
  }
}

describe('permission aware SQL on PostgreSQL', () => {
  it.each(['query', 'login'] as const)(
    'revokes PUBLIC schema creation during %s setup while preserving other grants',
    async (kind) => {
      const writer = `sql_writer_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
      await server.pool.query(`CREATE ROLE "${writer}" NOLOGIN`);
      let client: pg.Client | undefined;
      try {
        await server.pool.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
        await server.pool.query(`GRANT CREATE ON SCHEMA public TO "${writer}"`);
        expect(await publicSchemaCreates(server.pool)).toBe(true);
        let role: string;
        if (kind === 'query') {
          forgetQueryRole(server.pool);
          const state = await queryRole(server.pool, server.schemas);
          expect(state.active).toBe(true);
          expect(state.reason).toBeUndefined();
          role = state.role;
          client = new pg.Client({ ...server.pool.options });
        } else {
          const enabled = await inject(server, server.owner, 'POST', base('/login'), {
            action: 'enable',
            personId: fixture.persons.reader.signed.userId,
          });
          expect(enabled.statusCode, enabled.body).toBe(200);
          const login = enabled.json<SqlLogin>();
          expect(login.ready).toBe(true);
          expect(login.reason).toBeUndefined();
          role = login.role;
          client = new pg.Client({ ...server.pool.options, user: role, password: login.password });
        }
        expect(await publicSchemaCreates(server.pool)).toBe(false);
        const privileges = await server.pool.query(
          `SELECT has_schema_privilege($1, 'public', 'CREATE') AS writer,
            has_schema_privilege($2, 'public', 'USAGE') AS usage,
            has_schema_privilege($2, 'public', 'CREATE') AS creates`,
          [writer, role],
        );
        expect(privileges.rows).toEqual([{ writer: true, usage: true, creates: false }]);
        await client.connect();
        // Session defaults are optional; privileges must block creation even in a writable transaction.
        await client.query('SET default_transaction_read_only = off');
        await client.query('BEGIN');
        if (kind === 'query') await client.query(`SET LOCAL ROLE "${role}"`);
        for (const statement of [
          'CREATE TABLE public.sql_forbidden (id integer)',
          'CREATE VIEW public.sql_forbidden AS SELECT 1',
          'CREATE FUNCTION public.sql_forbidden() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$',
          'CREATE SCHEMA sql_forbidden',
        ]) {
          await client.query('SAVEPOINT attempt');
          await expect(client.query(statement), statement).rejects.toMatchObject({ code: '42501' });
          await client.query('ROLLBACK TO SAVEPOINT attempt');
        }
      } finally {
        await client?.end();
        if (kind === 'login')
          await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
        await server.pool.query(REVOKE_PUBLIC_CREATE);
        await server.pool.query(`DROP OWNED BY "${writer}"`);
        await server.pool.query(`DROP ROLE "${writer}"`);
        forgetQueryRole(server.pool);
      }
    },
  );
  it('returns exactly the records the API exposes for the same query', async () => {
    for (const who of [fixture.persons.reader.signed, fixture.persons.editor.signed]) {
      const response = await run(who, 'SELECT "Name" FROM "People" ORDER BY "Name"');
      expect(response.statusCode, response.body).toBe(200);
      const api = await inject(server, who, 'GET', `/api/views/${fixture.people.viewId}/rows?limit=100`);
      const names = api
        .json<RowsPage>()
        .rows.flatMap((row) => (row ? [row.values[fixture.people.fields.name]] : []))
        .sort();
      expect(response.json<SqlResult>().rows).toEqual(names.map((name) => [name]));
    }
  });
  it('distinguishes two editors only by their record rule', async () => {
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'record_rules')} SET roles = ARRAY[]::text[], users = ${[fixture.persons.editor.signed.userId, fixture.persons.limitedCreator.signed.userId]}::text[] WHERE table_id = ${fixture.people.tableId} AND roles = ARRAY['editor']::text[]`,
    );
    try {
      const source = 'SELECT "Name", "Notes" FROM "People" ORDER BY "Name"';
      const limited = (await run(fixture.persons.editor.signed, source)).json<SqlResult>();
      const full = (await run(fixture.persons.lead.signed, source)).json<SqlResult>();
      expect(limited.columns).toEqual(full.columns);
      expect(limited.rows).toEqual(full.rows.filter((row) => row[0] === 'Ana West'));
      expect(full.rowCount).toBe(3);
      expect(limited.rowCount).toBe(1);
      const guarded = await run(
        fixture.persons.editor.signed,
        `SELECT "Name" FROM "People" WHERE 1 / CASE WHEN "Name" = 'Zanzibar East' THEN 0 ELSE 1 END = 1`,
      );
      expect(guarded.statusCode, guarded.body).toBe(200);
    } finally {
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'record_rules')} SET roles = ARRAY['editor']::text[], users = ${[fixture.persons.limitedCreator.signed.userId]}::text[] WHERE table_id = ${fixture.people.tableId} AND ${fixture.persons.editor.signed.userId} = ANY(users)`,
      );
    }
  });
  it('keeps restricted fields unknown by both friendly and physical name', async () => {
    const who = fixture.persons.editor.signed;
    const catalog = await inject(server, who, 'GET', base());
    expect(
      catalog
        .json<SqlAccess>()
        .tables.find((table) => table.name === 'People')
        ?.fields.map((field) => field.name),
    ).not.toContain('Salary');
    for (const field of ['Salary', fixture.people.fields.salary, '__rid', '__created_by']) {
      const response = await run(who, `SELECT "${field}" FROM "People"`);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.messageKey).toBe('sql.run.column');
      expect(response.body).not.toContain('Salary');
    }
    const locked = await run(who, 'SELECT "Notes" FROM "People"');
    expect(locked.statusCode, locked.body).toBe(200);
  });
  it('keeps hidden links and aggregates scoped to the reader', async () => {
    const response = await run(fixture.persons.editor.signed, 'SELECT * FROM "Teams"');
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<SqlResult>();
    const link = result.rows[0]?.find(
      (value) => value && typeof value === 'object' && 'hiddenCount' in value,
    );
    expect(link).toEqual({ records: [fixture.people.records.ana], hiddenCount: 2 });
    expect(Number(result.rows[0]?.[result.columns.indexOf('Headcount')])).toBe(1);
  });
  it('records successful and refused runs in the audit log and personal history', async () => {
    const source = 'SELECT "Name" FROM "People"';
    const response = await run(fixture.persons.editor.signed, source);
    const result = response.json<SqlResult>();
    await run(fixture.persons.editor.signed, 'SELECT pg_sleep(1)');
    const events = await query<{
      metadata: { query: string; rowCount: number; durationMs: number; error: string | null };
    }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'databases.sql.executed' AND actor_id = ${fixture.persons.editor.signed.userId} ORDER BY id DESC`,
    );
    expect(
      events.rows.some(
        (row) => row.metadata.query === source && row.metadata.rowCount === 1 && row.metadata.durationMs >= 0,
      ),
    ).toBe(true);
    expect(events.rows.some((row) => row.metadata.error === 'sql.guard.function')).toBe(true);
    const history = await inject(server, fixture.persons.editor.signed, 'GET', base('/history'));
    expect(history.json().some((item: { id: string }) => item.id === result.id)).toBe(true);
    const other = await inject(server, fixture.persons.reader.signed, 'GET', base(`/runs/${result.id}`));
    expect(other.statusCode).toBe(404);
  });
  it('caps rows and applies the statement timeout', async () => {
    await inject(server, server.owner, 'PUT', base('/settings'), { ...settings, rowCap: 2 });
    const capped = await run(server.owner, 'SELECT "Name" FROM "People" ORDER BY "Name"');
    expect(capped.statusCode, capped.body).toBe(200);
    expect(capped.json<SqlResult>()).toMatchObject({ rowCount: 2, capped: true });
    // A short timeout only for the slow query, since even a two-row read can take over 10 ms on a
    // busy machine.  The recursive count below runs for many seconds.
    await inject(server, server.owner, 'PUT', base('/settings'), { ...settings, rowCap: 2, timeoutMs: 500 });
    const slow = await run(
      server.owner,
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT sum(x) FROM n',
    );
    expect(slow.statusCode).toBe(422);
    expect(slow.json().error.messageKey).toBe('sql.run.stopped');
    await inject(server, server.owner, 'PUT', base('/settings'), settings);
  });
  it('cancels an active query without canceling another person', async () => {
    const id = randomUUID();
    const pending = run(
      server.owner,
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 100000000) SELECT sum(x) FROM n',
      id,
    );
    await expect
      .poll(
        async () =>
          Boolean(
            (
              await query(
                server.pool,
                sql`SELECT id FROM ${ident(server.schemas.app, 'sql_history')} WHERE id = ${id} AND backend_pid IS NOT NULL`,
              )
            ).rowCount,
          ),
        { timeout: 5000, interval: 20 },
      )
      .toBe(true);
    await inject(server, fixture.persons.reader.signed, 'POST', base(`/runs/${id}/cancel`), {});
    const untouched = await query<{ canceled: boolean }>(
      server.pool,
      sql`SELECT canceled FROM ${ident(server.schemas.app, 'sql_history')} WHERE id = ${id}`,
    );
    expect(untouched.rows[0]?.canceled).toBe(false);
    const cancelStarted = performance.now();
    const response = await inject(server, server.owner, 'POST', base(`/runs/${id}/cancel`), {});
    expect(response.statusCode).toBe(200);
    expect((await pending).json().error.messageKey).toBe('sql.run.stopped');
    expect(performance.now() - cancelStarted).toBeLessThan(5000);
  });
  it('exports the stored result as CSV and Excel through the download path', async () => {
    const result = (await run(server.owner, "SELECT '=2+3' AS value")).json<SqlResult>();
    const csv = await inject(server, server.owner, 'GET', base(`/runs/${result.id}?format=csv`));
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain("'=2+3");
    const excel = await inject(server, server.owner, 'GET', base(`/runs/${result.id}?format=xlsx`));
    expect(excel.statusCode, excel.body).toBe(200);
    expect(excel.headers['content-type']).toContain('spreadsheetml');
  });
  it('refuses attribute notation that would call a function on the whole row', async () => {
    for (const source of [
      'SELECT p.pg_typeof FROM "People" p',
      'SELECT p.pg_column_size FROM "People" p',
      'SELECT p.hash_record FROM "People" p',
      'SELECT p.count FROM "People" p',
      'SELECT p."Name" FROM "People" p WHERE p.pg_column_size > 0 ORDER BY p.hash_record',
      'WITH c AS (SELECT 1 AS a) SELECT c.pg_typeof FROM c',
      'SELECT j.pg_typeof FROM ("People" p JOIN "Teams" t ON true) AS j',
      'SELECT count(*) FROM "People" p GROUP BY p.pg_typeof',
    ]) {
      const response = await run(fixture.persons.editor.signed, source);
      expect(response.statusCode, source).toBe(422);
      expect(response.json().error.messageKey, source).toBe('sql.run.column');
    }
    const named = await run(
      fixture.persons.editor.signed,
      'SELECT s.count FROM (SELECT count(*) AS count FROM "People") s',
    );
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json<SqlResult>().rows).toEqual([['1']]);
  });
  it('lets a recursive WITH list refer forward to a later member', async () => {
    const response = await run(
      fixture.persons.editor.signed,
      `WITH RECURSIVE a AS (SELECT * FROM "People"), "People" AS (SELECT 'fake' AS "Name") SELECT * FROM a`,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SqlResult>().rows).toEqual([['fake']]);
  });
  it('reports durations to the nearest 100 ms', async () => {
    const who = fixture.persons.editor.signed;
    const ids: string[] = [];
    for (const source of ['SELECT "Name" FROM "People"', 'SELECT 1', 'SELECT count(*) FROM "Teams"']) {
      const response = await run(who, source);
      expect(response.statusCode, response.body).toBe(200);
      const result = response.json<SqlResult>();
      expect(result.durationMs % 100, source).toBe(0);
      ids.push(result.id);
    }
    const history = (await inject(server, who, 'GET', base('/history'))).json<SqlHistory[]>();
    expect(history.filter((item) => ids.includes(item.id)).map((item) => item.durationMs % 100)).toEqual([
      0, 0, 0,
    ]);
    const events = await query<{ metadata: { durationMs: number } }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'databases.sql.executed' AND actor_id = ${who.userId}`,
    );
    expect(events.rows.filter((row) => row.metadata.durationMs % 100 !== 0)).toEqual([]);
  });
  it('returns date-only fields as ISO dates whatever the server time zone', async () => {
    const started = newId('field');
    const change = (input: Record<string, unknown>) =>
      applied(server, server.owner, fixture.databaseId, input);
    await change({
      kind: 'field.create',
      tableId: fixture.people.tableId,
      field: { id: started, name: 'Started', type: 'date', description: '', options: { includeTime: false } },
    });
    try {
      await change({
        kind: 'record.update',
        tableId: fixture.people.tableId,
        records: [{ id: fixture.people.records.ana, values: { [started]: '2026-01-05' } }],
      });
      const zone = process.env.TZ;
      // East of UTC, a local midnight is the day before in UTC.
      process.env.TZ = 'Pacific/Kiritimati';
      let response;
      try {
        response = await run(
          fixture.persons.editor.signed,
          'SELECT "Started", "Started" + 1 AS next, ARRAY["Started"] AS days FROM "People"',
        );
      } finally {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
      }
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<SqlResult>().rows).toEqual([['2026-01-05', '2026-01-06', ['2026-01-05']]]);
      const grid = await inject(
        server,
        fixture.persons.editor.signed,
        'GET',
        `/api/views/${fixture.people.viewId}/rows?limit=100`,
      );
      expect(
        grid.json<RowsPage>().rows.find((row) => row?.id === fixture.people.records.ana)?.values[started],
      ).toBe('2026-01-05');
    } finally {
      await change({ kind: 'field.trash', fieldId: started });
    }
  });
  it('runs editor queries as a role that reads only the data schema', async () => {
    const access = (await inject(server, server.owner, 'GET', base())).json<SqlAccess>();
    expect(access.queryRole).toMatchObject({ active: true });
    const role = access.queryRole!.role;
    const table = `"${server.schemas.data}"."${fixture.people.tableId}"`;
    const client = await server.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE "${role}"`);
      expect((await client.query(`SELECT count(*) FROM ${table}`)).rowCount).toBe(1);
      // Only the names that link names and attachment rules read are open outside the data schema.
      await client.query(`SELECT id, name FROM "${server.schemas.app}"."users"`);
      await client.query(`SELECT id, name, field_id, table_id FROM "${server.schemas.app}"."files"`);
      for (const forbidden of [
        `SELECT * FROM "${server.schemas.app}"."users"`,
        `SELECT * FROM "${server.schemas.app}"."sql_logins"`,
        `SELECT * FROM "${server.schemas.audit}"."events"`,
        `DELETE FROM ${table}`,
      ]) {
        await client.query('SAVEPOINT attempt');
        await expect(client.query(forbidden), forbidden).rejects.toMatchObject({ code: '42501' });
        await client.query('ROLLBACK TO SAVEPOINT attempt');
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    // Without the role's grant on a table, a query that reads it fails, so queries run as the role.
    forgetQueryRole(server.pool);
    await queryRole(server.pool, server.schemas);
    await server.pool.query(`REVOKE SELECT ON ${table} FROM "${role}"`);
    try {
      const denied = await run(fixture.persons.editor.signed, 'SELECT "Name" FROM "People"');
      expect(denied.statusCode, denied.body).toBe(422);
      expect(denied.json().error.messageKey).toBe('sql.run.failed');
    } finally {
      forgetQueryRole(server.pool);
    }
    const restored = await run(fixture.persons.editor.signed, 'SELECT "Name" FROM "People"');
    expect(restored.statusCode, restored.body).toBe(200);
  });
  it('lets an admin whose own access is limited read only as themselves', async () => {
    const editor = fixture.persons.editor.signed;
    await adminRoles(editor, ['security']);
    try {
      for (const person of [fixture.persons.hr, fixture.persons.reader]) {
        const wider = await inject(server, editor, 'POST', base('/login'), {
          action: 'enable',
          personId: person.signed.userId,
        });
        expect(wider.statusCode, wider.body).toBe(403);
        expect(wider.json().error.messageKey).toBe('sql.login.widen');
      }
      const self = await inject(server, editor, 'POST', base('/login'), {
        action: 'enable',
        personId: editor.userId,
      });
      expect(self.statusCode, self.body).toBe(200);
      const login = self.json<SqlLogin>();
      expect(login.ready, JSON.stringify(login)).toBe(true);
      const client = await loginClient(login);
      try {
        expect((await client.query('SELECT "Name" FROM "People"')).rows).toEqual([{ Name: 'Ana West' }]);
      } finally {
        await client.end();
      }
      // Rotating someone else's broader login would hand over its password, so it's refused too.
      const broader = await inject(server, server.owner, 'POST', base('/login'), {
        action: 'enable',
        personId: fixture.persons.hr.signed.userId,
      });
      expect(broader.statusCode, broader.body).toBe(200);
      const rotated = await inject(server, editor, 'POST', base('/login'), { action: 'rotate' });
      expect(rotated.statusCode, rotated.body).toBe(403);
      expect(rotated.json().error.messageKey).toBe('sql.login.widen');
      expect(rotated.json().password).toBeUndefined();
    } finally {
      await adminRoles(editor, []);
      await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
    }
  });
  it('turns the login off once the person it reads as outgrows the admin who enabled it', async () => {
    const hr = fixture.persons.hr.signed;
    await adminRoles(hr, ['security']);
    let client: pg.Client | undefined;
    try {
      const enabled = await inject(server, hr, 'POST', base('/login'), {
        action: 'enable',
        personId: fixture.persons.reader.signed.userId,
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const login = enabled.json<SqlLogin>();
      expect(login.ready, JSON.stringify(login)).toBe(true);
      client = await loginClient(login);
      expect((await client.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
      // Hana now sees only the West, and Rae still sees every record.
      await westRule('add', hr);
      await refreshLogins(server.pool, server.schemas);
      const status = (await inject(server, server.owner, 'GET', base('/login'))).json<SqlLogin>();
      expect(status).toMatchObject({ enabled: false, ready: false });
      await expect(client.query('SELECT "Name" FROM "People"')).rejects.toBeDefined();
      const events = await query<{ metadata: Record<string, unknown> }>(
        server.pool,
        sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'databases.sql.loginDisabled'`,
      );
      expect(events.rows.map((row) => row.metadata)).toEqual([
        {
          databaseId: fixture.databaseId,
          personId: fixture.persons.reader.signed.userId,
          enabledBy: hr.userId,
          reason: 'widened',
        },
      ]);
    } finally {
      await client?.end().catch(() => undefined);
      await westRule('remove', hr);
      await adminRoles(hr, []);
      await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
    }
  });
  it('gives an outside login exactly the chosen person’s API records and no base table access', async () => {
    const response = await inject(server, server.owner, 'POST', base('/login'), {
      action: 'enable',
      personId: fixture.persons.editor.signed.userId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const login = response.json<SqlLogin>();
    expect(login.ready, JSON.stringify(login)).toBe(true);
    const client = await loginClient(login);
    try {
      const result = await client.query('SELECT "Name" FROM "People" ORDER BY "Name"');
      expect(result.rows).toEqual([{ Name: 'Ana West' }]);
      await expect(
        client.query(`SELECT * FROM "${server.schemas.data}"."${fixture.people.tableId}"`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT "Salary" FROM "People"')).rejects.toMatchObject({ code: '42703' });
      await client.query('SET default_transaction_read_only = off');
      await expect(client.query('DELETE FROM "People"')).rejects.toMatchObject({ code: '55000' });
      const saved = (
        await run(fixture.persons.editor.signed, 'SELECT "Name" FROM "People"')
      ).json<SqlResult>();
      await query(
        server.pool,
        sql`UPDATE ${ident(server.schemas.app, 'grants')} SET role = 'reader' WHERE principal_id = ${fixture.persons.editor.signed.userId} AND resource_id = ${fixture.databaseId}`,
      );
      await expect(client.query('SELECT * FROM "People"')).rejects.toMatchObject({ code: '42P01' });
      expect(
        (await inject(server, fixture.persons.editor.signed, 'GET', base(`/runs/${saved.id}`))).statusCode,
      ).toBe(404);
      await refreshLogins(server.pool, server.schemas);
      expect((await client.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
      const disabled = await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json<SqlLogin>()).toMatchObject({ enabled: false, ready: false });
      await expect(client.query('SELECT * FROM "People"')).rejects.toBeDefined();
    } finally {
      await client.end();
    }
  });
  it('refuses an outside login advisory locks, temporary tables, large objects, a lifted disk limit, and view text', async () => {
    const response = await inject(server, server.owner, 'POST', base('/login'), {
      action: 'enable',
      personId: fixture.persons.editor.signed.userId,
    });
    expect(response.statusCode, response.body).toBe(200);
    const login = response.json<SqlLogin>();
    expect(login.ready, JSON.stringify(login)).toBe(true);
    const client = await loginClient(login);
    try {
      // The client lifts every limit that is a session default, so privileges refuse each of these.
      await client.query('SET default_transaction_read_only = off');
      await client.query('SET statement_timeout = 0');
      for (const statement of [
        'SELECT pg_advisory_lock(1)',
        'SELECT pg_advisory_lock_shared(1)',
        'SELECT pg_advisory_xact_lock(1)',
        'SELECT pg_advisory_xact_lock_shared(1, 2)',
        'SELECT pg_try_advisory_lock(1)',
        'SELECT pg_try_advisory_xact_lock(1, 2)',
        'CREATE TEMP TABLE filler AS SELECT 1 AS x',
        'SET temp_file_limit = -1',
        // Large objects are permanent and no limit on temporary files covers them.
        'SELECT lo_create(0)',
        'SELECT lo_creat(-1)',
        `SELECT lo_from_bytea(0, '\\x00')`,
        'SELECT lo_open(1, 131072)',
        `SELECT lowrite(0, '\\x00')`,
        `SELECT lo_put(1, 0, '\\x00')`,
        'SELECT lo_truncate(0, 0)',
        'SELECT lo_truncate64(0, 0)',
        `SELECT pg_logical_emit_message(false, 'filler', 'x')`,
        `SELECT pg_get_viewdef('"People"'::regclass)`,
        'SELECT definition FROM pg_catalog.pg_views',
        'SELECT ev_action FROM pg_catalog.pg_rewrite',
      ])
        await expect(client.query(statement), statement).rejects.toMatchObject({ code: '42501' });
      expect((await client.query('SHOW temp_file_limit')).rows).toEqual([{ temp_file_limit: '1GB' }]);
      const lockers = await server.pool.query(
        `SELECT p.oid::regprocedure::text AS name FROM pg_catalog.pg_proc p
        WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname ~ '^pg_(try_)?advisory_.*lock'
        AND p.proname !~ 'unlock' AND has_function_privilege($1, p.oid, 'EXECUTE')`,
        [login.role],
      );
      expect(lockers.rows).toEqual([]);
      // The login still reads its views.
      expect((await client.query('SELECT "Name" FROM "People"')).rowCount).toBeGreaterThan(0);
      // A role that came to own something, as one made before these were refused could, still goes.
      const owned = (await server.pool.query<{ oid: number }>('SELECT lo_create(0) AS oid')).rows[0]!.oid;
      await server.pool.query(`ALTER LARGE OBJECT ${owned} OWNER TO "${login.role}"`);
    } finally {
      await client.end();
      await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
    }
    expect(await loginObjects(login)).toBe(0);
  });
  it('keeps app requests fast while editor queries fill their own pool', async () => {
    await inject(server, server.owner, 'PUT', base('/settings'), { ...settings, timeoutMs: 120_000 });
    const people = [
      server.owner,
      fixture.persons.hr.signed,
      fixture.persons.lead.signed,
      fixture.persons.editor.signed,
      fixture.persons.reader.signed,
    ];
    // The server's own workers share the app pool, so a moment when it has someone waiting says
    // nothing about the editor.  What app requests must never wait behind is an editor query
    // holding one of the app pool's connections while it runs.
    const holders = appPoolHolders(server.pool);
    // Two runs each, more than the app's own pool holds.  One of each pair has to wait its turn.
    const runs = people.flatMap((who) =>
      [randomUUID(), randomUUID()].map((id) => ({
        who,
        id,
        response: holders.as(id, () => run(who, SLOW, id)),
      })),
    );
    const ids = runs.map((item) => item.id);
    /** The runs whose editor query is running now, past the bookkeeping before it */
    const querying = () =>
      observer(async (client) =>
        (
          await client.query<{ id: string }>(
            `SELECT substr(application_name, 9) AS id FROM pg_catalog.pg_stat_activity
              WHERE application_name LIKE 'rio_sql:%' AND state = 'active' AND query ILIKE '%recursive%'`,
          )
        ).rows.map((row) => row.id),
      );
    try {
      await expect
        .poll(async () => (await querying()).length, { timeout: 20_000, interval: 50 })
        .toBeGreaterThanOrEqual(3);
      const started = performance.now();
      const answers = await Promise.all(
        people.map((who) => inject(server, who, 'GET', `/api/databases/${fixture.databaseId}/schema`)),
      );
      const elapsed = performance.now() - started;
      expect(answers.map((answer) => answer.statusCode)).toEqual(people.map(() => 200));
      expect(elapsed).toBeLessThan(5_000);
      const running = await querying();
      expect(running).toHaveLength(3);
      expect(holders.heldBy(running)).toBe(0);
      const busy = await observer(
        async (client) =>
          (
            await client.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE application_name LIKE 'rio_sql:%'`,
            )
          ).rows[0]!.count,
      );
      expect(busy).toBe(3);
      // Every accepted run has its history row before any is canceled.
      await expect
        .poll(
          () =>
            observer(
              async (client) =>
                (
                  await client.query<{ count: number }>(
                    `SELECT count(*)::int AS count FROM "${server.schemas.app}".sql_history WHERE id = ANY($1::uuid[])`,
                    [ids],
                  )
                ).rows[0]!.count,
            ),
          { timeout: 20_000, interval: 50 },
        )
        .toBe(people.length);
    } finally {
      holders.stop();
      for (const item of runs) await inject(server, item.who, 'POST', base(`/runs/${item.id}/cancel`), {});
      await inject(server, server.owner, 'PUT', base('/settings'), settings);
    }
    const outcomes = await Promise.all(runs.map((item) => item.response));
    const keys = outcomes.map((outcome) => `${outcome.statusCode} ${outcome.json().error?.messageKey}`);
    expect(keys.filter((key) => key === '429 sql.run.running')).toHaveLength(people.length);
    // A run still waiting for a connection when a long one ends stops too, or finds no room in time.
    for (const key of keys.filter((key) => key !== '429 sql.run.running'))
      expect(['422 sql.run.stopped', '503 sql.run.busy']).toContain(key);
  });
  it('answers a run ID that is already taken with a conflict', async () => {
    const id = randomUUID();
    const first = await run(fixture.persons.reader.signed, 'SELECT 1', id);
    expect(first.statusCode, first.body).toBe(200);
    for (const who of [fixture.persons.editor.signed, fixture.persons.reader.signed]) {
      const again = await run(who, 'SELECT 2', id);
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json().error.messageKey).toBe('sql.run.duplicate');
    }
    const kept = await inject(server, fixture.persons.reader.signed, 'GET', base(`/runs/${id}`));
    expect(kept.json<SqlResult>().rows).toEqual([[1]]);
  });
  it('turns the login off when its person or the admin who enabled it is deleted for good', async () => {
    for (const gone of ['person', 'admin'] as const) {
      const chosen = await member('reader');
      // An owner of the database, whom no rule limits, may choose someone else.
      const admin = await member('owner');
      await adminRoles(admin, ['security']);
      const enabled = await inject(server, admin, 'POST', base('/login'), {
        action: 'enable',
        personId: chosen.userId,
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const login = enabled.json<SqlLogin>();
      expect(login.ready, JSON.stringify(login)).toBe(true);
      const outside = await loginClient(login);
      const target = gone === 'person' ? chosen : admin;
      try {
        expect((await outside.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
        const deleted = await query(
          server.pool,
          sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${target.userId}`,
        );
        expect(deleted.rowCount, gone).toBe(1);
        await expect(outside.query('SELECT "Name" FROM "People"'), gone).rejects.toBeDefined();
      } finally {
        await outside.end();
      }
      const status = (await inject(server, server.owner, 'GET', base('/login'))).json<SqlLogin>();
      expect(status, gone).toMatchObject({ enabled: false, ready: false, personId: null });
      expect(status.sql, gone).toBeUndefined();
      expect(await loginObjects(login), gone).toBe(0);
      const events = await query<{ metadata: Record<string, unknown> }>(
        server.pool,
        sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'databases.sql.loginDisabled' AND metadata->>'reason' = 'deleted' AND metadata->>'personId' = ${chosen.userId}`,
      );
      expect(
        events.rows.map((row) => row.metadata),
        gone,
      ).toEqual([
        {
          databaseId: fixture.databaseId,
          personId: chosen.userId,
          enabledBy: admin.userId,
          reason: 'deleted',
        },
      ]);
    }
  });

  it('keeps guest-masked fields in member SQL views and the runner', async () => {
    const govern = (action: unknown) =>
      inject(server, server.owner, 'POST', '/api/admin/governance/commands', {
        kind: 'governance.apply',
        id: newId('command'),
        action,
      });
    await govern({
      kind: 'classification.labels',
      labels: [{ id: 'guests', name: 'Guests', color: 'blue', description: '', rules: { maskGuests: true } }],
    });
    await govern({
      kind: 'classification.assign',
      target: { kind: 'field', databaseId: fixture.databaseId, fieldId: fixture.people.fields.salary },
      labelId: 'guests',
    });
    let client: pg.Client | undefined;
    try {
      const response = await run(server.owner, 'SELECT "Salary" FROM "People"');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<SqlResult>().rowCount).toBe(3);
      const enabled = await inject(server, server.owner, 'POST', base('/login'), {
        action: 'enable',
        personId: server.owner.userId,
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      client = await loginClient(enabled.json<SqlLogin>());
      expect((await client.query('SELECT "Salary" FROM "People"')).rowCount).toBe(3);
    } finally {
      await client?.end();
      await govern({
        kind: 'classification.assign',
        target: { kind: 'field', databaseId: fixture.databaseId, fieldId: fixture.people.fields.salary },
        labelId: null,
      });
      await govern({ kind: 'classification.labels', labels: [] });
      await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
    }
  });

  it('leaves classified values out of SQL views and the runner, and rebuilds when a label changes', async () => {
    const label = {
      id: 'internal',
      name: 'Internal only',
      color: 'blue',
      description: '',
      rules: { noExport: true },
    };
    const govern = (action: unknown) =>
      inject(server, server.owner, 'POST', '/api/admin/governance/commands', {
        kind: 'governance.apply',
        id: newId('command'),
        action,
      });
    const assign = (target: Record<string, string>, labelId: string | null) =>
      govern({
        kind: 'classification.assign',
        target: { databaseId: fixture.databaseId, ...target },
        labelId,
      });
    const catalog = async () => (await inject(server, server.owner, 'GET', base())).json<SqlAccess>().tables;
    const people = async () => (await catalog()).find((table) => table.id === fixture.people.tableId);
    let client: pg.Client | undefined;
    try {
      expect((await govern({ kind: 'classification.labels', labels: [label] })).statusCode).toBe(200);
      const enabled = await inject(server, server.owner, 'POST', base('/login'), {
        action: 'enable',
        personId: server.owner.userId,
      });
      expect(enabled.statusCode, enabled.body).toBe(200);
      const login = enabled.json<SqlLogin>();
      expect(login.ready, JSON.stringify(login)).toBe(true);
      client = await loginClient(login);
      expect((await client.query('SELECT "Salary" FROM "People" LIMIT 1')).rowCount).toBe(1);
      // A field an outside tool may not read leaves the runner's catalog, and the login's views are
      // rebuilt without it rather than waiting for the next midnight expiration.
      expect(
        (await assign({ kind: 'field', fieldId: fixture.people.fields.salary }, label.id)).statusCode,
      ).toBe(200);
      expect((await inject(server, server.owner, 'GET', base('/login'))).json<SqlLogin>().ready).toBe(false);
      expect((await people())?.fields.map((field) => field.name)).not.toContain('Salary');
      const refused = await run(server.owner, 'SELECT "Salary" FROM "People"');
      expect(refused.statusCode, refused.body).toBe(422);
      expect(refused.json().error.messageKey).toBe('sql.run.column');
      expect(refused.body).not.toContain(String(SALARY.ana));
      await refreshLogins(server.pool, server.schemas);
      await expect(client.query('SELECT "Salary" FROM "People"')).rejects.toMatchObject({ code: '42703' });
      expect((await client.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
      // A whole table goes the same way, and its view goes with it.
      await assign({ kind: 'table', tableId: fixture.people.tableId }, label.id);
      await refreshLogins(server.pool, server.schemas);
      await expect(client.query('SELECT "Name" FROM "People"')).rejects.toMatchObject({ code: '42P01' });
      expect((await catalog()).map((table) => table.id)).not.toContain(fixture.people.tableId);
      // Taking the labels off brings the field and the table back.
      await assign({ kind: 'table', tableId: fixture.people.tableId }, null);
      await assign({ kind: 'field', fieldId: fixture.people.fields.salary }, null);
      await refreshLogins(server.pool, server.schemas);
      expect((await client.query('SELECT "Salary" FROM "People"')).rowCount).toBe(3);
    } finally {
      await client?.end().catch(() => undefined);
      for (const table of ['databases', 'tables', 'fields'])
        await query(
          server.pool,
          sql`UPDATE ${ident(server.schemas.app, table)} SET classification_label = NULL`,
        );
      await govern({ kind: 'classification.labels', labels: [] });
      await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' });
    }
  });
});

it('completes administrator setup after the app creates a role but cannot revoke PUBLIC creation', async () => {
  const isolated = await startServer(kit, 'sqlrole');
  const admin = new pg.Client({ ...isolated.pool.options });
  await admin.connect();
  try {
    await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    await asLimitedAccount(async (appRole, limited) => {
      await admin.query(`ALTER ROLE "${appRole}" CREATEROLE`);
      const pending = await queryRole(limited, isolated.schemas);
      try {
        expect(pending).toMatchObject({ active: false, reason: 'sql.setup.publicCreate' });
        expect(await publicSchemaCreates(admin)).toBe(true);
        expect(
          (await admin.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [pending.role]))
            .rowCount,
        ).toBe(1);
        await admin.query(pending.sql);
        expect(await publicSchemaCreates(admin)).toBe(false);
        forgetQueryRole(limited);
        const ready = await queryRole(limited, isolated.schemas);
        expect(ready).toMatchObject({ role: pending.role, active: true });
        expect(ready.reason).toBeUndefined();
      } finally {
        await admin.query('ROLLBACK');
        await admin.query(REVOKE_PUBLIC_CREATE);
        await admin.query(`DROP OWNED BY "${pending.role}"`);
        await admin.query(`DROP ROLE "${pending.role}"`);
      }
    }, isolated);
  } finally {
    await admin.end();
    await isolated.close();
  }
});

it('supports administrator provisioning and rotation without role creation privileges', async () => {
  const admin = server.pool;
  await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
  await asLimitedAccount(async (role, limited) => {
    let outside: pg.Client | undefined;
    try {
      const ordinary = await run(server.owner, 'SELECT "Name" FROM "People"');
      expect(ordinary.statusCode, ordinary.body).toBe(200);
      // Without a role to run queries as, admins see the SQL that adds one.
      const unprotected = (await inject(server, server.owner, 'GET', base())).json<SqlAccess>();
      expect(unprotected.queryRole).toMatchObject({ active: false, reason: 'sql.setup.publicCreate' });
      expect(unprotected.queryRole?.sql).toContain(REVOKE_PUBLIC_CREATE);
      expect(await publicSchemaCreates(admin)).toBe(true);
      expect(unprotected.queryRole?.sql).toContain(`GRANT "${unprotected.queryRole?.role}" TO "${role}"`);
      await admin.query(unprotected.queryRole!.sql!);
      expect(await publicSchemaCreates(admin)).toBe(false);
      forgetQueryRole(limited);
      expect((await inject(server, server.owner, 'GET', base())).json<SqlAccess>().queryRole).toMatchObject({
        active: true,
      });
      const protectedRun = await run(server.owner, 'SELECT "Name" FROM "People"');
      expect(protectedRun.statusCode, protectedRun.body).toBe(200);
      await admin.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
      const response = await inject(server, server.owner, 'POST', base('/login'), {
        action: 'enable',
        personId: fixture.persons.reader.signed.userId,
      });
      expect(response.statusCode, response.body).toBe(200);
      const pending = response.json<SqlLogin>();
      expect(pending).toMatchObject({ enabled: true, ready: false, reason: 'sql.setup.publicCreate' });
      expect(pending.sql).toContain(REVOKE_PUBLIC_CREATE);
      expect(await publicSchemaCreates(admin)).toBe(true);
      expect(pending.sql).toContain(`AUTHORIZATION "${role}"`);
      // Provisioning roles alone cannot make an unsafe login ready.
      await admin.query(pending.sql!.replace(REVOKE_PUBLIC_CREATE, ''));
      const unsafe = await inject(server, server.owner, 'POST', base('/login'), { action: 'check' });
      expect(unsafe.json<SqlLogin>()).toMatchObject({ ready: false, reason: 'sql.setup.publicCreate' });
      expect(
        (
          await admin.query(
            `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relkind = 'v'`,
            [pending.schema],
          )
        ).rowCount,
      ).toBe(0);
      await admin.query(unsafe.json<SqlLogin>().sql!);
      expect(await publicSchemaCreates(admin)).toBe(false);
      const checked = await inject(server, server.owner, 'POST', base('/login'), { action: 'check' });
      expect(checked.json<SqlLogin>().ready).toBe(true);
      expect(checked.json<SqlLogin>().reason).toBeUndefined();
      outside = await loginClient(pending);
      expect((await outside.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
      const rotated = await inject(server, server.owner, 'POST', base('/login'), { action: 'rotate' });
      const next = rotated.json<SqlLogin>();
      expect(next.password).not.toBe(pending.password);
      // Trust authentication in a test cluster cannot verify a changed password, so role state is checked separately.
      await admin.query(next.sql ?? `SELECT 1`);
      expect(
        (await inject(server, server.owner, 'POST', base('/login'), { action: 'check' })).json<SqlLogin>()
          .ready,
      ).toBe(true);
      await outside.end();
      outside = undefined;
      const disabled = (
        await inject(server, server.owner, 'POST', base('/login'), { action: 'disable' })
      ).json<SqlLogin>();
      expect(disabled.enabled).toBe(false);
      expect(disabled.sql).toContain('DROP ROLE');
      await admin.query(disabled.sql!);
      const cleaned = (
        await inject(server, server.owner, 'POST', base('/login'), { action: 'check' })
      ).json<SqlLogin>();
      expect(cleaned).toMatchObject({ enabled: false, ready: false });
      expect(cleaned.sql).toBeUndefined();
    } finally {
      await outside?.end();
      await admin.query(REVOKE_PUBLIC_CREATE);
    }
  });
});

it('leaves the cleanup SQL when a deleted person’s login can’t be dropped', async () => {
  const admin = server.pool;
  await asLimitedAccount(async (_role, limited) => {
    const chosen = await member('reader');
    const enabled = await inject(server, server.owner, 'POST', base('/login'), {
      action: 'enable',
      personId: chosen.userId,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const pending = enabled.json<SqlLogin>();
    await admin.query(pending.sql!);
    const checked = await inject(server, server.owner, 'POST', base('/login'), { action: 'check' });
    expect(checked.json<SqlLogin>().ready, checked.body).toBe(true);
    const outside = await loginClient(pending);
    try {
      expect((await outside.query('SELECT "Name" FROM "People"')).rowCount).toBe(3);
      // The application account deletes the person, but it may not drop roles.
      await query(
        limited,
        sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${chosen.userId}`,
      );
      // The account is a member of the role, so the delete ends the role's sessions.
      await expect(outside.query('SELECT "Name" FROM "People"')).rejects.toBeDefined();
    } finally {
      await outside.end();
    }
    const queued = (await inject(server, server.owner, 'GET', base('/login'))).json<SqlLogin>();
    expect(queued).toMatchObject({ enabled: false, ready: false, personId: null });
    expect(queued.sql).toContain('DROP ROLE');
    expect(await loginObjects(pending)).toBe(2);
    await admin.query(queued.sql!);
    const cleaned = (
      await inject(server, server.owner, 'POST', base('/login'), { action: 'check' })
    ).json<SqlLogin>();
    expect(cleaned).toMatchObject({ enabled: false, ready: false });
    expect(cleaned.sql).toBeUndefined();
    expect(await loginObjects(pending)).toBe(0);
  });
});

it('keeps a deleted person’s login while it has a session the deleting account may not end', async () => {
  const admin = server.pool;
  await asLimitedAccount(async (account, limited) => {
    const chosen = await member('reader');
    const enabled = await inject(server, server.owner, 'POST', base('/login'), {
      action: 'enable',
      personId: chosen.userId,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    const pending = enabled.json<SqlLogin>();
    await admin.query(pending.sql!);
    const checked = await inject(server, server.owner, 'POST', base('/login'), { action: 'check' });
    expect(checked.json<SqlLogin>().ready, checked.body).toBe(true);
    const outside = await loginClient(pending);
    try {
      const pid = await backendOf(outside);
      // The account may now drop the role, as one that made the role itself may: it creates
      // roles, and it is the one that let this role connect.  From PostgreSQL 16 it must also
      // administer the role.  It is no member of the role, so it may not end the role's sessions.
      const settings = await admin.query<{ version: string; database: string }>(
        `SELECT current_setting('server_version_num') AS version, current_database() AS database`,
      );
      const { version, database } = settings.rows[0]!;
      await admin.query(
        [
          `REVOKE "${pending.role}" FROM "${account}"`,
          `ALTER ROLE "${account}" CREATEROLE`,
          `REVOKE CONNECT ON DATABASE "${database}" FROM "${pending.role}"`,
          `GRANT CONNECT ON DATABASE "${database}" TO "${account}" WITH GRANT OPTION`,
          ...(Number(version) >= 160000
            ? [`GRANT "${pending.role}" TO "${account}" WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`]
            : []),
        ].join('; '),
      );
      await limited.query(`GRANT CONNECT ON DATABASE "${database}" TO "${pending.role}"`);
      await query(
        limited,
        sql`DELETE FROM ${ident(server.schemas.app, 'users')} WHERE id = ${chosen.userId}`,
      );
      // PostgreSQL would have dropped the role and left the session connected with no role.
      expect(await loginObjects(pending)).toBe(2);
      expect(
        (await admin.query('SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1', [pid])).rowCount,
      ).toBe(1);
      // Only the account that let the role connect can take that back.
      await limited.query(`REVOKE CONNECT ON DATABASE "${database}" FROM "${pending.role}"`);
    } finally {
      await outside.end();
    }
    const queued = (await inject(server, server.owner, 'GET', base('/login'))).json<SqlLogin>();
    expect(queued).toMatchObject({ enabled: false, ready: false, personId: null });
    expect(queued.sql).toContain('DROP ROLE');
    await admin.query(queued.sql!);
    const cleaned = (
      await inject(server, server.owner, 'POST', base('/login'), { action: 'check' })
    ).json<SqlLogin>();
    expect(cleaned).toMatchObject({ enabled: false, ready: false });
    expect(cleaned.sql).toBeUndefined();
    expect(await loginObjects(pending)).toBe(0);
  });
});

it('lets each person start only so many runs a minute', async () => {
  const limited = await startServer(kit, 'sqlrate', { sqlMinuteLimit: 3 });
  try {
    const databaseId = newId('database');
    const created = await inject(limited, limited.owner, 'POST', '/api/databases', {
      id: databaseId,
      name: 'Rates',
      table: {
        id: newId('table'),
        name: 'Items',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'All' },
        records: [],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const url = `/api/databases/${databaseId}/sql/run`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await inject(limited, limited.owner, 'POST', url, {
        id: randomUUID(),
        query: 'SELECT 1',
      });
      statuses.push(response.statusCode);
      if (response.statusCode === 429) {
        expect(response.json().error.messageKey).toBe('sql.run.rateLimited');
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
      }
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // Each person counts on their own.
    const other = await limited.addMember();
    await query(
      limited.pool,
      sql`INSERT INTO ${ident(limited.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${limited.owner.info.org.id}, 'database', ${databaseId}, 'user', ${other.userId}, 'reader')`,
    );
    const opened = await inject(limited, limited.owner, 'PUT', `/api/databases/${databaseId}/sql/settings`, {
      ...settings,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const fresh = await inject(limited, other, 'POST', url, { id: randomUUID(), query: 'SELECT 1' });
    expect(fresh.statusCode, fresh.body).toBe(200);
  } finally {
    await limited.close();
  }
});

/** A database with one table, for servers of their own.  Each name becomes a record. */
async function stock(target: ServerFixture, names: string[] = [], name = 'Stock') {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const created = await inject(target, target.owner, 'POST', '/api/databases', {
    id: databaseId,
    name,
    table: {
      id: tableId,
      name: 'Items',
      fields: [{ id: fieldId, name: 'Name', type: 'text' }],
      view: { id: newId('view'), name: 'All' },
      records: names.map((value) => ({ id: newId('record'), values: { [fieldId]: value } })),
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  return { databaseId, tableId };
}
const itemsDatabase = async (target: ServerFixture) => (await stock(target)).databaseId;

it('closes a login made while PUBLIC kept its defaults until the setup SQL has run', async () => {
  const isolated = await startServer(kit, 'sqlshared', { sqlOutsideLogins: true });
  const admin = isolated.pool;
  let outside: pg.Client | undefined;
  try {
    const url = `/api/databases/${await itemsDatabase(isolated)}/sql`;
    const change = async (action: string) => {
      const response = await inject(isolated, isolated.owner, 'POST', `${url}/login`, {
        action,
        personId: isolated.owner.userId,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<SqlLogin>();
    };
    const status = async () =>
      (await inject(isolated, isolated.owner, 'GET', `${url}/login`)).json<SqlLogin>();
    const connect = async (login: SqlLogin) => {
      outside = await outsideClient(isolated, login);
      return outside;
    };
    const state = async (account: string, role: string) =>
      (
        await admin.query(
          `SELECT has_function_privilege($1, 'pg_catalog.pg_advisory_lock(bigint)', 'EXECUTE') AS locks,
            has_database_privilege($1, current_database(), 'TEMPORARY') AS temporary,
            has_function_privilege($1, 'pg_catalog.lo_create(oid)', 'EXECUTE') AS objects,
            has_function_privilege($1, 'pg_catalog.pg_get_viewdef(oid)', 'EXECUTE') AS views,
            (SELECT COALESCE(rolconfig::text ~ 'temp_file_limit', false) FROM pg_catalog.pg_roles
              WHERE rolname = $2) AS limited`,
          [account, role],
        )
      ).rows[0];
    // A login from before these were required: PUBLIC keeps its defaults, the role has no disk
    // limit, and the application account is no member of the role.
    const earlier = async (role: string, account?: string) => {
      await restorePublicDefaults(admin);
      await admin.query(`ALTER ROLE "${role}" RESET temp_file_limit`);
      if (account) await admin.query(`REVOKE "${role}" FROM "${account}"`);
    };
    const open = { locks: true, temporary: true, objects: true, views: true, limited: false };
    const shut = { locks: false, temporary: false, objects: false, views: false, limited: true };

    // A superuser account takes them away at the next refresh, and the login stays open.
    const first = await change('enable');
    expect(first.ready, JSON.stringify(first)).toBe(true);
    await earlier(first.role);
    expect(await state(first.role, first.role)).toEqual(open);
    // A session from before then has no disk limit, and keeps the advisory lock it took.
    const before = await connect(first);
    const beforePid = await backendOf(before);
    expect((await before.query('SHOW temp_file_limit')).rows).toEqual([{ temp_file_limit: '-1' }]);
    await before.query('SELECT pg_advisory_lock(1)');
    await refreshLogins(admin, isolated.schemas);
    expect(await state(first.role, first.role)).toEqual(shut);
    expect(await status()).toMatchObject({ enabled: true, ready: true });
    // So the refresh ends it, and the session that takes its place starts under the limits.
    await ended(isolated, beforePid);
    const reader = await connect(first);
    expect((await reader.query('SHOW temp_file_limit')).rows).toEqual([{ temp_file_limit: '1GB' }]);
    await expect(reader.query('SELECT pg_advisory_lock(1)')).rejects.toMatchObject({ code: '42501' });
    expect((await reader.query('SELECT "Name" FROM "Items"')).rowCount).toBe(0);
    await reader.end();
    outside = undefined;
    expect(await change('disable')).toMatchObject({ enabled: false });

    await asLimitedAccount(async (account, limited) => {
      // An account that creates roles but is no superuser can take nothing from PUBLIC and set no
      // disk limit.  It creates nothing, and the login waits for the setup SQL like any other.
      await admin.query(`ALTER ROLE "${account}" CREATEROLE`);
      const refused = await change('enable');
      expect(refused).toMatchObject({ enabled: true, ready: false, reason: 'sql.setup.publicDefaults' });
      expect(refused.sql).toContain(`CREATE ROLE "${refused.role}"`);
      expect(refused.sql).toContain('REVOKE EXECUTE ON FUNCTION');
      expect(
        (await admin.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [refused.role])).rowCount,
      ).toBe(0);
      await admin.query(`ALTER ROLE "${account}" NOCREATEROLE`);
      expect(await change('disable')).toMatchObject({ enabled: false });

      // An account that can't take them away opens nothing until the SQL that does has run.
      const pending = await change('enable');
      expect(pending).toMatchObject({ enabled: true, ready: false, reason: 'sql.setup.publicDefaults' });
      expect(pending.sql).toContain('pg_catalog.pg_advisory_lock(bigint)');
      expect(pending.sql).toContain(`TO "${account}";`);
      expect(pending.sql).toContain('pg_catalog.lo_create(oid)');
      expect(pending.sql).toContain('REVOKE TEMPORARY ON DATABASE');
      expect(pending.sql).toContain('temp_file_limit');
      // The account must be able to end the role's sessions, which takes membership in the role.
      const membership = `GRANT "${pending.role}" TO "${account}";`;
      expect(pending.sql).toContain(membership);
      await admin.query(pending.sql!.replace(membership, ''));
      const outsider = await change('check');
      expect(outsider).toMatchObject({ enabled: true, ready: false });
      expect(outsider.sql).toContain(membership);
      await admin.query(membership);
      expect(await change('check')).toMatchObject({ enabled: true, ready: true });
      const client = await connect(pending);
      expect((await client.query('SELECT "Name" FROM "Items"')).rowCount).toBe(0);
      expect(await state(pending.role, pending.role)).toEqual(shut);
      // The application account keeps its own locks and temporary tables, so the server still works.
      expect(await state(account, pending.role)).toMatchObject({
        locks: true,
        temporary: true,
        objects: true,
      });
      const saved = await inject(isolated, isolated.owner, 'PUT', `${url}/settings`, settings);
      expect(saved.statusCode, saved.body).toBe(200);

      // The same account finds an earlier login at the next refresh and closes it.
      await earlier(pending.role, account);
      await refreshLogins(limited, isolated.schemas);
      const closed = await status();
      expect(closed).toMatchObject({ enabled: true, ready: false, reason: 'sql.setup.publicDefaults' });
      expect(closed.sql).toContain('REVOKE EXECUTE ON FUNCTION');
      expect(closed.sql).toContain('temp_file_limit');
      expect(closed.sql).toContain(membership);
      await expect(client.query('SELECT "Name" FROM "Items"')).rejects.toMatchObject({ code: '42P01' });
      // The SQL ends the role's sessions once it has committed, since one from before has no limit.
      const clientPid = await backendOf(client);
      expect(closed.sql).toMatch(/COMMIT;\n.*pg_terminate_backend/);
      await admin.query(closed.sql!);
      await ended(isolated, clientPid);
      await refreshLogins(limited, isolated.schemas);
      expect(await status()).toMatchObject({ enabled: true, ready: true });
      const again = await connect(pending);
      expect((await again.query('SHOW temp_file_limit')).rows).toEqual([{ temp_file_limit: '1GB' }]);
      expect((await again.query('SELECT "Name" FROM "Items"')).rowCount).toBe(0);
      expect(await state(pending.role, pending.role)).toEqual(shut);
      // A member of the role ends its sessions, so turning the login off waits for none of them.
      // Dropping the role is left to the cleanup SQL, which also drops what the role owns.
      await again.query('BEGIN');
      await again.query('SELECT "Name" FROM "Items"');
      const off = await change('disable');
      expect(off).toMatchObject({ enabled: false, ready: false });
      await expect(again.query('SELECT 1')).rejects.toBeDefined();
      expect(off.sql).toContain(`DROP OWNED BY "${pending.role}";`);
      await admin.query(off.sql!);
      expect(await change('check')).toMatchObject({ enabled: false, ready: false });
    }, isolated);
  } finally {
    await (outside as pg.Client | undefined)?.end().catch(() => undefined);
    await isolated.close();
  }
});

it('opens no outside login unless the server allows them, and turns off the ones it has', async () => {
  const isolated = await startServer(kit, 'sqlgate');
  let outside: pg.Client | undefined;
  try {
    const url = `/api/databases/${await itemsDatabase(isolated)}/sql/login`;
    const enable = () =>
      inject(isolated, isolated.owner, 'POST', url, { action: 'enable', personId: isolated.owner.userId });
    const refused = await enable();
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json().error.messageKey).toBe('sql.setup.outsideLogins');
    const off = (await inject(isolated, isolated.owner, 'GET', url)).json<SqlLogin>();
    expect(off).toMatchObject({ enabled: false, ready: false, reason: 'sql.setup.outsideLogins' });
    const roles = async () =>
      (await isolated.pool.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [off.role]))
        .rowCount;
    expect(await roles()).toBe(0);
    // A login enabled while the server allowed them goes when it stops.
    isolated.ctx.config.sqlOutsideLogins = true;
    const enabled = await enable();
    expect(enabled.statusCode, enabled.body).toBe(200);
    const login = enabled.json<SqlLogin>();
    expect(login.ready, JSON.stringify(login)).toBe(true);
    outside = await outsideClient(isolated, login);
    expect((await outside.query('SELECT "Name" FROM "Items"')).rowCount).toBe(0);
    isolated.ctx.config.sqlOutsideLogins = false;
    const rotated = await inject(isolated, isolated.owner, 'POST', url, { action: 'rotate' });
    expect(rotated.statusCode, rotated.body).toBe(403);
    // The server's own pass runs alongside, and a pass skips a login the other is turning off.
    while (await roles()) {
      await closeLogins(isolated.pool, isolated.schemas);
      await delay(50);
    }
    await expect(outside.query('SELECT "Name" FROM "Items"')).rejects.toBeDefined();
    expect((await inject(isolated, isolated.owner, 'GET', url)).json<SqlLogin>()).toMatchObject({
      enabled: false,
      ready: false,
      personId: null,
    });
    const events = await query<{ reason: string }>(
      isolated.pool,
      sql`SELECT metadata->>'reason' AS reason FROM ${ident(isolated.schemas.audit, 'events')} WHERE action = 'databases.sql.loginDisabled'`,
    );
    expect(events.rows).toEqual([{ reason: 'notAllowed' }]);
  } finally {
    await outside?.end().catch(() => undefined);
    await isolated.close();
  }
});

describe('an outside login’s sessions', () => {
  let isolated: ServerFixture;
  const sessions: pg.Client[] = [];
  beforeAll(async () => {
    isolated = await startServer(kit, 'sqlsessions', { sqlOutsideLogins: true });
  }, 120_000);
  afterAll(async () => {
    for (const session of sessions) await session.end().catch(() => undefined);
    await isolated?.close();
  });

  const connect = async (login: SqlLogin) => {
    const session = await outsideClient(isolated, login);
    sessions.push(session);
    return session;
  };
  /** A session that read a view inside a transaction and never ended it, with its time limit lifted. */
  const hold = async (login: SqlLogin) => {
    const session = await connect(login);
    await session.query('SET statement_timeout = 0');
    await session.query('BEGIN');
    await session.query('SELECT * FROM "Items"');
    return session;
  };
  /** What the session reads now.  A session the server ended reads nothing. */
  const reads = (session: pg.Client) =>
    session.query('SELECT * FROM "Items"').then(
      (result) => result.rowCount,
      () => 0,
    );
  const login = (databaseId: string) => {
    const url = `/api/databases/${databaseId}/sql/login`;
    return {
      async change(action: string, personId = isolated.owner.userId) {
        const response = await inject(isolated, isolated.owner, 'POST', url, { action, personId });
        expect(response.statusCode, response.body).toBe(200);
        return response.json<SqlLogin>();
      },
      status: async () => (await inject(isolated, isolated.owner, 'GET', url)).json<SqlLogin>(),
    };
  };
  const roles = async (role: string) =>
    (await isolated.pool.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role])).rowCount;
  /** How many of a login's role and schema exist */
  const objects = async (names: SqlLogin) =>
    (
      await isolated.pool.query(
        `SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1
        UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $2`,
        [names.role, names.schema],
      )
    ).rowCount;
  /** An enabled login with a session that reads its view and then holds nothing */
  const idle = async (databaseId: string, personId?: string) => {
    const enabled = await login(databaseId).change('enable', personId);
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    const session = await connect(enabled);
    expect(await reads(session)).toBe(1);
    return { enabled, pid: await backendOf(session) };
  };
  /**
   * Refreshes until `done`.  The server's own refresh runs alongside, and a pass skips a login
   * that the other pass is working on.
   */
  const refreshUntil = async (done: () => Promise<boolean>) => {
    while (!(await done())) {
      await refreshLogins(isolated.pool, isolated.schemas);
      await delay(50);
    }
  };
  const turnedOff = async (databaseId: string) =>
    (
      await query<{ reason: string }>(
        isolated.pool,
        sql`SELECT metadata->>'reason' AS reason FROM ${ident(isolated.schemas.audit, 'events')}
        WHERE action = 'databases.sql.loginDisabled' AND metadata->>'databaseId' = ${databaseId}`,
      )
    ).rows;

  it('turns a login off and keeps changes working while a session holds its view open', async () => {
    const stocked = await stock(isolated, ['Bolt']);
    const other = await stock(isolated, [], 'Tools');
    const { change, status } = login(stocked.databaseId);
    const addField = (target: { databaseId: string; tableId: string }, name: string) =>
      command(isolated, isolated.owner, target.databaseId, {
        kind: 'field.create',
        tableId: target.tableId,
        field: { id: newId('field'), name, type: 'text' },
      });
    let enabled = await change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);

    // A change to another database's fields, or to who may read what, closes the views and waits
    // for no session.  The session reads nothing from then on.
    let session = await hold(enabled);
    expect(await reads(session)).toBe(1);
    expect(await addField(other, 'Size')).toMatchObject({ status: 'applied' });
    expect(await reads(session)).toBe(0);
    await query(
      isolated.pool,
      sql`UPDATE ${ident(isolated.schemas.app, 'memberships')} SET admin_roles = admin_roles`,
    );
    // The refresh ends the session in its way and rebuilds the views.
    await refreshUntil(async () => (await status()).ready);
    await expect(session.query('SELECT 1')).rejects.toBeDefined();

    // A change to the login's own database needs the table the session read.  The refresh ends
    // the session that holds it up.
    session = await hold(enabled);
    let settled = false;
    const adding = addField(stocked, 'Weight').finally(() => {
      settled = true;
    });
    while (!settled) {
      await refreshLogins(isolated.pool, isolated.schemas);
      await delay(50);
    }
    expect(await adding).toMatchObject({ status: 'applied' });
    await expect(session.query('SELECT 1')).rejects.toBeDefined();
    await refreshUntil(async () => (await status()).ready);

    // So does the server changing its own tables, as the migrations at startup do.
    session = await hold(enabled);
    await withoutBlockers(
      isolated.pool,
      isolated.schemas,
      () =>
        withTransaction(isolated.pool, async (db) => {
          await query(
            db,
            sql`LOCK TABLE ${ident(isolated.schemas.app, 'sql_logins')} IN ACCESS EXCLUSIVE MODE`,
          );
        }),
      50,
    );
    await expect(session.query('SELECT 1')).rejects.toBeDefined();

    // Turning the login off ends its sessions and removes its role.
    session = await hold(enabled);
    expect(await change('disable')).toMatchObject({ enabled: false, ready: false });
    expect(await reads(session)).toBe(0);
    expect(await roles(enabled.role)).toBe(0);

    // The same goes for every login once the server stops allowing them.
    enabled = await change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    session = await hold(enabled);
    isolated.ctx.config.sqlOutsideLogins = false;
    try {
      while (await roles(enabled.role)) {
        await closeLogins(isolated.pool, isolated.schemas);
        await delay(50);
      }
      expect(await status()).toMatchObject({ enabled: false, ready: false });
      expect(await reads(session)).toBe(0);
      expect(await turnedOff(stocked.databaseId)).toEqual([{ reason: 'notAllowed' }]);
    } finally {
      isolated.ctx.config.sqlOutsideLogins = true;
    }
  });

  it('keeps a disabled configuration once its role and schema are already gone', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'No objects');
    const enabled = await login(databaseId).change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    await query(
      isolated.pool,
      sql`UPDATE ${ident(isolated.schemas.app, 'sql_logins')}
      SET enabled = false, ready = false WHERE database_id = ${databaseId}`,
    );
    // Administrator cleanup can remove the PostgreSQL objects before the app's next pass.
    await query(isolated.pool, sql`DROP SCHEMA ${ident(enabled.schema)} CASCADE`);
    await query(isolated.pool, sql`DROP OWNED BY ${ident(enabled.role)}`);
    await query(isolated.pool, sql`DROP ROLE ${ident(enabled.role)}`);
    const configuration = async () =>
      (
        await query(
          isolated.pool,
          sql`SELECT * FROM ${ident(isolated.schemas.app, 'sql_logins')} WHERE database_id = ${databaseId}`,
        )
      ).rows;
    const before = await configuration();
    expect(before).toHaveLength(1);
    expect(await objects(enabled)).toBe(0);
    await refreshLogins(isolated.pool, isolated.schemas);
    expect(await configuration()).toEqual(before);
  });

  it('removes a disabled login even when its views have already been dropped', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'No views');
    const enabled = await login(databaseId).change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    // A cascading membership change can drop the views after a person's delete deferred cleanup.
    await query(
      isolated.pool,
      sql`UPDATE ${ident(isolated.schemas.app, 'sql_logins')}
      SET enabled = false, ready = false WHERE database_id = ${databaseId}`,
    );
    await query(isolated.pool, sql`DROP VIEW ${ident(enabled.schema, 'Items')}`);
    expect(await objects(enabled)).toBe(2);
    await refreshLogins(isolated.pool, isolated.schemas);
    expect(await objects(enabled)).toBe(0);
    expect(await login(databaseId).status()).toMatchObject({
      enabled: false,
      ready: false,
      personId: null,
    });
  });

  it('removes a deleted person’s login once the session that held its view is gone', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Leavers');
    const { change, status } = login(databaseId);
    const chosen = await isolated.addMember();
    await query(
      isolated.pool,
      sql`INSERT INTO ${ident(isolated.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${isolated.owner.info.org.id}, 'database', ${databaseId}, 'user', ${chosen.userId}, 'reader')`,
    );
    const enabled = await change('enable', chosen.userId);
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    const session = await hold(enabled);
    const pid = await backendOf(session);
    // Deleting the person turns the login off and waits for no session.
    const deleted = await query(
      isolated.pool,
      sql`DELETE FROM ${ident(isolated.schemas.app, 'users')} WHERE id = ${chosen.userId}`,
    );
    expect(deleted.rowCount).toBe(1);
    expect(await reads(session)).toBe(0);
    expect(await status()).toMatchObject({ enabled: false, ready: false, personId: null });
    // Termination is asynchronous, so wait for the backend's locks to go before retrying cleanup.
    await ended(isolated, pid);
    // Drive cleanup directly instead of waiting for the scheduled refresh.  Twenty seconds lets
    // PostgreSQL finish cleanup under load, while a role that cannot be removed still fails here.
    await expect
      .poll(
        async () => {
          await refreshLogins(isolated.pool, isolated.schemas);
          return roles(enabled.role);
        },
        { timeout: 20_000, interval: 50 },
      )
      .toBe(0);
    await expect(session.query('SELECT 1')).rejects.toBeDefined();
    expect((await status()).sql).toBeUndefined();
    expect(await turnedOff(databaseId)).toEqual([{ reason: 'deleted' }]);
  });

  it('ends a deleted person’s idle session before it drops the login’s role', async () => {
    const stocked = await stock(isolated, ['Bolt'], 'Idle');
    const chosen = await isolated.addMember();
    await query(
      isolated.pool,
      sql`INSERT INTO ${ident(isolated.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${isolated.owner.info.org.id}, 'database', ${stocked.databaseId}, 'user', ${chosen.userId}, 'reader')`,
    );
    const { enabled, pid } = await idle(stocked.databaseId, chosen.userId);
    // A session that holds no view keeps nothing from being dropped.  PostgreSQL would drop the
    // role and leave the session connected, so the delete ends the session first.  Until the
    // delete commits the role is still there for everyone else, and nothing else ends the session.
    const deleting = new pg.Client({ ...isolated.pool.options });
    await deleting.connect();
    try {
      await deleting.query('BEGIN');
      const deleted = await query(
        deleting,
        sql`DELETE FROM ${ident(isolated.schemas.app, 'users')} WHERE id = ${chosen.userId}`,
      );
      expect(deleted.rowCount).toBe(1);
      await ended(isolated, pid);
      expect(await roles(enabled.role)).toBe(1);
      await deleting.query('COMMIT');
    } finally {
      await deleting.end();
    }
    expect(await objects(enabled)).toBe(0);
    expect(await turnedOff(stocked.databaseId)).toEqual([{ reason: 'deleted' }]);
  });

  it('turns a login off when its database goes to the trash', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Trashed');
    const { enabled, pid } = await idle(databaseId);
    const trash = await command(isolated, isolated.owner, databaseId, { kind: 'database.trash' });
    expect(trash).toMatchObject({ status: 'applied' });
    await refreshUntil(async () => !(await objects(enabled)));
    await ended(isolated, pid);
    expect(await turnedOff(databaseId)).toEqual([{ reason: 'trashed' }]);
    // The database comes back without a login.
    const restore = await command(isolated, isolated.owner, databaseId, { kind: 'database.restore' });
    expect(restore).toMatchObject({ status: 'applied' });
    await refreshLogins(isolated.pool, isolated.schemas);
    expect(await login(databaseId).status()).toMatchObject({ enabled: false, ready: false });
    expect(await objects(enabled)).toBe(0);
  });

  it('removes a login before its database is deleted for good', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Purged');
    const { enabled, pid } = await idle(databaseId);
    await query(
      isolated.pool,
      sql`UPDATE ${ident(isolated.schemas.app, 'databases')} SET trashed_at = now() - interval '31 days'
      WHERE id = ${databaseId}`,
    );
    await purgeTrash(isolated.ctx);
    // The role is gone by the time the database is, whatever the refresh has done by then.
    expect(await objects(enabled)).toBe(0);
    await ended(isolated, pid);
    const left = await query(
      isolated.pool,
      sql`SELECT 1 FROM ${ident(isolated.schemas.app, 'databases')} WHERE id = ${databaseId}`,
    );
    expect(left.rowCount).toBe(0);
    expect(['trashed', 'purged']).toContain((await turnedOff(databaseId))[0]?.reason);
  });

  it('removes a login that has lost its row', async () => {
    // A build that deleted a database for good without removing its login left the login this way,
    // with a role, a schema, and a working password.  The refresh knows it by its schema.
    const { databaseId } = await stock(isolated, ['Bolt'], 'Orphaned');
    const { enabled, pid } = await idle(databaseId);
    await query(
      isolated.pool,
      sql`DELETE FROM ${ident(isolated.schemas.app, 'sql_logins')} WHERE database_id = ${databaseId}`,
    );
    expect(await objects(enabled)).toBe(2);
    await refreshUntil(async () => !(await objects(enabled)));
    await ended(isolated, pid);
  });

  it('ends a session whose role was dropped while it was connected', async () => {
    // A database administrator's cleanup can leave one, and so can a tool that reconnects while
    // its login is being removed.  It answers to no login, so the refresh ends it for having no role.
    const { databaseId } = await stock(isolated, ['Bolt'], 'Dropped');
    const { enabled, pid } = await idle(databaseId);
    await isolated.pool.query(
      `DROP SCHEMA "${enabled.schema}" CASCADE; DROP OWNED BY "${enabled.role}"; DROP ROLE "${enabled.role}"`,
    );
    await refreshLogins(isolated.pool, isolated.schemas);
    await ended(isolated, pid);
    expect(await login(databaseId).change('disable')).toMatchObject({ enabled: false, ready: false });
  });

  it('ends a session that connected while its login’s password was being replaced', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Rotated');
    const { change } = login(databaseId);
    const enabled = await change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    const holder = new pg.Client({ ...isolated.pool.options });
    await holder.connect();
    try {
      // The audit log's lock holds the change just before it commits, after it has ended the
      // login's sessions.  A tool that reconnects at once gets in under the old password.
      const chain = `${isolated.schemas.audit}:audit:${isolated.owner.info.org.id}`;
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [chain]);
      const rotating = change('rotate');
      for (;;) {
        const waiting = await isolated.pool.query(
          `SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'`,
        );
        if (waiting.rowCount) break;
        await delay(25);
      }
      const late = await connect(enabled);
      const pid = await backendOf(late);
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [chain]);
      const rotated = await rotating;
      expect(rotated.ready, JSON.stringify(rotated)).toBe(true);
      expect(rotated.password).not.toBe(enabled.password);
      await ended(isolated, pid);
      expect(await reads(await connect(rotated))).toBe(1);
    } finally {
      await holder.end();
      expect(await change('disable')).toMatchObject({ enabled: false });
    }
  });

  it('ends a session that outstays the query timeout, and puts back defaults the login changed', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Limits');
    const { change, status } = login(databaseId);
    const saved = await inject(isolated, isolated.owner, 'PUT', `/api/databases/${databaseId}/sql/settings`, {
      ...settings,
      timeoutMs: 2_000,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const enabled = await change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    const defaults = async () =>
      (
        await isolated.pool.query<{ rolconfig: string[] }>(
          'SELECT rolconfig FROM pg_catalog.pg_roles WHERE rolname = $1',
          [enabled.role],
        )
      ).rows[0]!.rolconfig.sort();
    const given = [
      'default_transaction_read_only=on',
      `search_path=${enabled.schema}`,
      'statement_timeout=2000',
      'temp_file_limit=1GB',
    ];
    expect(await defaults()).toEqual(given);
    // What the role has set for this database alone, which PostgreSQL applies over its other defaults
    const scoped = async () =>
      (
        await isolated.pool.query<{ setconfig: string[] }>(
          `SELECT setting.setconfig FROM pg_catalog.pg_db_role_setting setting
          JOIN pg_catalog.pg_roles r ON r.oid = setting.setrole
          JOIN pg_catalog.pg_database d ON d.oid = setting.setdatabase
          WHERE r.rolname = $1 AND d.datname = current_database()`,
          [enabled.role],
        )
      ).rows.flatMap((row) => row.setconfig);
    const database = (await isolated.pool.query<{ name: string }>('SELECT current_database() AS name'))
      .rows[0]!.name;
    let working = true;
    try {
      // A role may change its own defaults for good, for every database or for this one.  The next
      // rebuild puts them back.  The disk limit is no default, and the role can't change it either way.
      const parked = await connect(enabled);
      await parked.query('SET default_transaction_read_only = off');
      await parked.query('ALTER ROLE CURRENT_USER SET statement_timeout = 0');
      await parked.query('ALTER ROLE CURRENT_USER RESET default_transaction_read_only');
      await parked.query(`ALTER ROLE CURRENT_USER IN DATABASE "${database}" SET search_path = pg_catalog`);
      await expect(
        parked.query(`ALTER ROLE CURRENT_USER IN DATABASE "${database}" SET temp_file_limit = -1`),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await defaults()).toEqual([
        `search_path=${enabled.schema}`,
        'statement_timeout=0',
        'temp_file_limit=1GB',
      ]);
      expect(await scoped()).toEqual(['search_path=pg_catalog']);
      await query(
        isolated.pool,
        sql`UPDATE ${ident(isolated.schemas.app, 'sql_logins')} SET ready = false WHERE database_id = ${databaseId}`,
      );
      await refreshUntil(async () => (await status()).ready);
      expect(await defaults()).toEqual(given);
      expect(await scoped()).toEqual([]);

      // The time limit is a default a session lifts, so the server ends a session whose statement
      // has run past it, and one that sits idle inside a transaction.  A transaction that keeps
      // working stays, and so does a session that holds no transaction.
      const idle = await connect(enabled);
      const running = await connect(enabled);
      const reading = await connect(enabled);
      for (const session of [parked, running, reading]) await session.query('SET statement_timeout = 0');
      await parked.query('BEGIN');
      await parked.query('SELECT * FROM "Items"');
      const slept = running.query('SELECT pg_sleep(60)').then(
        () => 'finished',
        () => 'ended',
      );
      await reading.query('BEGIN');
      const batches = (async () => {
        while (working) {
          await reading.query('SELECT * FROM "Items"');
          await delay(25);
        }
      })().catch((error: unknown) => error);
      await delay(2_500);
      await refreshLogins(isolated.pool, isolated.schemas, { graceMs: 0 });
      await expect(parked.query('SELECT 1')).rejects.toBeDefined();
      expect(await slept).toBe('ended');
      working = false;
      expect(await batches).toBeUndefined();
      expect((await reading.query('SELECT * FROM "Items"')).rowCount).toBe(1);
      expect((await idle.query('SELECT * FROM "Items"')).rowCount).toBe(1);

      // A session that listens inside a transaction keeps PostgreSQL from clearing its notification
      // queue, so once the queue is filling no login keeps a transaction open.
      await refreshLogins(isolated.pool, isolated.schemas, { queueShare: -1 });
      await expect(reading.query('SELECT 1')).rejects.toBeDefined();
      expect((await idle.query('SELECT * FROM "Items"')).rowCount).toBe(1);
    } finally {
      working = false;
      expect(await change('disable')).toMatchObject({ enabled: false });
    }
  });

  it('turns a login off, instead of checking it, once the server stops allowing outside logins', async () => {
    const { databaseId } = await stock(isolated, ['Bolt'], 'Gate');
    const { change } = login(databaseId);
    const enabled = await change('enable');
    expect(enabled.ready, JSON.stringify(enabled)).toBe(true);
    const session = await connect(enabled);
    const holder = new pg.Client({ ...isolated.pool.options });
    await holder.connect();
    try {
      // Another change holds the login's row, so the pass that closes every login skips this one,
      // and the check reaches it while it is still on.
      await holder.query('BEGIN');
      await query(
        holder,
        sql`SELECT 1 FROM ${ident(isolated.schemas.app, 'sql_logins')} WHERE database_id = ${databaseId} FOR UPDATE`,
      );
      isolated.ctx.config.sqlOutsideLogins = false;
      const checking = change('check');
      for (;;) {
        const waiting = await isolated.pool.query(
          `SELECT 1 FROM pg_catalog.pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if (waiting.rowCount) break;
        await delay(25);
      }
      await holder.query('COMMIT');
      expect(await checking).toMatchObject({ enabled: false, ready: false });
      expect(await reads(session)).toBe(0);
      expect(await roles(enabled.role)).toBe(0);
      expect(await turnedOff(databaseId)).toEqual([{ reason: 'notAllowed' }]);
    } finally {
      isolated.ctx.config.sqlOutsideLogins = true;
      await holder.end();
    }
  });
});
