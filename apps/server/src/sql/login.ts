import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { AppError, type SqlLogin, type SqlSetupIssue } from '@riosoma/contracts';
import { ident, query, Sql, sql, withTransaction, type Queryable } from '@riosoma/db';
import pg from 'pg';
import { sealCredential, unsealCredential } from '../credentials/service.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from '../data/access.js';
import type { DataSchemas } from '../data/context.js';
import { auditEvent } from '../auth/database.js';
import { lockUnits, organizationAdmin, requirePerson, unitResourceAdmin } from '../org-units/store.js';
import { quoteName } from './guard.js';
import { embedded, literal, projections } from './projection.js';
import { settingsFor } from './store.js';
import {
  hardenDatabase,
  hardenPublicSchema,
  LOGIN_TEMP_FILE_LIMIT,
  preparedTransactions,
  publicDefaultsSql,
  publicSchemaCreates,
  REVOKE_PUBLIC_CREATE,
  SHARED_ROUTINES,
  TEMP_FILE_LIMITED,
} from './schema.js';

interface LoginRow {
  database_id: string;
  person_id: string | null;
  /** The admin who last chose the person or received the password */
  enabled_by: string | null;
  role_name: string;
  schema_name: string;
  enabled: boolean;
  ready: boolean;
  verifier: string | null;
  sealed_password: string | null;
  verified: boolean;
}
const table = (schemas: DataSchemas) => ident(schemas.app, 'sql_logins');

/**
 * How long a change to a login's views, schema, or role waits for a lock.  A session of the login
 * holds a lock on every view it has read for as long as its transaction stays open, so nothing that
 * closes a login waits on one for long.
 */
const LOCK_WAIT_MS = 1_000;

/** When the server ends a login's session of its own accord, besides one that holds up another session */
export const SESSION_LIMITS = {
  /** How long past its database's query timeout a statement may run, or a transaction sit idle */
  graceMs: 5_000,
  /** The share of PostgreSQL's notification queue in use past which no login keeps a transaction open */
  queueShare: 0.05,
};

/**
 * Whether the application account has the privileges of the role with this `oid`.  PostgreSQL asks
 * for them, or for a superuser, before it ends the role's sessions or drops what the role owns.
 */
const MEMBER = `pg_catalog.pg_has_role(current_user, oid, 'USAGE')`;

/**
 * Whether the application account may alter the role `login` and grant membership in it: a
 * superuser, or an account that creates roles and, from PostgreSQL 16, administers this one.
 */
const MANAGES = `(SELECT account.rolsuper OR (account.rolcreaterole
  AND (pg_catalog.current_setting('server_version_num')::int < 160000
    OR pg_catalog.pg_has_role(account.oid, login.oid, 'MEMBER WITH ADMIN OPTION')))
  FROM pg_catalog.pg_roles account WHERE account.rolname = current_user)`;

/**
 * Whether the session `backend` is connected to this database as a role that no longer exists.
 * PostgreSQL drops a role while sessions of it are connected, and a session that connects while
 * the drop is still committing stays connected too.  Such a session keeps what PUBLIC holds, and
 * no login's row names it.
 */
const STRAY = `backend.datname = pg_catalog.current_database() AND backend.usesysid IS NOT NULL
  AND backend.usename IS NULL AND backend.pid <> pg_catalog.pg_backend_pid()`;

/**
 * Whether the account may end a session whose role is gone.  Membership in the role went with the
 * role, so PostgreSQL asks for a superuser or a member of pg_signal_backend.
 */
const SIGNALS = `pg_catalog.pg_has_role(current_user, 'pg_signal_backend', 'USAGE')`;

/** The statement that ends the sessions of a login's role, for whoever runs it and may end them */
const endsSessions = (role: string) =>
  `SELECT CASE WHEN pg_catalog.pg_has_role(current_user, usesysid, 'USAGE') THEN pg_catalog.pg_terminate_backend(pid) END FROM pg_catalog.pg_stat_activity WHERE usename = ${literal(role)};`;

/** The statement that ends the sessions whose role is gone, for whoever runs it and may end them */
const ENDS_STRAYS = `SELECT CASE WHEN ${SIGNALS} THEN pg_catalog.pg_terminate_backend(backend.pid) END FROM pg_catalog.pg_stat_activity backend WHERE ${STRAY.replace(/\s+/g, ' ')};`;

/**
 * Whether the role `login` has session defaults of its own for this database.  A role may set them
 * for itself, PostgreSQL keeps them apart from the role's other defaults, and they come first when
 * a session starts.
 */
const SCOPED = `EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting setting
  JOIN pg_catalog.pg_database d ON d.oid = setting.setdatabase
  WHERE setting.setrole = login.oid AND d.datname = pg_catalog.current_database())`;

/** Whether the session `backend` holds a lock that some other session is waiting on */
const BLOCKS = `EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity waiting WHERE waiting.wait_event_type = 'Lock'
  AND backend.pid = ANY (pg_catalog.pg_blocking_pids(waiting.pid)))`;

/**
 * Whether the session `backend` has outstayed a login's limits, where $2 is the longest a statement
 * may run or a transaction sit idle, in milliseconds, and $3 is the share of the notification queue
 * that may be in use.  A statement runs that long only once its session has lifted the statement
 * timeout.  A transaction left idle keeps its locks and holds back cleanup.  A transaction that
 * keeps working, as a tool reading a large result in batches does, may stay, unless the
 * notification queue is filling: a session that listens inside a transaction is what keeps
 * PostgreSQL from clearing the queue, and a full queue fails every change the server makes.
 */
const OVERDUE = `${BLOCKS}
  OR (backend.state IN ('active', 'fastpath function call')
    AND backend.query_start < clock_timestamp() - $2::float8 * interval '1 millisecond')
  OR (backend.state LIKE 'idle in transaction%'
    AND backend.state_change < clock_timestamp() - $2::float8 * interval '1 millisecond')
  OR (backend.xact_start IS NOT NULL AND pg_catalog.pg_notification_queue_usage() > $3::float8)`;

/**
 * Runs `work` in a savepoint with a short wait for locks.  Answers false, with nothing `work`
 * changed, when it fails.
 */
async function attempt(db: Queryable, work: () => Promise<void>): Promise<boolean> {
  const wait = (value: string) => db.query(`SELECT pg_catalog.set_config('lock_timeout', $1, true)`, [value]);
  const usual = (
    await db.query<{ value: string }>(`SELECT pg_catalog.current_setting('lock_timeout') AS value`)
  ).rows[0]!.value;
  await db.query('SAVEPOINT attempt');
  try {
    await wait(String(LOCK_WAIT_MS));
    await work();
    await wait(usual);
    await db.query('RELEASE SAVEPOINT attempt');
    return true;
  } catch {
    // Rolling back puts the usual wait back too.
    await db.query('ROLLBACK TO SAVEPOINT attempt');
    await db.query('RELEASE SAVEPOINT attempt');
    return false;
  }
}

/**
 * Ends sessions of logins' roles, which is how the server takes back the locks they hold.  It ends
 * only those PostgreSQL lets it end, and checkRole opens no login whose sessions it couldn't.
 * `which` narrows them by a condition on the session, `backend`.
 */
async function endSessions(
  db: Queryable,
  roles: string | string[],
  which = 'true',
  values: unknown[] = [],
): Promise<void> {
  const names = [roles].flat();
  if (!names.length) return;
  await db.query(
    `SELECT CASE WHEN pg_catalog.pg_has_role(current_user, backend.usesysid, 'USAGE')
      THEN pg_catalog.pg_terminate_backend(backend.pid) END
    FROM pg_catalog.pg_stat_activity backend WHERE backend.usename::text = ANY ($1::text[]) AND (${which})`,
    [names, ...values],
  );
}

/**
 * Ends the sessions whose role is gone, when the account may.  It looks twice, so a role made since
 * the first look, whose session only seemed to have none, keeps its session.
 */
async function endStrays(db: Queryable): Promise<void> {
  const strays = await db.query<{ pid: number }>(
    `SELECT backend.pid FROM pg_catalog.pg_stat_activity backend WHERE ${STRAY} AND ${SIGNALS}`,
  );
  if (!strays.rowCount) return;
  await db.query(
    `SELECT pg_catalog.pg_terminate_backend(backend.pid) FROM pg_catalog.pg_stat_activity backend
    WHERE backend.pid = ANY ($1::int[]) AND ${STRAY}`,
    [strays.rows.map((row) => row.pid)],
  );
}

const ROLE_PREFIX = 'rio_read_';
const SCHEMA_PREFIX = 'rio_sql_';
export function loginNames(databaseId: string, appSchema: string) {
  const suffix = createHash('sha256').update(`${appSchema}:${databaseId}`).digest('hex').slice(0, 24);
  return { role: `${ROLE_PREFIX}${suffix}`, schema: `${SCHEMA_PREFIX}${suffix}` };
}
function passwordVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
async function person(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  userId: string,
): Promise<Actor> {
  const found = await query<{ org_id: string; kind: Actor['kind'] }>(
    db,
    sql`SELECT m.org_id, m.kind
    FROM ${ident(schemas.app, 'memberships')} m JOIN ${ident(schemas.app, 'users')} u ON u.id = m.user_id
    JOIN ${ident(schemas.app, 'databases')} d ON d.org_id = m.org_id
    WHERE d.id = ${databaseId} AND d.trashed_at IS NULL AND m.user_id = ${userId} AND u.deactivated_at IS NULL`,
  );
  const row = found.rows[0];
  if (!row) throw new AppError('validation_failed', 'sql.login.person');
  return { userId, orgId: row.org_id, kind: row.kind, adminRoles: [], sessionId: '', csrfToken: '' };
}
/**
 * Whether reading as a person stays within what an admin reads themselves.  Nobody widens their
 * own access, so an admin chooses someone else only while no field rule or record rule limits
 * what they read in the database.  Anyone may choose themselves.
 */
async function readsWithin(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
  personId: string,
  adminId: string | null,
  admin?: Actor,
): Promise<boolean> {
  if (!adminId) return false;
  if (adminId === personId) return true;
  try {
    const scope = new AccessScope(db, schemas, admin ?? (await person(db, schemas, databaseId, adminId)));
    await scope.require(databaseId, 'read');
    return !scope.limited(databaseId);
  } catch {
    return false;
  }
}

/**
 * Turns a login off for good: in the rebuild that found it reading wider than its admin, once the
 * server no longer allows outside logins, or when its database goes to the trash or is deleted for
 * good.
 */
async function turnOff(
  db: Queryable,
  schemas: DataSchemas,
  row: LoginRow,
  reason: 'widened' | 'notAllowed' | 'trashed' | 'purged',
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${table(schemas)} SET enabled = false, ready = false, verified = false, verifier = NULL,
    sealed_password = NULL WHERE database_id = ${row.database_id}`,
  );
  const metadata = {
    databaseId: row.database_id,
    personId: row.person_id,
    enabledBy: row.enabled_by,
    reason,
  };
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
    SELECT org_id, NULL, 'databases.sql.loginDisabled', ${JSON.stringify(metadata)}::jsonb
    FROM ${ident(schemas.app, 'databases')} WHERE id = ${row.database_id}`,
  );
  await remove(db, schemas, row);
}

/**
 * Removes a login that is off: its sessions, schema, and role, and then its row.  The row already
 * closes the views, so this waits on no session for long.  It tries again once the sessions have
 * ended and the views are gone.  What it still can't remove, for want of a privilege or of a lock a
 * session holds, stays for the cleanup SQL admins see.  Views that stay go at a later refresh, and
 * until then the role can name none of them to take a new lock.
 */
async function remove(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<void> {
  await joinRole(db, row);
  const drop = () =>
    attempt(db, async () => {
      await db.query(await provisionSql(db, schemas, { ...row, enabled: false }));
      await query(db, sql`DELETE FROM ${table(schemas)} WHERE database_id = ${row.database_id}`);
    });
  if (await drop()) return;
  await endSessions(db, row.role_name);
  if ((await dropViews(db, row)) && (await drop())) return;
  await shutOut(db, row);
}

/**
 * Removes a database's login before the database is deleted for good.  The login's row goes with
 * the database, and the row is what keeps the role's sessions in check, so the role goes first.
 *
 * Deleting the database closes every login's views, which locks every login's row in this order,
 * as any change to who may read what does.  Locking them the same way here keeps this from holding
 * one row while such a change holds the rows before it.
 */
export async function dropLogin(db: Queryable, schemas: DataSchemas, databaseId: string): Promise<void> {
  const known = await query(db, sql`SELECT 1 FROM ${table(schemas)} WHERE database_id = ${databaseId}`);
  if (!known.rowCount) return;
  const rows = await query<LoginRow>(
    db,
    sql`SELECT * FROM ${table(schemas)} ORDER BY database_id FOR UPDATE`,
  );
  const row = rows.rows.find((login) => login.database_id === databaseId);
  if (!row) return;
  if (row.enabled) await turnOff(db, schemas, row, 'purged');
  else await remove(db, schemas, row);
}

/**
 * Takes a login's use of its schema away once the login is off.  Without it the role can name no
 * view, so no new session of it takes a lock on one while the schema waits to be dropped.
 */
async function shutOut(db: Queryable, row: LoginRow): Promise<void> {
  await attempt(db, async () => {
    await db.query(`REVOKE ALL ON SCHEMA ${quoteName(row.schema_name)} FROM ${quoteName(row.role_name)}`);
  });
}

/**
 * Removes a login's views and answers whether they're gone.  A session that is reading one holds a
 * lock on it, so the drop waits briefly, then ends the sessions that are inside a transaction and
 * tries once more.  Views that stay are closed by the login's row, which every view reads first.
 */
async function dropViews(db: Queryable, row: LoginRow): Promise<boolean> {
  const drop = () =>
    attempt(db, async () => {
      const views = await db.query<{ relname: string }>(
        `SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'v'`,
        [row.schema_name],
      );
      for (const view of views.rows)
        await db.query(`DROP VIEW ${quoteName(row.schema_name)}.${quoteName(view.relname)}`);
    });
  if (await drop()) return true;
  await endSessions(db, row.role_name, 'backend.xact_start IS NOT NULL');
  return drop();
}

/** Closes a login's views without turning it off.  The row closes them, and then the views go. */
async function closeViews(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<void> {
  await query(db, sql`UPDATE ${table(schemas)} SET ready = false WHERE database_id = ${row.database_id}`);
  await dropViews(db, row);
}

/**
 * Only view ownership is needed after a database administrator provisions the role and schema.
 * Returns whether it built the views.  A person whose access has grown past the admin's turns the
 * login off instead.
 */
export async function rebuildLogin(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<boolean> {
  if (!(await dropViews(db, row))) {
    // Views a session still holds keep their old text, so the login stays closed until they go.
    await query(db, sql`UPDATE ${table(schemas)} SET ready = false WHERE database_id = ${row.database_id}`);
    return false;
  }
  if (!row.enabled || !row.person_id) return false;
  if (!(await readsWithin(db, schemas, row.database_id, row.person_id, row.enabled_by))) {
    await turnOff(db, schemas, row, 'widened');
    return false;
  }
  const expiresAt = new Date();
  expiresAt.setUTCHours(24, 0, 0, 0);
  const actor = await person(db, schemas, row.database_id, row.person_id);
  const scope = new AccessScope(db, schemas, actor);
  const { sources } = await projections(db, schemas, scope, row.database_id);
  for (const [name, { select }] of sources) {
    // Relative date rules use UTC days.  Expiration closes the midnight boundary until refresh.
    const gate = embedded(sql`SELECT ready FROM ${table(schemas)} WHERE database_id = ${row.database_id}
      AND enabled AND statement_timestamp() < expires_at`);
    const view = `${quoteName(row.schema_name)}.${quoteName(name)}`;
    await db.query(
      `CREATE VIEW ${view} WITH (security_barrier = true) AS SELECT * FROM (${select}) AS scoped WHERE (${gate})`,
    );
    await db.query(`REVOKE ALL ON ${view} FROM PUBLIC`);
    await db.query(`GRANT SELECT ON ${view} TO ${quoteName(row.role_name)}`);
  }
  await query(
    db,
    sql`UPDATE ${table(schemas)} SET ready = true, expires_at = ${expiresAt}, rebuilt_at = clock_timestamp() WHERE database_id = ${row.database_id}`,
  );
  return true;
}

/** The defaults each session of a login starts with.  The session can change them, so none is a limit. */
async function roleDefaults(
  db: Queryable,
  schemas: DataSchemas,
  row: LoginRow,
): Promise<Array<{ name: string; value: string; sql: string }>> {
  const settings = await settingsFor(db, schemas, row.database_id);
  return [
    { name: 'default_transaction_read_only', value: 'on', sql: 'on' },
    { name: 'statement_timeout', value: String(settings.timeoutMs), sql: String(settings.timeoutMs) },
    { name: 'search_path', value: row.schema_name, sql: quoteName(row.schema_name) },
  ];
}

async function provisionSql(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<string> {
  const identity = (
    await db.query<{ name: string; database: string; superuser: boolean }>(
      `SELECT current_user AS name, current_database() AS database,
        (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser`,
    )
  ).rows[0]!;
  const role = quoteName(row.role_name);
  const schema = quoteName(row.schema_name);
  const found = await db.query<{ limited: boolean; member: boolean; scoped: boolean }>(
    `SELECT ${TEMP_FILE_LIMITED} AS limited, ${MEMBER} AS member, ${SCOPED} AS scoped
    FROM pg_catalog.pg_roles login WHERE login.rolname = $1`,
    [row.role_name],
  );
  const exists = found.rowCount;
  if (!row.enabled)
    return [
      // A session that holds a view would keep the schema from being dropped.
      ...(exists ? [endsSessions(row.role_name)] : []),
      `DROP SCHEMA IF EXISTS ${schema} CASCADE;`,
      ...(exists
        ? [
            `REVOKE CONNECT ON DATABASE ${quoteName(identity.database)} FROM ${role};`,
            // A role can't be dropped while it owns anything, such as a large object.
            `DROP OWNED BY ${role};`,
            // PostgreSQL drops a role that has sessions, and a tool that reconnects at once has
            // one again by now.
            endsSessions(row.role_name),
            `DROP ROLE ${role};`,
          ]
        : []),
    ].join('\n');
  return [
    ...((await publicSchemaCreates(db)) ? [REVOKE_PUBLIC_CREATE] : []),
    ...(await publicDefaultsSql(db)),
    `${exists ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 10 PASSWORD ${literal(row.verifier)};`,
    // A role may also change its defaults for one database, and those come first when a session starts.
    ...(found.rows[0]?.scoped
      ? [`ALTER ROLE ${role} IN DATABASE ${quoteName(identity.database)} RESET ALL;`]
      : []),
    ...(await roleDefaults(db, schemas, row)).map(
      (setting) => `ALTER ROLE ${role} SET ${setting.name} = ${setting.sql};`,
    ),
    // The client can change the defaults above for its session.  It can't change this one.
    ...(found.rows[0]?.limited
      ? []
      : [`ALTER ROLE ${role} SET temp_file_limit = '${LOGIN_TEMP_FILE_LIMIT}';`]),
    // Membership is what lets the application account end the role's sessions.  A superuser needs none.
    ...((found.rows[0]?.member ?? identity.superuser)
      ? []
      : [`GRANT ${role} TO ${quoteName(identity.name)};`]),
    `CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${quoteName(identity.name)};`,
    `REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${role};`,
    `GRANT CONNECT ON DATABASE ${quoteName(identity.database)} TO ${role};`,
  ].join('\n');
}

/**
 * The SQL a database administrator runs for a login.  Sessions end once more after it commits: one
 * that connected while it ran came in under the old password and without the role's limits, and
 * one that connected while the role was being dropped is left with no role.
 */
async function administratorSql(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<string> {
  const after = row.enabled ? endsSessions(row.role_name) : ENDS_STRAYS;
  return `BEGIN;\n${await provisionSql(db, schemas, row)}\nCOMMIT;\n${after}`;
}

/**
 * Reject an existing role with extra access, including grants inherited through PUBLIC.  The role
 * may take no advisory lock, write no temporary table or large object, fill no more disk than its
 * limit, and read no view's text, since its session can lift every limit that is only a default.
 * It reads its views under a lock it can keep for as long as it likes, so the server must also be
 * able to end its sessions, and no lock may outlive a session.
 */
async function checkRole(db: Queryable, row: LoginRow): Promise<boolean> {
  const roles = await db.query<{ safe: boolean }>(
    `SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls) AND rolcanlogin
      AND ${TEMP_FILE_LIMITED} AND ${MEMBER} AS safe FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [row.role_name],
  );
  if (!roles.rows[0]?.safe) return false;
  if (await preparedTransactions(db)) return false;
  const shared = await db.query(
    `SELECT 1 WHERE has_table_privilege($1, 'pg_catalog.pg_rewrite', 'SELECT')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE ${SHARED_ROUTINES} AND has_function_privilege($1, p.oid, 'EXECUTE'))`,
    [row.role_name],
  );
  if (shared.rowCount) return false;
  const creation = await db.query(
    `SELECT 1 WHERE has_database_privilege($1, current_database(), 'CREATE,TEMPORARY')
    OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND has_schema_privilege($1, oid, 'CREATE'))`,
    [row.role_name],
  );
  if (creation.rowCount) return false;
  const memberships = await db.query(
    `SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
    [row.role_name],
  );
  if (memberships.rowCount) return false;
  const unsafe = await db.query(
    `SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (has_table_privilege($1, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR (n.nspname <> $2 AND has_table_privilege($1, c.oid, 'SELECT'))) LIMIT 1`,
    [row.role_name, row.schema_name],
  );
  if (unsafe.rowCount) return false;
  const columns = await db.query(
    `SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND (has_column_privilege($1, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES') OR (n.nspname <> $2 AND has_column_privilege($1, c.oid, a.attnum, 'SELECT'))) LIMIT 1`,
    [row.role_name, row.schema_name],
  );
  if (columns.rowCount) return false;
  const sequences = await db.query(
    `SELECT 1 FROM pg_catalog.pg_class c WHERE CASE WHEN c.relkind = 'S' THEN has_sequence_privilege($1, c.oid, 'USAGE,SELECT,UPDATE') ELSE false END LIMIT 1`,
    [row.role_name],
  );
  if (sequences.rowCount) return false;
  const schema = await db.query(
    `SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $2 AND nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) AND has_schema_privilege($1, oid, 'USAGE') AND NOT has_schema_privilege($1, oid, 'CREATE')`,
    [row.role_name, row.schema_name],
  );
  if (!schema.rowCount) return false;
  const routines = await db.query(
    `SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND p.prosecdef AND has_function_privilege($1, p.oid, 'EXECUTE') LIMIT 1`,
    [row.role_name],
  );
  return !routines.rowCount;
}

export async function loginStatus(
  db: Queryable,
  schemas: DataSchemas,
  databaseId: string,
): Promise<SqlLogin> {
  const found = await query<LoginRow>(
    db,
    sql`SELECT * FROM ${table(schemas)} WHERE database_id = ${databaseId}`,
  );
  const row = found.rows[0];
  const names = loginNames(databaseId, schemas.app);
  if (!row) return { enabled: false, ready: false, personId: null, ...names };
  return {
    enabled: row.enabled,
    ready: row.ready,
    personId: row.person_id,
    ...names,
    ...(!row.ready ? { sql: await administratorSql(db, schemas, row) } : {}),
    ...(!row.ready && row.enabled ? await setupIssue(db) : {}),
  };
}

/** What about the PostgreSQL database keeps every login closed, when something does */
async function setupIssue(db: Queryable): Promise<{ reason?: SqlSetupIssue }> {
  if (await publicSchemaCreates(db)) return { reason: 'sql.setup.publicCreate' };
  if ((await publicDefaultsSql(db)).length) return { reason: 'sql.setup.publicDefaults' };
  if (await preparedTransactions(db)) return { reason: 'sql.setup.preparedTransactions' };
  return {};
}

/**
 * `allowed` is whether the server allows outside logins.  It is checked here too, under the lock on
 * the login's row, so a login the pass that closes them hasn't reached is turned off, and never
 * checked and rebuilt.
 */
export async function changeLogin(
  pool: pg.Pool,
  schemas: DataSchemas,
  key: Buffer,
  actor: Actor,
  databaseId: string,
  action: 'enable' | 'rotate' | 'disable' | 'check',
  personId?: string,
  allowed = true,
): Promise<SqlLogin> {
  let password: string | undefined;
  let provisioned = false;
  let opened = false;
  let taken = false;
  const names = loginNames(databaseId, schemas.app);
  await withTransaction(pool, async (db) => {
    const limited = !organizationAdmin(actor, 'security');
    if (limited) {
      await lockUnits(db, actor.orgId);
      if (!(await unitResourceAdmin(db, quoteName(schemas.app), actor, 'database', databaseId, 'security')))
        throw new AppError('forbidden', 'errors.adminOnly');
    }
    await query(
      db,
      sql`INSERT INTO ${table(schemas)} (database_id, role_name, schema_name) VALUES (${databaseId}, ${names.role}, ${names.schema}) ON CONFLICT DO NOTHING`,
    );
    const row = (
      await query<LoginRow>(
        db,
        sql`SELECT * FROM ${table(schemas)} WHERE database_id = ${databaseId} FOR UPDATE`,
      )
    ).rows[0]!;
    opened = row.enabled && row.ready;
    if (limited) {
      if (row.person_id)
        actor.auditUnitId = await requirePerson(db, quoteName(schemas.app), actor, row.person_id, 'security');
      if (action === 'enable' && personId)
        actor.auditUnitId = await requirePerson(db, quoteName(schemas.app), actor, personId, 'security');
    }
    if (!allowed) {
      if (action === 'enable' || action === 'rotate')
        throw new AppError('forbidden', 'sql.setup.outsideLogins');
      if (action === 'check' && row.enabled) {
        await turnOff(db, schemas, row, 'notAllowed');
        return;
      }
    }
    if (action !== 'check') {
      row.ready = false;
      row.verified = false;
      row.enabled = action !== 'disable';
      if (action === 'enable') row.person_id = personId ?? null;
      if (row.enabled) {
        if (!row.person_id) throw new AppError('validation_failed', 'sql.login.person');
        const chosen = await person(db, schemas, databaseId, row.person_id);
        await new AccessScope(db, schemas, chosen).require(databaseId, 'read');
        // Enabling and rotating both hand the actor a password that reads as the chosen person.
        if (!(await readsWithin(db, schemas, databaseId, row.person_id, actor.userId, actor)))
          throw new AppError('forbidden', 'sql.login.widen');
        row.enabled_by = actor.userId;
        password = randomBytes(32).toString('base64url');
        row.verifier = passwordVerifier(password);
        row.sealed_password = await sealCredential(key, password, `sql-login:${databaseId}`, actor.orgId, db);
      }
      // The row closes the views before anything waits on a lock, and whoever was connected with
      // the old password, or held a view, goes with it.
      await query(
        db,
        sql`UPDATE ${table(schemas)} SET enabled = ${row.enabled}, ready = false, verified = false,
        person_id = ${row.person_id}, enabled_by = ${row.enabled_by}, verifier = ${row.verifier},
        sealed_password = ${row.sealed_password} WHERE database_id = ${databaseId}`,
      );
      await joinRole(db, row);
      await endSessions(db, row.role_name);
      await dropViews(db, row);
    }
    if (row.enabled) {
      await hardenPublicSchema(db);
      taken = (await hardenDatabase(db)) === 'taken';
    }
    const passed = await attempt(db, async () => {
      if (action !== 'check') await db.query(await provisionSql(db, schemas, row));
      if (row.enabled) {
        if (!(await checkRole(db, row))) throw new AppError('validation_failed', 'sql.login.privileges');
        await query(db, sql`UPDATE ${table(schemas)} SET ready = false WHERE database_id = ${databaseId}`);
      } else {
        const remains = await db.query(
          'SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1 UNION ALL SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $2',
          [row.role_name, row.schema_name],
        );
        if (remains.rowCount) throw new AppError('validation_failed', 'sql.login.privileges');
        await query(db, sql`DELETE FROM ${table(schemas)} WHERE database_id = ${databaseId}`);
      }
    });
    provisioned = passed && row.enabled;
    // A failed check keeps views absent, including when a DBA changed the role's grants.  Any other
    // action has closed them already.
    if (!passed && action === 'check') await closeViews(db, schemas, row);
    if (!passed && action === 'disable') await shutOut(db, row);
    await auditEvent(db, quoteName(schemas.audit), 'databases.sql.loginChanged', actor, {
      databaseId,
      action,
      personId: row.person_id,
    });
  });
  // A session that connected while the change was still committing came in under what the change
  // replaced: the old password, or a role that is now gone.  Checking a login that is open and
  // stays open changes nothing, so its sessions stay.
  if (action !== 'check' || !opened || !allowed) await endSessions(pool, names.role);
  await endStrays(pool);
  if (taken) await endLogins(pool, schemas);
  if (allowed && (action === 'check' || provisioned))
    await verifyLogin(pool, schemas, key, databaseId, actor.orgId);
  return { ...(await loginStatus(pool, schemas, databaseId)), ...(password ? { password } : {}) };
}

/**
 * Makes the application account a member of a login's role when it manages the role and isn't one
 * yet.  Membership is what lets it end the role's sessions and drop what the role owns.
 */
async function joinRole(db: Queryable, row: LoginRow): Promise<void> {
  const outside = await db.query(
    `SELECT 1 FROM pg_catalog.pg_roles login WHERE login.rolname = $1
    AND NOT pg_catalog.pg_has_role(current_user, login.oid, 'USAGE') AND ${MANAGES}`,
    [row.role_name],
  );
  if (!outside.rowCount) return;
  await attempt(db, async () => {
    await db.query(`GRANT ${quoteName(row.role_name)} TO CURRENT_USER`);
  });
}

/**
 * Brings a login's role up to what checkRole asks, as far as the application account may, which is
 * how a role made before a requirement existed comes to meet it.  A superuser gives the role a
 * limit on temporary files that the role can't lift.  An account that manages the role joins it,
 * and puts back the session defaults, which a role may change for itself, for every database or
 * for this one.  Any other account leaves all of it to the administrator SQL.
 *
 * Answers whether it set the limit.  PostgreSQL applies the limit when a session starts, so the
 * role's sessions from before have none, and the caller ends them once the change has committed.
 */
async function hardenRole(db: Queryable, schemas: DataSchemas, row: LoginRow): Promise<boolean> {
  const role = (
    await db.query<{
      superuser: boolean;
      manages: boolean;
      limited: boolean;
      scoped: boolean;
      config: string[] | null;
      database: string;
    }>(
      `SELECT (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser,
        ${MANAGES} AS manages, ${TEMP_FILE_LIMITED} AS limited, ${SCOPED} AS scoped,
        login.rolconfig AS config, pg_catalog.current_database() AS database
      FROM pg_catalog.pg_roles login WHERE login.rolname = $1`,
      [row.role_name],
    )
  ).rows[0];
  if (!role) return false;
  const name = quoteName(row.role_name);
  const limits = role.superuser && !role.limited;
  if (limits) await db.query(`ALTER ROLE ${name} SET temp_file_limit = '${LOGIN_TEMP_FILE_LIMIT}'`);
  if (!role.manages) return limits;
  await joinRole(db, row);
  const changed = (await roleDefaults(db, schemas, row)).filter(
    (setting) => !role.config?.includes(`${setting.name}=${setting.value}`),
  );
  if (changed.length || role.scoped)
    await attempt(db, async () => {
      if (role.scoped) await db.query(`ALTER ROLE ${name} IN DATABASE ${quoteName(role.database)} RESET ALL`);
      for (const setting of changed)
        await db.query(`ALTER ROLE ${name} SET ${setting.name} = ${setting.sql}`);
    });
  return limits;
}

/**
 * Whether a login is due a rebuild, or another check of what its role and PUBLIC may do.  A login
 * whose database is in the trash is due neither: it is turned off instead.
 */
const due = (schemas: DataSchemas, open: boolean) =>
  sql`login.enabled AND login.verified AND (NOT login.ready OR login.expires_at <= clock_timestamp() OR ${open}
    OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = login.role_name
      AND ${new Sql([`${TEMP_FILE_LIMITED} AND ${MEMBER}`], [])}))
    AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d
      WHERE d.id = login.database_id AND d.trashed_at IS NULL)`;

/** Runs every step, so one that fails holds up no other, then throws the first failure. */
async function runAll(steps: Array<() => Promise<unknown>>): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) await step().catch((error: unknown) => failures.push(error));
  if (failures.length) throw failures[0];
}

/**
 * Runs `work` for each login in a transaction of its own, so a login that fails, or whose session
 * holds a lock, holds up no other.
 */
function eachLogin(
  pool: pg.Pool,
  databaseIds: string[],
  work: (db: Queryable, databaseId: string) => Promise<void>,
): Promise<void> {
  return runAll(databaseIds.map((databaseId) => () => withTransaction(pool, (db) => work(db, databaseId))));
}

interface Connected {
  database_id: string;
  role_name: string;
  enabled: boolean;
}

/** The role and schema of a login that has no row */
interface Leftover {
  role_name: string;
  schema_name: string;
}

interface Survey {
  connected: Connected[];
  closed: string[];
  trashed: string[];
  leftovers: Leftover[];
}

/**
 * What every pass over the logins looks for first: the logins with a session connected, the ones
 * that are off and still need cleanup, the ones that are on while their database is in the trash,
 * and the schemas of logins that have no row.
 *
 * A login's row is what the server ends its sessions by, so a login never keeps its role past its
 * row.  A version that deleted a database for good without removing its login left one that does.
 * Its schema, which the application account owns, is how it is known.  Another install that keeps
 * its tables in this same PostgreSQL database names its logins' schemas the same way, so the
 * leftovers are looked for only while this install has the database to itself.
 */
async function survey(db: Queryable, schemas: DataSchemas): Promise<Survey> {
  const connected = await query<Connected>(
    db,
    sql`SELECT login.database_id, login.role_name, login.enabled FROM ${table(schemas)} login WHERE EXISTS (
      SELECT 1 FROM pg_catalog.pg_stat_activity backend WHERE backend.usename = login.role_name)`,
  );
  // Cascading permission changes can remove the views after a person's delete deferred cleanup.
  // Retry remaining schemas and roles even without views, and leave already cleaned rows alone.
  const closed = await query<{ database_id: string }>(
    db,
    sql`SELECT login.database_id FROM ${table(schemas)} login WHERE NOT login.enabled AND (
      EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname = login.schema_name)
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles role WHERE role.rolname = login.role_name)
    ) ORDER BY login.database_id`,
  );
  const trashed = await query<{ database_id: string }>(
    db,
    sql`SELECT login.database_id FROM ${table(schemas)} login
    JOIN ${ident(schemas.app, 'databases')} d ON d.id = login.database_id
    WHERE login.enabled AND d.trashed_at IS NOT NULL ORDER BY login.database_id`,
  );
  const leftovers = await query<Leftover>(
    db,
    sql`SELECT n.nspname::text AS schema_name,
      ${ROLE_PREFIX}::text || substr(n.nspname::text, ${SCHEMA_PREFIX.length + 1}::int) AS role_name
    FROM pg_catalog.pg_namespace n
    WHERE n.nspname::text ~ ${`^${SCHEMA_PREFIX}[0-9a-f]{24}$`}::text
    AND n.nspowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
    AND NOT EXISTS (SELECT 1 FROM ${table(schemas)} login WHERE login.schema_name = n.nspname::text)
    AND (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relname = 'sql_logins' AND c.relkind = 'r') = 1
    ORDER BY n.nspname`,
  );
  return {
    connected: connected.rows,
    closed: closed.rows.map((row) => row.database_id),
    trashed: trashed.rows.map((row) => row.database_id),
    leftovers: leftovers.rows,
  };
}

/** Ends every session of every login, which takes back whatever a session took before a change. */
async function endLogins(pool: pg.Pool, schemas: DataSchemas): Promise<void> {
  const roles = await query<{ role_name: string }>(pool, sql`SELECT role_name FROM ${table(schemas)}`);
  await endSessions(
    pool,
    roles.rows.map((row) => row.role_name),
  );
}

/**
 * Ends the sessions of logins that the server must not leave running: every session of a login
 * that is off, and a session of any other login that holds a lock another session waits on or has
 * outstayed the login's limits.  The query timeout is a default the session can lift, so ending the
 * session is what makes the limit hold.
 */
function endOverdue(
  pool: pg.Pool,
  schemas: DataSchemas,
  connected: Connected[],
  limits: typeof SESSION_LIMITS,
): Promise<void> {
  return runAll(
    connected.map((login) => async () => {
      if (!login.enabled) return endSessions(pool, login.role_name);
      const { timeoutMs } = await settingsFor(pool, schemas, login.database_id);
      return endSessions(pool, login.role_name, OVERDUE, [timeoutMs + limits.graceMs, limits.queueShare]);
    }),
  );
}

/** Finishes removing logins that are off, including ones whose views are already gone. */
function removeClosed(pool: pg.Pool, schemas: DataSchemas, closed: string[]): Promise<void> {
  return eachLogin(pool, closed, async (db, databaseId) => {
    const row = (
      await query<LoginRow>(
        db,
        sql`SELECT * FROM ${table(schemas)} WHERE database_id = ${databaseId} AND NOT enabled FOR UPDATE SKIP LOCKED`,
      )
    ).rows[0];
    if (row) await remove(db, schemas, row);
  });
}

/**
 * Turns off the logins whose databases are in the trash.  A database that comes back from the
 * trash has no login until an admin enables one again.
 */
function closeTrashed(pool: pg.Pool, schemas: DataSchemas, trashed: string[]): Promise<void> {
  return eachLogin(pool, trashed, async (db, databaseId) => {
    const row = (
      await query<LoginRow>(
        db,
        sql`SELECT login.* FROM ${table(schemas)} login WHERE login.database_id = ${databaseId}
        AND login.enabled AND EXISTS (SELECT 1 FROM ${ident(schemas.app, 'databases')} d
          WHERE d.id = login.database_id AND d.trashed_at IS NOT NULL)
        FOR UPDATE OF login SKIP LOCKED`,
      )
    ).rows[0];
    if (row) await turnOff(db, schemas, row, 'trashed');
  });
}

/**
 * Removes the role and schema of each login that has no row, after ending the role's sessions.  An
 * account that may not drop the role would fail at it on every pass, so it only ends the sessions,
 * and the role waits for a database administrator.
 */
function removeLeftovers(pool: pg.Pool, schemas: DataSchemas, leftovers: Leftover[]): Promise<void> {
  return runAll(
    leftovers.map(
      (leftover) => () =>
        withTransaction(pool, async (db) => {
          const state = (
            await db.query<{ claimed: boolean; manages: boolean | null }>(
              `SELECT EXISTS (SELECT 1 FROM ${quoteName(schemas.app)}.sql_logins WHERE schema_name = $1) AS claimed,
                (SELECT ${MANAGES} FROM pg_catalog.pg_roles login WHERE login.rolname = $2) AS manages`,
              [leftover.schema_name, leftover.role_name],
            )
          ).rows[0]!;
          if (state.claimed) return;
          if (state.manages === false) return endSessions(db, leftover.role_name);
          await remove(db, schemas, {
            ...leftover,
            database_id: '',
            person_id: null,
            enabled_by: null,
            enabled: false,
            ready: false,
            verifier: null,
            sealed_password: null,
            verified: false,
          });
        }),
    ),
  );
}

/**
 * Rebuilds the logins whose views were closed or have expired, after ending the sessions that have
 * outstayed their limits.  It also checks every login again while PUBLIC holds a default the login
 * must not have, or its role lacks its disk limit or the application account as a member, which is
 * how a login made before those were required stands.  One that fails the check stays closed until
 * the administrator SQL has run.
 *
 * Every pass also ends the sessions whose role is gone, turns off the logins whose databases are
 * in the trash, and removes what is left of logins that have no row.
 */
export async function refreshLogins(
  pool: pg.Pool,
  schemas: DataSchemas,
  limits: Partial<typeof SESSION_LIMITS> = {},
): Promise<void> {
  const found = await withTransaction(pool, async (db) => {
    await endStrays(db);
    const sessions = await survey(db, schemas);
    const enabled = await query(db, sql`SELECT 1 FROM ${table(schemas)} WHERE enabled AND verified LIMIT 1`);
    if (!enabled.rowCount) return { ...sessions, open: false, taken: false, due: [] };
    const defaults = await hardenDatabase(db);
    const open = defaults === 'held';
    const rows = await query<{ database_id: string }>(
      db,
      sql`SELECT login.database_id FROM ${table(schemas)} login WHERE ${due(schemas, open)} ORDER BY login.database_id`,
    );
    return { ...sessions, open, taken: defaults === 'taken', due: rows.rows.map((row) => row.database_id) };
  });
  // The roles given their limit on temporary files in this pass, whose earlier sessions have none
  const limited: string[] = [];
  await runAll([
    // A session from before PUBLIC lost a default keeps what it took under it, such as an advisory
    // lock or a temporary table, so every login's sessions end now that the change has committed.
    () => (found.taken ? endLogins(pool, schemas) : Promise.resolve()),
    () => endOverdue(pool, schemas, found.connected, { ...SESSION_LIMITS, ...limits }),
    () => removeClosed(pool, schemas, found.closed),
    () => removeLeftovers(pool, schemas, found.leftovers),
    () => closeTrashed(pool, schemas, found.trashed),
    () =>
      eachLogin(pool, found.due, async (db, databaseId) => {
        const row = (
          await query<LoginRow>(
            db,
            sql`SELECT * FROM ${table(schemas)} login WHERE login.database_id = ${databaseId}
            AND ${due(schemas, found.open)} FOR UPDATE OF login SKIP LOCKED`,
          )
        ).rows[0];
        if (!row) return;
        await db.query('SAVEPOINT rebuild');
        try {
          const limits = await hardenRole(db, schemas, row);
          if (await checkRole(db, row)) await rebuildLogin(db, schemas, row);
          else if (row.ready) await closeViews(db, schemas, row);
          if (limits) limited.push(row.role_name);
        } catch {
          await db.query('ROLLBACK TO SAVEPOINT rebuild');
          await closeViews(db, schemas, row);
        }
      }),
    () => endSessions(pool, limited),
  ]);
}

/**
 * Turns every login off while the server doesn't allow outside logins, including the ones enabled
 * before it stopped allowing them, and ends their sessions.  Without the privilege to drop a role,
 * its cleanup SQL waits for a database administrator.  A session left with no role by one pass is
 * ended by the next.
 */
export async function closeLogins(pool: pg.Pool, schemas: DataSchemas): Promise<void> {
  const found = await withTransaction(pool, async (db) => {
    await endStrays(db);
    const enabled = await query<{ database_id: string }>(
      db,
      sql`SELECT database_id FROM ${table(schemas)} WHERE enabled ORDER BY database_id`,
    );
    return { ...(await survey(db, schemas)), enabled: enabled.rows.map((row) => row.database_id) };
  });
  await runAll([
    () =>
      eachLogin(pool, found.enabled, async (db, databaseId) => {
        const row = (
          await query<LoginRow>(
            db,
            sql`SELECT * FROM ${table(schemas)} WHERE database_id = ${databaseId} AND enabled FOR UPDATE SKIP LOCKED`,
          )
        ).rows[0];
        if (row) await turnOff(db, schemas, row, 'notAllowed');
      }),
    () => removeClosed(pool, schemas, found.closed),
    () => removeLeftovers(pool, schemas, found.leftovers),
    () => endOverdue(pool, schemas, found.connected, SESSION_LIMITS),
  ]);
}

/** A reserved public member loses existing SQL credentials and connections before visitors arrive. */
export async function closePersonLogins(
  pool: pg.Pool,
  schemas: DataSchemas,
  personId: string,
): Promise<void> {
  await withTransaction(pool, async (db) => {
    const rows = await query<LoginRow>(
      db,
      sql`SELECT * FROM ${table(schemas)}
      WHERE person_id = ${personId} ORDER BY database_id FOR UPDATE`,
    );
    for (const row of rows.rows) {
      const role = await db.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [row.role_name]);
      // Closing views alone still allows a connection to inspect PostgreSQL's catalogs.
      if (role.rowCount) await db.query(`ALTER ROLE ${quoteName(row.role_name)} NOLOGIN`);
      await endSessions(db, row.role_name);
      await turnOff(db, schemas, row, 'notAllowed');
    }
  });
}

/**
 * Runs `work` while ending, every `everyMs`, any login's session that holds a lock another session
 * waits on.  The migrations at startup run under it: they change the tables a login's views read,
 * and they run before the refresh that would otherwise end such a session.  The logins are read
 * once, before `work`, which may come to wait on the very table that lists them, and there are
 * none before the first migration has made that table.
 */
export async function withoutBlockers<T>(
  pool: pg.Pool,
  schemas: DataSchemas,
  work: () => Promise<T>,
  everyMs = 2_000,
): Promise<T> {
  const known = await pool.query<{ known: boolean }>(
    'SELECT pg_catalog.to_regclass($1) IS NOT NULL AS known',
    [`${quoteName(schemas.app)}.sql_logins`],
  );
  const roles = known.rows[0]!.known
    ? (await query<{ role_name: string }>(pool, sql`SELECT role_name FROM ${table(schemas)}`)).rows.map(
        (row) => row.role_name,
      )
    : [];
  if (!roles.length) return work();
  let ending: Promise<void> | undefined;
  const timer = setInterval(() => {
    ending ??= endSessions(pool, roles, BLOCKS)
      .catch(() => undefined)
      .finally(() => {
        ending = undefined;
      });
  }, everyMs);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await ending;
  }
}

async function verifyLogin(
  pool: pg.Pool,
  schemas: DataSchemas,
  key: Buffer,
  databaseId: string,
  orgId: string,
): Promise<void> {
  let limits = false;
  await withTransaction(pool, async (db) => {
    const row = (
      await query<LoginRow>(
        db,
        sql`SELECT * FROM ${table(schemas)} WHERE database_id = ${databaseId} FOR UPDATE`,
      )
    ).rows[0];
    if (!row?.enabled || !row.sealed_password) return;
    await query(
      db,
      sql`UPDATE ${table(schemas)} SET ready = false, verified = false WHERE database_id = ${databaseId}`,
    );
    await dropViews(db, row);
    await db.query('SAVEPOINT verify');
    try {
      limits = await hardenRole(db, schemas, row);
      if (!(await checkRole(db, row))) return;
      const connection = new pg.Client({
        ...pool.options,
        user: row.role_name,
        password: await unsealCredential(key, row.sealed_password, `sql-login:${databaseId}`, orgId, db),
        connectionTimeoutMillis: 5000,
      });
      try {
        await connection.connect();
        const authenticated = await connection.query<{ name: string }>('SELECT current_user AS name');
        if (authenticated.rows[0]?.name !== row.role_name)
          throw new AppError('validation_failed', 'sql.login.privileges');
      } finally {
        await connection.end();
      }
      if (await rebuildLogin(db, schemas, row))
        await query(db, sql`UPDATE ${table(schemas)} SET verified = true WHERE database_id = ${databaseId}`);
    } catch {
      await db.query('ROLLBACK TO SAVEPOINT verify');
      limits = false;
    }
  });
  // The role's sessions from before it had its limit on temporary files have none.
  if (limits) await endSessions(pool, loginNames(databaseId, schemas.app).role);
}
