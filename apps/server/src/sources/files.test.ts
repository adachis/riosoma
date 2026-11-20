/**
 * File sources through the server: the guarded network they reach the world through, the checks a
 * source's address meets before it's saved, and whole syncs from a local web server into tables,
 * overrides and all.  The bucket suite that runs against MinIO is `files.minio.test.ts`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  newId,
  SourceConnection,
  type CommandBatchResult,
  type DatabaseSchema,
  type RowData,
  type SheetCell,
  type SourceMeta,
  type SourceObject,
  type SourcePreview,
  type SourceTestResult,
  type TableMeta,
} from '@riosoma/contracts';
import { ConnectorError, createFileConnector, type ConnectorContext } from '@riosoma/connectors';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import type { Resolve } from '../automations/outbound.js';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { fetchRowsById } from '../data/physical/records.js';
import { readSpreadsheet } from '../data/imports/spreadsheet.js';
import { checkFileAddress, checkFileHost, fileNetwork, spreadsheetReader } from './files.js';
import { claimSyncs, runSync } from './sync.js';

const TOKEN = 'Bearer file-token-value';
const files = new Map<string, { body: Buffer; type?: string }>();
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
let web: Server;
let other: Server;
let origin = '';
let otherOrigin = '';
let kit: TestPostgres;
let server: ServerFixture;
let databaseId: string;

function csv(rows: Array<Array<string | number>>): Buffer {
  return Buffer.from(['id,name,amount,joined', ...rows.map((row) => row.join(','))].join('\n'));
}

async function listen(handler: Parameters<typeof createServer>[1]): Promise<[Server, string]> {
  const listener = createServer(handler);
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  return [listener, `http://127.0.0.1:${(listener.address() as AddressInfo).port}`];
}

async function workbook(): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Orders');
  sheet.addRow(['Order', 'Placed', 'Shipped', 'Total', 'Rush', 'Note']);
  sheet.addRow([
    101,
    new Date(Date.UTC(2026, 8, 27)),
    new Date(Date.UTC(2026, 8, 28, 13, 45)),
    0.1 + 0.2,
    true,
    'first',
  ]);
  sheet.addRow([102, new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 2, 8, 0)), 7, false, '0042']);
  sheet.getColumn(2).numFmt = 'yyyy-mm-dd';
  sheet.getColumn(3).numFmt = 'yyyy-mm-dd hh:mm';
  return Buffer.from(await book.xlsx.writeBuffer());
}

beforeAll(async () => {
  files.set('/people.csv', {
    body: csv([
      [1, 'Ada', 10.5, '09/27/2026'],
      [2, 'Grace', 20, '10/01/2026'],
      [3, 'Linus', 30, '01/02/2026'],
    ]),
  });
  files.set('/book.xlsx', { body: await workbook() });
  files.set('/large.csv', { body: Buffer.from(`a\n${'12345\n'.repeat(40_000)}`) });
  [web, origin] = await listen((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    seen.push({ path, headers: req.headers });
    const redirects: Record<string, string> = {
      '/to-private.csv': 'https://files.example.test/people.csv',
      '/to-metadata.csv': 'http://169.254.169.254/latest/meta-data',
      '/to-other.csv': `${otherOrigin}/echo.csv`,
      '/to-same.csv': '/people.csv',
    };
    if (redirects[path]) {
      res.writeHead(302, { location: redirects[path] });
      return res.end();
    }
    if (path.startsWith('/private/') && req.headers.authorization !== TOKEN) {
      res.writeHead(401);
      return res.end();
    }
    const file = files.get(path.replace(/^\/private/, ''));
    if (!file) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, file.type ? { 'content-type': file.type } : {});
    if (req.method === 'HEAD') return res.end();
    res.end(file.body);
  });
  [other, otherOrigin] = await listen((req, res) => {
    seen.push({ path: `other:${req.url}`, headers: req.headers });
    res.end('id\n9\n');
  });
  kit = await startTestPostgres();
  // Private hosts are allowed, so the test's own web server on this machine can be reached.
  server = await startServer(kit, 'filesrc', {
    automationsAllowPrivateHosts: true,
    sourceFileMaxBytes: 64 * 1024,
  });
  const created = await server.app.inject({
    method: 'POST',
    url: '/api/databases',
    headers: server.owner.headers,
    payload: {
      id: newId('database'),
      name: 'Files',
      table: {
        id: newId('table'),
        name: 'Local',
        fields: [{ id: newId('field'), name: 'Name', type: 'text' }],
        view: { id: newId('view'), name: 'Grid' },
      },
    },
  });
  expect(created.statusCode, created.body).toBe(200);
  databaseId = created.json<DatabaseSchema>().database.id;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await kit?.stop();
  await new Promise<void>((resolve) => web.close(() => resolve()));
  await new Promise<void>((resolve) => other.close(() => resolve()));
});

/** A connector on the real guarded network, where names resolve the way a hostile one might. */
function guarded() {
  return createFileConnector('file-url', {
    network: fileNetwork({
      resolve: async (host) =>
        host === 'files.example.test'
          ? [{ address: '10.0.0.5', family: 4 }]
          : [{ address: '93.184.216.34', family: 4 }],
      // Only this test's own servers may be reached on a private address.
      allowPrivate: (url) => url.hostname === '127.0.0.1',
    }),
    spreadsheet: spreadsheetReader,
    maxBytes: 64 * 1024,
  });
}

function context(url: string, secrets: ConnectorContext['secrets'] = {}): ConnectorContext {
  return { connection: { kind: 'file-url', url }, secrets, timeoutMs: 10_000 };
}

const OBJECT = { kind: 'object' as const, object: { schema: null, name: 'file' } };

async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

async function createSource(url: string, secrets: Record<string, string> = {}): Promise<SourceMeta> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/sources',
    headers: server.owner.headers,
    payload: { name: `Files ${newId('source')}`, connection: { kind: 'file-url', url }, secrets },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourceMeta>();
}

async function applied(input: Record<string, unknown>) {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/databases/${databaseId}/commands`,
    headers: server.owner.headers,
    payload: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), ...input }],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = response.json<CommandBatchResult>().results[0]!;
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'applied' });
}

async function sync(tableId: string): Promise<TableMeta> {
  await applied({ kind: 'table.sync', tableId, confirmRemovals: false });
  for (const job of await claimSyncs(server.ctx, 100)) await runSync(server.ctx, job);
  return (await loadTable(server.pool, server.schemas, tableId))!;
}

async function rows(tableId: string): Promise<RowData[]> {
  const ids = await query<{ __id: string }>(
    server.pool,
    sql`SELECT __id FROM ${ident(server.schemas.data, tableId)} WHERE NOT __source_gone ORDER BY __rid`,
  );
  const fields = await loadFields(server.pool, server.schemas, [tableId]);
  return fetchRowsById(
    server.pool,
    server.schemas.data,
    tableId,
    fields,
    ids.rows.map((row) => row.__id),
  );
}

async function preview(source: SourceMeta): Promise<SourcePreview> {
  const response = await server.app.inject({
    method: 'POST',
    url: `/api/sources/${source.id}/preview`,
    headers: server.owner.headers,
    payload: { select: OBJECT },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SourcePreview>();
}

describe('the guarded network for file sources', () => {
  it('refuses private addresses, including one a redirect names, before anything connects', async () => {
    const connector = guarded();
    const direct = await refusal(
      connector.preview(context('https://files.example.test/people.csv'), OBJECT, 5),
    );
    expect(direct.messageKey).toBe('sources.file.blocked');
    const before = seen.length;
    const redirected = await refusal(connector.preview(context(`${origin}/to-private.csv`), OBJECT, 5));
    expect(redirected.messageKey).toBe('sources.file.blocked');
    const metadata = await refusal(connector.preview(context(`${origin}/to-metadata.csv`), OBJECT, 5));
    expect(metadata.messageKey).toBe('sources.file.blocked');
    // Only the redirecting answers were ever asked for.
    expect(seen.slice(before).map((entry) => entry.path)).toEqual(['/to-private.csv', '/to-metadata.csv']);
    const insecure = await refusal(
      connector.preview(context('http://public.example.test/people.csv'), OBJECT, 5),
    );
    expect(insecure.messageKey).toBe('sources.file.https');
    const test = await connector.test(context('https://files.example.test/people.csv'));
    expect(test.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.file.blocked' }),
    ]);
  });

  it('sends request headers only while redirects stay on the same origin', async () => {
    const connector = guarded();
    const secrets = { headers: `Authorization: ${TOKEN}` };
    expect((await connector.preview(context(`${origin}/to-same.csv`, secrets), OBJECT, 5)).rows).toHaveLength(
      3,
    );
    expect(seen.findLast((entry) => entry.path === '/people.csv')!.headers.authorization).toBe(TOKEN);
    expect((await connector.preview(context(`${origin}/to-other.csv`, secrets), OBJECT, 5)).rows).toEqual([
      [9],
    ]);
    expect(seen.findLast((entry) => entry.path.startsWith('other:'))!.headers.authorization).toBeUndefined();
  });

  it('stops a file at the size limit', async () => {
    const connector = guarded();
    const large = await refusal(connector.preview(context(`${origin}/large.csv`), OBJECT, 5));
    expect(large.messageKey).toBe('sources.file.tooLarge');
    const source = await createSource(`${origin}/large.csv`);
    const response = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/preview`,
      headers: server.owner.headers,
      payload: { select: OBJECT },
    });
    expect(response.json()).toMatchObject({
      error: { messageKey: 'sources.file.tooLarge', params: { megabytes: 0 } },
    });
  });

  it('refuses addresses and headers before a source is saved', async () => {
    const strict = { production: true, automationsAllowPrivateHosts: false };
    const problem = (url: string) => {
      try {
        checkFileAddress({ kind: 'file-url', url }, strict);
        return null;
      } catch (error) {
        return error instanceof AppError ? error.messageKey : String(error);
      }
    };
    expect(problem('https://files.example.com/a.csv')).toBeNull();
    expect(problem('http://files.example.com/a.csv')).toBe('sources.file.https');
    expect(problem('http://localhost:8000/a.csv')).toBe('sources.file.https');
    expect(problem('https://10.1.2.3/a.csv')).toBe('sources.file.blocked');
    expect(problem('https://[::1]/a.csv')).toBe('sources.file.blocked');
    expect(() =>
      checkFileAddress(
        {
          kind: 'bucket',
          endpoint: 'http://minio.internal:9000',
          bucket: 'data',
          prefix: '',
          pathStyle: true,
        },
        strict,
      ),
    ).toThrow(AppError);
    // With private hosts allowed, plain http reaches localhost, as it does for webhooks.
    expect(() =>
      checkFileAddress(
        { kind: 'file-url', url: 'http://localhost:8000/a.csv' },
        { production: true, automationsAllowPrivateHosts: true },
      ),
    ).not.toThrow();
    const insecure = await server.app.inject({
      method: 'POST',
      url: '/api/sources',
      headers: server.owner.headers,
      payload: {
        name: 'Plain',
        connection: { kind: 'file-url', url: 'http://files.example.com/a.csv' },
        secrets: {},
      },
    });
    expect(insecure.json()).toMatchObject({
      error: { messageKey: 'sources.file.https', fields: { url: 'sources.file.https' } },
    });
    const headers = await server.app.inject({
      method: 'POST',
      url: '/api/sources/test',
      headers: server.owner.headers,
      payload: {
        name: 'Headers',
        connection: { kind: 'file-url', url: `${origin}/people.csv` },
        secrets: { headers: 'Authorization Bearer no-colon' },
      },
    });
    expect(headers.json()).toMatchObject({ error: { messageKey: 'sources.file.headers' } });
    expect(headers.body).not.toContain('no-colon');
  });

  it('refuses file servers on a private network, and plain FTP, before they are saved', async () => {
    const strict = { production: true, automationsAllowPrivateHosts: false };
    const open = { production: true, automationsAllowPrivateHosts: true };
    const developing = { production: false, automationsAllowPrivateHosts: false };
    const hostKey = `ssh-ed25519 ${randomBytes(32).toString('base64')}`;
    const fileServer = (kind: 'sftp' | 'ftp' | 'ftps', host: string): SourceConnection =>
      SourceConnection.parse({
        kind,
        host,
        user: 'reader',
        path: 'exports/*.csv',
        ...(kind === 'sftp' ? { hostKey } : {}),
      });
    /** One file server's verdict, with the addresses its host name resolves to, or none. */
    const verdict = async (
      connection: SourceConnection,
      config = strict,
      addresses: string[] | null = ['93.184.216.34'],
    ): Promise<string | null> => {
      const resolve: Resolve = async () => {
        if (!addresses) throw new Error('no such host');
        return addresses.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
      };
      try {
        checkFileAddress(connection, config);
        await checkFileHost(connection, config, resolve);
        return null;
      } catch (error) {
        return error instanceof AppError ? error.messageKey : String(error);
      }
    };
    // An encrypted transport on the public internet needs nothing from the operator.
    expect(await verdict(fileServer('sftp', 'files.example.test'))).toBeNull();
    expect(await verdict(fileServer('ftps', 'files.example.test'))).toBeNull();
    expect(
      await verdict(fileServer('sftp', 'files.example.test'), strict, ['2606:4700:4700::1111']),
    ).toBeNull();
    // A literal loopback, private, link-local, or metadata address is refused before any lookup.
    for (const host of ['127.0.0.1', '::1', '10.1.2.3', '172.16.4.5', '192.168.1.1', '169.254.169.254'])
      expect(await verdict(fileServer('sftp', host)), host).toBe('sources.file.blocked');
    expect(await verdict(fileServer('sftp', 'localhost'))).toBe('sources.file.blocked');
    // So is a name that resolves somewhere private, one private address among public ones included.
    expect(await verdict(fileServer('sftp', 'files.example.test'), strict, ['10.0.0.5'])).toBe(
      'sources.file.blocked',
    );
    expect(
      await verdict(fileServer('ftps', 'files.example.test'), strict, ['93.184.216.34', 'fd00::1']),
    ).toBe('sources.file.blocked');
    expect(await verdict(fileServer('sftp', 'files.example.test'), open, ['10.0.0.5'])).toBeNull();
    // A name that doesn't resolve is the connection's to report, as a step of its own test.
    expect(await verdict(fileServer('sftp', 'missing.example.test'), strict, null)).toBeNull();
    // Plain FTP sends its password unencrypted, so it goes only where a plain-http address may.
    expect(await verdict(fileServer('ftp', 'files.example.test'))).toBe('sources.file.ftp');
    expect(await verdict(fileServer('ftp', 'files.example.test'), open)).toBe('sources.file.ftp');
    expect(await verdict(fileServer('ftp', 'localhost'), open)).toBeNull();
    expect(await verdict(fileServer('ftp', '10.0.0.5'), open)).toBe('sources.file.ftp');
    expect(await verdict(fileServer('ftp', 'localhost'), developing)).toBeNull();
    expect(await verdict(fileServer('ftp', 'localhost'))).toBe('sources.file.ftp');
    // Each refusal names the field the form shows it beside.
    const fields = (connection: SourceConnection) => {
      try {
        checkFileAddress(connection, strict);
        return null;
      } catch (error) {
        return error instanceof AppError ? error.fields : null;
      }
    };
    expect(fields(fileServer('ftp', 'files.example.test'))).toEqual({ kind: 'sources.file.ftp' });
    expect(fields(fileServer('sftp', '10.1.2.3'))).toEqual({ host: 'sources.file.blocked' });
  });

  it.each(['files.invalid:2222', 'fe80::1%eth0', 'a^b.invalid'])(
    'reports an invalid host format for %s',
    (host) => {
      const connection = SourceConnection.parse({ kind: 'ftps', host, user: 'reader', path: '*.csv' });
      for (const automationsAllowPrivateHosts of [false, true])
        expect(() =>
          checkFileAddress(connection, { production: true, automationsAllowPrivateHosts }),
        ).toThrowError(
          expect.objectContaining({
            messageKey: 'sources.remote.host',
            fields: { host: 'sources.remote.host' },
          }),
        );
    },
  );

  it.each(['sftp', 'ftps'] as const)('checks canonical %s hosts before saving', async (kind) => {
    const strict = { production: true, automationsAllowPrivateHosts: false };
    const open = { ...strict, automationsAllowPrivateHosts: true };
    const connection = (host: string) =>
      SourceConnection.parse({
        kind,
        host,
        user: 'reader',
        path: 'exports/*.csv',
        ...(kind === 'sftp' ? { hostKey: `ssh-ed25519 ${randomBytes(32).toString('base64')}` } : {}),
      });
    for (const host of ['%31%32%37.0.0.1', '127.1', '0x7f000001', '%31%30.0.0.5', '%31%36%39.254.169.254']) {
      expect(() => checkFileAddress(connection(host), strict), host).toThrowError(
        expect.objectContaining({ messageKey: 'sources.file.blocked' }),
      );
      expect(() => checkFileAddress(connection(host), open)).not.toThrow();
    }
    const host = `a${randomBytes(8).toString('hex')}.invalid`;
    const encoded = connection(`%61${host.slice(1)}`);
    const resolve = vi.fn<Resolve>(async (name) => {
      if (name !== host) throw new Error('no such host');
      return [{ address: '10.0.0.5', family: 4 }];
    });
    checkFileAddress(encoded, strict);
    await expect(checkFileHost(encoded, strict, resolve)).rejects.toHaveProperty(
      'messageKey',
      'sources.file.blocked',
    );
    expect(resolve).toHaveBeenCalledWith(host);
    resolve.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(checkFileHost(encoded, strict, resolve)).resolves.toBeUndefined();
  });
});

describe('syncing files into tables', () => {
  it('syncs a CSV file, keeps an override through the next sync, and never records the secret', async () => {
    const source = await createSource(`${origin}/private/people.csv`, { headers: `Authorization: ${TOKEN}` });
    expect(JSON.stringify(source)).not.toContain('file-token-value');
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['parse', 'ok'],
    ]);
    const objects = await server.app.inject({
      url: `/api/sources/${source.id}/objects`,
      headers: server.owner.headers,
    });
    expect(objects.json<SourceObject[]>()).toEqual([
      expect.objectContaining({ name: 'people.csv', type: 'file' }),
    ]);
    const shown = await preview(source);
    expect(shown.keyCandidates[0]).toEqual(['id']);
    expect(shown.columns.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['id', 'number'],
      ['name', 'text'],
      ['amount', 'number'],
      ['joined', 'date'],
    ]);
    expect(shown.rows[0]).toEqual([1, 'Ada', 10.5, '2026-09-27']);

    const tableId = newId('table');
    const field = Object.fromEntries(shown.columns.map((column) => [column.name, newId('field')]));
    await applied({
      kind: 'table.create',
      table: {
        id: tableId,
        name: 'People',
        source: { sourceId: source.id, select: OBJECT, keyColumns: ['id'], everyMinutes: null },
        fields: ['name', 'id', 'amount', 'joined'].map((name) => {
          const column = shown.columns.find((entry) => entry.name === name)!;
          return {
            id: field[name],
            name,
            type: column.suggested!.type,
            options: column.suggested!.options,
            source: { column: name, sourceType: column.sourceType },
          };
        }),
        view: { id: newId('view'), name: 'Grid' },
        records: [],
      },
    });
    const first = await sync(tableId);
    expect(first.source!.status, JSON.stringify(first.source!.status)).toMatchObject({
      state: 'idle',
      stats: { added: 3 },
    });
    const grace = (await rows(tableId)).find((row) => row.values[field.id!] === 2)!;
    expect(grace.values).toMatchObject({
      [field.name!]: 'Grace',
      [field.amount!]: 20,
      [field.joined!]: '2026-10-01',
    });
    await applied({
      kind: 'record.update',
      tableId,
      records: [{ id: grace.id, values: { [field.name!]: 'Grace Hopper' } }],
    });

    // The file changes: Grace's name and amount move, Linus leaves, and Katherine arrives.
    files.set('/people.csv', {
      body: csv([
        [1, 'Ada', 10.5, '09/27/2026'],
        [2, 'G. Hopper', 25, '10/01/2026'],
        [4, 'Katherine', 40, '02/03/2026'],
      ]),
    });
    const second = await sync(tableId);
    expect(second.source!.status.stats).toMatchObject({ added: 1, changed: 1, removed: 1 });
    const after = await rows(tableId);
    expect(after.map((row) => row.values[field.id!])).toEqual([1, 2, 4]);
    const kept = after.find((row) => row.id === grace.id)!;
    expect(kept.values).toMatchObject({ [field.name!]: 'Grace Hopper', [field.amount!]: 25 });
    expect(kept.overrides![field.name!]).toMatchObject({ source: 'G. Hopper' });

    // The header's value is nowhere: not in the change history, the audit log, or the sync status.
    const changes = await query<{ body: unknown }>(
      server.pool,
      sql`SELECT body FROM ${ident(server.schemas.app, 'changes')} WHERE table_id = ${tableId}`,
    );
    const events = await query<{ detail: unknown }>(
      server.pool,
      sql`SELECT * FROM ${ident(server.schemas.audit, 'events')}`,
    );
    for (const text of [
      JSON.stringify(changes.rows),
      JSON.stringify(events.rows),
      JSON.stringify(second.source),
    ])
      expect(text).not.toContain('file-token-value');
  });

  it('reads a workbook with the same types and dates the upload importer reads', async () => {
    const bytes = files.get('/book.xlsx')!.body;
    // What the upload importer's reader makes of the same workbook.
    const imported: SheetCell[][] = [];
    for await (const event of readSpreadsheet(bytes)) if (event.kind === 'row') imported.push(event.cells);
    expect(imported[1]).toEqual([
      101,
      { date: '2026-09-27' },
      { date: '2026-09-28T13:45:00' },
      0.3,
      true,
      'first',
    ]);
    const source = await createSource(`${origin}/book.xlsx`);
    const shown = await preview(source);
    expect(shown.columns.map((column) => [column.name, column.suggested])).toEqual([
      ['Order', { type: 'number', options: { precision: 0 } }],
      ['Placed', { type: 'date', options: {} }],
      ['Shipped', { type: 'date', options: { includeTime: true, timeZone: 'UTC' } }],
      ['Total', { type: 'number', options: { precision: 1 } }],
      ['Rush', { type: 'checkbox', options: {} }],
      ['Note', { type: 'text', options: {} }],
    ]);
    expect(shown.rows).toEqual([
      [101, '2026-09-27', '2026-09-28T13:45:00.000Z', 0.3, true, 'first'],
      [102, '2026-10-01', '2026-10-02T08:00:00.000Z', 7, false, '0042'],
    ]);
  });

  it('says a request header was refused without repeating it', async () => {
    const source = await createSource(`${origin}/private/people.csv`, {
      headers: 'Authorization: Bearer wrong-value-here',
    });
    const tested = await server.app.inject({
      method: 'POST',
      url: `/api/sources/${source.id}/test`,
      headers: server.owner.headers,
    });
    expect(tested.json<SourceTestResult>().steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.file.denied',
    });
    expect(tested.body).not.toContain('wrong-value-here');
    // Moving the address asks for the headers again rather than dropping them.
    const moved = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'file-url', url: `${origin}/people.csv` } },
    });
    expect(moved.json()).toMatchObject({ error: { messageKey: 'sources.secretsReenter' } });
    const cleared = await server.app.inject({
      method: 'PATCH',
      url: `/api/sources/${source.id}`,
      headers: server.owner.headers,
      payload: { connection: { kind: 'file-url', url: `${origin}/people.csv` }, secrets: { headers: null } },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<SourceMeta>().secrets).toEqual([]);
  });
});
