import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * Druid against a stand-in for `fetch` that answers the way a router does: SQL answers as
 * `arrayLines` with three header lines (names, Druid types, and SQL types) and a blank line after
 * the last row, and failures as Druid's JSON errors.  The live suite is `druid.live.test.ts`.
 */
import type { SourceConnection, SourceSelect } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { ConnectorContext, SourceRow } from '../types.js';
import {
  createDruidConnector,
  druidColumn,
  druidConnector,
  druidEndpoint,
  druidMissing,
  druidProjection,
  druidTypeClass,
  plainOfDruid,
  type DruidConnectorOptions,
  type DruidFetch,
} from './druid.js';
import type { Network } from './frame.js';

interface Request {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: {
    query: string;
    parameters: Array<{ type: string; value: string }>;
    context: { sqlQueryId: string; sqlTimeZone: string; timeout: number };
    resultFormat: string;
    header: boolean;
  };
}

type Reply = Response | Error;

/** An answer in `arrayLines`, whole unless it's cut short. */
function lines(names: string[], sqlTypes: string[], rows: unknown[][], whole = true): Response {
  const text = [names, names.map(() => 'STRING'), sqlTypes, ...rows]
    .map((row) => JSON.stringify(row))
    .join('\n');
  return new Response(`${text}\n${whole ? '\n' : ''}`, { status: 200 });
}

function failed(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function fakeDruid(answer: (request: Request) => Reply | undefined = () => undefined) {
  const log: Request[] = [];
  const fetcher: DruidFetch = async (url, init) => {
    const request: Request = {
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as Request['body'] } : {}),
    };
    log.push(request);
    const reply = answer(request) ?? defaults(request);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetcher, log };
}

function defaults(request: Request): Response {
  if (request.url.endsWith('/status'))
    return new Response(JSON.stringify({ version: '34.0.0' }), { status: 200 });
  const query = request.body?.query ?? '';
  if (/signed_in/.test(query)) return lines(['signed_in'], ['INTEGER'], [[1]]);
  if (/AS "visible"/.test(query)) return lines(['visible'], ['VARCHAR'], [['orders']]);
  if (/sys\.segments/.test(query))
    return lines(
      ['datasource', 'rows'],
      ['VARCHAR', 'BIGINT'],
      [
        ['wikipedia', 24433],
        ['orders', 13],
      ],
    );
  return lines([], [], []);
}

function network(): Network & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    proxied: () => false,
    resolve: async (host) => {
      calls.push(`resolve ${host}`);
    },
    connect: async (endpoint) => {
      calls.push(`connect ${endpoint.host}:${endpoint.port}`);
    },
    handshake: async (endpoint) => {
      calls.push(`handshake ${endpoint.host}:${endpoint.port}`);
    },
  };
}

type DruidSettings = Extract<SourceConnection, { kind: 'druid' }>;
const SETTINGS: DruidSettings = {
  kind: 'druid',
  host: 'druid.example.com',
  port: 9088,
  user: 'reader',
  secure: true,
};
// Built from parts, so the stand-in never reads as a stored secret.
const PASSWORD = ['stand', 'in', 'password', '8'].join('-');

function contextFor(
  connection: Partial<DruidSettings> = {},
  rest: Partial<ConnectorContext> = {},
): ConnectorContext {
  return {
    connection: { ...SETTINGS, ...connection },
    secrets: { password: PASSWORD },
    timeoutMs: 2_000,
    ...rest,
  };
}

const connector = (
  fake: ReturnType<typeof fakeDruid>,
  pageRows?: number,
  checks: Network = network(),
  more: DruidConnectorOptions = {},
) =>
  createDruidConnector({ fetch: fake.fetcher, network: checks, ...(pageRows ? { pageRows } : {}), ...more });

const ORDERS: SourceSelect = { kind: 'object', object: { schema: null, name: 'orders' } };

/** Answers the catalog about `orders`, and its rows for `read`. */
function ordersAnswer(read: (request: Request) => Reply | undefined) {
  return (request: Request): Reply | undefined => {
    if (request.body?.query.includes('INFORMATION_SCHEMA.COLUMNS'))
      return lines(
        ['COLUMN_NAME', 'DATA_TYPE', 'IS_NULLABLE'],
        ['VARCHAR', 'VARCHAR', 'VARCHAR'],
        [
          ['__time', 'TIMESTAMP', 'NO'],
          ['id', 'BIGINT', 'YES'],
          ['label', 'VARCHAR', 'YES'],
          ['tags', 'ARRAY', 'YES'],
        ],
      );
    return read(request);
  };
}

/**
 * `orders` as a cluster with several segments may serve it: five rows share one `__time`, and
 * every request turns those ties a different way, since Druid promises no order among them.  It
 * answers the old way of paging too (a finer order Druid refuses, then `OFFSET`), and every
 * answer ends with the row's time in milliseconds, whether or not the read asked for it.
 */
function shufflingOrders() {
  const rows = [
    ...[1, 2, 3, 4, 5].map((id) => ({ time: '2026-02-03T04:05:06.789Z', id })),
    { time: '2026-02-04T00:00:00.000Z', id: 6 },
    { time: '2026-02-05T00:00:00.000Z', id: 7 },
  ];
  let requests = 0;
  return (request: Request): Reply | undefined => {
    const query = request.body?.query ?? '';
    if (!query.includes('FROM "druid"."orders"')) return undefined;
    if (/ORDER BY "__time", /.test(query))
      return failed(400, {
        errorMessage:
          'Query could not be planned. A possible reason is [SQL query requires ordering a table by non-time column [[__time, label, id]], which is not supported.]',
      });
    requests += 1;
    const after = /"__time" > MILLIS_TO_TIMESTAMP\((-?\d+)\)/.exec(query)?.[1];
    const at = /"__time" = MILLIS_TO_TIMESTAMP\((-?\d+)\)/.exec(query)?.[1];
    const found = rows.filter(
      (row) =>
        (after === undefined || Date.parse(row.time) > Number(after)) &&
        (at === undefined || Date.parse(row.time) === Number(at)),
    );
    const byTime = new Map<string, typeof rows>();
    for (const row of found) byTime.set(row.time, [...(byTime.get(row.time) ?? []), row]);
    const ordered = [...byTime.keys()].sort().flatMap((time) => {
      const ties = byTime.get(time)!;
      const turn = requests % ties.length;
      return [...ties.slice(turn), ...ties.slice(0, turn)];
    });
    const limit = Number(/LIMIT (\d+)/.exec(query)?.[1] ?? ordered.length);
    const offset = Number(/OFFSET (\d+)/.exec(query)?.[1] ?? 0);
    return lines(
      ['label', 'EXPR$1', 'EXPR$2'],
      ['VARCHAR', 'VARCHAR', 'BIGINT'],
      ordered
        .slice(offset, offset + limit)
        .map((row) => [`row ${row.id}`, String(row.id), Date.parse(row.time)]),
    );
  };
}

describe('druid type mapping', () => {
  it.each([
    ['TIMESTAMP', 'timestamp'],
    ['DATE', 'date'],
    ['VARCHAR', 'text'],
    ['CHAR', 'text'],
    ['BIGINT', 'integer'],
    ['INTEGER', 'integer'],
    ['SMALLINT', 'integer'],
    ['TINYINT', 'integer'],
    ['DOUBLE', 'float'],
    ['FLOAT', 'float'],
    ['REAL', 'float'],
    ['DECIMAL', 'float'],
    ['BOOLEAN', 'boolean'],
    ['ARRAY', 'json'],
    ['VARCHAR ARRAY', 'json'],
    ['ARRAY<BIGINT>', 'json'],
    ['COMPLEX<json>', 'json'],
    ['COMPLEX<hyperUnique>', 'unknown'],
    ['OTHER', 'unknown'],
  ])('reads %s as %s', (type, kind) => {
    expect(druidTypeClass(type)).toBe(kind);
  });

  it('suggests a date and time for __time, and exact digits for a BIGINT', () => {
    expect(druidColumn('__time', 'TIMESTAMP', false).column).toMatchObject({
      nullable: false,
      suggested: { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
    });
    expect(druidColumn('n', 'BIGINT', true).column.suggested).toEqual({
      type: 'number',
      options: { precision: 0 },
    });
    expect(druidColumn('x', 'COMPLEX<thetaSketch>', true).column.suggested).toBeNull();
    const projected = (type: string) => druidProjection(druidColumn('c', type, true), '"c"');
    expect(projected('BIGINT')).toBe('CAST("c" AS VARCHAR)');
    for (const type of ['TIMESTAMP', 'DOUBLE', 'VARCHAR', 'ARRAY']) expect(projected(type)).toBe('"c"');
    expect(plainOfDruid('9007199254740993', druidColumn('n', 'BIGINT', true))).toBe('9007199254740993');
    expect(plainOfDruid('42', druidColumn('n', 'BIGINT', true))).toBe(42);
  });

  it('says which datasource or column is missing from Druid’s own words', () => {
    expect(
      druidMissing("Druid answered 400 Bad Request: Object 'gone' not found (line [1], column [15])"),
    ).toEqual({
      kind: 'object',
    });
    expect(
      druidMissing("Druid answered 400: Column 'nope' not found in any table (line [1], column [8])"),
    ).toEqual({
      kind: 'column',
      column: 'nope',
    });
    expect(druidMissing('Druid answered 403 Forbidden: Unauthorized')).toBeNull();
  });
});

describe('druid connections', () => {
  it('climbs every step with basic auth, and names the version', async () => {
    const fake = fakeDruid();
    const checks = network();
    const result = await connector(fake, undefined, checks).test(contextFor());
    expect(result).toMatchObject({ ok: true, serverVersion: 'Apache Druid 34.0.0' });
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(checks.calls).toEqual([
      'resolve druid.example.com',
      'connect druid.example.com:9088',
      'handshake druid.example.com:9088',
    ]);
    const first = fake.log[0]!;
    expect(first.url).toBe('https://druid.example.com:9088/druid/v2/sql');
    expect(first.headers.authorization).toBe(`Basic ${Buffer.from(`reader:${PASSWORD}`).toString('base64')}`);
    expect(first.body).toMatchObject({
      resultFormat: 'arrayLines',
      header: true,
      parameters: [],
      context: { sqlTimeZone: 'Etc/UTC', timeout: 2_000 },
    });
  });

  it('signs nobody in without a user, and skips TLS on a plain connection', async () => {
    const fake = fakeDruid();
    const result = await connector(fake).test(
      contextFor({ user: undefined, secure: false, port: 8888 }, { secrets: {} }),
    );
    expect(result.steps.map((step) => [step.step, step.status])).toContainEqual(['tls', 'skipped']);
    expect(fake.log[0]?.url).toBe('http://druid.example.com:8888/druid/v2/sql');
    expect(fake.log.every((request) => !('authorization' in request.headers))).toBe(true);
  });

  it('reports a refused sign-in at authentication, without the password', async () => {
    const fake = fakeDruid(() =>
      failed(401, { error: 'Unauthorized request', errorMessage: null, errorClass: null, host: 'router' }),
    );
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({
      step: 'authenticate',
      messageKey: 'sources.test.authenticate',
      detail: 'Druid answered 401: Unauthorized request',
    });
  });

  it('says a user who may not run SQL at the query step, since the sign-in worked', async () => {
    const fake = fakeDruid((request) =>
      request.body ? failed(403, { 'Access-Check-Result': 'Unauthorized' }) : undefined,
    );
    const result = await connector(fake).test(contextFor());
    expect(result.steps.map((step) => [step.step, step.status]).slice(-2)).toEqual([
      ['authenticate', 'ok'],
      ['query', 'failed'],
    ]);
    expect(result.steps.at(-1)).toMatchObject({ messageKey: 'sources.test.query' });
    expect(result.steps.at(-1)?.detail).toMatch(
      /permissions don't let it run SQL queries \(Druid answered 403/,
    );
  });

  it.each([
    [
      'resolve',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND druid'), { code: 'ENOTFOUND' }),
      }),
    ],
    [
      'connect',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      }),
    ],
    [
      'tls',
      new TypeError('fetch failed', {
        cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      }),
    ],
  ])('reports a transport failure at %s', async (step, error) => {
    const result = await connector(fakeDruid(() => error)).test(contextFor());
    expect(result.steps.at(-1)).toMatchObject({ step, status: 'failed', messageKey: `sources.test.${step}` });
  });

  it('passes a cluster with no datasources yet, with a note that says so', async () => {
    const fake = fakeDruid((request) =>
      // A new cluster has nothing ingested, so Druid lists nothing.
      /AS "visible"/.test(request.body?.query ?? '') ? lines(['visible'], ['VARCHAR'], []) : undefined,
    );
    const result = await connector(fake).test(contextFor());
    expect(result).toMatchObject({ ok: true, serverVersion: 'Apache Druid 34.0.0' });
    expect(result.steps.at(-1)).toMatchObject({
      step: 'query',
      status: 'ok',
      messageKey: 'sources.test.noDatasources',
    });
  });

  it('leaves a proxy’s error page out of the words it shows', async () => {
    const fake = fakeDruid(() => failed(502, '<html><body>Bad gateway</body></html>'));
    const result = await connector(fake).test(contextFor());
    expect(result.steps.at(-1)?.detail).toBe('Druid answered 502');
  });

  it('keeps no more than 200 characters of an error’s body, as plain text', async () => {
    const said = `service\u0007 says\n\n${'x'.repeat(2_000)}`;
    const plain = fakeDruid(() => failed(500, said));
    const detail = (await connector(plain).test(contextFor())).steps.at(-1)?.detail ?? '';
    expect(detail.startsWith('Druid answered 500: service says x')).toBe(true);
    expect(detail.length).toBeLessThanOrEqual('Druid answered 500: '.length + 200);
    const json = fakeDruid(() => failed(500, { errorMessage: `broken ${'y'.repeat(2_000)}` }));
    const jsonDetail = (await connector(json).test(contextFor())).steps.at(-1)?.detail ?? '';
    expect(jsonDetail.length).toBeLessThanOrEqual('Druid answered 500: '.length + 200);
  });

  it('asks for the password when a user is set, before anything connects', async () => {
    const fake = fakeDruid();
    const result = await connector(fake).test(contextFor({}, { secrets: {} }));
    expect(result.steps.at(-1)).toMatchObject({ messageKey: 'sources.secretsMissing' });
    expect(fake.log).toEqual([]);
  });

  it('takes the router from a pasted address', () => {
    expect(
      druidEndpoint({ ...SETTINGS, host: 'https://druid.example.com:9443/unified-console.html' }),
    ).toEqual({
      host: 'druid.example.com',
      port: 9443,
      tls: {},
    });
  });
});

describe('druid catalog and reads', () => {
  it('lists datasources as tables, with the rows their segments count', async () => {
    const fake = fakeDruid((request) =>
      request.body?.query.includes('INFORMATION_SCHEMA.TABLES')
        ? lines(['TABLE_NAME'], ['VARCHAR'], [['orders'], ['wikipedia'], ['empty']])
        : undefined,
    );
    expect(await connector(fake).listObjects(contextFor())).toEqual([
      { schema: null, name: 'orders', type: 'table', rowEstimate: 13 },
      { schema: null, name: 'wikipedia', type: 'table', rowEstimate: 24_433 },
      { schema: null, name: 'empty', type: 'table', rowEstimate: null },
    ]);
  });

  it('lists without counts when the system tables are off limits', async () => {
    const fake = fakeDruid((request) => {
      if (request.body?.query.includes('sys.segments')) return failed(403, { error: 'Unauthorized' });
      if (request.body?.query.includes('INFORMATION_SCHEMA.TABLES'))
        return lines(['TABLE_NAME'], ['VARCHAR'], [['orders']]);
      return undefined;
    });
    expect(await connector(fake).listObjects(contextFor())).toEqual([
      { schema: null, name: 'orders', type: 'table', rowEstimate: null },
    ]);
  });

  it('describes a datasource with the name as a parameter, and a query by running it for no rows', async () => {
    const fake = fakeDruid(
      ordersAnswer((request) =>
        request.body?.query.includes('LIMIT 0')
          ? lines(['label', 'rows'], ['VARCHAR', 'BIGINT'], [])
          : undefined,
      ),
    );
    const columns = await connector(fake).describe(contextFor(), ORDERS);
    expect(columns.map((column) => [column.name, column.nullable, column.suggested?.type])).toEqual([
      ['__time', false, 'date'],
      ['id', true, 'number'],
      ['label', true, 'text'],
      ['tags', true, 'longText'],
    ]);
    expect(fake.log.at(-1)?.body?.parameters).toEqual([{ type: 'VARCHAR', value: 'orders' }]);
    const queried = await connector(fake).describe(contextFor(), {
      kind: 'query',
      sql: 'SELECT label, COUNT(*) AS rows FROM orders GROUP BY label;',
    });
    expect(queried.map((column) => [column.name, column.suggested?.type])).toEqual([
      ['label', 'text'],
      ['rows', 'number'],
    ]);
    expect(fake.log.at(-1)?.body?.query).toBe(
      'SELECT * FROM (\nSELECT label, COUNT(*) AS rows FROM orders GROUP BY label\n) AS q LIMIT 0',
    );
  });

  it('turns a missing datasource into the sync’s own message, and offers no key', async () => {
    const fake = fakeDruid((request) =>
      request.body?.query.includes('INFORMATION_SCHEMA') ? lines(['TABLE_NAME'], ['VARCHAR'], []) : undefined,
    );
    await expect(connector(fake).describe(contextFor(), ORDERS)).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
      params: { object: 'orders' },
    });
    await expect(
      connector(fake).keyCandidates(contextFor(), { schema: null, name: 'orders' }),
    ).rejects.toMatchObject({
      messageKey: 'sources.sync.objectMissing',
    });
    const found = fakeDruid((request) =>
      request.body?.query.includes('INFORMATION_SCHEMA')
        ? lines(['TABLE_NAME'], ['VARCHAR'], [['orders']])
        : undefined,
    );
    expect(await connector(found).keyCandidates(contextFor(), { schema: null, name: 'orders' })).toEqual([]);
  });

  it('pages after each __time, reading every row at a page’s last __time in one request', async () => {
    const fake = fakeDruid(
      ordersAnswer((request) => {
        const query = request.body?.query ?? '';
        if (!query.includes('TIMESTAMP_TO_MILLIS')) return undefined;
        // In the order the read asks for them: the chosen columns, the key, then the page's time.
        const header = [
          ['__time', 'label', 'EXPR$2', 'EXPR$3'],
          ['TIMESTAMP', 'VARCHAR', 'VARCHAR', 'BIGINT'],
        ];
        const at = (time: string, label: string, id: string) => [time, label, id, Date.parse(time)];
        if (query.includes('"__time" = MILLIS_TO_TIMESTAMP(1770091506789)'))
          return lines(header[0]!, header[1]!, [
            at('2026-02-03T04:05:06.789Z', 'a', '9007199254740993'),
            at('2026-02-03T04:05:06.789Z', 'b', '2'),
            at('2026-02-03T04:05:06.789Z', 'c', '3'),
          ]);
        if (query.includes('"__time" > MILLIS_TO_TIMESTAMP(1770091506789)'))
          return lines(header[0]!, header[1]!, [at('2026-02-04T00:00:00.000Z', 'd', '4')]);
        return lines(header[0]!, header[1]!, [
          at('2026-02-01T00:00:00.000Z', 'z', '0'),
          at('2026-02-03T04:05:06.789Z', 'b', '2'),
        ]);
      }),
    );
    const batches: SourceRow[][] = [];
    for await (const batch of connector(fake, 2).read(contextFor(), ORDERS, {
      columns: ['__time', 'label'],
      types: { __time: 'date', label: 'text' },
      keyColumns: ['id'],
    }))
      batches.push(batch);
    expect(batches.flat().map((row) => [row.key, row.values.label])).toEqual([
      ['[0]', 'z'],
      ['["9007199254740993"]', 'a'],
      ['[2]', 'b'],
      ['[3]', 'c'],
      ['[4]', 'd'],
    ]);
    const select =
      'SELECT "__time", "label", CAST("id" AS VARCHAR), TIMESTAMP_TO_MILLIS("__time") FROM "druid"."orders"';
    expect(
      fake.log
        .map((request) => request.body?.query ?? '')
        .filter((query) => query.includes('TIMESTAMP_TO_MILLIS')),
    ).toEqual([
      `${select} ORDER BY "__time" LIMIT 2`,
      `${select} WHERE "__time" = MILLIS_TO_TIMESTAMP(1770091506789) LIMIT 1000001`,
      `${select} WHERE "__time" > MILLIS_TO_TIMESTAMP(1770091506789) ORDER BY "__time" LIMIT 2`,
    ]);
  });

  it('reads every row once when rows at one __time come back in a different order each time', async () => {
    const fake = fakeDruid(ordersAnswer(shufflingOrders()));
    const rows: SourceRow[] = [];
    for await (const batch of connector(fake, 2).read(contextFor(), ORDERS, {
      columns: ['label'],
      types: { label: 'text' },
      keyColumns: ['id'],
    }))
      rows.push(...batch);
    expect(rows.map((row) => row.key).sort()).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]', '[6]', '[7]']);
  });

  it('stops with a plain error when more rows share one __time than a read takes at once', async () => {
    const fake = fakeDruid(ordersAnswer(shufflingOrders()));
    const read = async () => {
      for await (const batch of connector(fake, 2, network(), { tieRows: 3 }).read(contextFor(), ORDERS, {
        columns: ['label'],
        types: { label: 'text' },
        keyColumns: ['id'],
      }))
        void batch;
    };
    await expect(read()).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail:
        'Druid holds more than 3 rows at the one __time 2026-02-03T04:05:06.789Z, more than a read takes at once, so it stopped',
    });
  });

  it('pages a query by its own __time, and reads one it can’t sort in a single request', async () => {
    const fake = fakeDruid((request) => {
      const query = request.body?.query ?? '';
      if (query.includes('LIMIT 0')) return lines(['__time', 'label'], ['TIMESTAMP', 'VARCHAR'], []);
      if (query.includes('ORDER BY'))
        return failed(400, {
          errorMessage: 'Query could not be planned: ordering by a non-time column is not supported',
        });
      if (query.startsWith('SELECT "label" FROM (')) return lines(['label'], ['VARCHAR'], [['a'], ['b']]);
      return undefined;
    });
    const rows: SourceRow[] = [];
    for await (const batch of connector(fake, 2).read(
      contextFor(),
      { kind: 'query', sql: 'SELECT __time, label FROM orders GROUP BY 1, 2' },
      { columns: ['label'], types: { label: 'text' }, keyColumns: ['label'] },
    ))
      rows.push(...batch);
    expect(rows.map((row) => row.key)).toEqual(['["a"]', '["b"]']);
    expect(fake.log.map((request) => request.body?.query).slice(-2)).toEqual([
      'SELECT "label", TIMESTAMP_TO_MILLIS("__time") FROM (\nSELECT __time, label FROM orders GROUP BY 1, 2\n) AS q ORDER BY "__time" LIMIT 2',
      'SELECT "label" FROM (\nSELECT __time, label FROM orders GROUP BY 1, 2\n) AS q',
    ]);
  });

  it('reads a query it can’t sort in one request', async () => {
    const fake = fakeDruid((request) => {
      const query = request.body?.query ?? '';
      if (query.includes('LIMIT 0')) return lines(['label'], ['VARCHAR'], []);
      if (query.includes('ORDER BY'))
        return failed(400, {
          errorMessage: 'Query could not be planned: ordering by a non-time column is not supported',
        });
      if (query.startsWith('SELECT "label" FROM (')) return lines(['label'], ['VARCHAR'], [['a'], ['b']]);
      return undefined;
    });
    const rows: SourceRow[] = [];
    for await (const batch of connector(fake, 2).read(
      contextFor(),
      { kind: 'query', sql: 'SELECT label FROM orders' },
      { columns: ['label'], types: { label: 'text' }, keyColumns: ['label'] },
    ))
      rows.push(...batch);
    expect(rows.map((row) => row.key)).toEqual(['["a"]', '["b"]']);
    expect(fake.log.at(-1)?.body?.query).toBe('SELECT "label" FROM (\nSELECT label FROM orders\n) AS q');
  });

  it('fails a read whose answer ends before its blank line, and cancels it', async () => {
    const fake = fakeDruid(
      ordersAnswer((request) =>
        request.body?.query.includes('ORDER BY "__time"')
          ? lines(
              ['label', 'EXPR$1', 'EXPR$2'],
              ['VARCHAR', 'VARCHAR', 'BIGINT'],
              [['a', '1', 1770091506000]],
              false,
            )
          : undefined,
      ),
    );
    const read = async () => {
      for await (const batch of connector(fake).read(contextFor(), ORDERS, {
        columns: ['label'],
        types: { label: 'text' },
        keyColumns: ['id'],
      }))
        void batch;
    };
    await expect(read()).rejects.toMatchObject({
      messageKey: 'sources.sync.read',
      detail: "Druid's answer ended before its last row, so the query failed partway",
    });
  });

  it('asks Druid to cancel a query still running when the call gives up', async () => {
    let release: () => void = () => undefined;
    const fake = fakeDruid(
      ordersAnswer((request) => {
        if (request.method === 'DELETE') return new Response(null, { status: 202 });
        if (!request.body?.query.includes('ORDER BY "__time"')) return undefined;
        const header = [
          ['label', 'EXPR$1', 'EXPR$2'],
          ['STRING', 'STRING', 'LONG'],
          ['VARCHAR', 'VARCHAR', 'BIGINT'],
        ];
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(`${header.map((row) => JSON.stringify(row)).join('\n')}\n`),
            );
            // A row shows it's the last at its time once a later one arrives.
            controller.enqueue(
              new TextEncoder().encode('["a","1",1770091506000]\n["b","2",1770091507000]\n'),
            );
            release = () => controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const controller = new AbortController();
    const read = connector(fake).read(contextFor({}, { signal: controller.signal }), ORDERS, {
      columns: ['label'],
      types: { label: 'text' },
      keyColumns: ['id'],
      batchSize: 1,
    });
    const iterator = read[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toHaveLength(1);
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ messageKey: 'sources.sync.read' });
    release();
    const cancel = fake.log.find((request) => request.method === 'DELETE');
    const queried = fake.log.find((request) => request.body?.query.includes('ORDER BY "__time"'));
    expect(cancel?.url).toBe(
      `https://druid.example.com:9088/druid/v2/sql/${queried?.body?.context.sqlQueryId}`,
    );
  });

  it('registers itself on import', () => {
    expect(druidConnector.kind).toBe('druid');
  });
});

it('runs every declared contract against the native protocol fixture', async () => {
  const boundary = new FixtureBoundary();
  const fake = fakeDruid(({ body }) => {
    const sql = body?.query ?? '';
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS'))
      return lines(
        ['COLUMN_NAME', 'DATA_TYPE', 'IS_NULLABLE'],
        ['VARCHAR', 'VARCHAR', 'VARCHAR'],
        [
          ['id', 'BIGINT', 'NO'],
          ['__time', 'TIMESTAMP', 'NO'],
        ],
      );
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return lines(['TABLE_NAME'], ['VARCHAR'], [['orders']]);
    if (!sql.includes('"orders"')) return undefined;
    const ids = /"id" = 2/.test(sql) ? ['2'] : /"id" DESC/.test(sql) ? ['3', '2', '1'] : ['1', '2', '3'];
    return sql.includes('TIMESTAMP_TO_MILLIS')
      ? lines(
          ['id', '__time', 'cursor'],
          ['BIGINT', 'TIMESTAMP', 'BIGINT'],
          ids.map((id) => [id, Number(id) * 1000, Number(id) * 1000]),
        )
      : lines(
          ['id', '__time'],
          ['BIGINT', 'TIMESTAMP'],
          ids.map((id) => [id, Number(id) * 1000]),
        );
  });
  await strictFixture(
    createDruidConnector({ fetch: boundary.wrap(fake.fetcher, 'fetch'), network: boundary.wrap(network()) }),
    contextFor(),
    { kind: 'object', object: { schema: null, name: 'orders' } },
    ['id'],
    3,
    boundary,
  );
});
