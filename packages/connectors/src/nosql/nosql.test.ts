import { generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SourceConnection, type NoSqlKind, type SourceSelect } from '@riosoma/contracts';
import { createNoSqlConnector } from './connector.js';
import { cosmosAuthorization } from './cosmos.js';
import { dynamoValue } from './dynamodb.js';
import { firestoreValue } from './firestore.js';
import { ALL, parseSelector, querySql } from './query.js';
import { documentPlan, documentRuleTranslates } from './live.js';
import type { LiveField, LiveInput } from '../live/translate.js';
import { Leaf } from '../rest/records.js';
import type { ConnectorContext, SourceRow } from '../types.js';
import { serviceAccount } from '../service-account.test-helpers.js';

const endpoint = new URL('http://127.0.0.1:18000').origin;
const secret = randomBytes(32).toString('base64');
const select: SourceSelect = { kind: 'object', object: { schema: null, name: 'items' } };
function context(kind: NoSqlKind, patch = {}): ConnectorContext {
  return {
    connection: SourceConnection.parse({
      kind,
      endpoint,
      region: 'us-east-1',
      user: 'reader',
      database: 'test',
      projectId: 'rio-test',
      emulator: true,
      ...patch,
    }),
    secrets: { password: secret, accessKeyId: randomBytes(8).toString('hex'), secretAccessKey: secret },
  };
}
const answer = (body: unknown, headers = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
async function read(
  connector: ReturnType<typeof createNoSqlConnector>,
  ctx: ConnectorContext,
  keyColumns: string[],
  extra = {},
) {
  const rows: SourceRow[] = [];
  for await (const batch of connector.read(ctx, select, {
    columns: ['name'],
    types: { name: 'text' },
    keyColumns,
    ...extra,
  }))
    rows.push(...batch);
  return rows;
}

describe('document protocol fixtures', () => {
  it('signs DynamoDB requests and keeps each parallel cursor with its segment', async () => {
    const calls: Record<string, unknown>[] = [];
    const connector = createNoSqlConnector('dynamodb', {
      fetch: async (_url, init) => {
        const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
        expect(new Headers(init.headers).get('authorization')).toContain('/dynamodb/aws4_request');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (operation === 'DescribeTable')
          return answer({ Table: { KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] } });
        if (operation === 'ListTables') return answer({ TableNames: ['items'] });
        calls.push(body);
        const segment = Number(body.Segment ?? 0);
        const next = body.ExclusiveStartKey ? 1 : 0;
        return answer({
          Items: [{ id: { S: `${segment}-${next}` }, name: { S: 'Row' }, nested: { M: { n: { N: '3' } } } }],
          ...(body.TotalSegments && !next ? { LastEvaluatedKey: { id: { S: String(segment) } } } : {}),
        });
      },
    });
    const ctx = context('dynamodb', { segments: 3 });
    const rows = await read(connector, ctx, ['id']);
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((row) => row.key)).size).toBe(6);
    for (const call of calls.filter((c) => c.ExclusiveStartKey))
      expect(call.ExclusiveStartKey).toEqual({ id: { S: String(call.Segment) } });
    expect((await connector.describe(ctx, select)).map((c) => c.name)).toContain('nested.n');
  });

  it('uses Query for an exact DynamoDB partition filter and binds every operand', async () => {
    let queried = false;
    const connector = createNoSqlConnector('dynamodb', {
      fetch: async (_url, init) => {
        const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
        if (operation === 'DescribeTable')
          return answer({
            Table: {
              KeySchema: [
                { AttributeName: 'tenant', KeyType: 'HASH' },
                { AttributeName: 'rank', KeyType: 'RANGE' },
              ],
            },
          });
        expect(operation).toBe('Query');
        const body = JSON.parse(String(init.body));
        expect(body.KeyConditionExpression).toContain(' AND ');
        expect(Object.values(body.ExpressionAttributeValues)).toContainEqual({ S: "a' OR true" });
        expect(body.Segment).toBeUndefined();
        queried = true;
        return answer({ Items: [] });
      },
    });
    await connector.describe(context('dynamodb'), {
      ...select,
      filter: JSON.stringify({ tenant: "a' OR true", rank: { $gte: 2 } }),
    });
    expect(queried).toBe(true);
  });

  it('maps sets, maps, precise numbers, timestamps, and binary values', () => {
    expect(dynamoValue({ SS: ['z', 'a'] })).toEqual(['a', 'z']);
    expect(dynamoValue({ N: '9007199254740993' })).toMatchObject({
      cell: '9007199254740993',
      shape: 'decimal',
    });
    expect(dynamoValue({ M: { values: { L: [{ BOOL: true }, { NULL: true }] } } })).toEqual({
      values: [true, null],
    });
    expect(dynamoValue({ B: randomBytes(3).toString('base64') })).toBeInstanceOf(Leaf);
    expect(firestoreValue({ integerValue: '9007199254740993' })).toMatchObject({ cell: '9007199254740993' });
    expect(firestoreValue({ timestampValue: '2026-01-01T00:00:00Z' })).toMatchObject({
      cell: { date: '2026-01-01T00:00:00Z' },
    });
  });

  it('reads CouchDB snapshots and explicit incremental deletions with opaque cursors', async () => {
    const seen: string[] = [];
    const connector = createNoSqlConnector('couchdb', {
      fetch: async (url) => {
        seen.push(url);
        if (url.includes('_all_docs'))
          return answer({ rows: [{ id: 'a', doc: { _id: 'a', name: 'Alpha' } }] });
        if (url.includes('_changes'))
          return answer({
            results: [
              { id: 'a', doc: { _id: 'a', name: 'Updated' } },
              { id: 'b', deleted: true },
            ],
            last_seq: 'next-opaque',
            pending: 0,
          });
        if (url.endsWith('_all_dbs')) return answer(['items', '_users']);
        return answer({ update_seq: 'first-opaque' });
      },
    });
    let cursor: unknown;
    let incremental = false;
    const ctx = context('couchdb');
    expect(
      (
        await read(connector, ctx, ['_id'], {
          onValidators: (v: unknown) => {
            cursor = v;
          },
        })
      )[0]!.key,
    ).toBe('["a"]');
    expect(cursor).toMatchObject({ cursor: 'first-opaque' });
    const rows = await read(connector, ctx, ['_id'], {
      since: cursor,
      onIncremental: () => {
        incremental = true;
      },
    });
    expect(incremental).toBe(true);
    expect(rows[1]).toEqual({ key: '["b"]', values: {}, deleted: true });
    expect(seen.some((url) => url.includes('since=first-opaque'))).toBe(true);
  });

  it('pushes Mango filters and follows bookmarks', async () => {
    let page = 0;
    const connector = createNoSqlConnector('couchdb', {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        expect(JSON.stringify(body.selector)).toContain('$gte');
        page++;
        return answer({ docs: page === 1 ? [{ _id: 'a', n: 3 }] : [], bookmark: 'next' });
      },
    });
    expect(
      (await connector.describe(context('couchdb'), { ...select, filter: '{"n":{"$gte":2}}' })).map(
        (c) => c.name,
      ),
    ).toEqual(['_id', 'n']);
    expect(page).toBe(2);
  });

  it('lists Couchbase namespaces and binds SQL++ filters in read-only requests', async () => {
    const statements: Record<string, unknown>[] = [];
    const connector = createNoSqlConnector('couchbase', {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        statements.push(body);
        return answer({
          status: 'success',
          results: body.statement.includes('system:keyspaces')
            ? [{ name: 'items', bucket: 'data', scope: 'sales' }]
            : [{ _id: 'a', n: 5 }],
        });
      },
    });
    const [ref] = await connector.listObjects(context('couchbase'));
    expect(ref!.schema).toBe('["data","sales"]');
    await connector.documentQuery!(
      context('couchbase'),
      { kind: 'object', object: ref! },
      {
        predicate: parseSelector('{"n":{"$gte":3}}'),
        order: [{ field: 'n', direction: 'desc' }],
        limit: 2,
        columns: ['n'],
        types: { n: 'number' },
        keyColumns: ['_id'],
      },
    );
    expect(statements.every((s) => s.readonly === true)).toBe(true);
    expect(statements[0]!.statement).toContain('k.`bucket`, k.`scope`');
    expect(statements.at(-1)!.args).toEqual([3]);
    expect(statements.at(-1)!.statement).toContain('`data`.`sales`.`items`');
    expect(statements.at(-1)!.statement).toContain('DESC');
  });

  it('lists Firestore documents and queries collection groups with full document keys', async () => {
    const name = 'projects/rio-test/databases/test/documents/parents/a/items/one';
    const requests: string[] = [];
    const connector = createNoSqlConnector('firestore', {
      fetch: async (url, init) => {
        requests.push(url);
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer owner');
        if (url.endsWith(':listCollectionIds')) return answer({ collectionIds: ['items'] });
        if (url.endsWith(':runQuery')) {
          expect(JSON.parse(String(init.body)).structuredQuery.from[0].allDescendants).toBe(true);
          return answer([{ document: { name, fields: { name: { stringValue: 'Alpha' } } } }]);
        }
        return answer({ documents: [{ name, fields: { name: { stringValue: 'Alpha' } } }] });
      },
    });
    const ctx = context('firestore', { collectionGroups: ['items'] });
    expect(await connector.listObjects(ctx)).toHaveLength(2);
    expect((await read(connector, ctx, ['__name__']))[0]!.key).toBe(JSON.stringify([name]));
    await connector.describe(ctx, { kind: 'object', object: { schema: 'group', name: 'items' } });
    expect(requests.some((url) => url.includes(':runQuery'))).toBe(true);
  });

  it('signs a Firestore service account assertion and sends its access token', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const account = JSON.stringify(
      serviceAccount({
        client_email: 'reader@rio-test.iam.gserviceaccount.com',
        private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      }),
    );
    const token = randomBytes(16).toString('hex');
    const connector = createNoSqlConnector('firestore', {
      fetch: async (url, init) => {
        if (url.endsWith('/token')) {
          const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
          const [header, payload, signature] = assertion.split('.');
          expect(
            verify(
              'RSA-SHA256',
              Buffer.from(`${header}.${payload}`),
              keys.publicKey,
              Buffer.from(signature!, 'base64url'),
            ),
          ).toBe(true);
          expect(JSON.parse(Buffer.from(payload!, 'base64url').toString()).scope).toContain(
            '/auth/datastore',
          );
          return answer({ access_token: token, expires_in: 3600 });
        }
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
        return answer({ collectionIds: [] });
      },
    });
    const ctx = context('firestore', { emulator: false });
    ctx.secrets = { serviceAccountJson: account };
    await connector.listObjects(ctx);
  });

  it('signs Cosmos requests and keeps empty continuation pages and partition identity', async () => {
    let pages = 0;
    const ctx = context('cosmosdb');
    const connector = createNoSqlConnector('cosmosdb', {
      now: () => new Date('2026-01-01T00:00:00Z'),
      fetch: async (url, init) => {
        const headers = new Headers(init.headers);
        if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/tenant'] } });
        expect(headers.get('authorization')).toBe(
          cosmosAuthorization(secret, 'POST', 'docs', 'dbs/test/colls/items', headers.get('x-ms-date')!),
        );
        expect(headers.get('x-ms-documentdb-partitionkey')).toBe('["north"]');
        pages++;
        if (pages % 2 === 1) return answer({ Documents: [] }, { 'x-ms-continuation': 'next' });
        expect(headers.get('x-ms-continuation')).toBe('next');
        return answer({ Documents: [{ id: 'a', tenant: 'north', name: 'Alpha' }] });
      },
    });
    const filtered: SourceSelect = { ...select, filter: '{"tenant":"north"}' };
    expect((await connector.preview(ctx, filtered, 10)).rows).toHaveLength(1);
    expect(await connector.keyCandidates(ctx, select.object)).toEqual([['tenant', 'id']]);
    expect(pages).toBe(2);
  });

  it('uses Entra token authorization and rejects repeated Cosmos continuation tokens', async () => {
    const token = randomBytes(16).toString('hex');
    const ctx = context('cosmosdb', { auth: 'entra' });
    ctx.secrets = { token };
    const connector = createNoSqlConnector('cosmosdb', {
      fetch: async (_url, init) => {
        expect(decodeURIComponent(new Headers(init.headers).get('authorization')!)).toBe(
          `type=aad&ver=1.0&sig=${token}`,
        );
        return answer({ DocumentCollections: [] }, { 'x-ms-continuation': 'same' });
      },
    });
    await expect(connector.listObjects(ctx)).rejects.toMatchObject({ messageKey: 'sources.nosql.paging' });
  });

  it.each(['dynamodb', 'couchdb', 'couchbase', 'firestore', 'cosmosdb'] as const)(
    'keeps %s failures free of credentials',
    async (kind) => {
      const connector = createNoSqlConnector(kind, {
        fetch: async () => new Response(secret, { status: 403 }),
      });
      const result = await connector.test(context(kind));
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.steps.at(-1)!.messageKey).toBe('sources.nosql.denied');
    },
  );
  it.each([
    ['ECONNREFUSED', 'connect'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ENOTFOUND', 'resolve'],
  ])('reports %s at the corresponding diagnostic step', async (code, step) => {
    const connector = createNoSqlConnector('couchdb', {
      fetch: async () => {
        throw Object.assign(new Error('Request failed'), { code });
      },
    });
    expect((await connector.test(context('couchdb'))).steps.at(-1)).toMatchObject({
      step,
      status: 'failed',
      messageKey: `sources.test.${step}`,
    });
  });
});

describe('document live authorization', () => {
  const fields = new Map<string, LiveField>([
    ['n', { id: 'n', type: 'number', options: {}, source: { column: 'n', sourceType: 'number' } }],
    ['text', { id: 'text', type: 'text', options: {}, source: { column: 'text', sourceType: 'string' } }],
  ]);
  const input: LiveInput = {
    dialect: 'couchbase' as LiveInput['dialect'],
    fields,
    filter: null,
    sorts: [],
    rules: null,
    context: { timeZone: 'UTC', now: new Date() },
  };
  it('keeps unrestricted and deny-all access distinct', () => {
    expect(documentPlan(input).where!.document).toEqual({ op: 'and', terms: [] });
    expect(documentPlan({ ...input, rules: [] }).where!.document).toEqual({
      op: 'and',
      terms: [{ op: 'or', terms: [] }],
    });
  });
  it('fails closed for unsupported rules and reports unsupported view filters', () => {
    const rule = {
      conjunction: 'and' as const,
      conditions: [{ id: 'condition', fieldId: 'text', operator: 'is' as const, value: 'Alpha' }],
    };
    expect(documentRuleTranslates(rule, fields)).toBe(false);
    const plan = documentPlan({ ...input, rules: [rule], filter: rule });
    expect(plan.skipped).toHaveLength(1);
    expect(JSON.stringify(plan.where!.document)).toContain('"op":"or","terms":[]');
  });
  it('refuses executable selectors and binds unusual field names', () => {
    expect(() => parseSelector('{"$where":"true"}')).toThrow();
    expect(() => parseSelector('{"n":{"$unknown":2}}')).toThrow();
    expect(() => parseSelector('{"n":{}}')).toThrow();
    const sql = querySql(parseSelector('{"a`b":"value"}'), 'couchbase');
    expect(sql.where).toContain('`a``b`');
    expect(sql.parameters).toEqual(['value']);
    expect(parseSelector()).toEqual(ALL);
  });
  it('keeps rounded numeric fields out of access rules and constrains Mango numeric types', async () => {
    const { mango } = await import('./query.js');
    const rule = {
      conjunction: 'and' as const,
      conditions: [{ id: 'condition', fieldId: 'n', operator: 'gt' as const, value: 2 }],
    };
    const plan = documentPlan({ ...input, rules: [rule] });
    expect(JSON.stringify(mango(plan.where!.document!))).toContain('"$type":"number"');
    for (const sourceType of ['decimal', 'long']) {
      const exact = new Map(fields);
      exact.set('n', { ...fields.get('n')!, source: { column: 'n', sourceType } });
      expect(documentRuleTranslates(rule, exact)).toBe(false);
    }
  });
});

it('simplifies unconditional selectors before Firestore snapshot queries', async () => {
  const connector = createNoSqlConnector('firestore', {
    fetch: async (url) => {
      expect(url).not.toContain(':runQuery');
      return answer({
        documents: [
          {
            name: 'projects/rio-test/databases/test/documents/items/one',
            fields: { n: { integerValue: '2' } },
          },
        ],
      });
    },
  });
  const preview = await connector.preview(
    context('firestore'),
    { ...select, filter: '{"$or":[{}, {"n":1}]}' },
    5,
  );
  expect(preview.rows).toHaveLength(1);
});

it('orders Firestore inequalities before the document-name cursor', async () => {
  const connector = createNoSqlConnector('firestore', {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(
        body.structuredQuery.orderBy.map((entry: { field: { fieldPath: string } }) => entry.field.fieldPath),
      ).toEqual(['`n`', '__name__']);
      return answer([]);
    },
  });
  await connector.describe(context('firestore'), { ...select, filter: '{"n":{"$gte":2}}' });
});

it('preserves native numeric DynamoDB key types when exact keys are stored as text', async () => {
  const value = '9007199254740993';
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
      if (operation === 'Query')
        expect(Object.values(JSON.parse(String(init.body)).ExpressionAttributeValues)).toContainEqual({
          N: value,
        });
      return answer({ Items: [{ id: { N: value }, name: { S: 'Exact' } }] });
    },
  });
  const rows = await connector.documentQuery!(context('dynamodb'), select, {
    predicate: parseSelector(JSON.stringify({ id: value })),
    order: [],
    limit: 1,
    columns: ['name'],
    types: {},
    keyColumns: ['id'],
  });
  expect(rows[0]!.key).toBe(JSON.stringify([value]));
});

it('converts each live field independently and preserves numeric-looking document IDs', async () => {
  const { registerConnector } = await import('../registry.js');
  const { liveRows } = await import('../live/reader.js');
  const connector = createNoSqlConnector('couchdb', {
    fetch: async (url) => {
      const document = { _id: '001', n: 1.25 };
      return url.includes('_find')
        ? answer({ docs: [document] })
        : answer({ rows: [{ id: document._id, doc: document }] });
    },
  });
  registerConnector(connector);
  try {
    const rows = await liveRows(
      { id: 'test', version: '1', kind: 'couchdb', context: context('couchdb'), select, keyColumns: ['_id'] },
      ['["001"]'],
      [
        { id: 'numeric', column: 'n', type: 'number' },
        { id: 'textual', column: 'n', type: 'text' },
      ],
    );
    expect(rows.get('["001"]')).toEqual({ numeric: 1.25, textual: '1.25' });
  } finally {
    registerConnector(createNoSqlConnector('couchdb'));
  }
});

it('budgets Firestore key batches against source and access-rule disjunctions', async () => {
  const { documentKeyBatchSize } = await import('./reader.js');
  const target = {
    id: 'test',
    version: '1',
    kind: 'firestore' as const,
    context: context('firestore'),
    select: { ...select, filter: '{"tenant":{"$in":["a","b","c"]}}' },
    keyColumns: ['__name__'],
  };
  expect(documentKeyBatchSize(target, parseSelector('{"n":{"$in":[1,2]}}'))).toBe(5);
  expect(documentKeyBatchSize({ ...target, select })).toBe(30);
});
