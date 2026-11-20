import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { newId, type Choice, type FieldCreate, type TableCreate } from '@riosoma/contracts';
import { connectDatabase, ident, join, query, sql, withTransaction, type Sql } from '@riosoma/db';
import { databaseMeta, type CommandContext } from '../data/commands/context.js';
import { createTable } from '../data/commands/schema.js';
import { ensureGroup, LONG_DEADLINES, recordChange } from '../data/commands/transaction.js';
import type { DataSchemas } from '../data/context.js';
import { loadFields } from '../data/metadata.js';
import type { StoredField } from '../data/types.js';
import type { Actor } from '../http/policy.js';
import { loadConfig } from '../config.js';

/**
 * Creates a sample database of synthetic records, for trying the grid at scale.
 *
 *   node apps/server/dist/tools/seed.js --owner person@example.com [--rows 1000000] [--name "Sample"]
 *
 * It reads the database settings the way the server does.  The database, its table, and its fields
 * are created by the same code the API uses; the rows are then generated inside Postgres in large
 * statements, so a million take seconds.  The bulk load isn't announced to open clients, so run it
 * before anyone opens the new database.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function choices(names: string[]): Choice[] {
  const colors = ['blue', 'green', 'orange', 'purple', 'red', 'teal', 'pink', 'yellow', 'brown', 'gray'] as const;
  return names.map((name, i) => ({ id: newId('choice'), name, color: colors[i % colors.length]! }));
}

/** Twenty fields covering every core type, with the primary field first. */
export function sampleTable(name = 'Items'): TableCreate {
  const f = (spec: Omit<FieldCreate, 'id' | 'description'>): FieldCreate =>
    ({ id: newId('field'), description: '', ...spec }) as FieldCreate;
  return {
    id: newId('table'),
    name,
    description: '',
    view: { id: newId('view'), name: 'Grid' },
    records: [],
    fields: [
      f({ name: 'Name', type: 'text', options: {} }),
      f({ name: 'Status', type: 'singleSelect', options: { choices: choices(['Todo', 'In progress', 'Review', 'Done', 'Blocked']) } }),
      f({ name: 'Priority', type: 'singleSelect', options: { choices: choices(['Low', 'Medium', 'High']) } }),
      f({ name: 'Tags', type: 'multipleSelect', options: { choices: choices(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta']) } }),
      f({ name: 'Amount', type: 'number', options: { precision: 2, thousands: true, allowNegative: true } }),
      f({ name: 'Quantity', type: 'number', options: { precision: 0, thousands: true, allowNegative: false } }),
      f({ name: 'Score', type: 'number', options: { precision: null, thousands: true, allowNegative: true } }),
      f({ name: 'Done', type: 'checkbox', options: { color: 'green' } }),
      f({ name: 'Due', type: 'date', options: { includeTime: false, dateFormat: 'local', timeFormat: 'local', timeZone: 'client' } }),
      f({ name: 'Started', type: 'date', options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'client' } }),
      f({ name: 'Email', type: 'email', options: {} }),
      f({ name: 'Website', type: 'url', options: {} }),
      f({ name: 'Phone', type: 'phone', options: {} }),
      f({ name: 'Notes', type: 'longText', options: { richText: false } }),
      f({ name: 'Region', type: 'singleSelect', options: { choices: choices(['North', 'South', 'East', 'West', 'Central', 'Overseas']) } }),
      f({ name: 'City', type: 'text', options: {} }),
      f({ name: 'Code', type: 'text', options: {} }),
      f({ name: 'Rating', type: 'number', options: { precision: 0, thousands: false, allowNegative: false } }),
      f({ name: 'Created', type: 'createdTime', options: {} }),
      f({ name: 'Record ID', type: 'recordId', options: {} }),
    ],
  };
}

const CITIES = ['Portland', 'Seattle', 'Austin', 'Boston', 'Chicago', 'Denver', 'Miami', 'Oakland', 'Phoenix', 'Tulsa'];

/** SQL producing a synthetic value for field `f` from the row number `n`. */
function valueSql(f: StoredField): Sql | null {
  const ids = f.type === 'singleSelect' || f.type === 'multipleSelect' ? f.options.choices.map((c) => c.id) : [];
  switch (f.name) {
    case 'Name':
      return sql`'Item ' || n`;
    case 'Amount':
      return sql`((n * 7919) % 1000000) / 100.0`;
    case 'Quantity':
      return sql`(n * 31) % 1000`;
    case 'Score':
      return sql`((n * 104729) % 20001 - 10000) / 7.0`;
    case 'Done':
      return sql`n % 3 = 0`;
    case 'Due':
      return sql`DATE '2024-01-01' + (n % 1500)::integer`;
    case 'Started':
      return sql`TIMESTAMPTZ '2024-01-01 00:00:00+00' + (n % 200000) * interval '17 minutes'`;
    case 'Email':
      return sql`'person' || n || '@example.com'`;
    case 'Website':
      return sql`'https://example.com/items/' || n`;
    case 'Phone':
      return sql`'+1 555 01' || lpad((n % 100)::text, 2, '0')`;
    case 'Notes':
      return sql`CASE WHEN n % 5 = 0 THEN 'Notes for item ' || n || E'\nA second line.' END`;
    case 'City':
      return sql`(${CITIES}::text[])[1 + n % ${CITIES.length}]`;
    case 'Code':
      return sql`upper(substr(md5(n::text), 1, 8))`;
    case 'Rating':
      return sql`CASE WHEN n % 7 = 0 THEN NULL ELSE n % 6 END`;
    case 'Tags':
      // Two tags, or one when both picks land on the same tag, or none for every tenth record.
      return sql`CASE WHEN n % 10 = 0 THEN NULL
        WHEN n % ${ids.length} = (n / 7) % ${ids.length} THEN ARRAY[(${ids}::text[])[1 + n % ${ids.length}]]
        ELSE ARRAY[(${ids}::text[])[1 + n % ${ids.length}], (${ids}::text[])[1 + (n / 7) % ${ids.length}]] END`;
    default:
      return f.type === 'singleSelect' ? sql`(${ids}::text[])[1 + (n * 13) % ${ids.length}]` : null;
  }
}

export async function seedDatabase(
  pool: pg.Pool,
  schemas: DataSchemas,
  actor: Actor,
  options: { rows: number; name: string; log?: (message: string) => void },
): Promise<{ databaseId: string; tableId: string; viewId: string }> {
  const databaseId = newId('database');
  const spec = sampleTable();
  const log = options.log ?? (() => undefined);
  await withTransaction(
    pool,
    async (db) => {
      const c: CommandContext = { db, schemas, actor, databaseId };
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'databases')} (id, org_id, name, color, created_by)
        VALUES (${databaseId}, ${actor.orgId}, ${options.name}, ${'blue'}, ${actor.userId})`,
      );
      await query(
        db,
        sql`INSERT INTO ${ident(schemas.app, 'grants')}
        (org_id, resource_kind, resource_id, principal_kind, principal_id, role, created_by)
        VALUES (${actor.orgId}, 'database', ${databaseId}, 'user', ${actor.userId}, 'owner', ${actor.userId})`,
      );
      const table = await createTable(c, spec);
      const groupId = newId('action');
      await ensureGroup(c, groupId);
      await recordChange(
        c,
        { body: { kind: 'database.created', database: await databaseMeta(c) }, prev: {} },
        { commandId: newId('command'), groupId, clientId: null },
      );
      await recordChange(c, table, { commandId: newId('command'), groupId, clientId: null });
    },
    LONG_DEADLINES,
  );
  log(`created database ${databaseId} with table ${spec.id}`);

  const fields = await loadFields(pool, schemas, [spec.id]);
  const writable = fields.flatMap((f) => {
    const value = valueSql(f);
    return value ? [{ f, value }] : [];
  });
  // Record IDs share a random prefix per seed, so two seeded databases never share an ID.
  const prefix = Array.from(randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join('');
  const chunk = 100_000;
  for (let start = 1; start <= options.rows; start += chunk) {
    const end = Math.min(options.rows, start + chunk - 1);
    await withTransaction(
      pool,
      (db) =>
        query(
          db,
          sql`INSERT INTO ${ident(schemas.data, spec.id)}
          (__id, __created_by, __updated_by, ${join(
            writable.map(({ f }) => sql`${ident(f.columnName)}`),
            ', ',
          )})
          SELECT ${'rec' + prefix} || lpad(to_hex(n), 9, '0'), ${actor.userId}, ${actor.userId},
            ${join(
              writable.map(({ value }) => value),
              ', ',
            )}
          FROM generate_series(${start}::bigint, ${end}::bigint) AS n`,
        ),
      LONG_DEADLINES,
    );
    log(`inserted ${end.toLocaleString('en-US')} of ${options.rows.toLocaleString('en-US')} rows`);
  }
  await query(
    pool,
    sql`UPDATE ${ident(schemas.app, 'tables')} SET data_version = data_version + 1 WHERE id = ${spec.id}`,
  );
  await query(pool, sql`ANALYZE ${ident(schemas.data, spec.id)}`);
  return { databaseId, tableId: spec.id, viewId: spec.view.id };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const owner = arg('owner');
  if (!owner) throw new Error('--owner <email> is required');
  const rows = Number(arg('rows') ?? 1_000_000);
  if (!Number.isSafeInteger(rows) || rows < 0) throw new Error('--rows must be a whole number');
  const name = arg('name') ?? `Sample: ${rows.toLocaleString('en-US')} rows`;

  const config = loadConfig();
  if (!config.database) throw new Error('The server has no database configured yet');
  const database = await connectDatabase(config.database);
  try {
    const schemas = config.database.schemas;
    const person = await query<{ id: string; org_id: string; kind: 'owner' | 'member' | 'guest' }>(
      database.pool,
      sql`SELECT u.id, m.org_id, m.kind FROM ${ident(schemas.app, 'users')} u
      JOIN ${ident(schemas.app, 'memberships')} m ON m.user_id = u.id
      WHERE lower(u.email) = lower(${owner}) LIMIT 1`,
    );
    const found = person.rows[0];
    if (!found) throw new Error(`No member with the email ${owner}`);
    const actor: Actor = {
      userId: found.id,
      orgId: found.org_id,
      sessionId: 'seed',
      kind: found.kind,
      adminRoles: [],
      csrfToken: '',
    };
    const started = Date.now();
    const ids = await seedDatabase(database.pool, schemas, actor, {
      rows,
      name,
      log: (message) => console.log(message),
    });
    console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s: /${ids.databaseId}/${ids.tableId}/${ids.viewId}`);
  } finally {
    await database.close();
  }
}

if (process.argv[1]?.endsWith('seed.js')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
