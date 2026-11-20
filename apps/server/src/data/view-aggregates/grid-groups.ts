import type { CellValue, Choice, GridGroupBoundary, RowData } from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from '../context.js';
import type { TileRecords } from '../dashboards/tiles.js';
import { compileFilter } from '../physical/filters.js';
import { groupExpression, groupOrder } from '../physical/groups.js';
import { resultType } from '../physical/relations.js';
import type { SnapshotRead } from '../snapshots.js';
import { columnRef } from '../physical/columns.js';
import { columnsOf, guarded, resultOf } from './grid-summary.js';
import type { StoredField } from '../types.js';

/** Counts and summaries share the same transaction and access predicate as the ordered IDs. */
export async function gridGroups(
  db: Queryable,
  schemas: DataSchemas,
  read: SnapshotRead,
  computed?: ReadonlyMap<string, Sql>,
  source?: { from: Sql; where: Sql },
): Promise<GridGroupBoundary[]> {
  const config = read.view.config;
  if (read.view.type !== 'grid' || !config.groups.length) return [];
  const fields = new Map(read.fields.map((field) => [field.id, field]));
  const s: TileRecords = {
    table: read.table,
    view: read.view,
    fields,
    from: source?.from ?? sql`${ident(schemas.data, read.table.id)}`,
    scope: read.predicate,
    where:
      source?.where ??
      sql`__deleted_at IS NULL AND NOT __source_gone AND (${read.predicate})
      AND ${compileFilter(config.filter, fields, read.context, schemas.app)}
      ${read.selection ? sql`AND (${read.selection.predicate})` : sql``}`,
    values: read.values ?? {
      schemas,
      read: read.context,
      tableId: read.table.id,
      visible: (field) => fields.has(field.id),
      recordPredicate: () => sql`FALSE`,
    },
  };
  let pinnedCount = 0;
  if (config.pinnedRecordIds.length) {
    const pins = await query<{ count: number }>(
      db,
      sql`SELECT count(*)::int AS count
      FROM ${s.from} WHERE ${s.where} AND __id = ANY(${config.pinnedRecordIds}::text[])`,
    );
    pinnedCount = pins.rows[0]?.count ?? 0;
    s.where = sql`(${s.where}) AND NOT (__id = ANY(${config.pinnedRecordIds}::text[]))`;
  }
  const columns = columnsOf(s, config);
  const shared = columns.filter((column) => !column.measure.join);
  const boundaries: GridGroupBoundary[] = [];
  for (let level = 1; level <= config.groups.length; level++) {
    const levels = config.groups.slice(0, level);
    const expressions = levels.map((group) =>
      groupExpression(fields.get(group.fieldId), group, read.context, computed),
    );
    const keys = expressions.map((expr, index) => sql`${expr} AS ${ident(`g${index}`)}`);
    const order = levels.map((group, index) =>
      groupOrder(sql`${ident(`g${index}`)}`, fields.get(group.fieldId), group.direction, schemas.app),
    );
    const select = (parts: typeof columns, withJoin = false) =>
      query<Record<string, unknown>>(
        db,
        sql`
      SELECT * FROM (SELECT ${join(keys, ', ')}, count(*)::int AS records
        ${join(
          parts.map((column) => sql`, ${column.measure.expr} AS ${ident(`v${column.index}`)}`),
          ' ',
        )}
      FROM ${s.from} ${withJoin ? (parts[0]?.measure.join ?? sql``) : sql``}
      WHERE ${s.where} GROUP BY ${join(
        levels.map((_, index) => sql`${ident(`g${index}`)}`),
        ', ',
      )}) grouped ORDER BY ${join(order, ', ')}`,
      );
    const together = await guarded(db, () => select(shared));
    const counted = together ?? (await select([]));
    let start = pinnedCount;
    const byKey = new Map<string, GridGroupBoundary>();
    const valuesOf = (row: Record<string, unknown>) =>
      levels.map((group, index) => {
        const field = fields.get(group.fieldId);
        const value = row[`g${index}`] ?? null;
        return [
          group.fieldId,
          value !== null && field && field.type !== 'lookup' && resultType(field) === 'number'
            ? Number(value)
            : value,
        ] as const;
      });
    const keyOf = (row: Record<string, unknown>) => JSON.stringify(valuesOf(row));
    for (const row of counted.rows) {
      const boundary: GridGroupBoundary = {
        key: keyOf(row),
        level,
        start,
        count: Number(row.records),
        values: Object.fromEntries(valuesOf(row)),
        summaries: {},
      };
      if (together)
        for (const column of shared)
          boundary.summaries[column.fieldId] = resultOf(column, row[`v${column.index}`]);
      start += boundary.count;
      boundaries.push(boundary);
      byKey.set(boundary.key, boundary);
    }
    for (const [fieldId, kind] of Object.entries(config.summaries)) {
      const field = fields.get(fieldId);
      if (kind !== 'sum' || field?.type !== 'multiCurrency' || config.hiddenFieldIds.includes(fieldId))
        continue;
      for (const boundary of byKey.values())
        boundary.summaries[fieldId] = { kind: 'sum', value: null, currencies: {} };
      const column = columnRef(field);
      const totals = await query<Record<string, unknown>>(
        db,
        sql`
        SELECT ${join(keys, ', ')}, ${column} ->> 'code' AS currency,
          sum((${column} ->> 'amount')::numeric)::text AS amount
        FROM ${s.from} WHERE ${s.where} AND ${column} IS NOT NULL
        GROUP BY ${join(expressions, ', ')}, ${column} ->> 'code'`,
      );
      for (const row of totals.rows) {
        const currencies = byKey.get(keyOf(row))?.summaries[fieldId]?.currencies;
        if (currencies) currencies[String(row.currency)] = Number(row.amount);
      }
    }
    for (const column of columns.filter((column) => column.measure.join || !together)) {
      const answer = await guarded(db, () => select([column], Boolean(column.measure.join)));
      for (const row of answer?.rows ?? []) {
        const boundary = byKey.get(keyOf(row));
        if (boundary) boundary.summaries[column.fieldId] = resultOf(column, row[`v${column.index}`]);
      }
    }
  }
  return boundaries.sort((a, b) => a.start - b.start || a.level - b.level);
}

/** Group labels may name people and links outside the first value page. */
export function groupLabelRows(
  groups: readonly GridGroupBoundary[],
  fields: SnapshotRead['fields'] = [],
): RowData[] {
  const systemValue = (group: GridGroupBoundary, type: string) => {
    const field = fields.find((field) => field.type === type && field.id in group.values);
    return field && group.values[field.id] != null ? String(group.values[field.id]) : null;
  };
  return groups.map((group) => ({
    id: '',
    values: group.values as Record<string, CellValue>,
    createdAt: systemValue(group, 'createdTime') ?? '',
    updatedAt: systemValue(group, 'lastModifiedTime') ?? '',
    createdBy: systemValue(group, 'createdBy'),
    updatedBy: systemValue(group, 'lastModifiedBy'),
  }));
}

/** Collapsed groups still need labels when their records are outside the requested page. */
export async function groupSelectChoices(
  db: Queryable,
  groups: readonly GridGroupBoundary[],
  fields: readonly StoredField[],
): Promise<Record<string, Choice[]>> {
  const choices: Record<string, Choice[]> = {};
  for (const field of fields) {
    const target = field.type === 'lookup' ? field.relation?.target : field;
    if (!target?.selectRead) continue;
    const ids = [
      ...new Set(
        groups.flatMap((group) => {
          const value = group.values[field.id];
          return typeof value === 'string'
            ? [value]
            : Array.isArray(value)
              ? value.filter((item): item is string => typeof item === 'string')
              : [];
        }),
      ),
    ];
    if (!ids.length) continue;
    const result = await query<{ choices: Choice[] }>(
      db,
      sql`SELECT ${target.selectRead.choices(sql`${ids}::text[]`)} AS choices`,
    );
    const known = new Map((choices[target.id] ?? []).map((choice) => [choice.id, choice]));
    for (const choice of result.rows[0]!.choices) known.set(choice.id, choice);
    choices[target.id] = [...known.values()];
  }
  return choices;
}
