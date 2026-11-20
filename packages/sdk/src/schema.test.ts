import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { FieldMeta, newId, ViewMeta } from '@riosoma/contracts';
import {
  RioClient,
  type SchemaFieldCreate,
  type SchemaFieldResult,
  type SchemaFieldUpdate,
  type SchemaTableCreate,
  type SchemaTableResult,
  type SchemaTableUpdate,
  type SchemaTrashResult,
  type SchemaViewCreate,
  type SchemaViewResult,
  type SchemaViewUpdate,
} from './index.js';

let server: Server;
let client: RioClient;
let answer: { status: number; body: unknown };
const requests: Array<{ method: string; path: string; authorization?: string; body?: unknown }> = [];
const token = randomBytes(32).toString('base64url');

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      requests.push({
        method: request.method!,
        path: request.url!,
        authorization: request.headers.authorization,
        ...(text ? { body: JSON.parse(text) } : {}),
      });
      response.writeHead(answer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  client = new RioClient({ baseUrl: `http://127.0.0.1:${port}/prefix`, token });
});
beforeEach(() => {
  requests.length = 0;
  answer = { status: 200, body: null };
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const at = '2026-10-01T12:00:00.000Z';
const tableId = newId('table');
const field = FieldMeta.parse({
  id: newId('field'),
  tableId,
  name: 'Title',
  description: '',
  type: 'text',
  position: 0,
  createdAt: at,
  updatedAt: at,
});
const view = ViewMeta.parse({
  id: newId('view'),
  tableId,
  name: 'Grid',
  type: 'grid',
  config: {},
  position: 0,
  createdBy: null,
  createdAt: at,
  updatedAt: at,
});
const undoGroupId = newId('action');
const tableResult: SchemaTableResult = {
  table: {
    id: tableId,
    databaseId: newId('database'),
    name: 'Tasks',
    description: '',
    primaryFieldId: field.id,
    fields: [field],
    views: [view],
    position: 0,
    createdAt: at,
    updatedAt: at,
  },
  undoGroupId,
};
const fieldResult: SchemaFieldResult = { field, undoGroupId };
const viewResult: SchemaViewResult = { view, undoGroupId };
const tableInput: SchemaTableCreate = {
  name: 'Tasks',
  fields: [
    { name: 'Title', type: 'text' },
    {
      name: 'Status',
      type: 'singleSelect',
      options: { choices: [{ name: 'Open' }] },
    },
  ],
};
const tableChange: SchemaTableUpdate = { name: 'Work', description: 'Scheduled work', index: 0 };
const fieldInput: SchemaFieldCreate = {
  name: 'Status',
  type: 'singleSelect',
  options: { choices: [{ name: 'Open' }] },
};
const fieldChange: SchemaFieldUpdate = { name: 'Budget', type: 'currency', options: { code: 'USD' } };
const viewInput: SchemaViewCreate = { name: 'Gallery', type: 'gallery' };
const viewChange: SchemaViewUpdate = { name: 'First', index: 0, fieldOrder: [field.id] };

type Result = SchemaTableResult | SchemaFieldResult | SchemaViewResult | SchemaTrashResult;
interface Write {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  result: Result;
  call(signal?: AbortSignal): Promise<Result>;
}
const writes: Write[] = [
  {
    name: 'tables.create',
    method: 'POST',
    path: '/api/v1/databases/db%2Fspace%20%3F%23/tables',
    body: tableInput,
    result: tableResult,
    call: (signal) => client.tables.create('db/space ?#', tableInput, { signal }),
  },
  {
    name: 'tables.update',
    method: 'PATCH',
    path: '/api/v1/tables/tbl%2Fspace%20%3F%23',
    body: tableChange,
    result: tableResult,
    call: (signal) => client.tables.update('tbl/space ?#', tableChange, { signal }),
  },
  {
    name: 'tables.trash',
    method: 'DELETE',
    path: '/api/v1/tables/tbl%2Fspace%20%3F%23',
    result: { id: tableId, undoGroupId },
    call: (signal) => client.tables.trash('tbl/space ?#', { signal }),
  },
  {
    name: 'fields.create',
    method: 'POST',
    path: '/api/v1/tables/tbl%2Fspace%20%3F%23/fields',
    body: fieldInput,
    result: fieldResult,
    call: (signal) => client.fields.create('tbl/space ?#', fieldInput, { signal }),
  },
  {
    name: 'fields.update',
    method: 'PATCH',
    path: '/api/v1/fields/fld%2Fspace%20%3F%23',
    body: fieldChange,
    result: fieldResult,
    call: (signal) => client.fields.update('fld/space ?#', fieldChange, { signal }),
  },
  {
    name: 'fields.trash',
    method: 'DELETE',
    path: '/api/v1/fields/fld%2Fspace%20%3F%23',
    result: { id: field.id, undoGroupId },
    call: (signal) => client.fields.trash('fld/space ?#', { signal }),
  },
  {
    name: 'views.create',
    method: 'POST',
    path: '/api/v1/tables/tbl%2Fspace%20%3F%23/views',
    body: viewInput,
    result: viewResult,
    call: (signal) => client.views.create('tbl/space ?#', viewInput, { signal }),
  },
  {
    name: 'views.update',
    method: 'PATCH',
    path: '/api/v1/views/viw%2Fspace%20%3F%23',
    body: viewChange,
    result: viewResult,
    call: (signal) => client.views.update('viw/space ?#', viewChange, { signal }),
  },
  {
    name: 'views.trash',
    method: 'DELETE',
    path: '/api/v1/views/viw%2Fspace%20%3F%23',
    result: { id: view.id, undoGroupId },
    call: (signal) => client.views.trash('viw/space ?#', { signal }),
  },
];

it.each(writes)('$name sends the REST contract and returns its result and undo group', async (write) => {
  answer.body = write.result;
  expect(await write.call()).toEqual(write.result);
  expect(requests).toEqual([
    {
      method: write.method,
      path: `/prefix${write.path}`,
      authorization: `Bearer ${token}`,
      ...(write.body === undefined ? {} : { body: write.body }),
    },
  ]);
});

it.each(writes)('$name preserves scope and validation refusals', async (write) => {
  for (const [status, code, messageKey] of [
    [403, 'forbidden', 'errors.tokenScope'],
    [422, 'validation_failed', 'data.link.targetChange'],
  ] as const) {
    answer = { status, body: { error: { code, messageKey, message: 'Refused' } } };
    await expect(write.call()).rejects.toMatchObject({ status, code, messageKey });
  }
  expect(requests).toHaveLength(2);
});

it.each(writes)('$name honors cancellation before sending a write', async (write) => {
  const controller = new AbortController();
  controller.abort();
  await expect(write.call(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(requests).toEqual([]);
});

it('keeps null results when a changed schema item is no longer visible', async () => {
  for (const [call, body] of [
    [() => client.tables.update(tableId, tableChange), { table: null, undoGroupId }],
    [() => client.fields.update(field.id, fieldChange), { field: null, undoGroupId }],
    [() => client.views.update(view.id, viewChange), { view: null, undoGroupId }],
  ] as const) {
    answer.body = body;
    expect(await call()).toEqual(body);
  }
});

it('lists and changes named functions with revisions and delete confirmation', async () => {
  const databaseId = newId('database');
  const functionId = newId('namedFunction');
  const input = {
    name: 'DOUBLE',
    parameters: ['amount'],
    body: 'amount * 2',
    description: 'Double an amount',
  };
  const definition = {
    ...input,
    id: functionId,
    databaseId,
    revision: 1,
    createdBy: null,
    updatedBy: null,
    createdAt: at,
    updatedAt: at,
  };
  const path = `/prefix/api/v1/databases/${databaseId}/named-functions`;
  answer.body = { namedFunctions: [definition] };
  expect(await client.namedFunctions.list(databaseId)).toEqual([definition]);
  answer.body = { definition, undoGroupId };
  expect(await client.namedFunctions.create(databaseId, input)).toEqual(answer.body);
  await client.namedFunctions.update(databaseId, functionId, { definition: input, revision: 1 });
  answer.body = { definition: null, undoGroupId };
  expect(
    await client.namedFunctions.delete(databaseId, functionId, { revision: 2, confirmUsed: true }),
  ).toEqual(answer.body);
  expect(requests.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
    { method: 'GET', path, body: undefined },
    { method: 'POST', path, body: input },
    { method: 'PATCH', path: `${path}/${functionId}`, body: { definition: input, revision: 1 } },
    { method: 'DELETE', path: `${path}/${functionId}`, body: { revision: 2, confirmUsed: true } },
  ]);
});
