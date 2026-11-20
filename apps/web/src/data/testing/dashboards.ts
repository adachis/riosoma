import { OTHER_GROUP_KEY, ViewConfig, cellValue, encodeWhere, idsOf, isEmptyValue } from '@riosoma/contracts';
import type {
  CellValue,
  DashboardData,
  DashboardDataRequest,
  DashboardFilters,
  ViewMeta,
  FieldMeta,
  RowData,
  Tile,
  TileData,
  TileRecordsAnswer,
  TileRecordsRequest,
  TileValue,
} from '@riosoma/contracts';
import type { FakeDatabase } from './database';
import { computeViewAggregate } from './aggregates';
import { matches, viewOrder } from './records';

/** Answers `POST /api/dashboards/:dashboardId/tiles/:tileId/records` in tests, in place of the default. */
export type TileRecordsResponder = (
  dashboardId: string,
  tileId: string,
  request: TileRecordsRequest,
  database: FakeDatabase,
) => TileRecordsAnswer | Promise<TileRecordsAnswer>;

/** Answers `POST /api/dashboards/:dashboardId/data` in tests, in place of the computed default. */
export type DashboardResponder = (
  dashboardId: string,
  request: DashboardDataRequest,
  database: FakeDatabase,
) => DashboardData | Promise<DashboardData>;

type ChartTile = Extract<Tile, { kind: 'chart' }>;
type Key = string | number | null;

const failure = (messageKey: string): TileData => ({ kind: 'error', messageKey });

/**
 * A small stand-in for the server's dashboard queries: the same inputs and result shapes, computed
 * from the fake's records in memory.  Date buckets and labels are simplified, and the combined
 * "Other" category comes last with an empty label, as the real one does.
 */
export function computeDashboardData(
  database: FakeDatabase,
  dashboardId: string,
  request: DashboardDataRequest,
  now: number,
): DashboardData {
  const dashboard = database.dashboard(dashboardId);
  const tiles: Record<string, TileData> = {};
  for (const tile of dashboard.config.tiles) {
    if (tile.kind === 'text' || (request.tileIds && !request.tileIds.includes(tile.id))) continue;
    tiles[tile.id] = tileData(database, tile, request.timeZone, now, request.filters);
  }
  return { tiles };
}

/** One data tile, or an interface block that works like one, from the fake's records. */
export function tileData(
  database: FakeDatabase,
  tile: Exclude<Tile, { kind: 'text' }>,
  timeZone: string,
  now: number,
  filters?: DashboardFilters,
): TileData {
  const { schema } = database;
  const table = schema.tables.find((item) => item.id === tile.source.tableId);
  if (!table) return failure('dashboards.tile.tableMissing');
  const fields = schema.fields.filter((field) => field.tableId === table.id);
  const view = tile.source.viewId ? schema.views.find((item) => item.id === tile.source.viewId) : null;
  if (tile.source.viewId && (!view || view.tableId !== table.id))
    return failure('dashboards.tile.viewMissing');
  if (tile.kind === 'pivot') {
    const answer = computeViewAggregate(
      database,
      '',
      { timeZone, summary: false },
      now,
      pivotView(database, tile, filters),
    );
    return answer.kind === 'pivot' || answer.kind === 'error'
      ? answer
      : failure('dashboards.tile.unavailable');
  }
  const used = [
    tile.kind === 'records' ? tile.fieldIds : [],
    tile.kind === 'records' ? [] : [tile.value.fieldId],
    tile.kind === 'chart' ? [tile.groupBy.fieldId, tile.seriesBy] : [],
  ].flat();
  const field = (id: string | null) => (id ? fields.find((item) => item.id === id) : undefined);
  if (used.some((id) => id && !field(id))) return failure('dashboards.tile.fieldMissing');
  const rows = tileRows(database, tile, timeZone, now);
  if (tile.kind === 'number')
    return {
      kind: 'number',
      value: aggregate(rows, tile.value, field(tile.value.fieldId)),
      records: rows.length,
    };
  if (tile.kind === 'records')
    return { kind: 'records', rows: rows.slice(0, tile.limit), total: rows.length };
  return chart(tile, rows, field(tile.groupBy.fieldId)!, field(tile.seriesBy), field(tile.value.fieldId), {
    timeZone,
    collaborators: new Map(schema.collaborators.map((person) => [person.id, person.name])),
  });
}

function aggregate(rows: readonly RowData[], value: TileValue, field: FieldMeta | undefined): number | null {
  if (value.fn === 'count') return rows.length;
  if (!field) return null;
  const values = rows.map((row) => cellValue(row, field)).filter((item) => !isEmptyValue(item));
  if (value.fn === 'countUnique') return new Set(values.map((item) => JSON.stringify(item))).size;
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

interface Labels {
  timeZone: string;
  collaborators: ReadonlyMap<string, string>;
}

/** The categories one value falls into: one per choice or person in a list, one otherwise. */
function keysOf(
  field: FieldMeta,
  value: CellValue,
  bucket: ChartTile['groupBy']['dateBucket'],
  labels: Labels,
): Array<{ key: Key; label: string }> {
  if (isEmptyValue(value)) return [{ key: null, label: '' }];
  const ids = typeof value === 'string' ? [value] : idsOf(value);
  switch (field.type) {
    case 'singleSelect':
    case 'multipleSelect':
      return ids.map((id) => ({
        key: id,
        label: field.options.choices.find((choice) => choice.id === id)?.name ?? '',
      }));
    case 'user':
    case 'createdBy':
    case 'lastModifiedBy':
      return ids.map((id) => ({ key: id, label: labels.collaborators.get(id) ?? '' }));
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime': {
      const key = dateKey(String(value), bucket, labels.timeZone);
      return [{ key, label: key }];
    }
    case 'checkbox':
      return [{ key: value === true ? 1 : 0, label: value === true ? 'true' : 'false' }];
    default:
      return typeof value === 'number'
        ? [{ key: value, label: String(value) }]
        : [{ key: String(value), label: String(value) }];
  }
}

function dateKey(value: string, bucket: ChartTile['groupBy']['dateBucket'], timeZone: string): string {
  const day =
    value.length === 10
      ? value
      : new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(value));
  const [year, month] = [day.slice(0, 4), Number(day.slice(5, 7))];
  switch (bucket) {
    case 'year':
      return year;
    case 'quarter':
      return `${year}-Q${Math.ceil(month / 3)}`;
    case 'month':
      return day.slice(0, 7);
    case 'week': {
      const date = new Date(`${day}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      return date.toISOString().slice(0, 10);
    }
    default:
      return day;
  }
}

function chart(
  tile: ChartTile,
  rows: readonly RowData[],
  groupBy: FieldMeta,
  seriesBy: FieldMeta | undefined,
  valueField: FieldMeta | undefined,
  labels: Labels,
): TileData {
  const categories = new Map<string, { key: Key; label: string }>();
  const series = new Map<string, { key: Key; label: string }>();
  const cells = new Map<string, RowData[]>();
  for (const row of rows) {
    const splits = seriesBy
      ? keysOf(seriesBy, cellValue(row, seriesBy), null, labels)
      : [{ key: null, label: '' }];
    for (const category of keysOf(groupBy, cellValue(row, groupBy), tile.groupBy.dateBucket, labels)) {
      categories.set(JSON.stringify(category.key), category);
      for (const split of splits) {
        series.set(JSON.stringify(split.key), split);
        const cell = `${JSON.stringify(category.key)}|${JSON.stringify(split.key)}`;
        cells.set(cell, [...(cells.get(cell) ?? []), row]);
      }
    }
  }
  const value = (category: Key, split: Key) =>
    aggregate(
      cells.get(`${JSON.stringify(category)}|${JSON.stringify(split)}`) ?? [],
      tile.value,
      valueField,
    );
  const splits = [...series.values()];
  const total = (key: Key) => splits.reduce((sum, split) => sum + (value(key, split.key) ?? 0), 0);
  const choiceOrder = (key: Key) =>
    groupBy.type === 'singleSelect' || groupBy.type === 'multipleSelect'
      ? groupBy.options.choices.findIndex((choice) => choice.id === key)
      : 0;
  const ordered = [...categories.values()].sort((a, b) => {
    if (tile.sort !== 'category') {
      const difference = total(a.key) - total(b.key);
      if (difference) return tile.sort === 'valueAscending' ? difference : -difference;
    }
    if (a.key === null || b.key === null) return a.key === null ? 1 : -1;
    const choice = choiceOrder(a.key) - choiceOrder(b.key);
    if (choice) return choice;
    return typeof a.key === 'number' && typeof b.key === 'number'
      ? a.key - b.key
      : String(a.key).localeCompare(String(b.key));
  });
  const shown = ordered.slice(0, tile.limit);
  const rest = ordered.slice(tile.limit);
  return {
    kind: 'chart',
    categories: [...shown, ...(rest.length ? [{ key: OTHER_GROUP_KEY, label: '' }] : [])],
    series: splits.map((split) => ({
      ...split,
      values: [
        ...shown.map((category) => value(category.key, split.key)),
        ...(rest.length
          ? [rest.reduce((sum, category) => sum + (value(category.key, split.key) ?? 0), 0)]
          : []),
      ],
    })),
    truncated: rest.length > 0,
  };
}

/** The records a tile reads, in its view's order. */
function tileRows(
  database: FakeDatabase,
  tile: Exclude<Tile, { kind: 'text' }>,
  timeZone: string,
  now: number,
): RowData[] {
  const { schema } = database;
  const fields = schema.fields.filter((field) => field.tableId === tile.source.tableId);
  const view = tile.source.viewId ? schema.views.find((item) => item.id === tile.source.viewId) : null;
  const records = database.rows(tile.source.tableId);
  const order = view ? viewOrder(records, view, schema.fields, timeZone, now) : records.order();
  const rows: RowData[] = [];
  for (let index = 0; index < order.total; index++) {
    const row = records.get(order.idAt(index)!);
    if (row && matches(row, tile.source.filter, fields, timeZone, now)) rows.push(row);
  }
  return rows;
}

/**
 * A small stand-in for the records behind a part of a chart: the records whose grouping value is
 * the category asked for, and its series when one is given.  "Other" is refused, and the address
 * opens the table's first grid view with an "is" condition, which suits the select and text
 * fields tests group by.
 */
export function computeTileRecords(
  database: FakeDatabase,
  dashboardId: string,
  tileId: string,
  request: TileRecordsRequest,
  now: number,
): TileRecordsAnswer {
  const tile = database.dashboard(dashboardId).config.tiles.find((item) => item.id === tileId);
  if (tile?.kind === 'pivot' && 'row' in request.slice) {
    const answer = computeViewAggregate(
      database,
      '',
      {
        timeZone: request.timeZone,
        summary: false,
        records: { ...request.slice, offset: request.offset, limit: request.limit },
      },
      now,
      pivotView(database, tile, request.filters),
    );
    return answer.kind === 'records'
      ? { ...answer, open: null }
      : { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
  }
  if (tile?.kind !== 'chart') return { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
  if (!('category' in request.slice)) return { kind: 'error', messageKey: 'dashboards.tile.unavailable' };
  const { category, series } = request.slice;
  if (category === OTHER_GROUP_KEY || series === OTHER_GROUP_KEY)
    return { kind: 'error', messageKey: 'dashboards.drill.otherUnsupported' };
  const field = (id: string) => database.schema.fields.find((item) => item.id === id)!;
  const labels = { timeZone: request.timeZone, collaborators: new Map<string, string>() };
  const within = (row: RowData, fieldId: string, key: Key, bucket: ChartTile['groupBy']['dateBucket']) =>
    keysOf(field(fieldId), cellValue(row, field(fieldId)), bucket, labels).some((item) => item.key === key);
  const rows = tileRows(database, tile, request.timeZone, now).filter(
    (row) =>
      within(row, tile.groupBy.fieldId, category, tile.groupBy.dateBucket) &&
      (series === undefined || !tile.seriesBy || within(row, tile.seriesBy, series, null)),
  );
  const grid = database.schema.views.find(
    (view) => view.tableId === tile.source.tableId && view.type === 'grid',
  );
  const where = encodeWhere({
    conjunction: 'and',
    conditions: [
      category === null
        ? { id: 'drill1', fieldId: tile.groupBy.fieldId, operator: 'isEmpty' }
        : { id: 'drill1', fieldId: tile.groupBy.fieldId, operator: 'is', value: category },
    ],
  });
  return {
    kind: 'records',
    rows: rows.slice(request.offset, request.offset + request.limit),
    total: rows.length,
    open: grid ? { viewId: grid.id, where } : null,
  };
}

function pivotView(
  database: FakeDatabase,
  tile: Extract<Tile, { kind: 'pivot' }>,
  filters?: DashboardFilters,
): ViewMeta {
  const source = database.schema.views.find((view) => view.id === tile.source.viewId);
  return {
    ...database.schema.views.find((view) => view.tableId === tile.source.tableId)!,
    type: 'pivot',
    config: ViewConfig.parse({
      pivot: tile.pivot,
      sorts: source?.config.sorts ?? [],
      filter: {
        conjunction: 'and',
        conditions: [
          source?.config.filter,
          tile.source.filter,
          ...(filters?.filter((item) => item.tableId === tile.source.tableId).map((item) => item.filter) ??
            []),
        ].filter((item) => item != null),
      },
    }),
  };
}
