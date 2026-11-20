import { ColumnSuggestionsRequest } from '@riosoma/contracts';
import { readColumnSuggestions, configureJoinedColumns } from '../data/joined-api.js';
import { tableCopyJob, cancelTableCopy, CopyJobParams } from '../data/duplicate-jobs.js';
import { duplicateAction } from './duplicates.js';
import { DuplicateRecords, DuplicateField, DuplicateTable } from '@riosoma/contracts';
import {
  NamedFunctionInput,
  NamedFunctionId,
  NamedFunctionUpdate,
  NamedFunctionDelete,
} from '@riosoma/contracts';
import {
  listNamedFunctions,
  createNamedFunction,
  updateNamedFunction,
  deleteNamedFunction,
} from './schema.js';
import { GridArrangementPatch, ViewId } from '@riosoma/contracts';
import { arrangeGrid } from '../data/grid-arrangements.js';
import { runHomeCommand } from '../data/commands/home.js';
import { TableCreate, JoinedTable, JoinedColumnsRequest, FieldId } from '@riosoma/contracts';
import { CommentCreate } from '@riosoma/contracts';
import { createComment } from '../data/comment-api.js';
import { readComments } from '../data/comment-routes.js';
import { readRecordHistory } from '../data/history.js';
import { clearPins, configureOverrides, createJoinedTable, readSyncHistory } from '../data/joined-api.js';
import { MemoryInput, SimilarQuery, WebQuery } from '@riosoma/contracts';
import { randomUUID } from 'node:crypto';
import { memories } from '../data/knowledge.js';
import { runKnowledgeCommand } from '../data/commands/knowledge.js';
import { similarRecords } from '../data/embeddings.js';
import { searchWeb } from '../ai/knowledge-calls.js';
import { listHome } from '../data/folders.js';
import { listDatabases } from '../data/routes.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  DatabaseId,
  TableId,
  RecordId,
  RecordsMove,
  SchemaFieldCreate,
  SchemaFieldUpdate,
  SchemaTableCreate,
  SchemaTableUpdate,
  SchemaViewCreate,
  SchemaViewUpdate,
  type TokenScope,
} from '@riosoma/contracts';
import { z } from 'zod';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { apiV1Headers } from './headers.js';
import { openapi } from './openapi.js';
import { RecordReader, recordsQuery } from './reads.js';
import { moveRecords, setLocks, writeRecords } from './writes.js';
import {
  createField,
  createTable,
  createView,
  readTables,
  readViews,
  trashField,
  trashTable,
  trashView,
  updateField,
  updateTable,
  updateView,
  withChoices,
} from './schema.js';

export async function apiV1Routes(app: FastifyInstance): Promise<void> {
  const policy = (scope: TokenScope) => ({ config: { policy: { kind: 'token' as const, scope } } });
  const reader = new RecordReader(app);
  app.get('/api/v1/duplicate-jobs/:jobId', policy('schema.bases:read'), (request) =>
    tableCopyJob(app, requireActor(request), parse(CopyJobParams, request.params).jobId),
  );
  app.post('/api/v1/duplicate-jobs/:jobId/cancel', policy('schema.bases:write'), (request) =>
    cancelTableCopy(app, requireActor(request), parse(CopyJobParams, request.params).jobId),
  );
  app.post(
    '/api/v1/tables/:tableId/records/duplicate',
    policy('data.records:write'),
    async (request, reply) => {
      const { tableId } = parse(z.object({ tableId: TableId }), request.params);
      const result = await duplicateAction(app, requireActor(request), {
        kind: 'record.duplicate',
        tableId,
        ...parse(DuplicateRecords, request.body),
      });
      reply.header('x-undo-group-id', result.undoGroupId);
      return result;
    },
  );
  app.post('/api/v1/fields/:fieldId/duplicate', policy('schema.bases:write'), async (request, reply) => {
    const { fieldId } = parse(z.object({ fieldId: FieldId }), request.params);
    const result = await duplicateAction(app, requireActor(request), {
      kind: 'field.duplicate',
      fieldId,
      ...parse(DuplicateField, request.body),
    });
    reply.header('x-undo-group-id', result.undoGroupId);
    return result;
  });
  app.post('/api/v1/tables/:tableId/duplicate', policy('schema.bases:write'), async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const result = await duplicateAction(app, requireActor(request), {
      kind: 'table.duplicate',
      tableId,
      ...parse(DuplicateTable, request.body),
    });
    reply.header('x-undo-group-id', result.undoGroupId);
    return result;
  });
  app.patch('/api/v1/views/:viewId/grid', policy('schema.bases:write'), (request) => {
    const { viewId } = parse(z.object({ viewId: ViewId }), request.params);
    return arrangeGrid(app, requireActor(request), viewId, {
      config: parse(GridArrangementPatch, request.body),
    });
  });
  app.post('/api/v1/knowledge/similar', policy('data.records:read'), (request) =>
    similarRecords(app, request, parse(SimilarQuery, request.body)),
  );
  app.post('/api/v1/knowledge/search', policy('data.records:read'), (request) =>
    searchWeb(app.ctx, requireActor(request), parse(WebQuery, request.body)),
  );
  app.get('/api/v1/databases/:databaseId/memories', policy('data.records:read'), (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return memories(app.ctx, requireActor(request), databaseId);
  });
  app.post('/api/v1/knowledge/memories', policy('data.records:write'), (request) =>
    runKnowledgeCommand(app, requireActor(request), {
      ...parse(MemoryInput.extend({ id: z.string().uuid().optional() }), request.body),
      kind: 'memory.save',
      id: (request.body as { id?: string }).id ?? randomUUID(),
    }),
  );
  app.addHook('onSend', apiV1Headers(app));
  app.get('/api/v1/openapi.json', { config: { policy: { kind: 'public' } } }, async () => openapi());
  app.post('/api/v1/home/commands', policy('schema.bases:write'), (request) =>
    runHomeCommand(app, requireActor(request), request.body),
  );
  app.get('/api/v1/home', policy('schema.bases:read'), (request) => listHome(app.ctx, requireActor(request)));
  app.get('/api/v1/databases', policy('schema.bases:read'), async (request) => {
    return { databases: await listDatabases(app.ctx, requireActor(request)) };
  });
  app.get('/api/v1/databases/:databaseId/tables', policy('schema.bases:read'), (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return readTables(app, requireActor(request), databaseId);
  });
  app.get('/api/v1/tables/:tableId/views', policy('schema.bases:read'), (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return readViews(app, requireActor(request), tableId);
  });
  // Schema writes answer with their undo group in the body and the header, as record writes do.
  const write = policy('schema.bases:write');
  const changed = <T extends { undoGroupId: string }>(reply: FastifyReply, result: T) => {
    reply.header('x-undo-group-id', result.undoGroupId);
    return result;
  };
  const functionPath = z.object({ databaseId: DatabaseId, functionId: NamedFunctionId });
  app.get('/api/v1/databases/:databaseId/named-functions', policy('schema.bases:read'), (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return listNamedFunctions(app, requireActor(request), databaseId);
  });
  app.post('/api/v1/databases/:databaseId/named-functions', write, async (request, reply) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return changed(
      reply,
      await createNamedFunction(
        app,
        requireActor(request),
        databaseId,
        parse(NamedFunctionInput, request.body),
      ),
    );
  });
  app.patch('/api/v1/databases/:databaseId/named-functions/:functionId', write, async (request, reply) => {
    const { databaseId, functionId } = parse(functionPath, request.params);
    return changed(
      reply,
      await updateNamedFunction(
        app,
        requireActor(request),
        databaseId,
        functionId,
        parse(NamedFunctionUpdate, request.body),
      ),
    );
  });
  app.delete('/api/v1/databases/:databaseId/named-functions/:functionId', write, async (request, reply) => {
    const { databaseId, functionId } = parse(functionPath, request.params);
    return changed(
      reply,
      await deleteNamedFunction(
        app,
        requireActor(request),
        databaseId,
        functionId,
        parse(NamedFunctionDelete, request.body),
      ),
    );
  });
  const choices = (body: unknown) =>
    body && typeof body === 'object' && 'options' in body
      ? { ...body, options: withChoices(body.options) }
      : body;
  app.post('/api/v1/databases/:databaseId/tables', write, async (request, reply) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    const body = request.body as { fields?: unknown };
    const input = parse(SchemaTableCreate, {
      ...body,
      ...(Array.isArray(body?.fields) ? { fields: body.fields.map(choices) } : {}),
    });
    return changed(reply, await createTable(app, requireActor(request), databaseId, input));
  });
  app.patch('/api/v1/tables/:tableId', write, async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(SchemaTableUpdate, request.body);
    return changed(reply, await updateTable(app, requireActor(request), tableId, input));
  });
  app.delete('/api/v1/tables/:tableId', write, async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return changed(reply, await trashTable(app, requireActor(request), tableId));
  });
  app.post('/api/v1/tables/:tableId/fields', write, async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(SchemaFieldCreate, choices(request.body));
    return changed(reply, await createField(app, requireActor(request), tableId, input));
  });
  app.patch('/api/v1/fields/:fieldId', write, async (request, reply) => {
    const { fieldId } = parse(z.object({ fieldId: FieldId }), request.params);
    const input = parse(SchemaFieldUpdate, request.body);
    return changed(reply, await updateField(app, requireActor(request), fieldId, input));
  });
  app.delete('/api/v1/fields/:fieldId', write, async (request, reply) => {
    const { fieldId } = parse(z.object({ fieldId: FieldId }), request.params);
    return changed(reply, await trashField(app, requireActor(request), fieldId));
  });
  app.post('/api/v1/tables/:tableId/views', write, async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(SchemaViewCreate, request.body);
    return changed(reply, await createView(app, requireActor(request), tableId, input));
  });
  app.patch('/api/v1/views/:viewId', write, async (request, reply) => {
    const { viewId } = parse(z.object({ viewId: ViewId }), request.params);
    const input = parse(SchemaViewUpdate, request.body);
    return changed(reply, await updateView(app, requireActor(request), viewId, input));
  });
  app.delete('/api/v1/views/:viewId', write, async (request, reply) => {
    const { viewId } = parse(z.object({ viewId: ViewId }), request.params);
    return changed(reply, await trashView(app, requireActor(request), viewId));
  });
  app.get('/api/v1/tables/:tableId/sync-history', policy('data.records:read'), (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { cursor } = parse(z.object({ cursor: z.string().max(1000).optional() }), request.query);
    return readSyncHistory(app.ctx, requireActor(request), tableId, cursor);
  });
  app.post('/api/v1/tables/:tableId/records/:recordId/comments', policy('data.records:write'), (request) => {
    const { tableId, recordId } = parse(z.object({ tableId: TableId, recordId: RecordId }), request.params);
    return createComment(app, requireActor(request), tableId, recordId, parse(CommentCreate, request.body));
  });
  app.get('/api/v1/tables/:tableId/records/:recordId/comments', policy('data.records:read'), (request) => {
    const { tableId, recordId } = parse(z.object({ tableId: TableId, recordId: RecordId }), request.params);
    return readComments(app.ctx, requireActor(request), tableId, [recordId], true);
  });
  app.get('/api/v1/tables/:tableId/records/:recordId/history', policy('data.records:read'), (request) => {
    const { tableId, recordId } = parse(z.object({ tableId: TableId, recordId: RecordId }), request.params);
    const { cursor } = parse(z.object({ cursor: z.string().max(1000).optional() }), request.query);
    return readRecordHistory(app.ctx, requireActor(request), tableId, recordId, cursor);
  });
  app.post('/api/v1/databases/:databaseId/column-suggestions', policy('schema.bases:write'), (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return readColumnSuggestions(
      app.ctx,
      requireActor(request),
      databaseId,
      parse(ColumnSuggestionsRequest, request.body),
    );
  });
  app.patch('/api/v1/tables/:tableId/joined-columns', policy('schema.bases:write'), (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { joinedFields, ...joined } = parse(JoinedColumnsRequest, request.body);
    return configureJoinedColumns(app, requireActor(request), tableId, joined, joinedFields);
  });
  app.post('/api/v1/databases/:databaseId/joined-tables', policy('schema.bases:write'), (request) => {
    const { databaseId } = parse(z.object({ databaseId: DatabaseId }), request.params);
    return createJoinedTable(
      app,
      requireActor(request),
      databaseId,
      parse(TableCreate.extend({ joined: JoinedTable }), request.body),
    );
  });
  app.patch('/api/v1/tables/:tableId/overrides', policy('schema.bases:write'), (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const settings = parse(
      z.object({
        allowComputedOverrides: z.boolean().optional(),
        historyRetentionDays: z.number().int().min(1).max(3650).optional(),
      }),
      request.body,
    );
    return configureOverrides(app, requireActor(request), tableId, settings);
  });
  app.post('/api/v1/tables/:tableId/clear-overrides', policy('data.records:write'), (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { records } = parse(
      z.object({
        records: z
          .array(z.object({ id: RecordId, fieldIds: z.array(FieldId).min(1).max(100) }))
          .min(1)
          .max(100),
      }),
      request.body,
    );
    return clearPins(app, requireActor(request), tableId, records);
  });
  app.get('/api/v1/tables/:tableId/records', policy('data.records:read'), async (request) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    return reader.read(request, tableId, recordsQuery(request.query));
  });
  app.get('/api/v1/tables/:tableId/records/:recordId', policy('data.records:read'), async (request) => {
    const { tableId, recordId } = parse(z.object({ tableId: TableId, recordId: RecordId }), request.params);
    return reader.read(request, tableId, recordsQuery(request.query), recordId);
  });
  app.post('/api/v1/tables/:tableId/records/move', policy('data.records:write'), async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const result = await moveRecords(app, request, tableId, parse(RecordsMove, request.body));
    reply.header('x-undo-group-id', result.undoGroupId);
    return result;
  });
  app.put('/api/v1/tables/:tableId/records/locks', policy('data.records:write'), async (request, reply) => {
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(
      z.object({
        recordIds: z.array(RecordId).min(1).max(100),
        locked: z.boolean(),
        reason: z.string().trim().max(1000).default(''),
      }),
      request.body,
    );
    const result = await setLocks(app, request, tableId, input.recordIds, input.locked, input.reason);
    reply.header('x-undo-group-id', result.undoGroupId);
    return result;
  });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const)
    app.route({
      method,
      url: '/api/v1/tables/:tableId/records',
      ...policy('data.records:write'),
      handler: async (request, reply) => {
        const { tableId } = parse(z.object({ tableId: TableId }), request.params);
        return writeRecords(app, request, reply, tableId, recordsQuery(request.query));
      },
    });
}
