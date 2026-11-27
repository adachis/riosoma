import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { SourceConnection, type NoSqlKind, type SourceSelect } from '@riosoma/contracts';
import { liveKeys, liveRows, type LiveTarget } from '../live/reader.js';
import { registerConnector } from '../registry.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { createNoSqlConnector } from './connector.js';
import { documentPlan, documentRuleTranslates } from './live.js';
import type { LiveInput } from '../live/translate.js';
import { ALL, mango, parseSelector, querySql } from './query.js';
import { fieldName, fieldParts } from './paths.js';

const select: SourceSelect = { kind: 'object', object: { schema: null, name: 'items' } };
const answer = (body: unknown) => new Response(JSON.stringify(body));
function context(kind: NoSqlKind): ConnectorContext {
  return {
    connection: SourceConnection.parse({
      kind,
      endpoint: new URL('http://127.0.0.1:18000').origin,
      region: 'us-east-1',
      user: 'reader',
      database: 'test',
      segments: 1,
    }),
    secrets: {
      password: randomBytes(16).toString('hex'),
      accessKeyId: randomBytes(16).toString('hex'),
      secretAccessKey: randomBytes(32).toString('base64'),
    },
  };
}
async function snapshot(
  connector: ReturnType<typeof createNoSqlConnector>,
  ctx: ConnectorContext,
  keyColumns: string[],
) {
  const rows: SourceRow[] = [];
  for await (const page of connector.read(ctx, select, {
    keyColumns,
    columns: ['id', 'tenant'],
    types: { id: 'text', tenant: 'text' },
  }))
    rows.push(...page);
  return rows;
}

it('keeps literal dotted fields separate from nested values during sampling and extraction', async () => {
  const connector = createNoSqlConnector('couchbase', {
    fetch: async () =>
      answer({ status: 'success', results: [{ _id: 'one', 'access.level': 9, access: { level: 1 } }] }),
  });
  const selected: SourceSelect = { ...select, object: { schema: '["data","sales"]', name: 'items' } };
  const preview = await connector.preview(context('couchbase'), selected, 1);
  const values = Object.fromEntries(
    preview.columns.map((column, index) => [column.name, preview.rows[0]![index]]),
  );
  expect(values).toMatchObject({ 'access\\.level': 9, 'access.level': 1 });
});

it.each([false, true])('rejects ambiguous legacy access mappings with late arrival %s', async (late) => {
  let calls = 0;
  const connector = createNoSqlConnector('couchbase', {
    fetch: async () => {
      calls++;
      return answer({
        status: 'success',
        results: [
          { _id: 'one', ...(late && calls === 1 ? {} : { 'access.level': 9 }), access: { level: 1 } },
        ],
      });
    },
  });
  const target: LiveTarget = {
    id: 'test',
    version: '1',
    kind: 'couchbase',
    context: context('couchbase'),
    select: { ...select, object: { schema: '["data","sales"]', name: 'items' } },
    keyColumns: ['_id'],
  };
  const plan = documentPlan({
    dialect: 'couchbase' as LiveInput['dialect'],
    fields: new Map([
      [
        'access',
        {
          id: 'access',
          type: 'number',
          options: {},
          source: { column: 'access.level', sourceType: 'number' },
        },
      ],
    ]),
    filter: null,
    sorts: [],
    rules: [
      { conjunction: 'and', conditions: [{ id: 'rule', fieldId: 'access', operator: 'eq', value: 1 }] },
    ],
    context: { timeZone: 'UTC', now: new Date() },
  });
  registerConnector(connector);
  try {
    await expect(liveKeys(target, { where: plan.where, order: [], limit: 5 })).rejects.toMatchObject({
      messageKey: 'sources.live.unsupported',
    });
    await expect(
      liveRows(target, ['["one"]'], [{ id: 'access', column: 'access.level', type: 'number' }]),
    ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
  } finally {
    registerConnector(createNoSqlConnector('couchbase'));
  }
});

it('uses the same native path for escaped filters, sorts, and live values', async () => {
  const statements: string[] = [];
  const connector = createNoSqlConnector('couchbase', {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      statements.push(body.statement);
      return answer({
        status: 'success',
        results: [{ _id: 'one', 'access.level': 9, access: { level: 1 } }],
      });
    },
  });
  const field = 'access\\.level';
  const rows = await connector.documentQuery!(
    context('couchbase'),
    { ...select, object: { schema: '["data","sales"]', name: 'items' } },
    {
      predicate: parseSelector(JSON.stringify({ [field]: 9 })),
      order: [{ field, direction: 'asc' }],
      limit: 1,
      columns: [field],
      types: { [field]: 'number' },
      keyColumns: ['_id'],
    },
  );
  expect(rows[0]!.values).toEqual({ [field]: 9 });
  expect(statements.at(-1)).toContain('c.`access.level`');
  expect(statements.at(-1)).not.toContain('c.`access`.`level`');
  expect(querySql(parseSelector(JSON.stringify({ [field]: 9 })), 'cosmosdb').where).toBe(
    '(c["access.level"] = @p1)',
  );
  for (const path of [
    ['a.b', 'c\\d'],
    ['a', 'b.c'],
    ['a\\', 'b'],
  ])
    expect(fieldParts(fieldName(path))).toEqual(path);
  expect(() => mango(parseSelector(JSON.stringify({ [field]: 9 })))).toThrow();
  const fields = new Map([
    [
      'access',
      { id: 'access', type: 'number', options: {}, source: { column: field, sourceType: 'number' } },
    ],
  ]);
  const rule = {
    conjunction: 'and' as const,
    conditions: [{ id: 'rule', fieldId: 'access', operator: 'eq' as const, value: 9 }],
  };
  expect(documentRuleTranslates(rule, fields, 'couchdb')).toBe(false);
  expect(documentRuleTranslates(rule, fields, 'couchbase')).toBe(true);
});

it('queries numeric DynamoDB identities with their native type', async () => {
  let queries = 0;
  const value = '9007199254740993';
  const connector = createNoSqlConnector('dynamodb', {
    fetch: async (_url, init) => {
      const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
      if (operation === 'DescribeTable')
        return answer({
          Table: {
            KeySchema: [{ AttributeName: 'id.part', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id.part', AttributeType: 'N' }],
          },
        });
      if (operation === 'Query') {
        queries++;
        const body = JSON.parse(String(init.body));
        expect(Object.values(body.ExpressionAttributeValues)).toEqual([{ N: value }]);
        expect(Object.values(body.ExpressionAttributeNames)).toEqual(['id.part']);
      }
      return answer({ Items: [{ 'id.part': { N: value } }] });
    },
  });
  const ctx = context('dynamodb');
  const [keyColumns] = await connector.keyCandidates(ctx, select.object);
  expect(keyColumns).toEqual(['id\\.part']);
  const [row] = await snapshot(connector, ctx, keyColumns!);
  registerConnector(connector);
  try {
    const rows = await liveRows(
      { id: 'test', version: '1', kind: 'dynamodb', context: ctx, select, keyColumns: keyColumns! },
      [row!.key],
      [],
    );
    expect([...rows.keys()]).toEqual([JSON.stringify([value])]);
    expect(queries).toBe(1);
  } finally {
    registerConnector(createNoSqlConnector('dynamodb'));
  }
});

it('keeps numeric DynamoDB identities exact across sample changes and beyond the sample', async () => {
  let values = ['1', '2'];
  const connector = createNoSqlConnector('dynamodb', {
    fetch: async (_url, init) => {
      const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
      if (operation === 'DescribeTable')
        return answer({
          Table: {
            KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
            AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }],
          },
        });
      const body = JSON.parse(String(init.body));
      const offset = body.ExclusiveStartKey ? 1000 : 0;
      const page = values.slice(offset, offset + body.Limit);
      return answer({
        Items: page.map((N) => ({ id: { N } })),
        ...(offset + page.length < values.length ? { LastEvaluatedKey: { id: { N: page.at(-1) } } } : {}),
      });
    },
  });
  const ctx = context('dynamodb');
  const before = await snapshot(connector, ctx, ['id']);
  expect(before[0]!.key).toBe('[1]');
  values = ['1', '2.5'];
  expect((await snapshot(connector, ctx, ['id']))[0]!.key).toBe('["1"]');
  values = [...Array.from({ length: 1000 }, (_, i) => String(i)), '9007199254740992', '9007199254740993'];
  const rows = await snapshot(connector, ctx, ['id']);
  expect(rows).toHaveLength(1002);
  expect(new Set(rows.map((row) => row.key)).size).toBe(1002);
  expect(rows.slice(-2).map((row) => row.key)).toEqual(['["9007199254740992"]', '["9007199254740993"]']);
  values = ['1.00', '1e0', '-0.0'];
  expect((await snapshot(connector, ctx, ['id'])).map((row) => row.key)).toEqual([
    '["1.00"]',
    '["1e0"]',
    '["-0.0"]',
  ]);
});

it('round trips null and missing Cosmos partitions without colliding with strings', async () => {
  const documents = [
    { id: 'one', tenant: null },
    { id: 'one' },
    { id: 'one', tenant: '' },
    { id: 'one', tenant: '\u0000[null]' },
    { id: 'one', tenant: '\u0000[]' },
    { id: 'one', tenant: 0 },
    { id: 'one', tenant: '0' },
    { id: 'one', tenant: false },
  ];
  const requests: Array<{ query: string; parameters: Array<{ value: unknown }>; partition: string | null }> =
    [];
  const connector = createNoSqlConnector('cosmosdb', {
    fetch: async (url, init) => {
      if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/tenant'] } });
      const body = JSON.parse(String(init.body));
      const partition = new Headers(init.headers).get('x-ms-documentdb-partitionkey');
      requests.push({ ...body, partition });
      const selected =
        partition === null
          ? documents
          : documents.filter((doc) => {
              const value = JSON.parse(partition)[0];
              return typeof value === 'object' && value !== null
                ? !Object.hasOwn(doc, 'tenant')
                : doc.tenant === value;
            });
      return answer({ Documents: selected });
    },
  });
  const ctx = context('cosmosdb');
  const [keyColumns] = await connector.keyCandidates(ctx, select.object);
  const rows = await snapshot(connector, ctx, keyColumns!);
  expect(rows).toHaveLength(documents.length);
  expect(new Set(rows.map((row) => row.key)).size).toBe(documents.length);
  expect(rows[0]!.values.tenant).toBeNull();
  const queried = await connector.documentQuery!(ctx, select, {
    predicate: ALL,
    order: [],
    limit: 10,
    columns: [],
    types: {},
    keyColumns: keyColumns!,
  });
  expect(queried.map((row) => row.key)).toEqual(rows.map((row) => row.key));
  registerConnector(connector);
  try {
    const target: LiveTarget = {
      id: 'test',
      version: '1',
      kind: 'cosmosdb',
      context: ctx,
      select,
      keyColumns: keyColumns!,
    };
    for (const row of rows) {
      const result = await liveRows(target, [row.key], [{ id: 'tenant', column: 'tenant', type: 'text' }]);
      expect([...result.keys()]).toEqual([row.key]);
    }
    const routed = requests.filter((request) => request.partition !== null);
    expect(routed.map((request) => request.partition)).toEqual([
      '[null]',
      '[{}]',
      '[""]',
      JSON.stringify(['\u0000[null]']),
      JSON.stringify(['\u0000[]']),
      '[0]',
      '["0"]',
      '[false]',
    ]);
    expect(routed[0]!.parameters.map((parameter) => parameter.value)).toContain(null);
    expect(routed[1]!.query).toContain('NOT IS_DEFINED(c["tenant"])');
  } finally {
    registerConnector(createNoSqlConnector('cosmosdb'));
  }
});

it('describes and routes missing nested Cosmos partition components', async () => {
  const connector = createNoSqlConnector('cosmosdb', {
    fetch: async (url, init) => {
      if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/account/tenant', '/region'] } });
      const partition = new Headers(init.headers).get('x-ms-documentdb-partitionkey');
      if (partition) {
        expect(partition).toBe('[{},null]');
        expect(JSON.parse(String(init.body)).query).toContain('NOT IS_DEFINED(c["account"]["tenant"])');
      }
      return answer({ Documents: [{ id: 'one', region: null }] });
    },
  });
  const ctx = context('cosmosdb');
  const [keyColumns] = await connector.keyCandidates(ctx, select.object);
  const preview = await connector.preview(ctx, select, 1);
  expect(keyColumns).toEqual(['account.tenant', 'region', 'id']);
  expect(preview.columns.map((column) => column.name)).toContain('account.tenant');
  const [row] = await snapshot(connector, ctx, keyColumns!);
  registerConnector(connector);
  try {
    const rows = await liveRows(
      { id: 'test', version: '1', kind: 'cosmosdb', context: ctx, select, keyColumns: keyColumns! },
      [row!.key],
      [],
    );
    expect([...rows.keys()]).toEqual([row!.key]);
  } finally {
    registerConnector(createNoSqlConnector('cosmosdb'));
  }
});
