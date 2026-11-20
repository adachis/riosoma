import type { RowData } from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import { columnType, jsonValueExpr } from '../physical/columns.js';
import { compileGroupOrder } from '../physical/groups.js';
import type { SnapshotRead } from '../snapshots.js';
import { gridGroups } from './grid-groups.js';

/** Source rows have already passed the source's filters and AccessScope record rules. */
export async function liveGroups(
  db: Queryable,
  schemas: DataSchemas,
  read: SnapshotRead,
  rows: readonly RowData[],
) {
  const columns = read.fields.filter((field) => columnType(field));
  // A typed, temporary query input lets source values use the same keys and summaries as copies.
  const from = sql`(SELECT ordinal::bigint AS __rid, item ->> 'id' AS __id,
    NULLIF(item ->> 'createdAt', '')::timestamptz AS __created_at,
    NULLIF(item ->> 'updatedAt', '')::timestamptz AS __updated_at,
    item ->> 'createdBy' AS __created_by, item ->> 'updatedBy' AS __updated_by
    ${join(
      columns.map(
        (field) =>
          sql`, ${jsonValueExpr(field, sql`item -> 'values' -> ${field.id}`)} AS ${ident(field.columnName)}`,
      ),
      ' ',
    )}
    FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) WITH ORDINALITY incoming(item, ordinal)
  ) AS ${ident(read.table.id)}`;
  const fields = new Map(read.fields.map((field) => [field.id, field]));
  const ordered = await query<{ position: number }>(
    db,
    sql`SELECT __rid::int AS position FROM ${from}
    ORDER BY ${read.view.config.pinnedRecordIds.length ? sql`COALESCE(array_position(${read.view.config.pinnedRecordIds}::text[], __id), 2147483647) ASC,` : sql``}${compileGroupOrder(read.view.config.groups, fields, read.context, undefined, schemas.app)} __rid ASC`,
  );
  const groups = await gridGroups(db, schemas, read, undefined, { from, where: sql`TRUE` });
  return { positions: ordered.rows.map((row) => row.position - 1), groups };
}
