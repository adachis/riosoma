import { ColumnSuggestionsRequest } from '@riosoma/contracts';
import { AccountSessions, EndSessions } from '@riosoma/contracts';
import { DuplicateRecords, DuplicateField, DuplicateTable } from '@riosoma/contracts';
import {
  NamedFunctionInput,
  NamedFunctionId,
  NamedFunctionMeta,
  NamedFunctionUpdate,
  NamedFunctionDelete,
  NamedFunctionResult,
} from '@riosoma/contracts';
import { CommentCreate, CommentId, RecordCommentSchema } from '@riosoma/contracts';
import { GridArrangementPatch } from '@riosoma/contracts';
import { DocumentImportRequest, DocumentImportResult } from '@riosoma/contracts';
import { HomeCommand } from '@riosoma/contracts';
import { SearchKnowledge, LibraryCommand } from '@riosoma/contracts';
import {
  TableCreate,
  JoinedTable,
  JoinedColumnsRequest,
  FieldId,
  SyncStats,
  CommandResult,
} from '@riosoma/contracts';
import { MemoryInput, SimilarQuery, WebQuery } from '@riosoma/contracts';
import {
  SchemaFieldCreate,
  SchemaFieldUpdate,
  SchemaTableCreate,
  SchemaTableUpdate,
  SchemaViewCreate,
  SchemaViewUpdate,
  HomeListing,
  RecordsQuery,
  AttachmentMeta,
  ErrorBody,
  RecordsWrite,
  RecordsMove,
  ViewId,
  TokenCreate,
  TokenScope,
  TableId,
  RecordId,
  DatabaseId,
  DatabaseSummary,
  TableMeta,
  FieldMeta,
  ViewMeta,
  TextMergeNotice,
  WebhookCreate,
  WebhookCreated,
  WebhookDeliveriesPage,
  WebhookDelivery,
  WebhookDeliveryId,
  WebhookId,
  WebhookList,
  WebhookMeta,
  WebhookPayload,
  WebhookSecret,
  WebhookUpdate,
} from '@riosoma/contracts';
import { DashboardConfig, DashboardDataRequest, TileRecordsRequest } from '@riosoma/contracts';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { message } from './messages.js';
import { MCP_SCOPES } from '../authorization/store.js';

/** Generated recursive references must point at their component after embedding the schema. */
function relocate(value: unknown, base: string): unknown {
  if (Array.isArray(value)) return value.map((item) => relocate(item, base));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string' && child.startsWith('#')
        ? base + child.slice(1)
        : relocate(child, base),
    ]),
  );
}

export function openapi() {
  const schemas: Record<string, unknown> = {};
  const component = (name: string, contract: z.ZodType, io: 'input' | 'output' = 'input') => {
    const $ref = `#/components/schemas/${name}`;
    schemas[name] = relocate(z.toJSONSchema(contract, { target: 'draft-2020-12', io }), $ref);
    return { $ref };
  };
  const fields = z.record(z.string(), z.unknown());
  const next = z.string().nullable();
  const textMerges = z.array(TextMergeNotice).optional();
  const keyed = component(
    'KeyedRecords',
    z.object({ records: z.record(z.string(), fields), order: z.array(RecordId), next, textMerges }),
  );
  const list = component(
    'ListRecords',
    z.object({ records: z.array(z.object({ id: RecordId }).catchall(z.unknown())), next, textMerges }),
  );
  const airtable = component(
    'AirtableRecords',
    z.object({
      records: z.array(z.object({ id: RecordId, createdTime: z.string(), fields })),
      offset: z.string().optional(),
      textMerges,
    }),
    'output',
  );
  schemas.Records = { oneOf: [keyed, list, airtable] };
  component('DashboardConfig', DashboardConfig);
  component('DashboardDataRequest', DashboardDataRequest);
  component('TileRecordsRequest', TileRecordsRequest);
  component('RecordsQuery', RecordsQuery);
  const write = component('RecordsWrite', RecordsWrite);
  const tokenCreate = component('TokenCreate', TokenCreate);
  const tokenMeta = z.object({
    id: z.string(),
    name: z.string(),
    scopes: z.array(TokenScope),
    databases: z.union([z.literal('all'), z.array(DatabaseId)]),
    createdAt: z.string(),
    lastUsedAt: next,
    expiresAt: next,
  });
  const tokens = component('Tokens', z.array(tokenMeta));
  const created = component('TokenCreated', tokenMeta.extend({ token: z.string() }));
  const home = component('Home', HomeListing, 'output');
  const databases = component('Databases', z.object({ databases: z.array(DatabaseSummary) }), 'output');
  const tableWithSchema = TableMeta.safeExtend({ fields: z.array(FieldMeta), views: z.array(ViewMeta) });
  const tables = component('Tables', z.object({ tables: z.array(tableWithSchema) }), 'output');
  const error = component(
    'Error',
    z.object({ error: ErrorBody.shape.error.omit({ userFault: true }).extend({ message: z.string() }) }),
  );
  const parameters = Object.entries(RecordsQuery.shape).map(([name, contract]) => ({
    name,
    in: 'query',
    required: false,
    ...(['filter', 'sort'].includes(name)
      ? { content: { 'application/json': { schema: component(`Query_${name}`, contract) } } }
      : {
          schema: component(`Query_${name}`, contract),
          ...(name === 'fields' ? { style: 'form', explode: true } : {}),
        }),
  }));
  const path = (name: string, contract: z.ZodType) => ({
    name,
    in: 'path',
    required: true,
    schema: component(`Path_${name}`, contract),
  });
  const response = (schema: unknown) => ({
    description: message('api.response.success'),
    content: { 'application/json': { schema } },
  });
  const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
  // Record writes answer with the undo group they made.  `undo: false` marks a write that makes
  // none, like staging an upload.
  const operation = (
    scope: string,
    params: unknown[],
    result: unknown = { $ref: '#/components/schemas/Records' },
    requestBody?: unknown,
    { undo = scope === 'data.records:write' }: { undo?: boolean } = {},
  ) => ({
    security: [{ personalToken: [] }],
    'x-required-scope': scope,
    parameters: params,
    ...(requestBody ? { requestBody: body(requestBody) } : {}),
    responses: {
      '200': {
        ...response(result),
        ...(undo
          ? {
              headers: {
                'x-undo-group-id': { schema: { type: 'string' }, description: message('api.undoGroup') },
              },
            }
          : {}),
      },
      default: {
        description: message('errors.badRequest'),
        content: { 'application/json': { schema: error } },
      },
    },
  });
  const records = [path('tableId', TableId), ...parameters];
  const hooks = 'schema.bases:write';
  const webhook = [path('databaseId', DatabaseId), path('webhookId', WebhookId)];
  const webhookResult = component('Webhook', WebhookMeta, 'output');
  // What each call to a webhook's address carries.  No route returns it, but receivers need it.
  component('WebhookPayload', WebhookPayload, 'output');
  const { responses: removed, ...removal } = operation(hooks, webhook);
  const csrf = { name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' } };
  const cursor = { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } };
  const commandResult = component('CommandBatch', z.object({ results: z.array(CommandResult) }));
  const syncHistory = component(
    'SyncHistory',
    z.object({
      runs: z.array(
        z.object({
          id: z.string(),
          tableId: TableId,
          startedAt: z.string(),
          endedAt: z.string().nullable(),
          outcome: z.enum(['running', 'succeeded', 'held', 'failed', 'canceled']),
          stats: SyncStats.nullable(),
          errorKey: z.string().nullable(),
        }),
      ),
      next: z.string().nullable(),
    }),
  );
  const recordHistory = component(
    'RecordHistory',
    z.object({
      entries: z.array(
        z.object({
          seq: z.number(),
          at: z.string(),
          actorId: z.string().nullable(),
          kind: z.enum(['created', 'updated', 'trashed', 'restored', 'synced']),
          changes: z.array(z.object({ fieldId: FieldId, before: z.unknown(), after: z.unknown() })),
          overrides: z.array(z.object({ fieldId: FieldId, set: z.boolean() })).optional(),
        }),
      ),
      next: z.string().nullable(),
    }),
  );
  // Schema writes answer with what they changed, or null when the token's owner can't see it.
  const schemaWrite = (params: unknown[], name: string, result: z.ZodType, input: [string, z.ZodType]) =>
    operation(
      'schema.bases:write',
      params,
      component(
        `${name}Change`,
        z.object({ [name.toLowerCase()]: result, undoGroupId: z.string() }),
        'output',
      ),
      component(...input),
      { undo: true },
    );
  const trashed = (params: unknown[]) =>
    operation(
      'schema.bases:write',
      params,
      component('Trashed', z.object({ id: z.string(), undoGroupId: z.string() }), 'output'),
      undefined,
      { undo: true },
    );
  const tableParam = [path('tableId', TableId)];
  const fieldParam = [path('fieldId', FieldId)];
  const viewParam = [path('viewId', ViewId)];
  const copyJob = component(
    'TableCopyJob',
    z.object({
      id: z.string(),
      state: z.enum(['running', 'finished', 'failed', 'canceled']),
      copied: z.number(),
      total: z.number(),
      result: CommandResult.nullable(),
    }),
    'output',
  );
  const paths = {
    '/api/me/sessions': {
      get: {
        security: [{ session: [] }],
        responses: { '200': response(component('AccountSessions', AccountSessions, 'output')) },
      },
    },
    '/api/me/sessions/end': {
      post: {
        security: [{ session: [] }],
        parameters: [csrf],
        requestBody: body(component('EndSessions', EndSessions)),
        responses: { '204': { description: message('api.response.success') } },
      },
    },
    '/api/v1/tables/{tableId}/records/duplicate': {
      post: operation(
        'data.records:write',
        tableParam,
        component(
          'DuplicatedRecords',
          z.object({ recordIds: z.array(RecordId), undoGroupId: z.string() }),
          'output',
        ),
        component('DuplicateRecords', DuplicateRecords),
        { undo: true },
      ),
    },
    '/api/v1/fields/{fieldId}/duplicate': {
      post: operation(
        'schema.bases:write',
        fieldParam,
        component('DuplicatedField', z.object({ fieldId: FieldId, undoGroupId: z.string() }), 'output'),
        component('DuplicateField', DuplicateField),
        { undo: true },
      ),
    },
    '/api/v1/tables/{tableId}/duplicate': {
      post: operation(
        'schema.bases:write',
        tableParam,
        component(
          'DuplicatedTable',
          z.object({ tableId: TableId, jobId: z.string().optional(), undoGroupId: z.string() }),
          'output',
        ),
        component('DuplicateTable', DuplicateTable),
        { undo: true },
      ),
    },
    '/api/v1/duplicate-jobs/{jobId}': {
      get: operation('schema.bases:read', [path('jobId', z.string())], copyJob),
    },
    '/api/v1/duplicate-jobs/{jobId}/cancel': {
      post: operation('schema.bases:write', [path('jobId', z.string())], copyJob),
    },
    '/api/v1/databases/{databaseId}/named-functions': {
      get: operation(
        'schema.bases:read',
        [path('databaseId', DatabaseId)],
        component('NamedFunctions', z.object({ namedFunctions: z.array(NamedFunctionMeta) }), 'output'),
      ),
      post: operation(
        'schema.bases:write',
        [path('databaseId', DatabaseId)],
        component('NamedFunctionResult', NamedFunctionResult, 'output'),
        component('NamedFunctionInput', NamedFunctionInput),
        { undo: true },
      ),
    },
    '/api/v1/databases/{databaseId}/named-functions/{functionId}': {
      patch: operation(
        'schema.bases:write',
        [path('databaseId', DatabaseId), path('functionId', NamedFunctionId)],
        component('NamedFunctionResult', NamedFunctionResult, 'output'),
        component('NamedFunctionUpdate', NamedFunctionUpdate),
        { undo: true },
      ),
      delete: operation(
        'schema.bases:write',
        [path('databaseId', DatabaseId), path('functionId', NamedFunctionId)],
        component('NamedFunctionResult', NamedFunctionResult, 'output'),
        component('NamedFunctionDelete', NamedFunctionDelete),
        { undo: true },
      ),
    },

    '/api/v1/tables/{tableId}': {
      patch: schemaWrite(tableParam, 'Table', tableWithSchema.nullable(), ['TableUpdate', SchemaTableUpdate]),
      delete: trashed(tableParam),
    },
    '/api/v1/tables/{tableId}/fields': {
      post: schemaWrite(tableParam, 'Field', FieldMeta.nullable(), ['FieldCreate', SchemaFieldCreate]),
    },
    '/api/v1/fields/{fieldId}': {
      patch: schemaWrite(fieldParam, 'Field', FieldMeta.nullable(), ['FieldUpdate', SchemaFieldUpdate]),
      delete: trashed(fieldParam),
    },
    '/api/v1/views/{viewId}': {
      patch: schemaWrite(viewParam, 'View', ViewMeta.nullable(), ['ViewUpdate', SchemaViewUpdate]),
      delete: trashed(viewParam),
    },
    '/api/v1/views/{viewId}/grid': {
      patch: operation(
        'schema.bases:write',
        [path('viewId', ViewId)],
        commandResult,
        component('GridArrangementPatch', GridArrangementPatch),
      ),
    },
    '/api/v1/tables/{tableId}/sync-history': {
      get: operation('data.records:read', [path('tableId', TableId), cursor], syncHistory),
    },
    '/api/v1/tables/{tableId}/records/{recordId}/history': {
      get: operation(
        'data.records:read',
        [path('tableId', TableId), path('recordId', RecordId), cursor],
        recordHistory,
      ),
    },
    '/api/v1/databases/{databaseId}/column-suggestions': {
      post: operation(
        'schema.bases:write',
        [path('databaseId', DatabaseId)],
        component(
          'ColumnSuggestions',
          z.object({
            suggestions: z.array(
              z.object({
                sources: z.array(z.object({ tableId: TableId, fieldId: FieldId })),
                confidence: z.number(),
                explanation: z.string(),
                reason: z.object({
                  messageKey: z.string(),
                  params: z.object({ percent: z.number() }).optional(),
                }),
                matchingRows: z.number(),
                agreement: z.number(),
              }),
            ),
            profiledFields: z.number(),
            ms: z.number(),
          }),
        ),
        component('ColumnSuggestionsRequest', ColumnSuggestionsRequest),
      ),
    },
    '/api/v1/tables/{tableId}/joined-columns': {
      patch: operation(
        'schema.bases:write',
        [path('tableId', TableId)],
        commandResult,
        component('JoinedColumns', JoinedColumnsRequest),
      ),
    },
    '/api/v1/databases/{databaseId}/joined-tables': {
      post: operation(
        'schema.bases:write',
        [path('databaseId', DatabaseId)],
        commandResult,
        component('JoinedTableCreate', TableCreate.extend({ joined: JoinedTable })),
      ),
    },
    '/api/v1/tables/{tableId}/overrides': {
      patch: operation(
        'schema.bases:write',
        [path('tableId', TableId)],
        commandResult,
        component(
          'OverrideSettings',
          z.object({
            allowComputedOverrides: z.boolean().optional(),
            historyRetentionDays: z.number().int().min(1).max(3650).optional(),
          }),
        ),
      ),
    },
    '/api/v1/tables/{tableId}/clear-overrides': {
      post: operation(
        'data.records:write',
        [path('tableId', TableId)],
        commandResult,
        component(
          'ClearOverrides',
          z.object({
            records: z
              .array(z.object({ id: RecordId, fieldIds: z.array(FieldId).min(1).max(100) }))
              .min(1)
              .max(100),
          }),
        ),
      ),
    },
    '/api/v1/remote-tools': { get: operation('data.records:read', []) },
    '/api/v1/imports/document': {
      post: operation(
        'data.records:write',
        [],
        component('DocumentImportResult', DocumentImportResult),
        component('DocumentImportRequest', DocumentImportRequest),
        { undo: false },
      ),
    },
    '/api/v1/knowledge/libraries': { get: operation('data.records:read', []) },
    '/api/v1/knowledge/libraries/{libraryId}/documents': {
      get: operation('data.records:read', [path('libraryId', z.string().uuid())]),
    },
    '/api/v1/knowledge/search-documents': {
      post: operation('data.records:read', [], undefined, component('SearchKnowledge', SearchKnowledge)),
    },
    '/api/v1/knowledge/library-commands': {
      post: operation('data.records:write', [], undefined, component('LibraryCommand', LibraryCommand)),
    },
    '/api/v1/knowledge/similar': {
      post: operation('data.records:read', [], undefined, component('SimilarQuery', SimilarQuery)),
    },
    '/api/v1/knowledge/search': {
      post: operation('data.records:read', [], undefined, component('WebQuery', WebQuery)),
    },
    '/api/v1/knowledge/memories': {
      post: operation('data.records:write', [], undefined, component('MemoryInput', MemoryInput)),
    },
    '/api/v1/databases/{databaseId}/memories': {
      get: operation('data.records:read', [path('databaseId', DatabaseId)]),
    },
    '/api/v1/home/commands': {
      post: operation(
        'schema.bases:write',
        [],
        component(
          'HomeCommandResult',
          z.object({
            id: z.string(),
            status: z.enum(['applied', 'duplicate', 'rejected']),
            invitationLink: z.string().optional(),
          }),
        ),
        component('HomeCommand', HomeCommand),
      ),
    },
    '/api/v1/home': { get: operation('schema.bases:read', [], home) },
    '/api/v1/databases': { get: operation('schema.bases:read', [], databases) },
    '/api/v1/databases/{databaseId}/tables': {
      get: operation('schema.bases:read', [path('databaseId', DatabaseId)], tables),
      post: schemaWrite([path('databaseId', DatabaseId)], 'Table', tableWithSchema.nullable(), [
        'TableCreate',
        SchemaTableCreate,
      ]),
    },
    '/api/v1/tables/{tableId}/views': {
      get: operation(
        'schema.bases:read',
        [path('tableId', TableId)],
        component('Views', z.object({ views: z.array(ViewMeta) }), 'output'),
      ),
      post: schemaWrite(tableParam, 'View', ViewMeta.nullable(), ['ViewCreate', SchemaViewCreate]),
    },
    '/api/v1/tables/{tableId}/fields/{fieldId}/files': {
      post: {
        ...operation(
          'data.records:write',
          [
            path('tableId', TableId),
            path('fieldId', FieldId),
            { name: 'x-file-name', in: 'header', required: true, schema: { type: 'string' } },
          ],
          component('UploadedAttachment', AttachmentMeta, 'output'),
          undefined,
          { undo: false },
        ),
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } },
        },
      },
    },
    '/api/v1/tables/{tableId}/records': {
      get: operation('data.records:read', records),
      post: operation('data.records:write', records, undefined, write),
      patch: operation('data.records:write', records, undefined, write),
      put: operation('data.records:write', records, undefined, write),
      delete: operation('data.records:write', [
        ...records,
        {
          name: 'records',
          in: 'query',
          required: true,
          style: 'form',
          explode: true,
          schema: component('DeleteRecords', z.array(RecordId).min(1).max(1_000)),
        },
      ]),
    },
    '/api/v1/tables/{tableId}/records/move': {
      post: operation(
        'data.records:write',
        [path('tableId', TableId)],
        component(
          'RecordsMoveResult',
          z.object({ recordIds: z.array(RecordId), viewId: ViewId, undoGroupId: z.string() }),
        ),
        component('RecordsMove', RecordsMove),
      ),
    },
    '/api/v1/tables/{tableId}/records/locks': {
      put: operation(
        'data.records:write',
        [path('tableId', TableId)],
        component('RecordLocksResult', z.object({ recordIds: z.array(RecordId), locked: z.boolean() })),
        component(
          'RecordLocksWrite',
          z.object({
            recordIds: z.array(RecordId).min(1).max(100),
            locked: z.boolean(),
            reason: z.string().max(1000).default(''),
          }),
        ),
      ),
    },
    '/api/v1/tables/{tableId}/records/{recordId}': {
      get: operation('data.records:read', [...records, path('recordId', RecordId)]),
    },
    '/api/v1/databases/{databaseId}/webhooks': {
      get: operation(
        hooks,
        [path('databaseId', DatabaseId)],
        component('WebhookList', WebhookList, 'output'),
      ),
      post: operation(
        hooks,
        [path('databaseId', DatabaseId)],
        component('WebhookCreated', WebhookCreated, 'output'),
        component('WebhookCreate', WebhookCreate),
      ),
    },
    '/api/v1/databases/{databaseId}/webhooks/{webhookId}': {
      patch: operation(hooks, webhook, webhookResult, component('WebhookUpdate', WebhookUpdate)),
      delete: {
        ...removal,
        responses: { '204': { description: message('api.response.success') }, default: removed.default },
      },
    },
    '/api/v1/databases/{databaseId}/webhooks/{webhookId}/secret': {
      post: operation(hooks, webhook, component('WebhookSecret', WebhookSecret, 'output')),
    },
    '/api/v1/databases/{databaseId}/webhooks/{webhookId}/deliveries': {
      get: operation(
        hooks,
        [...webhook, { name: 'cursor', in: 'query', required: false, schema: { type: 'string' } }],
        component('WebhookDeliveries', WebhookDeliveriesPage, 'output'),
      ),
    },
    '/api/v1/databases/{databaseId}/webhooks/{webhookId}/deliveries/{deliveryId}/redeliver': {
      post: operation(
        hooks,
        [...webhook, path('deliveryId', WebhookDeliveryId)],
        component('WebhookDelivery', WebhookDelivery, 'output'),
      ),
    },
    '/api/v1/tables/{tableId}/records/{recordId}/comments': {
      get: operation(
        'data.records:read',
        [path('tableId', TableId), path('recordId', RecordId)],
        component('CommentsPage', z.object({ comments: z.array(RecordCommentSchema) }), 'output'),
      ),
      post: operation(
        'data.records:write',
        [path('tableId', TableId), path('recordId', RecordId)],
        component('CommentCreated', z.object({ commentId: CommentId })),
        component('CommentCreate', CommentCreate),
        { undo: false },
      ),
    },
    '/api/v1/openapi.json': { get: { security: [], responses: { '200': response({ type: 'object' }) } } },
    '/api/tokens': {
      get: { security: [{ session: [] }], responses: { '200': response(tokens) } },
      post: {
        security: [{ session: [] }],
        parameters: [csrf],
        requestBody: body(tokenCreate),
        responses: { '200': response(created) },
      },
    },
    '/api/tokens/{tokenId}': {
      delete: {
        security: [{ session: [] }],
        parameters: [path('tokenId', z.string()), csrf],
        responses: { '204': { description: message('api.response.success') } },
      },
    },
  };
  const connectorOperations = [
    ['/api/v1/databases/{databaseId}/column-suggestions', 'post', 'suggestJoinedColumns'],
    ['/api/v1/tables/{tableId}/joined-columns', 'patch', 'configureJoinedColumns'],
    ['/api/v1/tables/{tableId}/records/duplicate', 'post', 'duplicateRecords'],
    ['/api/v1/fields/{fieldId}/duplicate', 'post', 'duplicateField'],
    ['/api/v1/tables/{tableId}/duplicate', 'post', 'duplicateTable'],
    ['/api/v1/duplicate-jobs/{jobId}', 'get', 'getDuplicateJob'],
    ['/api/v1/duplicate-jobs/{jobId}/cancel', 'post', 'cancelDuplicateJob'],
    ['/api/v1/databases/{databaseId}/named-functions', 'get', 'listNamedFunctions'],
    ['/api/v1/databases/{databaseId}/named-functions', 'post', 'createNamedFunction'],
    ['/api/v1/databases/{databaseId}/named-functions/{functionId}', 'patch', 'updateNamedFunction'],
    ['/api/v1/databases/{databaseId}/named-functions/{functionId}', 'delete', 'deleteNamedFunction'],
    ['/api/v1/tables/{tableId}/records/{recordId}/comments', 'get', 'getComments'],
    ['/api/v1/tables/{tableId}/records/{recordId}/comments', 'post', 'createComment'],
    ['/api/v1/imports/document', 'post', 'previewDocumentImport'],
    ['/api/v1/databases', 'get', 'listDatabases'],
    ['/api/v1/databases/{databaseId}/tables', 'get', 'listTables'],
    ['/api/v1/tables/{tableId}/views', 'get', 'listViews'],
    ['/api/v1/tables/{tableId}/records', 'get', 'findRecords'],
    ['/api/v1/tables/{tableId}/records/{recordId}', 'get', 'getRecord'],
    ['/api/v1/tables/{tableId}/records', 'post', 'createRecords'],
    ['/api/v1/tables/{tableId}/records', 'patch', 'updateRecords'],
    ['/api/v1/tables/{tableId}/records', 'delete', 'deleteRecords'],
  ] as const;
  for (const [path, method, id] of connectorOperations) {
    const operations = paths[path] as Record<string, object>;
    Object.assign(operations[method]!, {
      operationId: id,
      summary: message(`api.operation.${id}.summary`),
      description: message(`api.operation.${id}.description`),
      'x-ms-visibility': method === 'delete' ? 'advanced' : 'important',
    });
  }
  return {
    openapi: '3.1.0',
    info: { title: message('api.title'), version: VERSION },
    paths,
    components: {
      schemas,
      securitySchemes: {
        personalToken: { type: 'http', scheme: 'bearer', bearerFormat: 'rio_pat_<tokenId>_<secret>' },
        session: { type: 'apiKey', in: 'cookie', name: 'rio_session' },
      },
    },
  };
}

/** The transport wrapper uses the same issuer and scopes as direct MCP connections. */
export function mcpConnector() {
  return {
    swagger: '2.0',
    info: { title: message('api.connector.mcp.title'), version: VERSION },
    basePath: '/',
    schemes: ['https'],
    consumes: ['application/json'],
    produces: ['application/json', 'text/event-stream'],
    paths: {
      '/mcp': {
        post: {
          operationId: 'invokeMcp',
          summary: message('api.connector.mcp.summary'),
          description: message('api.connector.mcp.description'),
          'x-ms-agentic-protocol': 'mcp-streamable-1.0',
          'x-ms-visibility': 'important',
          responses: {
            '200': { description: message('api.response.success') },
            '202': { description: message('api.connector.mcp.accepted') },
          },
          security: [{ oauth2: [...MCP_SCOPES] }],
        },
      },
    },
    securityDefinitions: {
      oauth2: {
        type: 'oauth2',
        flow: 'accessCode',
        authorizationUrl: 'https://example.invalid/oauth/authorize',
        tokenUrl: 'https://example.invalid/oauth/token',
        scopes: {
          'schema.bases:read': message('api.operation.listDatabases.summary'),
          'schema.bases:write': message('api.connector.mcp.schemaWrite'),
          'data.records:read': message('api.operation.findRecords.summary'),
          'data.records:write': message('api.operation.updateRecords.summary'),
        },
      },
    },
  };
}
