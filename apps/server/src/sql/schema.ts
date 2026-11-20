import type { Queryable } from '@riosoma/db';
import { quoteName } from './guard.js';

export const REVOKE_PUBLIC_CREATE = 'REVOKE CREATE ON SCHEMA public FROM PUBLIC;';

/** Check the ACL itself: an app's own grants cannot tell us what every role inherits. */
export async function publicSchemaCreates(db: Queryable): Promise<boolean> {
  const result = await db.query<{ creates: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n,
        pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
      WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE'
    ) AS creates`,
  );
  return result.rows[0]!.creates;
}

/**
 * PostgreSQL 14 grants CREATE here to PUBLIC; upgrades can retain that grant on newer versions.
 * Isolate a denied revoke so setup can still return administrator SQL in the same transaction.
 * Keep a successful revoke even if provisioning the dedicated role later fails.
 */
export async function hardenPublicSchema(db: Queryable): Promise<void> {
  if (!(await publicSchemaCreates(db))) return;
  await db.query('SAVEPOINT public_schema');
  try {
    await db.query(REVOKE_PUBLIC_CREATE);
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT public_schema');
  }
  await db.query('RELEASE SAVEPOINT public_schema');
}

/**
 * The built-in functions every role may run by default that an outside login must not: the ones that
 * take an advisory lock, which the server serializes its own work on, the ones that print a view's
 * text, which holds the permission rules of whoever the view reads as, and the ones that write to
 * disk for good, which are the large object functions and the one that writes a message to the
 * write-ahead log.  No privilege on a table and no limit on temporary files covers those.
 */
export const SHARED_ROUTINES = `p.pronamespace = 'pg_catalog'::regnamespace
  AND (p.proname ~ '^pg_(try_)?advisory_(xact_)?lock(_shared)?$' OR p.proname ~ '^(lo_.*|loread|lowrite)$'
    OR p.proname IN ('pg_get_viewdef', 'pg_get_ruledef', 'pg_logical_emit_message'))`;

/** The most disk one process of an outside login may fill with temporary files */
export const LOGIN_TEMP_FILE_LIMIT = '1GB';

/**
 * Whether the PostgreSQL server allows prepared transactions.  One holds its locks after its
 * session ends, and only a superuser or the role that prepared it can roll it back, so the server
 * could not take a lock back from a login that prepared one.
 */
export async function preparedTransactions(db: Queryable): Promise<boolean> {
  const result = await db.query<{ allowed: boolean }>(
    `SELECT pg_catalog.current_setting('max_prepared_transactions')::int > 0 AS allowed`,
  );
  return result.rows[0]!.allowed;
}

/** Whether a role setting caps temporary files.  Only a superuser sets it, so the role can't lift it. */
export const TEMP_FILE_LIMITED = `EXISTS (SELECT 1 FROM unnest(rolconfig) AS setting
  WHERE split_part(setting, '=', 1) = 'temp_file_limit' AND setting <> 'temp_file_limit=-1')`;

interface PublicDefaults {
  account: string;
  database: string;
  superuser: boolean;
  routines: string[];
  rules: boolean;
  temporary: boolean;
}

/** What PUBLIC still holds of the defaults an outside login must not have, read from the ACLs. */
async function publicDefaults(db: Queryable): Promise<PublicDefaults> {
  const result = await db.query<PublicDefaults>(
    `SELECT current_user AS account, current_database() AS database,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user) AS superuser,
      ARRAY(SELECT format('pg_catalog.%I(%s)', p.proname, pg_catalog.oidvectortypes(p.proargtypes))
        FROM pg_catalog.pg_proc p WHERE ${SHARED_ROUTINES} AND EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE')
        ORDER BY 1) AS routines,
      EXISTS (SELECT 1 FROM pg_catalog.pg_class c,
        pg_catalog.aclexplode(COALESCE(c.relacl, pg_catalog.acldefault('r', c.relowner))) a
        WHERE c.oid = 'pg_catalog.pg_rewrite'::regclass AND a.grantee = 0 AND a.privilege_type = 'SELECT') AS rules,
      EXISTS (SELECT 1 FROM pg_catalog.pg_database d,
        pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a
        WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY') AS temporary`,
  );
  return result.rows[0]!;
}

/**
 * The statements that take those defaults from PUBLIC.  Each grant comes first, so the application
 * account keeps its own advisory locks and temporary tables, and whatever else it had.  Changing the
 * privileges of built-in functions takes a superuser.
 */
export async function publicDefaultsSql(db: Queryable): Promise<string[]> {
  const state = await publicDefaults(db);
  const account = quoteName(state.account);
  const database = quoteName(state.database);
  const routines = state.routines.join(', ');
  return [
    ...(state.routines.length
      ? [
          `GRANT EXECUTE ON FUNCTION ${routines} TO ${account};`,
          `REVOKE EXECUTE ON FUNCTION ${routines} FROM PUBLIC;`,
        ]
      : []),
    ...(state.rules
      ? [
          `GRANT SELECT ON pg_catalog.pg_rewrite TO ${account};`,
          'REVOKE SELECT ON pg_catalog.pg_rewrite FROM PUBLIC;',
        ]
      : []),
    ...(state.temporary
      ? [
          `GRANT TEMPORARY ON DATABASE ${database} TO ${account};`,
          `REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC;`,
        ]
      : []),
  ];
}

/**
 * Takes PUBLIC's defaults away when the application account is a superuser.  Another account leaves
 * them to the administrator SQL, and the logins stay closed.
 *
 * Answers how the defaults stand: `clear` when PUBLIC held none, `taken` when this call took them
 * away, and `held` while any remain.  A session that began before they were taken keeps what it
 * took under them, so whoever gets `taken` ends the logins' sessions once the change has committed.
 */
export async function hardenDatabase(db: Queryable): Promise<'clear' | 'taken' | 'held'> {
  const statements = await publicDefaultsSql(db);
  if (!statements.length) return 'clear';
  if (!(await publicDefaults(db)).superuser) return 'held';
  await db.query('SAVEPOINT public_defaults');
  try {
    for (const statement of statements) await db.query(statement);
  } catch {
    await db.query('ROLLBACK TO SAVEPOINT public_defaults');
  }
  await db.query('RELEASE SAVEPOINT public_defaults');
  return (await publicDefaultsSql(db)).length ? 'held' : 'taken';
}
