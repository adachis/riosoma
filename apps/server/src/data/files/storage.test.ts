import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newId } from '@riosoma/contracts';
import { azureServiceToken, createPool, ident, migrate, query, sql } from '@riosoma/db';
import { refusedPort, startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { loadConfig } from '../../config.js';
import { MIGRATIONS } from '../../migrations/index.js';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { AZURITE_URL, S3_URL, azureRequest, s3Request, testAzure, testS3 } from '../../test/stores.js';
import { azureStorage, blobSas, sharedKey, type AzureSettings } from './azure-storage.js';
import { checkFileStorage } from './check.js';
import { PART_BYTES } from './remote.js';
import type { S3Settings } from './s3-storage.js';
import {
  CHUNK_BYTES,
  fileStorage,
  outsideStorage,
  type FileStorage,
  type FileStorageConfig,
  type StorageKind,
} from './storage.js';

/**
 * The contract every store keeps, run against each kind: PostgreSQL and a local folder always,
 * MinIO when `RIOSOMA_TEST_S3_URL` names it, and Azurite when `RIOSOMA_TEST_AZURITE_URL` does (see
 * `test/stores.ts`).  Writes, reads, ranges, deletes, copies, uploads in parts, and uploads that
 * fail partway, which must leave nothing behind.
 */

let kit: TestPostgres;
let pool: pg.Pool;
let drop: () => Promise<void>;
const schemas = { app: 'store_app', data: 'store_data', audit: 'store_audit' };
beforeAll(async () => {
  kit = await startTestPostgres();
  const database = await kit.createDatabase('store');
  drop = database.drop;
  const profile = { ...database.profile, schemas };
  pool = createPool(profile);
  await migrate(pool, schemas, MIGRATIONS);
}, 60_000);
afterAll(async () => {
  await pool?.end();
  await drop?.();
  await kit?.stop();
});

async function bytesOf(stream: Readable): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return null;
    throw error;
  }
  return Buffer.concat(chunks);
}

/** A source that sends `bytes` and then fails, the way a dropped upload does. */
function failing(bytes: number): Readable {
  return Readable.from(
    (async function* () {
      for (let sent = 0; sent < bytes; sent += 1024 * 1024)
        yield randomBytes(Math.min(1024 * 1024, bytes - sent));
      throw new Error('The upload was dropped');
    })(),
    { objectMode: false },
  );
}

const kinds: StorageKind[] = [
  'postgres',
  'local',
  ...(S3_URL ? (['s3'] as const) : []),
  ...(AZURITE_URL ? (['azure-blob'] as const) : []),
];

describe.each(kinds)('%s storage contract', (kind) => {
  let storage: FileStorage;
  let directory: string;
  let s3: S3Settings | null = null;
  let azure: AzureSettings | null = null;
  const requests: string[] = [];
  const recording: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(`${init?.method ?? 'GET'} ${url.search}`);
    return fetch(input, init);
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rio-store-test-'));
    if (kind === 's3') s3 = await testS3('contract');
    if (kind === 'azure-blob') azure = await testAzure('contract');
    const config: FileStorageConfig = { filesDir: directory, filesS3: s3, filesAzure: azure };
    storage =
      kind === 'postgres'
        ? fileStorage(kind, pool, schemas.app, config)
        : outsideStorage(kind, config, { fetch: recording });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** Whether nothing at all is stored under the key, looking past the store's own interface. */
  async function nothingUnder(key: string): Promise<void> {
    const read = await bytesOf(storage.read(key));
    expect(read === null || (kind === 'postgres' && read.length === 0)).toBe(true);
    if (kind === 'postgres') {
      const chunks = await query(
        pool,
        sql`SELECT 1 FROM ${ident(schemas.app, 'file_chunks')} WHERE storage_key = ${key}`,
      );
      expect(chunks.rowCount).toBe(0);
    }
    if (kind === 'local') expect(await readdir(directory)).not.toContain(key);
    if (s3) {
      // An upload that was never completed or aborted would still be listed here.
      const response = await s3Request(
        s3,
        'GET',
        `?uploads=&prefix=${encodeURIComponent(`${s3.prefix}${key}`)}`,
      );
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).not.toContain('<Upload>');
    }
    if (azure) {
      const response = await azureRequest(
        azure,
        'GET',
        `/${azure.container}?restype=container&comp=list&include=uncommittedblobs&prefix=${encodeURIComponent(`${azure.prefix}${key}`)}`,
      );
      const text = await response.text();
      expect(response.status, text).toBe(200);
      expect(text).not.toContain('<Blob>');
    }
  }

  it('writes and reads exact bytes across chunk boundaries', async () => {
    const key = newId('attachment');
    const bytes = randomBytes(CHUNK_BYTES * 2 + 71);
    await storage.write(key, Readable.from([bytes.subarray(0, 1000), bytes.subarray(1000)]));
    expect((await bytesOf(storage.read(key)))!.equals(bytes)).toBe(true);
    const empty = newId('attachment');
    await storage.write(empty, Readable.from([]));
    expect(await bytesOf(storage.read(empty))).toEqual(Buffer.alloc(0));
  });

  it('reads ranges, including ones across chunks and at either end', async () => {
    const key = newId('attachment');
    const bytes = randomBytes(CHUNK_BYTES + 500);
    await storage.write(key, Readable.from([bytes]));
    for (const [start, end] of [
      [0, 0],
      [0, 99],
      [CHUNK_BYTES - 10, CHUNK_BYTES + 10],
      [bytes.length - 1, bytes.length - 1],
      [5, bytes.length - 1],
    ] as const) {
      const read = await bytesOf(storage.read(key, { start, end }));
      expect(read!.equals(bytes.subarray(start, end + 1)), `${start}-${end}`).toBe(true);
    }
  });

  it('deletes, and deleting what is already gone is fine', async () => {
    const key = newId('attachment');
    await storage.write(key, Readable.from([randomBytes(2048)]));
    await storage.delete(key);
    await nothingUnder(key);
    await storage.delete(key);
    await storage.delete(newId('attachment'));
  });

  it('copies within the store, and a copy of something missing reads as missing', async () => {
    const key = newId('attachment');
    const bytes = randomBytes(CHUNK_BYTES + 3);
    await storage.write(key, Readable.from([bytes]));
    const copy = newId('attachment');
    await storage.copy(key, copy);
    await storage.delete(key);
    expect((await bytesOf(storage.read(copy)))!.equals(bytes)).toBe(true);
    const gone = storage.copy(newId('attachment'), newId('attachment'));
    if (kind === 'postgres') await gone;
    else await expect(gone).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uploads large files in parts', async () => {
    requests.length = 0;
    const key = newId('attachment');
    const bytes = randomBytes(PART_BYTES + 4096);
    await storage.write(key, Readable.from([bytes]));
    expect((await bytesOf(storage.read(key)))!.equals(bytes)).toBe(true);
    const range = await bytesOf(storage.read(key, { start: PART_BYTES - 5, end: PART_BYTES + 5 }));
    expect(range!.equals(bytes.subarray(PART_BYTES - 5, PART_BYTES + 6))).toBe(true);
    if (kind === 's3') {
      expect(requests).toContain('POST ?uploads=');
      expect(requests.filter((request) => request.startsWith('PUT ?partNumber='))).toHaveLength(2);
    }
    if (kind === 'azure-blob') {
      expect(requests.filter((request) => request.startsWith('PUT ?comp=block&'))).toHaveLength(2);
      expect(requests).toContain('PUT ?comp=blocklist');
    }
  }, 60_000);

  it('leaves nothing behind when an upload fails, whether small or in parts', async () => {
    for (const size of [3000, PART_BYTES * 2 + 1024]) {
      const key = newId('attachment');
      await expect(storage.write(key, failing(size))).rejects.toThrow('The upload was dropped');
      await nothingUnder(key);
    }
  }, 60_000);

  it.runIf(kind === 's3' || kind === 'azure-blob')(
    'signs short-lived addresses that answer with the given type and disposition',
    async () => {
      const key = newId('attachment');
      const bytes = randomBytes(5000);
      await storage.write(key, Readable.from([bytes]));
      const disposition = `attachment; filename="r_sum_.txt"; filename*=UTF-8''r%C3%A9sum%C3%A9.txt`;
      const url = await storage.signedUrl!(key, { seconds: 60, type: 'text/plain', disposition });
      const whole = await fetch(url!);
      expect(whole.status).toBe(200);
      expect(whole.headers.get('content-type')).toBe('text/plain');
      expect(whole.headers.get('content-disposition')).toBe(disposition);
      expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
      const part = await fetch(url!, { headers: { range: 'bytes=10-19' } });
      expect(part.status).toBe(206);
      expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
      const altered = new URL(url!);
      altered.searchParams.set(kind === 's3' ? 'response-content-type' : 'rsct', 'text/html');
      expect((await fetch(altered)).status).toBe(403);
    },
  );
});

describe('the start check', () => {
  it('passes for a writable folder and names the failure for one it cannot use', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rio-store-check-'));
    try {
      expect(await checkFileStorage({ filesStorage: 'local', filesDir: directory })).toBe('local');
      expect(await readdir(directory)).toEqual([]);
      const file = join(directory, 'not-a-folder');
      await writeFile(file, 'x');
      await expect(checkFileStorage({ filesStorage: 'local', filesDir: file })).rejects.toMatchObject({
        setting: 'RIOSOMA_FILES_STORAGE',
        reason: 'storageCheck',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(await checkFileStorage({ filesStorage: 'postgres' })).toBe('postgres');
  });

  it('says why an S3-compatible service refused, without the keys', async () => {
    // A port nothing answers on, and one no other test's server can be holding in the meantime.
    const port = await refusedPort();
    const failure = await checkFileStorage({
      filesStorage: 's3',
      filesS3: {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'us-east-1',
        bucket: 'files',
        prefix: '',
        accessKeyId: 'synthetic-key',
        secretAccessKey: 'synthetic-secret',
        pathStyle: true,
      },
    }).then(
      () => null,
      (error: unknown) => error as Error & { detail?: string },
    );
    expect(failure).toMatchObject({ setting: 'RIOSOMA_FILES_STORAGE', detail: 'ECONNREFUSED' });
    expect(failure!.message).not.toContain('synthetic');
  });

  it.runIf(S3_URL)('names the service error for a wrong secret key', async () => {
    const settings = await testS3('check');
    expect(await checkFileStorage({ filesStorage: 's3', filesS3: settings })).toBe('s3');
    await expect(
      checkFileStorage({ filesStorage: 's3', filesS3: { ...settings, secretAccessKey: 'wrong' } }),
    ).rejects.toMatchObject({ detail: '403 SignatureDoesNotMatch' });
    await expect(
      checkFileStorage({ filesStorage: 's3', filesS3: { ...settings, bucket: 'riosoma-missing-bucket' } }),
    ).rejects.toMatchObject({ detail: '404 NoSuchBucket' });
  });

  it.runIf(AZURITE_URL)('names the service error for a wrong account key', async () => {
    const settings = await testAzure('check');
    expect(await checkFileStorage({ filesStorage: 'azure-blob', filesAzure: settings })).toBe('azure-blob');
    await expect(
      checkFileStorage({
        filesStorage: 'azure-blob',
        filesAzure: { ...settings, accountKey: randomBytes(64).toString('base64') },
      }),
    ).rejects.toMatchObject({ detail: '403 AuthorizationFailure' });
  });
});

describe('Azure signing', () => {
  it('signs with Shared Key over the canonical headers and resource', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const url = new URL(
      'https://account.blob.core.windows.net/files/riosoma/att_1?comp=block&blockid=YQ%3D%3D',
    );
    const header = sharedKey(
      'PUT',
      url,
      { 'x-ms-date': 'Mon, 28 Sep 2026 00:00:00 GMT', 'x-ms-version': '2021-08-06', 'content-length': '5' },
      'account',
      key,
    );
    // The string Azure signs, by the published rules, signed here independently.
    const text = [
      'PUT',
      '',
      '',
      '5',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      'x-ms-date:Mon, 28 Sep 2026 00:00:00 GMT\nx-ms-version:2021-08-06\n/account/files/riosoma/att_1\nblockid:YQ==\ncomp:block',
    ].join('\n');
    const expected = createHmac('sha256', Buffer.from(key, 'base64')).update(text).digest('base64');
    expect(header).toBe(`SharedKey account:${expected}`);
  });

  it('makes a read-only SAS that expires', () => {
    const sas = new URLSearchParams(
      blobSas(
        { account: 'account', container: 'files', accountKey: Buffer.alloc(32, 1).toString('base64') },
        'riosoma/att_1',
        new Date('2026-09-28T00:05:00.123Z'),
        true,
        { type: 'text/plain', disposition: 'inline' },
      ),
    );
    expect(Object.fromEntries(sas)).toMatchObject({
      sv: '2021-08-06',
      se: '2026-09-28T00:05:00Z',
      sr: 'b',
      sp: 'r',
      spr: 'https',
      rsct: 'text/plain',
      rscd: 'inline',
    });
    expect(sas.get('sig')).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('signs in with an identity token when there is no account key', async () => {
    const calls: string[] = [];
    const fake: typeof fetch = (_input, init) => {
      calls.push(`${init?.method} ${new Headers(init?.headers).get('authorization')}`);
      return Promise.resolve(new Response(null, { status: init?.method === 'DELETE' ? 202 : 201 }));
    };
    const storage = azureStorage(
      {
        account: 'account',
        container: 'files',
        prefix: '',
        endpoint: 'https://account.blob.core.windows.net',
      },
      { fetch: fake, token: () => Promise.resolve('synthetic-token') },
    );
    await storage.write('att_1', Readable.from([Buffer.from('hello')]));
    await storage.delete('att_1');
    expect(calls).toEqual(['PUT Bearer synthetic-token', 'DELETE Bearer synthetic-token']);
    // A SAS is signed with the account key, so without one downloads go through Riosoma.
    expect(
      await storage.signedUrl!('att_1', { seconds: 60, type: 'text/plain', disposition: 'inline' }),
    ).toBeNull();
  });

  it('gets the managed identity token for Storage from the platform, once', async () => {
    const asked: Array<{ resource: string | null; clientId: string | null; header: unknown }> = [];
    const identity = createServer((request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      asked.push({
        resource: url.searchParams.get('resource'),
        clientId: url.searchParams.get('client_id'),
        header: request.headers['x-identity-header'],
      });
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          access_token: 'synthetic-token',
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
          resource: 'https://storage.azure.com/',
          token_type: 'Bearer',
        }),
      );
    });
    await new Promise<void>((resolve) => identity.listen(0, '127.0.0.1', resolve));
    const { port } = identity.address() as AddressInfo;
    vi.stubEnv('IDENTITY_ENDPOINT', `http://127.0.0.1:${port}/msi/token`);
    vi.stubEnv('IDENTITY_HEADER', 'synthetic-header');
    try {
      const token = azureServiceToken(
        'https://storage.azure.com/.default',
        '00000000-0000-0000-0000-000000000001',
      );
      expect(await token()).toBe('synthetic-token');
      expect(await token()).toBe('synthetic-token');
      expect(asked).toEqual([
        {
          resource: 'https://storage.azure.com',
          clientId: '00000000-0000-0000-0000-000000000001',
          header: 'synthetic-header',
        },
      ]);
    } finally {
      vi.unstubAllEnvs();
      await new Promise((resolve) => identity.close(resolve));
    }
  });
});

describe.each(kinds.filter((kind) => kind === 's3' || kind === 'azure-blob'))(
  '%s downloads through signed addresses',
  (kind) => {
    let server: ServerFixture;
    beforeAll(async () => {
      const settings =
        kind === 's3' ? { filesS3: await testS3('redirect') } : { filesAzure: await testAzure('redirect') };
      server = await startServer(kit, `redirect_${kind.replace('-', '_')}`, {
        filesStorage: kind,
        filesSignedUrlSeconds: 120,
        ...settings,
      });
    }, 60_000);
    afterAll(async () => {
      await server?.close();
    });

    it('redirects only after the permission check, to an address that expires', async () => {
      const databaseId = newId('database');
      const table = {
        id: newId('table'),
        name: 'Files',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: newId('field'), name: 'Files', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      };
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: { id: databaseId, name: 'Signed', table },
      });
      expect(created.statusCode, created.body).toBe(200);
      const bytes = randomBytes(10_000);
      const upload = await server.app.inject({
        method: 'POST',
        url: `/api/tables/${table.id}/fields/${table.fields[1]!.id}/files`,
        headers: {
          ...server.owner.headers,
          'content-type': 'application/octet-stream',
          'x-file-name': 'data.bin',
        },
        payload: bytes,
      });
      expect(upload.statusCode, upload.body).toBe(200);
      const file = upload.json<{ url: string }>();
      const download = await server.app.inject({ url: file.url, headers: server.owner.headers });
      expect(download.statusCode).toBe(302);
      expect(download.headers['cache-control']).toBe('private, no-store');
      expect(download.headers['content-length'] ?? '0').toBe('0');
      const location = String(download.headers.location);
      const fetched = await fetch(location);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-disposition')).toContain('attachment');
      expect(Buffer.from(await fetched.arrayBuffer()).equals(bytes)).toBe(true);
      const stranger = await server.addMember();
      const refused = await server.app.inject({ url: file.url, headers: stranger.headers });
      expect(refused.statusCode).toBe(404);
      expect(refused.headers.location).toBeUndefined();
    });
  },
);

it('reads every setting each kind needs, and names the one that is missing', () => {
  const base = {
    RIOSOMA_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'rio-store-config-')),
    RIOSOMA_SECRET_KEY: Buffer.alloc(32).toString('base64'),
  };
  const s3 = {
    ...base,
    RIOSOMA_FILES_STORAGE: 's3',
    RIOSOMA_FILES_S3_BUCKET: 'files',
    RIOSOMA_FILES_S3_ACCESS_KEY_ID: 'key',
    RIOSOMA_FILES_S3_SECRET_ACCESS_KEY: 'secret',
    RIOSOMA_FILES_S3_REGION: 'eu-west-1',
  };
  expect(loadConfig(s3).filesS3).toEqual({
    region: 'eu-west-1',
    bucket: 'files',
    prefix: '',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    pathStyle: false,
  });
  expect(
    loadConfig({ ...s3, RIOSOMA_FILES_S3_PREFIX: 'riosoma/files//', RIOSOMA_FILES_S3_PATH_STYLE: 'true' })
      .filesS3,
  ).toMatchObject({ prefix: 'riosoma/files/', pathStyle: true });
  for (const setting of [
    'RIOSOMA_FILES_S3_BUCKET',
    'RIOSOMA_FILES_S3_ACCESS_KEY_ID',
    'RIOSOMA_FILES_S3_SECRET_ACCESS_KEY',
  ])
    expect(() => loadConfig({ ...s3, [setting]: undefined })).toThrow(`${setting} is required`);
  expect(() => loadConfig({ ...s3, RIOSOMA_FILES_S3_REGION: undefined })).toThrow(
    'RIOSOMA_FILES_S3_REGION or RIOSOMA_FILES_S3_ENDPOINT is required',
  );
  expect(() => loadConfig({ ...s3, RIOSOMA_FILES_S3_ENDPOINT: 'https://user:pass@s3.example.com' })).toThrow(
    'RIOSOMA_FILES_S3_ENDPOINT',
  );
  expect(() => loadConfig({ ...s3, RIOSOMA_FILES_S3_KMS_KEY_ID: 'key' })).toThrow(
    'RIOSOMA_FILES_S3_KMS_KEY_ID',
  );
  expect(() => loadConfig({ ...s3, RIOSOMA_FILES_S3_PREFIX: '../up' })).toThrow('RIOSOMA_FILES_S3_PREFIX');
  // Files already in a bucket are still read from it after new files go elsewhere.
  expect(loadConfig({ ...s3, RIOSOMA_FILES_STORAGE: 'postgres' }).filesS3).toMatchObject({ bucket: 'files' });
  expect(loadConfig(base).filesS3).toBeNull();

  const azure = {
    ...base,
    RIOSOMA_FILES_STORAGE: 'azure-blob',
    RIOSOMA_FILES_AZURE_ACCOUNT: 'riosomafiles',
    RIOSOMA_FILES_AZURE_CONTAINER: 'attachments',
  };
  expect(loadConfig(azure).filesAzure).toEqual({
    account: 'riosomafiles',
    container: 'attachments',
    prefix: '',
    endpoint: 'https://riosomafiles.blob.core.windows.net',
  });
  expect(() => loadConfig({ ...azure, RIOSOMA_FILES_AZURE_CONTAINER: undefined })).toThrow(
    'RIOSOMA_FILES_AZURE_CONTAINER is required',
  );
  expect(() => loadConfig({ ...azure, RIOSOMA_FILES_AZURE_ACCOUNT_KEY: 'not base64!' })).toThrow(
    'RIOSOMA_FILES_AZURE_ACCOUNT_KEY',
  );
  expect(loadConfig({ ...azure, RIOSOMA_FILES_SIGNED_URL_SECONDS: '300' }).filesSignedUrlSeconds).toBe(300);
  expect(loadConfig(base).filesSignedUrlSeconds).toBe(0);
});
