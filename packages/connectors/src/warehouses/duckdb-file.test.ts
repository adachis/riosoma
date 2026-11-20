import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { allowedDuckPath, createDuckDbFileConnector } from './duckdb-file.js';
import { literal } from './sql.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'warehouse-file-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const select: SourceSelect = { kind: 'object', object: { schema: 'main', name: 'data' } };
function context(path: string, format = 'duckdb') {
  return { secrets: {}, connection: SourceConnection.parse({ kind: 'duckdb-file', path, format }) };
}
it('reads a database without changing its bytes', async () => {
  const path = join(root, 'example.duckdb');
  const instance = await DuckDBInstance.create(path);
  const db = await instance.connect();
  await db.run(
    'CREATE TABLE data(id BIGINT PRIMARY KEY, title VARCHAR, amount DECIMAL(20,4), document JSON)',
  );
  await db.run("INSERT INTO data VALUES (1, 'One', 12.3400, '{\"ready\":true}')");
  db.disconnectSync();
  instance.closeSync();
  const before = await readFile(path);
  const connector = createDuckDbFileConnector({ allowedRoots: [root] });
  expect((await connector.listObjects(context(path)))[0]?.name).toBe('data');
  expect(await connector.keyCandidates(context(path), select.object)).toEqual([['id']]);
  const preview = await connector.preview(context(path), select, 5);
  expect(preview.columns.map((c) => c.suggested?.type)).toEqual(['number', 'text', 'number', 'longText']);
  expect(preview.rows[0]).toEqual([1, 'One', 12.34, '{"ready":true}']);
  expect(await readFile(path)).toEqual(before);
  expect((await connector.test(context(path))).ok).toBe(true);
});
it.each(['local', 'url', 'bucket'] as const)(
  'preserves catalog-qualified stored views from %s storage',
  async (storage) => {
    const filename = 'event records.duckdb';
    const path = join(root, filename);
    const instance = await DuckDBInstance.create(path);
    const db = await instance.connect();
    try {
      await db.run('CREATE TABLE data AS SELECT 1 AS id');
      await db.run('CREATE VIEW stored AS SELECT * FROM "event records".main.data');
    } finally {
      db.disconnectSync();
      instance.closeSync();
    }
    const bytes = await readFile(path);
    const network = {
      allowsAddress: () => true,
      check: async () => ({ address: '127.0.0.1', family: 4 as const }),
      async request({ url }: { url: URL }) {
        const body = url.searchParams.has('list-type')
          ? Buffer.from(
              `<ListBucketResult><Contents><Key>events/${filename}</Key><Size>${bytes.length}</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
            )
          : bytes;
        return {
          status: 200,
          headers: {},
          url,
          body: (async function* () {
            yield body;
          })(),
          close() {},
        };
      },
    };
    const ctx = {
      connection: SourceConnection.parse({
        kind: 'duckdb-file',
        storage,
        path,
        url: `https://${['files', 'invalid'].join('.')}/events/${encodeURIComponent(filename)}`,
        bucket: 'source-files',
        prefix: 'events/',
      }),
      secrets: { accessKeyId: ['test', 'access'].join('-'), secretAccessKey: ['test', 'secret'].join('-') },
    };
    const connector = createDuckDbFileConnector({ allowedRoots: [root], network });
    const stored: SourceSelect = { kind: 'object', object: { schema: 'main', name: 'stored' } };
    expect(await connector.listObjects(ctx)).toContainEqual(
      expect.objectContaining({ name: 'stored', type: 'view' }),
    );
    expect((await connector.preview(ctx, stored, 5)).rows).toEqual([[1]]);
    const rows = [];
    for await (const batch of connector.read(ctx, stored, {
      columns: ['id'],
      keyColumns: ['id'],
      types: { id: 'number' },
    }))
      rows.push(...batch);
    expect(rows).toEqual([{ key: '[1]', values: { id: 1 } }]);
    expect(await readFile(path)).toEqual(bytes);
  },
);
it.each(['csv', 'parquet'])('reads a folder of %s files with the installed engine', async (format) => {
  const dir = join(root, 'files');
  await mkdir(dir);
  const instance = await DuckDBInstance.create(':memory:');
  const db = await instance.connect();
  for (const id of [1, 2])
    await db.run(
      `COPY (SELECT ${id} AS id, 'entry' AS title) TO ${literal(join(dir, `${id}.${format}`))} (FORMAT ${format})`,
    );
  db.disconnectSync();
  instance.closeSync();
  const rows = [];
  for await (const batch of createDuckDbFileConnector({ allowedRoots: [root] }).read(
    context(dir, format),
    select,
    { columns: ['id', 'title'], keyColumns: ['id'], types: { id: 'number', title: 'text' }, batchSize: 1 },
  ))
    rows.push(...batch);
  expect(rows.map((row) => row.key).sort()).toEqual(['[1]', '[2]']);
});
it('refuses disabled roots, sibling paths, and symlink escapes', async () => {
  const allowed = join(root, 'allowed');
  const sibling = join(root, 'allowed-other');
  await mkdir(allowed);
  await mkdir(sibling);
  const file = join(sibling, 'data.csv');
  await writeFile(file, 'id\n1\n');
  await symlink(file, join(allowed, 'link.csv'));
  await expect(allowedDuckPath(file, [allowed])).rejects.toMatchObject({
    messageKey: 'sources.duckdb.pathBlocked',
  });
  await expect(allowedDuckPath(join(allowed, 'link.csv'), [allowed])).rejects.toMatchObject({
    messageKey: 'sources.duckdb.pathBlocked',
  });
  await expect(createDuckDbFileConnector().preview(context(file, 'csv'), select, 5)).rejects.toMatchObject({
    messageKey: 'sources.duckdb.pathBlocked',
  });
});
it('refuses an active database and enforces the shared file size limit', async () => {
  const path = join(root, 'active.duckdb');
  await writeFile(path, 'pending');
  await writeFile(`${path}.wal`, 'pending');
  await expect(
    createDuckDbFileConnector({ allowedRoots: [root] }).preview(context(path), select, 5),
  ).rejects.toMatchObject({ messageKey: 'sources.duckdb.activeFile' });
  const csv = join(root, 'data.csv');
  await writeFile(csv, 'id,title\n1,entry\n');
  await expect(
    createDuckDbFileConnector({ allowedRoots: [root], maxBytes: 2 }).preview(context(csv, 'csv'), select, 5),
  ).rejects.toMatchObject({ messageKey: 'sources.file.tooLarge' });
});
it('prevents a query from reading files outside the staged source', async () => {
  const csv = join(root, 'data.csv');
  await writeFile(csv, 'id\n1\n');
  const hidden = join(root, 'hidden.csv');
  await writeFile(hidden, 'private\nvalue\n');
  const connector = createDuckDbFileConnector({ allowedRoots: [root] });
  await expect(
    connector.preview(
      context(csv, 'csv'),
      { kind: 'query', sql: `SELECT * FROM read_csv(${literal(hidden)})` },
      5,
    ),
  ).rejects.toBeDefined();
  await expect(
    connector.preview(
      context(csv, 'csv'),
      { kind: 'query', sql: 'SELECT 1) q; CREATE TABLE changed(id INT)' },
      5,
    ),
  ).rejects.toBeDefined();
});

it('stages signed bucket pages and ignores a sibling prefix', async () => {
  const requests: Array<{ url: URL; headers: Record<string, string> }> = [];
  const network = {
    allowsAddress: () => true,
    check: async () => ({ address: '127.0.0.1', family: 4 as const }),
    async request(request: { url: URL; headers: Record<string, string> }) {
      requests.push(request);
      const listing = request.url.searchParams.has('list-type');
      const body = listing
        ? request.url.searchParams.has('continuation-token')
          ? '<ListBucketResult><Contents><Key>events/two.csv</Key><Size>5</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>'
          : '<ListBucketResult><Contents><Key>events/one.csv</Key><Size>5</Size></Contents><Contents><Key>events-other/private.csv</Key><Size>5</Size></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken></ListBucketResult>'
        : request.url.pathname.endsWith('one.csv')
          ? 'id\n1\n'
          : 'id\n2\n';
      return {
        status: 200,
        headers: {},
        url: request.url,
        body: (async function* () {
          yield Buffer.from(body);
        })(),
        close() {},
      };
    },
  };
  const secrets = {
    accessKeyId: ['test', 'access'].join('-'),
    secretAccessKey: ['test', 'secret'].join('-'),
    sessionToken: ['test', 'session'].join('-'),
  };
  const ctx = {
    connection: SourceConnection.parse({
      kind: 'duckdb-file',
      storage: 'bucket',
      bucket: 'source-files',
      prefix: 'events',
      format: 'csv',
    }),
    secrets,
  };
  const preview = await createDuckDbFileConnector({ network }).preview(ctx, select, 5);
  expect(preview.rows.map((row) => row[0]).sort()).toEqual([1, 2]);
  expect(requests).toHaveLength(4);
  expect(requests.every((r) => !r.url.pathname.includes('events-other'))).toBe(true);
  expect(requests.every((r) => r.headers['x-amz-security-token'] === secrets.sessionToken)).toBe(true);
});

it('reports read and parse separately in the diagnostic ladder', async () => {
  const path = join(root, 'corrupt.duckdb');
  await writeFile(path, 'not a database');
  const result = await createDuckDbFileConnector({ allowedRoots: [root] }).test(context(path));
  expect(result.ok).toBe(false);
  expect(result.steps.map(({ step, status }) => [step, status])).toEqual([
    ['read', 'ok'],
    ['parse', 'failed'],
  ]);
});

it('runs every declared contract against the installed file engine', async () => {
  const filename = join(root, 'contract.duckdb');
  const instance = await DuckDBInstance.create(filename);
  const db = await instance.connect();
  await db.run('CREATE TABLE data(id INTEGER PRIMARY KEY)');
  await db.run('INSERT INTO data VALUES (1), (2), (3)');
  db.disconnectSync();
  instance.closeSync();
  const boundary = new FixtureBoundary();
  const spies = ['prepare', 'run', 'runAndReadAll', 'streamAndReadAll', 'disconnectSync'].map((name) => {
    const method = name as 'run';
    const original = DuckDBConnection.prototype[method];
    return vi.spyOn(DuckDBConnection.prototype, method).mockImplementation(function (
      this: DuckDBConnection,
      ...args
    ) {
      return boundary.wrap({ [method]: (...values: typeof args) => Reflect.apply(original, this, values) })[
        method
      ]!(...args);
    });
  });
  try {
    await strictFixture(
      createDuckDbFileConnector({ allowedRoots: [root] }),
      { ...context(filename), secrets: { token: crypto.randomUUID() } },
      { kind: 'object', object: { schema: 'main', name: 'data' } },
      ['id'],
      3,
      boundary,
    );
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});
