import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  AttachmentMeta,
  ClassificationRules,
  KnowledgeSettings,
  newId,
  type CommandBatchResult,
  type ImageSearchResult,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../test/fixture.js';
import { addressSettings } from '../../api-v1/attachments.js';
import { readFixture } from '../snapshots.test-helpers.js';
import { insertRecords } from '../physical/records.js';
import { scanPendingFiles } from './scanning.js';
import { standIn } from './scan-test-support.js';

let kit: TestPostgres, server: ServerFixture, host: Server, origin: string;
let png: Buffer;
let searches = 0,
  downloads = 0;
let lastSearch = '';
let scanner: Awaited<ReturnType<typeof standIn>>;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'imagesearch');
  scanner = await standIn();
  png = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  host = createServer((request, reply) => {
    if (request.url?.startsWith('/search?')) {
      searches++;
      lastSearch = request.url;
      return reply.setHeader('content-type', 'application/json').end(
        JSON.stringify({
          results: [
            {
              title: 'Licensed photo',
              url: 'https://photos.example.test/page',
              img_src: `${origin}/image.png`,
              license: 'CC BY 4.0',
            },
            {
              title: 'No license',
              url: 'https://photos.example.test/other',
              img_src: `${origin}/other.png`,
            },
            ...['private', 'large', 'text', 'wrong-header'].map((name) => ({
              title: name,
              url: 'https://photos.example.test/page',
              img_src: `${origin}/${name}`,
            })),
            {
              title: 'Private IP',
              url: 'https://photos.example.test/page',
              img_src: 'https://10.0.0.8/private.png',
            },
            { title: 'Invalid', url: 'javascript:alert(1)', img_src: `${origin}/image.png` },
          ],
        }),
      );
    }
    downloads++;
    if (request.url === '/private')
      return reply.writeHead(302, { location: 'https://10.0.0.9/image.png' }).end();
    if (request.url === '/large') return reply.setHeader('content-type', 'image/png').end(Buffer.alloc(1025));
    if (request.url === '/text')
      return reply.setHeader('content-type', 'image/png').end('a document, not an image');
    if (request.url === '/wrong-header') return reply.setHeader('content-type', 'text/html').end(png);
    reply.setHeader('content-type', 'image/png').end(png);
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
  Object.assign(addressSettings(server.ctx), {
    maxBytes: 1024,
    allowPrivate: (url: URL) => url.origin === origin,
  });
}, 60000);
afterAll(async () => {
  host?.closeAllConnections();
  await new Promise<void>((resolve) => (host ? host.close(() => resolve()) : resolve()));
  await scanner?.close();
  await server?.close();
  await kit?.stop();
});
beforeEach(async () => {
  server.config.clamavUrl = undefined;
  await send('PUT', '/api/ai/settings', { enabled: true });
  await configure(true);
});
async function send(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  headers = server.owner.headers,
) {
  return server.app.inject({ method, url, headers, payload });
}
async function configure(enabled: boolean, address: string | null = origin) {
  const response = await send('POST', '/api/knowledge/commands', {
    id: randomUUID(),
    kind: 'knowledge.settings',
    settings: KnowledgeSettings.parse({ search: { enabled, address } }),
  });
  expect(response.statusCode, response.body).toBe(200);
}
async function fixture() {
  const read = await readFixture(server, [{ type: 'attachment' }]);
  const recordId = newId('record');
  await insertRecords(
    server.pool,
    server.schemas.data,
    read.table.id,
    read.fields,
    [{ id: recordId, values: {} }],
    server.owner.userId,
  );
  const target = { tableId: read.table.id, fieldId: read.fields[0]!.id, recordId };
  const search = async () => send('POST', '/api/knowledge/images', { ...target, query: 'ocean' });
  const attach = async (result: ImageSearchResult, patch = {}) => {
    const response = await send('POST', `/api/databases/${read.table.databaseId}/commands`, {
      clientId: newId('client'),
      commands: [
        {
          kind: 'record.attachFromUrl',
          id: newId('command'),
          groupId: newId('action'),
          ...target,
          url: result.url,
          imageSearchToken: result.token,
          ...patch,
        },
      ],
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<CommandBatchResult>().results[0]!;
  };
  return { read, target, search, attach };
}

it('uses the image category and saves authenticated source and license metadata', async () => {
  const f = await fixture();
  const response = await f.search();
  expect(response.statusCode, response.body).toBe(200);
  const results = response.json<ImageSearchResult[]>();
  const request = new URL(lastSearch, origin);
  expect(request.searchParams.get('categories')).toBe('images');
  expect(request.searchParams.get('format')).toBe('json');
  expect(request.searchParams.get('q')).toBe('ocean');
  expect(results).toHaveLength(7);
  expect(await f.attach(results[0]!)).toMatchObject({ status: 'applied' });
  const stored = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.target.tableId}`,
  );
  const details = await send('GET', `/api/files?ids=${stored.rows[0]!.id}`);
  const [file] = AttachmentMeta.array().parse(details.json());
  expect(file!.source).toEqual({
    url: 'https://photos.example.test/page',
    imageUrl: `${origin}/image.png`,
    license: 'CC BY 4.0',
  });
  expect((await send('GET', file!.url)).rawPayload).toEqual(png);
  expect(await f.attach(results[1]!)).toMatchObject({ status: 'applied' });
  const noLicense = await query<{ thumbnails: { source: unknown } }>(
    server.pool,
    sql`SELECT thumbnails FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.target.tableId} AND name = 'other.png'`,
  );
  expect(noLicense.rows[0]!.thumbnails.source).toEqual({
    url: 'https://photos.example.test/other',
    imageUrl: `${origin}/other.png`,
  });
});

it('refuses private redirects and addresses, size overflow, and spoofed image content without retaining files', async () => {
  const f = await fixture();
  const results = (await f.search()).json<ImageSearchResult[]>();
  for (const [title, key] of [
    ['private', 'api.file.blocked'],
    ['Private IP', 'api.file.blocked'],
    ['large', 'api.file.tooLarge'],
    ['text', 'files.search.notImage'],
    ['wrong-header', 'files.search.notImage'],
  ]) {
    expect(await f.attach(results.find((result) => result.title === title)!)).toMatchObject({
      status: 'rejected',
      error: { messageKey: key },
    });
  }
  const stored = await query(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.target.tableId}`,
  );
  expect(stored.rowCount).toBe(0);
});

it('rejects altered selections and rechecks web settings before downloading', async () => {
  const f = await fixture();
  const result = (await f.search()).json<ImageSearchResult[]>()[0]!;
  const before = downloads;
  expect(await f.attach(result, { url: `${origin}/other.png` })).toMatchObject({ status: 'rejected' });
  expect(await f.attach(result, { imageSearchToken: result.token + 'x' })).toMatchObject({
    status: 'rejected',
  });
  expect(await f.attach(result, { recordId: newId('record') })).toMatchObject({ status: 'rejected' });
  await configure(false);
  expect(await f.attach(result)).toMatchObject({ status: 'rejected' });
  expect(downloads).toBe(before);
});

it('explains missing configuration, respects organization settings, and checks access before searching', async () => {
  const f = await fixture();
  const statusUrl = `/api/knowledge/images/status?${new URLSearchParams(f.target)}`;
  const before = searches;
  for (const [enabled, address] of [
    [false, origin],
    [true, null],
  ] as const) {
    await configure(enabled, address);
    expect((await send('GET', statusUrl)).json()).toMatchObject({ available: false, canConfigure: true });
    expect((await f.search()).statusCode).toBe(403);
  }
  await configure(true);
  await send('PUT', '/api/ai/settings', { enabled: false });
  expect((await send('GET', statusUrl)).json()).toMatchObject({ available: false, reason: 'rio.disabled' });
  const outsider = await server.addMember();
  expect(
    (await send('POST', '/api/knowledge/images', { ...f.target, query: 'secret' }, outsider.headers))
      .statusCode,
  ).toBe(404);
  expect(searches).toBe(before);
});

it('quarantines a selected image and retains provenance after the virus scan', async () => {
  const f = await fixture();
  const result = (await f.search()).json<ImageSearchResult[]>()[0]!;
  server.config.clamavUrl = scanner.url;
  expect(await f.attach(result)).toMatchObject({ status: 'applied' });
  const stored = await query<{ id: string }>(
    server.pool,
    sql`SELECT id FROM ${ident(server.schemas.app, 'files')} WHERE table_id = ${f.target.tableId}`,
  );
  const read = async () =>
    (await send('GET', `/api/files?ids=${stored.rows[0]!.id}`)).json<AttachmentMeta[]>()[0]!;
  expect(await read()).toMatchObject({ scanState: 'quarantined', url: '', source: { license: 'CC BY 4.0' } });
  await scanPendingFiles(server.app);
  expect(await read()).toMatchObject({
    scanState: 'clean',
    source: { url: result.sourceUrl, license: 'CC BY 4.0' },
  });
});

it('checks classification before sending a query and again before importing an earlier selection', async () => {
  const f = await fixture();
  const selected = (await f.search()).json<ImageSearchResult[]>()[0]!;
  const beforeSearch = searches,
    beforeDownload = downloads;
  const label = {
    id: 'restricted-images',
    name: 'Restricted images',
    color: 'red',
    description: '',
    rules: ClassificationRules.parse({ noProviders: true, noExternalSharing: true }),
  };
  for (const action of [
    { kind: 'classification.labels', labels: [label] },
    {
      kind: 'classification.assign',
      target: { kind: 'field', fieldId: f.target.fieldId, databaseId: f.read.table.databaseId },
      labelId: label.id,
    },
  ]) {
    const response = await send('POST', '/api/admin/governance/commands', {
      kind: 'governance.apply',
      id: newId('command'),
      action,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ status: 'applied' });
  }
  expect((await f.search()).json()).toMatchObject({
    error: { messageKey: 'governance.classificationDenied' },
  });
  expect(await f.attach(selected)).toMatchObject({
    status: 'rejected',
    error: { messageKey: 'governance.classificationDenied' },
  });
  expect(searches).toBe(beforeSearch);
  expect(downloads).toBe(beforeDownload);
});

it('proxies raster previews with the download guard and virus scanning, and refuses private previews', async () => {
  const f = await fixture();
  const results = (await f.search()).json<ImageSearchResult[]>();
  server.config.clamavUrl = scanner.url;
  const count = scanner.received.length;
  const response = await send('GET', results[0]!.preview);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.rawPayload).toEqual(png);
  expect(scanner.received.length).toBe(count + 1);
  expect(
    (await send('GET', results.find((result) => result.title === 'Private IP')!.preview)).statusCode,
  ).not.toBe(200);
  const mismatched = await send('GET', results.find((result) => result.title === 'wrong-header')!.preview);
  expect(mismatched.statusCode, mismatched.body).toBe(422);
  expect(mismatched.json().error.messageKey).toBe('knowledge.searchUnavailable');
});

it('blocks a revoked scanner destination before sending image previews', async () => {
  const f = await fixture();
  const results = (await f.search()).json<ImageSearchResult[]>();
  const count = scanner.received.length;
  server.config.clamavApprovedUrls = [];
  await query(
    server.pool,
    sql`UPDATE ${ident(server.schemas.app, 'orgs')}
    SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify({ enabled: true, address: scanner.url, oversizedPolicy: 'quarantine' })}::jsonb)
    WHERE id = ${server.owner.info.org.id}`,
  );
  try {
    const response = await send('GET', results[0]!.preview);
    expect(response.statusCode, response.body).toBe(403);
    expect(scanner.received).toHaveLength(count);
  } finally {
    delete server.config.clamavApprovedUrls;
    await query(
      server.pool,
      sql`UPDATE ${ident(server.schemas.app, 'orgs')} SET settings = settings - 'fileScanner' - 'fileScannerStatus'
      WHERE id = ${server.owner.info.org.id}`,
    );
  }
});
