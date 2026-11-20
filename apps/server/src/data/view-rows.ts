import { EMPTY_STACK, type RowsQuery, type StackCounts } from '@riosoma/contracts';
import { compile, ident, query, sql, type Queryable, type Sql } from '@riosoma/db';
import type { DataSchemas } from './context.js';
import { loadCollaborators } from './metadata.js';
import { columnRef } from './physical/columns.js';
import { compileFilter } from './physical/filters.js';
import type { SnapshotRead } from './snapshots.js';
import type { ReadContext, StoredField } from './types.js';
import { badViewSetting, formulaDates, isCalendarField, isStackField } from './view-settings.js';

function stackField(read: SnapshotRead): StoredField | undefined {
  const id = read.view.config.kanban.stackFieldId;
  if (read.view.type !== 'kanban' || !id) badViewSetting('kanban.stackFieldId');
  const field = read.fields.find((field) => field.id === id);
  if (field && !isStackField(field)) badViewSetting('kanban.stackFieldId');
  return field;
}

function stackExpr(field: StoredField | undefined): Sql {
  if (!field) return sql`${EMPTY_STACK}::text`;
  const col = columnRef(field);
  return field.type === 'user'
    ? sql`COALESCE((${col})[1], ${EMPTY_STACK})`
    : sql`COALESCE(${col}, ${EMPTY_STACK})`;
}

/** The day a calendar, timeline, or Gantt view places a record on by one of its date fields. */
export function calendarDay(field: StoredField, context: ReadContext, setting: string): Sql {
  // A date formula that changed to one only JavaScript computes after the calendar chose it.
  if (field.type === 'formula' && !field.options.sortable) formulaDates(setting);
  const col = columnRef(field);
  if (field.type === 'formula') {
    if (field.options.resultType === 'date') return sql`(${col})::date`;
    const zone = field.options.timeZone === 'client' ? context.timeZone : field.options.timeZone;
    return sql`((${col})::timestamptz AT TIME ZONE ${zone})::date`;
  }
  if (field.type === 'date' || field.type === 'createdTime' || field.type === 'lastModifiedTime') {
    if (field.type === 'date' && !field.options.includeTime) return col;
    const zone = field.options.timeZone === 'client' ? context.timeZone : field.options.timeZone;
    return sql`(${col} AT TIME ZONE ${zone})::date`;
  }
  return badViewSetting('calendar.startFieldId');
}

/** Restrict ordering without changing the access predicate used to fetch stable snapshot pages. */
export function selectViewRows(read: SnapshotRead, input: RowsQuery): SnapshotRead {
  if (input.stack !== undefined && (input.from !== undefined || input.to !== undefined))
    badViewSetting('stack');
  let predicate: Sql;
  let selection: unknown;
  if (input.stack !== undefined) {
    predicate = sql`${stackExpr(stackField(read))} = ${input.stack}`;
    selection = ['stack', input.stack];
  } else if (input.from !== undefined || input.to !== undefined) {
    if (!input.from) badViewSetting('from');
    if (!input.to || input.to < input.from) badViewSetting('to');
    const { startFieldId, endFieldId } = read.view.config.calendar;
    if (read.view.type !== 'calendar' || !startFieldId) badViewSetting('calendar.startFieldId');
    const start = read.fields.find((field) => field.id === startFieldId);
    const end = read.fields.find((field) => field.id === endFieldId);
    if (start && !isCalendarField(start)) badViewSetting('calendar.startFieldId');
    if (end && !isCalendarField(end)) badViewSetting('calendar.endFieldId');
    if (!start) predicate = sql`FALSE`;
    else {
      const first = calendarDay(start, read.context, 'calendar.startFieldId');
      // An absent or earlier end is a single-day event on its start day.
      const last = end
        ? sql`GREATEST(${first}, ${calendarDay(end, read.context, 'calendar.endFieldId')})`
        : first;
      predicate = sql`(${first} IS NOT NULL AND ${first} <= ${input.to}::date AND ${last} >= ${input.from}::date)`;
    }
    selection = ['range', input.from, input.to];
  } else return read;
  return { ...read, selection: { key: JSON.stringify([selection, compile(predicate)]), predicate } };
}

export async function viewStackCounts(
  db: Queryable,
  schemas: DataSchemas,
  read: SnapshotRead,
): Promise<StackCounts> {
  const field = stackField(read);
  const stack = stackExpr(field);
  const result = await query<{ id: string; count: string }>(
    db,
    sql`SELECT ${stack} AS id, count(*) AS count FROM ${ident(schemas.data, read.table.id)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND (${read.predicate})
        AND ${compileFilter(read.view.config.filter, new Map(read.fields.map((f) => [f.id, f])), read.context)}
      GROUP BY 1`,
  );
  const counts = new Map(result.rows.map((row) => [row.id, Number(row.count)]));
  const available =
    field?.type === 'singleSelect'
      ? field.options.choices.map((choice) => choice.id)
      : field?.type === 'user' && read.scope
        ? (await loadCollaborators(db, schemas, read.table.orgId, read.scope)).map((person) => person.id)
        : [];
  const ids = new Set([...available, ...counts.keys(), EMPTY_STACK]);
  return { stacks: [...ids].map((id) => ({ id, count: counts.get(id) ?? 0 })) };
}
