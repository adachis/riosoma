import { ident, query, sql } from '@riosoma/db';
import { readsLive } from '../sources/live.js';
import {
  isSummaryBlock,
  AppError,
  type Command,
  type RioPlanPreview,
  type Tile,
  type TileData,
} from '@riosoma/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { AccessScope } from './access.js';
import type { CommandContext } from './commands/context.js';
import { computeDataTiles, failure } from './dashboards/routes.js';
import { isDataTile } from './dashboards/config.js';
import { loadSchema, loadTable, loadFields } from './metadata.js';
import { resolveSelectOptions } from './select-options.js';
import { naturalCollation } from './dashboards/routes.js';
import { viewRecords } from './view-aggregates/routes.js';
import { chartAggregate, pivotAggregate } from './view-aggregates/compute.js';
import { gridSummary } from './view-aggregates/grid-summary.js';
import { gridGroups } from './view-aggregates/grid-groups.js';

/** A bounded snapshot keeps all browsing inside the preview off the network. */
export const PREVIEW_ROWS = 200;
export const PREVIEW_READS = 20;
export const PREVIEW_MS = 5_000;

export async function readPlanPreview(
  c: CommandContext,
  commands: Command[],
  timeZone: string,
  log: FastifyBaseLogger,
  expires = performance.now() + PREVIEW_MS,
  readLimit = PREVIEW_READS,
): Promise<RioPlanPreview> {
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  const role = await scope.require(c.databaseId, 'read');
  const schema = (await loadSchema(c.db, c.schemas, c.databaseId, role, { scope, secretKey: c.secretKey }))!;
  const fieldIds = commands.flatMap((command) => ('fieldId' in command ? [command.fieldId] : []));
  // Deleted fields remain in metadata, so their tables can still show the proposed removal.
  const fieldTables = new Map(
    fieldIds.length
      ? (
          await query<{ id: string; table_id: string }>(
            c.db,
            sql`SELECT id, table_id FROM ${ident(c.schemas.app, 'fields')}
              WHERE id = ANY(${fieldIds}::text[])
              AND table_id = ANY(${schema.tables.map((table) => table.id)}::text[])`,
          )
        ).rows.map((field) => [field.id, field.table_id])
      : [],
  );
  const targets = [
    ...new Set(
      commands.flatMap((command) => {
        if (command.kind === 'dashboard.create') return [command.dashboard.id];
        if ('dashboardId' in command) return [command.dashboardId];
        if (command.kind === 'interface.create') return [command.interface.id];
        if ('interfaceId' in command) return [command.interfaceId];
        if (command.kind === 'automation.create') return [command.automation.id];
        if ('automationId' in command) return [command.automationId];
        if (command.kind === 'view.create') return [command.view.id];
        if ('viewId' in command && command.viewId) return [command.viewId];
        const tableId =
          command.kind === 'table.duplicate'
            ? command.newTableId
            : command.kind === 'field.duplicate'
              ? schema.fields.find((field) => field.id === command.newFieldId)?.tableId
              : command.kind === 'table.create'
                ? command.table.id
                : 'tableId' in command
                  ? command.tableId
                  : 'fieldId' in command
                    ? fieldTables.get(command.fieldId)
                    : undefined;
        return schema.views
          .filter((view) => view.tableId === tableId)
          .slice(0, 1)
          .map((view) => view.id);
      }),
    ),
  ];
  let rowsLeft = PREVIEW_ROWS;
  let readsLeft = readLimit;
  const unavailable = () => ({ kind: 'error' as const, messageKey: 'dashboards.tile.unavailable' });
  const result: RioPlanPreview = {
    schema,
    dashboards: {},
    interfaces: {},
    records: {},
    views: {},
    aggregates: {},
    rowLimit: PREVIEW_ROWS,
    targets,
  };
  const compute = async (tiles: Array<Exclude<Tile, { kind: 'text' }>>, followViewOrder = false) => {
    const result: Record<string, TileData> = {};
    for (const tile of tiles) {
      if (readsLeft-- <= 0 || performance.now() >= expires || (tile.kind === 'records' && rowsLeft <= 0)) {
        result[tile.id] = unavailable();
        continue;
      }
      const limited =
        tile.kind === 'records' ? { ...tile, limit: Math.min(tile.limit, rowsLeft, 100) } : tile;
      const data = (
        await computeDataTiles(
          c.db,
          c.schemas,
          scope,
          c.databaseId,
          [limited],
          timeZone,
          log,
          Math.max(1, Math.min(1_000, Math.floor(expires - performance.now()))),
          false,
          { simulatedRids: true },
          followViewOrder,
        )
      )[tile.id]!;
      result[tile.id] = data;
      if (data.kind === 'records') rowsLeft -= data.rows.length;
    }
    return result;
  };
  const records = async (
    id: string,
    tableId: string,
    viewId: string | null,
    filter: Extract<Tile, { kind: 'records' }>['source']['filter'] = null,
    followViewOrder = false,
  ): Promise<TileData> => {
    const data = await compute(
      [
        {
          kind: 'records',
          id,
          title: '',
          place: { x: 0, y: 0, w: 12, h: 4 },
          source: { tableId, viewId, filter },
          fieldIds: schema.fields.filter((field) => field.tableId === tableId).map((field) => field.id),
          limit: PREVIEW_ROWS,
        },
      ],
      followViewOrder,
    );
    return data[id]!;
  };
  for (const dashboard of schema.dashboards ?? []) {
    if (!targets.includes(dashboard.id)) continue;
    result.dashboards[dashboard.id] = { tiles: await compute(dashboard.config.tiles.filter(isDataTile)) };
  }
  for (const item of schema.interfaces ?? []) {
    if (!targets.includes(item.id)) continue;
    for (const page of item.pages) {
      result.interfaces[`${item.id}/${page.id}`] = {
        blocks: await compute(page.blocks.filter(isSummaryBlock)),
      };
      for (const block of page.blocks) {
        if (block.kind !== 'records') continue;
        result.records[`${item.id}/${page.id}/${block.id}`] = await records(
          block.id,
          block.source.tableId,
          block.source.viewId,
          block.source.filter,
        );
      }
    }
  }
  const read = {
    timeZone,
    now: new Date(),
    natural: await naturalCollation(c.db, c.schemas),
    simulatedRids: true,
  };
  for (const view of schema.views) {
    if (!targets.includes(view.id)) continue;
    result.views[view.id] = await records(view.id, view.tableId, view.id, null, true);
    if (view.type !== 'grid' && view.type !== 'chart' && view.type !== 'pivot') continue;
    if (readsLeft-- <= 0 || performance.now() >= expires) {
      result.aggregates![view.id] = unavailable();
      if (view.type === 'grid' && (view.config.groups.length || view.config.pinnedRecordIds.length))
        result.views[view.id] = unavailable();
      continue;
    }
    await query(c.db, sql`SAVEPOINT preview_aggregate`);
    try {
      await query(
        c.db,
        sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.min(1_000, Math.floor(expires - performance.now()))))}, true)`,
      );
      const table = await loadTable(c.db, c.schemas, view.tableId);
      if (!table || readsLive(table)) throw new AppError('not_found', 'errors.notFound');
      const values = viewRecords(
        table,
        view,
        await resolveSelectOptions(
          c.db,
          c.schemas,
          scope,
          scope.visibleFields(table.id, await loadFields(c.db, c.schemas, [table.id])),
        ),
        scope,
        c.schemas,
        read,
      );
      const deadline = () => {
        if (performance.now() >= expires) throw new AppError('unavailable', 'errors.unavailable');
      };
      const sampled = result.views[view.id]!;
      if (view.type === 'grid' && sampled.kind === 'records') {
        deadline();
        sampled.pinnedCount = sampled.rows.filter((row) =>
          view.config.pinnedRecordIds.includes(row.id),
        ).length;
        // Boundaries describe the sampled rows, so the sandbox never requests omitted records.
        sampled.groups = await gridGroups(
          c.db,
          c.schemas,
          {
            table,
            view,
            fields: [...values.fields.values()],
            predicate: values.scope,
            context: read,
            access: scope.accessKey(table.id),
            values: values.values,
          },
          undefined,
          {
            from: values.from,
            where: sql`(${values.where}) AND __id = ANY(${sampled.rows.map((row) => row.id)}::text[])`,
          },
        );
      }
      result.aggregates![view.id] =
        view.type === 'grid'
          ? await gridSummary(c.db, values, view.config, deadline)
          : view.type === 'chart' && view.config.chart.groupBy
            ? await chartAggregate(c.db, values, view.config.chart, deadline)
            : view.type === 'pivot' && view.config.pivot.rows.length
              ? await pivotAggregate(c.db, values, view.config.pivot, deadline)
              : unavailable();
    } catch (error) {
      await query(c.db, sql`ROLLBACK TO SAVEPOINT preview_aggregate`);
      const messageKey = failure(error);
      if (!messageKey) throw error;
      result.aggregates![view.id] = { kind: 'error', messageKey };
      if (view.type === 'grid' && view.config.groups.length && !result.views[view.id]!.groups)
        result.views[view.id] = { kind: 'error', messageKey };
    } finally {
      await query(c.db, sql`RELEASE SAVEPOINT preview_aggregate`);
    }
  }
  return result;
}
