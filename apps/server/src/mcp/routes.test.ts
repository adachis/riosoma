import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  newId,
  type ColumnSuggestions,
  type CommandBatchResult,
  type NamedFunctionResult,
  type FieldMeta,
  type SchemaFieldResult,
  type SchemaTableResult,
  type SchemaTrashResult,
  type SchemaViewResult,
  type TableMeta,
  type TokenCreated,
  type TokenScope,
  type UndoResult,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { RecordReader } from '../api-v1/reads.js';
import { AccessScope } from '../data/access.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { MCP_LIMITS } from './tools.js';

let kit: TestPostgres;
let server: ServerFixture;
let endpoint: URL;
let token: TokenCreated;
const clients: Client[] = [];

const READS: TokenScope[] = ['schema.bases:read', 'data.records:read'];
const EVERYTHING: TokenScope[] = [...READS, 'data.records:write'];

it('duplicates records, fields, and tables through MCP and REST with one undo group per action', async () => {
  const target = await table();
  const records = await seed(target, [{ Name: 'Original', Count: 17 }]);
  const authorization = bearer(await makeToken([...EVERYTHING, 'schema.bases:write']));
  const client = await connect(authorization);
  const rollback = async (groupId: string, confirmedMajorCreation: boolean) => {
    if (confirmedMajorCreation) {
      const refused = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${target.databaseId}/undo`,
        headers: server.owner.headers,
        payload: { clientId: newId('client'), commandId: newId('command'), groupId },
      });
      expect(refused.statusCode, refused.body).toBe(200);
      expect(refused.json()).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'data.undo.majorCreationConfirmationRequired' },
      });
    }
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${target.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { clientId: newId('client'), commandId: newId('command'), groupId, confirmedMajorCreation },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied', skipped: 0 });
  };
  for (const transport of ['mcp', 'rest'] as const) {
    const operations = [
      {
        tool: 'duplicate_records',
        path: `/tables/${target.tableId}/records/duplicate`,
        input: { tableId: target.tableId, recordIds: records },
      },
      {
        tool: 'duplicate_field',
        path: `/fields/${target.field.Count}/duplicate`,
        input: { fieldId: target.field.Count, name: 'Count copy', withValues: true },
      },
      {
        tool: 'duplicate_table',
        path: `/tables/${target.tableId}/duplicate`,
        input: { tableId: target.tableId, name: 'Table copy', withRecords: true },
      },
    ];
    for (const operation of operations) {
      let result: { undoGroupId: string; recordIds?: string[]; fieldId?: string; tableId?: string };
      if (transport === 'mcp') result = await succeed(client, operation.tool, operation.input);
      else {
        const response = await server.app.inject({
          method: 'POST',
          url: `/api/v1${operation.path}`,
          headers: authorization,
          payload: operation.input,
        });
        expect(response.statusCode, response.body).toBe(200);
        result = response.json();
        expect(response.headers['x-undo-group-id']).toBe(result.undoGroupId);
      }
      expect(result.undoGroupId).toMatch(/^act/);
      if (result.recordIds) {
        const copied = await succeed<{ record: { fields: Record<string, unknown> } }>(client, 'get_record', {
          tableId: target.tableId,
          recordId: result.recordIds[0],
        });
        expect(copied.record.fields.Count).toBe(17);
      }
      if (result.fieldId)
        expect(
          (
            await query(
              server.pool,
              sql`SELECT type, name FROM ${ident(server.schemas.app, 'fields')} WHERE id = ${result.fieldId}`,
            )
          ).rows[0],
        ).toEqual({ type: 'number', name: 'Count copy' });
      if (result.tableId)
        expect(
          (
            await query(
              server.pool,
              sql`SELECT name FROM ${ident(server.schemas.app, 'tables')} WHERE id = ${result.tableId}`,
            )
          ).rows[0],
        ).toEqual({ name: 'Table copy' });
      await rollback(result.undoGroupId, operation.tool === 'duplicate_table');
    }
  }
  const reader = await connect(bearer(await makeToken(READS)));
  expect(
    await fail(reader, 'duplicate_records', { tableId: target.tableId, recordIds: records }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });
});

it('creates and reads link choice options through the field tools', async () => {
  const target = await table();
  const client = await connect(bearer(await makeToken([...EVERYTHING, 'schema.bases:write'])));
  const options = {
    linkedTableId: target.tableId,
    displayFieldIds: [target.field.Status!, target.field.Count!],
    filter: {
      conjunction: 'and',
      conditions: [
        { id: 'same', fieldId: target.field.Count!, operator: 'eq', currentFieldId: target.field.Count! },
      ],
    },
  };
  const created = await succeed<SchemaFieldResult>(client, 'create_field', {
    tableId: target.tableId,
    input: { name: 'Related', type: 'link', options },
  });
  expect(created.field).toMatchObject({ type: 'link', options });
  const schema = await succeed<{ tables: Array<{ fields: FieldMeta[] }> }>(client, 'get_schema', {
    databaseId: target.databaseId,
  });
  expect(
    schema.tables.flatMap((table) => table.fields).find((field) => field.id === created.field!.id),
  ).toMatchObject({ options });
});

it('updates conditional form settings through REST and the view tool with undo', async () => {
  const target = await table();
  const client = await connect(bearer(await makeToken([...EVERYTHING, 'schema.bases:write'])));
  const created = await succeed<SchemaViewResult>(client, 'create_view', {
    tableId: target.tableId,
    input: { name: 'Intake', type: 'form' },
  });
  const viewId = created.view!.id;
  const form = {
    questions: [
      { fieldId: target.field.Name },
      { fieldId: target.field.Count, showIf: { fieldId: target.field.Name, equals: 'Yes' } },
    ],
  };
  const token = await makeToken([...EVERYTHING, 'schema.bases:write']);
  const rest = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/views/${viewId}`,
    headers: bearer(token),
    payload: { form },
  });
  expect(rest.statusCode, rest.body).toBe(200);
  expect(rest.json<SchemaViewResult>().view!.config.form.questions[1]!.showIf).toEqual(
    form.questions[1]!.showIf,
  );
  const saved = await succeed<SchemaViewResult>(client, 'update_view', {
    viewId,
    input: { form: { ...form, title: 'Conditional intake' } },
  });
  expect(saved.view!.config.form.title).toBe('Conditional intake');
  const undo = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${target.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId: saved.undoGroupId },
  });
  expect(undo.statusCode, undo.body).toBe(200);
  const events = await query(
    server.pool,
    sql`SELECT action FROM ${ident(server.schemas.audit, 'events')} WHERE metadata ->> 'viewId' = ${viewId}`,
  );
  expect(events.rows.some((event) => event.action === 'data.view.updated')).toBe(true);
});

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'mcp');
  endpoint = new URL('/mcp', await server.app.listen({ port: 0, host: '127.0.0.1' }));
  token = await makeToken();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.close()));
  // Shared fixture tokens start each test with their own rolling allowance.
  await server.pool.query(`DELETE FROM "${server.schemas.app}".auth_attempts WHERE key LIKE 'mcp:%'`);
});
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

interface Row {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}
interface Failure {
  code: string;
  messageKey: string;
  message: string;
  params?: Record<string, string | number | boolean>;
  fields?: Record<string, string>;
}
interface Table {
  databaseId: string;
  tableId: string;
  /** Field IDs by name */
  field: Record<string, string>;
}

async function makeToken(
  scopes: TokenScope[] = EVERYTHING,
  databases: 'all' | string[] = 'all',
  who?: SignedIn,
) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: (who ?? server.owner).headers,
    payload: { name: 'Connector', scopes, databases },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<TokenCreated>();
}

const bearer = (pat: TokenCreated = token) => ({ authorization: `Bearer ${pat.token}` });

async function connect(headers: Record<string, string> = bearer()) {
  const client = new Client({ name: 'riosoma-tests', version: '1.0.0' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers } }));
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

function body(result: CallToolResult): unknown {
  const [first] = result.content;
  if (first?.type !== 'text') throw new Error('The result has no text.');
  const parsed: unknown = JSON.parse(first.text);
  // The same data comes back structured, for clients that read it that way.
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

async function succeed<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return body(result) as T;
}

async function fail(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Failure> {
  const result = await call(client, name, args);
  expect(result.isError, JSON.stringify(result.content)).toBe(true);
  return (body(result) as { error: Failure }).error;
}

/** A table with a text, a single select, a number, and a date field, named as people name them. */
async function table(): Promise<Table> {
  const read = await readFixture(server, [
    { type: 'text' },
    {
      type: 'singleSelect',
      options: {
        choices: [
          { id: newId('choice'), name: 'To do', color: 'gray' },
          { id: newId('choice'), name: 'Done', color: 'green' },
        ],
      },
    },
    { type: 'number' },
    { type: 'date' },
  ]);
  const names = ['Name', 'Status', 'Count', 'Due'];
  const field: Record<string, string> = {};
  for (const [index, stored] of read.fields.entries()) {
    field[names[index]!] = stored.id;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'fields')} SET name = ${names[index]!} WHERE id = ${stored.id}`,
    );
  }
  return { databaseId: read.table.databaseId, tableId: read.table.id, field };
}

/** Adds records through the REST API, so reads here don't lean on the writes under test. */
async function seed(target: Table, rows: Array<Record<string, unknown>>): Promise<string[]> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${target.tableId}/records?shape=list`,
    headers: bearer(),
    payload: { records: rows.map((fields) => ({ fields })) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ records: Array<{ id: string }> }>().records.map((record) => record.id);
}

async function changes(databaseId: string) {
  return (
    await query<{ group_id: string; actor_id: string | null; kind: string }>(
      server.pool,
      sql`SELECT group_id, actor_id, kind FROM ${ident(server.schemas.app, 'changes')}
      WHERE database_id = ${databaseId} ORDER BY seq`,
    )
  ).rows;
}

const initialize = (id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } },
});

async function post(payload: unknown, headers: Record<string, string> = {}) {
  return server.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...bearer(),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    payload: JSON.stringify(payload),
  });
}

it('initializes over HTTP and lists only the tools each token’s scopes allow', async () => {
  const reader = await connect(bearer(await makeToken(READS)));
  expect(reader.getServerVersion()).toMatchObject({ name: 'riosoma', version: expect.any(String) });
  expect(reader.getServerCapabilities()?.tools).toBeDefined();
  expect(reader.getInstructions()).toContain('list_databases');
  const readTools = (await reader.listTools()).tools;
  expect(readTools.map((tool) => tool.name)).toEqual([
    'get_duplicate_job',
    'get_comments',
    'list_connected_tools',
    'get_record_history',
    'get_sync_history',
    'search_knowledge',
    'list_knowledge',
    'find_similar_records',
    'web_search',
    'list_memories',
    'list_databases',
    'list_folders',
    'get_dashboard',
    'get_interface',
    'get_automation',
    'get_schema',
    'list_named_functions',
    'find_records',
    'count_records',
    'aggregate_records',
    'get_record',
  ]);
  for (const tool of readTools) {
    expect(tool.description!.length).toBeGreaterThan(20);
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.annotations?.readOnlyHint).toBe(true);
  }
  // Tokens without the write scope are refused the write tools even when they ask by name.
  expect(
    await fail(reader, 'create_records', { tableId: newId('table'), records: [{ fields: {} }] }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });

  expect(
    await fail(reader, 'run_button', {
      databaseId: newId('database'),
      fieldId: newId('field'),
      recordId: newId('record'),
    }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });

  const writer = await connect();
  expect(
    await fail(writer, 'run_button', {
      databaseId: newId('database'),
      fieldId: newId('field'),
      recordId: newId('record'),
    }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });
  const tools = (await writer.listTools()).tools;
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  expect(tools.map((tool) => tool.name)).toEqual([
    'get_duplicate_job',
    'duplicate_records',
    'attach_file_from_url',
    'create_comment',
    'get_comments',
    'preview_document_import',
    'clear_overrides',
    ...readTools
      .map((tool) => tool.name)
      .filter((name) => name !== 'get_comments' && name !== 'get_duplicate_job'),
    'propose_record_update',
    'create_records',
    'update_records',
    'move_records',
    'set_record_locks',
    'delete_records',
    'change_knowledge',
    'remember',
    'forget',
  ]);
  expect(tools.find((tool) => tool.name === 'delete_records')?.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
  });
  expect(tools.find((tool) => tool.name === 'attach_file_from_url')?.annotations).toMatchObject({
    readOnlyHint: false,
    openWorldHint: true,
  });
  expect(
    await fail(reader, 'attach_file_from_url', {
      tableId: newId('table'),
      fieldId: newId('field'),
      recordId: newId('record'),
      url: 'https://files.example.test/report.pdf',
    }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });
  expect(tools.find((tool) => tool.name === 'find_records')?.inputSchema.properties).toHaveProperty('cursor');

  const recordsOnly = await connect(bearer(await makeToken(['data.records:read'])));
  expect((await recordsOnly.listTools()).tools.map((tool) => tool.name)).toEqual([
    'get_comments',
    'list_connected_tools',
    'get_record_history',
    'get_sync_history',
    'search_knowledge',
    'list_knowledge',
    'find_similar_records',
    'web_search',
    'list_memories',
    'find_records',
    'count_records',
    'aggregate_records',
    'get_record',
  ]);
  for (const name of ['get_dashboard', 'get_interface', 'get_automation'])
    expect(
      await fail(recordsOnly, name, { databaseId: newId('database'), id: newId('automation') }),
    ).toMatchObject({ code: 'forbidden', messageKey: 'errors.tokenScope' });
  const schemaWriter = await connect(bearer(await makeToken(['schema.bases:write'])));
  const schemaTools = (await schemaWriter.listTools()).tools;
  expect(schemaTools).toHaveLength(22);
  expect(schemaTools.map((tool) => tool.name)).toEqual([
    'cancel_duplicate_job',
    'duplicate_field',
    'duplicate_table',
    'configure_grid',
    'suggest_joined_columns',
    'configure_joined_columns',
    'create_joined_table',
    'configure_overrides',
    'change_home',
    'create_named_function',
    'update_named_function',
    'delete_named_function',
    'create_table',
    'update_table',
    'trash_table',
    'create_field',
    'update_field',
    'trash_field',
    'create_view',
    'update_view',
    'trash_view',
    'run_button',
  ]);
  for (const tool of schemaTools)
    expect(tool.annotations?.readOnlyHint).toBe(tool.name === 'suggest_joined_columns');
  expect(await fail(schemaWriter, 'get_sync_history', { tableId: newId('table') })).toMatchObject({
    code: 'forbidden',
    messageKey: 'errors.tokenScope',
  });
});

it('creates, renames, reorders, and trashes schema through audited commands the app can undo', async () => {
  const target = await table();
  const token = await makeToken(['schema.bases:read', 'schema.bases:write']);
  const client = await connect(bearer(token));
  type SchemaTable = TableMeta & { fields: FieldMeta[]; views: ViewMeta[] };
  const schema = async () => {
    const response = await server.app.inject({
      method: 'GET',
      url: `/api/v1/databases/${target.databaseId}/tables`,
      headers: bearer(token),
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ tables: SchemaTable[] }>().tables;
  };
  const undo = async (groupId: string, confirmedMajorCreation = false) => {
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${target.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { clientId: newId('client'), commandId: newId('command'), groupId, confirmedMajorCreation },
    });
    expect(response.json<UndoResult>().status, response.body).toBe('applied');
  };
  const created = await succeed<SchemaTableResult>(client, 'create_table', {
    databaseId: target.databaseId,
    input: {
      name: 'Tasks',
      fields: [
        { name: 'Title', type: 'text' },
        { name: 'Status', type: 'singleSelect', options: { choices: [{ name: 'Open' }] } },
      ],
    },
  });
  const tableId = created.table!.id;
  const current = async () => (await schema()).find((item) => item.id === tableId);
  expect(created.table).toMatchObject({
    name: 'Tasks',
    primaryFieldId: created.table!.fields[0]!.id,
    views: [{ name: 'Grid view', type: 'grid' }],
  });
  expect(created.table!.fields[1]).toMatchObject({
    options: { choices: [{ id: expect.stringMatching(/^cho/), name: 'Open', color: expect.any(String) }] },
  });
  const renamed = await succeed<SchemaTableResult>(client, 'update_table', {
    tableId,
    input: { name: 'Work', index: 0 },
  });
  expect(renamed.table!.name).toBe('Work');
  expect((await schema()).map((item) => item.id)).toEqual([tableId, target.tableId]);
  const field = await succeed<SchemaFieldResult>(client, 'create_field', {
    tableId,
    input: { name: 'Notes', type: 'longText' },
  });
  const fieldId = field.field!.id;
  const fieldChange = await succeed<SchemaFieldResult>(client, 'update_field', {
    fieldId,
    input: { name: 'Details' },
  });
  expect(fieldChange.field).toMatchObject({ id: fieldId, name: 'Details' });
  const view = await succeed<SchemaViewResult>(client, 'create_view', {
    tableId,
    input: { name: 'Second', type: 'gallery' },
  });
  const viewId = view.view!.id;
  const arranged = await succeed<SchemaViewResult>(client, 'update_view', {
    viewId,
    input: { name: 'First', index: 0, fieldOrder: [fieldId] },
  });
  expect(arranged.view!.config.fieldOrder[0]).toBe(fieldId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['First', 'Grid view']);
  const viewTrash = await succeed<SchemaTrashResult>(client, 'trash_view', { viewId });
  expect((await current())!.views.map((item) => item.id)).not.toContain(viewId);
  const fieldTrash = await succeed<SchemaTrashResult>(client, 'trash_field', { fieldId });
  expect((await current())!.fields.map((item) => item.id)).not.toContain(fieldId);
  const tableTrash = await succeed<SchemaTrashResult>(client, 'trash_table', { tableId });
  expect(await current()).toBeUndefined();
  for (const [result, id] of [
    [viewTrash, viewId],
    [fieldTrash, fieldId],
    [tableTrash, tableId],
  ] as const)
    expect(result.id).toBe(id);

  const actions = [created, renamed, field, fieldChange, view, arranged, viewTrash, fieldTrash, tableTrash];
  for (const action of actions) {
    expect(action.undoGroupId).toMatch(/^act/);
    expect(await changes(target.databaseId)).toContainEqual({
      group_id: action.undoGroupId,
      actor_id: server.owner.userId,
      kind: expect.any(String),
    });
  }
  const audit = await query<{ actor_id: string; action: string }>(
    server.pool,
    sql`SELECT actor_id, action FROM ${ident(server.schemas.audit, 'events')}
      WHERE metadata ->> 'databaseId' = ${target.databaseId}`,
  );
  for (const kind of ['table', 'field', 'view'])
    for (const action of ['created', 'updated', 'trashed'])
      expect(audit.rows).toContainEqual({ actor_id: server.owner.userId, action: `data.${kind}.${action}` });

  await undo(tableTrash.undoGroupId);
  expect(await current()).toBeDefined();
  await undo(fieldTrash.undoGroupId);
  expect((await current())!.fields.find((item) => item.id === fieldId)!.name).toBe('Details');
  await undo(viewTrash.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['First', 'Grid view']);
  await undo(arranged.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['Grid view', 'Second']);
  expect((await current())!.views.find((item) => item.id === viewId)!.config.fieldOrder).not.toContain(
    fieldId,
  );
  await undo(view.undoGroupId);
  expect((await current())!.views.map((item) => item.name)).toEqual(['Grid view']);
  await undo(fieldChange.undoGroupId);
  expect((await current())!.fields.find((item) => item.id === fieldId)!.name).toBe('Notes');
  await undo(field.undoGroupId);
  expect((await current())!.fields.map((item) => item.id)).not.toContain(fieldId);
  await undo(renamed.undoGroupId);
  expect((await schema()).map((item) => [item.id, item.name])).toEqual([
    [target.tableId, 'Records'],
    [tableId, 'Tasks'],
  ]);
  await undo(created.undoGroupId, true);
  expect(await current()).toBeUndefined();
});

it('refuses every schema write without scope, outside the token’s databases, or without schema edit rights', async () => {
  const fixture = await readFixture(server, [{ type: 'text' }, { type: 'longText' }]);
  const other = await table();
  const writes: Array<[string, Record<string, unknown>]> = [
    [
      'create_table',
      {
        databaseId: fixture.table.databaseId,
        input: { name: 'New', fields: [{ name: 'Name', type: 'text' }] },
      },
    ],
    ['update_table', { tableId: fixture.table.id, input: { name: 'Renamed' } }],
    ['trash_table', { tableId: fixture.table.id }],
    ['create_field', { tableId: fixture.table.id, input: { name: 'Added', type: 'text' } }],
    ['update_field', { fieldId: fixture.fields[1]!.id, input: { name: 'Renamed' } }],
    ['trash_field', { fieldId: fixture.fields[1]!.id }],
    ['create_view', { tableId: fixture.table.id, input: { name: 'Added' } }],
    ['update_view', { viewId: fixture.view.id, input: { name: 'Renamed' } }],
    ['trash_view', { viewId: fixture.view.id }],
  ];
  const unscoped = await connect();
  const restricted = await connect(bearer(await makeToken(['schema.bases:write'], [other.databaseId])));
  const denied: Client[] = [];
  for (const role of ['reader', 'editor']) {
    const member = await server.addMember();
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
        (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
        VALUES (${member.info.org.id}, 'database', ${fixture.table.databaseId}, 'user', ${member.userId}, ${role})`,
    );
    denied.push(await connect(bearer(await makeToken(['schema.bases:write'], 'all', member))));
  }
  const log = await changes(fixture.table.databaseId);
  for (const [name, args] of writes) {
    expect(await fail(unscoped, name, args)).toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.tokenScope',
    });
    expect(await fail(restricted, name, args)).toMatchObject({ messageKey: 'errors.notFound' });
    for (const client of denied)
      expect(await fail(client, name, args)).toMatchObject({
        code: 'forbidden',
        messageKey: 'data.access.denied',
      });
  }
  expect(await changes(fixture.table.databaseId)).toEqual(log);
});

it('refuses link retargeting with or without an explicit type and preserves names, values, and history', async () => {
  const target = await table();
  const client = await connect(bearer(await makeToken([...EVERYTHING, 'schema.bases:write'])));
  const create = (name: string) =>
    succeed<SchemaTableResult>(client, 'create_table', {
      databaseId: target.databaseId,
      input: { name, fields: [{ name: 'Name', type: 'text' }] },
    });
  const first = (await create('First')).table!;
  const second = (await create('Second')).table!;
  const linked = await succeed<SchemaFieldResult>(client, 'create_field', {
    tableId: target.tableId,
    input: { name: 'Target', type: 'link', options: { linkedTableId: first.id } },
  });
  const destination = await succeed<{ records: Row[] }>(client, 'create_records', {
    tableId: first.id,
    records: [{ fields: { Name: 'Kept' } }],
  });
  await seed(target, [{ Name: 'Source', Target: [destination.records[0]!.id] }]);
  const schema = () => succeed(client, 'get_schema', { databaseId: target.databaseId });
  const records = () => succeed(client, 'find_records', { tableId: target.tableId });
  const before = await schema();
  const values = await records();
  const log = await changes(target.databaseId);
  for (const type of [undefined, 'link']) {
    expect(
      await fail(client, 'update_field', {
        fieldId: linked.field!.id,
        input: { name: 'Renamed', ...(type ? { type } : {}), options: { linkedTableId: second.id } },
      }),
    ).toMatchObject({ code: 'validation_failed', messageKey: 'data.link.targetChange' });
    expect(await schema()).toEqual(before);
    expect(await records()).toEqual(values);
    expect(await changes(target.databaseId)).toEqual(log);
  }
});

it('changes home with the schema write scope and lists tags through the home reader', async () => {
  const writer = await connect(bearer(await makeToken(['schema.bases:read', 'schema.bases:write'])));
  const reader = await connect(bearer(await makeToken(READS)));
  const tagId = newId('tag');
  const input = {
    id: newId('command'),
    action: { kind: 'tag.create', tagId, name: 'Project label', color: '#007aff', visibility: 'private' },
  };
  expect(await fail(reader, 'change_home', input)).toMatchObject({
    code: 'forbidden',
    messageKey: 'errors.tokenScope',
  });
  expect(await succeed(writer, 'change_home', input)).toMatchObject({ id: input.id, status: 'applied' });
  const listing = await succeed<{ tags: Array<{ id: string; name: string }> }>(writer, 'list_folders');
  expect(listing.tags).toContainEqual(expect.objectContaining({ id: tagId, name: 'Project label' }));
});

it('refuses hidden home batches without applying any action', async () => {
  const writer = await connect(bearer(await makeToken(['schema.bases:read', 'schema.bases:write'])));
  const fixture = await table();
  const tagId = newId('tag');
  const response = await call(writer, 'change_home', {
    id: newId('command'),
    action: { kind: 'tag.create', tagId, name: 'Unapplied', color: '#007aff', visibility: 'private' },
    actions: [{ kind: 'database.trash', databaseId: fixture.databaseId }],
  });
  expect(response.isError).toBe(true);
  const listing = await succeed<{ tags: Array<{ id: string }>; databases: Array<{ id: string }> }>(
    writer,
    'list_folders',
  );
  expect(listing.tags.some((tag) => tag.id === tagId)).toBe(false);
  expect(listing.databases.some((database) => database.id === fixture.databaseId)).toBe(true);
});

it('configures and reorders grids through scoped tools', async () => {
  const f = await readFixture(server, [{ type: 'text' }, { type: 'number' }]);
  const writer = await connect(bearer(await makeToken([...EVERYTHING, 'schema.bases:write'])));
  const reader = await connect(bearer(await makeToken(READS)));
  const created = await succeed<{ records: Array<{ id: string }> }>(writer, 'create_records', {
    tableId: f.table.id,
    records: [{ fields: { [f.fields[0]!.id]: 'First' } }, { fields: { [f.fields[0]!.id]: 'Second' } }],
  });
  const ids = created.records.map((record) => record.id);
  const arrangement = { viewId: f.view.id, config: { pinnedRecordIds: [ids[1]] } };
  expect(await fail(reader, 'configure_grid', arrangement)).toMatchObject({
    messageKey: 'errors.tokenScope',
  });
  expect(await succeed(writer, 'configure_grid', arrangement)).toMatchObject({
    results: [{ status: 'applied' }],
  });
  expect(await succeed(reader, 'get_schema', { databaseId: f.table.databaseId })).toMatchObject({
    tables: [{ views: [{ id: f.view.id, config: { pinnedRecordIds: [ids[1]] } }] }],
  });
  const icons = {
    viewId: f.view.id,
    config: { iconSets: [{ fieldId: f.fields[1]!.id, thresholds: [0, 10] }] },
  };
  expect(await fail(reader, 'configure_grid', icons)).toMatchObject({ messageKey: 'errors.tokenScope' });
  expect(await succeed(writer, 'configure_grid', icons)).toMatchObject({ results: [{ status: 'applied' }] });
  expect(await succeed(reader, 'get_schema', { databaseId: f.table.databaseId })).toMatchObject({
    tables: [{ views: [{ id: f.view.id, config: icons.config }] }],
  });
  // A grid's arrangement stays on grids, so a view of another kind refuses it.
  const listId = newId('view');
  const listView = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: { id: listId, tableId: f.table.id, name: 'List', type: 'list', config: {} },
        },
      ],
    },
  });
  expect(listView.statusCode, listView.body).toBe(200);
  expect(
    await fail(writer, 'configure_grid', { viewId: listId, config: { pinnedRecordIds: [ids[0]] } }),
  ).toMatchObject({ messageKey: 'data.view.gridOnly' });
  const move = { tableId: f.table.id, viewId: f.view.id, recordIds: [ids[1]], place: { before: ids[0] } };
  expect(await fail(reader, 'move_records', move)).toMatchObject({ messageKey: 'errors.tokenScope' });
  expect(await succeed(writer, 'move_records', move)).toMatchObject({
    recordIds: [ids[1]],
    viewId: f.view.id,
    undoGroupId: expect.any(String),
  });
});

it('lists databases and reads schemas only within the token’s reach, and refuses unknown arguments', async () => {
  const first = await table();
  const second = await table();
  const client = await connect();
  const { databases } = await succeed<{ databases: Array<{ id: string; name: string; role: string }> }>(
    client,
    'list_databases',
  );
  expect(databases).toContainEqual({ id: first.databaseId, name: 'Records', role: 'owner' });
  const home = await succeed<{ databases: Array<{ id: string }> }>(client, 'list_folders');
  expect(home.databases.map((database) => database.id)).toEqual(
    expect.arrayContaining([first.databaseId, second.databaseId]),
  );
  const schema = await succeed<{
    id: string;
    tables: Array<{
      id: string;
      fields: Array<{
        id: string;
        name: string;
        type: string;
        options: { choices?: Array<{ name: string }> };
      }>;
      views: Array<{ name: string }>;
    }>;
  }>(client, 'get_schema', { databaseId: first.databaseId });
  expect(schema.id).toBe(first.databaseId);
  expect(schema.tables[0]!.id).toBe(first.tableId);
  expect(schema.tables[0]!.fields.map((f) => [f.name, f.type])).toEqual([
    ['Name', 'text'],
    ['Status', 'singleSelect'],
    ['Count', 'number'],
    ['Due', 'date'],
  ]);
  expect(schema.tables[0]!.fields[1]!.options.choices?.map((choice) => choice.name)).toEqual([
    'To do',
    'Done',
  ]);
  expect(schema.tables[0]!.views.map((v) => v.name)).toEqual(['Grid']);

  const limited = await connect(bearer(await makeToken(EVERYTHING, [first.databaseId])));
  expect(
    (await succeed<{ databases: Array<{ id: string }> }>(limited, 'list_databases')).databases.map(
      (d) => d.id,
    ),
  ).toEqual([first.databaseId]);
  const limitedHome = await succeed<{ folders: unknown[]; databases: Array<{ id: string }> }>(
    limited,
    'list_folders',
  );
  expect(limitedHome.folders).toEqual([]);
  expect(limitedHome.databases.map((database) => database.id)).toEqual([first.databaseId]);
  expect(await fail(limited, 'get_schema', { databaseId: second.databaseId })).toMatchObject({
    code: 'not_found',
    messageKey: 'errors.notFound',
    message: 'The requested resource was not found.',
  });
  for (const name of ['get_dashboard', 'get_interface', 'get_automation'])
    expect(
      await fail(limited, name, { databaseId: second.databaseId, id: newId('automation') }),
    ).toMatchObject({ code: 'not_found' });
  expect(await fail(limited, 'find_records', { tableId: second.tableId })).toMatchObject({
    messageKey: 'errors.notFound',
  });
  // Arguments the tool doesn't know are refused rather than quietly ignored.
  expect(await fail(client, 'list_databases', { filter: 'x' })).toMatchObject({
    messageKey: 'errors.validationFailed',
    fields: { _: 'validation.unrecognized_keys' },
  });
  expect(await fail(client, 'get_schema', { databaseId: 'nope' })).toMatchObject({
    messageKey: 'errors.validationFailed',
    fields: { databaseId: 'validation.invalid_format' },
  });
});

it('reads late schema pages and selected columns through the scoped schema tool', async () => {
  const target = await table();
  const client = await connect(
    bearer(await makeToken([...READS, 'schema.bases:write'], [target.databaseId])),
  );
  const created = await succeed<SchemaTableResult>(client, 'create_table', {
    databaseId: target.databaseId,
    input: {
      name: 'Wide metrics',
      fields: Array.from({ length: 300 }, (_, index) => ({ name: `metric_${index}`, type: 'text' })),
    },
  });
  const tableId = created.table!.id;
  type Page = {
    tables: Array<{
      id: string;
      fieldCount: number;
      nextOffset: number | null;
      fields: Array<{ id: string; name: string }>;
    }>;
  };
  const page = await succeed<Page>(client, 'get_schema', {
    databaseId: target.databaseId,
    tableId,
    offset: 280,
    limit: 20,
  });
  expect(page.tables).toHaveLength(1);
  expect(page.tables[0]).toMatchObject({ id: tableId, fieldCount: 300, nextOffset: null });
  expect(page.tables[0]!.fields.map((field) => field.name)).toEqual(
    Array.from({ length: 20 }, (_, index) => `metric_${280 + index}`),
  );
  const fieldId = page.tables[0]!.fields.at(-1)!.id;
  const selected = await succeed<Page>(client, 'get_schema', {
    databaseId: target.databaseId,
    tableId,
    fields: [fieldId],
  });
  expect(selected.tables[0]!.fields).toEqual([expect.objectContaining({ id: fieldId, name: 'metric_299' })]);
  const other = await table();
  expect(
    await fail(client, 'get_schema', { databaseId: target.databaseId, tableId: other.tableId }),
  ).toMatchObject({ code: 'not_found' });
  expect(
    await fail(client, 'get_schema', { databaseId: other.databaseId, tableId: other.tableId }),
  ).toMatchObject({ code: 'not_found' });
  expect(
    await fail(client, 'get_schema', { databaseId: target.databaseId, tableId, limit: 51 }),
  ).toMatchObject({ code: 'validation_failed' });
});

it('shares scoped notes with the REST API and refuses memory tools outside token permissions', async () => {
  const first = await table();
  const second = await table();
  const limited = await makeToken(EVERYTHING, [first.databaseId]);
  const client = await connect(bearer(limited));
  const note = { databaseId: first.databaseId, memoryId: randomUUID(), text: 'Keep harvest notes' };
  expect(await succeed(client, 'remember', note)).toMatchObject({ status: 'applied' });
  const read = await server.app.inject({
    url: `/api/v1/databases/${first.databaseId}/memories`,
    headers: bearer(limited),
  });
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json()).toMatchObject([{ id: note.memoryId, text: note.text, visibility: 'personal' }]);
  const changed = await server.app.inject({
    method: 'POST',
    url: '/api/v1/knowledge/memories',
    headers: bearer(limited),
    payload: { ...note, text: 'Updated harvest notes' },
  });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json()).toMatchObject({ status: 'applied' });
  expect(await succeed(client, 'list_memories', { databaseId: first.databaseId })).toMatchObject({
    memories: [{ id: note.memoryId, text: 'Updated harvest notes' }],
  });
  expect(await fail(client, 'list_memories', { databaseId: second.databaseId })).toMatchObject({
    code: 'not_found',
  });
  const reader = await connect(bearer(await makeToken(READS, [first.databaseId])));
  expect(await fail(reader, 'remember', note)).toMatchObject({ messageKey: 'errors.tokenScope' });
  expect(
    await succeed(client, 'forget', {
      databaseId: first.databaseId,
      memoryId: note.memoryId,
    }),
  ).toMatchObject({ status: 'applied' });
  expect(await succeed(client, 'list_memories', { databaseId: first.databaseId })).toEqual({ memories: [] });
});

it('finds records by named fields and choices, sorts them, pages to the end, counts them, and reads one', async () => {
  const target = await table();
  const ids = await seed(
    target,
    Array.from({ length: 7 }, (_, n) => ({ Name: `Item ${n}`, Status: n % 2 ? 'Done' : 'To do', Count: n })),
  );
  const client = await connect();
  const where = [{ field: 'status', operator: 'is', value: 'done' }];
  const first = await succeed<{ records: Row[]; next: string | null }>(client, 'find_records', {
    tableId: target.tableId,
    where,
    sort: [{ field: 'Count', direction: 'desc' }],
    limit: 2,
  });
  expect(first.records.map((record) => record.fields.Count)).toEqual([5, 3]);
  expect(first.records[0]).toEqual({
    id: ids[5],
    createdTime: expect.any(String),
    fields: { Name: 'Item 5', Status: 'Done', Count: 5, Due: null },
  });
  expect(first.next).toEqual(expect.any(String));
  // Each page is its own request, and the cursor still carries on from the last one.
  const second = await succeed<{ records: Row[]; next: string | null }>(client, 'find_records', {
    tableId: target.tableId,
    where,
    sort: [{ field: 'Count', direction: 'desc' }],
    limit: 2,
    cursor: first.next,
  });
  expect(second.records.map((record) => record.fields.Count)).toEqual([1]);
  expect(second.next).toBeNull();

  const any = await succeed<{ records: Row[] }>(client, 'find_records', {
    tableId: target.tableId,
    where: [
      { field: 'Count', operator: 'eq', value: 0 },
      { field: target.field.Count!, operator: 'gte', value: 6 },
    ],
    match: 'any',
    fields: ['Name'],
    view: 'Grid',
  });
  expect(any.records.map((record) => record.fields)).toEqual([{ Name: 'Item 0' }, { Name: 'Item 6' }]);
  expect(
    await succeed(client, 'count_records', {
      tableId: target.tableId,
      where: [{ field: 'Status', operator: 'isAnyOf', value: ['To do'] }],
    }),
  ).toEqual({ count: 4 });
  expect(await succeed(client, 'count_records', { tableId: target.tableId })).toEqual({ count: 7 });
  expect(
    await succeed(client, 'get_record', {
      tableId: target.tableId,
      recordId: ids[2],
      fields: ['Name', 'Status'],
    }),
  ).toEqual({
    record: { id: ids[2], createdTime: expect.any(String), fields: { Name: 'Item 2', Status: 'To do' } },
  });
});

it('answers conditions it cannot apply, unknown fields and choices, and bad pages with words the caller can act on', async () => {
  const target = await table();
  await seed(target, [{ Name: 'Only', Status: 'Done', Count: 1 }]);
  const client = await connect();
  const find = (args: Record<string, unknown>) =>
    fail(client, 'find_records', { tableId: target.tableId, ...args });
  expect(await find({ where: [{ field: 'Status', operator: 'is', value: 'Maybe' }] })).toMatchObject({
    code: 'validation_failed',
    messageKey: 'api.filter.unknownChoice',
    params: { field: 'Status', value: 'Maybe', choices: 'To do, Done' },
  });
  // An operator the field doesn't offer, or a value of the wrong kind, would otherwise be skipped
  // and match every record.
  for (const condition of [
    { field: 'Count', operator: 'contains', value: '1' },
    { field: 'Count', operator: 'eq', value: 'one' },
    { field: 'Due', operator: 'isBefore', value: '2026-10-01' },
    { field: 'Status', operator: 'isAnyOf', value: 7 },
  ])
    expect(await find({ where: [condition] }), JSON.stringify(condition)).toMatchObject({
      messageKey: 'mcp.condition.invalid',
      message: expect.stringContaining('operators'),
      params: { field: condition.field, operator: condition.operator, operators: expect.any(String) },
    });
  expect(
    (await find({ where: [{ field: 'Count', operator: 'contains', value: '1' }] })).params?.operators,
  ).toBe('eq, neq, lt, lte, gt, gte, isEmpty, isNotEmpty');
  expect(
    await succeed(client, 'count_records', {
      tableId: target.tableId,
      where: [{ field: 'Due', operator: 'isBefore', value: { mode: 'exactDate', date: '2026-10-01' } }],
    }),
  ).toEqual({ count: 0 });
  expect(await find({ sort: [{ field: 'Missing' }] })).toMatchObject({
    messageKey: 'data.field.unknown',
    params: { field: 'Missing', fields: 'Name, Status, Count, Due' },
  });
  expect(await find({ cursor: 'invalid' })).toMatchObject({ messageKey: 'api.cursor.invalid' });
  expect(await find({ view: 'Missing' })).toMatchObject({ messageKey: 'errors.notFound' });
  expect(await find({ limit: 101 })).toMatchObject({
    messageKey: 'errors.validationFailed',
    fields: { limit: 'validation.too_big' },
  });
  expect(await find({ sort: [{ field: 'Count', dir: 'desc' }] })).toMatchObject({
    fields: { 'sort.0': 'validation.unrecognized_keys' },
  });
  expect(
    await fail(client, 'get_record', { tableId: target.tableId, recordId: newId('record') }),
  ).toMatchObject({
    messageKey: 'errors.notFound',
  });
  await expect(client.callTool({ name: 'drop_everything', arguments: {} })).rejects.toMatchObject({
    code: -32602,
    data: { messageKey: 'mcp.tool.unknown', params: { tool: 'drop_everything' } },
  });
});

it('creates, updates, and trashes records through the command bus as the token’s owner, in groups the app can undo', async () => {
  const target = await table();
  const client = await connect();
  const created = await succeed<{ records: Row[]; undoGroupId: string }>(client, 'create_records', {
    tableId: target.tableId,
    typecast: true,
    records: [
      { fields: { Name: 'Paper', status: 'Waiting', [target.field.Count!]: '3' } },
      { fields: { name: 'Pens', Due: '2026-10-15' } },
    ],
  });
  expect(created.records.map((record) => record.fields)).toEqual([
    { Name: 'Paper', Status: 'Waiting', Count: 3, Due: null },
    { Name: 'Pens', Status: null, Count: null, Due: '2026-10-15' },
  ]);
  const [paper, pens] = created.records.map((record) => record.id);
  let log = await changes(target.databaseId);
  // The new choice is a field change, in the same group as the records that use it.
  expect(log).toEqual([
    { group_id: created.undoGroupId, actor_id: server.owner.userId, kind: 'field.updated' },
    { group_id: created.undoGroupId, actor_id: server.owner.userId, kind: 'record.created' },
  ]);
  const audit = await query<{ actor_id: string; metadata: { tableId: string; count: number } }>(
    server.pool,
    sql`SELECT actor_id, metadata FROM ${ident(server.schemas.audit, 'events')}
    WHERE action = 'data.records.created' AND metadata ->> 'databaseId' = ${target.databaseId}`,
  );
  expect(audit.rows).toEqual([
    {
      actor_id: server.owner.userId,
      metadata: expect.objectContaining({ tableId: target.tableId, count: 2 }),
    },
  ]);

  const updated = await succeed<{ records: Row[]; undoGroupId: string }>(client, 'update_records', {
    tableId: target.tableId,
    records: [{ id: paper, fields: { Count: 4, Status: 'Done' } }],
  });
  expect(updated.records).toEqual([
    {
      id: paper,
      createdTime: expect.any(String),
      fields: { Name: 'Paper', Status: 'Done', Count: 4, Due: null },
    },
  ]);

  const trashed = await succeed<{ records: Row[]; undoGroupId: string }>(client, 'delete_records', {
    tableId: target.tableId,
    recordIds: [pens, pens],
  });
  expect(trashed.records.map((record) => record.fields.Name)).toEqual(['Pens']);
  expect(await succeed(client, 'count_records', { tableId: target.tableId })).toEqual({ count: 1 });
  log = await changes(target.databaseId);
  expect(log.slice(2)).toEqual([
    { group_id: updated.undoGroupId, actor_id: server.owner.userId, kind: 'record.updated' },
    { group_id: trashed.undoGroupId, actor_id: server.owner.userId, kind: 'record.trashed' },
  ]);

  for (const groupId of [trashed.undoGroupId, updated.undoGroupId]) {
    const undone = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${target.databaseId}/undo`,
      headers: server.owner.headers,
      payload: { clientId: newId('client'), commandId: newId('command'), groupId },
    });
    expect(undone.json<UndoResult>().status, undone.body).toBe('applied');
  }
  const restored = await succeed<{ records: Row[] }>(client, 'find_records', {
    tableId: target.tableId,
    sort: [{ field: 'Name' }],
  });
  expect(restored.records.map((record) => [record.fields.Name, record.fields.Count])).toEqual([
    ['Paper', 3],
    ['Pens', null],
  ]);
});

it('gives records it creates their fields’ defaults and shows each default in the schema', async () => {
  const target = await table();
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'fields')}
    SET options = options || ${JSON.stringify({ defaultValue: { kind: 'firstChoice' } })}::jsonb
    WHERE id = ${target.field.Status!}`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'fields')}
    SET options = options || ${JSON.stringify({ defaultValue: { kind: 'value', value: 2 } })}::jsonb
    WHERE id = ${target.field.Count!}`,
  );
  const client = await connect();
  const created = await succeed<{ records: Row[] }>(client, 'create_records', {
    tableId: target.tableId,
    records: [{ fields: { Name: 'Paper' } }, { fields: { Name: 'Pens', Count: null } }],
  });
  expect(created.records.map((record) => record.fields)).toEqual([
    { Name: 'Paper', Status: 'To do', Count: 2, Due: null },
    { Name: 'Pens', Status: 'To do', Count: null, Due: null },
  ]);
  const schema = await succeed<{
    tables: Array<{ fields: Array<{ name: string; options: Record<string, unknown> }> }>;
  }>(client, 'get_schema', { databaseId: target.databaseId });
  expect(schema.tables[0]!.fields.find((field) => field.name === 'Count')!.options).toMatchObject({
    defaultValue: { kind: 'value', value: 2 },
  });
});

it('refuses writes the caller can fix, with the field and value named', async () => {
  const target = await table();
  const [id] = await seed(target, [{ Name: 'Existing' }]);
  const client = await connect();
  const create = (records: unknown[], extra: Record<string, unknown> = {}) =>
    fail(client, 'create_records', { tableId: target.tableId, records, ...extra });
  expect(await create([{ fields: { Status: 'Waiting' } }])).toMatchObject({
    messageKey: 'data.value.unknownChoice',
    params: { field: 'Status', value: 'Waiting' },
  });
  expect(await create([{ fields: { Count: 'three' } }], { typecast: true })).toMatchObject({
    messageKey: 'data.value.notNumber',
    params: { field: 'Count' },
  });
  expect(await create([{ fields: { Color: 'Red' } }])).toMatchObject({
    messageKey: 'data.field.unknown',
    params: { field: 'Color', fields: 'Name, Status, Count, Due' },
  });
  // A field named twice, once by name and once by ID, is ambiguous.
  expect(await create([{ fields: { Name: 'One', [target.field.Name!]: 'Two' } }])).toMatchObject({
    messageKey: 'errors.validationFailed',
  });
  expect(await create(Array.from({ length: 101 }, () => ({ fields: {} })))).toMatchObject({
    fields: { records: 'validation.too_big' },
  });
  expect(
    await fail(client, 'update_records', {
      tableId: target.tableId,
      records: [{ id: newId('record'), fields: { Name: 'Gone' } }],
    }),
  ).toMatchObject({ messageKey: 'errors.notFound' });
  expect(
    await fail(client, 'delete_records', { tableId: target.tableId, recordIds: [newId('record')] }),
  ).toMatchObject({
    messageKey: 'errors.notFound',
  });
  expect(await succeed(client, 'get_record', { tableId: target.tableId, recordId: id })).toMatchObject({
    record: { fields: { Name: 'Existing' } },
  });
  expect(await changes(target.databaseId)).toHaveLength(1);
});

it('never shows a record or field the person can’t see, and changes nothing their role doesn’t allow', async () => {
  const target = await table();
  const [shown, hidden] = await seed(target, [
    { Name: 'Shown', Count: 1 },
    { Name: 'Hidden', Count: 2 },
  ]);
  const client = await connect();
  vi.spyOn(AccessScope.prototype, 'visibleFields').mockImplementation((_tableId, items) =>
    items.filter((item) => item.id !== target.field.Count),
  );
  vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(() => sql`__id <> ${hidden!}`);
  const schema = await succeed<{ tables: Array<{ fields: Array<{ name: string }> }> }>(client, 'get_schema', {
    databaseId: target.databaseId,
  });
  expect(schema.tables[0]!.fields.map((f) => f.name)).toEqual(['Name', 'Status', 'Due']);
  const found = await succeed<{ records: Row[] }>(client, 'find_records', { tableId: target.tableId });
  expect(found.records).toEqual([
    { id: shown, createdTime: expect.any(String), fields: { Name: 'Shown', Status: null, Due: null } },
  ]);
  expect(await succeed(client, 'count_records', { tableId: target.tableId })).toEqual({ count: 1 });
  expect(
    await fail(client, 'count_records', {
      tableId: target.tableId,
      where: [{ field: 'Count', operator: 'eq', value: 2 }],
    }),
  ).toMatchObject({ messageKey: 'data.field.unknown', params: { fields: 'Name, Status, Due' } });
  expect(await fail(client, 'get_record', { tableId: target.tableId, recordId: hidden })).toMatchObject({
    messageKey: 'errors.notFound',
  });
  expect(
    await fail(client, 'update_records', {
      tableId: target.tableId,
      records: [{ id: hidden, fields: { Name: 'Changed' } }],
    }),
  ).toMatchObject({ messageKey: 'errors.notFound' });
  expect(
    await fail(client, 'update_records', {
      tableId: target.tableId,
      records: [{ id: shown, fields: { Count: 5 } }],
    }),
  ).toMatchObject({ messageKey: 'data.field.unknown' });
  expect(
    await fail(client, 'delete_records', { tableId: target.tableId, recordIds: [hidden] }),
  ).toMatchObject({
    messageKey: 'errors.notFound',
  });
  vi.restoreAllMocks();

  // A reader's token may hold the write scope, and still only reads.
  const member = await server.addMember();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${member.info.org.id}, 'database', ${target.databaseId}, 'user', ${member.userId}, 'reader')`,
  );
  const reader = await connect(bearer(await makeToken(EVERYTHING, 'all', member)));
  expect(await succeed(reader, 'count_records', { tableId: target.tableId })).toEqual({ count: 2 });
  expect(
    await fail(reader, 'create_records', {
      tableId: target.tableId,
      records: [{ fields: { Name: 'Mine' } }],
    }),
  ).toMatchObject({ code: 'forbidden', messageKey: 'data.access.denied' });
  const outsider = await connect(bearer(await makeToken(EVERYTHING, 'all', await server.addMember())));
  expect(await fail(outsider, 'find_records', { tableId: target.tableId })).toMatchObject({
    messageKey: 'errors.notFound',
  });
  expect(await changes(target.databaseId)).toHaveLength(1);
});

it('refuses cookies, a revoked token at once, other sites’ pages, batches, and methods other than POST', async () => {
  await expect(connect(server.owner.headers)).rejects.toMatchObject({ code: 401 });
  const revocable = await makeToken([...EVERYTHING, 'schema.bases:write']);
  const client = await connect(bearer(revocable));
  expect((await client.listTools()).tools.length).toBe(57);
  const revoked = await server.app.inject({
    method: 'DELETE',
    url: `/api/tokens/${revocable.id}`,
    headers: server.owner.headers,
  });
  expect(revoked.statusCode).toBe(204);
  await expect(client.listTools()).rejects.toMatchObject({ code: 401 });
  await expect(client.callTool({ name: 'list_databases', arguments: {} })).rejects.toMatchObject({
    code: 401,
  });

  // Fastify has already parsed the body, and the transport answers from it.
  const answered = await post(initialize(), { 'content-type': 'application/json; charset=utf-8' });
  expect(answered.statusCode, answered.body).toBe(200);
  expect(answered.headers['cache-control']).toBe('no-store');
  expect(answered.json()).toMatchObject({ id: 1, result: { serverInfo: { name: 'riosoma' } } });
  // The server's own pages may call it, with or without the default port written out.
  for (const origin of ['http://localhost', 'http://localhost:80'])
    expect((await post(initialize(), { origin })).statusCode, origin).toBe(200);

  const refused = await post(initialize(), { cookie: server.owner.headers.cookie, authorization: '' });
  expect(refused.statusCode).toBe(401);
  expect(refused.json()).toMatchObject({
    jsonrpc: '2.0',
    id: null,
    error: { message: expect.any(String), data: { messageKey: 'errors.tokenInvalid' } },
  });
  expect(refused.body).not.toContain(server.owner.headers.cookie);
  for (const origin of ['https://elsewhere.example', 'http://localhost:8080', 'null']) {
    const elsewhere = await post(initialize(), { origin });
    expect(elsewhere.statusCode, origin).toBe(403);
    expect(elsewhere.json()).toMatchObject({ error: { data: { messageKey: 'mcp.origin' } } });
  }
  const batch = await post([initialize(1), initialize(2)]);
  expect(batch.statusCode).toBe(400);
  expect(batch.json()).toMatchObject({ error: { code: -32600, data: { messageKey: 'mcp.batch' } } });
  const broken = await post('{', {});
  expect(broken.statusCode).toBe(400);
  const unparsed = await server.app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      ...bearer(),
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    payload: '{"jsonrpc":',
  });
  expect(unparsed.statusCode).toBe(400);
  expect(unparsed.json()).toMatchObject({ error: { code: -32700 } });
  for (const method of ['GET', 'DELETE'] as const) {
    const response = await server.app.inject({ method, url: '/mcp', headers: bearer() });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(response.json()).toMatchObject({ error: { data: { messageKey: 'mcp.method' } } });
  }
  expect((await server.app.inject({ method: 'GET', url: '/mcp' })).statusCode).toBe(401);
});

it('stops a call at its deadline and reports a failure without anything internal in it', async () => {
  const target = await table();
  const client = await connect();
  const limit = MCP_LIMITS.callMs;
  MCP_LIMITS.callMs = 100;
  try {
    vi.spyOn(RecordReader.prototype, 'read').mockImplementation(() => new Promise<never>(() => undefined));
    await expect(
      client.callTool({ name: 'count_records', arguments: { tableId: target.tableId } }),
    ).rejects.toMatchObject({ code: -32603, data: { messageKey: 'mcp.deadline' } });
    // A change past its deadline may still finish, and the caller is told to check.
    vi.spyOn(AccessScope.prototype, 'require').mockImplementation(() => new Promise<never>(() => undefined));
    await expect(
      client.callTool({
        name: 'create_records',
        arguments: { tableId: target.tableId, records: [{ fields: {} }] },
      }),
    ).rejects.toMatchObject({ code: -32603, data: { messageKey: 'mcp.deadline.write' } });
  } finally {
    MCP_LIMITS.callMs = limit;
    vi.restoreAllMocks();
  }
  vi.spyOn(RecordReader.prototype, 'read').mockRejectedValue(
    new Error('relation "private_table" does not exist'),
  );
  const failure = await client
    .callTool({ name: 'count_records', arguments: { tableId: target.tableId } })
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(failure).toMatchObject({
    code: -32603,
    message: expect.stringContaining('An internal error occurred.'),
    data: { messageKey: 'errors.internal' },
  });
  expect(JSON.stringify(failure)).not.toContain('private_table');
  expect(String(failure)).not.toContain('private_table');
});

it('refuses updates and proposals containing both existing and missing records', async () => {
  const target = await table();
  const [id] = await seed(target, [{ Name: 'Before', Count: 1 }]);
  const writer = await connect();
  const before = await changes(target.databaseId);
  const args = {
    tableId: target.tableId,
    records: [
      { id, fields: { Name: 'After' } },
      { id: newId('record'), fields: { Name: 'Missing' } },
    ],
  };
  const update = await fail(writer, 'update_records', args);
  expect(update).toMatchObject({ code: 'not_found' });
  expect(await fail(writer, 'propose_record_update', args)).toEqual(update);
  const result = await succeed<{ record: Row }>(writer, 'get_record', {
    tableId: target.tableId,
    recordId: id,
  });
  expect(result.record.fields).toMatchObject({ Name: 'Before', Count: 1 });
  expect(await changes(target.databaseId)).toEqual(before);
});

it('refuses proposals without write scope or with invalid values and leaves records unchanged', async () => {
  const target = await table();
  const [id] = await seed(target, [{ Name: 'Before', Count: 1 }]);
  const reader = await connect(bearer(await makeToken(READS)));
  expect((await reader.listTools()).tools.map((tool) => tool.name)).not.toContain('propose_record_update');
  expect(
    await fail(reader, 'propose_record_update', {
      tableId: target.tableId,
      records: [{ id, fields: { Name: 'After' } }],
    }),
  ).toMatchObject({ messageKey: 'errors.tokenScope' });
  const writer = await connect();
  expect(
    await fail(writer, 'propose_record_update', {
      tableId: target.tableId,
      records: [{ id, fields: { Count: 'invalid' } }],
    }),
  ).toMatchObject({ messageKey: 'data.value.notNumber' });
  const result = await succeed<{ record: Row }>(writer, 'get_record', {
    tableId: target.tableId,
    recordId: id,
  });
  expect(result.record.fields).toMatchObject({ Name: 'Before', Count: 1 });
});

it('refuses values that violate a field rule through the record tools', async () => {
  const target = await table();
  const saved = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${target.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.update',
          fieldId: target.field.Name,
          options: { validation: { minLength: { value: 4 } } },
        },
      ],
    },
  });
  expect(saved.statusCode).toBe(200);
  const client = await connect();
  const failure = await fail(client, 'create_records', {
    tableId: target.tableId,
    records: [{ fields: { Name: 'No' } }],
  });
  expect(failure).toMatchObject({
    code: 'validation_failed',
    fields: { [target.field.Name!]: 'data.validation.minLength' },
  });
});

it('arranges a gallery through the API and record tool with shared order and one undo action', async () => {
  const target = await table();
  const ids = await seed(target, [{ Name: 'First' }, { Name: 'Second' }, { Name: 'Third' }]);
  const viewId = newId('view');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${target.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: { id: viewId, tableId: target.tableId, name: 'Cards', type: 'gallery', config: {} },
        },
      ],
    },
  });
  expect(created.json().results[0].status).toBe('applied');
  const moved = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${target.tableId}/records/move`,
    headers: bearer(),
    payload: { viewId, recordIds: [ids[2]], place: { before: ids[0] } },
  });
  expect(moved.statusCode, moved.body).toBe(200);
  expect(moved.headers['x-undo-group-id']).toBe(moved.json().undoGroupId);
  const readOrder = async () => {
    const read = await server.app.inject({
      url: `/api/v1/tables/${target.tableId}/records?view=${viewId}&shape=list`,
      headers: bearer(),
    });
    expect(read.statusCode).toBe(200);
    return read.json<{ records: Array<{ Name: string }> }>().records.map((row) => row.Name);
  };
  expect(await readOrder()).toEqual(['Third', 'First', 'Second']);
  const client = await connect();
  const result = await succeed<{ undoGroupId: string }>(client, 'move_records', {
    tableId: target.tableId,
    viewId,
    recordIds: [ids[1]],
    place: { before: ids[2] },
  });
  expect(await readOrder()).toEqual(['Second', 'Third', 'First']);
  const undone = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${target.databaseId}/undo`,
    headers: server.owner.headers,
    payload: { clientId: newId('client'), commandId: newId('command'), groupId: result.undoGroupId },
  });
  expect(undone.statusCode).toBe(200);
  expect(await readOrder()).toEqual(['Third', 'First', 'Second']);
  const reader = await connect(bearer(await makeToken(READS)));
  expect(
    await fail(reader, 'move_records', {
      tableId: target.tableId,
      viewId,
      recordIds: [ids[1]],
      place: { before: ids[0] },
    }),
  ).toMatchObject({ messageKey: 'errors.tokenScope' });
});

it('round-trips a cell comment through REST and MCP with token scope enforcement', async () => {
  const target = await table();
  const [recordId] = await seed(target, [{ Name: 'Review' }]);
  const client = await connect();
  const id = newId('comment');
  expect(
    await succeed(client, 'create_comment', {
      tableId: target.tableId,
      recordId,
      comment: { id, body: 'Check status', fieldId: target.field.Status },
    }),
  ).toEqual({ commentId: id });
  const url = `/api/v1/tables/${target.tableId}/records/${recordId}/comments`;
  const rest = await server.app.inject({ method: 'GET', url, headers: bearer() });
  expect(rest.statusCode, rest.body).toBe(200);
  expect(rest.json()).toMatchObject({
    comments: [{ id, fieldId: target.field.Status, body: 'Check status' }],
  });
  const posted = await server.app.inject({
    method: 'POST',
    url,
    headers: bearer(),
    payload: { id: newId('comment'), body: 'Record note' },
  });
  expect(posted.statusCode, posted.body).toBe(200);
  expect(await succeed(client, 'get_comments', { tableId: target.tableId, recordId })).toMatchObject({
    comments: [{ fieldId: target.field.Status }, { body: 'Record note' }],
  });
  const reader = await connect(bearer(await makeToken(READS)));
  expect(
    await fail(reader, 'create_comment', {
      tableId: target.tableId,
      recordId,
      comment: { id: newId('comment'), body: 'No' },
    }),
  ).toMatchObject({ messageKey: 'errors.tokenScope' });
  expect(
    (await changes(target.databaseId)).filter((change) => change.kind === 'comment.created'),
  ).toHaveLength(2);
});

it('lists, creates, updates, and deletes named functions through scoped commands', async () => {
  const target = await table();
  const client = await connect(bearer(await makeToken([...EVERYTHING, 'schema.bases:write'])));
  const input = {
    name: 'DOUBLE',
    parameters: ['amount'],
    body: 'amount * 2',
    description: 'Double an amount',
  };
  const created = await succeed<NamedFunctionResult>(client, 'create_named_function', {
    databaseId: target.databaseId,
    input,
  });
  const functionId = created.definition!.id;
  expect(created.definition).toMatchObject({ ...input, revision: 1 });
  expect(await succeed(client, 'list_named_functions', { databaseId: target.databaseId })).toEqual({
    namedFunctions: [created.definition],
  });
  expect(
    await fail(client, 'update_named_function', {
      databaseId: target.databaseId,
      functionId,
      input: { definition: input, revision: 2 },
    }),
  ).toMatchObject({ code: 'conflict' });
  const updated = await succeed<NamedFunctionResult>(client, 'update_named_function', {
    databaseId: target.databaseId,
    functionId,
    input: { definition: { ...input, name: 'TRIPLE', body: 'amount * 3' }, revision: 1 },
  });
  expect(updated.definition).toMatchObject({ name: 'TRIPLE', revision: 2 });
  const removed = await succeed<NamedFunctionResult>(client, 'delete_named_function', {
    databaseId: target.databaseId,
    functionId,
    input: { revision: 2 },
  });
  expect(removed.definition).toBeNull();
  expect(removed.undoGroupId).toMatch(/^act/);
  expect(await succeed(client, 'list_named_functions', { databaseId: target.databaseId })).toEqual({
    namedFunctions: [],
  });
  const reader = await connect(bearer(await makeToken(['schema.bases:read'])));
  expect(await fail(reader, 'create_named_function', { databaseId: target.databaseId, input })).toMatchObject(
    { code: 'forbidden', messageKey: 'errors.tokenScope' },
  );
});

it('proposes and applies ordered joined-column mappings through MCP and REST', async () => {
  const base = await table();
  await seed(base, [
    { Name: 'One', Count: 1 },
    { Name: 'Two', Count: 2 },
    { Name: 'Three', Count: 3 },
  ]);
  const authorization = bearer(await makeToken([...EVERYTHING, 'schema.bases:write']));
  const client = await connect(authorization);
  const other = await succeed<SchemaTableResult>(client, 'create_table', {
    databaseId: base.databaseId,
    input: {
      name: 'Second source',
      fields: [
        { name: 'Source key', type: 'text' },
        { name: 'Count', type: 'number' },
      ],
    },
  });
  const side = other.table!;
  const second = other.table!.fields;
  await succeed(client, 'create_records', {
    tableId: side.id,
    records: [
      { fields: { 'Source key': 'One', Count: 1 } },
      { fields: { 'Source key': 'Two', Count: 2 } },
      { fields: { 'Source key': 'Three', Count: 3 } },
    ],
  });
  const input = {
    baseTableId: base.tableId,
    steps: [
      {
        tableId: side.id,
        leftTableId: base.tableId,
        leftFieldId: base.field.Name,
        rightFieldId: second[0]!.id,
        kind: 'full',
      },
    ],
  };
  const proposed = await succeed<ColumnSuggestions>(client, 'suggest_joined_columns', {
    databaseId: base.databaseId,
    ...input,
  });
  expect(proposed.suggestions).toHaveLength(2);
  const rest = await server.app.inject({
    method: 'POST',
    url: `/api/v1/databases/${base.databaseId}/column-suggestions`,
    headers: authorization,
    payload: input,
  });
  expect(rest.statusCode, rest.body).toBe(200);
  expect(rest.json().suggestions).toEqual(proposed.suggestions);
  const fields = [
    { id: newId('field'), name: 'Key', type: 'text' },
    { id: newId('field'), name: 'Count', type: 'number' },
  ];
  const joined = {
    ...input,
    fields: proposed.suggestions.map((suggestion, index) => ({
      ...suggestion.sources[0]!,
      sources: suggestion.sources,
      outputFieldId: fields[index]!.id,
    })),
  };
  const id = newId('table');
  const created = await succeed<CommandBatchResult>(client, 'create_joined_table', {
    databaseId: base.databaseId,
    table: { id, name: 'Mapped sources', fields, view: { id: newId('view'), name: 'Grid' }, joined },
  });
  expect(created.results[0]?.status).toBe('applied');
  const updated = await succeed<CommandBatchResult>(client, 'configure_joined_columns', {
    tableId: id,
    joined: {
      ...joined,
      fields: joined.fields.map((mapping) => ({
        ...mapping.sources[1]!,
        outputFieldId: mapping.outputFieldId,
        sources: [...mapping.sources].reverse(),
      })),
    },
  });
  expect(updated.results[0]?.status).toBe('applied');
  const extra = { id: newId('field'), name: 'Second count', type: 'number' };
  const split = {
    ...joined,
    fields: [
      joined.fields[0]!,
      { tableId: base.tableId, fieldId: base.field.Count, outputFieldId: fields[1]!.id },
      { tableId: side.id, fieldId: second[1]!.id, outputFieldId: extra.id },
    ],
  };
  const splitFields = [...fields, extra];
  const splitRest = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/tables/${id}/joined-columns`,
    headers: authorization,
    payload: { ...split, joinedFields: splitFields },
  });
  expect(splitRest.statusCode, splitRest.body).toBe(200);
  expect(splitRest.json<CommandBatchResult>().results[0]?.status, splitRest.body).toBe('applied');
  const widenRest = await server.app.inject({
    method: 'PATCH',
    url: `/api/v1/tables/${id}/joined-columns`,
    headers: authorization,
    payload: { ...split, joinedFields: splitFields.map((field) => ({ ...field, type: 'text' })) },
  });
  expect(widenRest.statusCode, widenRest.body).toBe(200);
  expect(widenRest.json<CommandBatchResult>().results[0]?.status, widenRest.body).toBe('applied');
  const merged = await succeed<CommandBatchResult>(client, 'configure_joined_columns', {
    tableId: id,
    joined,
    joinedFields: fields.map((field) => ({ ...field, type: 'text' })),
  });
  expect(merged.results[0]?.status).toBe('applied');
  const mcpExtra = { ...extra, id: newId('field') };
  const splitMcp = await succeed<CommandBatchResult>(client, 'configure_joined_columns', {
    tableId: id,
    joined: {
      ...split,
      fields: split.fields.map((mapping) => ({
        ...mapping,
        outputFieldId: mapping.outputFieldId === extra.id ? mcpExtra.id : mapping.outputFieldId,
      })),
    },
    joinedFields: [...fields.map((field) => ({ ...field, type: 'text' })), mcpExtra],
  });
  expect(splitMcp.results[0]?.status).toBe('applied');
  expect(
    await fail(await connect(bearer(await makeToken(READS))), 'suggest_joined_columns', {
      databaseId: base.databaseId,
      ...input,
    }),
  ).toMatchObject({ messageKey: 'errors.tokenScope' });
});
