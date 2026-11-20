import { randomBytes } from 'node:crypto';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AutomationConfig,
  newId,
  type CommandBatchResult,
  type OrganizationArchiveJob,
  type OrganizationReviewResult,
  type SourceMeta,
  type TokenCreated,
} from '@riosoma/contracts';
import { closeLivePools, forgetLiveColumns, registerConnector, type Connector } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { ServerFixture, SignedIn } from '../../test/fixture.js';
import { seal } from '../../secrets.js';
import { claimSyncs } from '../../sources/sync.js';
import * as outbound from '../../automations/outbound.js';
import { newHookAddress } from '../../sources/webhook.js';
import {
  buildOrigin,
  call,
  commands,
  count,
  exportArchive,
  importArchive,
  rebuild,
  reviewList,
  target,
  upload,
  values,
  type Origin,
  type Row,
} from './organization-archives.test-support.js';

let kit: TestPostgres;
let origin: Origin;
let servers: ServerFixture[] = [];
let liveDb: Awaited<ReturnType<TestPostgres['createDatabase']>>;
/** The origin with its additions, exported with the passphrase */
let sealed: Buffer;
/** The same, exported without one */
let plain: Buffer;

const random = (bytes = 8) => randomBytes(bytes).toString('hex');
/** Credentials kept where a name-based filter wouldn't look, made at runtime */
const leaks = {
  path: ['pathsecret', random()].join(''),
  body: ['bodysecret', random()].join(''),
  zapier: ['zap', random()].join(''),
  sas: ['sas', random()].join(''),
  googleKey: ['gkey', random()].join(''),
};
const addresses = {
  slack: `https://hooks.slack.com/services/T00000000/B00000000/${leaks.path}`,
  zapier: `https://hooks.zapier.com/hooks/catch/123456/${leaks.zapier}/`,
  blob: `https://account.blob.core.windows.net/c/data.csv?sv=2022-11-02&se=2030-01-01&sr=b&sp=r&sig=${leaks.sas}`,
  geocode: `https://maps.googleapis.com/maps/api/geocode/json?address=x&key=${leaks.googleKey}`,
};
const pathBody = JSON.stringify({ api_key: leaks.body, note: 'kept' });
/** Identifiers from elsewhere that look like this server's own */
const outside = {
  table: `tbl${'Q'.repeat(7)}${'7'.repeat(7)}`,
  host: `usr${'H'.repeat(7)}${'4'.repeat(7)}`,
  header: ['bearer', random(6)].join('-'),
};
const outsideUrls = [
  `https://api.airtable.com/v0/app${'B'.repeat(14)}/${outside.table}`,
  `https://${outside.host}.example.test/in`,
];

beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await buildOrigin(kit, 'org_after_origin');
  const server = origin.server;
  const first = origin.schemas[0]!;
  const databaseId = first.database.id;
  const items = first.tables.find((table) => table.name === 'Items')!;
  const nameField = first.fields.find((field) => field.tableId === items.id && field.name === 'Name')!;
  // A live table over a real PostgreSQL database, whose password the source stores.
  liveDb = await kit.createDatabase('org_after_live');
  const remote = new pg.Client({ connectionString: liveDb.url });
  await remote.connect();
  await remote.query(`CREATE TABLE items (id integer PRIMARY KEY, name text)`);
  await remote.query(`INSERT INTO items VALUES (1, 'from the source one'), (2, 'from the source two')`);
  await remote.end();
  const url = new URL(liveDb.url);
  const live = await call<SourceMeta>(server, 'POST', '/api/sources', {
    name: 'Live warehouse',
    connection: {
      kind: 'postgres',
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      tls: { mode: 'disable' },
    },
    secrets: { password: decodeURIComponent(url.password) || 'test' },
    access: 'creators',
  });
  await commands(server, databaseId, [
    {
      kind: 'table.create',
      table: {
        id: newId('table'),
        name: 'Live items',
        source: {
          sourceId: live.id,
          select: { kind: 'object', object: { schema: 'public', name: 'items' } },
          keyColumns: ['id'],
          everyMinutes: null,
          freshness: 'live',
        },
        fields: [
          { id: newId('field'), name: 'Key', type: 'number', source: { column: 'id', sourceType: '' } },
          { id: newId('field'), name: 'Name', type: 'text', source: { column: 'name', sourceType: '' } },
        ],
        view: { id: newId('view'), name: 'Live grid' },
        records: [],
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: newId('automation'),
        name: 'Path secret',
        config: {
          trigger: { kind: 'recordCreated', tableId: items.id },
          steps: [
            { id: 'generic-hook', kind: 'callWebhook', url: addresses.slack, headers: {}, body: pathBody },
          ],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: newId('automation'),
        name: 'Outside IDs',
        config: {
          trigger: { kind: 'recordCreated', tableId: items.id },
          steps: [
            {
              id: 'airtable-call',
              kind: 'callWebhook',
              url: outsideUrls[0],
              headers: { Authorization: outside.header },
              body: '',
            },
            {
              id: 'host-call',
              kind: 'callWebhook',
              url: outsideUrls[1],
              headers: { Authorization: outside.header },
              body: '',
            },
            {
              id: 'tell-someone',
              kind: 'sendEmail',
              to: ['someone@example.test'],
              subject: `About ${outside.table}`,
              body: `Ticket ${outside.table} for {{trigger.record.${nameField.id}}}`,
            },
          ],
        },
      },
    },
  ]);
  const pathSecret = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'automations')} WHERE name = 'Path secret'`,
  );
  await commands(server, databaseId, [
    { kind: 'automation.update', automationId: pathSecret.rows[0]!.id, enabled: true },
  ]);
  await call(server, 'POST', `/api/databases/${databaseId}/webhooks`, {
    url: addresses.zapier,
    events: ['record.created'],
  });
  const org = server.owner.info.org.id;
  for (const [name, address] of [
    ['Blob', addresses.blob],
    ['Geocode', addresses.geocode],
  ] as const) {
    const id = newId('source');
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'sources')} (id, org_id, name, kind, connection, sealed_secrets, access)
      VALUES (${id}, ${org}, ${name}, 'file-url', ${JSON.stringify({ kind: 'file-url', url: address, format: 'csv' })}::jsonb,
        ${seal(server.config.secretKey, '{}', `source:${id}`)}, 'admins')`,
    );
  }
  sealed = (await exportArchive(server, { files: false, audit: false, passphrase: values.passphrase })).bytes;
  plain = (await exportArchive(server, { files: false, audit: false })).bytes;
}, 300_000);

afterEach(async () => {
  for (const server of servers.reverse()) await server.close();
  servers = [];
});

afterAll(async () => {
  await closeLivePools();
  forgetLiveColumns();
  await liveDb?.drop();
  await origin?.server.close();
  await kit?.stop();
});

async function fresh(prefix: string) {
  const made = await target(kit, prefix);
  servers.push(made.server);
  return made;
}

type Line = { kind: string; catalog?: string; row: Row };
const editing =
  (catalog: string, change: (row: Row) => Row) =>
  (_name: string, items: unknown[]): unknown[] =>
    items.map((item) => {
      const value = item as Line;
      return value.kind === 'catalog' && value.catalog === catalog
        ? { ...value, row: change(value.row) }
        : item;
    });

const tokenIn = (text: string) => /\/join#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

async function accept(server: ServerFixture, token: string, email: string): Promise<SignedIn> {
  const accepted = await server.app.inject({
    method: 'POST',
    url: '/api/auth/invitations/accept',
    payload: { token, name: 'Invited' },
  });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const info = accepted.json<SignedIn['info']>();
  const cookies = accepted.headers['set-cookie']!;
  const cookie = (Array.isArray(cookies) ? cookies[0]! : cookies).split(';')[0]!;
  return { userId: info.user.id, email, info, headers: { cookie, 'x-csrf-token': info.csrfToken } };
}

async function one<T extends Row>(server: ServerFixture, text: ReturnType<typeof sql>): Promise<T> {
  return (await query<T>(server.pool, text)).rows[0]!;
}

const errorKey = (body: string) =>
  (JSON.parse(body) as { error?: { messageKey?: string } }).error?.messageKey;

/** A TCP listener that counts every connection made to it and closes each at once */
async function listener(): Promise<{ port: number; connections: () => number; close: () => void }> {
  let connections = 0;
  const server: TcpServer = createTcpServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    connections: () => connections,
    close: () => server.close(),
  };
}

describe('after an organization import', () => {
  it('reads nothing through a paused source until the owner turns it on, whatever the path', async () => {
    const { server } = await fresh('org_after_live');
    const done = await importArchive(server, sealed, values.passphrase);
    expect(done.report).toMatchObject({ secretsRestored: true, authenticated: true });
    const app = server.schemas.app;
    const source = await one<{ id: string; import_paused: boolean }>(
      server,
      sql`SELECT id, import_paused FROM ${ident(app, 'sources')} WHERE name = 'Live warehouse'`,
    );
    expect(source.import_paused).toBe(true);
    const view = await one<{ id: string }>(
      server,
      sql`SELECT id FROM ${ident(app, 'views')} WHERE name = 'Live grid'`,
    );
    const rows = `/api/views/${view.id}/rows?offset=0&limit=100`;
    // The restored password stays unused while the source waits in the review.
    const read = await server.app.inject({ url: rows, headers: server.owner.headers });
    expect(read.statusCode, read.body).toBe(409);
    expect(errorKey(read.body)).toBe('organizationArchive.sourcePaused');
    expect(await claimSyncs(server.ctx, 100)).toHaveLength(0);
    const review = (await reviewList(server)).find(
      (item) => item.kind === 'source' && item.name === 'Live warehouse',
    )!;
    expect(review.done).toBe(false);
    await call<OrganizationReviewResult>(
      server,
      'POST',
      `/api/organization-archives/review/${review.id}/enable`,
    );
    const opened = await call<{ rows: Array<{ values: Row } | null> }>(server, 'GET', rows);
    expect(opened.rows.filter(Boolean).map((row) => Object.values(row!.values))).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['from the source one']),
        expect.arrayContaining(['from the source two']),
      ]),
    );
  });

  it.each(['ftp', 'sftp', 'ftps', 'webdav', 'graphql'] as const)(
    'checks the current address policy before resuming an imported %s source',
    async (kind) => {
      const host = `${random()}.invalid`;
      const connection =
        kind === 'webdav'
          ? { kind, url: 'http://127.0.0.1/files/', user: 'reader', path: '*.csv' }
          : kind === 'graphql'
            ? { kind, baseUrl: 'http://127.0.0.1/service', query: '{ items { id } }', records: 'data.items' }
            : {
                kind,
                host,
                user: 'reader',
                path: '*.csv',
                hostKey: `ssh-ed25519 ${randomBytes(32).toString('base64')}`,
              };
      const archive = await rebuild(sealed, {
        sign: values.passphrase,
        entry: editing('sources', (row) =>
          row.name === 'Live warehouse' ? { ...row, kind, connection } : row,
        ),
      });
      const { server } = await fresh('sftp_address_review');
      server.config.production = true;
      server.config.automationsAllowPrivateHosts = false;
      const resolve = vi
        .spyOn(outbound, 'systemResolve')
        .mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      try {
        await importArchive(server, archive, values.passphrase);
        const review = (await reviewList(server)).find(
          (item) => item.kind === 'source' && item.name === 'Live warehouse',
        )!;
        const resumed = await server.app.inject({
          method: 'POST',
          url: `/api/organization-archives/review/${review.id}/enable`,
          headers: server.owner.headers,
        });
        expect(resumed.statusCode, resumed.body).toBe(422);
        expect(resumed.json()).toMatchObject({
          error: {
            messageKey:
              kind === 'ftp'
                ? 'sources.file.ftp'
                : kind === 'graphql'
                  ? 'sources.rest.https'
                  : kind === 'webdav'
                    ? 'sources.file.https'
                    : 'sources.file.blocked',
          },
        });
        expect((await reviewList(server)).find((item) => item.id === review.id)?.done).toBe(false);
        expect(
          await one(
            server,
            sql`SELECT import_paused FROM ${ident(server.schemas.app, 'sources')} WHERE name = 'Live warehouse'`,
          ),
        ).toMatchObject({ import_paused: true });
        if (kind === 'sftp' || kind === 'ftps') expect(resolve).toHaveBeenCalledWith(host);
      } finally {
        resolve.mockRestore();
      }
    },
  );

  it('opens no connection for a paused source that needs no stored secret, on any path', async () => {
    const socket = await listener();
    try {
      const hostile = await rebuild(plain, {
        entry: editing('sources', (row) =>
          row.name === 'Live warehouse'
            ? {
                ...row,
                connection: {
                  kind: 'postgres',
                  host: '127.0.0.1',
                  port: socket.port,
                  database: 'anything',
                  user: 'anyone',
                  auth: { method: 'aws-rds-iam', region: 'us-east-1' },
                  tls: { mode: 'disable' },
                },
              }
            : row,
        ),
      });
      const { server } = await fresh('org_after_ambient');
      const done = await importArchive(server, hostile);
      expect(done.report).toMatchObject({ authenticated: false, secretsRestored: false });
      const app = server.schemas.app;
      const source = await one<{ id: string }>(
        server,
        sql`SELECT id FROM ${ident(app, 'sources')} WHERE name = 'Live warehouse'`,
      );
      const view = await one<{ id: string }>(
        server,
        sql`SELECT id FROM ${ident(app, 'views')} WHERE name = 'Live grid'`,
      );
      const databaseId = (
        await one<{ database_id: string }>(
          server,
          sql`SELECT t.database_id FROM ${ident(app, 'views')} v JOIN ${ident(app, 'tables')} t ON t.id = v.table_id WHERE v.id = ${view.id}`,
        )
      ).database_id;
      const refused = async (response: { statusCode: number; body: string }) => {
        expect(response.statusCode, response.body).toBe(409);
        expect(errorKey(response.body)).toBe('organizationArchive.sourcePaused');
      };
      await refused(
        await server.app.inject({ url: `/api/views/${view.id}/rows`, headers: server.owner.headers }),
      );
      await refused(
        await server.app.inject({
          method: 'POST',
          url: `/api/sources/${source.id}/test`,
          headers: server.owner.headers,
        }),
      );
      await refused(
        await server.app.inject({ url: `/api/sources/${source.id}/objects`, headers: server.owner.headers }),
      );
      await refused(
        await server.app.inject({
          method: 'POST',
          url: `/api/sources/${source.id}/preview`,
          headers: server.owner.headers,
          payload: { select: { kind: 'object', object: { schema: 'public', name: 'items' } } },
        }),
      );
      const created = await server.app.inject({
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
                id: newId('table'),
                name: 'Another live table',
                source: {
                  sourceId: source.id,
                  select: { kind: 'object', object: { schema: 'public', name: 'items' } },
                  keyColumns: ['id'],
                  everyMinutes: null,
                  freshness: 'live',
                },
                fields: [
                  {
                    id: newId('field'),
                    name: 'Key',
                    type: 'number',
                    source: { column: 'id', sourceType: '' },
                  },
                ],
                view: { id: newId('view'), name: 'Grid' },
                records: [],
              },
            },
          ],
        },
      });
      expect(created.json<CommandBatchResult>().results[0]).toMatchObject({
        status: 'rejected',
        error: { messageKey: 'organizationArchive.sourcePaused' },
      });
      // Join discovery never reads a live table's source.
      const joins = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${databaseId}/join-suggestions`,
        headers: server.owner.headers,
        payload: {},
      });
      expect(joins.statusCode, joins.body).toBe(200);
      expect(await claimSyncs(server.ctx, 100)).toHaveLength(0);
      expect(socket.connections()).toBe(0);
    } finally {
      socket.close();
    }
  });

  it('never hands a paused Airtable source’s stored token to Airtable', async () => {
    const { server } = await fresh('org_after_airtable');
    const id = newId('source');
    const org = server.owner.info.org.id;
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'sources')} (id, org_id, name, kind, connection, sealed_secrets, access, import_paused)
      VALUES (${id}, ${org}, 'Bases', 'airtable', ${JSON.stringify({ kind: 'airtable' })}::jsonb,
        ${seal(server.config.secretKey, JSON.stringify({ token: ['pat', random()].join('') }), `source:${id}`)}, 'admins', true)`,
    );
    let asked = 0;
    // Stands in for the Airtable connector, so nothing leaves this machine.
    registerConnector({
      kind: 'airtable',
      bases: async () => {
        asked++;
        return [];
      },
    } as unknown as Connector);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${id}/airtable-bases`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorKey(response.body)).toBe('organizationArchive.sourcePaused');
    expect(asked).toBe(0);
  });

  it('takes no posts at a paused webhook source, and makes it an address only from the review', async () => {
    const { server } = await fresh('org_after_incoming');
    await importArchive(server, sealed, values.passphrase);
    const app = server.schemas.app;
    const source = await one<{ id: string; import_paused: boolean }>(
      server,
      sql`SELECT id, import_paused FROM ${ident(app, 'sources')} WHERE name = 'Orders coming in'`,
    );
    expect(source.import_paused).toBe(true);
    const admin = await server.addMember({ name: 'Sources admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(app, 'memberships')} SET admin_roles = ARRAY['data_sources'] WHERE user_id = ${admin.userId}`,
    );
    for (const headers of [admin.headers, server.owner.headers]) {
      const made = await server.app.inject({
        method: 'POST',
        url: `/api/sources/${source.id}/webhook-address`,
        headers,
      });
      expect(made.statusCode, made.body).toBe(409);
      expect(errorKey(made.body)).toBe('organizationArchive.sourcePaused');
    }
    expect(await count(server, 'source_hooks')).toBe(0);
    // Even an address made some other way takes nothing while the source waits in the review.
    const path = await newHookAddress(server.pool, server.schemas, {
      id: source.id,
      orgId: server.owner.info.org.id,
    });
    const post = () =>
      server.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/json' },
        payload: { records: [{ order: 'one' }] },
      });
    const refused = await post();
    expect(refused.statusCode, refused.body).toBe(503);
    expect(refused.json()).toEqual({ error: 'paused' });
    const review = (await reviewList(server)).find(
      (item) => item.kind === 'source' && item.name === 'Orders coming in',
    )!;
    const turnedOn = await call<OrganizationReviewResult>(
      server,
      'POST',
      `/api/organization-archives/review/${review.id}/enable`,
    );
    expect(turnedOn.address).toMatch(/^\/api\/inbound\//);
    // The review makes a new address, so the one made while it waited never works.
    expect((await post()).statusCode).toBe(404);
  });

  it('turns an imported item on only from the owner’s review list', async () => {
    const { server, mail } = await fresh('org_after_bypass');
    await importArchive(server, sealed, values.passphrase);
    const app = server.schemas.app;
    const person = (await reviewList(server)).find(
      (item) => item.kind === 'person' && item.destinations[0]!.value === origin.member.email,
    )!;
    await call(server, 'POST', '/api/organization-archives/review/invite', { ids: [person.id] });
    await vi.waitFor(() => expect(mail).toHaveLength(1));
    const creator = await accept(server, tokenIn(mail[0]!.text), origin.member.email);
    const webhook = await one<{ id: string; database_id: string }>(
      server,
      sql`SELECT id, database_id FROM ${ident(app, 'webhooks')} WHERE url LIKE 'https://receiver.example.test%'`,
    );
    const databaseId = webhook.database_id;
    await query(
      server.pool,
      sql`INSERT INTO ${ident(app, 'grants')} (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${databaseId}, 'user', ${creator.userId}, 'creator')
      ON CONFLICT (resource_kind, resource_id, principal_kind, principal_id) DO UPDATE SET role = 'creator'`,
    );
    const admin = await server.addMember({ name: 'Admin' });
    await query(
      server.pool,
      sql`UPDATE ${ident(app, 'memberships')} SET admin_roles = ARRAY['security', 'integrations'] WHERE user_id = ${admin.userId}`,
    );
    const refused = (response: { statusCode: number; body: string }) => {
      expect(response.statusCode, response.body).toBe(409);
      expect(errorKey(response.body)).toBe('organizationArchive.review.turnOnFromReview');
    };
    const hook = `/api/databases/${databaseId}/webhooks/${webhook.id}`;
    refused(
      await server.app.inject({
        method: 'PATCH',
        url: hook,
        headers: creator.headers,
        payload: { enabled: true },
      }),
    );
    const token = await server.app.inject({
      method: 'POST',
      url: '/api/tokens',
      headers: creator.headers,
      payload: { name: 'Scripts', scopes: ['schema.bases:write'], databases: 'all' },
    });
    expect(token.statusCode, token.body).toBe(200);
    refused(
      await server.app.inject({
        method: 'PATCH',
        url: `/api/v1/databases/${databaseId}/webhooks/${webhook.id}`,
        headers: { authorization: `Bearer ${token.json<TokenCreated>().token}` },
        payload: { enabled: true },
      }),
    );
    const automation = await one<{ id: string }>(
      server,
      sql`SELECT id FROM ${ident(app, 'automations')} WHERE name = 'Tell everyone' AND database_id = ${databaseId}`,
    );
    const turnOn = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: creator.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'automation.update',
            automationId: automation.id,
            enabled: true,
          },
        ],
      },
    });
    expect(turnOn.json<CommandBatchResult>().results[0]).toMatchObject({
      status: 'rejected',
      error: { messageKey: 'organizationArchive.review.turnOnFromReview' },
    });
    refused(
      await server.app.inject({
        method: 'PUT',
        url: '/api/admin/calendar-feeds/policy',
        headers: admin.headers,
        payload: { enabled: true },
      }),
    );
    refused(
      await server.app.inject({
        method: 'PUT',
        url: '/api/admin/feedback/github',
        headers: admin.headers,
        payload: { enabled: true, repository: 'example/feedback' },
      }),
    );
    const state = async () =>
      one<{ webhook: boolean; automation: boolean; feeds: boolean; feedback: boolean }>(
        server,
        sql`SELECT (SELECT enabled FROM ${ident(app, 'webhooks')} WHERE id = ${webhook.id}) AS webhook,
          (SELECT enabled FROM ${ident(app, 'automations')} WHERE id = ${automation.id}) AS automation,
          (SELECT calendar_feeds FROM ${ident(app, 'orgs')}) AS feeds,
          (SELECT feedback_github_enabled FROM ${ident(app, 'orgs')}) AS feedback`,
      );
    expect(await state()).toEqual({ webhook: false, automation: false, feeds: false, feedback: false });
    const items = await reviewList(server);
    const pending = (kind: string, name?: string) =>
      items.find((item) => item.kind === kind && (name === undefined || item.name === name))!;
    for (const item of [
      pending('webhook', 'https://receiver.example.test'),
      pending('automation', 'Tell everyone'),
      pending('calendarFeeds'),
      pending('feedback'),
    ]) {
      expect(item.done).toBe(false);
      const result = await call<OrganizationReviewResult>(
        server,
        'POST',
        `/api/organization-archives/review/${item.id}/enable`,
      );
      expect(result.item.done).toBe(true);
    }
    expect(await state()).toEqual({ webhook: true, automation: true, feeds: true, feedback: true });
    expect(
      (
        await one<{ run_as_id: string }>(
          server,
          sql`SELECT run_as_id FROM ${ident(app, 'automations')} WHERE id = ${automation.id}`,
        )
      ).run_as_id,
    ).toBe(server.owner.userId);
    // Once the owner has turned it on, it's an ordinary webhook again.
    for (const enabled of [false, true])
      expect(
        (
          await server.app.inject({
            method: 'PATCH',
            url: hook,
            headers: server.owner.headers,
            payload: { enabled },
          })
        ).statusCode,
      ).toBe(200);
    // The creator has no role in a database this one links to, so rules limit what they see here,
    // and a webhook someone else made is not theirs to change.
    const limited = await server.app.inject({
      method: 'PATCH',
      url: hook,
      headers: creator.headers,
      payload: { enabled: false },
    });
    expect(limited.statusCode, limited.body).toBe(403);
    expect(errorKey(limited.body)).toBe('webhooks.rulesLimited');
  });

  it('carries every address and secret-named body value only under the passphrase', async () => {
    for (const bytes of [sealed, plain])
      for (const [name, value] of Object.entries(leaks)) expect(bytes.includes(value), name).toBe(false);
    const { server: preview } = await fresh('org_after_preview');
    const uploaded = await upload(preview, plain);
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    // The review shows each address's scheme and host, and only that.
    expect(uploaded.json<OrganizationArchiveJob>().preview!.outside).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'webhook',
          destinations: [{ kind: 'address', value: 'https://hooks.zapier.com' }],
        }),
        expect.objectContaining({
          kind: 'automation',
          name: 'Path secret',
          destinations: [{ kind: 'address', value: 'https://hooks.slack.com' }],
        }),
        expect.objectContaining({
          kind: 'source',
          name: 'Blob',
          destinations: [{ kind: 'host', value: 'account.blob.core.windows.net' }],
        }),
        expect.objectContaining({
          kind: 'source',
          name: 'Geocode',
          destinations: [{ kind: 'host', value: 'maps.googleapis.com' }],
        }),
      ]),
    );

    const { server: right } = await fresh('org_after_sealed');
    await importArchive(right, sealed, values.passphrase);
    const app = right.schemas.app;
    const step = async (server: ServerFixture, name: string) =>
      AutomationConfig.parse(
        (
          await one<{ config: Row }>(
            server,
            sql`SELECT config FROM ${ident(server.schemas.app, 'automations')} WHERE name = ${name}`,
          )
        ).config,
      ).steps[0]!;
    expect(await step(right, 'Path secret')).toMatchObject({ url: addresses.slack, body: pathBody });
    expect(
      (
        await one<{ url: string }>(
          right,
          sql`SELECT url FROM ${ident(app, 'webhooks')} WHERE url LIKE '%zapier%'`,
        )
      ).url,
    ).toBe(addresses.zapier);
    const urls = (
      await query<{ name: string; url: string }>(
        right.pool,
        sql`SELECT name, connection->>'url' AS url FROM ${ident(app, 'sources')} WHERE kind = 'file-url' ORDER BY name`,
      )
    ).rows;
    expect(urls).toEqual([
      { name: 'Blob', url: addresses.blob },
      { name: 'Geocode', url: addresses.geocode },
    ]);

    const { server: none } = await fresh('org_after_plain');
    await importArchive(none, plain);
    expect(await step(none, 'Path secret')).toMatchObject({
      url: 'https://hooks.slack.com',
      body: JSON.stringify({ api_key: '', note: 'kept' }),
    });
    const items = await reviewList(none);
    const hook = items.find((item) => item.kind === 'webhook' && item.name === 'https://hooks.zapier.com')!;
    const blob = items.find((item) => item.kind === 'source' && item.name === 'Blob')!;
    for (const item of [hook, blob, items.find((item) => item.name === 'Path secret')!]) {
      expect(item.needsSecret).toBe(true);
      const response = await none.app.inject({
        method: 'POST',
        url: `/api/organization-archives/review/${item.id}/enable`,
        headers: none.owner.headers,
      });
      expect(response.statusCode, item.name).toBe(409);
      expect(errorKey(response.body)).toBe('organizationArchive.review.secretNeeded');
    }
    // Entered again where each is set up, each turns on.
    const webhook = await one<{ id: string; database_id: string }>(
      none,
      sql`SELECT id, database_id FROM ${ident(none.schemas.app, 'webhooks')} WHERE url = 'https://hooks.zapier.com'`,
    );
    await call(none, 'PATCH', `/api/databases/${webhook.database_id}/webhooks/${webhook.id}`, {
      url: 'https://hooks.zapier.com/hooks/catch/1/entered-again/',
    });
    const source = await one<{ id: string }>(
      none,
      sql`SELECT id FROM ${ident(none.schemas.app, 'sources')} WHERE name = 'Blob'`,
    );
    await call(none, 'PATCH', `/api/sources/${source.id}`, {
      connection: {
        kind: 'file-url',
        url: 'https://account.blob.core.windows.net/c/data.csv',
        format: 'csv',
      },
    });
    for (const item of [hook, blob])
      expect(
        (
          await call<OrganizationReviewResult>(
            none,
            'POST',
            `/api/organization-archives/review/${item.id}/enable`,
          )
        ).item.done,
      ).toBe(true);
  });

  it('gives new IDs only to IDs and references, never to addresses or other text', async () => {
    const config = async (server: ServerFixture) =>
      AutomationConfig.parse(
        (
          await one<{ config: Row }>(
            server,
            sql`SELECT config FROM ${ident(server.schemas.app, 'automations')} WHERE name = 'Outside IDs'`,
          )
        ).config,
      );
    const first = origin.schemas[0]!;
    const items = first.tables.find((table) => table.name === 'Items')!;
    const nameField = first.fields.find((field) => field.tableId === items.id && field.name === 'Name')!;
    const { server: right } = await fresh('org_after_ids');
    await importArchive(right, sealed, values.passphrase);
    const restored = await config(right);
    const [airtable, host, tell] = restored.steps as Array<Row>;
    expect([airtable!.url, host!.url]).toEqual(outsideUrls);
    expect([airtable!.headers, host!.headers]).toEqual([
      { Authorization: outside.header },
      { Authorization: outside.header },
    ]);
    const freshName = await one<{ id: string }>(
      right,
      sql`SELECT f.id FROM ${ident(right.schemas.app, 'fields')} f JOIN ${ident(right.schemas.app, 'tables')} t ON t.id = f.table_id
      WHERE t.id = ${String((restored.trigger as { tableId: string }).tableId)} AND f.name = 'Name'`,
    );
    expect(freshName.id).not.toBe(nameField.id);
    expect(tell).toMatchObject({
      subject: `About ${outside.table}`,
      body: `Ticket ${outside.table} for {{trigger.record.${freshName.id}}}`,
    });
    const { server: none } = await fresh('org_after_ids_plain');
    await importArchive(none, plain);
    const left = (await config(none)).steps as Array<Row>;
    // Only the scheme and host come without the passphrase, and a host's letters are one case.
    expect(left.map((step) => step.url ?? null)).toEqual([
      'https://api.airtable.com',
      `https://${outside.host.toLowerCase()}.example.test`,
      null,
    ]);
    expect(left[2]).toMatchObject({ subject: `About ${outside.table}` });
  });
});
