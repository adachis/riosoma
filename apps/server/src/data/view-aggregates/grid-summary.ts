import { columnRef } from '../physical/columns.js';
import type { GridConfig, GridSummary, SummaryKind, SummaryResult } from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { BUSY, failure } from '../dashboards/routes.js';
import type { TileRecords } from '../dashboards/tiles.js';
import { summaryMeasure, type SummaryMeasure } from '../dashboards/values.js';

/**
 * A grid view's summary row: how many records the view shows, and each column's summary over the
 * same records, through the view's filter and the reader's access.  Summaries that read one value
 * per record share a single query.  One that reads a list through a join of its own (unique values
 * of a multiple select, say) has a query to itself, since its join repeats records for the rest.
 *
 * A column whose values can't be summarized, such as a formula whose text isn't a number, leaves
 * only itself out: when the shared query fails that way, each column is read again on its own.
 */

interface Column {
  index: number;
  fieldId: string;
  kind: Exclude<SummaryKind, 'none'>;
  measure: SummaryMeasure;
}

const alias = (index: number): Sql => sql`${ident(`v${index}`)}`;

/** A failure that belongs to one column's values, rather than to the database or the clock. */
function columnFailure(error: unknown): boolean {
  const messageKey = failure(error);
  return messageKey !== null && messageKey !== BUSY;
}

export function resultOf(column: Column, raw: unknown): SummaryResult {
  if (column.measure.text) return { kind: column.kind, value: typeof raw === 'string' ? raw : null };
  const value = raw === null || raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(value)) return { kind: column.kind, value: null };
  if (!column.measure.dates) return { kind: column.kind, value };
  const instant = new Date(value).toISOString();
  return { kind: column.kind, value: column.measure.dates === 'date' ? instant.slice(0, 10) : instant };
}

/** Runs one statement in a savepoint, and answers null when it failed on a column's values. */
export async function guarded<T>(db: Queryable, work: () => Promise<T>): Promise<T | null> {
  await query(db, sql`SAVEPOINT summary_column`);
  try {
    const answer = await work();
    await query(db, sql`RELEASE SAVEPOINT summary_column`);
    return answer;
  } catch (error) {
    if (!columnFailure(error)) throw error;
    await query(db, sql`ROLLBACK TO SAVEPOINT summary_column`);
    await query(db, sql`RELEASE SAVEPOINT summary_column`);
    return null;
  }
}

/** The columns to summarize: shown in the view, visible to the person, and fitting their field. */
export function columnsOf(s: TileRecords, config: GridConfig): Column[] {
  const hidden = new Set(config.hiddenFieldIds);
  const columns: Column[] = [];
  for (const [fieldId, kind] of Object.entries(config.summaries)) {
    // The primary field's footer always shows the record count.
    if (kind === 'none' || hidden.has(fieldId) || fieldId === s.table.primaryFieldId) continue;
    const field = s.fields.get(fieldId);
    if (!field) continue;
    let measure: SummaryMeasure | null = null;
    try {
      measure = summaryMeasure(kind, field, s.fields, s.values);
    } catch (error) {
      // A link whose linked names this person can't see can't be counted, and nor can a formula
      // that can't be filtered.  The rest of the row still shows.
      if (!columnFailure(error)) throw error;
    }
    if (measure) columns.push({ index: columns.length, fieldId, kind, measure });
  }
  return columns;
}

export async function gridSummary(
  db: Queryable,
  s: TileRecords,
  config: GridConfig,
  deadline: () => void,
): Promise<GridSummary> {
  const columns = columnsOf(s, config);
  const shared = columns.filter((column) => !column.measure.join);
  const alone = columns.filter((column) => column.measure.join);
  const values: GridSummary['values'] = {};
  const select = (parts: readonly Column[]) =>
    query<Record<string, unknown>>(
      db,
      sql`SELECT count(*)::double precision AS records
        ${join(
          parts.map((column) => sql`, ${column.measure.expr} AS ${alias(column.index)}`),
          ' ',
        )}
      FROM ${s.from} WHERE ${s.where}`,
    );

  let records: number;
  const together = await guarded(db, () => select(shared));
  deadline();
  if (together) {
    const row = together.rows[0]!;
    records = Number(row.records);
    for (const column of shared) values[column.fieldId] = resultOf(column, row[`v${column.index}`]);
  } else {
    records = Number((await select([])).rows[0]!.records);
    for (const column of shared) {
      deadline();
      const single = await guarded(db, () => select([column]));
      if (single) values[column.fieldId] = resultOf(column, single.rows[0]![`v${column.index}`]);
    }
  }
  for (const column of alone) {
    deadline();
    const found = await guarded(db, () =>
      query<Record<string, unknown>>(
        db,
        sql`SELECT ${column.measure.expr} AS ${alias(column.index)}
        FROM ${s.from} ${column.measure.join!} WHERE ${s.where}`,
      ),
    );
    if (found) values[column.fieldId] = resultOf(column, found.rows[0]![`v${column.index}`]);
  }
  for (const [fieldId, kind] of Object.entries(config.summaries)) {
    const field = s.fields.get(fieldId);
    if (kind !== 'sum' || field?.type !== 'multiCurrency' || config.hiddenFieldIds.includes(fieldId))
      continue;
    deadline();
    const column = columnRef(field);
    const totals = await query<{ code: string; amount: string }>(
      db,
      sql`
      SELECT ${column} ->> 'code' AS code, sum((${column} ->> 'amount')::numeric)::text AS amount
      FROM ${s.from} WHERE ${s.where} AND ${column} IS NOT NULL GROUP BY ${column} ->> 'code'`,
    );
    values[fieldId] = {
      kind: 'sum',
      value: null,
      currencies: Object.fromEntries(totals.rows.map((row) => [row.code, Number(row.amount)])),
    };
  }
  return { kind: 'summary', records, values };
}
