import { AGGREGATE_CAPS, cellValue, idsOf, isEmptyValue } from '@riosoma/contracts';
import type {
  CellValue,
  ChartAggregate,
  FieldMeta,
  GroupBy,
  GroupKey,
  PivotAggregate,
  PivotCell,
  PivotOrder,
  PivotRow,
  RowData,
  TileValue,
  ViewAggregate,
  ViewAggregateRequest,
  ViewMeta,
} from '@riosoma/contracts';
import type { FakeDatabase } from './database';
import { viewOrder } from './records';

/** Answers `POST /api/databases/:databaseId/views/:viewId/aggregate` in tests, in place of the computed default. */
export type ViewAggregateResponder = (
  viewId: string,
  request: ViewAggregateRequest,
  database: FakeDatabase,
) => ViewAggregate | Promise<ViewAggregate>;

/** One group a record falls in: its key as the server writes it in text, and its label. */
interface Group {
  key: string | null;
  label: string;
}

interface Dim {
  field: FieldMeta;
  bucket: GroupBy['dateBucket'];
  groupsOf(row: RowData): Group[];
  keyOf(text: string | null): GroupKey;
  compare(one: Group, other: Group): number;
}

const collator = new Intl.Collator('en-US', { numeric: true });
const unavailable: ViewAggregate = { kind: 'error', messageKey: 'dashboards.tile.unavailable' };

function day(value: string, timeZone: string): string {
  return value.length === 10
    ? value
    : new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(value));
}

/** A period's first day, the way the server keys date groups. */
function periodStart(date: string, bucket: GroupBy['dateBucket']): string {
  const [year, month] = [date.slice(0, 4), Number(date.slice(5, 7))];
  switch (bucket) {
    case 'year':
      return `${year}-01-01`;
    case 'quarter':
      return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
    case 'month':
      return `${date.slice(0, 7)}-01`;
    case 'week': {
      const start = new Date(`${date}T12:00:00Z`);
      start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
      return start.toISOString().slice(0, 10);
    }
    default:
      return date;
  }
}

function dimOf(
  database: FakeDatabase,
  field: FieldMeta,
  bucket: GroupBy['dateBucket'],
  timeZone: string,
): Dim {
  const people = new Map(database.schema.collaborators.map((person) => [person.id, person.name]));
  const numeric = ['number', 'currency', 'percent', 'duration', 'rating', 'autoNumber', 'count'].includes(
    field.type,
  );
  const choices =
    field.type === 'singleSelect' || field.type === 'multipleSelect' ? field.options.choices : [];
  const linkedName = (id: string) => {
    if (field.type !== 'link') return id;
    const table = database.table(field.options.linkedTableId);
    const row = database.rows(table.id).get(id);
    return row ? String(cellValue(row, database.field(table.primaryFieldId)) ?? '') : '';
  };
  const groupsOf = (row: RowData): Group[] => {
    const value: CellValue = cellValue(row, field);
    if (field.type === 'checkbox') return [{ key: String(value === true), label: String(value === true) }];
    if (isEmptyValue(value)) return [{ key: null, label: '' }];
    // A single select or person holds one ID, and lists hold several.
    const ids = typeof value === 'string' ? [value] : idsOf(value);
    switch (field.type) {
      case 'singleSelect':
      case 'multipleSelect':
        return ids.map((id) => ({ key: id, label: choices.find((item) => item.id === id)?.name ?? '' }));
      case 'user':
      case 'createdBy':
      case 'lastModifiedBy':
        return ids.map((id) => ({ key: id, label: people.get(id) ?? '' }));
      case 'link':
        return ids.map((id) => ({ key: id, label: linkedName(id) }));
      case 'date':
      case 'createdTime':
      case 'lastModifiedTime': {
        const key = periodStart(day(String(value), timeZone), bucket);
        return [{ key, label: key }];
      }
      default:
        return [{ key: String(value), label: String(value) }];
    }
  };
  const position = (group: Group) => choices.findIndex((item) => item.id === group.key);
  return {
    field,
    bucket,
    groupsOf,
    keyOf: (text) => (text === null ? null : numeric ? Number(text) : text),
    compare: (one, other) => {
      if (choices.length) return position(one) - position(other);
      if (numeric) return Number(one.key) - Number(other.key);
      return collator.compare(one.label || String(one.key), other.label || String(other.key));
    },
  };
}

function aggregate(rows: readonly RowData[], value: TileValue, field: FieldMeta | undefined): number | null {
  if (value.fn === 'count')
    return field ? rows.filter((row) => !isEmptyValue(cellValue(row, field))).length : rows.length;
  if (!field) return null;
  const values = rows.map((row) => cellValue(row, field)).filter((item) => !isEmptyValue(item));
  if (value.fn === 'countUnique')
    return new Set(values.flatMap((item) => (Array.isArray(item) ? idsOf(item) : [JSON.stringify(item)])))
      .size;
  const numbers = values.filter((item): item is number => typeof item === 'number');
  if (!numbers.length) return null;
  switch (value.fn) {
    case 'sum':
      return numbers.reduce((total, item) => total + item, 0);
    case 'average':
      return numbers.reduce((total, item) => total + item, 0) / numbers.length;
    case 'min':
      return Math.min(...numbers);
    case 'max':
      return Math.max(...numbers);
  }
}

/** Every combination of a record's groups across these fields, one per value of each list. */
function combinations(row: RowData, dims: readonly Dim[]): Group[][] {
  return dims.reduce<Group[][]>(
    (partial, dim) => partial.flatMap((prefix) => dim.groupsOf(row).map((group) => [...prefix, group])),
    [[]],
  );
}

const tupleOf = (groups: readonly Group[]) => JSON.stringify(groups.map((group) => group.key));

interface Bucket {
  groups: Group[];
  rows: Set<RowData>;
}

function bucket(rows: readonly RowData[], dims: readonly Dim[]): Map<string, Bucket> {
  const found = new Map<string, Bucket>();
  for (const row of rows)
    for (const groups of combinations(row, dims)) {
      const tuple = tupleOf(groups);
      let entry = found.get(tuple);
      if (!entry) {
        entry = { groups, rows: new Set() };
        found.set(tuple, entry);
      }
      entry.rows.add(row);
    }
  return found;
}

/** Groups in order: by label, or by the first value of each level's own group. */
function ordered(
  buckets: Map<string, Bucket>,
  rows: readonly RowData[],
  dims: readonly Dim[],
  order: PivotOrder,
  first: (rows: readonly RowData[]) => number | null,
): Bucket[] {
  const byValue = order === 'valueAscending' || order === 'valueDescending';
  const flip = order === 'labelDescending' || order === 'valueDescending' ? -1 : 1;
  const totals = new Map<string, number | null>();
  const total = (groups: Group[]) => {
    const tuple = tupleOf(groups);
    if (!totals.has(tuple))
      totals.set(tuple, first([...(bucket(rows, dims.slice(0, groups.length)).get(tuple)?.rows ?? [])]));
    return totals.get(tuple) ?? null;
  };
  return [...buckets.values()].sort((one, other) => {
    for (let j = 0; j < dims.length; j++) {
      const a = one.groups[j]!;
      const b = other.groups[j]!;
      if (a.key === b.key) continue;
      if (byValue) {
        const difference =
          (total(one.groups.slice(0, j + 1)) ?? 0) - (total(other.groups.slice(0, j + 1)) ?? 0);
        if (difference) return difference * flip;
      }
      if (a.key === null || b.key === null) return a.key === null ? 1 : -1;
      return dims[j]!.compare(a, b) * (byValue ? 1 : flip);
    }
    return 0;
  });
}

/**
 * A small stand-in for the server's chart and pivot queries: the same inputs and answer shapes,
 * computed from the fake's records in memory.  Labels are simplified: dates keep their keys, and
 * checkboxes read as `true` and `false`.
 */
export function computeViewAggregate(
  database: FakeDatabase,
  viewId: string,
  request: ViewAggregateRequest,
  now: number,
  viewOverride?: ViewMeta,
): ViewAggregate {
  const view = viewOverride ?? database.view(viewId);
  const fields = database.schema.fields.filter((field) => field.tableId === view.tableId);
  const field = (id: string | null) => (id ? fields.find((item) => item.id === id) : undefined);
  const chart = view.type === 'chart' ? view.config.chart : null;
  const pivot = view.type === 'pivot' ? view.config.pivot : null;
  const rowsBy: GroupBy[] = chart?.groupBy ? [chart.groupBy] : (pivot?.rows ?? []);
  const columnBy: GroupBy | null = chart
    ? chart.seriesBy
      ? { fieldId: chart.seriesBy, dateBucket: null }
      : null
    : (pivot?.column ?? null);
  const values: TileValue[] = chart ? [chart.value] : (pivot?.values ?? []);
  const ids = [...rowsBy, ...(columnBy ? [columnBy] : [])].map((group) => group.fieldId);
  ids.push(...values.flatMap((value) => (value.fieldId ? [value.fieldId] : [])));
  if (ids.some((id) => !field(id))) return unavailable;
  const dimFor = (group: GroupBy) =>
    dimOf(database, field(group.fieldId)!, group.dateBucket, request.timeZone);
  const dims = rowsBy.map(dimFor);
  const column = columnBy ? dimFor(columnBy) : null;
  const records = database.rows(view.tableId);
  const order = viewOrder(records, view, database.schema.fields, request.timeZone, now);
  const rows: RowData[] = [];
  for (let index = 0; index < order.total; index++) {
    const row = records.get(order.idAt(index)!);
    if (row) rows.push(row);
  }

  if (request.records) {
    const target = request.records;
    const matching = rows.filter(
      (row) =>
        target.row.every((key, j) =>
          dims[j]!.groupsOf(row).some((group) => group.key === (key === null ? null : String(key))),
        ) &&
        (target.column === undefined ||
          column!
            .groupsOf(row)
            .some((group) => group.key === (target.column === null ? null : String(target.column)))),
    );
    return {
      kind: 'records',
      rows: matching.slice(target.offset, target.offset + target.limit),
      total: matching.length,
    };
  }

  const computed = (subset: Iterable<RowData>) => {
    const list = [...subset];
    return values.map((value) => aggregate(list, value, field(value.fieldId)));
  };
  const leaves = bucket(rows, dims);
  const sort = chart
    ? chart.sort === 'category'
      ? 'labelAscending'
      : chart.sort
    : (pivot?.order ?? 'labelAscending');
  const kept = ordered(leaves, rows, dims, sort, (subset) => computed(subset)[0] ?? null);
  const shown = kept.slice(0, AGGREGATE_CAPS.rows);
  const columnBuckets = column
    ? ordered(bucket(rows, [column]), rows, [column], 'labelAscending', () => null)
    : [];
  const columns = columnBuckets.slice(0, AGGREGATE_CAPS.columns);
  const cellOf = (groups: Group[], columnGroup: Group): PivotCell => {
    const inRow = bucket(rows, dims.slice(0, groups.length)).get(tupleOf(groups))?.rows ?? new Set<RowData>();
    const inCell = [...inRow].filter((row) =>
      column!.groupsOf(row).some((group) => group.key === columnGroup.key),
    );
    return inCell.length ? computed(inCell) : null;
  };

  if (chart) {
    const empty = values[0]!.fn === 'count' || values[0]!.fn === 'countUnique' ? 0 : null;
    const answer: ChartAggregate = {
      kind: 'chart',
      categories: shown.map((entry) => ({
        key: dims[0]!.keyOf(entry.groups[0]!.key),
        label: entry.groups[0]!.label,
      })),
      series: column
        ? columns.map((line) => ({
            key: column.keyOf(line.groups[0]!.key),
            label: line.groups[0]!.label,
            values: shown.map((entry) => cellOf(entry.groups, line.groups[0]!)?.[0] ?? empty),
          }))
        : [{ key: null, label: '', values: shown.map((entry) => computed(entry.rows)[0] ?? empty) }],
      capped: { categories: kept.length > shown.length, series: columnBuckets.length > columns.length },
    };
    return answer;
  }

  const settings = pivot!;
  const withTotals = !column || settings.rowTotals;
  const rowAt = (groups: Group[]): PivotRow => {
    const inRow = bucket(rows, dims.slice(0, groups.length)).get(tupleOf(groups))?.rows ?? new Set<RowData>();
    return {
      keys: groups.map((group, j) => dims[j]!.keyOf(group.key)),
      label: groups.at(-1)!.label,
      cells: columns.map((line) => cellOf(groups, line.groups[0]!)),
      total: withTotals ? computed(inRow) : null,
    };
  };
  const pivotRows: PivotRow[] = [];
  let previous: Group[] | null = null;
  for (const entry of shown) {
    const changed = entry.groups.findIndex(
      (group, j) => j < dims.length - 1 && previous?.[j]?.key !== group.key,
    );
    if (changed >= 0)
      for (let j = changed; j < dims.length - 1; j++) pivotRows.push(rowAt(entry.groups.slice(0, j + 1)));
    pivotRows.push(rowAt(entry.groups));
    previous = entry.groups;
  }
  const answer: PivotAggregate = {
    kind: 'pivot',
    columns: columns.map((line) => ({
      key: column!.keyOf(line.groups[0]!.key),
      label: line.groups[0]!.label,
    })),
    rows: pivotRows,
    totals: settings.columnTotals
      ? {
          cells: columns.map((line) => computed(line.rows)),
          total: withTotals ? computed(rows) : null,
        }
      : null,
    capped: { rows: kept.length > shown.length, columns: columnBuckets.length > columns.length },
  };
  return answer;
}
