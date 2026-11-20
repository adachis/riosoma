import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { expect } from 'vitest';
import {
  newId,
  type CommandBatchResult,
  type DatabaseSchema,
  type OrganizationArchiveJob,
  type OrganizationImportReviewItem,
  type OrganizationManifest,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import type { TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import type { RuntimeConfig } from '../../config.js';
import { seal } from '../../secrets.js';
import { CATALOG_PLAN } from './catalog.js';
import { ArchiveDirectory, AFTER_MANIFEST, jsonLines, line, unpack } from './container.js';
import { archiveKeys, decryptSecret, encryptSecret, forgetKeys, manifestMac } from './encryption.js';
import { SCHEMA_VERSION } from './export.js';
import { SecretLine } from './inspect.js';
import { TEST_PROVIDER_ID } from '../../ai/test-fixtures.js';

export type Row = Record<string, unknown>;

const random = (bytes = 8) => randomBytes(bytes).toString('hex');

/**
 * The working folders this test file's own archive work uses, apart from every server's, so no
 * other test run's cleanup, or this one's, reaches another's.
 */
export const workDir = mkdtempSync(join(tmpdir(), 'rio-test-archives-'));
process.once('exit', () => rmSync(workDir, { recursive: true, force: true }));

/** Stand-ins for credentials, made at runtime so no whole one is ever written down */
export const values = {
  passphrase: ['twelve', 'or', 'more', 'characters'].join(' '),
  credential: ['stored', 'credential', random()].join('-'),
  header: ['hdr', random()].join('-'),
  query: ['qry', random()].join(''),
  slack: ['https://hooks.slack.com/services/T00000000/B00000000', random()].join('/'),
  teams: ['https://example.webhook.office.com/webhookb2', random()].join('/'),
  discord: ['https://discord.com/api/webhooks/123', random()].join('/'),
  sms: random(16),
  oauth: ['oauth', random()].join('-'),
  github: ['gh', random()].join('-'),
  aiKey: ['ai', random()].join('-'),
  passwordHash: ['$argon2id$v=19$m=65536,t=3,p=4', random(), random(16)].join('$'),
};

export async function call<T>(
  server: ServerFixture,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  who: SignedIn = server.owner,
): Promise<T> {
  const response = await server.app.inject({
    method,
    url,
    headers: who.headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

export async function commands(server: ServerFixture, databaseId: string, list: Row[]): Promise<void> {
  const groupId = newId('action');
  const result = await call<CommandBatchResult>(server, 'POST', `/api/databases/${databaseId}/commands`, {
    clientId: newId('client'),
    commands: list.map((command) => ({ id: newId('command'), groupId, ...command })),
  });
  for (const item of result.results) expect(item, JSON.stringify(item)).toMatchObject({ status: 'applied' });
}

export interface Origin {
  server: ServerFixture;
  member: SignedIn;
  guest: SignedIn;
  schemas: DatabaseSchema[];
  attachment: Buffer;
  /** Exported with the passphrase, files, and the audit log */
  exported: Buffer;
  /** Exported with files and the audit log, and no passphrase */
  plain: Buffer;
  exportId: string;
  ids: {
    folder: string;
    group: string;
    source: string;
    /** The incoming address the webhook source had on the old server */
    incoming: string;
    messaging: string;
    calling: string;
    webhook: string;
    link: string;
    form: string;
  };
}

async function buildDatabase(origin: ServerFixture, member: SignedIn, name: string, attachment: Buffer) {
  const database = newId('database');
  const table = newId('table');
  const related = newId('table');
  const field = newId('field');
  const number = newId('field');
  const files = newId('field');
  const person = newId('field');
  const target = newId('field');
  const link = newId('field');
  const view = newId('view');
  const record = newId('record');
  const linked = newId('record');
  await call(origin, 'POST', '/api/databases', {
    id: database,
    name,
    table: {
      id: table,
      name: 'Items',
      view: { id: view, name: 'Grid' },
      fields: [
        { id: field, name: 'Name', type: 'text' },
        { id: number, name: 'Amount', type: 'number', options: { precision: 2 } },
        { id: files, name: 'Files', type: 'attachment' },
        { id: person, name: 'Person', type: 'user' },
      ],
    },
  });
  await commands(origin, database, [
    {
      kind: 'table.create',
      table: {
        id: related,
        name: 'Related',
        view: { id: newId('view'), name: 'Grid' },
        fields: [{ id: target, name: 'Title', type: 'text' }],
      },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: { id: link, name: 'Related', type: 'link', options: { linkedTableId: related } },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: {
        id: newId('field'),
        name: 'Twice',
        type: 'formula',
        options: { expression: `{${number}} * 2` },
      },
    },
    {
      kind: 'field.create',
      tableId: table,
      field: {
        id: newId('field'),
        name: 'Titles',
        type: 'lookup',
        options: { linkFieldId: link, targetFieldId: target },
      },
    },
  ]);
  const uploaded = await origin.app.inject({
    method: 'POST',
    url: `/api/tables/${table}/fields/${files}/files`,
    headers: {
      ...origin.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'notes.txt',
    },
    payload: attachment,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  await commands(origin, database, [
    {
      kind: 'record.create',
      tableId: related,
      records: [{ id: linked, values: { [target]: 'Linked title' } }],
    },
    {
      kind: 'record.create',
      tableId: table,
      records: [
        {
          id: record,
          values: {
            [field]: 'First',
            [number]: 12.5,
            [files]: [uploaded.json<{ id: string }>().id],
            [person]: [member.userId],
            [link]: [linked],
          },
        },
        { id: newId('record'), values: { [field]: `Second ${member.userId}`, [number]: 5 } },
      ],
    },
    {
      kind: 'view.update',
      viewId: view,
      config: {
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'amount', fieldId: number, operator: 'gt', value: 10 }],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: newId('automation'),
        name: 'Change name',
        config: {
          trigger: { kind: 'recordUpdated', tableId: table, fieldIds: [number] },
          steps: [
            {
              id: 'change-name',
              kind: 'updateRecord',
              tableId: table,
              record: 'trigger',
              values: { [field]: `{{trigger.record.${field}}}` },
            },
          ],
        },
      },
    },
    {
      kind: 'dashboard.create',
      dashboard: {
        id: newId('dashboard'),
        name: 'Totals',
        config: {
          tiles: [
            {
              id: 'tile-total',
              kind: 'number',
              title: 'Total',
              place: { x: 0, y: 0, w: 4, h: 2 },
              source: { tableId: table },
              value: { fn: 'sum', fieldId: number },
            },
          ],
        },
      },
    },
    {
      kind: 'interface.create',
      interface: {
        id: newId('interface'),
        name: 'Portal',
        pages: [
          {
            id: 'page-items',
            name: 'Items',
            blocks: [
              {
                id: 'block-records',
                kind: 'records',
                place: { x: 0, y: 0, w: 4, h: 2 },
                source: { tableId: table, viewId: view },
                fieldIds: [field, number],
              },
            ],
          },
        ],
      },
    },
  ]);
  if (name === 'One')
    await call(origin, 'POST', `/api/databases/${database}/save-as-template`, {
      name: 'Starting point',
      description: 'A saved workspace',
      category: 'work',
      samples: 2,
    });
  await call(origin, 'PUT', `/api/fields/${number}/permissions`, {
    restricted: { roles: ['creator'], users: [member.userId] },
    locked: { roles: ['creator'], users: [] },
  });
  await call(origin, 'PUT', `/api/tables/${table}/record-rules`, {
    rules: [
      {
        id: newId('recordRule'),
        roles: ['reader'],
        users: [member.userId],
        condition: {
          conjunction: 'and',
          conditions: [{ id: 'amount', fieldId: number, operator: 'gt', value: 10 }],
        },
      },
    ],
  });
  await query(
    origin.pool,
    sql`UPDATE ${ident(origin.schemas.app, 'databases')} SET settings = ${JSON.stringify({ theme: { id: 'nature', scheme: 'grove' } })}::jsonb WHERE id = ${database}`,
  );
  return call<DatabaseSchema>(origin, 'GET', `/api/databases/${database}/schema`);
}

export async function exportArchive(
  server: ServerFixture,
  options: { files?: boolean; audit?: boolean; passphrase?: string },
): Promise<{ id: string; bytes: Buffer }> {
  const job = await call<OrganizationArchiveJob>(
    server,
    'POST',
    '/api/organization-archives/export',
    options,
  );
  await server.ctx.organizationArchives!.settled(job.id);
  const done = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
  expect(done.error).toBeNull();
  expect(done.state).toBe('finished');
  const response = await server.app.inject({
    url: `/api/organization-archives/${job.id}/download`,
    headers: server.owner.headers,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('application/vnd.riosoma.organization');
  expect(response.headers['content-disposition']).toBe('attachment; filename="organization.rio"');
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  return { id: job.id, bytes: response.rawPayload };
}

/**
 * An organization with two linked databases, one trashed, a folder shared with a group, a member
 * with an admin role, a guest in the group, a source with a stored credential, and everything
 * that reaches outside: automations that message, email, and call the web, a webhook, a public
 * link with a password, a public form, calendar feeds, a cloud drive app, feedback to a
 * repository, and AI settings with a provider address and key.
 */
export async function buildOrigin(kit: TestPostgres, prefix: string): Promise<Origin> {
  const server = await startServer(kit, prefix);
  const attachment = Buffer.alloc(6 * 1024 * 1024 + 123, 'a');
  const member = await server.addMember({ name: 'Casey' });
  const guest = await server.addMember({ name: 'Gale', kind: 'guest' });
  const schemas = [
    await buildDatabase(server, member, 'One', attachment),
    await buildDatabase(server, member, 'Two', attachment),
  ];
  const app = server.schemas.app;
  const org = server.owner.info.org.id;
  const [first] = schemas;
  const databaseId = first!.database.id;
  const table = first!.tables.find((item) => item.name === 'Items')!;
  const view = first!.views.find((item) => item.tableId === table.id)!;
  await query(
    server.pool,
    sql`UPDATE ${ident(app, 'orgs')} SET settings = ${JSON.stringify({ theme: { id: 'nature', scheme: 'grove' } })}::jsonb,
    second_step_policy = 'everyone', automation_sms_enabled = true, feedback_github_enabled = true,
    feedback_github_repository = 'example/feedback', feedback_github_token = ${seal(server.config.secretKey, values.github, `feedback.github:${org}`)}
    WHERE id = ${org}`,
  );
  const folder = newId('folder');
  const group = newId('group');
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'folders')} (id, org_id, name) VALUES (${folder}, ${org}, 'Work')`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'groups')} (id, org_id, name, scim_managed) VALUES (${group}, ${org}, 'Readers', true)`,
  );
  for (const person of [member, guest])
    await query(
      server.pool,
      sql`INSERT INTO ${ident(app, 'group_members')} (org_id, group_id, user_id) VALUES (${org}, ${group}, ${person.userId})`,
    );
  await query(
    server.pool,
    sql`UPDATE ${ident(app, 'memberships')} SET admin_roles = ARRAY['audit'] WHERE user_id = ${member.userId}`,
  );
  for (const schema of schemas)
    await query(
      server.pool,
      sql`INSERT INTO ${ident(app, 'folder_databases')} (org_id, folder_id, database_id)
      VALUES (${org}, ${folder}, ${schema.database.id})`,
    );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'grants')}
    (org_id, resource_kind, resource_id, principal_kind, principal_id, role) VALUES (${org}, 'folder', ${folder}, 'group', ${group}, 'reader')`,
  );
  const source = await call<{ id: string }>(server, 'POST', '/api/sources', {
    name: 'Warehouse',
    connection: { kind: 'postgres', host: 'example.test', database: 'records', user: 'reader' },
    secrets: { password: values.credential },
    access: 'admins',
  });
  const incoming = await call<{ id: string; webhookPath: string }>(server, 'POST', '/api/sources', {
    name: 'Orders coming in',
    connection: { kind: 'webhook' },
    secrets: {},
    access: 'admins',
  });
  await call(server, 'POST', '/api/sources', {
    name: 'News',
    connection: { kind: 'feed', url: 'https://feeds.example.test/items.xml' },
    secrets: {},
    access: 'admins',
  });
  const signOnId = random();
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'sso_providers')}
    (id, org_id, kind, name, issuer, client_id, sealed_secret)
    VALUES (${signOnId}, ${org}, 'oidc', 'Sign in', 'https://example.test', 'application',
      ${seal(server.config.secretKey, values.credential, `sso:${signOnId}`)})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'ai_settings')} (org_id, settings) VALUES (${org}, ${JSON.stringify({
      enabled: true,
      autonomy: 'instant',
      providers: [{ providerId: TEST_PROVIDER_ID, baseUrl: 'http://127.0.0.1:9/v1' }],
      models: { everyday: { providerId: TEST_PROVIDER_ID, model: 'everyday-model' }, power: null },
    })}::jsonb)`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'ai_keys')} (org_id, provider_id, sealed)
    VALUES (${org}, ${TEST_PROVIDER_ID}, ${seal(server.config.secretKey, values.aiKey, `ai:${org}:${TEST_PROVIDER_ID}`)})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'oauth_apps')} (org_id, provider, client_id, sealed_secret, enabled)
    VALUES (${org}, 'google-drive', 'drive-client', ${seal(server.config.secretKey, values.oauth, `oauth-app:${org}:google-drive`)}, true)`,
  );
  const messaging = newId('automation');
  const calling = newId('automation');
  await commands(server, databaseId, [
    {
      kind: 'automation.create',
      automation: {
        id: messaging,
        name: 'Tell everyone',
        config: {
          trigger: { kind: 'recordCreated', tableId: table.id },
          steps: [
            { id: 'notify-slack', kind: 'slack', webhookUrl: values.slack, body: 'hello' },
            { id: 'notify-teams', kind: 'teams', webhookUrl: values.teams, body: 'hello' },
            { id: 'notify-discord', kind: 'discord', webhookUrl: values.discord, body: 'hello' },
            {
              id: 'notify-sms',
              kind: 'sms',
              accountSid: `AC${'0'.repeat(32)}`,
              authToken: values.sms,
              from: '+15005550006',
              to: '+15005550001',
              body: 'hello',
            },
          ],
        },
      },
    },
    {
      kind: 'automation.create',
      automation: {
        id: calling,
        name: 'Call out',
        config: {
          trigger: { kind: 'recordCreated', tableId: table.id },
          steps: [
            {
              id: 'call-webhook',
              kind: 'callWebhook',
              url: `https://api.example.test/in?key=${values.query}&mode=full`,
              headers: { 'X-Access-Key': values.header },
              body: '',
            },
            {
              id: 'send-email',
              kind: 'sendEmail',
              to: ['someone@example.test'],
              subject: 'New',
              body: 'New',
            },
          ],
        },
      },
    },
  ]);
  await commands(server, databaseId, [
    { kind: 'automation.update', automationId: messaging, enabled: true },
    { kind: 'automation.update', automationId: calling, enabled: true },
  ]);
  const webhook = await call<{ id: string }>(server, 'POST', `/api/databases/${databaseId}/webhooks`, {
    url: 'https://receiver.example.test/hook',
    events: ['record.created'],
  });
  const link = random(11);
  const form = random(11);
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'shared_views')} (id, org_id, database_id, view_id, settings, password_hash, created_by)
    VALUES (${link}, ${org}, ${databaseId}, ${view.id}, '{}'::jsonb, ${values.passwordHash}, ${server.owner.userId})`,
  );
  await query(
    server.pool,
    sql`INSERT INTO ${ident(app, 'public_forms')} (id, org_id, database_id, view_id, created_by)
    VALUES (${form}, ${org}, ${databaseId}, ${view.id}, ${server.owner.userId})`,
  );
  await query(
    server.pool,
    sql`UPDATE ${ident(app, 'databases')} SET trashed_at = now() WHERE id = ${schemas[1]!.database.id}`,
  );
  const exported = await exportArchive(server, { files: true, audit: true, passphrase: values.passphrase });
  const plain = await exportArchive(server, { files: true, audit: true });
  return {
    server,
    member,
    guest,
    schemas,
    attachment,
    exported: exported.bytes,
    plain: plain.bytes,
    exportId: exported.id,
    ids: {
      folder,
      group,
      source: source.id,
      incoming: incoming.webhookPath,
      messaging,
      calling,
      webhook: webhook.id,
      link,
      form,
    },
  };
}

/** A server whose mail is kept for the test to read, with an address for invitation links */
export async function target(
  kit: TestPostgres,
  prefix: string,
  overrides: Partial<RuntimeConfig> = {},
): Promise<{ server: ServerFixture; mail: Array<{ to: string; text: string }> }> {
  const server = await startServer(kit, prefix, overrides);
  const mail: Array<{ to: string; text: string }> = [];
  server.config.baseUrl = 'https://example.test';
  server.ctx.mailer = {
    send: async (message) => {
      mail.push({ to: message.to, text: message.text });
    },
  };
  return { server, mail };
}

export async function upload(server: ServerFixture, bytes: Buffer) {
  return server.app.inject({
    method: 'POST',
    url: '/api/organization-archives/import',
    headers: { ...server.owner.headers, 'content-type': 'application/vnd.riosoma.organization' },
    payload: bytes,
  });
}

/** Uploads and confirms an archive, and answers the finished job. */
export async function importArchive(
  server: ServerFixture,
  bytes: Buffer,
  passphrase?: string,
): Promise<OrganizationArchiveJob> {
  const preview = await upload(server, bytes);
  expect(preview.statusCode, preview.body).toBe(200);
  const job = preview.json<OrganizationArchiveJob>();
  await call(
    server,
    'POST',
    `/api/organization-archives/${job.id}/confirm`,
    passphrase ? { passphrase } : {},
  );
  await server.ctx.organizationArchives!.settled(job.id);
  const done = await call<OrganizationArchiveJob>(server, 'GET', `/api/organization-archives/${job.id}`);
  expect(done.error).toBeNull();
  expect(done.state).toBe('finished');
  return done;
}

export async function reviewList(server: ServerFixture): Promise<OrganizationImportReviewItem[]> {
  return call<OrganizationImportReviewItem[]>(server, 'GET', '/api/organization-archives/review');
}

export async function collect(source: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

async function lines(directory: ArchiveDirectory, name: string): Promise<unknown[]> {
  const list: unknown[] = [];
  for await (const item of jsonLines(directory.read(name))) list.push(item);
  return list;
}

/**
 * Rebuilds an archive with changed entries, recomputing every SHA-256 as anyone could.  With
 * `sign` the passphrase is known, so the manifest's HMAC is made again and each secret sealed again
 * for it.  Without it, the HMAC and secrets stay as they were, as they must for anyone without the
 * passphrase.
 */
export async function rebuild(
  bytes: Buffer,
  options: {
    summary?: (summary: OrganizationManifest) => OrganizationManifest;
    entry?: (name: string, items: unknown[]) => unknown[];
    raw?: (name: string, bytes: Buffer) => Buffer;
    add?: Array<[string, Buffer]>;
    sign?: string;
    /** Changes the secret lines as they are, for an archive rebuilt without the passphrase */
    secrets?: (items: SecretLine[]) => SecretLine[];
  } = {},
): Promise<Buffer> {
  const { directory, summary } = await unpack(Readable.from([bytes]), SCHEMA_VERSION, workDir);
  const out = await ArchiveDirectory.create(workDir);
  try {
    for (const name of directory.entries.keys()) {
      if (name === 'manifest.jsonl' || (AFTER_MANIFEST as readonly string[]).includes(name)) continue;
      if (name.endsWith('.jsonl')) {
        const items = await lines(directory, name);
        const changed = options.entry?.(name, items) ?? items;
        await out.add(name, Readable.from(changed.map(line)));
      } else {
        const raw = await collect(directory.read(name));
        await out.add(name, Readable.from([options.raw?.(name, raw) ?? raw]));
      }
    }
    for (const [name, value] of options.add ?? []) await out.add(name, Readable.from([value]));
    const next = options.summary?.(summary) ?? summary;
    await out.manifest(next);
    if (summary.encryption) {
      let secrets = (await lines(directory, 'secrets.jsonl')).map((item) => SecretLine.parse(item));
      if (options.sign) {
        const keys = await archiveKeys(options.sign, summary.encryption);
        try {
          const before = await manifestMac(keys.authentication, directory.read('manifest.jsonl'));
          const after = await manifestMac(keys.authentication, out.read('manifest.jsonl'));
          const opened = secrets.map(({ sealed, ...place }) => ({
            place,
            value: decryptSecret(keys.encryption, before, place, sealed),
          }));
          secrets = opened.map(({ place, value }) => ({
            ...place,
            sealed: encryptSecret(keys.encryption, after, place, value),
          }));
          await out.add('manifest.hmac', Readable.from([after]));
        } finally {
          forgetKeys(keys);
        }
      } else {
        secrets = options.secrets?.(secrets) ?? secrets;
        await out.add('manifest.hmac', Readable.from([await collect(directory.read('manifest.hmac'))]));
      }
      await out.add('secrets.jsonl', Readable.from(secrets.map(line)));
    }
    return await collect(out.stream());
  } finally {
    await directory.close();
    await out.close();
  }
}

export async function manifestOf(bytes: Buffer): Promise<OrganizationManifest> {
  const { directory, summary } = await unpack(Readable.from([bytes]), SCHEMA_VERSION, workDir);
  await directory.close();
  return summary;
}

export async function count(server: ServerFixture, table: string, where = sql`TRUE`): Promise<number> {
  const result = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.app, table)} WHERE ${where}`,
  );
  return Number(result.rows[0]!.count);
}

/** The review item each catalog restored only from the review list becomes */
const REVIEW_KINDS: Readonly<Record<string, string>> = {
  shared_views: 'publicLink',
  public_forms: 'publicForm',
  knowledge_libraries: 'knowledgeLibrary',
  knowledge_documents: 'knowledgeDocument',
};

/**
 * Checks that an import brought back every catalog the archive carries, at least as many rows as it
 * carried, each the way the plan says, so no catalog can travel and then be dropped.  Group
 * memberships of people who haven't joined wait with their review items, and links and forms wait
 * as review items.  Answers the catalogs it checked.
 */
export async function expectEveryCatalogBack(server: ServerFixture, bytes: Buffer): Promise<string[]> {
  const summary = await manifestOf(bytes);
  const checked: string[] = [];
  for (const { catalog, restore } of CATALOG_PLAN) {
    const carried = summary.counts[catalog] ?? 0;
    if (!carried) continue;
    checked.push(catalog);
    let back: number;
    if (catalog === 'events') {
      const events = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.audit, 'events')} WHERE metadata->>'imported' = 'true'`,
      );
      back = Number(events.rows[0]!.count);
    } else if (catalog === 'group_members') {
      const waiting = await query<{ count: string }>(
        server.pool,
        sql`SELECT COALESCE(sum(jsonb_array_length(detail->'groups')), 0) AS count
        FROM ${ident(server.schemas.app, 'organization_import_review')} WHERE kind = 'person'`,
      );
      back = (await count(server, catalog)) + Number(waiting.rows[0]!.count);
    } else if (restore === 'review') {
      back = await count(server, 'organization_import_review', sql`kind = ${REVIEW_KINDS[catalog] ?? ''}`);
    } else back = await count(server, catalog);
    expect(back, catalog).toBeGreaterThanOrEqual(carried);
  }
  return checked;
}

export type { OrganizationImportReviewItem };
