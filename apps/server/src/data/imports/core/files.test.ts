import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../../../test/fixture.js';
import { FileDownloads } from './files.js';

const MB = 1024 * 1024;
const target = { tableId: newId('table'), fieldId: newId('field') };
const keys = {
  tooLarge: 'import.airtable.report.filesTooLarge',
  blocked: 'import.airtable.report.filesBlocked',
  failed: 'import.airtable.report.filesFailed',
  budget: 'import.airtable.report.filesBudget',
};
let kit: TestPostgres;
let server: ServerFixture;
let source: Server;
let origin: string;

beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'import_file_cap');
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Imported files',
      table: {
        id: target.tableId,
        name: 'Documents',
        fields: [
          { id: newId('field'), name: 'Name', type: 'text' },
          { id: target.fieldId, name: 'Files', type: 'attachment' },
        ],
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  source = createServer((_request, response) => {
    response.writeHead(200, { 'transfer-encoding': 'chunked' });
    response.end(Buffer.alloc(MB + 1, 1));
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (source) await new Promise<void>((resolve) => source.close(() => resolve()));
  await server?.close();
  await kit?.stop();
});

it('resolves signed URLs only after size checks and releases the allowance when resolution fails', async () => {
  const files = new FileDownloads<string>({
    app: server.app,
    owner: { orgId: server.owner.info.org.id, userId: server.owner.userId },
    resolve: async () => [],
    allowPrivate: (url) => url.origin === origin,
    limits: { fileBytes: MB, totalFileBytes: MB },
    signal: new AbortController().signal,
    keys,
  });
  let resolutions = 0;
  const prepare = async () => {
    resolutions++;
    return { url: '', filename: 'file.bin', size: null, problem: 'blocked' as const };
  };
  expect(
    await files.fetch('large', target, { url: '', filename: 'file.bin', size: MB + 1, prepare }),
  ).toBeNull();
  expect(resolutions).toBe(0);
  for (let index = 0; index < 2; index++) {
    const key = `blocked${index}`;
    expect(await files.fetch(key, target, { url: '', filename: 'file.bin', size: null, prepare })).toBeNull();
    expect(files.notes(key).map((note) => note.key)).toEqual([keys.blocked]);
  }
  expect(resolutions).toBe(2);
  expect(files.bytes).toBe(0);
});

it.each([
  { cap: MB, fileBytes: 4 * MB, totalFileBytes: 8 * MB, size: null, outcome: 'tooLarge' },
  { cap: MB, fileBytes: 4 * MB, totalFileBytes: 8 * MB, size: MB + 1, outcome: 'tooLarge' },
  { cap: MB, fileBytes: 4 * MB, totalFileBytes: 2 * MB, size: null, outcome: 'tooLarge' },
  { cap: MB / 2, fileBytes: 4 * MB, totalFileBytes: 8 * MB, size: null, outcome: 'tooLarge' },
  { cap: 4 * MB, fileBytes: MB, totalFileBytes: 8 * MB, size: null, outcome: 'tooLarge' },
  { cap: null, fileBytes: MB, totalFileBytes: 8 * MB, size: MB + 1, outcome: 'tooLarge' },
  { cap: 4 * MB, fileBytes: 4 * MB, totalFileBytes: MB, size: null, outcome: 'budget' },
])(
  'reports $outcome for cap $cap, file limit $fileBytes, budget $totalFileBytes, and size $size',
  async ({ cap, fileBytes, totalFileBytes, size, outcome }) => {
    const configured = await server.app.inject({
      method: 'POST',
      url: '/api/org/admin-commands',
      headers: server.owner.headers,
      payload: {
        kind: 'organization.files',
        maxUploadBytes: cap,
        revision: (await server.app.inject({ url: '/api/org/files', headers: server.owner.headers })).json()
          .revision,
      },
    });
    expect(configured.statusCode, configured.body).toBe(200);
    const files = new FileDownloads<string>({
      app: server.app,
      owner: { orgId: server.owner.info.org.id, userId: server.owner.userId },
      resolve: async () => [],
      allowPrivate: (url) => url.origin === origin,
      limits: { fileBytes, totalFileBytes },
      signal: new AbortController().signal,
      keys,
    });
    expect(await files.fetch(target.fieldId, target, { url: origin, filename: 'file.bin', size })).toBeNull();
    expect(files.notes(target.fieldId)).toEqual([
      {
        status: 'omitted',
        key: outcome === 'tooLarge' ? keys.tooLarge : keys.budget,
        params:
          outcome === 'tooLarge'
            ? { count: 1, megabytes: Math.min(cap ?? fileBytes, fileBytes) / MB }
            : { count: 1, gigabytes: 0 },
      },
    ]);
    expect(files.files).toBe(0);
    expect(files.bytes).toBe(0);
  },
);
