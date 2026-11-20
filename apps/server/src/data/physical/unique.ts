import { AppError } from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import type { StoredField } from '../types.js';

export function isUnique(field: Pick<StoredField, 'options'>): boolean {
  return 'unique' in field.options && field.options.unique === true;
}
export function uniqueIndexName(field: StoredField): string {
  const insensitive = field.type === 'text' && field.options.uniqueCaseInsensitive;
  return `uq_${field.id}_${field.columnName.replace(field.id, '') || '0'}_${insensitive ? 'i' : 's'}`;
}
function key(field: StoredField) {
  const column = ident(field.columnName);
  return field.type === 'text' && field.options.uniqueCaseInsensitive ? sql`lower(${column})` : column;
}
function predicate(field: StoredField) {
  const column = ident(field.columnName);
  return ['text', 'email', 'url', 'phone', 'singleSelect'].includes(field.type)
    ? sql`__deleted_at IS NULL AND ${column} IS NOT NULL AND ${column} <> ''`
    : sql`__deleted_at IS NULL AND ${column} IS NOT NULL`;
}
export async function uniqueIndexReady(
  db: Queryable,
  schemas: Pick<DataSchemas, 'data'>,
  field: StoredField,
): Promise<boolean> {
  const result = await query<{ ready: boolean }>(
    db,
    sql`SELECT i.indisvalid AND i.indisunique AS ready
    FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid JOIN pg_namespace n ON n.oid = x.relnamespace
    JOIN pg_class t ON t.oid = i.indrelid
    WHERE n.nspname = ${schemas.data} AND x.relname = ${uniqueIndexName(field)} AND t.relname = ${field.tableId}`,
  );
  return result.rows[0]?.ready === true;
}
export async function uniqueDuplicates(
  db: Queryable,
  schemas: Pick<DataSchemas, 'data'>,
  field: StoredField,
): Promise<Array<{ value: unknown; recordIds: string[] }>> {
  const result = await query<{ value: unknown; record_ids: string[] }>(
    db,
    sql`SELECT ${key(field)} AS value, (array_agg(__id ORDER BY __id))[1:20] AS record_ids
    FROM ${ident(schemas.data, field.tableId)} WHERE ${predicate(field)}
    GROUP BY ${key(field)} HAVING count(*) > 1 LIMIT 20`,
  );
  return result.rows.map((row) => ({ value: row.value, recordIds: row.record_ids }));
}
export function duplicatesError(field: StoredField, databaseId: string, duplicates: unknown): AppError {
  return new AppError('validation_failed', 'data.validation.duplicates', {
    fields: { [field.id]: 'data.validation.unique' },
    params: {
      duplicates: JSON.stringify(duplicates),
      dedupe: `/${databaseId}/${field.tableId}?duplicates=${field.tableId}`,
    },
  });
}
export async function buildUniqueIndex(
  db: Queryable,
  schemas: Pick<DataSchemas, 'data'>,
  field: StoredField,
  concurrently: boolean,
): Promise<void> {
  if (!isUnique(field)) return;
  if (field.source) throw new AppError('validation_failed', 'data.validation.uniqueSource');
  if (await uniqueIndexReady(db, schemas, field)) return;
  await query(
    db,
    sql`DROP INDEX ${concurrently ? sql`CONCURRENTLY` : sql``} IF EXISTS ${ident(schemas.data, uniqueIndexName(field))}`,
  );
  await query(
    db,
    sql`CREATE UNIQUE INDEX ${concurrently ? sql`CONCURRENTLY` : sql``} ${ident(uniqueIndexName(field))}
    ON ${ident(schemas.data, field.tableId)} (${key(field)}) WHERE ${predicate(field)}`,
  );
}
export async function changeUniqueIndex(
  db: Queryable,
  schemas: Pick<DataSchemas, 'data'>,
  before: StoredField,
  after: StoredField,
): Promise<void> {
  if (isUnique(after)) {
    if (after.source) throw new AppError('validation_failed', 'data.validation.uniqueSource');
    if (!(await uniqueIndexReady(db, schemas, after)))
      throw new AppError('validation_failed', 'data.validation.uniquePrepare');
  }
  if (isUnique(before) && (!isUnique(after) || uniqueIndexName(before) !== uniqueIndexName(after)))
    await query(db, sql`DROP INDEX IF EXISTS ${ident(schemas.data, uniqueIndexName(before))}`);
}
export function uniqueViolation(error: unknown): AppError | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== '23505' ||
    !('constraint' in error)
  )
    return null;
  const match = /^uq_(fld[0-9A-Za-z]{14})_/.exec(String(error.constraint));
  return match
    ? new AppError('validation_failed', 'data.validation.unique', {
        fields: { [match[1]!]: 'data.validation.unique' },
      })
    : null;
}
