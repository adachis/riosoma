import {
  cellValue,
  filterBlockCondition,
  filtersFor,
  idsOf,
  isGroup,
  isSummaryBlock,
} from '@riosoma/contracts';
import type {
  FilterCondition,
  FilterGroup,
  InterfaceData,
  InterfaceDataRequest,
  InterfaceRecordsPage,
  InterfaceRecordsRequest,
  RecordsBlock,
  RowData,
  TileData,
} from '@riosoma/contracts';
import { ApiError } from '../../api';
import { tileData } from './dashboards';
import { missing, type FakeDatabase } from './database';
import { matches, viewOrder } from './records';

/** Answers `POST /api/interfaces/:interfaceId/data` in tests, in place of the computed default. */
export type InterfaceDataResponder = (
  interfaceId: string,
  request: InterfaceDataRequest,
  database: FakeDatabase,
) => InterfaceData | Promise<InterfaceData>;

function unavailable(): never {
  throw new ApiError(404, {
    code: 'not_found',
    messageKey: 'interfaces.block.unavailable',
    userFault: true,
  });
}

function page(database: FakeDatabase, interfaceId: string, pageId: string) {
  return database.interfaceMeta(interfaceId).pages.find((item) => item.id === pageId) ?? missing();
}

const TILE_MESSAGES: Readonly<Record<string, string>> = {
  'dashboards.tile.tableMissing': 'interfaces.block.unavailable',
  'dashboards.tile.viewMissing': 'interfaces.block.unavailable',
  'dashboards.tile.fieldMissing': 'interfaces.block.unavailable',
};

/**
 * A small stand-in for the server's interface reads: number and chart blocks as the fake computes
 * dashboard tiles, and records blocks from the fake's records in their view's order.
 */
export function computeInterfaceData(
  database: FakeDatabase,
  interfaceId: string,
  request: InterfaceDataRequest,
  now: number,
): InterfaceData {
  const blocks: Record<string, TileData> = {};
  for (const block of page(database, interfaceId, request.pageId).blocks.filter(isSummaryBlock)) {
    if (request.blockIds && !request.blockIds.includes(block.id)) continue;
    const data = tileData(database, block, request.timeZone, now);
    blocks[block.id] =
      data.kind === 'error'
        ? { ...data, messageKey: TILE_MESSAGES[data.messageKey] ?? data.messageKey }
        : data;
  }
  return { blocks };
}

function filterFields(group: FilterGroup | null): string[] {
  return (group?.conditions ?? []).flatMap((condition) =>
    isGroup(condition) ? filterFields(condition) : [condition.fieldId],
  );
}

export function interfaceRecords(
  database: FakeDatabase,
  interfaceId: string,
  request: InterfaceRecordsRequest,
  now: number,
  snapshot: string,
): InterfaceRecordsPage {
  const found = page(database, interfaceId, request.pageId);
  const block = found.blocks.find(
    (item): item is RecordsBlock => item.id === request.blockId && item.kind === 'records',
  );
  if (!block) missing();
  const { schema } = database;
  const table = schema.tables.find((item) => item.id === block.source.tableId);
  const view = schema.views.find((item) => item.id === block.source.viewId);
  if (!table || !view || view.tableId !== table.id) unavailable();
  const fields = schema.fields.filter((field) => field.tableId === table.id);
  const known = new Set(fields.map((field) => field.id));
  if ([...block.fieldIds, ...filterFields(block.source.filter)].some((id) => !known.has(id))) unavailable();
  const conditions: Array<FilterCondition | FilterGroup> = block.source.filter ? [block.source.filter] : [];
  for (const filter of filtersFor(found, block)) {
    const field = fields.find((item) => item.id === filter.fieldId);
    const condition = field
      ? filterBlockCondition(filter.control, field, request.filters?.[filter.id])
      : null;
    if (condition) conditions.push(condition);
  }
  const narrowed: FilterGroup = { conjunction: 'and', conditions };
  const records = database.rows(table.id);
  const order = viewOrder(records, view, schema.fields, request.timeZone, now);
  const rows: RowData[] = [];
  for (let index = 0; index < order.total; index++) {
    const row = records.get(order.idAt(index)!);
    if (row && matches(row, narrowed, fields, request.timeZone, now)) rows.push(row);
  }
  const shown = rows.slice(request.offset, request.offset + request.limit);
  const linked: Record<string, string> = {};
  for (const field of fields) {
    if (field.type !== 'link') continue;
    const primary = database.field(database.table(field.options.linkedTableId).primaryFieldId);
    for (const row of shown)
      for (const id of idsOf(cellValue(row, field))) {
        const target = database.rows(field.options.linkedTableId).get(id);
        if (target) linked[id] = String(cellValue(target, primary) ?? '');
      }
  }
  return {
    snapshot,
    total: rows.length,
    offset: request.offset,
    rows: shown,
    rebuilt: false,
    linked,
    tableId: table.id,
  };
}
