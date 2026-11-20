import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type pg from 'pg';
import { withTransaction, type Queryable } from '@riosoma/db';
import type { SqlSetupIssue } from '@riosoma/contracts';
import type { DataSchemas } from '../data/context.js';
import { quoteName } from './guard.js';
import { hardenPublicSchema, publicSchemaCreates, REVOKE_PUBLIC_CREATE } from './schema.js';

/**
 * The columns outside the data schema that scope fragments read: people's names, which link names
 * show for a table whose primary field is a person, and file names, which attachment record rules
 * match.  The role reads nothing else outside the data schema.
 */
const SCOPE_COLUMNS: Record<string, readonly string[]> = {
  users: ['id', 'name'],
  files: ['id', 'name', 'field_id', 'table_id'],
};
const CHECK_EVERY_MS = 60_000;

export interface QueryRole {
  role: string;
  /** Whether queries run as the role */
  active: boolean;
  /** What a database administrator runs to add the role */
  sql: string;
  reason?: SqlSetupIssue;
}

const known = new WeakMap<pg.Pool, { at: number; state: Promise<QueryRole> }>();

/** Forgets what was learned about the role, so the next query checks it again. */
export function forgetQueryRole(pool: pg.Pool): void {
  known.delete(pool);
}

/**
 * The role SQL editor queries run as, which can read the data schema's tables and nothing else
 * that matters.  The server creates it when it may create roles, and grants it what it needs when
 * it already exists.  Otherwise queries run as the server, and admins see the SQL that adds it.
 * What was learned is kept for a minute.
 */
export function queryRole(pool: pg.Pool, schemas: DataSchemas): Promise<QueryRole> {
  const cached = known.get(pool);
  if (cached && performance.now() - cached.at < CHECK_EVERY_MS) return cached.state;
  const state = prepare(pool, schemas);
  known.set(pool, { at: performance.now(), state });
  state.catch(() => known.delete(pool));
  return state;
}

function roleName(database: string, schemas: DataSchemas): string {
  const suffix = createHash('sha256')
    .update(`${database}:${schemas.app}:${schemas.data}`)
    .digest('hex')
    .slice(0, 24);
  return `rio_query_${suffix}`;
}

function grants(schemas: DataSchemas, role: string, owner: string | null): string[] {
  const name = quoteName(role);
  const data = quoteName(schemas.data);
  const app = quoteName(schemas.app);
  return [
    `GRANT USAGE ON SCHEMA ${data} TO ${name};`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA ${data} TO ${name};`,
    `ALTER DEFAULT PRIVILEGES${owner ? ` FOR ROLE ${quoteName(owner)}` : ''} IN SCHEMA ${data} GRANT SELECT ON TABLES TO ${name};`,
    `GRANT USAGE ON SCHEMA ${app} TO ${name};`,
    ...Object.entries(SCOPE_COLUMNS).map(
      ([table, columns]) =>
        `GRANT SELECT (${columns.map(quoteName).join(', ')}) ON ${app}.${quoteName(table)} TO ${name};`,
    ),
  ];
}

async function prepare(pool: pg.Pool, schemas: DataSchemas): Promise<QueryRole> {
  return withTransaction(pool, async (db) => {
    const identity = (
      await db.query<{ user: string; database: string; creates: boolean; version: number }>(
        `SELECT current_user AS user, current_database() AS database,
        (SELECT rolsuper OR rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) AS creates,
        current_setting('server_version_num')::int AS version`,
      )
    ).rows[0]!;
    const role = roleName(identity.database, schemas);
    const exists = async () =>
      Boolean((await db.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1', [role])).rowCount);
    const found = await exists();
    const administratorSql = async () =>
      [
        'BEGIN;',
        ...((await publicSchemaCreates(db)) ? [REVOKE_PUBLIC_CREATE] : []),
        `${(await exists()) ? 'ALTER' : 'CREATE'} ROLE ${quoteName(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`,
        ...grants(schemas, role, identity.user),
        `GRANT ${quoteName(role)} TO ${quoteName(identity.user)};`,
        'COMMIT;',
      ].join('\n');
    await hardenPublicSchema(db);
    if (found && (await usable(db, schemas, role, identity.version)))
      return { role, active: true, sql: await administratorSql() };
    // Grants only change the catalog when something is missing.
    await db.query('SAVEPOINT query_role');
    try {
      if (!found && identity.creates) {
        await db.query(
          `CREATE ROLE ${quoteName(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
        );
        await db.query(`GRANT ${quoteName(role)} TO CURRENT_USER`);
      }
      if (found || identity.creates)
        for (const statement of grants(schemas, role, null)) await db.query(statement);
      await db.query('RELEASE SAVEPOINT query_role');
    } catch {
      await db.query('ROLLBACK TO SAVEPOINT query_role');
    }
    const active = (await exists()) && (await usable(db, schemas, role, identity.version));
    return {
      role,
      active,
      sql: await administratorSql(),
      ...(!active && (await publicSchemaCreates(db)) ? { reason: 'sql.setup.publicCreate' as const } : {}),
    };
  });
}

const literalName = (name: string): string => `'${name.replaceAll("'", "''")}'`;

/**
 * Whether the server may run queries as the role, and the role reads the data schema and no more:
 * no elevated attributes or memberships, nothing it can change or create, nothing it can read
 * outside the data schema but the scope columns, and no security-definer routine it can run.
 */
async function usable(db: Queryable, schemas: DataSchemas, role: string, version: number): Promise<boolean> {
  const plain = await db.query<{ plain: boolean }>(
    `SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin) AS plain
    FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [role],
  );
  if (!plain.rows[0]?.plain) return false;
  const allowed = Object.entries(SCOPE_COLUMNS)
    .map(
      ([table, columns]) =>
        `(c.relname = ${literalName(table)} AND a.attname IN (${columns.map(literalName).join(', ')}))`,
    )
    .join(' OR ');
  const result = await db.query<{ ok: boolean }>(
    `SELECT pg_catalog.pg_has_role(current_user, $1::name, $2)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid = m.member
      WHERE r.rolname = $1)
    AND pg_catalog.has_schema_privilege($1::name, $3::name, 'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $3 AND c.relkind IN ('r', 'p')
      AND NOT pg_catalog.has_table_privilege($1::name, c.oid, 'SELECT'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (pg_catalog.has_table_privilege($1::name, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR (n.nspname <> $3 AND pg_catalog.has_table_privilege($1::name, c.oid, 'SELECT'))))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND a.attnum > 0 AND NOT a.attisdropped
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (pg_catalog.has_column_privilege($1::name, c.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')
        OR (n.nspname <> $3 AND pg_catalog.has_column_privilege($1::name, c.oid, a.attnum, 'SELECT')
          AND NOT (n.nspname = $4 AND (${allowed})))))
    AND NOT pg_catalog.has_database_privilege($1::name, current_database(), 'CREATE')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_'
      AND pg_catalog.has_schema_privilege($1::name, oid, 'CREATE'))
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND p.prosecdef
      AND pg_catalog.has_function_privilege($1::name, p.oid, 'EXECUTE')) AS ok`,
    [role, version >= 160_000 ? 'SET' : 'MEMBER', schemas.data, schemas.app],
  );
  return result.rows[0]?.ok === true;
}
