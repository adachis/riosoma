import { ident, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';

export function attachmentNames(
  appSchema: string | undefined,
  field: StoredField,
  col: Sql,
  first = false,
): Sql {
  if (!appSchema) throw new Error('Attachment names require the app schema');
  const source = sql`FROM unnest(${col}) WITH ORDINALITY AS attachment_ids(id, position)
    JOIN ${ident(appSchema, 'files')} attachment_file ON attachment_file.id = attachment_ids.id
    AND attachment_file.field_id = ${field.id} AND attachment_file.table_id = ${field.tableId}`;
  return first
    ? sql`(SELECT attachment_file.name ${source} WHERE attachment_ids.position = 1)`
    : sql`(SELECT string_agg(attachment_file.name, ', ' ORDER BY attachment_ids.position) ${source})`;
}

export function attachmentFilter(
  appSchema: string | undefined,
  field: StoredField,
  col: Sql,
  value: unknown,
): Sql {
  if (!appSchema) throw new Error('Attachment filters require the app schema');
  return sql`EXISTS (SELECT 1 FROM ${ident(appSchema, 'files')} attachment_file
    WHERE attachment_file.id = ANY(${col}) AND attachment_file.field_id = ${field.id}
    AND attachment_file.table_id = ${field.tableId}
    AND strpos(lower(attachment_file.name), lower(${value}::text)) > 0)`;
}
