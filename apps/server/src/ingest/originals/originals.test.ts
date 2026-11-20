import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  DatabaseCreate,
  ClassificationRules,
  newId,
  type IngestFile,
  type IngestOriginalCommand,
  type SharedViewLink,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { loadTable } from '../../data/metadata.js';
import { storeOriginal } from '../../data/files/originals.js';
import * as storage from '../../data/files/storage.js';
import { IngestTableStore } from '../tables/store.js';
import { IngestWorker } from '../pipeline/index.js';
import { PipelineStore } from '../pipeline/store.js';
import { drainOriginalDeletions, sweepOriginals } from './retention.js';

let kit: TestPostgres;
let server: ServerFixture;
let store: IngestTableStore;
let directory: string;
let reader: SignedIn;
let commenter: SignedIn;
let editor: SignedIn;
beforeAll(async () => {
  kit = await startTestPostgres();
  directory = await mkdtemp(join(tmpdir(), 'ingest-originals-'));
  // Public view pages need a web shell even when only the server has been built.
  const webDir = join(directory, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<html><head></head><body></body></html>');
  server = await startServer(kit, 'originaldoors', { filesDir: directory, webDir });
  server.ctx.ingest!.pause();
  store = new IngestTableStore(server.pool, server.schemas);
  reader = await server.addMember({ name: 'Reader' });
  commenter = await server.addMember({ name: 'Commenter' });
  editor = await server.addMember({ name: 'Editor' });
  await server.pool.query(
    `UPDATE ${server.schemas.app}.orgs SET public_sharing = '{"publicFiles":true}' WHERE id = $1`,
    [server.owner.info.org.id],
  );
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(keepDays: number | 'forever' | null = 90) {
  const specs = [
    { key: 'code', type: 'text' },
    { key: 'amount', type: 'number' },
    { key: 'needsReview', type: 'checkbox' },
    { key: 'reviewNote', type: 'longText' },
    { key: 'readByAi', type: 'checkbox' },
    { key: 'source', type: 'text' },
    { key: 'received', type: 'date', options: { includeTime: true } },
    { key: 'private', type: 'text' },
    { key: 'photo', type: 'attachment' },
  ].map((field) => ({ ...field, id: newId('field') }));
  const input = DatabaseCreate.parse({
    id: newId('database'),
    name: 'Incoming',
    table: {
      id: newId('table'),
      name: 'Arrivals',
      fields: specs.map((field) => ({ ...field, name: field.key })),
      view: { id: newId('view'), name: 'Grid' },
    },
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: input,
  });
  expect(created.statusCode, created.body).toBe(200);
  const context = { orgId: server.owner.info.org.id, tableId: input.table.id, userId: server.owner.userId };
  await store.changeSettings(context, null, {
    state: 'live',
    ownerId: server.owner.userId,
    rowMeaning: 'An arrival',
    identity: ['code'],
    fields: specs
      .slice(0, 2)
      .map((field) => ({ key: field.key, fieldId: field.id, meaning: field.key, required: false })),
    originals: { keepDays, readOnlyAccess: false },
    reply: true,
  });
  for (const field of specs.slice(0, 7))
    await store.markField(context, field.id, {
      key: field.key,
      role: ['code', 'amount'].includes(field.key) ? 'data' : 'process',
    });
  for (const [person, role] of [
    [reader, 'reader'],
    [commenter, 'commenter'],
    [editor, 'editor'],
  ] as const)
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${context.orgId}, 'database', ${input.id}, 'user', ${person.userId}, ${role})`,
    );
  return { input, context, specs, table: (await loadTable(server.pool, server.schemas, context.tableId))! };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function original(
  f: Fixture,
  options: {
    age?: number;
    bytes?: Buffer;
    kind?: 'postgres' | 'local';
    parentId?: string;
    name?: string;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from(`Code,Amount\n${randomUUID()},1\n`);
  const receivedAt = new Date(Date.now() - (options.age ?? 0) * 86_400_000).toISOString();
  const file = await store.createFile(f.context, {
    origin: options.parentId ? 'part' : 'drop',
    parentId: options.parentId ?? null,
    name: options.name ?? 'private-arrival.csv',
    mediaType: 'text/csv',
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    storedFile: null,
    receivedAt,
    expiresAt: new Date(Date.parse(receivedAt) + 90 * 86_400_000).toISOString(),
  });
  const config = { ...server.config, filesStorage: options.kind ?? 'postgres' };
  const saved = await withTransaction(server.pool, (db) =>
    storeOriginal(
      db,
      server.schemas.app,
      config,
      { ...f.context, fileId: file.id },
      { name: file.name, bytes },
      () => {},
    ),
  );
  return { file: await store.updateFile(f.context, file.id, { storedFile: saved.id }), bytes, saved };
}
const url = (f: Fixture, fileId: string) =>
  `/api/tables/${f.context.tableId}/ingest/files/${fileId}/original`;
const command = (f: Fixture, body: IngestOriginalCommand, person = server.owner) =>
  server.app.inject({
    method: 'POST',
    url: `/api/tables/${f.context.tableId}/ingest/originals/commands`,
    headers: person.headers,
    payload: body,
  });
async function publishShare(f: Fixture, kind: 'view' | 'site') {
  if (kind === 'view') {
    const response = await server.app.inject({
      method: 'PUT',
      url: `/api/views/${f.input.table.view.id}/shared-view`,
      headers: server.owner.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const id = response.json<SharedViewLink>().linkId;
    return { id, address: (fileId: string) => `/api/public/views/${id}/ingest/files/${fileId}/original` };
  }
  const interfaceId = newId('interface');
  const created = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${f.input.id}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [
        {
          id: newId('command'),
          groupId: newId('action'),
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: 'Incoming',
            pages: [
              {
                id: 'page0001',
                name: 'Arrivals',
                blocks: [
                  {
                    id: 'block001',
                    kind: 'records',
                    place: { x: 0, y: 0, w: 6, h: 4 },
                    source: { tableId: f.context.tableId, viewId: f.input.table.view.id },
                    fieldIds: [f.specs[0]!.id],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  expect(created.json().results[0].status, created.body).toBe('applied');
  const id = `arrivals-${randomUUID().slice(0, 8)}`;
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/interfaces/${interfaceId}/site`,
    headers: server.owner.headers,
    payload: {
      slug: id,
      title: 'Arrivals',
      pages: [{ pageId: 'page0001', slug: 'arrivals', title: 'Arrivals' }],
    },
  });
  expect(published.statusCode, published.body).toBe(200);
  return {
    id,
    address: (fileId: string) =>
      `/api/public/sites/${id}/tables/${f.context.tableId}/ingest/files/${fileId}/original`,
  };
}
async function switchTable(f: Fixture, enabled: boolean) {
  const response = await command(f, { kind: 'ingest.originals.readOnly', enabled });
  expect(response.statusCode, response.body).toBe(200);
}
async function opened(
  f: Fixture,
  file: IngestFile,
  headers: Record<string, string>,
  allowed: boolean,
  address = url(f, file.id),
) {
  const before = await server.pool.query(
    `SELECT id FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.original.opened' AND metadata->>'fileId' = $1`,
    [file.id],
  );
  const response = await server.app.inject({ url: address, headers });
  expect(response.statusCode, response.body).toBe(allowed ? 200 : 404);
  if (!allowed) {
    const missing = await server.app.inject({ url: address.replace(file.id, 'missing-original'), headers });
    expect(response.body).toBe(missing.body);
  }
  const after = await server.pool.query(
    `SELECT metadata FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.original.opened' AND metadata->>'fileId' = $1 ORDER BY id`,
    [file.id],
  );
  expect(after.rows).toHaveLength(before.rowCount! + 1);
  expect(after.rows.at(-1).metadata).toMatchObject({
    fileId: file.id,
    outcome: allowed ? 'allowed' : 'refused',
  });
  expect(JSON.stringify(after.rows)).not.toContain(file.name);
}

it('admits editors and keeps readers and commenters behind the table switch, with identical refusals and one audit per open', async () => {
  const f = await fixture();
  const { file } = await original(f);
  await opened(f, file, server.owner.headers, true);
  await opened(f, file, editor.headers, true);
  await opened(f, file, reader.headers, false);
  await opened(f, file, commenter.headers, false);
  await opened(f, file, {}, false);
  await switchTable(f, true);
  await opened(f, file, reader.headers, true);
  await opened(f, file, commenter.headers, true);
  const refused = await command(f, { kind: 'ingest.originals.readOnly', enabled: false }, reader);
  expect(refused.statusCode).toBe(403);
});

it.each(['record', 'field'] as const)('treats an editor with a hidden %s as read-only', async (rule) => {
  const f = await fixture();
  const { file } = await original(f);
  const response =
    rule === 'record'
      ? await server.app.inject({
          method: 'PUT',
          url: `/api/tables/${f.context.tableId}/record-rules`,
          headers: server.owner.headers,
          payload: {
            rules: [
              {
                id: newId('recordRule'),
                roles: [],
                users: [editor.userId],
                condition: {
                  conjunction: 'and',
                  conditions: [{ id: 'code', fieldId: f.specs[0]!.id, operator: 'is', value: 'visible' }],
                },
              },
            ],
          },
        })
      : await server.app.inject({
          method: 'PUT',
          url: `/api/fields/${f.specs[7]!.id}/permissions`,
          headers: server.owner.headers,
          payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
        });
  expect(response.statusCode, response.body).toBe(200);
  await opened(f, file, editor.headers, false);
  await switchTable(f, true);
  await opened(f, file, editor.headers, true);
});

it('requires record scopes for tokens and applies the token owner’s role', async () => {
  const f = await fixture();
  const { file } = await original(f);
  for (const person of [server.owner, reader]) {
    for (const scope of ['data.records:read', 'schema.bases:read'] as const) {
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/tokens',
        headers: person.headers,
        payload: { name: 'Original read', scopes: [scope], databases: [f.input.id] },
      });
      expect(created.statusCode, created.body).toBe(200);
      const headers = { authorization: `Bearer ${created.json().token}` };
      await opened(f, file, headers, person === server.owner && scope === 'data.records:read');
      if (person === reader && scope === 'data.records:read') {
        await switchTable(f, true);
        await opened(f, file, headers, true);
        await switchTable(f, false);
      }
    }
  }
});

it.each(['automation', 'script'] as const)(
  'applies a %s person’s read permissions through the real route',
  async (kind) => {
    const f = await fixture();
    const { file } = await original(f);
    const resolve = server.ctx.sessions.resolve.bind(server.ctx.sessions);
    const spy = vi.spyOn(server.ctx.sessions, 'resolve').mockImplementation(async (request) => {
      const actor = await resolve(request);
      return actor ? { ...actor, [kind]: { id: 'run-source', runId: 'run', depth: 0 } } : actor;
    });
    try {
      await opened(f, file, editor.headers, true);
      await opened(f, file, reader.headers, false);
      await switchTable(f, true);
      await opened(f, file, reader.headers, true);
    } finally {
      spy.mockRestore();
    }
  },
);

it('keeps a shared view and its public link behind their own switch and still refuses signed-in readers', async () => {
  const f = await fixture();
  const { file } = await original(f);
  const published = await server.app.inject({
    method: 'PUT',
    url: `/api/views/${f.input.table.view.id}/shared-view`,
    headers: server.owner.headers,
  });
  expect(published.statusCode, published.body).toBe(200);
  const linkId = published.json<SharedViewLink>().linkId;
  const address = `/api/public/views/${linkId}/ingest/files/${file.id}/original`;
  await opened(f, file, {}, false, address);
  await switchTable(f, true);
  await opened(f, file, {}, false, address);
  await switchTable(f, false);
  const enabled = await command(f, {
    kind: 'ingest.originals.share',
    share: { kind: 'view', id: linkId },
    enabled: true,
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  await opened(f, file, {}, true, address);
  await opened(f, file, reader.headers, true, address);
  await opened(f, file, reader.headers, false);
  await server.app.inject({
    method: 'PATCH',
    url: `/api/views/${f.input.table.view.id}/shared-view`,
    headers: server.owner.headers,
    payload: { password: 'a-password' },
  });
  await opened(f, file, {}, false, address);
  const unlocked = await server.app.inject({
    method: 'POST',
    url: `/api/public/views/${linkId}/password`,
    payload: { password: 'a-password' },
  });
  const cookie = unlocked.cookies.map((value) => `${value.name}=${value.value}`).join('; ');
  await opened(f, file, { cookie }, true, address);
});

it.each(['site', 'interface'] as const)(
  'requires a published %s switch and the existing publication guards',
  async (kind) => {
    const f = await fixture();
    const { file } = await original(f);
    const interfaceId = newId('interface');
    const created = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${f.input.id}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          {
            id: newId('command'),
            groupId: newId('action'),
            kind: 'interface.create',
            interface: {
              id: interfaceId,
              name: 'Incoming',
              pages: [
                {
                  id: 'page0001',
                  name: 'Arrivals',
                  blocks: [
                    {
                      id: 'block001',
                      kind: 'records',
                      place: { x: 0, y: 0, w: 6, h: 4 },
                      source: { tableId: f.context.tableId, viewId: f.input.table.view.id },
                      fieldIds: [f.specs[0]!.id],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    expect(created.json().results[0].status, created.body).toBe('applied');
    const slug = `arrivals-${randomUUID().slice(0, 8)}`;
    const published = await server.app.inject({
      method: 'PUT',
      url: `/api/interfaces/${interfaceId}/site`,
      headers: server.owner.headers,
      payload: {
        slug,
        title: 'Arrivals',
        pages: [{ pageId: 'page0001', slug: 'arrivals', title: 'Arrivals' }],
      },
    });
    expect(published.statusCode, published.body).toBe(200);
    const address = `/api/public/sites/${slug}/tables/${f.context.tableId}/ingest/files/${file.id}/original`;
    await opened(f, file, {}, false, address);
    await switchTable(f, true);
    await opened(f, file, {}, false, address);
    const enabled = await command(f, {
      kind: 'ingest.originals.share',
      enabled: true,
      share: { kind, id: kind === 'site' ? slug : interfaceId },
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    await opened(f, file, {}, true, address);
    await switchTable(f, false);
    await opened(f, file, reader.headers, false);
    await server.app.inject({
      method: 'DELETE',
      url: `/api/interfaces/${interfaceId}/site`,
      headers: server.owner.headers,
    });
    await opened(f, file, {}, false, address);
  },
);

it.each(['view', 'site'] as const)(
  'requires export permission for every field of an original opened through a public %s',
  async (kind) => {
    const f = await fixture();
    const { file } = await original(f);
    const share = await publishShare(f, kind);
    const enabled = await command(f, {
      kind: 'ingest.originals.share',
      share: { kind, id: share.id },
      enabled: true,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    await opened(f, file, {}, true, share.address(file.id));
    const govern = async (action: object) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/api/admin/governance/commands',
        headers: server.owner.headers,
        payload: { kind: 'governance.apply', id: newId('command'), action },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().status, response.body).toBe('applied');
    };
    const governance = await server.app.inject({
      url: '/api/admin/governance',
      headers: server.owner.headers,
    });
    expect(governance.statusCode, governance.body).toBe(200);
    const labelId = `restricted-${randomUUID()}`;
    await govern({
      kind: 'classification.labels',
      labels: [
        ...governance.json().labels,
        {
          id: labelId,
          name: `Restricted ${kind}`,
          color: 'red',
          description: '',
          rules: ClassificationRules.parse({ noExport: true }),
        },
      ],
    });
    for (const target of [
      { kind: 'table', databaseId: f.input.id, tableId: f.context.tableId },
      { kind: 'field', databaseId: f.input.id, fieldId: f.specs[7]!.id },
    ]) {
      await govern({ kind: 'classification.assign', target, labelId });
      await opened(f, file, server.owner.headers, false);
      await opened(f, file, {}, false, share.address(file.id));
      await govern({ kind: 'classification.assign', target, labelId: null });
      await opened(f, file, {}, true, share.address(file.id));
    }
  },
);

it.each(['view', 'site'] as const)(
  'serves and audits allowed and refused originals on a verified %s domain',
  async (kind) => {
    const f = await fixture();
    const { file, bytes } = await original(f);
    const share = await publishShare(f, kind);
    const domainId = randomUUID();
    const host = `${randomUUID()}.test`;
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.custom_domains
      (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at)
      VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [domainId, f.context.orgId, host, randomUUID(), [kind === 'view' ? 'views' : 'sites']],
    );
    if (kind === 'site')
      await server.pool.query(
        `UPDATE ${server.schemas.app}.published_sites SET domain_id = $1 WHERE slug = $2`,
        [domainId, share.id],
      );
    const page = await server.app.inject({
      url: kind === 'view' ? `/v/${share.id}` : '/arrivals',
      headers: { host },
    });
    expect(page.statusCode, page.body).toBe(200);
    const address = share.address(file.id);
    await opened(f, file, { host }, false, address);
    const enabled = await command(f, {
      kind: 'ingest.originals.share',
      share: { kind, id: share.id },
      enabled: true,
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    await opened(f, file, {}, true, address);
    await opened(f, file, { host }, true, address);
    const downloaded = await server.app.inject({ url: address, headers: { host } });
    expect(downloaded.rawPayload).toEqual(bytes);
    const head = await server.app.inject({ method: 'HEAD', url: address, headers: { host } });
    expect(head.statusCode, head.body).toBe(200);
    expect(head.headers['content-length']).toBe(String(bytes.length));
    const otherOrgId = newId('org');
    await server.pool.query(`INSERT INTO ${server.schemas.app}.orgs (id, name) VALUES ($1, $2)`, [
      otherOrgId,
      'Other organization',
    ]);
    const otherHost = `${randomUUID()}.test`;
    await server.pool.query(
      `INSERT INTO ${server.schemas.app}.custom_domains
      (id, org_id, host, challenge, kinds, verified_at, first_verified_at, checked_at)
      VALUES ($1, $2, $3, $4, $5, now(), now(), now())`,
      [randomUUID(), otherOrgId, otherHost, randomUUID(), [kind === 'view' ? 'views' : 'sites']],
    );
    const refused = await server.app.inject({ url: address, headers: { host: otherHost } });
    expect(refused.statusCode, refused.body).toBe(404);
    const privateDoor = await server.app.inject({
      url: url(f, file.id),
      headers: { host, ...server.owner.headers },
    });
    expect(privateDoor.statusCode, privateDoor.body).toBe(404);
  },
);

it('keeps the expiry activity note when an active reading lease finishes after the sweep', async () => {
  const f = await fixture();
  const { file } = await original(f, { age: 120 });
  const pipeline = new PipelineStore(server.app);
  const token = randomUUID();
  const reading = await store.updateFile(f.context, file.id, {
    state: 'reading',
    leasedBy: token,
    leaseUntil: new Date(Date.now() + 300_000).toISOString(),
  });
  const claim = { file: reading, token, job: await pipeline.job(server.pool, reading) };
  await sweepOriginals(server.ctx);
  const expired = (await store.readFile(f.context, file.id))!;
  expect(expired.notes).toContainEqual({ messageId: 'ingest.pipeline.originalExpired' });
  await pipeline.finish(claim, { state: 'read', notes: [] });
  const finished = (await store.readFile(f.context, file.id))!;
  expect(finished).toMatchObject({
    state: 'read',
    storedFile: null,
    originalExpiredAt: expired.originalExpiredAt,
  });
  expect(finished.notes).toContainEqual({ messageId: 'ingest.pipeline.originalExpired' });
  const response = await server.app.inject({ url: url(f, file.id), headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(410);
  expect(response.json()).toMatchObject({ outcome: 'expired', messageId: 'ingest.pipeline.originalExpired' });
});

it('matches attachment headers for generated bytes, supports ranges, and never serves a pending scan', async () => {
  const f = await fixture();
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#00aaff' } })
    .png()
    .toBuffer();
  const { file, saved } = await original(f, { bytes, name: 'private-arrival.png' });
  const uploaded = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${f.context.tableId}/fields/${f.specs[8]!.id}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': file.name,
    },
    payload: bytes,
  });
  expect(uploaded.statusCode, uploaded.body).toBe(200);
  const attachmentId = uploaded.json().id;
  const attachment = await server.app.inject({
    url: `/api/files/${attachmentId}/${file.name}`,
    headers: server.owner.headers,
  });
  const downloaded = await server.app.inject({ url: url(f, file.id), headers: server.owner.headers });
  expect(downloaded.rawPayload).toEqual(attachment.rawPayload);
  for (const header of [
    'content-type',
    'content-length',
    'content-disposition',
    'etag',
    'cache-control',
    'content-security-policy',
    'x-content-type-options',
  ])
    expect(downloaded.headers[header], header).toEqual(attachment.headers[header]);
  await server.pool.query(`UPDATE ${server.schemas.app}.files SET scan_state = 'unavailable' WHERE id = $1`, [
    saved.id,
  ]);
  await opened(f, file, server.owner.headers, false);
  const audio = Buffer.alloc(76);
  audio.write('RIFF', 0);
  audio.writeUInt32LE(68, 4);
  audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24);
  audio.writeUInt32LE(16000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write('data', 36);
  audio.writeUInt32LE(32, 40);
  const sound = await original(f, { bytes: audio, name: 'private-arrival.wav' });
  const range = await server.app.inject({
    url: url(f, sound.file.id),
    headers: { ...server.owner.headers, range: 'bytes=2-8' },
  });
  expect(range.statusCode).toBe(206);
  expect(range.rawPayload).toEqual(audio.subarray(2, 9));
  const invalid = await server.app.inject({
    url: url(f, sound.file.id),
    headers: { ...server.owner.headers, range: 'bytes=9999-' },
  });
  expect(invalid.statusCode).toBe(416);
});

it('refuses demo actors at every new download, command, and settings route', async () => {
  const f = await fixture();
  const { file } = await original(f);
  const spy = vi.spyOn(server.ctx.sessions, 'resolve').mockResolvedValue({
    userId: server.owner.userId,
    orgId: server.owner.info.org.id,
    kind: 'owner',
    adminRoles: [],
    sessionId: 'demo-session',
    csrfToken: server.owner.info.csrfToken,
    demo: true,
  });
  try {
    for (const address of [
      url(f, file.id),
      `/api/public/views/missing/ingest/files/${file.id}/original`,
      `/api/public/sites/missing/tables/${f.context.tableId}/ingest/files/${file.id}/original`,
      '/api/org/ingest',
    ]) {
      const response = await server.app.inject({ url: address, headers: server.owner.headers });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().error.messageKey).toBe('demo.readOnly');
    }
    for (const body of [
      { kind: 'ingest.originals.readOnly', enabled: true },
      { kind: 'ingest.originals.retention', keepDays: 30 },
      { kind: 'ingest.originals.share', enabled: true, share: { kind: 'view', id: 'missing' } },
    ] as const)
      expect((await command(f, body)).statusCode).toBe(403);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/org/ingest/commands',
      headers: server.owner.headers,
      payload: { kind: 'organization.ingest', settings: { originalKeepDays: 30, probationFiles: 1 } },
    });
    expect(response.statusCode, response.body).toBe(403);
  } finally {
    spy.mockRestore();
  }
});

it('previews count and bytes, binds confirmation to the change, preserves examples, and never restores expired originals', async () => {
  const f = await fixture();
  const old = await original(f, { age: 60 });
  const recent = await original(f, { age: 2 });
  const example = await original(f, { age: 120 });
  const format = await store.createFormat(f.context, {
    name: 'CSV',
    state: 'draft',
    probationPassed: 0,
    signature: { id: 'csv', kind: 'text', headerGroups: [], markers: [] },
    reading: 'ai',
    rules: null,
  });
  const pair = await store.createExample(f.context, {
    formatId: format.id,
    fileId: example.file.id,
    expected: [{ values: {} }],
    own: true,
  });
  const body = { kind: 'ingest.originals.retention' as const, keepDays: 30 };
  const preview = await command(f, body);
  expect(preview.json()).toMatchObject({
    status: 'confirmation-required',
    originals: 1,
    bytes: old.bytes.length,
    examples: 1,
  });
  expect((await store.readFile(f.context, old.file.id))!.storedFile).toBe(old.saved.id);
  expect((await command(f, body)).json().status).toBe('confirmation-required');
  const wrong = await command(f, {
    ...body,
    keepDays: 1,
    confirmationToken: preview.json().confirmationToken,
  });
  expect(wrong.json().status).toBe('confirmation-required');
  const applied = await command(f, { ...body, confirmationToken: preview.json().confirmationToken });
  expect(applied.json()).toMatchObject({
    status: 'applied',
    originals: 1,
    bytes: old.bytes.length,
    examples: 1,
  });
  expect((await store.readFile(f.context, old.file.id))!).toMatchObject({
    storedFile: null,
    notes: [{ messageId: 'ingest.pipeline.originalExpired' }],
  });
  expect((await store.readFile(f.context, recent.file.id))!.storedFile).toBe(recent.saved.id);
  expect((await store.readFile(f.context, example.file.id))!.expiresAt).toBeNull();
  for (const keepDays of [1, 3650, 'forever'] as const) {
    const response = await command(f, { ...body, keepDays });
    if (response.json().confirmationToken)
      await command(f, { ...body, keepDays, confirmationToken: response.json().confirmationToken });
    expect((await store.readFile(f.context, example.file.id))!.storedFile).toBe(example.saved.id);
  }
  expect((await store.readFile(f.context, old.file.id))!.storedFile).toBeNull();
  const expired = await server.app.inject({ url: url(f, old.file.id), headers: server.owner.headers });
  expect(expired.statusCode).toBe(410);
  expect(expired.json()).toMatchObject({ outcome: 'expired', messageId: 'ingest.pipeline.originalExpired' });
  await store.removeExample(f.context, pair.id, 30);
  const released = (await store.readFile(f.context, example.file.id))!;
  expect(released.isExample).toBe(false);
  expect(Date.parse(released.expiresAt!) - Date.parse(released.receivedAt)).toBe(30 * 86_400_000);
  await sweepOriginals(server.ctx);
  expect((await store.readFile(f.context, example.file.id))!.storedFile).toBeNull();
});

it('updates organization followers with confirmation and validates retention and probation bounds', async () => {
  const follower = await fixture(null);
  const override = await fixture(90);
  const old = await original(follower, { age: 60 });
  const kept = await original(override, { age: 60 });
  const settings = { originalKeepDays: 30, probationFiles: 3 };
  const send = (payload: object, person = server.owner) =>
    server.app.inject({ method: 'POST', url: '/api/org/ingest/commands', headers: person.headers, payload });
  const preview = await send({ kind: 'organization.ingest', settings });
  expect(preview.json()).toMatchObject({
    status: 'confirmation-required',
    originals: 1,
    bytes: old.bytes.length,
  });
  expect((await store.readFile(follower.context, old.file.id))!.storedFile).toBe(old.saved.id);
  const applied = await send({
    kind: 'organization.ingest',
    settings,
    confirmationToken: preview.json().confirmationToken,
  });
  expect(applied.json().status).toBe('applied');
  expect((await store.readFile(follower.context, old.file.id))!.storedFile).toBeNull();
  expect((await store.readFile(override.context, kept.file.id))!.storedFile).toBe(kept.saved.id);
  expect((await send({ kind: 'organization.ingest', settings }, reader)).statusCode).toBe(403);
  for (const probationFiles of [0, 11, 1.5])
    expect(
      (await send({ kind: 'organization.ingest', settings: { ...settings, probationFiles } })).statusCode,
    ).toBe(422);
  for (const keepDays of [0, 3651, 1.5])
    expect((await command(follower, { kind: 'ingest.originals.retention', keepDays })).statusCode).toBe(422);
  await send({ kind: 'organization.ingest', settings: { originalKeepDays: 90, probationFiles: 3 } });
});

it('sweeps in bounded batches, skips a legal hold and examples, and retries outside bytes after committed row deletion', async () => {
  const f = await fixture();
  const held = await fixture();
  const files = await Promise.all([
    original(f, { age: 120 }),
    original(f, { age: 120 }),
    original(f, { age: 120, kind: 'local' }),
  ]);
  const recent = await original(f);
  const protectedFile = await original(held, { age: 120 });
  await server.pool.query(`UPDATE ${server.schemas.app}.databases SET legal_hold = true WHERE id = $1`, [
    held.input.id,
  ]);
  const outside = files[2]!;
  const real = storage.fileStorage;
  let attempts = 0;
  const spy = vi.spyOn(storage, 'fileStorage').mockImplementation((kind, db, schema, config) => {
    const adapter = real(kind, db, schema, config);
    if (kind !== 'local') return adapter;
    return {
      ...adapter,
      async delete(key) {
        const row = await server.pool.query(`SELECT id FROM ${server.schemas.app}.files WHERE id = $1`, [
          outside.saved.id,
        ]);
        expect(row.rowCount).toBe(0);
        if (++attempts === 1) throw new Error('Storage unavailable');
        await adapter.delete(key);
      },
    };
  });
  const before = await server.pool.query(
    `SELECT id FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.originals.swept'`,
  );
  try {
    const result = await sweepOriginals(server.ctx, 2);
    expect(result).toEqual({ originals: 3, bytes: files.reduce((sum, file) => sum + file.bytes.length, 0) });
    expect((await store.readFile(f.context, outside.file.id))!.storedFile).toBeNull();
    const pending = await server.pool.query(
      `SELECT attempts FROM ${server.schemas.app}.ingest_original_deletions WHERE id = $1`,
      [outside.saved.id],
    );
    expect(pending.rows).toEqual([{ attempts: 1 }]);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.ingest_original_deletions SET retry_at = now() WHERE id = $1`,
      [outside.saved.id],
    );
    expect(await drainOriginalDeletions(server.ctx)).toBe(outside.bytes.length);
    expect(attempts).toBe(2);
  } finally {
    spy.mockRestore();
  }
  expect((await store.readFile(f.context, recent.file.id))!.storedFile).toBe(recent.saved.id);
  expect((await store.readFile(held.context, protectedFile.file.id))!.storedFile).toBe(
    protectedFile.saved.id,
  );
  const after = await server.pool.query(
    `SELECT metadata FROM ${server.schemas.audit}.events WHERE action = 'data.ingest.originals.swept' ORDER BY id`,
  );
  expect(after.rows).toHaveLength(before.rowCount! + 1);
  expect(after.rows.at(-1).metadata).toMatchObject({
    originals: 3,
    bytes: files[0]!.bytes.length + files[1]!.bytes.length,
    removedBytes: files.reduce((sum, file) => sum + file.bytes.length, 0),
    pendingBytes: outside.bytes.length,
  });
});

it('audits bytes freed by a retry-only sweep once for the organization', async () => {
  const f = await fixture();
  const outside = await original(f, { age: 120, kind: 'local' });
  const databases = await server.pool.query<{ id: string }>(
    `SELECT id FROM ${server.schemas.app}.databases WHERE org_id = $1 AND NOT legal_hold`,
    [f.context.orgId],
  );
  const databaseIds = databases.rows.map((row) => row.id);
  const audits = async () =>
    (
      await server.pool.query(
        `SELECT metadata FROM ${server.schemas.audit}.events
        WHERE action = 'data.ingest.originals.swept' AND org_id = $1 ORDER BY id`,
        [f.context.orgId],
      )
    ).rows;
  const before = (await audits()).length;
  const real = storage.fileStorage;
  let attempts = 0;
  const spy = vi.spyOn(storage, 'fileStorage').mockImplementation((kind, db, schema, config) => {
    const adapter = real(kind, db, schema, config);
    if (kind !== 'local') return adapter;
    return {
      ...adapter,
      async delete(key) {
        if (++attempts === 1) throw new Error('Storage unavailable');
        await adapter.delete(key);
      },
    };
  });
  try {
    expect(await sweepOriginals(server.ctx)).toEqual({ originals: 1, bytes: outside.bytes.length });
    expect((await store.readFile(f.context, outside.file.id))!.storedFile).toBeNull();
    expect((await audits()).slice(before)).toEqual([
      {
        metadata: {
          originals: 1,
          bytes: 0,
          removedBytes: outside.bytes.length,
          pendingBytes: outside.bytes.length,
        },
      },
    ]);
    const pending = await server.pool.query(
      `SELECT attempts FROM ${server.schemas.app}.ingest_original_deletions WHERE id = $1`,
      [outside.saved.id],
    );
    expect(pending.rows).toEqual([{ attempts: 1 }]);
    await server.pool.query(
      `UPDATE ${server.schemas.app}.ingest_original_deletions SET retry_at = now() WHERE id = $1`,
      [outside.saved.id],
    );
    // No database scan contributes totals while committed outside deletions are retried.
    await server.pool.query(
      `UPDATE ${server.schemas.app}.databases SET legal_hold = true WHERE id = ANY($1::text[])`,
      [databaseIds],
    );
    expect(await sweepOriginals(server.ctx)).toEqual({ originals: 0, bytes: 0 });
    expect(attempts).toBe(2);
    expect(
      (
        await server.pool.query(
          `SELECT id FROM ${server.schemas.app}.ingest_original_deletions WHERE id = $1`,
          [outside.saved.id],
        )
      ).rows,
    ).toEqual([]);
    expect((await audits()).slice(before)).toEqual([
      {
        metadata: {
          originals: 1,
          bytes: 0,
          removedBytes: outside.bytes.length,
          pendingBytes: outside.bytes.length,
        },
      },
      {
        metadata: {
          originals: 0,
          bytes: outside.bytes.length,
          removedBytes: 0,
          pendingBytes: 0,
        },
      },
    ]);
    expect(await sweepOriginals(server.ctx)).toEqual({ originals: 0, bytes: 0 });
    expect(await audits()).toHaveLength(before + 2);
    expect(attempts).toBe(2);
  } finally {
    spy.mockRestore();
    await server.pool.query(
      `UPDATE ${server.schemas.app}.databases SET legal_hold = false WHERE id = ANY($1::text[])`,
      [databaseIds],
    );
  }
});

it.each([1, 3, 5])(
  'leaves probation after exactly %i clean files and keeps rows and activity after expiry',
  async (probationFiles) => {
    const f = await fixture();
    const setting = await server.app.inject({
      method: 'POST',
      url: '/api/org/ingest/commands',
      headers: server.owner.headers,
      payload: { kind: 'organization.ingest', settings: { originalKeepDays: 90, probationFiles } },
    });
    expect(setting.statusCode, setting.body).toBe(200);
    const format = await store.createFormat(f.context, {
      name: 'CSV',
      state: 'probation',
      probationPassed: 0,
      signature: { id: 'code', kind: 'text', headerGroups: [['Code']], markers: [] },
      reading: 'layout',
      rules: {
        header: { markers: ['Code'], searchRows: 10 },
        columns: {
          code: { aliases: ['Code'], cleaners: [{ kind: 'text' }] },
          amount: { aliases: ['Amount'], cleaners: [{ kind: 'number' }] },
        },
      },
    });
    const worker = new IngestWorker(server.app);
    let last: IngestFile | undefined;
    try {
      for (let count = 1; count <= probationFiles; count++) {
        last = await worker.receiveFile(f.table, {
          name: 'rows.csv',
          bytes: Buffer.from(`Code,Amount\n${randomUUID()},1\n`),
          droppedBy: server.owner.userId,
        });
        await worker.drain();
        expect((await store.readFile(f.context, last.id))!.state).toBe('read');
        expect(await store.readFormat(f.context, format.id)).toMatchObject({
          probationPassed: count,
          state: count === probationFiles ? 'live' : 'probation',
        });
        if (count === 1 && probationFiles > 1) {
          await worker.resumeFile(last.id, server.owner.userId);
          await worker.drain();
          expect(await store.readFormat(f.context, format.id)).toMatchObject({
            probationPassed: 1,
            state: 'probation',
          });
        }
      }
      const records = await query(
        server.pool,
        sql`SELECT __id FROM ${ident(server.schemas.data, f.context.tableId)}`,
      );
      await server.pool.query(
        `UPDATE ${server.schemas.app}.ingest_files SET expires_at = now() - interval '1 day' WHERE id = $1`,
        [last!.id],
      );
      await sweepOriginals(server.ctx);
      expect(
        (await query(server.pool, sql`SELECT __id FROM ${ident(server.schemas.data, f.context.tableId)}`))
          .rows,
      ).toEqual(records.rows);
      expect((await store.readFile(f.context, last!.id))!.notes).toContainEqual({
        messageId: 'ingest.pipeline.originalExpired',
      });
      await expect(worker.retryFile(last!.id, server.owner.userId)).rejects.toMatchObject({
        messageKey: 'ingest.pipeline.originalExpired',
      });
    } finally {
      await worker.close();
    }
  },
);
