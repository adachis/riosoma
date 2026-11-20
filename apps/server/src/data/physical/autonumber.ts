import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { StoredField } from '../types.js';

async function setDefault(db: Queryable, schema: string, field: StoredField): Promise<void> {
  // Utility DDL cannot bind parameters; ident validates both parts of this regclass literal.
  await query(
    db,
    sql`ALTER TABLE ${ident(schema, field.tableId)}
    ALTER COLUMN ${ident(field.columnName)} SET DEFAULT nextval('${ident(schema, field.id)}'::regclass)`,
  );
}

export async function initializeAutoNumber(db: Queryable, schema: string, field: StoredField): Promise<void> {
  await query(
    db,
    sql`CREATE SEQUENCE ${ident(schema, field.id)} AS bigint
    OWNED BY ${ident(schema, field.tableId, field.columnName)}`,
  );
  await query(
    db,
    sql`WITH numbered AS (
    SELECT __rid, row_number() OVER (ORDER BY __rid) AS value FROM ${ident(schema, field.tableId)}
  ) UPDATE ${ident(schema, field.tableId)} r SET ${ident(field.columnName)} = numbered.value
    FROM numbered WHERE numbered.__rid = r.__rid`,
  );
  await query(
    db,
    sql`SELECT setval(${`"${schema}"."${field.id}"`}::regclass,
    COALESCE(max(${ident(field.columnName)}), 1), count(*) > 0) FROM ${ident(schema, field.tableId)}`,
  );
  await setDefault(db, schema, field);
}

/** Backups retain their sequence position without consuming numbers on subsequent inserts. */
export async function suspendAutoNumber(db: Queryable, schema: string, field: StoredField): Promise<void> {
  if (field.type !== 'autoNumber') return;
  await query(
    db,
    sql`ALTER TABLE ${ident(schema, field.tableId)}
    ALTER COLUMN ${ident(field.columnName)} DROP DEFAULT`,
  );
  await query(
    db,
    sql`ALTER SEQUENCE ${ident(schema, field.id)} RENAME TO ${ident(`${field.columnName}_seq`)}`,
  );
}

/** Undo restores the original sequence, including numbers consumed by rolled-back inserts. */
export async function resumeAutoNumber(db: Queryable, schema: string, field: StoredField): Promise<void> {
  if (field.type !== 'autoNumber') return;
  const backup = await query(
    db,
    sql`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relname = ${`${field.columnName}_seq`} AND c.relkind = 'S'`,
  );
  if (!backup.rowCount) return;
  await query(
    db,
    sql`ALTER SEQUENCE ${ident(schema, `${field.columnName}_seq`)} RENAME TO ${ident(field.id)}`,
  );
  await setDefault(db, schema, field);
  // Records inserted while this column was a backup still need a unique number on restoration.
  await query(
    db,
    sql`UPDATE ${ident(schema, field.tableId)} r SET ${ident(field.columnName)} = numbered.value
    FROM (SELECT __rid, nextval(${`"${schema}"."${field.id}"`}::regclass) AS value
      FROM (SELECT __rid FROM ${ident(schema, field.tableId)} WHERE ${ident(field.columnName)} IS NULL
        ORDER BY __rid) AS missing) AS numbered WHERE r.__rid = numbered.__rid`,
  );
}
