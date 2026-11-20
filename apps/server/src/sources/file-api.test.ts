import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  SourceConnection,
  newId,
  type SourceMeta,
  type CommandBatchResult,
  type RowsPage,
} from '@riosoma/contracts';
import {
  createGraphQlConnector,
  createODataConnector,
  registerConnector,
  type FileNetwork,
  type FileRequest,
} from '@riosoma/connectors';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { checkFileAddress, fileNetwork } from './files.js';
import { checkApiAddress } from './rest.js';
import * as outbound from '../automations/outbound.js';

let kit: TestPostgres;
let server: ServerFixture;
const secret = randomBytes(20).toString('hex');
const requests: FileRequest[] = [];
const baseUrl = 'https://192.0.2.1/service';
const metadata =
  '<Edmx><DataServices><Schema Namespace="Sample"><EntityType Name="Item"><Key><PropertyRef Name="id"/></Key><Property Name="id" Type="Edm.Int32" Nullable="false"/><Property Name="name" Type="Edm.String"/></EntityType><EntityContainer Name="Default"><EntitySet Name="Items" EntityType="Sample.Item"/></EntityContainer></Schema></DataServices></Edmx>';
const network: FileNetwork = {
  allowsAddress: () => true,
  check: async () => ({ address: '192.0.2.1', family: 4 }),
  async request(request) {
    requests.push(request);
    let body: string;
    if (request.url.pathname.endsWith('$metadata')) body = metadata;
    else if (request.method === 'POST')
      body = JSON.stringify({
        data: {
          __schema: {
            types: [{ name: 'Item', fields: [{ name: 'id', type: { kind: 'SCALAR', name: 'Int' } }] }],
          },
        },
      });
    else
      body = JSON.stringify({
        value: [
          { id: 2, name: 'Second' },
          { id: 3, name: 'Third' },
        ],
      });
    return {
      status: 200,
      url: request.url,
      headers: {},
      close() {},
      body: (async function* () {
        yield Buffer.from(body);
      })(),
    };
  },
};
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'fileapisources', { automationsAllowPrivateHosts: true });
  registerConnector(createGraphQlConnector({ network }));
  registerConnector(createODataConnector({ network }));
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

it('keeps saved introspection on its stored target and refuses readers without source administration', async () => {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'Graph records',
      connection: {
        kind: 'graphql',
        baseUrl,
        query: '{ items { id } }',
        records: 'data.items',
        auth: { method: 'header', name: 'X-Key' },
      },
      secrets: { apiKey: secret },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(created.body).not.toContain(secret);
  const source = created.json<SourceMeta>();
  const member = await server.addMember();
  const denied = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/graphql-suggestions`,
    headers: member.headers,
    payload: {},
  });
  expect(denied.statusCode).toBe(403);
  const result = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/graphql-suggestions`,
    headers: server.owner.headers,
    payload: { connection: { baseUrl: 'https://192.0.2.2/' } },
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toMatchObject([{ name: 'Item.id' }]);
  expect(requests.at(-1)?.url.origin).toBe(new URL(baseUrl).origin);
  expect(requests.at(-1)?.headers['X-Key']).toBe(secret);
  const moved = await server.app.inject({
    method: 'PATCH',
    url: `/api/sources/${source.id}`,
    headers: server.owner.headers,
    payload: { connection: { ...source.connection, baseUrl: 'https://192.0.2.2/' } },
  });
  expect(moved.statusCode).toBe(422);
});

it('creates a live OData table through commands and reads projected rows through the shared reader', async () => {
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: {
      name: 'OData records',
      connection: { kind: 'odata', baseUrl, requestsPerSecond: 100 },
      secrets: {},
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  const source = created.json<SourceMeta>();
  const databaseId = newId('database');
  const database = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Live records',
      table: {
        id: newId('table'),
        name: 'Notes',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(database.statusCode, database.body).toBe(200);
  const tableId = newId('table'),
    viewId = newId('view'),
    nameId = newId('field');
  const command = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'table.create',
          table: {
            id: tableId,
            name: 'Remote',
            source: {
              sourceId: source.id,
              select: { kind: 'object', object: { schema: null, name: 'Items' } },
              keyColumns: ['id'],
              everyMinutes: null,
              freshness: 'live',
            },
            fields: [
              {
                id: nameId,
                name: 'Name',
                type: 'text',
                source: { column: 'name', sourceType: 'Edm.String' },
              },
            ],
            view: { id: viewId, name: 'Grid' },
            records: [],
          },
        },
      ],
    },
  });
  expect(command.statusCode, command.body).toBe(200);
  expect(command.json<CommandBatchResult>().results[0]).toMatchObject({ status: 'applied' });
  const result = await server.app.inject({
    method: 'GET',
    url: `/api/views/${viewId}/rows?limit=20`,
    headers: server.owner.headers,
  });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json<RowsPage>().rows.map((row) => row?.values[nameId])).toEqual(['Second', 'Third']);
  expect(
    requests.some(
      (request) => request.url.searchParams.has('$select') && request.url.searchParams.has('$top'),
    ),
  ).toBe(true);
  const member = await server.addMember();
  const denied = await server.app.inject({
    method: 'GET',
    url: `/api/views/${viewId}/rows`,
    headers: member.headers,
  });
  expect([403, 404]).toContain(denied.statusCode);
});

it('applies network guards to WebDAV and both API kinds', async () => {
  const config = { production: true, automationsAllowPrivateHosts: false };
  for (const kind of ['graphql', 'odata'] as const) {
    const connection = SourceConnection.parse({
      kind,
      baseUrl: 'https://127.0.0.1/',
      query: '{ rows }',
      records: 'data.rows',
    });
    expect(() => checkApiAddress(connection, config)).toThrow();
  }
  const webdav = SourceConnection.parse({ kind: 'webdav', url: 'https://127.0.0.1/' });
  expect(() => checkFileAddress(webdav, config)).toThrow();
  const guarded = fileNetwork({
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    allowPrivate: () => false,
  });
  await expect(
    guarded.request({
      url: new URL('https://127.0.0.1/'),
      method: 'PROPFIND',
      headers: {},
      body: '<propfind/>',
      maxBytes: 1000,
      idleMs: 100,
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toHaveProperty('problem', 'blocked');
});

it('journals source commands, seals undo credentials, and refuses stale or unauthorized undo', async () => {
  const send = (action: unknown, id = newId('command'), headers = server.owner.headers) =>
    server.app.inject({ method: 'POST', url: '/api/source-commands', headers, payload: { id, action } });
  const id = newId('command');
  const action = {
    kind: 'create',
    input: {
      name: 'Undo records',
      connection: {
        kind: 'graphql',
        baseUrl,
        query: '{ items { id } }',
        records: 'data.items',
        auth: { method: 'header', name: 'X-Key' },
      },
      secrets: { apiKey: secret },
    },
  };
  const created = await send(action, id);
  expect(created.statusCode, created.body).toBe(200);
  const first = created.json<{ id: string; source: SourceMeta }>();
  const replay = await send(action, id);
  expect(replay.json()).toMatchObject({ id, status: 'duplicate', source: { id: first.source.id } });
  const edited = await send({
    kind: 'update',
    sourceId: first.source.id,
    input: { name: 'Updated records' },
  });
  expect(edited.statusCode, edited.body).toBe(200);
  const member = await server.addMember();
  expect(
    (await send({ kind: 'undo', commandId: edited.json().id }, undefined, member.headers)).statusCode,
  ).toBe(403);
  expect((await send({ kind: 'undo', commandId: id })).statusCode).toBe(409);
  const restored = await send({ kind: 'undo', commandId: edited.json().id });
  expect(restored.statusCode, restored.body).toBe(200);
  expect(restored.json().source.name).toBe('Undo records');
  expect((await send({ kind: 'undo', commandId: edited.json().id })).statusCode).toBe(409);
  const deleted = await send({ kind: 'delete', sourceId: first.source.id });
  expect(deleted.statusCode, deleted.body).toBe(200);
  const undeleted = await send({ kind: 'undo', commandId: deleted.json().id });
  expect(undeleted.statusCode, undeleted.body).toBe(200);
  expect(undeleted.json().source).toMatchObject({ id: first.source.id, name: 'Undo records' });
  const introspected = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${first.source.id}/graphql-suggestions`,
    headers: server.owner.headers,
  });
  expect(introspected.statusCode, introspected.body).toBe(200);
  expect(requests.at(-1)?.headers['X-Key']).toBe(secret);
  const journal = await server.pool.query(
    `SELECT result FROM "${server.schemas.app}".commands WHERE id = $1`,
    [edited.json().id],
  );
  expect(JSON.stringify(journal.rows)).not.toContain(secret);
  expect(journal.rows[0].result.before.sealed_secrets).toBeTruthy();
  expect(restored.body).not.toContain('sealed_secrets');
  const audit = await server.pool.query(
    `SELECT action FROM "${server.schemas.audit}".events WHERE metadata->>'commandId' = $1`,
    [restored.json().id],
  );
  expect(audit.rows).toEqual([{ action: 'data.source.undone' }]);
});

it.each([
  ['delete', 'dns'],
  ['update', 'dns'],
  ['delete', 'ftp'],
  ['update', 'ftp'],
  ['delete', 'graphql'],
  ['update', 'graphql'],
] as const)('rechecks the %s undo connection after the %s policy changes', async (change, policy) => {
  const config = server.app.ctx.config;
  const original = {
    production: config.production,
    automationsAllowPrivateHosts: config.automationsAllowPrivateHosts,
  };
  const resolve = vi
    .spyOn(outbound, 'systemResolve')
    .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  const send = (action: unknown) =>
    server.app.inject({
      method: 'POST',
      url: '/api/source-commands',
      headers: server.owner.headers,
      payload: { id: newId('command'), action },
    });
  try {
    config.production = true;
    config.automationsAllowPrivateHosts = policy !== 'dns';
    const connection =
      policy === 'graphql'
        ? {
            kind: 'graphql',
            baseUrl: 'http://127.0.0.1/service',
            query: '{ items { id } }',
            records: 'data.items',
          }
        : {
            kind: policy === 'ftp' ? 'ftp' : 'ftps',
            host: policy === 'ftp' ? 'localhost' : `${randomBytes(8).toString('hex')}.invalid`,
            user: 'reader',
            path: 'exports/*.csv',
          };
    const input = { name: 'Restored files', connection, secrets: { password: secret } };
    const created = await send({ kind: 'create', input });
    expect(created.statusCode, created.body).toBe(200);
    const sourceId = created.json().source.id;
    const changed = await send({ kind: change, sourceId, input: { name: 'Changed files' } });
    expect(changed.statusCode, changed.body).toBe(200);
    config.automationsAllowPrivateHosts = false;
    if (policy === 'dns') resolve.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    const error = {
      code: 'validation_failed',
      messageKey:
        policy === 'dns'
          ? 'sources.file.blocked'
          : policy === 'ftp'
            ? 'sources.file.ftp'
            : 'sources.rest.https',
    };
    const saved = await send({ kind: 'create', input });
    expect(saved.statusCode, saved.body).toBe(422);
    expect(saved.json()).toMatchObject({ error: { code: error.code } });
    const undone = await send({ kind: 'undo', commandId: changed.json().id });
    expect(undone.statusCode, undone.body).toBe(422);
    expect(undone.json()).toMatchObject({ error });
    const listed = await server.app.inject({ url: '/api/sources', headers: server.owner.headers });
    const source = listed.json<SourceMeta[]>().find((entry) => entry.id === sourceId);
    if (change === 'delete') expect(source).toBeUndefined();
    else expect(source?.name).toBe('Changed files');
    config.automationsAllowPrivateHosts = true;
    const restored = await send({ kind: 'undo', commandId: changed.json().id });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json()).toMatchObject({
      status: 'applied',
      source: { id: sourceId, name: input.name, connection },
    });
    expect(restored.body).not.toContain(secret);
    expect((await send({ kind: 'delete', sourceId })).statusCode).toBe(200);
  } finally {
    Object.assign(config, original);
    resolve.mockRestore();
  }
});

it('reauthorizes command replay and audits changes in the source creator unit', async () => {
  const manager = await server.addMember({ name: 'Source manager' });
  const maker = await server.addMember({ name: 'Source creator' });
  const ownerCall = async (method: 'POST' | 'PUT', url: string, payload: unknown) => {
    const response = await server.app.inject({
      method,
      url,
      headers: server.owner.headers,
      payload: payload as Record<string, unknown>,
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response;
  };
  const root = (await ownerCall('POST', '/api/org/units', { name: 'Source group', parentId: null })).json();
  const child = (
    await ownerCall('POST', '/api/org/units', { name: 'Source child', parentId: root.id })
  ).json();
  const outside = (
    await ownerCall('POST', '/api/org/units', { name: 'Other source group', parentId: null })
  ).json();
  for (const [person, unit] of [
    [manager, root],
    [maker, child],
  ] as const) {
    await ownerCall('PUT', `/api/org/members/${person.userId}/unit`, { unitId: unit.id });
    await ownerCall('PUT', `/api/org/units/${unit.id}/admins/${person.userId}`, { roles: ['data_sources'] });
  }
  const made = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: maker.headers,
    payload: { name: 'Child source', connection: { kind: 'odata', baseUrl }, secrets: {} },
  });
  expect(made.statusCode, made.body).toBe(200);
  const id = newId('command');
  const payload = {
    id,
    action: { kind: 'update', sourceId: made.json().id, input: { name: 'Managed source' } },
  };
  const send = () =>
    server.app.inject({ method: 'POST', url: '/api/source-commands', headers: manager.headers, payload });
  const changed = await send();
  expect(changed.statusCode, changed.body).toBe(200);
  const audit = await server.pool.query(
    `SELECT metadata FROM "${server.schemas.audit}".events WHERE metadata->>'commandId' = $1`,
    [id],
  );
  expect(audit.rows[0].metadata.unitId).toBe(child.id);
  await ownerCall('PUT', `/api/org/members/${maker.userId}/unit`, { unitId: outside.id });
  const replay = await send();
  expect(replay.statusCode, replay.body).toBe(403);
  expect(replay.body).not.toContain(baseUrl);
});
