import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture, type SignedIn } from '../../test/fixture.js';
import { saveFieldRules, saveRecordRules } from '../permissions/store.js';
import { cleanupUploads } from './resumable.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'resumable');
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function setup() {
  const databaseId = newId('database');
  const tableId = newId('table');
  const fieldId = newId('field');
  const nameFieldId = newId('field');
  const recordId = newId('record');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: databaseId,
      name: 'Files',
      table: {
        id: tableId,
        name: 'Files',
        fields: [
          { id: nameFieldId, name: 'Name', type: 'text' },
          { id: fieldId, name: 'Files', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [{ id: recordId, values: {} }],
      },
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const url = `/api/tables/${tableId}/fields/${fieldId}/records/${recordId}/uploads`;
  const headers = (person = server.owner) => ({ ...person.headers, 'tus-resumable': '1.0.0' });
  const create = (length = 6, person = server.owner) =>
    server.app.inject({
      method: 'POST',
      url,
      headers: {
        ...headers(person),
        'upload-length': String(length),
        'upload-metadata': `filename ${Buffer.from('resume.txt').toString('base64')}`,
      },
    });
  const patch = (location: string, offset: number, bytes: string, person = server.owner) =>
    server.app.inject({
      method: 'PATCH',
      url: location,
      headers: {
        ...headers(person),
        'upload-offset': String(offset),
        'content-type': 'application/offset+octet-stream',
      },
      payload: Buffer.from(bytes),
    });
  const head = (location: string) => server.app.inject({ method: 'HEAD', url: location, headers: headers() });
  return { databaseId, tableId, fieldId, nameFieldId, recordId, url, headers, create, patch, head };
}

describe('resumable attachments', () => {
  const settings = async (maxUploadBytes: number | null, person = server.owner) =>
    server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: person.headers,
      payload: {
        kind: 'organization.files',
        maxUploadBytes,
        revision: (await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()
          .revision,
      },
    });

  it('defaults to no cap and accepts a multi-gigabyte declaration without allocating its contents', async () => {
    const f = await setup();
    const read = await server.app.inject({ url: '/api/org/files', headers: server.owner.headers });
    expect(read.json()).toEqual({ maxUploadBytes: null, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const options = await server.app.inject({ method: 'OPTIONS', url: f.url, headers: f.headers() });
    expect(options.headers['tus-max-size']).toBeUndefined();
    const created = await f.create(3 * 1024 ** 3);
    expect(created.statusCode, created.body).toBe(201);
    expect((await f.head(String(created.headers.location))).headers['upload-length']).toBe(
      String(3 * 1024 ** 3),
    );
  });

  it('authorizes and audits settings changes and rejects invalid limits', async () => {
    const member = await server.addMember();
    expect((await settings(4, member)).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/org/files', headers: member.headers })).statusCode).toBe(
      403,
    );
    const roles = (values: string[]) =>
      server.app.inject({
        method: 'POST',
        url: '/api/org/admin-commands',
        headers: server.owner.headers,
        payload: { kind: 'organization.roles', userId: member.userId, roles: values },
      });
    expect((await roles(['people'])).statusCode).toBe(200);
    expect((await settings(4, member)).statusCode).toBe(403);
    expect((await roles(['security'])).statusCode).toBe(200);
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect((await settings(value)).statusCode).toBe(422);
    const changed = await settings(4, member);
    expect(changed.statusCode, changed.body).toBe(200);
    const audit = await query<{ metadata: unknown }>(
      server.pool,
      sql`
      SELECT metadata FROM ${ident(server.schemas.audit, 'events')}
      WHERE org_id = ${server.owner.info.org.id} AND action = 'organization.files'
      ORDER BY chain_seq DESC LIMIT 1`,
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      before: { maxUploadBytes: null },
      after: { maxUploadBytes: 4 },
    });
    expect((await roles([])).statusCode).toBe(200);
    expect((await settings(5, member)).statusCode).toBe(403);
    expect((await settings(null)).statusCode).toBe(200);
  });

  it('rechecks a lowered cap on resume, preserves committed bytes, and allows resuming after clearing it', async () => {
    const f = await setup();
    const location = String((await f.create()).headers.location);
    expect((await f.patch(location, 0, 'abc')).statusCode).toBe(204);
    expect((await settings(4)).statusCode).toBe(200);
    const options = await server.app.inject({ method: 'OPTIONS', url: f.url, headers: f.headers() });
    expect(options.headers['tus-max-size']).toBe('4');
    expect((await f.patch(location, 3, 'def')).statusCode).toBe(413);
    expect((await f.head(location)).headers['upload-offset']).toBe('3');
    expect((await settings(null)).statusCode).toBe(200);
    expect((await f.patch(location, 3, 'def')).statusCode).toBe(204);
  });

  it('resumes from committed bytes, rejects a wrong offset, and completes exactly once', async () => {
    const f = await setup();
    const created = await f.create();
    expect(created.statusCode, created.body).toBe(201);
    const location = String(created.headers.location);
    expect((await f.patch(location, 0, 'abc')).statusCode).toBe(204);
    expect((await f.head(location)).headers['upload-offset']).toBe('3');
    expect((await f.patch(location, 0, 'bad')).statusCode).toBe(409);
    expect((await f.head(location)).headers['upload-offset']).toBe('3');
    expect((await f.patch(location, 3, 'def')).statusCode).toBe(204);
    expect((await f.head(location)).headers['upload-offset']).toBe('6');
    const id = location.split('/').at(-1)!;
    const file = await server.app.inject({
      url: `/api/files/${id}/resume.txt`,
      headers: server.owner.headers,
    });
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toBe('abcdef');
    expect((await f.patch(location, 6, '')).statusCode).toBe(204);
    const chunks = await query(
      server.pool,
      sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_upload_chunks')} WHERE upload_id = ${id}`,
    );
    expect(chunks.rowCount).toBe(0);
  });

  it('enforces length across chunks and removes expired or terminated staging rows', async () => {
    const f = await setup();
    const configured = await server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: server.owner.headers,
      payload: {
        kind: 'organization.files',
        maxUploadBytes: 6,
        revision: (await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()
          .revision,
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expect((await f.create(7)).statusCode).toBe(413);
    const created = await f.create(4);
    const location = String(created.headers.location);
    expect((await f.patch(location, 0, 'abc')).statusCode).toBe(204);
    expect((await f.patch(location, 3, 'de')).statusCode).toBe(413);
    expect((await f.head(location)).headers['upload-offset']).toBe('3');
    const id = location.split('/').at(-1)!;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'file_uploads')} SET expires_at = now() - interval '1 second' WHERE id = ${id}`,
    );
    expect((await f.head(location)).statusCode).toBe(404);
    await cleanupUploads(server.app);
    expect(
      (
        await query(
          server.pool,
          sql`SELECT 1 FROM ${ident(server.schemas.app, 'file_upload_chunks')} WHERE upload_id = ${id}`,
        )
      ).rowCount,
    ).toBe(0);
    const next = String((await f.create()).headers.location);
    await f.patch(next, 0, 'abc');
    expect((await server.app.inject({ method: 'DELETE', url: next, headers: f.headers() })).statusCode).toBe(
      204,
    );
    expect((await f.head(next)).statusCode).toBe(404);
  });

  it('rechecks ownership, record visibility, field visibility, and field locks on creation and chunks', async () => {
    const f = await setup();
    const member: SignedIn = await server.addMember();
    expect((await f.create(6, member)).statusCode).toBe(404);
    await query(
      server.pool,
      sql`INSERT INTO ${ident(server.schemas.app, 'grants')}
      (org_id, resource_kind, resource_id, principal_kind, principal_id, role)
      VALUES (${server.owner.info.org.id}, 'database', ${f.databaseId}, 'user', ${member.userId}, 'editor')`,
    );
    const created = await f.create(6, member);
    expect(created.statusCode, created.body).toBe(201);
    const location = String(created.headers.location);
    expect((await f.patch(location, 0, 'abc')).statusCode).toBe(404);
    const target = { orgId: server.owner.info.org.id, ...f };
    for (const rule of ['locked', 'restricted'] as const) {
      await saveFieldRules(
        server.pool,
        server.schemas,
        target,
        { locked: null, restricted: null, [rule]: { roles: ['owner'], users: [] } },
        server.owner.userId,
      );
      const status = rule === 'locked' ? 403 : 404;
      expect((await f.create(6, member)).statusCode).toBe(status);
      expect((await f.patch(location, 0, 'abc', member)).statusCode).toBe(status);
    }
    await saveFieldRules(
      server.pool,
      server.schemas,
      target,
      { locked: null, restricted: null },
      server.owner.userId,
    );
    expect((await f.patch(location, 0, 'abc', member)).statusCode).toBe(204);
    await saveRecordRules(
      server.pool,
      server.schemas,
      target,
      [
        {
          id: newId('recordRule'),
          roles: ['editor'],
          users: [],
          condition: {
            conjunction: 'and',
            conditions: [{ id: 'visible-name', fieldId: f.nameFieldId, operator: 'is', value: 'visible' }],
          },
        },
      ],
      server.owner.userId,
    );
    expect((await f.create(6, member)).statusCode).toBe(404);
    expect((await f.patch(location, 3, 'def', member)).statusCode).toBe(404);
    await saveRecordRules(server.pool, server.schemas, target, [], server.owner.userId);
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.data, f.tableId)} SET __deleted_at = now() WHERE __id = ${f.recordId}`,
    );
    expect((await f.create(6, member)).statusCode).toBe(404);
    expect((await f.patch(location, 3, 'def', member)).statusCode).toBe(404);
  });

  it('finishes empty uploads and protects method overrides with the session check', async () => {
    const f = await setup();
    const empty = await f.create(0);
    expect(empty.statusCode, empty.body).toBe(201);
    expect((await f.head(String(empty.headers.location))).headers['upload-offset']).toBe('0');
    const location = String((await f.create()).headers.location);
    const refused = await server.app.inject({
      method: 'HEAD',
      url: location,
      headers: {
        cookie: server.owner.headers.cookie,
        'tus-resumable': '1.0.0',
        'x-http-method-override': 'DELETE',
      },
    });
    expect(refused.statusCode).toBe(403);
    expect((await f.head(location)).statusCode).toBe(200);
    const removed = await server.app.inject({
      method: 'POST',
      url: location,
      headers: { ...f.headers(), 'x-http-method-override': 'DELETE' },
    });
    expect(removed.statusCode).toBe(204);
    expect((await f.head(location)).statusCode).toBe(404);
  });

  it('advertises extensions and validates protocol versions and media types', async () => {
    const f = await setup();
    const options = await server.app.inject({ method: 'OPTIONS', url: f.url, headers: server.owner.headers });
    expect(options.headers['tus-extension']).toBe('creation,termination');
    const version = await server.app.inject({
      method: 'POST',
      url: f.url,
      headers: { ...server.owner.headers, 'upload-length': '6' },
    });
    expect(version.statusCode).toBe(412);
    const location = String((await f.create()).headers.location);
    const media = await server.app.inject({
      method: 'PATCH',
      url: location,
      headers: { ...f.headers(), 'upload-offset': '0', 'content-type': 'text/plain' },
      payload: 'a',
    });
    expect(media.statusCode).toBe(415);
  });
});
