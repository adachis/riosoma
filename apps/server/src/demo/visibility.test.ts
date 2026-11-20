import { z } from 'zod';
import * as contracts from '@riosoma/contracts';
import { plantPrivateConfiguration, plantUnreviewedFields } from './privacy-fixture.test-helpers.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { InjectOptions } from 'fastify';
import { newId, type DatabaseSchema, type SessionInfo } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../test/fixture.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { insertRecords } from '../data/physical/records.js';
import { DEMO_ROUTE_CORPUS } from '../test/corpora/demo.js';
import { demoRoutes } from './routes.js';

let kit: TestPostgres;
let server: ServerFixture;
let privateMember: SignedIn;
let read: Awaited<ReturnType<typeof readFixture>>;
let privateRead: Awaited<ReturnType<typeof readFixture>>;
let assets: string;
let headers: Record<string, string>;
let privacy: Awaited<ReturnType<typeof plantPrivateConfiguration>>;
const recordId = newId('record');
const attachmentId = newId('attachment');
const dashboardId = newId('dashboard');
const kanbanId = newId('view');
const interfaceId = newId('interface');
const privateNames = [
  'Unshared database orchard',
  'Unshared table canyon',
  'Unshared member meadow',
  'Unshared group harbor',
];
const slug = `demo-${randomBytes(8).toString('hex')}`;
const sourceId = newId('source');
const automationId = newId('automation');
const privateDetail = randomBytes(18).toString('hex');
const recipientAddress = `${randomBytes(18).toString('hex')}@example.test`;
const requests: Record<string, InjectOptions & { status?: number }> = {};

beforeAll(async () => {
  kit = await startTestPostgres();
  assets = mkdtempSync(join(tmpdir(), 'rio-demo-visibility-'));
  writeFileSync(join(assets, 'index.html'), '<!doctype html><title>Riosoma</title>');
  writeFileSync(join(assets, 'theme.css'), ':root {}');
  writeFileSync(join(assets, 'index.json'), '[]');
  mkdirSync(join(assets, 'palette'));
  writeFileSync(
    join(assets, 'palette', 'theme.json'),
    JSON.stringify({ defaultScheme: 'house', schemes: [{ id: 'house' }] }),
  );
  server = await startServer(kit, 'demovisibility', { webDir: assets, themesDir: assets });
  server.config.baseUrl = 'http://127.0.0.1';
  const member = await server.addMember();
  privateMember = await server.addMember({ name: privateNames[2] });
  read = await readFixture(server, [
    { type: 'text' },
    { type: 'number' },
    { type: 'singleSelect' },
    { type: 'attachment' },
  ]);
  privateRead = await readFixture(server, [{ type: 'text' }]);
  await server.pool.query(`UPDATE "${server.schemas.app}".databases SET name = $1 WHERE id = $2`, [
    privateNames[0],
    privateRead.table.databaseId,
  ]);
  await server.pool.query(`UPDATE "${server.schemas.app}".tables SET name = $1 WHERE id = $2`, [
    privateNames[1],
    privateRead.table.id,
  ]);
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".groups (id, org_id, name) VALUES ($1, $2, $3)`,
    [newId('group'), member.info.org.id, privateNames[3]],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".grants
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES ($1, 'database', $2, 'user', $3, 'editor')`,
    [member.info.org.id, read.table.databaseId, member.userId],
  );
  const bytes = Buffer.from('readable attachment');
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".files
    (id, org_id, table_id, field_id, name, size, type, sha256, storage, storage_key, scan_state, attached_at, thumbnails)
    VALUES ($1, $2, $3, $4, 'sample.txt', $5, 'text/plain', $6, 'postgres', $1, 'clean', now(), $7)`,
    [
      attachmentId,
      member.info.org.id,
      read.table.id,
      read.fields[3]!.id,
      bytes.length,
      randomBytes(32).toString('hex'),
      JSON.stringify({ small: { key: `${attachmentId}-small`, width: 1, height: 1, size: bytes.length } }),
    ],
  );
  for (const key of [attachmentId, `${attachmentId}-small`])
    await server.pool.query(
      `INSERT INTO "${server.schemas.app}".file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
      [key, bytes],
    );
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [
      {
        id: recordId,
        values: {
          [read.fields[0]!.id]: 'Public record',
          [read.fields[1]!.id]: 42,
          [read.fields[3]!.id]: [attachmentId],
        },
      },
    ],
    member.userId,
  );
  await insertRecords(
    server.pool,
    server.schemas.data,
    privateRead.table.id,
    privateRead.fields,
    [{ id: newId('record'), values: { [privateRead.fields[0]!.id]: 'Private record' } }],
    privateMember.userId,
  );
  const linkId = newId('field');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${read.table.databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'view.create',
          view: {
            id: kanbanId,
            tableId: read.table.id,
            name: 'Public stacks',
            type: 'kanban',
            config: { kanban: { stackFieldId: read.fields[2]!.id } },
          },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'field.create',
          tableId: read.table.id,
          field: {
            id: linkId,
            name: 'Related records',
            type: 'link',
            options: { linkedTableId: read.table.id },
          },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'dashboard.create',
          dashboard: {
            id: dashboardId,
            name: 'Public overview',
            config: {
              tiles: [
                {
                  id: 'tile001',
                  kind: 'chart',
                  place: { x: 0, y: 0, w: 4, h: 3 },
                  source: { tableId: read.table.id },
                  groupBy: { fieldId: read.fields[0]!.id },
                  value: { fn: 'count' },
                },
              ],
            },
          },
        },
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: 'Public directory',
            pages: [
              {
                id: 'page001',
                name: 'Records',
                blocks: [
                  {
                    id: 'records001',
                    kind: 'records',
                    place: { x: 0, y: 0, w: 6, h: 4 },
                    source: { tableId: read.table.id, viewId: read.view.id },
                    fieldIds: [read.fields[0]!.id],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  expect(
    created.json().results.every((result: { status: string }) => result.status === 'applied'),
    created.body,
  ).toBe(true);
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${interfaceId}/site`,
    headers: server.owner.headers,
    payload: {
      slug,
      title: 'Public directory',
      theme: { id: 'palette', scheme: 'house' },
      pages: [{ pageId: 'page001', slug: 'records', title: 'Records' }],
    },
  });
  expect(published.statusCode, published.body).toBe(200);
  for (const url of [
    '/healthz',
    '/readyz',
    '/api/config',
    '/api/setup/status',
    '/api/auth/session',
    '/api/home',
    '/api/databases',
    '/api/interfaces/code-frame',
  ])
    requests[`GET ${url}`] = { url };
  requests['GET /*'] = { url: '/' };
  requests['GET /themes/*'] = { url: '/themes/theme.css' };
  // Missing branding is a normal, empty response and must not expose configuration details.
  for (const path of ['/api/auth/logo/:key', '/api/org/logo/:key'])
    requests[`GET ${path}`] = { url: path.replace(':key', randomUUID()), status: 404 };
  requests['GET /api/databases/:databaseId/schema'] = {
    url: `/api/databases/${read.table.databaseId}/schema`,
  };
  requests['GET /api/files'] = { url: `/api/files?ids=${attachmentId}` };
  requests['GET /api/files/:attachmentId/:name'] = { url: `/api/files/${attachmentId}/sample.txt` };
  requests['GET /api/files/:attachmentId/thumbnails/:size'] = {
    url: `/api/files/${attachmentId}/thumbnails/small`,
  };
  requests['GET /api/fields/:fieldId/select-options'] = {
    url: `/api/fields/${read.fields[2]!.id}/select-options`,
  };
  requests['POST /api/fields/:fieldId/link-options'] = {
    url: `/api/fields/${linkId}/link-options`,
    payload: {},
  };
  for (const suffix of ['', '/comments', '/history'])
    requests[`GET /api/tables/:tableId/records/:recordId${suffix}`] = {
      url: `/api/tables/${read.table.id}/records/${recordId}${suffix}`,
    };
  requests['GET /api/tables/:tableId/records/search'] = {
    url: `/api/tables/${read.table.id}/records/search?q=Public`,
  };
  for (const path of ['rows', 'stacks', 'ranges', 'position'])
    requests[`GET /api/views/:viewId/${path}`] = {
      url: `/api/views/${path === 'stacks' ? kanbanId : read.view.id}/${path}${path === 'ranges' ? `?fields=${read.fields[1]!.id}` : path === 'position' ? `?recordId=${recordId}` : ''}`,
    };
  requests['POST /api/views/:viewId/search'] = {
    url: `/api/views/${read.view.id}/search`,
    payload: { query: 'Public' },
  };
  requests['POST /api/tables/:tableId/records/names'] = {
    url: `/api/tables/${read.table.id}/records/names`,
    payload: { ids: [recordId] },
  };
  requests['POST /api/tables/:tableId/records/history'] = {
    url: `/api/tables/${read.table.id}/records/history`,
    payload: { ids: [recordId], fieldIds: [read.fields[0]!.id] },
  };
  requests['POST /api/dashboards/:dashboardId/data'] = {
    url: `/api/dashboards/${dashboardId}/data`,
    payload: { timeZone: 'UTC' },
  };
  requests['POST /api/dashboards/:dashboardId/tiles/:tileId/records'] = {
    url: `/api/dashboards/${dashboardId}/tiles/tile001/records`,
    payload: { timeZone: 'UTC', slice: { category: 'Public record' } },
  };
  requests['POST /api/databases/:databaseId/views/:viewId/aggregate'] = {
    url: `/api/databases/${read.table.databaseId}/views/${read.view.id}/aggregate`,
    payload: { timeZone: 'UTC', summary: true },
  };
  requests['POST /api/interfaces/:interfaceId/data'] = {
    url: `/api/interfaces/${interfaceId}/data`,
    payload: { pageId: 'page001', timeZone: 'UTC' },
  };
  requests['POST /api/interfaces/:interfaceId/records'] = {
    url: `/api/interfaces/${interfaceId}/records`,
    payload: { pageId: 'page001', blockId: 'records001', offset: 0, limit: 50, timeZone: 'UTC' },
  };
  for (const prefix of ['/sites', '/api/public/sites']) {
    requests[`GET ${prefix}/:slug`] = { url: `${prefix}/${slug}` };
    requests[`GET ${prefix}/:slug/*`] = { url: `${prefix}/${slug}/records` };
  }
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".sources (id, org_id, name, kind, connection, sealed_secrets, access)
     VALUES ($1, $2, $3, 'postgres', $4, $5, 'admins')`,
    [
      sourceId,
      member.info.org.id,
      privateDetail,
      { kind: 'postgres', host: privateDetail, port: 5432, user: privateDetail },
      privateDetail,
    ],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".table_sources (table_id, source_id, settings, status)
     VALUES ($1, $2, $3, $4)`,
    [
      read.table.id,
      sourceId,
      {
        sourceId,
        select: { kind: 'object', object: { schema: privateDetail, name: privateDetail } },
        freshness: 'copy',
        keyColumns: [privateDetail],
        everyMinutes: null,
        allowOverrides: true,
      },
      {
        state: 'failed',
        lastSyncAt: null,
        lastSuccessAt: null,
        nextSyncAt: null,
        error: {
          messageKey: 'sources.sync.objectMissing',
          params: { object: privateDetail },
          detail: privateDetail,
        },
        stats: null,
        held: null,
      },
    ],
  );
  await server.pool.query(
    `INSERT INTO "${server.schemas.app}".automations
     (id, org_id, database_id, name, position, config, webhook_secret_hash, webhook_salt)
     VALUES ($1, $2, $3, 'Public automation', 0, $4, $5, $6)`,
    [
      automationId,
      member.info.org.id,
      read.table.databaseId,
      {
        trigger: { kind: 'webhook' },
        steps: [
          {
            id: 'branch001',
            name: 'Public branch',
            kind: 'if',
            conditions: null,
            then: [
              {
                id: 'email001',
                name: 'Public email step',
                kind: 'sendEmail',
                to: [recipientAddress],
                subject: privateDetail,
                body: privateDetail,
              },
            ],
            otherwise: [
              {
                id: 'repeat001',
                name: 'Public loop',
                kind: 'repeat',
                list: privateDetail,
                steps: [
                  {
                    id: 'email002',
                    name: 'Public nested email',
                    kind: 'sendEmail',
                    to: [recipientAddress],
                    subject: privateDetail,
                    body: privateDetail,
                  },
                ],
              },
            ],
          },
        ],
      },
      randomBytes(32).toString('hex'),
      randomBytes(16).toString('hex'),
    ],
  );
  privacy = await plantPrivateConfiguration(server, read, member);
  // Unknown stored settings must stay private without requiring another response-specific patch.
  for (const [table, column] of [
    ['databases', 'settings'],
    ['sources', 'connection'],
    ['table_sources', 'settings'],
    ['table_sources', 'status'],
    ['fields', 'options'],
    ['views', 'config'],
    ['dashboards', 'config'],
    ['automations', 'config'],
    ['interfaces', 'pages'],
    ['published_sites', 'settings'],
    ['published_sites', 'pages'],
  ]) {
    const rows = await server.pool.query<{ id: string; value: unknown }>(
      `SELECT ${table === 'table_sources' ? 'table_id' : table === 'published_sites' ? 'interface_id' : 'id'} AS id, "${column}" AS value FROM "${server.schemas.app}"."${table}"`,
    );
    for (const row of rows.rows)
      await server.pool.query(
        `UPDATE "${server.schemas.app}"."${table}" SET "${column}" = $1 WHERE ${table === 'table_sources' ? 'table_id' : table === 'published_sites' ? 'interface_id' : 'id'} = $2`,
        [JSON.stringify(plantUnreviewedFields(row.value, privacy.marker, `${table}.${column}`)), row.id],
      );
  }
  // Finish fixture notifications before measuring visitor reads, with no background delivery races.
  server.ctx.notifications?.pause();
  await server.ctx.notifications?.drain();
  server.config.demoAccount = member.email;
  server.config.demoMode = true;
  const session = await server.app.inject('/api/auth/session');
  expect(session.statusCode, session.body).toBe(200);
  headers = {
    cookie: String(session.headers['set-cookie']).split(';')[0]!,
    'x-csrf-token': session.json<SessionInfo>().csrfToken,
  };
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  if (assets) rmSync(assets, { recursive: true, force: true });
});

it('enumerates every allowed demo response and reveals no email addresses or inaccessible database, table, person, or group names', async () => {
  const allowed = [...new Set(demoRoutes(server.app))].filter((route) => DEMO_ROUTE_CORPUS[route] === 'read');
  expect(Object.keys(requests).sort()).toEqual(allowed.filter((route) => !route.startsWith('HEAD ')).sort());
  for (const route of allowed) {
    const [method] = route.split(' ');
    const fixture = requests[route.replace(/^HEAD /, 'GET ')]!;
    const response = await server.app.inject({
      ...fixture,
      method: method as InjectOptions['method'],
      headers,
    });
    expect.soft(response.statusCode, `${route}: ${response.body}`).toBe(fixture.status ?? 200);
    expect.soft(response.body, route).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    for (const hidden of [...privateNames, privateMember.email])
      expect.soft(response.body, route).not.toContain(hidden);
  }
  for (const url of [
    `/api/databases/${privateRead.table.databaseId}/schema`,
    `/api/views/${privateRead.view.id}/rows`,
  ]) {
    const response = await server.app.inject({ url, headers });
    expect(response.statusCode, response.body).toBe(404);
    for (const hidden of [...privateNames, privateMember.email]) expect(response.body).not.toContain(hidden);
  }
}, 30_000);

it('omits populated source failures and nested automation contact settings from demo schema', async () => {
  const response = await server.app.inject({
    url: `/api/databases/${read.table.databaseId}/schema`,
    headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.body).not.toContain(privateDetail);
  expect(response.body).not.toContain(recipientAddress);
  expect(response.json<DatabaseSchema>().automations?.map((item) => item.id)).toContain(automationId);
  const ordinary = await server.app.inject({
    url: `/api/databases/${read.table.databaseId}/schema`,
    headers: server.owner.headers,
  });
  expect(ordinary.body).toContain(privateDetail);
  expect(ordinary.body).toContain(recipientAddress);
});

it('requires a privacy decision for every catalog column and configuration contract field', async () => {
  const columns = await server.pool.query<{ table_name: string; column_name: string; data_type: string }>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema = $1 ORDER BY table_name, column_name`,
    [server.schemas.app],
  );
  const inventory = columns.rows.map((row) => `${row.table_name}.${row.column_name}: ${row.data_type}`);
  await expect(inventory.join('\n')).toMatchFileSnapshot('./privacy-catalog.txt');
  // Contract fingerprints cover nested fields, dictionary values, and every discriminated object kind.
  const schemas = Object.fromEntries(
    Object.entries(contracts).flatMap(([name, value]) => {
      if (!(value instanceof z.ZodType)) return [];
      const schema = z.toJSONSchema(value, { io: 'input', unrepresentable: 'any' });
      return [[name, createHash('sha256').update(JSON.stringify(schema)).digest('hex')]];
    }),
  );
  // The file ends with a line break, the way the formatter leaves every JSON file in the repository.
  await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot('./privacy-contracts.json');
});

async function rowChecksums() {
  const tables = await server.pool.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = ANY($1::text[])
     AND table_type = 'BASE TABLE' AND table_name <> 'sessions' ORDER BY table_schema, table_name`,
    [[server.schemas.app, server.schemas.data]],
  );
  const checksums = [];
  for (const table of tables.rows) {
    const result = await server.pool.query(
      `SELECT count(*)::int AS count, md5(COALESCE(string_agg(row_to_json(row)::text, '' ORDER BY row_to_json(row)::text), '')) AS checksum
       FROM "${table.table_schema}"."${table.table_name}" row`,
    );
    checksums.push({ table: `${table.table_schema}.${table.table_name}`, ...result.rows[0] });
  }
  return checksums;
}

it('plants private configuration markers and scans every allowed demo route with only named public displays exempted', async () => {
  const allowed = [...new Set(demoRoutes(server.app))].filter((route) => DEMO_ROUTE_CORPUS[route] === 'read');
  expect(Object.keys(requests).sort()).toEqual(allowed.filter((route) => !route.startsWith('HEAD ')).sort());
  const kinds = new Set<string>();
  const visit = (schema: unknown): void => {
    if (!schema || typeof schema !== 'object') return;
    const object = schema as { properties?: { id?: unknown; name?: unknown; kind?: { const?: string } } };
    if (object.properties?.id && object.properties.name && object.properties.kind?.const)
      kinds.add(object.properties.kind.const);
    Object.values(schema).forEach(visit);
  };
  visit(z.toJSONSchema(contracts.AutomationStep, { unrepresentable: 'any' }));
  expect([...privacy.stepKinds].sort()).toEqual([...kinds].sort());
  const before = await rowChecksums();
  for (const route of allowed) {
    const [method] = route.split(' ');
    const fixture = requests[route.replace(/^HEAD /, 'GET ')]!;
    const response = await server.app.inject({
      ...fixture,
      method: method as InjectOptions['method'],
      headers,
    });
    expect.soft(response.statusCode, `${route}: ${response.body}`).toBe(fixture.status ?? 200);
    for (const [marker, path] of privacy.privateMarkers)
      expect.soft(response.body, `${route}: ${path}`).not.toContain(marker);
  }
  const schema = await server.app.inject({ url: `/api/databases/${read.table.databaseId}/schema`, headers });
  expect(contracts.DatabaseSchema.safeParse(schema.json()).success, schema.body).toBe(true);
  expect([...privacy.publicMarkers.keys()].some((marker) => schema.body.includes(marker))).toBe(true);
  expect(await rowChecksums()).toEqual(before);
}, 30_000);
