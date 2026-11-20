import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type TokenCreated } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { tenantRoutes, tenantTools, type TenantResource } from '../test/corpora/tenant.js';
import { readFixture } from './snapshots.test-helpers.js';
import { TOOLS } from '../mcp/tools.js';
import { zip, zipBombs, worksheetWorkbook } from '../test/corpora/zip.js';

let kit: TestPostgres;
let server: ServerFixture;
let resource: TenantResource;
let foreign: SignedIn;
let localDatabaseId: string;
let originalSchema: unknown;
const attackers: Array<{ person: SignedIn; token: Record<string, string> }> = [];
const registered = new Set<string>();
const initialization = channel('fastify.initialization');
function inventory(message: unknown) {
  const { fastify } = message as { fastify: FastifyInstance };
  fastify.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      if (method !== 'HEAD') registered.add(`${method} ${route.url}`);
  });
}
const scopes = ['schema.bases:read', 'schema.bases:write', 'data.records:read', 'data.records:write'];

beforeAll(async () => {
  kit = await startTestPostgres();
  initialization.subscribe(inventory);
  try {
    server = await startServer(kit, 'tenant_corpus');
  } finally {
    initialization.unsubscribe(inventory);
  }
  const people = [server.owner, await server.addMember(), await server.addMember()];
  for (const person of people) {
    const made = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: person.headers,
      payload: { name: 'Tenant corpus', scopes, databases: 'all' },
    });
    expect(made.statusCode, made.body).toBe(200);
    attackers.push({ person, token: { authorization: `Bearer ${made.json<TokenCreated>().token}` } });
  }
  const guest = people[2]!;
  await server.pool.query(`UPDATE ${server.schemas.app}.memberships SET kind = 'guest' WHERE user_id = $1`, [
    guest.userId,
  ]);
  guest.info.membership.kind = 'guest';
  foreign = await server.addMember();
  const orgId = newId('org');
  await server.pool.query(`INSERT INTO ${server.schemas.app}.orgs (id, name) VALUES ($1, 'Foreign tenant')`, [
    orgId,
  ]);
  await server.pool.query(
    `UPDATE ${server.schemas.app}.memberships SET org_id = $1, kind = 'owner' WHERE user_id = $2`,
    [orgId, foreign.userId],
  );
  const read = await readFixture(
    { ...server, owner: { ...foreign, info: { ...foreign.info, org: { ...foreign.info.org, id: orgId } } } },
    [{ type: 'text' }, { type: 'attachment' }],
  );
  resource = {
    databaseId: read.table.databaseId,
    tableId: read.table.id,
    joinedTableId: newId('table'),
    joinedFieldId: newId('field'),
    viewId: read.view.id,
    fieldId: read.fields[0]!.id,
    attachmentFieldId: read.fields[1]!.id,
    recordId: newId('record'),
    dashboardId: newId('dashboard'),
    interfaceId: newId('interface'),
    automationId: newId('automation'),
    functionId: newId('namedFunction'),
    libraryId: randomUUID(),
    attachmentId: '',
    webhookId: '',
    deliveryId: newId('delivery'),
    jobId: newId('job'),
  };
  await server.pool.query(
    `INSERT INTO ${server.schemas.app}.table_copies (id, command_id, org_id, user_id, database_id, state, total)
    VALUES ($1, $2, $3, $4, $5, 'finished', 0)`,
    [resource.jobId, newId('command'), orgId, foreign.userId, resource.databaseId],
  );
  const seeded = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${resource.databaseId}/commands`,
    headers: foreign.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          kind: 'table.create',
          id: newId('command'),
          groupId: newId('action'),
          table: {
            id: resource.joinedTableId,
            name: 'TENANT_SENTINEL',
            fields: [{ id: resource.joinedFieldId, name: 'Text', type: 'text' }],
            view: { id: newId('view'), name: 'Grid' },
          },
        },
        {
          kind: 'record.create',
          id: newId('command'),
          groupId: newId('action'),
          tableId: resource.tableId,
          records: [{ id: resource.recordId, values: { [resource.fieldId]: 'TENANT_SENTINEL' } }],
        },
        ...[
          {
            kind: 'namedFunction.create',
            functionId: resource.functionId,
            definition: {
              name: 'TENANT_SENTINEL',
              parameters: [],
              body: '1',
              description: 'TENANT_SENTINEL',
            },
          },
          { kind: 'dashboard.create', dashboard: { id: resource.dashboardId, name: 'TENANT_SENTINEL' } },
          {
            kind: 'interface.create',
            interface: {
              id: resource.interfaceId,
              name: 'TENANT_SENTINEL',
              pages: [{ id: 'page01', name: 'Notes', blocks: [] }],
            },
          },
          {
            kind: 'automation.create',
            automation: {
              id: resource.automationId,
              name: 'TENANT_SENTINEL',
              config: { trigger: { kind: 'recordCreated', tableId: resource.tableId }, steps: [] },
            },
          },
        ].map((command) => ({ ...command, id: newId('command'), groupId: newId('action') })),
      ],
    },
  });
  expect(seeded.statusCode, seeded.body).toBe(200);
  expect(seeded.json()).toMatchObject({ results: Array.from({ length: 6 }, () => ({ status: 'applied' })) });
  const library = await server.app.inject({
    method: 'POST',
    url: '/api/knowledge/library-commands',
    headers: foreign.headers,
    payload: {
      kind: 'library.save',
      id: randomUUID(),
      libraryId: resource.libraryId,
      scope: { kind: 'database', databaseId: resource.databaseId },
      details: { name: 'TENANT_SENTINEL', description: 'TENANT_SENTINEL', label: 'public' },
    },
  });
  expect(library.json(), library.body).toMatchObject({ status: 'applied' });
  const uploaded = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${resource.tableId}/fields/${resource.attachmentFieldId}/files`,
    headers: { ...foreign.headers, 'content-type': 'application/octet-stream', 'x-file-name': 'note.png' },
    payload: await sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } })
      .png()
      .toBuffer(),
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  resource.attachmentId = uploaded.json<{ id: string }>().id;
  const webhook = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${resource.databaseId}/webhooks`,
    headers: foreign.headers,
    payload: {
      url: 'https://receiver.example.test/',
      events: ['record.created'],
      tableIds: [resource.tableId],
      enabled: false,
    },
  });
  expect(webhook.statusCode, webhook.body).toBe(200);
  resource.webhookId = webhook.json<{ id: string }>().id;
  const enabled = await server.app.inject({
    method: 'PUT',
    url: '/api/ai/settings',
    headers: server.owner.headers,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  localDatabaseId = (await readFixture(server, [{ type: 'text' }])).table.databaseId;
  originalSchema = (
    await server.app.inject({ url: `/api/databases/${resource.databaseId}/schema`, headers: foreign.headers })
  ).json();
  // Even stray direct grants must never override the organization boundary.
  for (const { person } of attackers)
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.grants (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES ($1, 'database', $2, 'user', $3, 'owner')`,
      [orgId, resource.databaseId, person.userId],
    );
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

describe('generated cross-organization access matrix', () => {
  it('covers the registered resource route inventory', () => {
    const cases = new Set(
      tenantRoutes(resource).map((route) => {
        let path = route.url.split('?')[0]!;
        for (const [key, value] of Object.entries(resource))
          if (value) path = path.replaceAll(value, `:${key === 'attachmentFieldId' ? 'fieldId' : key}`);
        path = path.replace(/\/note\.png$/, '/:name').replace(/\/thumbnails\/small$/, '/thumbnails/:size');
        return `${route.method} ${path}`;
      }),
    );
    for (const route of registered) {
      if (
        !route.endsWith('/knowledge/search') &&
        (/ \/api\/v1\/(databases|tables|fields|views|home|knowledge|duplicate-jobs)(?:\/|$)/.test(route) ||
          / \/api\/(?:duplicate-jobs\/:jobId(?:\/cancel)?|interfaces\/:interfaceId\/site|tables\/:tableId\/(?:permissions|record-rules|fields\/:fieldId\/files)|fields\/:fieldId\/permissions|files(?:\/.*)?|knowledge\/(?:libraries(?:\/.*)?|search-documents|library-commands))$/.test(
            route,
          ))
      )
        expect(cases, route).toContain(route);
    }
  });

  it('covers the complete registered tool inventory', () => {
    const cases = tenantTools(resource);
    for (const tool of TOOLS) {
      expect(cases, tool.definition.name).toHaveProperty(tool.definition.name);
    }
  });
  it.each(['owner', 'member', 'guest'])(
    'hides foreign resources from %s through session and token routes',
    async (kind) => {
      const attacker = attackers.find(({ person }) => person.info.membership.kind === kind)!;
      for (const route of tenantRoutes(resource)) {
        const response = await server.app.inject({
          ...route,
          headers: {
            ...('token' in route && route.token ? attacker.token : attacker.person.headers),
            ...('headers' in route ? route.headers : {}),
          },
        });
        const expiredGuestToken = kind === 'guest' && 'token' in route && route.token;
        if ('collection' in route && !expiredGuestToken) {
          expect(response.statusCode, response.body).toBe(200);
          for (const id of [resource.databaseId, resource.tableId, resource.libraryId, resource.attachmentId])
            expect(response.body).not.toContain(id);
          expect(response.body).not.toContain('TENANT_SENTINEL');
          continue;
        }
        if ('rejected' in route && !expiredGuestToken) {
          expect(response.statusCode, `${route.method} ${route.url}: ${response.body}`).toBe(200);
          expect(response.json()).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
          expect(response.body).not.toContain('TENANT_SENTINEL');
          continue;
        }
        if ('batch' in route) {
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json()).toMatchObject({
            results: [{ status: 'rejected', error: { code: 'not_found' } }],
          });
          expect(response.body).not.toContain('TENANT_SENTINEL');
          continue;
        }
        expect(response.statusCode, `${kind}: ${route.method} ${route.url}: ${response.body}`).toBe(
          expiredGuestToken ? 401 : 404,
        );
        expect(response.json()).toMatchObject({
          error: { code: expiredGuestToken ? 'unauthenticated' : 'not_found' },
        });
        expect(response.body).not.toContain('TENANT_SENTINEL');
      }
    },
  );

  it('keeps nested foreign IDs inaccessible inside an authorized outer resource', async () => {
    const calls = tenantTools(resource);
    const nested = [
      ['update_named_function', { ...calls.update_named_function, databaseId: localDatabaseId }],
      ['delete_named_function', { ...calls.delete_named_function, databaseId: localDatabaseId }],
      ['create_joined_table', { ...calls.create_joined_table, databaseId: localDatabaseId }],
      [
        'change_knowledge',
        {
          command: {
            kind: 'library.save',
            id: randomUUID(),
            libraryId: resource.libraryId,
            scope: { kind: 'personal' },
            details: { name: 'changed', description: '', label: 'public' },
          },
        },
      ],
    ] as const;
    for (const [name, args] of nested) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...attackers[0]!.token, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
      });
      const result = response.json().result;
      expect(response.statusCode, response.body).toBe(200);
      if (name === 'change_knowledge')
        expect(result.structuredContent).toMatchObject({ status: 'rejected', error: { code: 'not_found' } });
      else
        expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'not_found' } } });
      expect(response.body).not.toContain('TENANT_SENTINEL');
    }
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${localDatabaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            kind: 'record.update',
            id: newId('command'),
            groupId: newId('action'),
            tableId: resource.tableId,
            records: [{ id: resource.recordId, values: { [resource.fieldId]: 'changed' } }],
          },
        ],
      },
    });
    expect(response.json(), response.body).toMatchObject({
      results: [{ status: 'rejected', error: { code: 'not_found' } }],
    });
  });

  it('filters collection searches without an explicit library ID', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/knowledge/search-documents',
      headers: server.owner.headers,
      payload: { query: 'TENANT_SENTINEL' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ passages: [] });
    expect(response.body).not.toContain('TENANT_SENTINEL');
  });

  it.each(['owner', 'member', 'guest'])('hides foreign resources from %s through MCP', async (kind) => {
    const attacker = attackers.find(({ person }) => person.info.membership.kind === kind)!;
    let id = 0;
    for (const [name, args] of Object.entries(tenantTools(resource))) {
      const response = await server.app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { ...attacker.token, accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
      });
      expect(response.statusCode, response.body).toBe(kind === 'guest' ? 401 : 200);
      const body = response.json();
      if (kind === 'guest') expect(body).toHaveProperty('error');
      else if (['list_databases', 'list_folders', 'list_knowledge', 'list_connected_tools'].includes(name)) {
        expect(body.result, response.body).not.toHaveProperty('isError', true);
        for (const id of [resource.databaseId, resource.tableId, resource.libraryId])
          expect(response.body).not.toContain(id);
      } else if (name === 'web_search')
        expect(body.error, response.body).toMatchObject({
          data: { messageKey: 'knowledge.searchUnavailable' },
        });
      else if (['remember', 'forget', 'change_knowledge'].includes(name))
        expect(body.result.structuredContent, `${kind}: ${name}: ${response.body}`).toMatchObject({
          status: 'rejected',
          error: { code: 'not_found' },
        });
      else
        expect(body.result, `${kind}: ${name}: ${response.body}`).toMatchObject({
          isError: true,
          structuredContent: { error: { code: 'not_found' } },
        });
      expect(response.body).not.toContain('TENANT_SENTINEL');
    }
  });

  it('lets the rightful tenant read unchanged records after every rejected mutation', async () => {
    const response = await server.app.inject({
      url: `/api/views/${resource.viewId}/rows?refresh=1`,
      headers: foreign.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      rows: [{ id: resource.recordId, values: { [resource.fieldId]: 'TENANT_SENTINEL' } }],
    });
    const read = await server.app.inject({
      url: `/api/databases/${resource.databaseId}/schema`,
      headers: foreign.headers,
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual(originalSchema);
    expect(read.json()).toMatchObject({
      dashboards: [{ id: resource.dashboardId }],
      interfaces: [{ id: resource.interfaceId }],
      automations: [{ id: resource.automationId }],
      namedFunctions: [{ id: resource.functionId, name: 'TENANT_SENTINEL', body: '1' }],
    });
  });

  it.each([false, true])(
    'refuses expanded worksheet cells through the import endpoint with shared strings %s',
    async (shared) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/imports/spreadsheet',
        headers: { ...foreign.headers, 'content-type': 'application/octet-stream' },
        payload: worksheetWorkbook('x'.repeat(17 * 1024 * 1024), 1, shared),
      });
      expect(response.body.length).toBeLessThan(2048);
      expect(response.body).toContain('import.spreadsheet.tooLarge');
      expect(response.body).not.toContain('xxxxxxxx');
    },
  );

  it.each(zipBombs)(
    'stores uploaded $name without expanding it and serves it as a download',
    async ({ size, declared }) => {
      const bytes = zip([{ name: 'word/document.xml', bytes: Buffer.alloc(size, 32), declared }]);
      const uploaded = await server.app.inject({
        method: 'POST',
        url: `/api/tables/${resource.tableId}/fields/${resource.attachmentFieldId}/files`,
        headers: {
          ...foreign.headers,
          'content-type': 'application/octet-stream',
          'x-file-name': 'bomb.docx',
        },
        payload: bytes,
      });
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      const id = uploaded.json<{ id: string }>().id;
      const url = `/api/files/${id}/bomb.docx`;
      const downloaded = await server.app.inject({ url, headers: foreign.headers });
      expect(downloaded.statusCode).toBe(200);
      expect(downloaded.headers['content-disposition']).toMatch(/^attachment;/);
      expect(downloaded.rawPayload).toEqual(bytes);
      for (const { person } of attackers)
        expect((await server.app.inject({ url, headers: person.headers })).statusCode).toBe(404);
    },
  );
});
