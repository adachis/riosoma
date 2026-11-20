import { sparklineFields } from './sparklines.js';
import { linkChoices } from './link-picker.js';
import { LinkChoicesRequest } from '@riosoma/contracts';
import { ChoiceId } from '@riosoma/contracts';
import { sourceOptionsPage } from './select-options.js';
import { conversionSourceChoices, isSelect, resolveSelectOptions, sourceChoices } from './select-options.js';
import { decorateRecordLocks } from './record-locks.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import { syncHistory } from '../sources/history.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  canConvert,
  ConversionPreviewRequest,
  ExportQuery,
  FieldId,
  PositionQuery,
  RecordId,
  RowsQuery,
  TableId,
  ViewId,
  RecordExportQuery,
  RecordNamesRequest,
  RecordHistoryCellsRequest,
  type RecordHistoryCells,
  type RecordNames,
  type RowData,
  ViewSearchRequest,
  ViewRangesQuery,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Sql } from '@riosoma/db';
import { auditEvent, authDatabase } from '../auth/database.js';
import { disposition } from './files/detect.js';
import { exportFileName } from './export/filename.js';
import { EXPORT_TYPES, exportView } from './export/index.js';
import { recordWord } from './export/office/record.js';
import { checkFormat } from './export/source.js';
import type { StoredField, StoredTable } from './types.js';
import { displayExpr } from './physical/relations.js';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { rowAttachments } from './files/metadata.js';
import { primaryField } from './commands/links.js';
import { AccessScope } from './access.js';
import { dataStore } from './context.js';
import { loadCollaborators, loadField, loadFields, loadTable, loadView, loadViews } from './metadata.js';
import { previewConversion } from './physical/convert.js';
import { ridsForIds } from './physical/order.js';
import { fetchPageByRid } from './physical/records.js';
import { ViewSearch } from './search.js';
import { SnapshotCache, type SnapshotRead } from './snapshots.js';
import { viewStackCounts } from './view-rows.js';
import { viewRanges } from './view-ranges.js';
import { narrowView } from './view-where.js';
import { liveDeps, liveRead, LiveReads, readsLive, visibleLive } from '../sources/live.js';

const ViewParams = z.object({ viewId: ViewId });
const RecordParams = z.object({ tableId: TableId, recordId: RecordId });
const FieldParams = z.object({ fieldId: FieldId });
const notFound = () => new AppError('not_found', 'errors.notFound');

/**
 * Paging a view's rows, finding a record's position, finding text in a view, one record,
 * conversion previews, and downloading a view as a file.
 */
export async function readRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const snapshots = new SnapshotCache(() => dataStore(ctx), ctx.config.snapshotCacheMb ?? 256, app.log);
  ctx.data = snapshots;
  const live = new LiveReads(ctx, (ctx.config.snapshotCacheMb ?? 256) * 1024 * 1024, app.log);
  ctx.live = live;
  /** Reads a live table can't serve, since they need every record at hand. */
  const refuseLive = (read: SnapshotRead) => {
    if (readsLive(read.table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
  };
  const searches = new ViewSearch(() => dataStore(ctx), snapshots, ctx.config.dbQueryTimeoutMs);
  const sessionRoute = { config: { policy: { kind: 'session' as const } } };

  app.post('/api/fields/:fieldId/link-options', sessionRoute, async (request) => {
    const { fieldId } = parse(FieldParams, request.params);
    const input = parse(LinkChoicesRequest, request.body);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      // Eligibility and preview values must describe the same readable version of each record.
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return linkChoices(
        db,
        schemas,
        new AccessScope(db, schemas, requireActor(request)),
        fieldId,
        input,
        ctx,
      );
    });
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  /** A view's read for this person, narrowed for this read alone when a `where` token comes with it. */
  async function viewRead(
    scope: AccessScope,
    viewId: string,
    timeZone?: string,
    where?: string,
  ): Promise<SnapshotRead> {
    const { pool, schemas } = dataStore(ctx);
    const loaded = await loadView(pool, schemas, viewId);
    if (!loaded || loaded.trashed) throw notFound();
    await scope.require(loaded.databaseId, 'read');
    const [table, fields, context] = await Promise.all([
      loadTable(pool, schemas, loaded.view.tableId),
      loadFields(pool, schemas, [loaded.view.tableId]),
      snapshots.readContext(timeZone),
    ]);
    if (!table || table.trashed) throw notFound();
    await prepareJoinedRead(ctx, scope, table);
    const current = table.joined ? (await loadTable(pool, schemas, table.id))! : table;
    return {
      scope,
      table: current,
      view: narrowView(loaded.view, where),
      ...(where === undefined ? {} : { where }),
      fields: await sparklineFields(
        pool,
        schemas,
        scope,
        await resolveSelectOptions(pool, schemas, scope, scope.visibleFields(table.id, fields)),
        loaded.view.config.sparklines,
      ),
      predicate: scope.recordPredicate(table.id),
      access: scope.accessKey(table.id),
      context,
      values: {
        schemas,
        read: context,
        tableId: table.id,
        visible: (field) => scope.visibleFields(field.tableId, [field]).length > 0,
        recordPredicate: (tableId, alias) =>
          alias ? scope.linkedPredicate(tableId, alias) : scope.recordPredicate(tableId),
      },
    };
  }

  app.get('/api/tables/:tableId/sync-history', sessionRoute, async (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { cursor } = parse(z.object({ cursor: z.string().max(1000).optional() }), request.query);
    const { pool, schemas } = dataStore(ctx);
    return syncHistory(pool, schemas, new AccessScope(pool, schemas, requireActor(request)), tableId, cursor);
  });

  app.get('/api/views/:viewId/rows', sessionRoute, async (request) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(RowsQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const read = await viewRead(scope, viewId, input.tz, input.where);
    if (readsLive(read.table)) {
      if (input.stack !== undefined || input.from !== undefined || input.to !== undefined)
        throw new AppError('validation_failed', 'sources.live.viewUnsupported');
      const page = await live.page(await liveRead(ctx, read, scope), input);
      await decorateRecordLocks(pool, schemas, scope, read.table.id, page.rows, read.table);
      return page;
    }
    const page = await snapshots.page(read, input);
    await decorateRecordLocks(pool, schemas, scope, read.table.id, page.rows, read.table);
    return page;
  });

  app.get('/api/views/:viewId/export', sessionRoute, async (request, reply) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(ExportQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const read = await viewRead(scope, viewId, input.timeZone, input.where);
    return exportView(reply, {
      pool,
      schemas,
      scope,
      snapshots,
      read,
      query: input,
      files: ctx.config,
      // Which view went out, as what, and how many records: never a value.
      audit: (records) =>
        auditEvent(pool, authDatabase(ctx).audit, 'databases.view.downloaded', actor, {
          databaseId: read.table.databaseId,
          tableId: read.table.id,
          viewId,
          format: input.format,
          records,
        }),
      ...(readsLive(read.table) ? { live: async () => live.order(await liveRead(ctx, read, scope)) } : {}),
    });
  });

  app.get('/api/views/:viewId/stacks', sessionRoute, async (request) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(RowsQuery.pick({ tz: true }), request.query);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const read = await viewRead(scope, viewId, input.tz);
    refuseLive(read);
    return viewStackCounts(pool, schemas, read);
  });

  app.get('/api/views/:viewId/ranges', sessionRoute, async (request) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(ViewRangesQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const read = await viewRead(scope, viewId, input.tz, input.where);
    refuseLive(read);
    return viewRanges(pool, schemas, read, input.fields);
  });

  app.get('/api/views/:viewId/position', sessionRoute, async (request) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(PositionQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const read = await viewRead(scope, viewId, input.tz, input.where);
    if (readsLive(read.table)) return live.position(await liveRead(ctx, read, scope), input);
    return snapshots.position(read, input);
  });

  app.post('/api/views/:viewId/search', sessionRoute, async (request) => {
    const { viewId } = parse(ViewParams, request.params);
    const input = parse(ViewSearchRequest, request.body);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const read = await viewRead(scope, viewId, input.tz, input.where);
    refuseLive(read);
    return searches.search(read, input);
  });

  app.get('/api/tables/:tableId/records/search', sessionRoute, async (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(
      z.object({
        q: z.string().max(100_000).default(''),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
      request.query,
    );
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'read');
    await prepareJoinedRead(ctx, scope, table);
    if (readsLive(table)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
    // The primary field as the person sees it: a name read through links counts only records
    // they may see.
    const primary = scope
      .visibleFields(tableId, await loadFields(pool, schemas, [tableId]))
      .find((field) => field.id === table.primaryFieldId);
    if (!primary) throw notFound();
    const name = displayExpr(primary);
    const result = await query<{ id: string; name: string }>(
      pool,
      sql`
      SELECT __id AS id, ${name} AS name FROM ${ident(schemas.data, tableId)}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)})
        AND strpos(lower(${name}), lower(${input.q})) > 0
      ORDER BY __updated_at DESC, __rid DESC LIMIT ${input.limit}`,
    );
    return result.rows;
  });

  // Names for linked records the client hasn't read, such as links the server just made.
  app.post('/api/tables/:tableId/records/names', sessionRoute, async (request): Promise<RecordNames> => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(RecordNamesRequest, request.body);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'read');
    await prepareJoinedRead(ctx, scope, table);
    const primary = scope
      .visibleFields(tableId, await loadFields(pool, schemas, [tableId]))
      .find((field) => field.id === table.primaryFieldId);
    if (!primary) throw notFound();
    const result = await query<{ id: string; name: string | null }>(
      pool,
      sql`
      SELECT __id AS id, ${displayExpr(primary)} AS name FROM ${ident(schemas.data, tableId)}
      WHERE __id = ANY(${input.ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone
        AND (${scope.recordPredicate(tableId)})`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.id, row.name ?? '']));
  });

  app.post(
    '/api/tables/:tableId/records/history',
    sessionRoute,
    async (request): Promise<RecordHistoryCells> => {
      const { tableId } = parse(z.object({ tableId: TableId }), request.params);
      const input = parse(RecordHistoryCellsRequest, request.body);
      const { pool, schemas } = dataStore(ctx);
      const scope = new AccessScope(pool, schemas, requireActor(request));
      const table = await loadTable(pool, schemas, tableId);
      if (!table || table.trashed) throw notFound();
      await scope.require(table.databaseId, 'read');
      await prepareJoinedRead(ctx, scope, table);
      const fields = scope
        .visibleFields(tableId, await loadFields(pool, schemas, [tableId]))
        .filter((field) => field.type === 'changeLog' && input.fieldIds.includes(field.id));
      if (!fields.length) return [];
      if (readsLive(table) && scope.liveRules(tableId) !== null)
        scope.confirmLive(tableId, await visibleLive(liveDeps(ctx), table, scope, input.ids));
      const rids = await ridsForIds(pool, schemas.data, tableId, input.ids);
      const rows = await fetchPageByRid(
        pool,
        schemas.data,
        tableId,
        fields,
        [...rids.values()],
        scope.recordPredicate(tableId),
      );
      return rows.flatMap((row) => (row ? [{ id: row.id, values: row.values }] : []));
    },
  );

  /** One record as the person sees it, with the fields they can see, or not found. */
  async function recordRead(
    scope: AccessScope,
    tableId: string,
    recordId: string,
  ): Promise<{ table: StoredTable; fields: StoredField[]; row: RowData }> {
    const { pool, schemas } = dataStore(ctx);
    const table = await loadTable(pool, schemas, tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'read');
    await prepareJoinedRead(ctx, scope, table);
    if (readsLive(table)) {
      const fields = await loadFields(pool, schemas, [tableId]);
      const views = await loadViews(pool, schemas, [tableId]);
      const visible = await sparklineFields(
        pool,
        schemas,
        scope,
        await resolveSelectOptions(pool, schemas, scope, scope.visibleFields(tableId, fields)),
        views.flatMap((view) => view.config.sparklines),
      );
      const row = await live.record(
        {
          table,
          fields: visible,
          allFields: fields,
          predicate: sql`TRUE`,
          access: scope.accessKey(tableId),
          context: await snapshots.readContext(),
          rules: scope.liveRules(tableId),
          scope,
        },
        recordId,
      );
      if (!row) throw notFound();
      const rows = [row];
      await decorateRecordLocks(pool, schemas, scope, tableId, rows);
      return { table, fields: visible, row: rows[0]! };
    }
    const [fields, rids] = await Promise.all([
      loadFields(pool, schemas, [tableId]),
      ridsForIds(pool, schemas.data, tableId, [recordId]),
    ]);
    const rid = rids.get(recordId);
    if (rid === undefined) throw notFound();
    const views = await loadViews(pool, schemas, [tableId]);
    const visible = await sparklineFields(
      pool,
      schemas,
      scope,
      await resolveSelectOptions(pool, schemas, scope, scope.visibleFields(tableId, fields)),
      views.flatMap((view) => view.config.sparklines),
    );
    const [row] = await fetchPageByRid(
      pool,
      schemas.data,
      tableId,
      visible,
      [rid],
      scope.recordPredicate(tableId),
    );
    if (!row) throw notFound();
    const rows = [row];
    await decorateRecordLocks(pool, schemas, scope, tableId, rows);
    return { table, fields: visible, row: rows[0]! };
  }

  app.get('/api/tables/:tableId/records/:recordId', sessionRoute, async (request) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const { fields, row } = await recordRead(scope, tableId, recordId);
    const attachments = await rowAttachments(pool, schemas.app, tableId, fields, [row]);
    return Object.keys(attachments).length ? { ...row, attachments } : row;
  });

  // One record as a Word document, read exactly as the record route reads it.
  app.get('/api/tables/:tableId/records/:recordId/export', sessionRoute, async (request, reply) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const input = parse(RecordExportQuery, request.query);
    checkFormat(input);
    const { pool, schemas } = dataStore(ctx);
    const actor = requireActor(request);
    const scope = new AccessScope(pool, schemas, actor);
    const { table, fields, row } = await recordRead(scope, tableId, recordId);
    const { bytes, title } = await recordWord({
      pool,
      schemas,
      scope,
      table,
      fields,
      row,
      locale: input.locale,
      timeZone: input.timeZone,
      comments: input.comments,
      files: ctx.config,
      now: new Date(),
    });
    await auditEvent(pool, authDatabase(ctx).audit, 'databases.record.downloaded', actor, {
      databaseId: table.databaseId,
      tableId,
      recordId,
      format: input.format,
      comments: input.comments,
    });
    const type = EXPORT_TYPES[input.format];
    reply.header('content-type', type);
    reply.header('content-disposition', disposition(type, exportFileName(table.name, title, input.format)));
    reply.header('x-content-type-options', 'nosniff');
    // The Word export uses an explicit Office type, attachment disposition, and nosniff.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(bytes);
  });

  app.get('/api/fields/:fieldId/select-options', sessionRoute, async (request) => {
    const { fieldId } = parse(FieldParams, request.params);
    const { search, ids, names } = parse(
      z.object({
        search: z.string().max(255).optional(),
        names: z
          .string()
          .max(18000)
          .transform((value) => {
            try {
              return JSON.parse(value) as unknown;
            } catch {
              return null;
            }
          })
          .pipe(z.array(z.string().max(255)).max(50))
          .optional(),
        ids: z
          .string()
          .max(18000)
          .transform((value) => value.split(','))
          .pipe(z.array(ChoiceId).max(1000))
          .optional(),
      }),
      request.query,
    );
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const field = await loadField(pool, schemas, fieldId);
    if (!field || field.trashed || !isSelect(field)) throw notFound();
    await scope.ensureTable(field.tableId);
    const table = await loadTable(pool, schemas, field.tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'read');
    if (!scope.visibleFields(table.id, [field]).length) throw notFound();
    return sourceOptionsPage(pool, schemas, scope, field, { search, ids, names });
  });

  app.post('/api/fields/:fieldId/conversion-preview', sessionRoute, async (request) => {
    const { fieldId } = parse(FieldParams, request.params);
    const input = parse(ConversionPreviewRequest, request.body);
    const { pool, schemas } = dataStore(ctx);
    const scope = new AccessScope(pool, schemas, requireActor(request));
    const field = await loadField(pool, schemas, fieldId);
    if (!field || field.trashed) throw notFound();
    const table = await loadTable(pool, schemas, field.tableId);
    if (!table || table.trashed) throw notFound();
    await scope.require(table.databaseId, 'editSchema');
    const visible = scope.visibleFields(table.id, [field]);
    if (!visible.length) throw notFound();
    if (scope.limitsRecords(table.id)) throw new AppError('forbidden', 'data.access.recordHidden');
    if (!canConvert(field.type, input.to.type))
      throw new AppError('validation_failed', 'data.field.cannotConvert');
    const collaborators =
      field.type === 'createdBy' ||
      field.type === 'lastModifiedBy' ||
      field.type === 'user' ||
      input.to.type === 'user'
        ? await loadCollaborators(pool, schemas, table.orgId, scope)
        : [];
    let linkedPrimary: Awaited<ReturnType<typeof primaryField>> | undefined;
    let linkedPredicate: Sql | undefined;
    if (input.to.type === 'link') {
      const target = await loadTable(pool, schemas, input.to.options.linkedTableId);
      if (!target || target.trashed || target.orgId !== table.orgId) throw notFound();
      await scope.require(target.databaseId, 'read');
      linkedPrimary = scope.visibleFields(target.id, [await primaryField(pool, schemas, target.id)])[0];
      if (!linkedPrimary) throw notFound();
      linkedPredicate = scope.recordPredicate(target.id, 'target');
    }
    if (
      isSelect(field) &&
      field.options.source &&
      (!isSelect(input.to) || input.to.options.source?.tableId !== field.options.source.tableId)
    )
      await conversionSourceChoices(pool, schemas, scope, field);
    const [from] = await resolveSelectOptions(pool, schemas, scope, visible);
    const to =
      isSelect(input.to) && input.to.options.source
        ? {
            ...input.to,
            options: {
              ...input.to.options,
              choices: await sourceChoices(
                pool,
                schemas,
                scope,
                { ...field, ...input.to },
                isSelect(from!) ? { names: from!.options.choices.map((choice) => choice.name) } : {},
              ),
            },
          }
        : input.to;
    return previewConversion(pool, schemas.data, table.id, from!, to, {
      appSchema: schemas.app,
      linkedPrimary,
      linkedPredicate,
      dateOrder: input.dateOrder,
      timeZone: input.timeZone,
      userNames: new Map(collaborators.map((person) => [person.id, person.name])),
      userEmails: new Map(collaborators.map((person) => [person.id, person.email])),
    });
  });
}
