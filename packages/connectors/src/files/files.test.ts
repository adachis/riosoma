import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * File sources end to end against a local web server and a stand-in S3 bucket, with DuckDB doing
 * the reading for real.  The network here is a plain one, since the private-network rule belongs
 * to the server and its own tests hold it to that rule.  These tests cover what the connector does
 * with the bytes: every format, a prefix read as one, types that match the upload importer's,
 * keys, limits, and messages that never carry a secret.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { SheetCell, SourceConnection, SourceSecrets } from '@riosoma/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectorError, type Connector, type ConnectorContext, type SourceRow } from '../types.js';
import {
  cellValue,
  emptyStats,
  normalizeDate,
  observe,
  parseNumber,
  readingOf,
  type FileCell,
} from './cells.js';
import { createFileConnector, type FileConnectorOptions } from './connector.js';
import type { SpreadsheetEvent } from './engine.js';
import { formatOfContentType, formatOfName, parseUnionName, unionName } from './formats.js';
import { FileNetworkError, type FileNetwork, type FileResponse } from './network.js';
import {
  bucketTarget,
  listUrl,
  objectUrl,
  parseError,
  parseListing,
  payloadHash,
  presign,
  regionOf,
  sign,
} from './s3.js';

// ------------------------------------------------------------------ fixtures

const CSV = [
  'id,name,amount,paid,joined,seen,contact,notes',
  '1,Ada,"1,200.50",yes,09/27/2026,2026-09-27 14:30,ada@example.com,first',
  '2,Grace,-3.5,no,10/01/2026,2026-10-01T08:00:00Z,grace@example.com,',
  '3,Linus,$40,yes,01/02/2026,2026-01-02 09:15,linus@example.com,n/a',
].join('\n');

/** A workbook as the spreadsheet reader would hand it over: its sheets and their typed cells. */
const WORKBOOK: Array<{ name: string; rows: SheetCell[][] }> = [
  {
    name: 'Orders',
    rows: [
      ['Order', 'Placed', 'Total', 'Rush', 'Code'],
      [101, { date: '2026-09-27' }, 12.5, true, '0042'],
      [102, { date: '2026-09-28T13:45:00' }, 7, false, '0043'],
      [103, null, { error: '#N/A' }, true, '0044'],
    ],
  },
  { name: 'Notes', rows: [['Text'], ['hello']] },
];

function workbookBytes(sheets: typeof WORKBOOK): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(JSON.stringify(sheets))]);
}

async function* readWorkbook(bytes: Buffer): AsyncGenerator<SpreadsheetEvent> {
  const sheets = JSON.parse(bytes.subarray(4).toString('utf8')) as typeof WORKBOOK;
  for (const [position, sheet] of sheets.entries()) {
    yield { kind: 'sheet', name: sheet.name, position };
    for (const [index, cells] of sheet.rows.entries()) yield { kind: 'row', number: index + 1, cells };
    yield { kind: 'end', rows: sheet.rows.length, total: sheet.rows.length };
  }
}

const files = new Map<string, { body: Buffer; type?: string; auth?: string }>();
let server: Server;
let origin = '';
let root = '';
const requests: Array<{ path: string; headers: IncomingMessage['headers'] }> = [];

function listing(prefix: string): string {
  const keys = [...files.keys()]
    .filter((path) => path.startsWith('/bucket/'))
    .map((path) => decodeURIComponent(path.slice('/bucket/'.length)))
    .filter((key) => key.startsWith(prefix))
    .sort();
  const contents = keys
    .map(
      (key) =>
        `<Contents><Key>${key.replaceAll('&', '&amp;')}</Key><Size>${files.get(`/bucket/${encodeURI(key)}`)?.body.length ?? 0}</Size></Contents>`,
    )
    .join('');
  return `<?xml version="1.0"?><ListBucketResult><Name>bucket</Name><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'rio-file-sources-'));
  // Parquet comes from DuckDB itself, so its types are real ones.
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const parquetPath = join(root, 'made.parquet');
  await connection.run(
    `COPY (SELECT * FROM (VALUES (1, 'north', DATE '2026-09-27', 12.345::DECIMAL(10,3), TIMESTAMP '2026-09-27 10:00:00'),
      (2, 'south', DATE '2026-09-28', 7.5::DECIMAL(10,3), TIMESTAMP '2026-09-28 11:30:00')) AS t(id, region, day, amount, stamp))
     TO '${parquetPath}' (FORMAT parquet)`,
  );
  connection.disconnectSync();
  instance.closeSync();
  const parquet = await readFile(parquetPath);
  rmSync(parquetPath);

  files.set('/data/people.csv', { body: Buffer.from(CSV) });
  files.set('/data/people.tsv', {
    body: Buffer.from(CSV.replaceAll(',', '\t').replace('"1\t200.50"', '"1,200.50"')),
  });
  files.set('/data/rows.json', {
    body: Buffer.from(
      JSON.stringify([
        { id: 1, city: 'Lima', meta: { rank: 2 } },
        { id: 2, city: 'Oslo', meta: null },
      ]),
    ),
  });
  files.set('/data/rows.ndjson', { body: Buffer.from('{"id":"a","count":3}\n{"id":"b","count":4}\n') });
  files.set('/data/made.parquet', { body: parquet });
  files.set('/data/book.xlsx', { body: workbookBytes(WORKBOOK) });
  files.set('/data/unicode.csv', {
    body: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('name,word\nA,café\n', 'utf16le')]),
  });
  files.set('/data/export', { body: Buffer.from('a,b\n5,2\n'), type: 'text/csv; charset=utf-8' });
  files.set('/data/mystery', { body: Buffer.from('a,b\n1,2\n') });
  files.set('/data/private.csv', { body: Buffer.from('a\n7\n'), auth: 'Bearer right-token-value' });
  files.set('/data/huge.csv', { body: Buffer.from(`a\n${'1\n'.repeat(5_000)}`) });
  files.set('/data/broken.parquet', { body: Buffer.from('PAR1 but nothing more') });
  files.set('/bucket/exports/2026-09-01.csv', { body: Buffer.from('id,total\n1,10\n2,20\n') });
  files.set('/bucket/exports/2026-09-02.csv', { body: Buffer.from('total,id\n30,3\n40,4\n') });
  files.set('/bucket/exports/readme.txt', { body: Buffer.from('not data') });
  files.set('/bucket/exports/day.parquet', { body: parquet });
  files.set('/bucket/odd/a.csv', { body: Buffer.from('id,total\n1,10\n') });
  files.set('/bucket/odd/b.csv', { body: Buffer.from('id,other\n2,20\n') });
  files.set('/bucket/secret/keys.csv', { body: Buffer.from('id\n1\n') });

  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push({ path: url.pathname, headers: req.headers });
    if (url.pathname === '/bucket/' || url.pathname === '/bucket') {
      if (String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIDREADONLY/')) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        return res.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
      }
      if (!String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        return res.end(
          // This stand-in returns XML error data, never browser-rendered HTML.
          // nosemgrep: javascript.express.security.injection.raw-html-format.raw-html-format
          `<Error><Code>InvalidAccessKeyId</Code><Message>The key ${String(req.headers.authorization)} is unknown</Message></Error>`,
        );
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(listing(url.searchParams.get('prefix') ?? ''));
    }
    if (url.pathname === '/redirect.csv') {
      res.writeHead(302, { location: '/data/people.csv' });
      return res.end();
    }
    const file = files.get(url.pathname);
    if (!file) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      return res.end('<Error><Code>NoSuchKey</Code><Message>gone</Message></Error>');
    }
    if (file.auth && req.headers.authorization !== file.auth) {
      res.writeHead(401);
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': String(file.body.length), server: 'TestServer/1.0' });
      return res.end();
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ''));
    if (range) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), file.body.length - 1);
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${file.body.length}`,
        ...(file.type ? { 'content-type': file.type } : {}),
      });
      return res.end(file.body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...(file.type ? { 'content-type': file.type } : {}) });
    res.end(file.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** A plain network that reaches only this test's server, following no redirects. */
const plainNetwork: FileNetwork = {
  allowsAddress: (url) => url.protocol === 'https:' || url.hostname === '127.0.0.1',
  check: async () => ({ address: '127.0.0.1', family: 4 }),
  request: ({ url, method, headers, maxBytes, signal }) =>
    new Promise<FileResponse>((resolve, reject) => {
      const outgoing = httpRequest(url, { method, headers, signal }, (incoming) => {
        let size = 0;
        resolve({
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value[0] : value,
            ]),
          ),
          url,
          body: (async function* () {
            for await (const chunk of incoming) {
              size += (chunk as Buffer).length;
              if (size > maxBytes) throw new FileNetworkError('tooLarge');
              yield chunk as Buffer;
            }
          })(),
          close: () => incoming.destroy(),
        });
      });
      outgoing.on('error', (error) => reject(new FileNetworkError('failed', error.message)));
      outgoing.end();
    }),
};

function connectorFor(kind: 'file-url' | 'bucket', options: FileConnectorOptions = {}): Connector {
  return createFileConnector(kind, {
    network: plainNetwork,
    spreadsheet: (bytes) => readWorkbook(bytes),
    tempRoot: root,
    sockets: { connect: async () => undefined, handshake: async () => undefined },
    ...options,
  });
}

function urlContext(
  path: string,
  extra: Partial<SourceConnection> = {},
  secrets: SourceSecrets = {},
): ConnectorContext {
  return {
    connection: { kind: 'file-url', url: `${origin}${path}`, ...extra } as SourceConnection,
    secrets,
    timeoutMs: 20_000,
  };
}

function bucketContext(prefix = 'exports/', secrets: SourceSecrets = GOOD_KEYS): ConnectorContext {
  return {
    connection: { kind: 'bucket', endpoint: origin, bucket: 'bucket', prefix, pathStyle: true },
    secrets,
    timeoutMs: 20_000,
  };
}

const GOOD_KEYS: SourceSecrets = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMIsecretvalue' };
const OBJECT = { kind: 'object' as const, object: { schema: null, name: 'file' } };

async function everyRow(
  connector: Connector,
  ctx: ConnectorContext,
  columns: string[],
  keyColumns: string[],
  types: Record<string, string> = {},
  select = OBJECT,
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of connector.read(ctx, select, { columns, keyColumns, types, batchSize: 2 }))
    rows.push(...batch);
  return rows;
}

async function failureOf(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

/** Every call leaves its temporary directory behind it empty and gone. */
function leftovers(): string[] {
  return readdirSync(root).filter((name) => name.startsWith('riosoma-source-'));
}

// --------------------------------------------------------------------- tests

describe('signing requests for S3-compatible buckets', () => {
  const credentials = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  };
  const moment = new Date('2013-05-24T00:00:00Z');

  it('signs an object read the way the published example does', () => {
    const headers = sign(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      'us-east-1',
      credentials,
      { Range: 'bytes=0-9' },
      moment,
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(headers['x-amz-date']).toBe('20130524T000000Z');
  });

  it('signs a listing, with its query in canonical order', () => {
    const headers = sign(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2'),
      'us-east-1',
      credentials,
      {},
      moment,
    );
    expect(headers.authorization).toContain(
      'Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('signs an object write with its body the way the published example does', () => {
    const body = 'Welcome to Amazon S3.';
    const headers = sign(
      'PUT',
      objectUrl(
        bucketTarget({ bucket: 'examplebucket', endpoint: 'https://s3.amazonaws.com', pathStyle: false }),
        'test$file.text',
      ),
      'us-east-1',
      credentials,
      { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
      moment,
      payloadHash(body),
    );
    expect(headers['x-amz-content-sha256']).toBe(
      '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072',
    );
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, ' +
        'Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('presigns an address the way the published example does', () => {
    const url = presign(
      'GET',
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      'us-east-1',
      credentials,
      86_400,
      moment,
    );
    expect(url.href).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('addresses buckets by host or by path, encodes keys, and finds each service’s region', () => {
    const aws = bucketTarget({ bucket: 'my-data', region: 'eu-west-1', pathStyle: false });
    expect(objectUrl(aws, 'a b/c+d.csv').href).toBe(
      'https://my-data.s3.eu-west-1.amazonaws.com/a%20b/c%2Bd.csv',
    );
    const minio = bucketTarget({ endpoint: 'http://localhost:9000', bucket: 'files', pathStyle: true });
    expect(listUrl(minio, 'x/', 1000).href).toBe(
      'http://localhost:9000/files/?list-type=2&max-keys=1000&prefix=x%2F',
    );
    const base = { kind: 'bucket' as const, bucket: 'b', prefix: '', pathStyle: false };
    expect(regionOf({ ...base, endpoint: 'https://s3.us-west-004.backblazeb2.com' })).toBe('us-west-004');
    expect(regionOf({ ...base, endpoint: 'https://abc.r2.cloudflarestorage.com' })).toBe('auto');
    expect(regionOf({ ...base, endpoint: 'https://storage.googleapis.com' })).toBe('auto');
    expect(regionOf({ ...base, endpoint: 'http://localhost:9000' })).toBe('us-east-1');
  });

  it('reads listings and error answers', () => {
    expect(
      parseListing(
        '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>n&amp;1</NextContinuationToken>' +
          '<Contents><Key>a&amp;b.csv</Key><Size>12</Size></Contents></ListBucketResult>',
      ),
    ).toEqual({ objects: [{ key: 'a&b.csv', bytes: 12 }], next: 'n&1' });
    expect(parseError('<Error><Code>NoSuchBucket</Code><Message>none</Message></Error>')).toEqual({
      code: 'NoSuchBucket',
      message: 'none',
    });
  });
});

describe('formats', () => {
  it('chooses a format by extension, then by content type, and names unions as patterns', () => {
    expect(formatOfName('a/B.CSV')).toBe('csv');
    expect(formatOfName('x.jsonl')).toBe('ndjson');
    expect(formatOfName('x.xls')).toBeNull();
    expect(formatOfContentType('application/vnd.apache.parquet')).toBe('parquet');
    expect(formatOfContentType('text/tab-separated-values; charset=utf-8')).toBe('tsv');
    expect(unionName('exports/', 'csv')).toBe('exports/*.csv');
    expect(parseUnionName('exports/*.csv')).toEqual({ prefix: 'exports/', format: 'csv' });
    expect(parseUnionName('exports/a.csv')).toBeNull();
  });
});

describe('reading cells the way the upload importer does', () => {
  // The importer's own cases, from `apps/web/src/screens/import/columns.test.ts`.
  function infer(values: FileCell[]) {
    const stats = emptyStats();
    for (const value of values) observe(stats, value);
    return readingOf(stats);
  }

  it.each([
    ['number', ['1.20', '-2.345', '']],
    ['checkbox', ['true', 'FALSE', 'yes', 'no', '1', '0', 'x', 'checked']],
    ['date', ['2026-01-02', '2026-02-03']],
    ['dateTime', ['2026-01-02', '2026-02-03T12:20:00Z']],
    ['email', ['a@example.com', 'b@example.com']],
    ['url', ['https://example.com', 'http://example.org/a']],
    ['longText', ['A\nB', 'C']],
    ['longText', ['x'.repeat(256)]],
    ['text', ['A', 'B']],
    ['text', ['', '']],
    // The importer would suggest a single select here, where a synced column only offers it.
    ['text', ['Ready', 'Done', 'Ready']],
  ])('chooses %s', (type, values) => {
    expect(infer(values).type).toBe(type);
  });

  it('keeps the most decimal places, up to eight, and samples a thousand values', () => {
    expect(infer(['1.20', '-2.345', '3.123456789']).precision).toBe(8);
    expect(infer(['1,200', '3']).precision).toBe(0);
    const sampled = infer([
      ...Array<string>(1000).fill(''),
      ...Array<string>(1000).fill('12'),
      'not a number',
    ]);
    expect(sampled.type).toBe('number');
  });

  it('picks one date order for a column, preferring month first when both fit', () => {
    const dayFirst = infer(['01/02/2026', '13/02/2026']);
    expect(dayFirst).toMatchObject({ type: 'date', dateOrder: 'dmy' });
    expect(cellValue('01/02/2026', 'date', dayFirst)).toBe('2026-02-01');
    expect(cellValue('02/13/2026', 'date', dayFirst)).toBeNull();
    const either = infer(['01/02/2026']);
    expect(either.dateOrder).toBe('mdy');
    expect(cellValue('01/02/2026', 'date', either)).toBe('2026-01-02');
    expect(infer(['13/02/2026', '02/13/2026']).type).toBe('text');
    expect(infer(['02/30/2026']).type).toBe('text');
    expect(normalizeDate('9/27/26', 'mdy')).toBe('2026-09-27');
  });

  it('reads times with no zone as UTC and keeps explicit offsets', () => {
    const european = { type: 'dateTime' as const, precision: 0, dateOrder: 'dmy' as const };
    expect(cellValue('27.09.2026 11:05', 'date', european)).toBe('2026-09-27T11:05:00.000Z');
    expect(cellValue('2026-09-27T11:05:00+02:00', 'date', european)).toBe('2026-09-27T09:05:00.000Z');
    expect(cellValue('9/27/2026 2:30 PM', 'date', { ...european, dateOrder: 'mdy' })).toBe(
      '2026-09-27T14:30:00.000Z',
    );
  });

  it('reads numbers as a person writes them, and leaves out cells that don’t fit', () => {
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('(12)')).toBe(-12);
    expect(parseNumber('$40')).toBe(40);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('12 apples')).toBeNull();
    const number = infer(['1']);
    expect(cellValue('n/a', 'number', number)).toBeNull();
    expect(cellValue('yes', 'checkbox', number)).toBe(true);
    expect(cellValue('off', 'checkbox', number)).toBe(false);
    expect(cellValue('maybe', 'checkbox', number)).toBeNull();
    expect(cellValue('a, b,a', 'multipleSelect', number)).toEqual(['a', 'b']);
  });

  it('lets a workbook’s typed cells decide their column, as the importer does', () => {
    expect(infer([12, 3.25, null]).type).toBe('number');
    expect(infer([true, false]).type).toBe('checkbox');
    expect(infer([{ date: '2026-01-02' }, { date: '2026-02-03' }]).type).toBe('date');
    expect(infer([{ date: '2026-01-02T10:00:00' }]).type).toBe('dateTime');
    // A number cell is never a checkbox, even when it holds a 1.
    expect(infer([1, 0]).type).toBe('number');
    expect(infer([1, 'n/a']).type).toBe('text');
    expect(cellValue({ date: '2026-09-28T13:45:00' }, 'date', infer([{ date: '2026-09-28T13:45:00' }]))).toBe(
      '2026-09-28T13:45:00.000Z',
    );
    expect(cellValue(12.5, 'text', infer([12.5]))).toBe('12.5');
  });
});

describe('a file at a web address', () => {
  it('reads a CSV file with the importer’s types, keys, and values', async () => {
    const connector = connectorFor('file-url');
    const ctx = urlContext('/data/people.csv');
    const columns = await connector.describe(ctx, OBJECT);
    expect(Object.fromEntries(columns.map((column) => [column.name, column.suggested]))).toEqual({
      id: { type: 'number', options: { precision: 0 } },
      name: { type: 'text', options: {} },
      amount: { type: 'number', options: { precision: 2 } },
      paid: { type: 'checkbox', options: {} },
      joined: { type: 'date', options: {} },
      seen: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
      contact: { type: 'email', options: {} },
      notes: { type: 'text', options: {} },
    });
    expect(columns.find((column) => column.name === 'notes')?.alternatives).toContain('singleSelect');
    const preview = await connector.preview(ctx, OBJECT, 2);
    expect(preview.rowEstimate).toBe(3);
    expect(preview.rows).toEqual([
      [1, 'Ada', 1200.5, true, '2026-09-27', '2026-09-27T14:30:00.000Z', 'ada@example.com', 'first'],
      [2, 'Grace', -3.5, false, '2026-10-01', '2026-10-01T08:00:00.000Z', 'grace@example.com', null],
    ]);
    expect(await connector.keyCandidates(ctx, OBJECT.object)).toEqual([
      ['id'],
      ['name'],
      ['amount'],
      ['joined'],
      ['seen'],
      ['contact'],
    ]);
    const rows = await everyRow(connector, ctx, ['name', 'amount', 'notes'], ['id'], { amount: 'text' });
    expect(rows).toEqual([
      { key: '[1]', values: { name: 'Ada', amount: '1,200.50', notes: 'first' } },
      { key: '[2]', values: { name: 'Grace', amount: '-3.5', notes: null } },
      { key: '[3]', values: { name: 'Linus', amount: '$40', notes: 'n/a' } },
    ]);
    expect(leftovers()).toEqual([]);
  });

  it('reads TSV, JSON, NDJSON, Parquet, UTF-16 text, and a workbook’s chosen sheet', async () => {
    const connector = connectorFor('file-url');
    const tsv = await connector.preview(urlContext('/data/people.tsv'), OBJECT, 1);
    expect(tsv.rows[0]!.slice(0, 3)).toEqual([1, 'Ada', 1200.5]);

    const json = urlContext('/data/rows.json');
    expect(
      (await connector.describe(json, OBJECT)).map((column) => [column.name, column.suggested?.type]),
    ).toEqual([
      ['id', 'number'],
      ['city', 'text'],
      ['meta', 'longText'],
    ]);
    expect((await connector.preview(json, OBJECT, 5)).rows).toEqual([
      [1, 'Lima', '{"rank":2}'],
      [2, 'Oslo', null],
    ]);

    const ndjson = urlContext('/data/rows.ndjson');
    expect(await everyRow(connector, ndjson, ['count'], ['id'])).toEqual([
      { key: '["a"]', values: { count: 3 } },
      { key: '["b"]', values: { count: 4 } },
    ]);

    const parquet = urlContext('/data/made.parquet');
    const parquetColumns = await connector.describe(parquet, OBJECT);
    expect(parquetColumns.map((column) => [column.name, column.suggested])).toEqual([
      ['id', { type: 'number', options: { precision: 0 } }],
      ['region', { type: 'text', options: {} }],
      ['day', { type: 'date', options: {} }],
      ['amount', { type: 'number', options: { precision: 3 } }],
      ['stamp', { type: 'date', options: { includeTime: true, timeZone: 'UTC' } }],
    ]);
    expect(await everyRow(connector, parquet, ['day', 'amount', 'stamp'], ['id'])).toEqual([
      { key: '[1]', values: { day: '2026-09-27', amount: 12.345, stamp: '2026-09-27T10:00:00.000Z' } },
      { key: '[2]', values: { day: '2026-09-28', amount: 7.5, stamp: '2026-09-28T11:30:00.000Z' } },
    ]);

    const utf16 = await connector.preview(urlContext('/data/unicode.csv'), OBJECT, 5);
    expect(utf16.rows).toEqual([['A', 'café']]);

    // The content type names the format when the address doesn't.
    expect((await connector.preview(urlContext('/data/export'), OBJECT, 5)).rows).toEqual([[5, 2]]);

    const book = urlContext('/data/book.xlsx');
    const bookColumns = await connector.describe(book, OBJECT);
    expect(bookColumns.map((column) => [column.name, column.suggested])).toEqual([
      ['Order', { type: 'number', options: { precision: 0 } }],
      ['Placed', { type: 'date', options: { includeTime: true, timeZone: 'UTC' } }],
      ['Total', { type: 'number', options: { precision: 1 } }],
      ['Rush', { type: 'checkbox', options: {} }],
      ['Code', { type: 'number', options: { precision: 0 } }],
    ]);
    expect((await connector.preview(book, OBJECT, 5)).rows).toEqual([
      [101, '2026-09-27T00:00:00.000Z', 12.5, true, 42],
      [102, '2026-09-28T13:45:00.000Z', 7, false, 43],
      [103, null, null, true, 44],
    ]);
    // A code kept as text in the workbook stays text when a person chooses text for it.
    expect(await everyRow(connector, book, ['Code'], ['Order'], { Code: 'text' })).toEqual([
      { key: '[101]', values: { Code: '0042' } },
      { key: '[102]', values: { Code: '0043' } },
      { key: '[103]', values: { Code: '0044' } },
    ]);
    const notes = urlContext('/data/book.xlsx', { sheet: 'Notes' });
    expect((await connector.preview(notes, OBJECT, 5)).rows).toEqual([['hello']]);
    const missing = await failureOf(
      connector.describe(urlContext('/data/book.xlsx', { sheet: 'Gone' }), OBJECT),
    );
    expect(missing).toMatchObject({ messageKey: 'sources.file.sheetMissing', params: { sheet: 'Gone' } });
    expect(leftovers()).toEqual([]);
  });

  it('sends request headers, and names a refusal without repeating them', async () => {
    const connector = connectorFor('file-url');
    const right = urlContext('/data/private.csv', {}, { headers: 'Authorization: Bearer right-token-value' });
    expect((await connector.preview(right, OBJECT, 5)).rows).toEqual([[7]]);
    const wrong = urlContext('/data/private.csv', {}, { headers: 'Authorization: Bearer wrong-token-value' });
    const refused = await failureOf(connector.preview(wrong, OBJECT, 5));
    expect(refused.messageKey).toBe('sources.file.denied');
    expect(JSON.stringify(refused)).not.toContain('wrong-token-value');
    const result = await connector.test(wrong);
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.file.denied',
    });
    expect(JSON.stringify(result)).not.toContain('wrong-token-value');
    const missing = await failureOf(connector.preview(urlContext('/data/nothing.csv'), OBJECT, 5));
    expect(missing.messageKey).toBe('sources.sync.objectMissing');
  });

  it('climbs every step of a connection test', async () => {
    const connector = connectorFor('file-url');
    const result = await connector.test(urlContext('/data/people.csv'));
    expect(result).toMatchObject({ ok: true, serverVersion: 'TestServer/1.0' });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['read', 'ok'],
      ['parse', 'ok'],
    ]);
    const parquet = await connector.test(urlContext('/data/made.parquet'));
    expect(parquet.ok).toBe(true);
    const broken = await connector.test(urlContext('/data/broken.parquet'));
    expect(broken.steps.at(-1)).toMatchObject({
      step: 'parse',
      status: 'failed',
      messageKey: 'sources.test.parse',
    });
    const unknown = await connector.test(urlContext('/data/mystery'));
    expect(unknown.steps.at(-1)).toMatchObject({
      step: 'read',
      status: 'failed',
      messageKey: 'sources.file.formatUnknown',
    });
    const insecure = await connector.test({
      ...urlContext('/data/people.csv'),
      connection: { kind: 'file-url', url: 'http://example.com/a.csv' },
    });
    expect(insecure.steps).toEqual([
      expect.objectContaining({ step: 'resolve', status: 'failed', messageKey: 'sources.file.https' }),
    ]);
    expect(leftovers()).toEqual([]);
  });

  it('stops at the size limit and refuses queries', async () => {
    const connector = connectorFor('file-url', { maxBytes: 1_000 });
    const large = await failureOf(connector.preview(urlContext('/data/huge.csv'), OBJECT, 5));
    expect(large).toMatchObject({ messageKey: 'sources.file.tooLarge', params: { megabytes: 0 } });
    const query = await failureOf(
      connector.describe(urlContext('/data/people.csv'), { kind: 'query', sql: 'SELECT 1' }),
    );
    expect(query.messageKey).toBe('sources.file.noQueries');
    const aborted = new AbortController();
    aborted.abort();
    const stopped = await failureOf(
      connectorFor('file-url').describe(
        { ...urlContext('/data/people.csv'), signal: aborted.signal },
        OBJECT,
      ),
    );
    expect(stopped.messageKey).toBe('sources.sync.read');
    const broken = await failureOf(
      connectorFor('file-url').describe(urlContext('/data/broken.parquet'), OBJECT),
    );
    expect(broken.messageKey).toBe('sources.file.unreadable');
    // DuckDB's words name the file, not where it sat on disk.
    expect(broken.detail).toContain('broken.parquet');
    expect(broken.detail).not.toContain(root);
    expect(leftovers()).toEqual([]);
  });
});

describe('files in a bucket', () => {
  it('lists each readable file and one object for every format with more than one file', async () => {
    const connector = connectorFor('bucket');
    const objects = await connector.listObjects(bucketContext());
    expect(objects).toEqual([
      { schema: null, name: 'exports/*.csv', type: 'files', rowEstimate: null, bytes: 38, files: 2 },
      { schema: null, name: 'exports/2026-09-01.csv', type: 'file', rowEstimate: null, bytes: 19 },
      { schema: null, name: 'exports/2026-09-02.csv', type: 'file', rowEstimate: null, bytes: 19 },
      {
        schema: null,
        name: 'exports/day.parquet',
        type: 'file',
        rowEstimate: null,
        bytes: expect.any(Number),
      },
    ]);
    const signed = requests.filter((entry) => entry.path.startsWith('/bucket')).at(-1)!;
    expect(String(signed.headers.authorization)).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/s3\//,
    );
  });

  it('reads every file under a prefix as one, in order, matching columns by name', async () => {
    const connector = connectorFor('bucket');
    const union = { kind: 'object' as const, object: { schema: null, name: 'exports/*.csv' } };
    expect(await everyRow(connector, bucketContext(), ['total'], ['id'], {}, union)).toEqual([
      { key: '[1]', values: { total: 10 } },
      { key: '[2]', values: { total: 20 } },
      { key: '[3]', values: { total: 30 } },
      { key: '[4]', values: { total: 40 } },
    ]);
    expect(await connector.keyCandidates(bucketContext(), union.object)).toEqual([['id'], ['total']]);
    const single = { kind: 'object' as const, object: { schema: null, name: 'exports/2026-09-02.csv' } };
    expect((await connector.preview(bucketContext(), single, 5)).rows).toEqual([
      [30, 3],
      [40, 4],
    ]);
    const differ = await failureOf(
      connector.describe(bucketContext('odd/'), {
        kind: 'object',
        object: { schema: null, name: 'odd/*.csv' },
      }),
    );
    expect(differ).toMatchObject({ messageKey: 'sources.file.columnsDiffer', params: { file: 'odd/b.csv' } });
    expect(leftovers()).toEqual([]);
  });

  it('never reads outside its prefix', async () => {
    const connector = connectorFor('bucket');
    for (const name of ['secret/keys.csv', 'exports/../secret/keys.csv', 'secret/*.csv']) {
      const refused = await failureOf(
        connector.describe(bucketContext(), { kind: 'object', object: { schema: null, name } }),
      );
      expect(refused.messageKey).toBe('sources.sync.objectMissing');
    }
  });

  it('reads a named file with keys that may read it but not list the bucket', async () => {
    const readOnly = bucketContext('exports/2026-09-01.csv', {
      accessKeyId: 'AKIDREADONLY',
      secretAccessKey: 'read-only-secret',
    });
    const connector = connectorFor('bucket');
    expect(await connector.listObjects(readOnly)).toEqual([
      { schema: null, name: 'exports/2026-09-01.csv', type: 'file', rowEstimate: null, bytes: 19 },
    ]);
    const denied = await failureOf(
      connector.listObjects({ ...readOnly, connection: bucketContext('exports/').connection }),
    );
    expect(denied.messageKey).toBe('sources.file.keys');
  });

  it('says when the keys are wrong, without repeating them', async () => {
    const wrong = bucketContext('exports/', {
      accessKeyId: 'AKIDWRONGVALUE',
      secretAccessKey: 'wrong-secret-value',
    });
    const connector = connectorFor('bucket');
    const listed = await failureOf(connector.listObjects(wrong));
    expect(listed.messageKey).toBe('sources.file.keys');
    expect(listed.detail).toContain('InvalidAccessKeyId');
    expect(listed.detail).not.toContain('AKIDWRONGVALUE');
    const result = await connector.test(wrong);
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      status: 'failed',
      messageKey: 'sources.file.keys',
    });
    expect(JSON.stringify(result)).not.toContain('AKIDWRONGVALUE');
    expect(JSON.stringify(result)).not.toContain('wrong-secret-value');
    const good = await connector.test(bucketContext());
    expect(good.ok).toBe(true);
    expect(good.steps.map((step) => step.step)).toEqual([
      'resolve',
      'connect',
      'tls',
      'authenticate',
      'read',
      'parse',
    ]);
    const empty = await connector.test(bucketContext('nothing/'));
    expect(empty.steps.at(-1)).toMatchObject({
      step: 'read',
      status: 'failed',
      messageKey: 'sources.file.noFiles',
    });
  });
});

it('runs every declared bucket contract against its file fixture', async () => {
  const boundary = new FixtureBoundary();
  const api = connectorFor(
    'bucket',
    boundary.wrap({ network: plainNetwork, sockets: { connect: async () => {}, handshake: async () => {} } }),
  );
  await strictFixture(
    api,
    bucketContext(),
    { kind: 'object', object: { schema: null, name: 'exports/*.csv' } },
    ['id'],
    4,
    boundary,
  );
});
