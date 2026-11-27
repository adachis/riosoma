import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { SourceConnection, type SourceSelect } from '@riosoma/contracts';
import { connectorFor, registerConnector } from '../registry.js';
import { liveKeys, liveRows, closeLivePools, forgetLiveColumns } from '../live/index.js';
import { LivePool } from '../live/pool.js';
import { signAwsRequest } from '../files/s3.js';
import { createAthenaConnector } from './athena.js';
import { createRedshiftConnector, redshiftColumn, redshiftCredentials } from './redshift.js';
import { projection } from '../sql.js';
import { render, sqlf, value } from '../live/fragment.js';
import { translateCondition, translateSort } from '../live/translate.js';
import type { ConnectorContext } from '../types.js';

const secrets = {
  accessKeyId: randomBytes(12).toString('hex'),
  secretAccessKey: randomBytes(24).toString('hex'),
  sessionToken: randomBytes(16).toString('hex'),
};
const connection = SourceConnection.parse({
  kind: 'athena',
  region: 'us-east-1',
  database: 'events',
  workgroup: 'readers',
  resultsLocation: 's3://results/queries/',
  maxScannedBytes: 20_000_000,
});
const ctx = { connection, secrets, timeoutMs: 5_000 };
const select: SourceSelect = { kind: 'object', object: { schema: 'events', name: 'visits' } };
let server: Server;
let endpoint: URL;
let cutoff = 20_000_000;
let scanned = 100;
let state = 'SUCCEEDED';
let headers: Record<string, string | string[] | undefined>;
let calls: Array<{ operation: string; body: Record<string, unknown> }> = [];
let failure = false;
let extraColumns: Array<{ Name: string; Type: string }> = [];
let extraValues: Array<string | null> = [];
let onOperation: ((operation: string) => void) | undefined;
const temporary = randomBytes(20).toString('hex');

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    headers = request.headers;
    const operation = String(request.headers['x-amz-target'] ?? 'GetClusterCredentials')
      .split('.')
      .at(-1)!;
    const body =
      operation === 'GetClusterCredentials'
        ? Object.fromEntries(new URLSearchParams(raw))
        : (JSON.parse(raw) as Record<string, unknown>);
    calls.push({ operation, body });
    onOperation?.(operation);
    if (failure) {
      response.writeHead(403).end(JSON.stringify({ message: secrets.secretAccessKey }));
      return;
    }
    if (operation === 'GetClusterCredentials') {
      response.end(
        `<GetClusterCredentialsResponse><DbUser>IAM:reader</DbUser><DbPassword>${temporary}</DbPassword></GetClusterCredentialsResponse>`,
      );
      return;
    }
    const answer: Record<string, unknown> = {
      GetDataCatalog: { DataCatalog: { Type: 'GLUE', Parameters: { 'catalog-id': '123456789012' } } },
      GetCredentials: { dbUser: 'IAM:reader', dbPassword: temporary },
      GetWorkGroup: { WorkGroup: { Configuration: { BytesScannedCutoffPerQuery: cutoff } } },
      StartQueryExecution: { QueryExecutionId: `query-${calls.length}` },
      GetQueryExecution: {
        QueryExecution: { Status: { State: state }, Statistics: { DataScannedInBytes: scanned } },
      },
      StopQueryExecution: {},
      GetTables: body.NextToken
        ? { TableList: [{ Name: 'daily', TableType: 'VIRTUAL_VIEW' }] }
        : { TableList: [{ Name: 'visits' }], NextToken: 'tables-next' },
      GetTable: {
        Table: {
          Name: 'visits',
          StorageDescriptor: {
            Columns: [{ Name: 'id', Type: 'bigint' }, { Name: 'label', Type: 'string' }, ...extraColumns],
          },
          PartitionKeys: [{ Name: 'day', Type: 'date' }],
        },
      },
      GetQueryResults: {
        ResultSet: {
          ResultSetMetadata: {
            ColumnInfo: [
              { Name: 'id', Type: 'bigint' },
              { Name: 'label', Type: 'varchar' },
              { Name: 'day', Type: 'date' },
              ...extraColumns,
            ],
          },
          Rows: body.NextToken
            ? [
                {
                  Data: [
                    { VarCharValue: '2' },
                    {},
                    { VarCharValue: '2026-01-02' },
                    ...extraColumns.map(() => ({})),
                  ],
                },
              ]
            : [
                { Data: [{ VarCharValue: 'id' }, { VarCharValue: 'label' }, { VarCharValue: 'day' }] },
                {
                  Data: [
                    { VarCharValue: '1' },
                    { VarCharValue: '' },
                    { VarCharValue: '2026-01-01' },
                    ...extraValues.map((value) => (value === null ? {} : { VarCharValue: value })),
                  ],
                },
              ],
        },
        ...(body.NextToken ? {} : { NextToken: 'rows-next' }),
      },
    };
    response.setHeader('content-type', 'application/x-amz-json-1.1');
    response.end(JSON.stringify(answer[operation] ?? {}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  calls = [];
  cutoff = 20_000_000;
  scanned = 100;
  state = 'SUCCEEDED';
  failure = false;
  extraColumns = [];
  extraValues = [];
  onOperation = undefined;
});
const options = { endpoint: () => endpoint, pollMs: 1 };

it('reports no declared Athena keys rather than guessing from sampled values', async () => {
  expect(
    await createAthenaConnector(options).keyCandidates(ctx, { schema: 'events', name: 'visits' }),
  ).toEqual([]);
});

it('matches the published IAM ListUsers Signature Version 4 vector', () => {
  // https://aws.amazon.com/blogs/korea/aws-api-call-1/
  const signed = signAwsRequest({
    method: 'GET',
    url: new URL('https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08'),
    service: 'iam',
    region: 'us-east-1',
    now: new Date('2015-08-30T12:36:00Z'),
    credentials: {
      accessKeyId: ['AKID', 'EXAMPLE'].join(''),
      secretAccessKey: ['wJalrXUtnFEMI', '/K7MDENG', '+bPxRfiCYEXAMPLEKEY'].join(''),
    },
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
  });
  expect(signed.authorization).toContain(
    'Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7',
  );
});

describe('Athena over signed HTTP', () => {
  it('lists Glue pages and keeps partition columns', async () => {
    const connector = createAthenaConnector(options);
    expect(await connector.listObjects(ctx)).toEqual([
      { schema: 'events', name: 'visits', type: 'table', rowEstimate: null },
      { schema: 'events', name: 'daily', type: 'view', rowEstimate: null },
    ]);
    expect((await connector.describe(ctx, select)).map((c) => c.name)).toEqual(['id', 'label', 'day']);
    expect(calls.some((c) => c.operation === 'GetDataCatalog')).toBe(false);
    expect(calls.find((c) => c.operation === 'GetTable')?.body.CatalogId).toBeUndefined();
    expect(headers['x-amz-security-token']).toBe(secrets.sessionToken);
    expect(headers.authorization).toContain('/us-east-1/glue/aws4_request');
  });
  it('treats AwsDataCatalog as Glue without GetDataCatalog and falls back to ListDataCatalogs for other catalogs', async () => {
    const catalogs = new Map<string, { status: number; body: unknown }>([
      [
        'AwsDataCatalog',
        {
          status: 400,
          body: { __type: 'InvalidRequestException', message: 'DataCatalog AwsDataCatalog was not found' },
        },
      ],
      [
        'shared_glue',
        {
          status: 400,
          body: { __type: 'InvalidRequestException', message: 'DataCatalog shared_glue was not found' },
        },
      ],
      [
        'federated_lambda',
        {
          status: 400,
          body: { __type: 'InvalidRequestException', message: 'DataCatalog federated_lambda was not found' },
        },
      ],
      [
        'missing_catalog',
        {
          status: 400,
          body: { __type: 'InvalidRequestException', message: 'DataCatalog missing_catalog was not found' },
        },
      ],
      [
        'custom_glue',
        {
          status: 200,
          body: { DataCatalog: { Type: 'GLUE', Parameters: { 'catalog-id': '123456789012' } } },
        },
      ],
      ['lambda_direct', { status: 200, body: { DataCatalog: { Type: 'LAMBDA' } } }],
    ]);
    const operations: Array<{ operation: string; body: Record<string, unknown> }> = [];
    const fakeClient: typeof fetch = async (_url, init) => {
      const operation = new Headers(init?.headers).get('x-amz-target')!.split('.').at(-1)!;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      operations.push({ operation, body });
      if (operation === 'GetWorkGroup')
        return new Response(
          JSON.stringify({ WorkGroup: { Configuration: { BytesScannedCutoffPerQuery: cutoff } } }),
        );
      if (operation === 'GetDataCatalog') {
        const entry = catalogs.get(String(body.Name))!;
        return new Response(JSON.stringify(entry.body), { status: entry.status });
      }
      if (operation === 'ListDataCatalogs')
        return new Response(
          JSON.stringify(
            body.NextToken
              ? { DataCatalogsSummary: [{ CatalogName: 'shared_glue', Type: 'GLUE' }] }
              : {
                  DataCatalogsSummary: [
                    { CatalogName: 'AwsDataCatalog', Type: 'GLUE' },
                    { CatalogName: 'federated_lambda', Type: 'LAMBDA' },
                  ],
                  NextToken: 'catalogs-next',
                },
          ),
        );
      if (operation === 'GetTables') return new Response(JSON.stringify({ TableList: [{ Name: 'visits' }] }));
      if (operation === 'GetTable')
        return new Response(
          JSON.stringify({
            Table: { Name: 'visits', StorageDescriptor: { Columns: [{ Name: 'id', Type: 'bigint' }] } },
          }),
        );
      return new Response('{}');
    };
    const connector = createAthenaConnector({ fetch: fakeClient, pollMs: 1 });
    const withCatalog = (catalog: string) => ({
      ...ctx,
      connection: SourceConnection.parse({ ...connection, catalog }),
    });

    expect(await connector.listObjects(withCatalog('AwsDataCatalog'))).toHaveLength(1);
    expect(operations.some((c) => c.operation === 'GetDataCatalog')).toBe(false);
    expect(operations.some((c) => c.operation === 'ListDataCatalogs')).toBe(false);
    expect(operations.find((c) => c.operation === 'GetTables')?.body.CatalogId).toBeUndefined();

    operations.length = 0;
    expect(await connector.listObjects(withCatalog('custom_glue'))).toHaveLength(1);
    expect(operations.find((c) => c.operation === 'GetTables')?.body.CatalogId).toBe('123456789012');

    operations.length = 0;
    expect(await connector.listObjects(withCatalog('shared_glue'))).toHaveLength(1);
    expect(operations.some((c) => c.operation === 'GetDataCatalog')).toBe(true);
    expect(operations.filter((c) => c.operation === 'ListDataCatalogs')).toHaveLength(2);
    expect(operations.find((c) => c.operation === 'GetTables')?.body.CatalogId).toBeUndefined();

    await expect(connector.listObjects(withCatalog('federated_lambda'))).rejects.toMatchObject({
      messageKey: 'sources.athena.glueCatalog',
    });
    await expect(connector.listObjects(withCatalog('missing_catalog'))).rejects.toMatchObject({
      messageKey: 'sources.athena.glueCatalog',
    });

    operations.length = 0;
    await expect(connector.listObjects(withCatalog('lambda_direct'))).rejects.toMatchObject({
      messageKey: 'sources.athena.glueCatalog',
    });
    expect(operations.some((c) => c.operation === 'ListDataCatalogs')).toBe(false);
  });
  it.each([
    ['float', 'real', 'number'],
    ['int', 'integer', 'number'],
    ['string', 'varchar', 'text'],
  ])('maps the Glue %s alias to %s for sync selection', async (type, signature, suggested) => {
    extraColumns = [{ Name: 'value', Type: type! }];
    const columns = await createAthenaConnector(options).describe(ctx, select);
    expect(columns.find((column) => column.name === 'value')).toMatchObject({
      sourceType: signature,
      suggested: { type: suggested },
    });
  });
  it.each([
    ['timestamp with time zone', '2026-01-01 12:34:56.000 UTC', '2026-01-01T12:34:56.000Z'],
    ['timestamp with time zone', '2026-01-01 12:34:56.123 +05:30', '2026-01-01T07:04:56.123Z'],
    ['timestamp', '2026-01-01 12:34:56.123', '2026-01-01T12:34:56.123Z'],
  ])('returns matching snapshot and live values for %s containing %s', async (type, value, expected) => {
    extraColumns = [{ Name: 'created', Type: type! }];
    extraValues = [value!];
    const connector = createAthenaConnector(options);
    const original = connectorFor('athena');
    registerConnector(connector);
    try {
      const preview = await connector.preview(ctx, select, 5);
      const index = preview.columns.findIndex((column) => column.name === 'created');
      expect(preview.rows.map((row) => row[index])).toEqual([expected, null]);
      const batches = [];
      for await (const batch of connector.read(ctx, select, {
        columns: ['created'],
        keyColumns: ['id'],
        types: { created: 'date' },
      }))
        batches.push(...batch);
      expect(batches.map((row) => row.values.created)).toEqual([expected, null]);
      const rows = await liveRows(
        {
          id: 'athena-timestamps',
          version: '1',
          kind: 'athena',
          context: ctx,
          select,
          keyColumns: ['id'],
        },
        ['[1]', '[2]'],
        [{ id: 'created', column: 'created', type: 'date' }],
      );
      expect([...rows.values()].map((row) => row.created)).toEqual([expected, null]);
    } finally {
      await closeLivePools();
      forgetLiveColumns();
      registerConnector(original);
    }
  });
  it.each(['idle', 'reading'])(
    'isolates a pooled session from its previous caller aborting while %s',
    async (when) => {
      const original = connectorFor('athena');
      const connector = createAthenaConnector(options);
      const opened = vi.spyOn(connector, 'session');
      registerConnector(connector);
      const pool = new LivePool('1', 'athena', ctx, 1);
      const first = new AbortController();
      const second = new AbortController();
      try {
        await pool.use((session) => session.select('SELECT 1', []), first.signal);
        if (when === 'idle') first.abort();
        else
          onOperation = (operation) => {
            if (operation === 'GetQueryExecution') first.abort();
          };
        await expect(
          pool.use((session) => session.select('SELECT 1', []), second.signal),
        ).resolves.toHaveLength(2);
        await expect(pool.use((session) => session.describe(select), second.signal)).resolves.toHaveLength(3);
        expect(opened).toHaveBeenCalledTimes(1);
        state = 'RUNNING';
        onOperation = (operation) => {
          if (operation === 'GetQueryExecution') second.abort();
        };
        await expect(
          pool.use((session) => session.select('SELECT 1', []), second.signal),
        ).rejects.toMatchObject({
          messageKey: 'sources.sync.read',
        });
        await vi.waitFor(() =>
          expect(calls.some((call) => call.operation === 'StopQueryExecution')).toBe(true),
        );
        expect(pool.sessions).toBe(0);
      } finally {
        await pool.retire();
        registerConnector(original);
      }
    },
  );
  it('reads every result page and distinguishes an empty string from null', async () => {
    const connector = createAthenaConnector(options);
    const batches = [];
    for await (const batch of connector.read(ctx, select, {
      columns: ['label', 'day'],
      keyColumns: ['id'],
      types: { label: 'text', day: 'date' },
      batchSize: 1,
    }))
      batches.push(batch);
    expect(batches).toEqual([
      [{ key: '[1]', values: { label: '', day: '2026-01-01' } }],
      [{ key: '[2]', values: { label: null, day: '2026-01-02' } }],
    ]);
    const start = calls.find((c) => c.operation === 'StartQueryExecution')!;
    expect(start.body).toMatchObject({
      WorkGroup: 'readers',
      ResultConfiguration: { OutputLocation: 's3://results/queries/' },
    });
    expect(start.body.QueryString).toContain('"AwsDataCatalog"."events"."visits"');
    expect(calls.filter((c) => c.operation === 'GetQueryResults')).toHaveLength(2);
  });
  it.each([0, 20_000_001])(
    'refuses an unsafe workgroup limit of %s before starting a query',
    async (limit) => {
      cutoff = limit;
      await expect(createAthenaConnector(options).preview(ctx, select, 2)).rejects.toMatchObject({
        messageKey: 'sources.athena.workgroupLimit',
      });
      expect(calls.some((c) => c.operation === 'StartQueryExecution')).toBe(false);
    },
  );
  it('cancels an over-limit query before reading results', async () => {
    scanned = 20_000_001;
    await expect(createAthenaConnector(options).preview(ctx, select, 2)).rejects.toMatchObject({
      messageKey: 'sources.athena.scanLimit',
    });
    expect(calls.some((c) => c.operation === 'StopQueryExecution')).toBe(true);
    expect(calls.some((c) => c.operation === 'GetQueryResults')).toBe(false);
  });
  it('cancels a running live query when its statement budget expires', async () => {
    state = 'RUNNING';
    const session = await createAthenaConnector(options).session!({ ...ctx, statementTimeoutMs: 30 });
    await expect(session.select('SELECT 1', [])).rejects.toBeDefined();
    await session.close();
    expect(calls.some((c) => c.operation === 'StopQueryExecution')).toBe(true);
  });
  it.each(['workgroupLimit', 'scanLimit'] as const)(
    'keeps the %s diagnosis on live reads',
    async (diagnosis) => {
      const original = connectorFor('athena');
      registerConnector(createAthenaConnector(options));
      if (diagnosis === 'workgroupLimit') cutoff = 0;
      else scanned = 20_000_001;
      try {
        await expect(
          liveKeys(
            {
              id: `athena-${diagnosis}`,
              version: '1',
              kind: 'athena',
              context: ctx,
              select,
              keyColumns: ['id'],
            },
            { where: null, order: [], limit: 5 },
          ),
        ).rejects.toMatchObject({ messageKey: `sources.athena.${diagnosis}` });
      } finally {
        await closeLivePools();
        forgetLiveColumns();
        registerConnector(original);
      }
    },
  );
  it('scrubs credentials from a failed HTTP response', async () => {
    failure = true;
    const result = await createAthenaConnector(options).test(ctx);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secrets.secretAccessKey);
  });
  it('contains a supplied query before sending it', async () => {
    await expect(
      createAthenaConnector(options).preview(
        ctx,
        { kind: 'query', sql: 'SELECT 1) q; DROP TABLE visits' },
        5,
      ),
    ).rejects.toBeDefined();
    expect(calls.some((c) => c.operation === 'StartQueryExecution')).toBe(false);
  });
});

function redshift(deployment: 'provisioned' | 'serverless'): ConnectorContext {
  return {
    secrets,
    connection: SourceConnection.parse({
      kind: 'redshift',
      host: 'warehouse.invalid',
      database: 'events',
      region: 'us-east-1',
      user: 'reader',
      deployment,
      clusterIdentifier: 'warehouse',
      workgroup: 'readers',
    }),
  };
}
it.each(['provisioned', 'serverless'] as const)(
  'gets temporary credentials for a %s endpoint',
  async (deployment) => {
    expect(await redshiftCredentials(redshift(deployment), options)).toEqual({
      user: 'IAM:reader',
      password: temporary,
    });
    expect(calls[0]?.operation).toBe(
      deployment === 'provisioned' ? 'GetClusterCredentials' : 'GetCredentials',
    );
    expect(headers.authorization).toContain(
      deployment === 'provisioned' ? '/redshift/aws4_request' : '/redshift-serverless/aws4_request',
    );
    if (deployment === 'provisioned')
      expect(calls[0]?.body).toMatchObject({ AutoCreate: 'false', DbUser: 'reader' });
  },
);
it('uses verified TLS and Redshift catalogs without treating informational keys as unique', async () => {
  const statements: string[] = [];
  const client = {
    on: vi.fn(),
    connect: vi.fn(),
    end: vi.fn(),
    query: vi.fn(async (input: pg.QueryConfig) => {
      statements.push(input.text);
      return {
        rows: input.text.includes('svv_columns')
          ? [
              { column_name: 'document', data_type: 'super', is_nullable: 'YES' },
              {
                column_name: 'amount',
                data_type: 'numeric',
                is_nullable: 'NO',
                numeric_precision: 18,
                numeric_scale: 4,
              },
              {
                column_name: 'notes',
                data_type: 'character varying',
                is_nullable: 'YES',
                character_maximum_length: 65535,
              },
            ]
          : [],
        fields: [],
      };
    }),
  };
  const factory = vi.fn(() => client as unknown as pg.Client);
  const connector = createRedshiftConnector({ ...options, client: factory, ca: async () => 'trusted-root' });
  const described = await connector.describe(redshift('serverless'), select);
  expect(described[0]).toMatchObject({
    sourceType: 'super',
    suggested: { type: 'longText' },
  });
  expect(described[1]).toMatchObject({
    sourceType: 'numeric(18,4)',
    suggested: { type: 'number', options: { precision: 4 } },
  });
  expect(described[2]).toMatchObject({
    sourceType: 'character varying(65535)',
    suggested: { type: 'longText' },
  });
  expect(factory.mock.calls).toHaveLength(1);
  expect((factory.mock.calls[0] as unknown[])[0]).toMatchObject({
    ssl: { rejectUnauthorized: true, servername: 'warehouse.invalid', ca: 'trusted-root' },
    password: temporary,
  });
  expect(statements.some((sql) => sql.includes('svv_external_columns'))).toBe(true);
  expect(await connector.keyCandidates(redshift('serverless'), select.object)).toEqual([]);
  expect(redshiftColumn('shape', 'geometry').suggested?.type).toBe('longText');
  expect(projection(redshiftColumn('shape', 'geometry'), '"shape"', 'redshift')).toBe(
    'ST_AsEWKT("shape", 17)',
  );
  expect(redshiftColumn('clock', 'timetz').suggested?.type).toBe('text');
});
it.each(['redshift', 'athena'] as const)('pushes filters and sorts down with safe %s literals', (dialect) => {
  const field = {
    id: 'title',
    type: 'text',
    options: {},
    source: { column: 'title', sourceType: 'varchar' },
  };
  const filter = translateCondition(
    field,
    { id: 'condition', fieldId: 'title', operator: 'contains', value: "O'Reilly" },
    dialect,
    { timeZone: 'UTC', now: new Date() },
  );
  expect(filter.ok).toBe(true);
  if (filter.ok) {
    const rendered = render(filter.sql, dialect);
    expect(rendered.text).toContain('strpos');
    if (dialect === 'athena') {
      expect(rendered.text).toContain("'O''Reilly'");
      expect(rendered.params).toEqual([]);
    } else expect(rendered.params).toEqual(["O'Reilly"]);
  }
  expect(translateSort(field, { fieldId: 'title', direction: 'desc' }, dialect).ok).toBe(true);
  expect(render(sqlf`SELECT ${value("x'; DROP TABLE t")}`, dialect).text).not.toBe("SELECT x'; DROP TABLE t");
});

it('keeps Redshift trailing spaces significant in text filters', () => {
  const field = {
    id: 'title',
    type: 'text',
    options: {},
    source: { column: 'title', sourceType: 'varchar' },
  };
  const equal = translateCondition(
    field,
    { id: 'equal', fieldId: 'title', operator: 'is', value: 'entry ' },
    'redshift',
    { timeZone: 'UTC', now: new Date() },
  );
  const empty = translateCondition(
    field,
    { id: 'empty', fieldId: 'title', operator: 'isEmpty' },
    'redshift',
    { timeZone: 'UTC', now: new Date() },
  );
  expect(equal.ok && render(equal.sql, 'redshift').text).toContain('OCTET_LENGTH');
  expect(empty.ok && render(empty.sql, 'redshift').text).toContain('CHAR_LENGTH');
});

it('casts Athena record keys to the types its SQL engine compares', async () => {
  const statements: string[] = [];
  const original = connectorFor('athena');
  const columns = [
    {
      name: 'id',
      sourceType: 'bigint',
      nullable: false,
      suggested: { type: 'number', options: {} },
      alternatives: [],
    },
    {
      name: 'enabled',
      sourceType: 'boolean',
      nullable: false,
      suggested: { type: 'checkbox', options: {} },
      alternatives: [],
    },
    {
      name: 'day',
      sourceType: 'date',
      nullable: false,
      suggested: { type: 'date', options: {} },
      alternatives: [],
    },
  ];
  registerConnector({
    ...original,
    session: async () => ({
      close: async () => {},
      describe: async () => columns,
      select: async (sql) => {
        statements.push(sql);
        return [{ id: '1', enabled: 'true', day: '2026-01-01' }];
      },
    }),
  });
  try {
    const rows = await liveRows(
      {
        id: 'athena-key-types',
        version: '1',
        kind: 'athena',
        context: ctx,
        select,
        keyColumns: ['id', 'enabled', 'day'],
      },
      ['[1,true,"2026-01-01"]'],
      [{ id: 'label', column: 'id', type: 'number' }],
    );
    expect(rows.get('[1,true,"2026-01-01"]')).toEqual({ label: 1 });
    expect(statements[0]).toContain("CAST('1' AS bigint)");
    expect(statements[0]).toContain("CAST('true' AS boolean)");
    expect(statements[0]).toContain("CAST('2026-01-01' AS date)");
  } finally {
    await closeLivePools();
    forgetLiveColumns();
    registerConnector(original);
  }
});

it('runs every declared Athena capability against signed protocol fixtures', async () => {
  const boundary = new FixtureBoundary();
  const queries = new Map<string, string>();
  const fetcher: typeof fetch = async (_url, init) => {
    const operation = new Headers(init?.headers).get('x-amz-target')?.split('.').at(-1);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    const fields = [{ Name: 'id', Type: 'bigint' }];
    let answer: unknown = {};
    if (operation === 'GetDataCatalog')
      answer = { DataCatalog: { Type: 'GLUE', Parameters: { 'catalog-id': 'fixture' } } };
    if (operation === 'GetWorkGroup')
      answer = { WorkGroup: { Configuration: { BytesScannedCutoffPerQuery: 1000 } } };
    if (operation === 'GetTables') answer = { TableList: [{ Name: 'visits' }] };
    if (operation === 'GetTable')
      answer = { Table: { StorageDescriptor: { Columns: fields }, PartitionKeys: [] } };
    if (operation === 'StartQueryExecution') {
      const id = String(queries.size);
      queries.set(id, body.QueryString!);
      answer = { QueryExecutionId: id };
    }
    if (operation === 'GetQueryExecution')
      answer = { QueryExecution: { Status: { State: 'SUCCEEDED' }, Statistics: { DataScannedInBytes: 1 } } };
    if (operation === 'GetQueryResults') {
      const sql = queries.get(body.QueryExecutionId!)!;
      const ids = /"id" = 2/.test(sql) ? ['2'] : /"id" DESC/.test(sql) ? ['3', '2', '1'] : ['1', '2', '3'];
      answer = {
        ResultSet: {
          ResultSetMetadata: { ColumnInfo: fields },
          Rows: [{ Data: [{ VarCharValue: 'id' }] }, ...ids.map((id) => ({ Data: [{ VarCharValue: id }] }))],
        },
      };
    }
    return new Response(JSON.stringify(answer));
  };
  await strictFixture(
    createAthenaConnector({ fetch: boundary.wrap(fetcher, 'fetch'), pollMs: 1 }),
    ctx,
    { kind: 'object', object: select.object },
    ['id'],
    3,
    boundary,
    (ctx) =>
      createAthenaConnector({ fetch: boundary.wrap(fetcher, 'fetch'), pollMs: 1 }).preview(ctx, select, 1),
  );
});
