import { AGGREGATE_CAPS, type PivotOrder } from '@riosoma/contracts';
import { ident, join, keyword, query, sql, type Queryable, type Sql } from '@riosoma/db';
import { among, joins, type TileRecords } from '../dashboards/tiles.js';
import type { Dimension, Measure } from '../dashboards/values.js';

/**
 * Groups a view's records into rows by up to three fields and into columns by one more, and
 * computes up to five values for every group, all with `GROUP BY` in Postgres.  Each query joins
 * only the fields its own groups use, so a record with several values in a list counts once in
 * each of their groups, and once in any total that spans them.  Rows and columns keep the first
 * groups in order up to the caps, and the summary says when it left any out.
 */

export type Values = Array<number | null>;

/** A group as the database names it: its key as text, and the name people and records carry. */
export interface Level {
  key: string | null;
  name: string | null;
}

export interface RankedRow {
  /** One group per row field, outermost first */
  levels: Level[];
  /** Each prefix of the row's keys as Postgres writes them in JSON, outermost first */
  tuples: string[];
  /** Values the ranking computed on the way, by value index */
  values: ReadonlyMap<number, number | null>;
}

export interface RankedColumn extends Level {
  tuple: string;
}

export interface SummaryInput {
  rows: readonly Dimension[];
  column: Dimension | null;
  measures: readonly Measure[];
  order: PivotOrder;
  /** Values across every column for each row.  A summary without columns always has them. */
  rowTotals: boolean;
  /** Values across every row for each column, and for every record */
  columnTotals: boolean;
  /** Values for each outer group's own row */
  groups: boolean;
  caps?: { rows: number; columns: number };
  /** Throws once the request has spent its time, between queries */
  deadline(): void;
}

export interface Summary {
  rows: RankedRow[];
  columns: RankedColumn[];
  capped: { rows: boolean; columns: boolean };
  /** By row tuple, at every level: values across every column */
  totals: Map<string, Values>;
  /** By row tuple, then column tuple */
  cells: Map<string, Map<string, Values>>;
  /** By column tuple: values across every row */
  columnTotals: Map<string, Values>;
  /** Values across every record, when the totals ask for them */
  grand: Values | null;
}

const keyOf = (d: Dimension): Sql => d.key(d.value);

/** The groups' keys as one JSON array, which Postgres writes the same way every time. */
const tupleOf = (keys: readonly Sql[]): Sql => sql`jsonb_build_array(${join(keys, ', ')})::text`;

/** Column names this module makes up, each a checked identifier. */
const name = (prefix: 'g' | 'k' | 'l' | 't' | 'v' | 'tuple' | 'p', index: number): Sql =>
  sql`${ident(`${prefix}${index}`)}`;

const numeric = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

type Row = Record<string, unknown>;

const groupsOf = (levels: readonly Level[]) => {
  const seen = new Map<string, { key: string | null; label: null }>();
  for (const level of levels) seen.set(JSON.stringify(level.key), { key: level.key, label: null });
  return [...seen.values()];
};

/**
 * Values that can share a query share one.  A value that reads a list through a join of its own,
 * such as unique values of a multiple select, gets a query to itself, since its join repeats every
 * record for the others.
 */
function batches(measures: readonly Measure[], indexes: readonly number[]) {
  const plain = indexes.filter((index) => !measures[index]!.join);
  const alone = indexes.filter((index) => measures[index]!.join);
  return [
    ...(plain.length ? [{ indexes: plain, join: null }] : []),
    ...alone.map((index) => ({ indexes: [index], join: measures[index]!.join })),
  ];
}

interface Found {
  row: string;
  column: string | null;
  values: Map<number, number | null>;
}

/** Values grouped by row groups and a column, for the groups the restriction lets through. */
async function valuesBy(
  db: Queryable,
  s: TileRecords,
  rows: readonly Dimension[],
  column: Dimension | null,
  measures: readonly Measure[],
  indexes: readonly number[],
  restrict: Sql,
): Promise<Found[]> {
  const found = new Map<string, Found>();
  const grouped = [rows.length ? sql`1` : null, column ? sql`2` : null].filter(
    (part): part is Sql => part !== null,
  );
  for (const batch of batches(measures, indexes)) {
    const values = join(
      batch.indexes.map((index) => sql`${measures[index]!.expr} AS ${name('v', index)}`),
      ', ',
    );
    const result = await query<Row>(
      db,
      sql`SELECT ${tupleOf(rows.map(keyOf))} AS row_tuple,
        ${column ? tupleOf([keyOf(column)]) : sql`NULL::text`} AS column_tuple, ${values}
      FROM ${s.from} ${joins(...rows.map((d) => d.join), column?.join, batch.join)}
      WHERE ${s.where} AND ${restrict}
      ${grouped.length ? sql`GROUP BY ${join(grouped, ', ')}` : sql``}`,
    );
    for (const row of result.rows) {
      const rowTuple = String(row.row_tuple);
      const columnTuple = row.column_tuple === null ? null : String(row.column_tuple);
      const key = JSON.stringify([rowTuple, columnTuple]);
      let entry = found.get(key);
      if (!entry) {
        entry = { row: rowTuple, column: columnTuple, values: new Map() };
        found.set(key, entry);
      }
      for (const index of batch.indexes) entry.values.set(index, numeric(row[`v${index}`]));
    }
  }
  return [...found.values()];
}

/**
 * The first groups in order, one row per combination of the fields' values.  Ordering by value
 * sorts each outer group by its own first value, then the groups inside it by theirs, with ties in
 * the groups' own order.  The group of records with no value comes last at every level, or last
 * among its equals when ordering by value.
 */
async function rank(
  db: Queryable,
  s: TileRecords,
  dims: readonly Dimension[],
  order: PivotOrder,
  measures: readonly Measure[],
  inline: readonly number[],
  cap: number,
): Promise<{ rows: RankedRow[]; capped: boolean }> {
  const byValue = order === 'valueAscending' || order === 'valueDescending';
  const direction = keyword(order === 'labelDescending' || order === 'valueDescending' ? 'DESC' : 'ASC');
  const grouped = (j: number) => sql`grouped.${name('g', j)}`;
  const ranked = (column: Sql) => sql`ranked.${column}`;
  const prefixes = dims.map((_, j) => tupleOf(dims.slice(0, j + 1).map((d, k) => d.key(grouped(k)))));
  const inlineJoin = inline.map((index) => measures[index]!.join).find((part) => part) ?? null;
  // Outer groups' first values, for ordering by value, each from a query of its own fields only.
  const outer = byValue ? dims.slice(0, -1) : [];
  const parents = outer.map((_, j) => {
    const first = measures[0]!;
    const own = dims.slice(0, j + 1);
    return sql`${name('p', j)} AS (SELECT ${tupleOf(own.map(keyOf))} AS prefix, ${first.expr} AS total
      FROM ${s.from} ${joins(...own.map((d) => d.join), first.join)} WHERE ${s.where} GROUP BY 1)`;
  });
  const levelOrder = dims.map((d, j) => {
    const label = sql`(${d.order(ranked(name('g', j)), ranked(name('l', j)))})`;
    const empty = sql`(${ranked(name('g', j))} IS NULL)`;
    if (!byValue)
      return sql`${empty}, ${label} ${direction} NULLS LAST, ${ranked(name('k', j))} ${direction}`;
    const total = j === dims.length - 1 ? ranked(name('v', 0)) : ranked(name('t', j));
    return sql`${total} ${direction} NULLS LAST, ${empty}, ${label} ASC NULLS LAST, ${ranked(name('k', j))} ASC`;
  });
  const result = await query<Row>(
    db,
    sql`${parents.length ? sql`WITH ${join(parents, ', ')}` : sql``}
    SELECT ranked.* FROM (
      SELECT grouped.*, ${join(
        dims.map(
          (d, j) => sql`${d.key(grouped(j))} AS ${name('k', j)}, ${d.label(grouped(j))} AS ${name('l', j)},
            ${prefixes[j]!} AS ${name('tuple', j)}`,
        ),
        ', ',
      )}
        ${join(
          outer.map((_, j) => sql`, ${name('p', j)}.total AS ${name('t', j)}`),
          ' ',
        )}
      FROM (
        SELECT ${join(
          dims.map((d, j) => sql`${d.value} AS ${name('g', j)}`),
          ', ',
        )}
          ${join(
            inline.map((index) => sql`, ${measures[index]!.expr} AS ${name('v', index)}`),
            ' ',
          )}
        FROM ${s.from} ${joins(...dims.map((d) => d.join), inlineJoin)}
        WHERE ${s.where}
        GROUP BY ${join(
          dims.map((_, j) => name('g', j)),
          ', ',
        )}
      ) AS grouped
      ${join(
        outer.map((_, j) => sql`JOIN ${name('p', j)} ON ${name('p', j)}.prefix = ${prefixes[j]!}`),
        ' ',
      )}
    ) AS ranked
    ORDER BY ${join(levelOrder, ', ')}
    LIMIT ${cap + 1}`,
  );
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  const rows = result.rows.slice(0, cap).map((row) => ({
    levels: dims.map((_, j) => ({ key: text(row[`k${j}`]), name: text(row[`l${j}`]) })),
    tuples: dims.map((_, j) => String(row[`tuple${j}`])),
    values: new Map(inline.map((index) => [index, numeric(row[`v${index}`])])),
  }));
  return { rows, capped: result.rows.length > cap };
}

/** Whether a record's groups are among the ranked rows' groups at this depth. */
function inRows(dims: readonly Dimension[], rows: readonly RankedRow[]): Sql {
  const depth = dims.length;
  const parts = dims.map((d, j) => among(d, groupsOf(rows.map((row) => row.levels[j]!))));
  if (depth > 1) {
    const tuples = [...new Set(rows.map((row) => row.tuples[depth - 1]!))];
    parts.push(sql`${tupleOf(dims.map(keyOf))} = ANY(${tuples}::text[])`);
  }
  return join(parts, ' AND ');
}

export async function summarize(db: Queryable, s: TileRecords, input: SummaryInput): Promise<Summary> {
  const caps = input.caps ?? AGGREGATE_CAPS;
  const { rows: dims, column, measures } = input;
  const every = measures.map((_, index) => index);
  const byValue = input.order === 'valueAscending' || input.order === 'valueDescending';
  // The ranking groups by every row field anyway, so it computes what it safely can on the way.
  const inline = measures.length === 1 || measures.every((m) => !m.join) ? every : byValue ? [0] : [];

  let columns: RankedColumn[] = [];
  let columnsCapped = false;
  if (column) {
    const found = await rank(db, s, [column], 'labelAscending', measures, [], caps.columns);
    columns = found.rows.map((row) => ({ ...row.levels[0]!, tuple: row.tuples[0]! }));
    columnsCapped = found.capped;
    input.deadline();
  }
  const ranked = await rank(db, s, dims, input.order, measures, inline, caps.rows);
  input.deadline();

  const blank = (): Values => measures.map(() => null);
  const fill = (target: Values, values: ReadonlyMap<number, number | null>) => {
    for (const [index, value] of values) target[index] = value;
  };
  const totals = new Map<string, Values>();
  const cells = new Map<string, Map<string, Values>>();
  for (const row of ranked.rows) {
    const values = blank();
    fill(values, row.values);
    totals.set(row.tuples[dims.length - 1]!, values);
  }

  const withTotals = !column || input.rowTotals;
  const inColumns = column && columns.length ? among(column, groupsOf(columns)) : null;
  const depths = input.groups ? dims.map((_, j) => j + 1) : [dims.length];
  if (ranked.rows.length)
    for (const depth of depths) {
      const own = dims.slice(0, depth);
      const restrict = inRows(own, ranked.rows);
      if (column && inColumns) {
        const found = await valuesBy(db, s, own, column, measures, every, sql`${restrict} AND ${inColumns}`);
        for (const entry of found) {
          let byColumn = cells.get(entry.row);
          if (!byColumn) {
            byColumn = new Map();
            cells.set(entry.row, byColumn);
          }
          const values = blank();
          fill(values, entry.values);
          byColumn.set(entry.column!, values);
        }
        input.deadline();
      }
      const missing = depth === dims.length ? every.filter((index) => !inline.includes(index)) : every;
      if (withTotals && missing.length) {
        for (const entry of await valuesBy(db, s, own, null, measures, missing, restrict)) {
          const values = totals.get(entry.row) ?? blank();
          fill(values, entry.values);
          totals.set(entry.row, values);
        }
        input.deadline();
      }
    }

  const columnTotals = new Map<string, Values>();
  let grand: Values | null = null;
  if (input.columnTotals) {
    if (column && inColumns) {
      for (const entry of await valuesBy(db, s, [], column, measures, every, inColumns)) {
        const values = blank();
        fill(values, entry.values);
        columnTotals.set(entry.column!, values);
      }
      input.deadline();
    }
    if (withTotals) {
      grand = blank();
      for (const entry of await valuesBy(db, s, [], null, measures, every, sql`TRUE`))
        fill(grand, entry.values);
    }
  }
  return {
    rows: ranked.rows,
    columns,
    capped: { rows: ranked.capped, columns: columnsCapped },
    totals,
    cells,
    columnTotals,
    grand,
  };
}
