import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * Google Sheets sources against a local stand-in for Google's token address and the Sheets API.
 * The stand-in checks every assertion's signature with the key's public half, the way Google
 * does, and answers the refusals Google gives: a spreadsheet nobody shared, one that doesn't exist,
 * a file that isn't a spreadsheet, the API turned off, and requests to slow down.  The network here
 * is a plain one, since the private-network rule belongs to the server, whose own tests hold these
 * sources to it.
 */
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { GoogleSheetsConnection, type SourceSecrets } from '@riosoma/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileNetworkError, type FileNetwork, type FileResponse } from '../files/network.js';
import { ConnectorError, type ConnectorContext, type SourceRow } from '../types.js';
import {
  createGoogleSheetsConnector,
  ROW_NUMBER,
  sheetCell,
  sheetColumnNames,
  type SheetsConnectorOptions,
} from './connector.js';
import { readServiceAccountKey, serviceAccountAssertion, SHEETS_READ_SCOPE } from './google.js';
import { accessToken, serviceAccount } from '../service-account.test-helpers.js';

// ------------------------------------------------------------------- the key

const EMAIL = 'rio-sync@garden-project.iam.gserviceaccount.com';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY_JSON = JSON.stringify(
  serviceAccount({
    project_id: 'garden-project',
    private_key_id: 'key-id-0123456789',
    private_key: PRIVATE_PEM,
    client_email: EMAIL,
    // A key names a token address of its own, which the connector never uses.
    token_uri: 'https://attacker.example/token',
  }),
);
/** A key Google doesn't know, which signs correctly but can't be checked against the account. */
const STRANGER_JSON = JSON.stringify({
  ...JSON.parse(KEY_JSON),
  private_key: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
});

// ------------------------------------------------------------ the stand-in

const ORDERS = 'ordersSpreadsheet0123456789abcdefghijklmnop';
const HIDDEN = 'hiddenSpreadsheet0123456789abcdefghijklmnop';
const MISSING = 'missingSpreadsheet0123456789abcdefghijklmno';
const EXCEL = 'excelUploadedFile0123456789abcdefghijklmnopq';

interface FakeSheet {
  id: number;
  title: string;
  type?: string;
  rows: number;
  columns: number;
  /** Row 1 first, as the sheet shows them */
  values: unknown[][];
}

function orderRows(count: number): unknown[][] {
  return Array.from({ length: count }, (_unused, index) => {
    const n = index + 1;
    return [
      `A-${n}`,
      `Customer ${n}`,
      n * 2.5,
      `9/${(n % 28) + 1}/2026`,
      n % 2 === 0,
      `buyer${n}@example.com`,
      n % 3 === 0 ? 'North' : 'South',
    ];
  });
}

let sheets: Map<string, { title: string; sheets: FakeSheet[] }>;
let apiDisabled = false;
let throttles = 0;
let retryAfter: string | undefined;
let server: Server;
let origin = '';
const issued = new Set<string>();
let tokenRequests = 0;
const seen: Array<{ path: string; query: URLSearchParams; at: number }> = [];

function reset() {
  sheets = new Map([
    [
      ORDERS,
      {
        title: 'Garden orders',
        sheets: [
          {
            id: 0,
            title: 'Orders',
            rows: 1_000,
            columns: 26,
            values: [
              ['Order', 'Customer', 'Total', 'Placed', 'Paid', 'Email', 'Region'],
              ...orderRows(12),
              [],
              ['A-13', 'Late customer', '#N/A', '', '', '', 'West'],
            ],
          },
          { id: 1234, title: 'Chart', type: 'OBJECT', rows: 0, columns: 0, values: [] },
          {
            id: 77,
            title: 'Notes ’n’ things',
            rows: 20,
            columns: 4,
            values: [
              ['Exported from the old system'],
              [],
              ['Name', '', 'Name', 'Row number'],
              ['Ada', 'first', 'Lovelace', 'one'],
              ['Grace', 'second', 'Hopper', 'two'],
            ],
          },
          { id: 5, title: 'Empty', rows: 1_000, columns: 26, values: [] },
        ],
      },
    ],
    [HIDDEN, { title: 'Secret plans', sheets: [] }],
    [EXCEL, { title: 'Uploaded workbook', sheets: [] }],
  ]);
  apiDisabled = false;
  throttles = 0;
  retryAfter = undefined;
  tokenRequests = 0;
  seen.length = 0;
}
reset();

function send(res: ServerResponse, status: number, body: unknown, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function googleError(res: ServerResponse, code: number, status: string, message: string, reason?: string) {
  send(res, code, {
    error: {
      code,
      message,
      status,
      ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}),
    },
  });
}

/** Checks an assertion the way Google does, with the public half of the account's key. */
function checkAssertion(assertion: string, publicKey: KeyObject): Record<string, unknown> | null {
  const [header, claims, signature] = assertion.split('.');
  if (!header || !claims || !signature) return null;
  const good = verify(
    'RSA-SHA256',
    Buffer.from(`${header}.${claims}`),
    publicKey,
    Buffer.from(signature, 'base64url'),
  );
  return good ? (JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>) : null;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

function values(sheet: FakeSheet, first: number, last: number): unknown[][] {
  const rows = sheet.values.slice(first - 1, last).map((row) => {
    const cells = [...row];
    while (cells.length && (cells.at(-1) === '' || cells.at(-1) === null)) cells.pop();
    return cells;
  });
  // Google leaves out the empty rows at the end of a range.
  while (rows.length && rows.at(-1)!.length === 0) rows.pop();
  return rows;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', origin);
  seen.push({ path: url.pathname, query: url.searchParams, at: Date.now() });
  if (url.pathname === '/token') {
    tokenRequests++;
    const form = new URLSearchParams(await body(req));
    const claims = checkAssertion(form.get('assertion') ?? '', pair.publicKey);
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !claims)
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
    if (claims.iss !== EMAIL || claims.scope !== SHEETS_READ_SCOPE || claims.aud !== `${origin}/token`)
      return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid claims.' });
    const token = accessToken(tokenRequests);
    issued.add(token);
    return send(res, 200, { access_token: token, expires_in: 3599, token_type: 'Bearer' });
  }
  const auth = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (!issued.has(auth))
    return googleError(res, 401, 'UNAUTHENTICATED', `Request had invalid credentials: ${auth}`);
  if (throttles > 0) {
    throttles--;
    res.writeHead(429, {
      'content-type': 'application/json',
      ...(retryAfter ? { 'retry-after': retryAfter } : {}),
    });
    return res.end(
      JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }),
    );
  }
  if (apiDisabled)
    return googleError(
      res,
      403,
      'PERMISSION_DENIED',
      'Google Sheets API has not been used in project 12345 before or it is disabled.',
      'SERVICE_DISABLED',
    );
  const match = /^\/v4\/spreadsheets\/([^/]+)(?:\/values\/(.+))?$/.exec(url.pathname);
  if (!match) return googleError(res, 404, 'NOT_FOUND', 'Not found');
  const id = decodeURIComponent(match[1]!);
  if (id === HIDDEN) return googleError(res, 403, 'PERMISSION_DENIED', 'The caller does not have permission');
  if (id === EXCEL)
    return googleError(res, 400, 'FAILED_PRECONDITION', 'This operation is not supported for this document');
  const found = sheets.get(id);
  if (!found) return googleError(res, 404, 'NOT_FOUND', 'Requested entity was not found.');
  if (!match[2])
    return send(res, 200, {
      spreadsheetId: id,
      properties: { title: found.title },
      sheets: found.sheets.map((sheet, index) => ({
        properties: {
          sheetId: sheet.id,
          title: sheet.title,
          index,
          sheetType: sheet.type ?? 'GRID',
          ...(sheet.type === 'OBJECT'
            ? {}
            : { gridProperties: { rowCount: sheet.rows, columnCount: sheet.columns } }),
        },
      })),
    });
  const range = /^'((?:[^']|'')*)'!(\d+):(\d+)$/.exec(decodeURIComponent(match[2]));
  if (!range) return googleError(res, 400, 'INVALID_ARGUMENT', 'Unable to parse range');
  const sheet = found.sheets.find((entry) => entry.title === range[1]!.replaceAll("''", "'"));
  if (!sheet) return googleError(res, 400, 'INVALID_ARGUMENT', `Unable to parse range: ${match[2]}`);
  if (Number(range[3]) > sheet.rows)
    return googleError(res, 400, 'INVALID_ARGUMENT', `Range exceeds grid limits. Max rows: ${sheet.rows}`);
  if (url.searchParams.get('valueRenderOption') !== 'UNFORMATTED_VALUE')
    return googleError(res, 400, 'INVALID_ARGUMENT', 'Expected unformatted values');
  const rows = values(sheet, Number(range[2]), Number(range[3]));
  send(res, 200, {
    range: decodeURIComponent(match[2]),
    majorDimension: 'ROWS',
    ...(rows.length ? { values: rows } : {}),
  });
}

const plainNetwork: FileNetwork = {
  allowsAddress: (url) => url.protocol === 'https:' || url.hostname === '127.0.0.1',
  check: async () => ({ address: '127.0.0.1', family: 4 }),
  request: ({ url, method, headers, body: sent, maxBytes, signal }) =>
    new Promise<FileResponse>((resolve, reject) => {
      if (url.hostname !== '127.0.0.1') {
        reject(new FileNetworkError('blocked', `nothing may reach ${url.hostname}`));
        return;
      }
      const outgoing = httpRequest(url, { method, headers, signal }, (incoming) => {
        let size = 0;
        resolve({
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(', ') : value,
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
      outgoing.end(sent);
    }),
};

beforeAll(async () => {
  server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'boom' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  reset();
});

function connector(options: SheetsConnectorOptions = {}) {
  return createGoogleSheetsConnector({
    network: plainNetwork,
    sockets: { connect: async () => undefined, handshake: async () => undefined },
    sheetsUrl: origin,
    tokenUrl: `${origin}/token`,
    // Fast enough for tests, and still paced.
    requestsPerSecond: 200,
    ...options,
  });
}

function context(
  spreadsheets: string[] = [ORDERS],
  extra: Record<string, unknown> = {},
  secrets: SourceSecrets = { serviceAccountJson: KEY_JSON },
): ConnectorContext {
  return {
    connection: GoogleSheetsConnection.parse({ kind: 'google-sheets', spreadsheets, ...extra }),
    secrets,
    timeoutMs: 20_000,
  };
}

const sheet = (id: number, spreadsheet = ORDERS) => ({
  kind: 'object' as const,
  object: { schema: spreadsheet, name: String(id) },
});

async function refusal(work: Promise<unknown>): Promise<ConnectorError> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(ConnectorError);
  return error as ConnectorError;
}

async function everyRow(
  ctx: ConnectorContext,
  select: ReturnType<typeof sheet>,
  columns: string[],
  keyColumns: string[],
  options: SheetsConnectorOptions = {},
): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  for await (const batch of connector(options).read(ctx, select, {
    columns,
    keyColumns,
    types: {},
    batchSize: 4,
  }))
    rows.push(...batch);
  return rows;
}

/** Everything a failure or a result says, which no part of the key or a token may be in. */
function leaks(text: string): string[] {
  const secretParts = [
    PRIVATE_PEM,
    ...PRIVATE_PEM.split('\n').filter((line) => line.length > 20),
    ...issued,
    'ya29.',
  ];
  return secretParts.filter((part) => text.includes(part));
}

// ------------------------------------------------------------------- tests

describe('a service account’s sign-in', () => {
  it('signs an assertion Google can check, for reading spreadsheets only', () => {
    const key = readServiceAccountKey(KEY_JSON)!;
    expect(key.clientEmail).toBe(EMAIL);
    const assertion = serviceAccountAssertion(
      key,
      SHEETS_READ_SCOPE,
      'https://oauth2.googleapis.com/token',
      1_000,
    );
    const header = JSON.parse(Buffer.from(assertion.split('.')[0]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'key-id-0123456789' });
    expect(checkAssertion(assertion, pair.publicKey)).toEqual({
      iss: EMAIL,
      scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000,
      exp: 4_600,
    });
  });

  it('reads only a service account’s RSA key', () => {
    expect(readServiceAccountKey('{}')).toBeNull();
    expect(
      readServiceAccountKey(
        JSON.stringify({
          ...JSON.parse(KEY_JSON),
          private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----',
        }),
      ),
    ).toBeNull();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    expect(readServiceAccountKey(JSON.stringify({ ...JSON.parse(KEY_JSON), private_key: ec }))).toBeNull();
  });
});

describe('reading a sheet’s cells and header', () => {
  it('names columns the way file sources do, keeping the row number’s name for itself', () => {
    expect(sheetColumnNames(['Name', '', 'Name', ' Row  Number ', 7], 6)).toEqual([
      'Name',
      'column1',
      'Name_1',
      'Row Number_1',
      '7',
      'column5',
    ]);
  });

  it('reads error values as errors, and keeps numbers and checkboxes typed', () => {
    expect(sheetCell('#DIV/0!')).toEqual({ error: '#DIV/0!' });
    expect(sheetCell('#hashtag')).toBe('#hashtag');
    expect(sheetCell(3.5)).toBe(3.5);
    expect(sheetCell(false)).toBe(false);
    expect(sheetCell('')).toBeNull();
  });
});

describe('testing a Google Sheets source', () => {
  it('climbs from finding Google to reading the first rows', async () => {
    const result = await connector().test(context([ORDERS]));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(result.steps.map((step) => [step.step, step.status])).toEqual([
      ['resolve', 'ok'],
      ['connect', 'ok'],
      ['tls', 'skipped'],
      ['authenticate', 'ok'],
      ['sheets', 'ok'],
      ['rows', 'ok'],
    ]);
  });

  it('says what usually fixes each failure, and never repeats the key or a token', async () => {
    const failed = async (ctx: ConnectorContext) => {
      const result = await connector().test(ctx);
      expect(result.ok).toBe(false);
      expect(leaks(JSON.stringify(result))).toEqual([]);
      const last = result.steps.at(-1)!;
      return [last.step, last.messageKey];
    };
    expect(
      await failed(context([ORDERS], {}, { serviceAccountJson: JSON.stringify(serviceAccount({})) })),
    ).toEqual(['authenticate', 'sources.google.key']);
    expect(await failed(context([ORDERS], {}, { serviceAccountJson: STRANGER_JSON }))).toEqual([
      'authenticate',
      'sources.google.keyRefused',
    ]);
    expect(await failed(context([ORDERS, HIDDEN]))).toEqual(['sheets', 'sources.google.notShared']);
    expect(await failed(context([MISSING]))).toEqual(['sheets', 'sources.google.notFound']);
    expect(await failed(context([EXCEL]))).toEqual(['sheets', 'sources.google.notSheets']);
    apiDisabled = true;
    expect(await failed(context([ORDERS]))).toEqual(['sheets', 'sources.google.apiDisabled']);
    apiDisabled = false;
    expect(await failed(context([ORDERS], { headerRow: 40 }))).toEqual([
      'rows',
      'sources.google.headerEmpty',
    ]);
  });
});

describe('what a Google Sheets source offers', () => {
  it('lists each spreadsheet’s sheets of cells by ID, with the names people know them by', async () => {
    const objects = await connector().listObjects(context());
    expect(objects).toEqual([
      {
        schema: ORDERS,
        schemaLabel: 'Garden orders',
        name: '0',
        label: 'Orders',
        type: 'sheet',
        rowEstimate: null,
      },
      {
        schema: ORDERS,
        schemaLabel: 'Garden orders',
        name: '77',
        label: 'Notes ’n’ things',
        type: 'sheet',
        rowEstimate: null,
      },
      {
        schema: ORDERS,
        schemaLabel: 'Garden orders',
        name: '5',
        label: 'Empty',
        type: 'sheet',
        rowEstimate: null,
      },
    ]);
    const hidden = await refusal(connector().listObjects(context([ORDERS, HIDDEN])));
    expect(hidden.messageKey).toBe('sources.google.notShared');
  });

  it('types columns by file sources’ rules, adds row numbers last, and skips blank rows', async () => {
    const preview = await connector().preview(context(), sheet(0), 3);
    expect(preview.columns.map((column) => [column.name, column.suggested?.type, column.role])).toEqual([
      ['Order', 'text', undefined],
      ['Customer', 'text', undefined],
      ['Total', 'number', undefined],
      ['Placed', 'date', undefined],
      ['Paid', 'checkbox', undefined],
      ['Email', 'email', undefined],
      ['Region', 'text', undefined],
      [ROW_NUMBER, 'number', 'rowNumber'],
    ]);
    expect(preview.rows).toEqual([
      ['A-1', 'Customer 1', 2.5, '2026-09-02', false, 'buyer1@example.com', 'South', 2],
      ['A-2', 'Customer 2', 5, '2026-09-03', true, 'buyer2@example.com', 'South', 3],
      ['A-3', 'Customer 3', 7.5, '2026-09-04', false, 'buyer3@example.com', 'North', 4],
    ]);
    // Thirteen records, since the blank row between them isn't one.
    expect(preview.rowEstimate).toBe(13);
  });

  it('reads a header further down, and names blank and repeated headers', async () => {
    const preview = await connector().preview(context([ORDERS], { headerRow: 3 }), sheet(77), 5);
    expect(preview.columns.map((column) => column.name)).toEqual([
      'Name',
      'column1',
      'Name_1',
      'Row number_1',
      ROW_NUMBER,
    ]);
    expect(preview.rows).toEqual([
      ['Ada', 'first', 'Lovelace', 'one', 4],
      ['Grace', 'second', 'Hopper', 'two', 5],
    ]);
  });

  it('says so when the header row is empty', async () => {
    const empty = await refusal(connector().preview(context(), sheet(5), 5));
    expect(empty).toMatchObject({
      messageKey: 'sources.google.headerEmpty',
      detail: 'Empty has nothing in row 1',
    });
  });

  it('offers columns whose values are all there and all different, then row numbers', async () => {
    const keys = await connector().keyCandidates(context(), sheet(0).object);
    expect(keys).toEqual([['Order'], ['Customer'], [ROW_NUMBER]]);
  });

  it('refuses queries and sheets it doesn’t know', async () => {
    expect(
      (await refusal(connector().preview(context(), { kind: 'query', sql: 'SELECT 1' }, 5))).messageKey,
    ).toBe('sources.google.noQueries');
    expect((await refusal(connector().preview(context(), sheet(1234), 5))).messageKey).toBe(
      'sources.sync.objectMissing',
    );
    // A spreadsheet the source doesn't list is refused before anything asks Google about it.
    const before = seen.length;
    expect((await refusal(connector().preview(context(), sheet(0, HIDDEN), 5))).messageKey).toBe(
      'sources.sync.objectMissing',
    );
    expect(seen.slice(before).filter((entry) => entry.path !== '/token')).toEqual([]);
  });
});

describe('reading a sheet for a sync', () => {
  it('reads every row a request at a time, by column name, keyed as asked', async () => {
    const found = sheets.get(ORDERS)!.sheets[0]!;
    found.values = [found.values[0]!, ...orderRows(250)];
    const before = seen.length;
    const rows = await everyRow(context(), sheet(0), ['Total', 'Order', ROW_NUMBER], ['Order'], {
      // 26 columns, so each request asks for 100 rows.
      cellsPerRequest: 2_600,
    });
    expect(rows).toHaveLength(250);
    expect(rows[0]).toEqual({ key: '["A-1"]', values: { Total: 2.5, Order: 'A-1', [ROW_NUMBER]: 2 } });
    expect(rows.at(-1)).toEqual({
      key: '["A-250"]',
      values: { Total: 625, Order: 'A-250', [ROW_NUMBER]: 251 },
    });
    const ranges = seen
      .slice(before)
      .filter((entry) => entry.path.includes('/values/'))
      .map((entry) => decodeURIComponent(entry.path.split('/values/')[1]!));
    expect(ranges).toEqual([
      "'Orders'!1:101",
      "'Orders'!102:201",
      "'Orders'!202:301",
      "'Orders'!302:401",
      // The rest of the grid is read too, since a sheet can have records after a long gap.
      ...Array.from(
        { length: 6 },
        (_unused, index) => `'Orders'!${402 + index * 100}:${Math.min(1_000, 501 + index * 100)}`,
      ),
    ]);
  });

  it('follows a sheet that was renamed, and fails when a column it reads is gone', async () => {
    const found = sheets.get(ORDERS)!.sheets[0]!;
    found.title = 'Orders (2026)';
    const rows = await everyRow(context(), sheet(0), ['Customer'], [ROW_NUMBER]);
    expect(rows[0]).toEqual({ key: '[2]', values: { Customer: 'Customer 1' } });
    found.values[0] = ['Order', 'Client'];
    const gone = await refusal(everyRow(context(), sheet(0), ['Customer'], ['Order']));
    expect(gone).toMatchObject({ messageKey: 'sources.sync.columnMissing', params: { column: 'Customer' } });
  });

  it('reads values as the field types the table chose', async () => {
    const rows: SourceRow[] = [];
    for await (const batch of connector().read(context(), sheet(0), {
      columns: ['Total', 'Placed', 'Paid'],
      keyColumns: ['Order'],
      types: { Total: 'text', Placed: 'text', Paid: 'longText' },
    }))
      rows.push(...batch);
    expect(rows[0]!.values).toEqual({ Total: '2.5', Placed: '9/2/2026', Paid: 'FALSE' });
    // An error value arrives empty, as it does from a workbook.
    expect(rows.at(-1)!.values).toEqual({ Total: null, Placed: null, Paid: null });
  });
});

describe('manners with Google', () => {
  it('waits out a request to slow down, keeps its token, and asks for a new one once refused', async () => {
    // Tokens from earlier tests are refused from here on, so the first call asks for a new one.
    issued.clear();
    const api = connector();
    await api.listObjects(context());
    expect(tokenRequests).toBe(1);
    throttles = 2;
    retryAfter = '1';
    const started = Date.now();
    await api.listObjects(context());
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    // The token from the first call is still good, so no new one was asked for.
    expect(tokenRequests).toBe(1);
    issued.clear();
    await api.listObjects(context());
    expect(tokenRequests).toBe(2);
  });

  it('gives up when Google keeps asking, and says so', async () => {
    throttles = 10;
    retryAfter = '120';
    const busy = await refusal(connector({ maxRetryWaitMs: 60_000 }).listObjects(context()));
    expect(busy.messageKey).toBe('sources.google.rateLimited');
    expect(busy.detail).toContain('asked to wait 120 seconds');
  });

  it('keeps to its pace for each service account', async () => {
    const api = connector({ requestsPerSecond: 5 });
    const before = seen.length;
    await api.listObjects(context());
    await api.listObjects(context());
    await api.listObjects(context());
    const reads = seen.slice(before).filter((entry) => entry.path !== '/token');
    expect(reads).toHaveLength(3);
    expect(reads.at(-1)!.at - reads[0]!.at).toBeGreaterThanOrEqual(350);
  });
});

it('runs every declared Sheets contract against its grid fixture', async () => {
  const boundary = new FixtureBoundary();
  const api = connector(
    boundary.wrap({ network: plainNetwork, sockets: { connect: async () => {}, handshake: async () => {} } }),
  );
  await strictFixture(api, context(), sheet(0), [ROW_NUMBER], 13, boundary);
});
