import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingPageSettings,
  newId,
  type BookingPage,
  type CalendarFeedCreated,
  type DatabaseSchema,
  type OAuthApp,
  type OrganizationReviewResult,
  type RowsPage,
  type SignatureSigner,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { authDatabase, tokenHash } from '../../auth/database.js';
import { clientById } from '../../authorization/store.js';
import { requestById, signerEvent, visitOf } from '../../signatures/store.js';
import { CATALOGS, LEFT_OUT, type CatalogLine, type Row } from './catalog.js';
import { jsonLines, unpack } from './container.js';
import { SCHEMA_VERSION } from './export.js';
import { authenticate } from './import.js';
import {
  call,
  commands,
  count,
  expectEveryCatalogBack,
  exportArchive,
  importArchive,
  rebuild,
  reviewList,
  target,
  workDir,
} from './organization-archives.test-support.js';

let kit: TestPostgres;
let origin: ServerFixture;
let member: SignedIn;
let page: BookingPage;
let feed: CalendarFeedCreated;
let registration: OAuthApp & { clientSecret: string };
let signatureRequest: string;
let plain: Buffer;
let encrypted: Buffer;
let servers: ServerFixture[] = [];
const passphrase = randomBytes(24).toString('base64url');
const secrets = Array.from({ length: 12 }, () => randomBytes(32).toString('hex'));
const ids = {
  database: newId('database'),
  table: newId('table'),
  calendar: newId('view'),
  name: newId('field'),
  email: newId('field'),
  time: newId('field'),
  summary: newId('field'),
  automation: newId('automation'),
  function: newId('namedFunction'),
  formula: newId('field'),
};
const sqlSettings = { roles: ['owner', 'creator'], timeoutMs: 24000, rowCap: 321 };

beforeAll(async () => {
  kit = await startTestPostgres();
  origin = await startServer(kit, 'catalog_origin', { baseUrl: 'https://example.test' });
  member = await origin.addMember({ name: 'Calendar reader' });
  await call(origin, 'POST', '/api/databases', {
    id: ids.database,
    name: 'Appointments',
    table: {
      id: ids.table,
      name: 'Appointments',
      view: { id: newId('view'), name: 'Grid' },
      fields: [
        { id: ids.name, name: 'Name', type: 'text' },
        { id: ids.email, name: 'Email', type: 'email' },
        { id: ids.time, name: 'Time', type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
        { id: ids.summary, name: 'Summary', type: 'text' },
      ],
    },
  });
  await commands(origin, ids.database, [
    {
      kind: 'namedFunction.create',
      functionId: ids.function,
      definition: {
        name: 'DOUBLE',
        parameters: [ids.name],
        body: `{${ids.name}} * 2`,
        description: 'Double the argument',
      },
    },
    {
      kind: 'field.create',
      tableId: ids.table,
      field: { id: ids.formula, name: 'Doubled', type: 'formula', options: { expression: 'DOUBLE(3)' } },
    },
    { kind: 'record.create', tableId: ids.table, records: [{ id: newId('record'), values: {} }] },
    {
      kind: 'view.create',
      view: {
        id: ids.calendar,
        tableId: ids.table,
        name: 'Appointments calendar',
        type: 'calendar',
        config: { calendar: { startFieldId: ids.time } },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: ids.automation,
        name: 'Remember versions',
        config: { trigger: { kind: 'recordCreated', tableId: ids.table }, steps: [] },
      },
    },
  ]);
  const app = origin.schemas.app;
  const org = origin.owner.info.org.id;
  await query(
    origin.pool,
    sql`UPDATE ${ident(app, 'fields')} SET ai = ${JSON.stringify({
      prompt: `Describe {${ids.name}}`,
      tier: 'fast',
      trigger: 'referencedChange',
      ownerId: origin.owner.userId,
    })}::jsonb WHERE id = ${ids.summary}`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'ai_settings')} (org_id, settings)
    VALUES (${org}, '{"enabled":true}')`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
    VALUES (${org}, 'database', ${ids.database}, 'user', ${member.userId}, 'reader')`,
  );
  page = await call<BookingPage>(origin, 'POST', `/api/tables/${ids.table}/booking-pages`, {
    settings: BookingPageSettings.parse({
      title: 'Office hours',
      timeFieldId: ids.time,
      nameFieldId: ids.name,
      emailFieldId: ids.email,
      lengthMinutes: 30,
      timeZone: 'UTC',
      hours: Array.from({ length: 7 }, () => [{ start: '09:00', end: '17:00' }]),
    }),
  });
  feed = await call<CalendarFeedCreated>(origin, 'POST', `/api/views/${ids.calendar}/calendar-feed`, {
    timeZone: 'America/Chicago',
  });
  await call(origin, 'POST', `/api/views/${ids.calendar}/calendar-feed`, { timeZone: 'UTC' }, member);
  await call(origin, 'PUT', `/api/databases/${ids.database}/sql/settings`, sqlSettings);
  const created = await origin.app.inject({
    method: 'POST',
    url: '/api/admin/oauth/apps',
    headers: origin.owner.headers,
    payload: {
      name: 'Calendar integration',
      icon: 'database',
      homepage: 'https://client.example.test',
      redirectUris: ['https://client.example.test/callback'],
      confidential: true,
      scopes: ['data.records:read'],
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  registration = created.json<typeof registration>();
  const incoming = await call<{ id: string }>(origin, 'POST', '/api/sources', {
    name: 'Incoming appointments',
    connection: { kind: 'webhook' },
    secrets: {},
    access: 'admins',
  });
  const incomingTable = newId('table');
  await commands(origin, ids.database, [
    {
      kind: 'table.create',
      table: {
        id: incomingTable,
        name: 'Incoming records',
        source: {
          sourceId: incoming.id,
          select: { kind: 'object', object: { schema: null, name: 'posts' } },
          keyColumns: ['reference'],
          everyMinutes: null,
        },
        fields: [
          {
            id: newId('field'),
            name: 'Reference',
            type: 'text',
            source: { column: 'reference', sourceType: 'string' },
          },
        ],
        view: { id: newId('view'), name: 'Incoming grid' },
        records: [],
      },
    },
  ]);
  await query(
    origin.pool,
    sql`UPDATE ${ident(app, 'table_sources')}
    SET fetch_state = ${JSON.stringify({ etag: secrets[0] })}::jsonb WHERE table_id = ${incomingTable}`,
  );
  await call(origin, 'POST', '/api/sources', {
    name: 'Calendar news',
    connection: { kind: 'feed', url: 'https://example.test/news.xml' },
    secrets: {},
    access: 'admins',
  });
  await seedExcluded();
  plain = (await exportArchive(origin, { files: false })).bytes;
  encrypted = (await exportArchive(origin, { files: false, passphrase })).bytes;
}, 120_000);

afterEach(async () => {
  for (const server of servers.reverse()) await server.close();
  servers = [];
}, 120_000);

afterAll(async () => {
  await origin?.close();
  await kit?.stop();
}, 120_000);

async function fresh(prefix: string) {
  const made = await target(kit, prefix);
  servers.push(made.server);
  // Matching the importing owner exercises references that can be restored immediately.
  await query(
    made.server.pool,
    sql`UPDATE ${ident(made.server.schemas.app, 'users')}
    SET email = ${origin.owner.email} WHERE id = ${made.server.owner.userId}`,
  );
  return made;
}

async function one(server: ServerFixture, table: string): Promise<Row> {
  return (await query<Row>(server.pool, sql`SELECT * FROM ${ident(server.schemas.app, table)}`)).rows[0]!;
}

async function seedExcluded() {
  const app = origin.schemas.app;
  const org = origin.owner.info.org.id;
  const person = origin.owner.userId;
  const consent = randomBytes(16).toString('hex');
  const grant = randomBytes(16).toString('hex');
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_consents')}
    (id, client_id, org_id, user_id, scopes) VALUES (${consent}, ${registration.id}, ${org}, ${person}, '{}')`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_grants')}
    (id, consent_id, client_id, org_id, user_id, scopes, resource)
    VALUES (${grant}, ${consent}, ${registration.id}, ${org}, ${person}, '{}', 'https://example.test/api/v1')`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_credentials')} (hash, grant_id, kind, expires_at)
    VALUES (${secrets[0]!}, ${grant}, 'refresh', now() + interval '1 day')`,
  );
  const ownedHook = newId('webhook');
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'webhooks')}
    (id, org_id, database_id, url, events, secret)
    VALUES (${ownedHook}, ${org}, ${ids.database}, 'https://client.example.test/events', '{}', ${secrets[0]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_webhooks')} (webhook_id, grant_id)
    VALUES (${ownedHook}, ${grant})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'scim_tokens')} (id, org_id, name, secret_hash)
    VALUES (${newId('token')}, ${org}, 'Directory', ${secrets[1]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'sql_logins')}
    (database_id, role_name, schema_name, verifier, sealed_password)
    VALUES (${ids.database}, 'archive_test_role', 'archive_test_schema', ${secrets[2]!}, ${secrets[3]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_connections')}
    (id, org_id, user_id, provider, account_id, sealed_tokens)
    VALUES (${newId('job')}, ${org}, ${person}, 'drive', 'account', ${secrets[4]!})`,
  );
  signatureRequest = newId('job');
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'signature_requests')}
    (id, org_id, database_id, table_id, record_id, field_id, source_id, name,
      original_hash, expires_at, input, pages, signers)
    VALUES (${signatureRequest}, ${org}, ${ids.database}, ${ids.table}, ${newId('record')},
      ${ids.summary}, ${newId('attachment')}, 'Sent document', ${secrets[5]!}, now() + interval '1 day',
      '{}', '[]', ${JSON.stringify([{ email: `${secrets[6]}@example.test` }])}::jsonb)`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'automation_versions')}
    (automation_id, version, config) VALUES (${ids.automation}, 1,
      ${JSON.stringify({ trigger: { kind: 'webhook' }, steps: [{ body: secrets[7] }] })}::jsonb)`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'ai_keys')} (org_id, provider_id, sealed)
    VALUES (${org}, 'test-provider', ${secrets[8]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'api_tokens')}
    (id, org_id, user_id, name, scopes, secret_hash)
    VALUES (${newId('token')}, ${org}, ${person}, 'Personal', '{}', ${secrets[9]!})`,
  );
  const provider = randomBytes(16).toString('hex');
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'sso_providers')}
    (id, org_id, kind, name, issuer, client_id, sealed_secret)
    VALUES (${provider}, ${org}, 'oidc', 'Sign in', 'https://example.test', 'client', ${secrets[10]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'sso_domain_verifications')}
    (org_id, provider_id, domain, challenge)
    VALUES (${org}, ${provider}, 'example.test', ${secrets[11]!})`,
  );
  await query(
    origin.pool,
    sql`INSERT INTO ${ident(app, 'oauth_clients')}
    (id, org_id, name, icon, homepage, redirect_uris, scopes, verified)
    VALUES (${randomBytes(16).toString('hex')}, ${org}, 'Dynamic registration', 'app',
      'https://client.example.test', ARRAY['https://client.example.test/callback'], '{}', false)`,
  );
}

describe('additional organization archive catalogs', () => {
  it.each([false, true])(
    'round trips settings with encrypted credentials %s and leaves integrations off',
    async (sealed) => {
      const { server, mail } = await fresh(`catalog_round_${sealed}`);
      const result = await importArchive(server, sealed ? encrypted : plain, sealed ? passphrase : undefined);
      const database = result.report!.databases[0]!.id;
      const schema = await call<DatabaseSchema>(server, 'GET', `/api/databases/${database}/schema`);
      const field = (name: string) => schema.fields.find((field) => field.name === name)!;
      expect(schema.namedFunctions).toEqual([
        expect.objectContaining({
          databaseId: database,
          name: 'DOUBLE',
          parameters: [ids.name],
          body: `{${ids.name}} * 2`,
          description: 'Double the argument',
          createdBy: server.owner.userId,
          updatedBy: server.owner.userId,
          revision: 1,
        }),
      ]);
      expect(schema.namedFunctions![0]!.id).not.toBe(ids.function);
      expect(field('Doubled')).toMatchObject({ options: { expression: 'DOUBLE(3)' } });
      const view = schema.views.find(
        (view) => view.tableId === field('Doubled').tableId && view.type === 'grid',
      )!;
      const rows = await call<RowsPage>(server, 'GET', `/api/views/${view.id}/rows`);
      expect(rows.rows[0]!.values[field('Doubled').id]).toBe(6);
      const copiedPage = await one(server, 'booking_pages');
      expect(copiedPage).toMatchObject({
        enabled: false,
        owner_id: null,
        database_id: database,
        table_id: schema.tables[0]!.id,
        settings: {
          ...page.settings,
          timeFieldId: field('Time').id,
          nameFieldId: field('Name').id,
          emailFieldId: field('Email').id,
        },
      });
      expect(copiedPage.id).not.toBe(page.pageId);
      expect(copiedPage.id).toMatch(/^[A-Za-z0-9]{22}$/);
      expect(await one(server, 'sql_settings')).toEqual({ database_id: database, settings: sqlSettings });
      expect(field('Summary').ai).toMatchObject({
        prompt: `Describe {${field('Name').id}}`,
        tier: 'fast',
        trigger: 'referencedChange',
        ownerId: server.owner.userId,
      });
      expect((await one(server, 'ai_settings')).settings).toMatchObject({ enabled: false, providers: [] });
      const copiedClient = await one(server, 'oauth_clients');
      expect(copiedClient).toMatchObject({
        name: registration.name,
        redirect_uris: registration.redirectUris,
        scopes: registration.scopes,
        import_paused: true,
        secret_hash: '',
        last_used_at: null,
      });
      expect(copiedClient.id).not.toBe(registration.id);
      expect(copiedClient.id).toMatch(/^[a-f0-9]{32}$/);
      expect(await count(server, 'calendar_feeds')).toBe(0);
      expect(await count(server, 'sources', sql`import_paused`)).toBe(2);
      expect(await count(server, 'source_hooks')).toBe(0);
      const incoming = schema.tables.find((table) => table.name === 'Incoming records')!;
      const copiedSource = await one(server, 'table_sources');
      expect(copiedSource).toMatchObject({
        table_id: incoming.id,
        fetch_state: null,
        settings: {
          select: { kind: 'object', object: { schema: null, name: 'posts' } },
          keyColumns: ['reference'],
        },
      });
      const source = (
        await query<Row>(
          server.pool,
          sql`SELECT * FROM ${ident(server.schemas.app, 'sources')}
        WHERE id = ${String(copiedSource.source_id)}`,
        )
      ).rows[0]!;
      expect(source).toMatchObject({ name: 'Incoming appointments', kind: 'webhook', import_paused: true });
      for (const catalog of [
        'oauth_grants',
        'oauth_consents',
        'oauth_credentials',
        'scim_tokens',
        'sql_logins',
        'signature_requests',
        'automation_versions',
        'ai_keys',
        'api_tokens',
        'sso_domain_verifications',
        'webhooks',
      ])
        expect(await count(server, catalog), catalog).toBe(0);
      expect(mail).toEqual([]);
      const reviews = await reviewList(server);
      // Subscriptions stay behind, and only the organization's calendar feed setting waits here.
      expect(reviews.filter((item) => item.kind === 'calendarFeeds')).toHaveLength(1);
      expect(reviews.map((item) => item.kind)).not.toContain('calendarFeed');
      expect(await expectEveryCatalogBack(server, sealed ? encrypted : plain)).toEqual(
        expect.arrayContaining([
          'booking_pages',
          'named_functions',
          'oauth_clients',
          'sql_settings',
          'table_sources',
          'ai_settings',
        ]),
      );
      expect(reviews).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'bookingPage', name: 'Office hours', done: false }),
          expect.objectContaining({ kind: 'oauthClient', needsSecret: true, done: false }),
        ]),
      );
      expect((await server.app.inject({ url: feed.path })).statusCode).toBe(404);
      expect((await server.app.inject({ url: `/api/public/bookings/${page.pageId}` })).statusCode).toBe(404);
      expect(
        (await server.app.inject({ url: `/api/public/bookings/${String(copiedPage.id)}` })).statusCode,
      ).toBe(404);
    },
  );

  it('keeps excluded credentials out of both clear entries and encrypted secrets', async () => {
    const forbidden = [...secrets, registration.clientSecret, tokenHash(registration.clientSecret)];
    const stored = await query<Row>(
      origin.pool,
      sql`SELECT token_hash, csrf_token FROM ${ident(origin.schemas.app, 'sessions')}`,
    );
    forbidden.push(...stored.rows.flatMap((row) => [String(row.token_hash), String(row.csrf_token)]));
    for (const table of ['calendar_feeds', 'source_hooks']) {
      const rows = await query<{ token_hash: string }>(
        origin.pool,
        sql`SELECT token_hash FROM ${ident(origin.schemas.app, table)}`,
      );
      forbidden.push(...rows.rows.map((row) => row.token_hash));
    }
    for (const bytes of [plain, encrypted]) {
      const { directory, summary } = await unpack(Readable.from([bytes]), SCHEMA_VERSION, workDir);
      try {
        for (const secret of forbidden) expect(bytes.includes(secret)).toBe(false);
        const opened = summary.encryption ? await authenticate(directory, summary, passphrase) : new Map();
        const text = JSON.stringify([...opened.values()]);
        for (const secret of forbidden) expect(text).not.toContain(secret);
        const catalogs = new Set<string>();
        for (const entry of directory.entries.keys()) {
          if (!entry.endsWith('.jsonl') || entry === 'secrets.jsonl') continue;
          for await (const value of jsonLines(directory.read(entry))) {
            const item = value as CatalogLine;
            if (item.kind === 'catalog') {
              catalogs.add(item.catalog);
              expect(CATALOGS).toContain(item.catalog);
              expect(LEFT_OUT[item.catalog]).toBeUndefined();
            }
          }
        }
        for (const table of ['booking_pages', 'oauth_clients', 'sql_settings'])
          expect(catalogs.has(table), table).toBe(true);
        expect(catalogs.has('calendar_feeds')).toBe(false);
        expect(summary.counts.oauth_clients).toBe(1);
      } finally {
        await directory.close();
      }
    }
  });

  it('requires review for pages and registrations even after a new client secret is issued', async () => {
    const { server } = await fresh('catalog_review');
    await importArchive(server, encrypted, passphrase);
    const reviews = await reviewList(server);
    const enable = (id: string) =>
      call<OrganizationReviewResult>(server, 'POST', `/api/organization-archives/review/${id}/enable`);
    const copiedPage = await one(server, 'booking_pages');
    const bypass = await server.app.inject({
      method: 'PUT',
      url: `/api/booking-pages/${String(copiedPage.id)}`,
      headers: server.owner.headers,
      payload: { settings: copiedPage.settings, enabled: true },
    });
    expect(bypass.statusCode, bypass.body).toBe(409);
    expect(bypass.json()).toMatchObject({
      error: { messageKey: 'organizationArchive.review.turnOnFromReview' },
    });
    const pageReview = reviews.find((item) => item.kind === 'bookingPage')!;
    expect((await enable(pageReview.id)).address).toBe(`/b/${String(copiedPage.id)}`);
    expect(await one(server, 'booking_pages')).toMatchObject({
      enabled: true,
      owner_id: server.owner.userId,
    });
    expect(
      (await server.app.inject({ url: `/api/public/bookings/${String(copiedPage.id)}` })).statusCode,
    ).toBe(200);
    // Turning on the calendar feed setting makes no subscription, and people make their own again.
    await enable(reviews.find((item) => item.kind === 'calendarFeeds')!.id);
    expect(await count(server, 'calendar_feeds')).toBe(0);
    const schema = await call<DatabaseSchema>(
      server,
      'GET',
      `/api/databases/${String(copiedPage.database_id)}/schema`,
    );
    const calendar = schema.views.find((view) => view.name === 'Appointments calendar')!;
    const made = await call<CalendarFeedCreated>(server, 'POST', `/api/views/${calendar.id}/calendar-feed`, {
      timeZone: 'UTC',
    });
    expect(made.path).not.toBe(feed.path);
    expect((await server.app.inject({ url: made.path })).statusCode).toBe(200);
    const clientReview = reviews.find((item) => item.kind === 'oauthClient')!;
    const copiedClient = await one(server, 'oauth_clients');
    const clientId = String(copiedClient.id);
    const client = () => clientById(server.pool, authDatabase(server.ctx).app, clientId);
    // The OAuth apps screen shows the registration as paused, and whether it needs a new secret.
    const listed = async () =>
      (await call<OAuthApp[]>(server, 'GET', '/api/admin/oauth/apps')).find((app) => app.id === clientId);
    expect(await listed()).toMatchObject({ paused: true, secretNeeded: true });
    await expect(client()).rejects.toMatchObject({ error: 'invalid_client' });
    const needsSecret = await server.app.inject({
      method: 'POST',
      url: `/api/organization-archives/review/${clientReview.id}/enable`,
      headers: server.owner.headers,
    });
    expect(needsSecret.statusCode).toBe(409);
    const replacement = await call<{ clientSecret: string }>(
      server,
      'POST',
      `/api/admin/oauth/apps/${clientId}/secret`,
    );
    expect(replacement.clientSecret).not.toBe(registration.clientSecret);
    expect(await listed()).toMatchObject({ paused: true, secretNeeded: false });
    await expect(client()).rejects.toMatchObject({ error: 'invalid_client' });
    await enable(clientReview.id);
    expect(await client()).toMatchObject({
      import_paused: false,
      secret_hash: tokenHash(replacement.clientSecret),
    });
    expect(await listed()).toMatchObject({ paused: false, secretNeeded: false });
    expect((await enable(clientReview.id)).item.done).toBe(true);
    expect(await count(server, 'oauth_grants')).toBe(0);
  });

  it('discards a client secret planted in an unchecked archive', async () => {
    const planted = await rebuild(plain, {
      entry: (_name, items) =>
        items.map((item) => {
          const line = item as CatalogLine;
          return line.catalog === 'oauth_clients'
            ? { ...line, row: { ...line.row, secret_hash: tokenHash(secrets[0]!), import_paused: false } }
            : item;
        }),
    });
    const { server } = await fresh('catalog_planted');
    await importArchive(server, planted);
    expect(await one(server, 'oauth_clients')).toMatchObject({ secret_hash: '', import_paused: true });
  });

  it('keeps pages and registrations waiting for review when an imported organization is exported again', async () => {
    const { server: first } = await fresh('catalog_again_first');
    await importArchive(first, encrypted, passphrase);
    const again = await exportArchive(first, { files: false });
    const { server: second } = await fresh('catalog_again_second');
    await importArchive(second, again.bytes);
    const reviews = await reviewList(second);
    expect(reviews.filter((item) => item.kind === 'bookingPage')).toHaveLength(1);
    expect(reviews.filter((item) => item.kind === 'oauthClient')).toHaveLength(1);
    expect(await one(second, 'booking_pages')).toMatchObject({ enabled: false, owner_id: null });
    expect(await one(second, 'oauth_clients')).toMatchObject({ import_paused: true, secret_hash: '' });
    expect(await count(second, 'calendar_feeds')).toBe(0);
  });

  it('keeps public registrations public and still requires the owner to review them', async () => {
    const publicClient = await rebuild(plain, {
      entry: (_name, items) =>
        items.map((item) => {
          const line = item as CatalogLine;
          return line.catalog === 'oauth_clients'
            ? { ...line, row: { ...line.row, secret_hash: null } }
            : item;
        }),
    });
    const { server } = await fresh('catalog_public');
    await importArchive(server, publicClient);
    const imported = await one(server, 'oauth_clients');
    expect(imported).toMatchObject({ import_paused: true, secret_hash: null });
    const review = (await reviewList(server)).find((item) => item.kind === 'oauthClient')!;
    expect(review.needsSecret).toBe(false);
    await call(server, 'POST', `/api/organization-archives/review/${review.id}/enable`);
    expect(await clientById(server.pool, authDatabase(server.ctx).app, String(imported.id))).toMatchObject({
      import_paused: false,
      secret_hash: null,
    });
  });

  it('carries signers’ steps in the audit log without their IP addresses or browsers', async () => {
    const address = `198.51.100.${1 + (randomBytes(1)[0]! % 250)}`;
    const browser = `Browser/${randomBytes(12).toString('hex')}`;
    const memberAddress = `192.0.2.${1 + (randomBytes(1)[0]! % 250)}`;
    const signer: SignatureSigner = {
      id: newId('signatureSigner'),
      name: 'Outside signer',
      email: 'signer@example.test',
      status: 'pending',
      invitedAt: null,
      openedAt: null,
      signedAt: null,
      lastReminder: null,
      automaticReminder: false,
      reason: null,
      consent: null,
      ip: null,
      userAgent: null,
      timeZone: null,
      values: {},
    };
    const request = (await requestById(origin.pool, origin.schemas, signatureRequest))!;
    await signerEvent(origin.pool, origin.schemas, request, 'opened', signer, visitOf(address, browser));
    // A member's own sign-in keeps its address: they're part of the organization.
    await query(
      origin.pool,
      sql`INSERT INTO ${ident(origin.schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${origin.owner.info.org.id}, ${origin.owner.userId}, 'auth.sign_in',
        ${JSON.stringify({ ip: memberAddress })}::jsonb)`,
    );
    const archive = (await exportArchive(origin, { files: false, audit: true })).bytes;
    expect(archive.includes(address)).toBe(false);
    expect(archive.includes(browser)).toBe(false);
    expect(archive.includes(memberAddress)).toBe(true);
    const events: Row[] = [];
    const { directory } = await unpack(Readable.from([archive]), SCHEMA_VERSION, workDir);
    try {
      for await (const value of jsonLines(directory.read('organization.jsonl'))) {
        const item = value as CatalogLine;
        if (item.kind === 'catalog' && item.catalog === 'events') events.push(item.row);
      }
    } finally {
      await directory.close();
    }
    const opened = events.find((event) => event.action === 'signature.opened')!;
    expect(opened.metadata).toEqual({
      actorKind: 'signer',
      requestId: signatureRequest,
      recordId: request.record_id,
      signerId: signer.id,
    });
    // An archive that still carries them brings them in no further.
    const planted = await rebuild(archive, {
      entry: (_name, items) =>
        items.map((item) => {
          const line = item as CatalogLine;
          return line.catalog === 'events' && line.row.action === 'signature.opened'
            ? {
                ...line,
                row: {
                  ...line.row,
                  metadata: { ...(line.row.metadata as Row), ip: address, userAgent: browser },
                },
              }
            : item;
        }),
    });
    const { server } = await fresh('catalog_signers');
    await importArchive(server, planted);
    const imported = await query<{ metadata: Row }>(
      server.pool,
      sql`SELECT metadata FROM ${ident(server.schemas.audit, 'events')} WHERE action = 'signature.opened'`,
    );
    expect(imported.rows).toHaveLength(1);
    // The signer's ID follows the new IDs, as every ID does.
    expect(imported.rows[0]!.metadata).toMatchObject({
      actorKind: 'signer',
      signerId: expect.stringMatching(/^sgn/),
      imported: true,
    });
    expect(imported.rows[0]!.metadata).not.toHaveProperty('ip');
    expect(imported.rows[0]!.metadata).not.toHaveProperty('userAgent');
  });
});
