import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { KeyedRecords, TokenCreated } from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { readFixture } from '../data/snapshots.test-helpers.js';
import { AccessScope } from '../data/access.js';
import type { SnapshotRead } from '../data/snapshots.js';
import { addressSettings } from './attachments.js';

const LIMIT = 64 * 1024;
const TEXT = 'Downloaded by address';

let kit: TestPostgres;
let server: ServerFixture;
let token: TokenCreated;
let files: Server;
let origin: string;
/** Paths the stand-in file server was asked for, in order */
let asked: string[] = [];

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'restfiles');
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Files', scopes: ['data.records:read', 'data.records:write'], databases: 'all' },
  });
  expect(response.statusCode, response.body).toBe(200);
  token = response.json<TokenCreated>();
  files = createServer((req, res) => {
    const path = req.url ?? '/';
    asked.push(path);
    if (path.startsWith('/files/')) return res.end(`${TEXT} ${path}`);
    if (path === '/moved/report.txt') {
      res.writeHead(302, { location: '/files/report.txt' });
      return res.end();
    }
    if (path === '/inside') {
      res.writeHead(302, { location: 'https://10.0.0.9/secret' });
      return res.end();
    }
    if (path === '/declared') {
      res.writeHead(200, { 'content-length': String(LIMIT + 1) });
      return res.end(Buffer.alloc(LIMIT + 1));
    }
    if (path === '/streamed') {
      // No length up front, so only counting the bytes can catch it.
      res.writeHead(200, { 'transfer-encoding': 'chunked' });
      for (let sent = 0; sent <= LIMIT; sent += 16 * 1024) res.write(Buffer.alloc(16 * 1024));
      return res.end();
    }
    // Answers nothing at all, so only the wait can end it.
    if (path === '/silent') return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
  const port = (files.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  const settings = addressSettings(server.ctx);
  // Only the stand-in may be reached on a private address, and names resolve to a private one.
  settings.allowPrivate = (url) => url.hostname === '127.0.0.1' && url.port === String(port);
  settings.resolve = async () => [{ address: '10.0.0.7', family: 4 }];
  settings.maxBytes = LIMIT;
  settings.idleMs = 500;
}, 60_000);
afterAll(async () => {
  files?.closeAllConnections();
  await new Promise<void>((resolve) => (files ? files.close(() => resolve()) : resolve()));
  await server?.close();
  await kit?.stop();
});
beforeEach(() => {
  asked = [];
});

const headers = () => ({ authorization: `Bearer ${token.token}` });
const urlFor = (tableId: string) => `/api/v1/tables/${tableId}/records`;

async function write(
  tableId: string,
  method: 'POST' | 'PATCH',
  records: Array<{ id?: string; fields: Record<string, unknown> }>,
) {
  return server.app.inject({ method, url: urlFor(tableId), headers: headers(), payload: { records } });
}

async function fixture() {
  return readFixture(server, [{ type: 'text' }, { type: 'attachment' }, { type: 'attachment' }]);
}

/** How many records the table holds and how many files were stored for it. */
async function counts(read: SnapshotRead) {
  const records = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.data, read.table.id)}`,
  );
  const stored = await query<{ count: string }>(
    server.pool,
    sql`SELECT count(*) FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${read.table.id}`,
  );
  return { records: Number(records.rows[0]!.count), files: Number(stored.rows[0]!.count) };
}

it('stores files from addresses beside files named by ID, and serves them back', async () => {
  const read = await fixture();
  const upload = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${read.table.id}/fields/${read.fields[1]!.id}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'kept.txt',
    },
    payload: Buffer.from('Uploaded first'),
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const kept = upload.json<{ id: string }>();
  const created = await write(read.table.id, 'POST', [
    {
      fields: {
        'Field 0': 'Mixed',
        'Field 1': [
          kept.id,
          { url: `${origin}/files/plan.txt`, filename: 'Plan.txt' },
          // A redirect is followed, and the file is named after the address it was asked for.
          { url: `${origin}/moved/report.txt` },
        ],
        'Field 2': [{ url: `${origin}/files/other%20notes.txt?signature=kept-private` }],
      },
    },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  const body = created.json<KeyedRecords>();
  const id = body.order[0]!;
  const cells = body.records[id]! as Record<
    string,
    Array<{ id: string; filename: string; url: string; size: number }>
  >;
  expect(cells['Field 1']!.map((file) => file.filename)).toEqual(['kept.txt', 'Plan.txt', 'report.txt']);
  expect(cells['Field 1']![0]!.id).toBe(kept.id);
  expect(cells['Field 2']!.map((file) => file.filename)).toEqual(['other notes.txt']);
  // The downloads run side by side, so they may arrive in any order.
  expect(asked.sort()).toEqual([
    '/files/other%20notes.txt?signature=kept-private',
    '/files/plan.txt',
    '/files/report.txt',
    '/moved/report.txt',
  ]);
  const plan = cells['Field 1']![1]!;
  expect(plan.size).toBe(Buffer.byteLength(`${TEXT} /files/plan.txt`));
  const served = await server.app.inject({ url: plan.url, headers: server.owner.headers });
  expect(served.statusCode, served.body).toBe(200);
  expect(served.body).toBe(`${TEXT} /files/plan.txt`);
  const stored = await query<{ storage: string; attached: boolean; created_by: string }>(
    server.pool,
    sql`SELECT storage, attached_at IS NOT NULL AS attached, created_by
    FROM ${ident(server.schemas.app, 'files')} WHERE id = ${plan.id}`,
  );
  expect(stored.rows).toEqual([{ storage: 'postgres', attached: true, created_by: server.owner.userId }]);
  // An attachment as a read returns it goes back as it is, keeping its file.
  const patched = await write(read.table.id, 'PATCH', [
    { id, fields: { 'Field 1': [...cells['Field 1']!, { url: `${origin}/files/added.txt` }] } },
  ]);
  expect(patched.statusCode, patched.body).toBe(200);
  const after = patched.json<KeyedRecords>().records[id]!['Field 1'] as Array<{
    id: string;
    filename: string;
  }>;
  expect(after.slice(0, 3).map((file) => file.id)).toEqual(cells['Field 1']!.map((file) => file.id));
  expect(after[3]!.filename).toBe('added.txt');
});

it('refuses private addresses, redirects into them, and addresses that are not https, writing nothing', async () => {
  const read = await fixture();
  const before = await counts(read);
  for (const [address, item] of [
    ['https://10.0.0.9/secret', 0],
    ['https://files.example.test/resolves-privately.txt', 0],
    ['http://files.example.test/plain.txt', 0],
    ['ftp://files.example.test/old.txt', 0],
    [`${origin}/inside`, 1],
  ] as const) {
    const response = await write(read.table.id, 'POST', [
      { fields: { 'Field 1': [{ url: `${origin}/files/fine.txt` }] } },
      {
        fields: {
          'Field 2': [...(item ? [{ url: `${origin}/files/first.txt` }] : []), { url: address }],
        },
      },
    ]);
    expect(response.statusCode, `${address} ${response.body}`).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        messageKey: 'api.file.blocked',
        message: expect.stringContaining('private network'),
        params: { field: 'Field 2', record: 1, item },
      },
    });
  }
  // The address comes back without its query, which may hold a secret.
  const hidden = await write(read.table.id, 'POST', [
    { fields: { 'Field 1': [{ url: 'https://10.0.0.9/secret?token=abc' }] } },
  ]);
  expect(hidden.json()).toMatchObject({ error: { params: { address: 'https://10.0.0.9/secret' } } });
  expect(hidden.body).not.toContain('token=abc');
  expect(await counts(read)).toEqual(before);
});

it('refuses a file past the upload limit, whether it says so or not, with nothing written', async () => {
  const read = await fixture();
  const before = await counts(read);
  for (const path of ['/declared', '/streamed']) {
    const response = await write(read.table.id, 'POST', [
      {
        fields: {
          'Field 0': 'Too big',
          'Field 1': [{ url: `${origin}/files/small.txt` }, { url: origin + path }],
        },
      },
    ]);
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        messageKey: 'api.file.tooLarge',
        params: { field: 'Field 1', record: 0, item: 1, address: origin + path },
      },
    });
  }
  expect(await counts(read)).toEqual(before);
});

it('honors the organization cap for declared and streamed address imports', async () => {
  const read = await fixture();
  const before = await counts(read);
  const policy = addressSettings(server.ctx);
  const previous = policy.maxBytes;
  const change = async (maxUploadBytes: number | null) =>
    server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: server.owner.headers,
      payload: {
        kind: 'organization.files',
        maxUploadBytes,
        revision: (await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()
          .revision,
      },
    });
  expect((await change(1024)).statusCode).toBe(200);
  policy.maxBytes = Infinity;
  try {
    for (const path of ['/declared', '/streamed']) {
      const response = await write(read.table.id, 'POST', [
        {
          fields: { 'Field 1': [{ url: origin + path }] },
        },
      ]);
      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({
        error: {
          messageKey: 'api.file.tooLarge',
          params: { megabytes: 0 },
        },
      });
    }
    expect(await counts(read)).toEqual(before);
  } finally {
    policy.maxBytes = previous;
    expect((await change(null)).statusCode).toBe(200);
  }
});

it.each(['REST', 'compatible'])('names the submitted cell for deferred %s download failures', async (api) => {
  const read = await fixture();
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'Unchanged' } },
    { fields: { 'Field 0': 'Attachment failure' } },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  const [first, second] = created.json<KeyedRecords>().order;
  const before = await counts(read);
  for (const [address, messageKey] of [
    ['https://10.0.0.9/secret', 'api.file.blocked'],
    [`${origin}/inside`, 'api.file.blocked'],
    [`${origin}/gone.txt`, 'api.file.notFound'],
    [`${origin}/declared`, 'api.file.tooLarge'],
  ]) {
    const response = await server.app.inject({
      method: 'PATCH',
      url: api === 'REST' ? urlFor(read.table.id) : `/v0/${read.table.databaseId}/${read.table.id}`,
      headers: headers(),
      payload: {
        records: [
          { id: first, fields: { 'Field 0': 'Unchanged' } },
          { id: second, fields: { 'Field 2': [{ url: address }] } },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        ...(api === 'REST' ? { messageKey } : { type: 'INVALID_ATTACHMENT_OBJECT' }),
        params: {
          fieldId: read.fields[2]!.id,
          field: 'Field 2',
          recordId: second,
          recordIndex: 1,
          record: 1,
          item: 0,
        },
      },
    });
    expect(await counts(read)).toEqual(before);
  }
});

it('says when nothing is at an address and when an address goes quiet', async () => {
  const read = await fixture();
  const before = await counts(read);
  const missing = await write(read.table.id, 'POST', [
    { fields: { 'Field 1': [{ url: `${origin}/gone.txt` }] } },
  ]);
  expect(missing.json()).toMatchObject({
    error: { messageKey: 'api.file.notFound', params: { address: `${origin}/gone.txt` } },
  });
  const silent = await write(read.table.id, 'POST', [
    { fields: { 'Field 1': [{ url: `${origin}/silent` }] } },
  ]);
  expect(silent.json()).toMatchObject({ error: { messageKey: 'api.file.timedOut', params: { item: 0 } } });
  const malformed = await write(read.table.id, 'POST', [
    { fields: { 'Field 1': [{ url: 'not an address' }] } },
  ]);
  expect(malformed.json()).toMatchObject({
    error: { messageKey: 'api.file.address', params: { field: 'Field 1', record: 0, item: 0 } },
  });
  expect(await counts(read)).toEqual(before);
});

it('takes up to ten addresses a record and fifty a request', async () => {
  const read = await fixture();
  const addresses = (record: number, count: number) =>
    Array.from({ length: count }, (_, n) => ({ url: `${origin}/files/${record}-${n}.txt` }));
  const perRecord = await write(read.table.id, 'POST', [
    { fields: { 'Field 1': addresses(0, 6), 'Field 2': addresses(0, 5).slice(1) } },
    { fields: { 'Field 1': addresses(1, 11) } },
  ]);
  expect(perRecord.statusCode).toBe(422);
  expect(perRecord.json()).toMatchObject({
    error: { messageKey: 'api.file.perRecord', params: { record: 1, limit: 10 } },
  });
  const perRequest = await write(
    read.table.id,
    'POST',
    Array.from({ length: 6 }, (_, record) => ({
      fields: { 'Field 1': addresses(record, record < 5 ? 10 : 1) },
    })),
  );
  expect(perRequest.json()).toMatchObject({
    error: { messageKey: 'api.file.perRequest', params: { limit: 50 } },
  });
  expect(asked).toEqual([]);
  const most = await write(
    read.table.id,
    'POST',
    Array.from({ length: 5 }, (_, record) => ({ fields: { 'Field 1': addresses(record, 10) } })),
  );
  expect(most.statusCode, most.body).toBe(200);
  expect(asked).toHaveLength(50);
  const records = most.json<KeyedRecords>();
  expect(records.order.map((id) => (records.records[id]!['Field 1'] as unknown[]).length)).toEqual([
    10, 10, 10, 10, 10,
  ]);
});

it('checks the field lock and record rules before downloading, and removes files a refused write stored', async () => {
  const read = await fixture();
  const created = await write(read.table.id, 'POST', [{ fields: { 'Field 0': 'Existing' } }]);
  const id = created.json<KeyedRecords>().order[0]!;
  const before = await counts(read);
  const locked = vi
    .spyOn(AccessScope.prototype, 'canEditField')
    .mockImplementation((_table, field) => field.id !== read.fields[1]!.id);
  try {
    const response = await write(read.table.id, 'PATCH', [
      { id, fields: { 'Field 1': [{ url: `${origin}/files/locked.txt` }] } },
    ]);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { messageKey: 'data.access.fieldLocked' } });
  } finally {
    locked.mockRestore();
  }
  const hidden = vi
    .spyOn(AccessScope.prototype, 'recordPredicate')
    .mockImplementation(() => sql`__id <> ${id}`);
  try {
    const response = await write(read.table.id, 'PATCH', [
      { id, fields: { 'Field 1': [{ url: `${origin}/files/hidden.txt` }] } },
    ]);
    expect(response.statusCode).toBe(404);
  } finally {
    hidden.mockRestore();
  }
  expect(asked).toEqual([]);
  // A new record that would land outside the rules is refused by the write itself, after the
  // downloads, which are removed again.
  const limited = vi.spyOn(AccessScope.prototype, 'limitsRecords').mockReturnValue(true);
  const outside = vi.spyOn(AccessScope.prototype, 'recordPredicate').mockImplementation(() => sql`FALSE`);
  try {
    const response = await write(read.table.id, 'POST', [
      { fields: { 'Field 0': 'Outside', 'Field 1': [{ url: `${origin}/files/outside.txt` }] } },
    ]);
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json()).toMatchObject({ error: { messageKey: 'data.access.recordOutsideRules' } });
  } finally {
    limited.mockRestore();
    outside.mockRestore();
  }
  expect(asked).toEqual(['/files/outside.txt']);
  expect(await counts(read)).toEqual(before);
  const unchanged = await server.app.inject({ url: `${urlFor(read.table.id)}/${id}`, headers: headers() });
  expect(unchanged.json<KeyedRecords>().records[id]!['Field 1']).toEqual([]);
});

it('uploads through a bearer token and attaches the stored file through a record command', async () => {
  const read = await fixture();
  const upload = await server.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${read.table.id}/fields/${read.fields[1]!.id}/files`,
    headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-file-name': 'page.txt' },
    payload: Buffer.from('Captured page'),
  });
  expect(upload.statusCode, upload.body).toBe(200);
  const file = upload.json<{ id: string }>();
  const created = await write(read.table.id, 'POST', [
    { fields: { 'Field 0': 'Page', 'Field 1': [file.id] } },
  ]);
  expect(created.statusCode, created.body).toBe(200);
  expect(created.headers['x-undo-group-id']).toBeTruthy();
  const body = created.json<KeyedRecords>();
  expect(body.records[body.order[0]!]!['Field 1']).toMatchObject([{ id: file.id, filename: 'page.txt' }]);
});

it('refuses bearer uploads outside the token scope, database grant, and attachment field', async () => {
  const read = await fixture();
  const outside = await fixture();
  const before = await counts(read);
  const upload = (authorization: string, fieldId = read.fields[1]!.id) =>
    server.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${read.table.id}/fields/${fieldId}/files`,
      headers: { authorization, 'content-type': 'application/octet-stream', 'x-file-name': 'page.txt' },
      payload: Buffer.from('Captured page'),
    });
  const readOnly = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: { name: 'Read only', scopes: ['data.records:read'], databases: 'all' },
  });
  expect(readOnly.statusCode, readOnly.body).toBe(200);
  expect((await upload(`Bearer ${readOnly.json<TokenCreated>().token}`)).statusCode).toBe(403);
  const restricted = await server.app.inject({
    method: 'POST',
    url: '/api/tokens',
    headers: server.owner.headers,
    payload: {
      name: 'Selected database',
      scopes: ['data.records:write'],
      databases: [outside.table.databaseId],
    },
  });
  expect(restricted.statusCode, restricted.body).toBe(200);
  expect([403, 404]).toContain((await upload(`Bearer ${restricted.json<TokenCreated>().token}`)).statusCode);
  expect((await upload(`Bearer ${token.token}`, read.fields[0]!.id)).statusCode).toBe(404);
  expect(await counts(read)).toEqual(before);
});

it('answers bearer uploads with the API headers and documents no undo group for them', async () => {
  const read = await fixture();
  const url = `/api/v1/tables/${read.table.id}/fields/${read.fields[1]!.id}/files`;
  const upload = (extra: Record<string, string> = {}) =>
    server.app.inject({
      method: 'POST',
      url,
      headers: { ...extra, 'content-type': 'application/octet-stream', 'x-file-name': 'page.txt' },
      payload: Buffer.from('Captured page'),
    });
  const previous = server.config.baseUrl;
  server.config.baseUrl = 'https://riosoma.example.com';
  try {
    const listing = await server.app.inject({ url: '/api/v1/databases' });
    expect(listing.headers['www-authenticate']).toBeTruthy();
    const refused = await upload();
    expect(refused.statusCode).toBe(401);
    expect(refused.headers['www-authenticate']).toBe(listing.headers['www-authenticate']);
    expect(refused.headers['cache-control']).toBe('no-store');
  } finally {
    server.config.baseUrl = previous;
  }
  const accepted = await upload(headers());
  expect(accepted.statusCode, accepted.body).toBe(200);
  expect(accepted.headers['cache-control']).toBe('no-store');
  expect(accepted.headers['x-undo-group-id']).toBeUndefined();
  const session = await server.app.inject({
    method: 'POST',
    url: `/api/tables/${read.table.id}/fields/${read.fields[1]!.id}/files`,
    headers: {
      ...server.owner.headers,
      'content-type': 'application/octet-stream',
      'x-file-name': 'page.txt',
    },
    payload: Buffer.from('Captured page'),
  });
  expect(session.statusCode, session.body).toBe(200);
  expect(session.headers['www-authenticate']).toBeUndefined();
  const spec = (await server.app.inject({ url: '/api/v1/openapi.json' })).json<{
    paths: Record<
      string,
      Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>
    >;
  }>();
  expect(
    spec.paths['/api/v1/tables/{tableId}/fields/{fieldId}/files']!.post!.responses['200']!.headers,
  ).toBeUndefined();
  expect(spec.paths['/api/v1/tables/{tableId}/records']!.post!.responses['200']!.headers).toHaveProperty(
    'x-undo-group-id',
  );
});
