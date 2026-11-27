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
import { sourceKey } from '../registry.js';
import type { ConnectorContext, SourceRow, Validators } from '../types.js';
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

it('matches DynamoDB composite S + N keys to row values for small and large N and keeps deletes consistent', async () => {
  const composite = (items: Array<Record<string, unknown>>) =>
    createNoSqlConnector('dynamodb', {
      fetch: async (_url, init) => {
        const operation = new Headers(init.headers).get('x-amz-target')!.split('.').at(-1);
        if (operation === 'DescribeTable')
          return answer({
            Table: {
              KeySchema: [
                { AttributeName: 'pk', KeyType: 'HASH' },
                { AttributeName: 'id', KeyType: 'RANGE' },
              ],
              AttributeDefinitions: [
                { AttributeName: 'pk', AttributeType: 'S' },
                { AttributeName: 'id', AttributeType: 'N' },
              ],
            },
          });
        return answer({ Items: items });
      },
    });
  const ctx = context('dynamodb', { segments: 1 });

  // Small N only: id stays a number in both values and key.
  const smallItems = [
    { pk: { S: 'fixture' }, id: { N: '1' }, name: { S: 'One' } },
    { pk: { S: 'fixture' }, id: { N: '2' }, name: { S: 'Two' } },
  ];
  const smallRows: SourceRow[] = [];
  for await (const batch of composite(smallItems).read(ctx, select, {
    columns: ['pk', 'id', 'name'],
    types: {},
    keyColumns: ['pk', 'id'],
  }))
    smallRows.push(...batch);
  expect(smallRows.map((row) => row.values.id)).toEqual([1, 2]);
  for (const row of smallRows) expect(row.key).toBe(sourceKey([row.values.pk!, row.values.id!]));

  // Describe places the sortable RANGE key first regardless of attribute order in Items.
  const reordered = composite([
    { active: { BOOL: true }, name: { S: 'One' }, pk: { S: 'fixture' }, id: { N: '1' } },
  ]);
  expect((await reordered.describe(ctx, select)).map((c) => c.name)[0]).toBe('id');

  // Mixed small N + N above 2^53: exactness turns id into strings in both values and key.
  const mixedItems = [
    { pk: { S: 'fixture' }, id: { N: '1' }, name: { S: 'Small' } },
    { pk: { S: 'fixture' }, id: { N: '9007199254740993' }, name: { S: 'Large' } },
  ];
  const mixedRows: SourceRow[] = [];
  for await (const batch of composite(mixedItems).read(ctx, select, {
    columns: ['pk', 'id', 'name'],
    types: {},
    keyColumns: ['pk', 'id'],
  }))
    mixedRows.push(...batch);
  expect(mixedRows.map((row) => row.values.id)).toEqual(['1', '9007199254740993']);
  for (const row of mixedRows) expect(row.key).toBe(sourceKey([row.values.pk!, row.values.id!]));

  // Deleted-row path matches the row it removes.
  const couch = createNoSqlConnector('couchdb', {
    fetch: async (url) => {
      if (url.includes('_all_docs')) return answer({ rows: [{ id: '1', doc: { _id: '1', name: 'Alpha' } }] });
      if (url.includes('_changes'))
        return answer({ results: [{ id: '1', deleted: true }], last_seq: 'seq-2', pending: 0 });
      return answer({ update_seq: 'seq-1' });
    },
  });
  let checkpoint: Validators | undefined;
  const initial: SourceRow[] = [];
  for await (const batch of couch.read(context('couchdb'), select, {
    columns: ['_id', 'name'],
    types: {},
    keyColumns: ['_id'],
    onValidators: (v: Validators) => {
      checkpoint = v;
    },
  }))
    initial.push(...batch);
  expect(initial[0]!.key).toBe(sourceKey([initial[0]!.values._id!]));
  const changes: SourceRow[] = [];
  for await (const batch of couch.read(context('couchdb'), select, {
    columns: ['_id', 'name'],
    types: {},
    keyColumns: ['_id'],
    since: checkpoint,
  }))
    changes.push(...batch);
  expect(changes[0]).toEqual({ key: initial[0]!.key, values: {}, deleted: true });
});

it('carries HTTP status and a short scrubbed error code from nosql/http without exposing bodies or headers', async () => {
  const bodies = [
    {
      status: 400,
      code: 'BadRequest',
      body: { code: 'BadRequest', message: `secret=${secret} full-body-text` },
    },
    {
      status: 400,
      code: 'ValidationException',
      body: { __type: 'com.amazonaws.dynamodb.v20120810#ValidationException', message: secret },
    },
    {
      status: 400,
      code: 'no_usable_index',
      body: { error: `no_usable_index_${secret}`, reason: 'detailed-body' },
    },
  ];
  for (const entry of bodies) {
    const connector = createNoSqlConnector('cosmosdb', {
      fetch: async () =>
        new Response(JSON.stringify(entry.body), {
          status: entry.status,
          headers: { 'x-ms-secret-header': secret },
        }),
    });
    let caught: unknown;
    try {
      await connector.listObjects(context('cosmosdb'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ messageKey: 'sources.sync.read', params: { status: entry.status } });
    expect((caught as { detail?: string }).detail).toContain(entry.code);
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('full-body-text');
    expect(serialized).not.toContain('detailed-body');
    expect(serialized).not.toContain('x-ms-secret-header');
  }
});

it('pins Cosmos filter and sort pushdown queries and rejects system-property pushdown', async () => {
  const docs = [
    {
      id: '1',
      name: 'Alpha',
      amount: 12.5,
      active: true,
      day: '2026-01-15',
      _rid: 'r1',
      _etag: 'e1',
      _ts: 1,
    },
    {
      id: '2',
      name: 'Bravo',
      amount: 3.75,
      active: false,
      day: '2026-01-16',
      _rid: 'r2',
      _etag: 'e2',
      _ts: 2,
    },
  ];
  const queries: Array<{
    query: string;
    parameters: Array<{ name: string; value: unknown }>;
    headers: Record<string, string>;
  }> = [];
  const connector = createNoSqlConnector('cosmosdb', {
    fetch: async (url, init) => {
      if (url.endsWith('/pkranges')) return answer({ PartitionKeyRanges: [{ id: '0' }] });
      if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/id'] } });
      const body = JSON.parse(String(init.body)) as {
        query: string;
        parameters: Array<{ name: string; value: unknown }>;
      };
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (
        body.query.includes('ORDER BY') &&
        !headers['x-ms-documentdb-partitionkey'] &&
        !headers['x-ms-documentdb-partitionkeyrangeid']
      )
        return new Response(
          JSON.stringify({
            code: 'BadRequest',
            message: 'The provided cross partition query can not be directly served by the gateway.',
          }),
          { status: 400, headers: { 'content-type': 'application/json', 'x-ms-substatus': '1004' } },
        );
      queries.push({ ...body, headers });
      return answer({ Documents: docs });
    },
  });
  const ctx = context('cosmosdb');
  await connector.documentQuery!(ctx, select, {
    predicate: { op: 'eq', field: 'name', value: 'Bravo' },
    order: [],
    limit: 6,
    columns: ['id', 'name', 'amount', 'active', 'day'],
    types: {},
    keyColumns: ['id'],
  });
  await connector.documentQuery!(ctx, select, {
    predicate: ALL,
    order: [{ field: 'name', direction: 'desc' }],
    limit: 6,
    columns: ['id', 'name', 'amount', 'active', 'day'],
    types: {},
    keyColumns: ['id'],
  });
  const filterQuery = queries[1]!;
  expect(filterQuery.query).toBe('SELECT * FROM c WHERE c["name"] = @p1');
  expect(filterQuery.parameters).toEqual([{ name: '@p1', value: 'Bravo' }]);
  expect(filterQuery.headers['x-ms-documentdb-query-enablecrosspartition']).toBe('true');

  const sortQuery = queries[3]!;
  expect(sortQuery.query).toBe('SELECT * FROM c WHERE true ORDER BY c["name"] DESC');
  expect(sortQuery.parameters).toEqual([]);
  expect(sortQuery.headers['x-ms-documentdb-partitionkeyrangeid']).toBe('0');
  expect(sortQuery.headers['x-ms-documentdb-query-enablecrosspartition']).toBeUndefined();

  for (const system of ['_rid', '_self', '_etag', '_attachments', '_ts']) {
    const systemFields = new Map<string, LiveField>([
      [system, { id: system, type: 'text', options: {}, source: { column: system, sourceType: 'string' } }],
    ]);
    const rule = {
      conjunction: 'and' as const,
      conditions: [{ id: 'c1', fieldId: system, operator: 'is' as const, value: 'x' }],
    };
    expect(documentRuleTranslates(rule, systemFields, 'cosmosdb')).toBe(false);
    await expect(
      connector.documentQuery!(ctx, select, {
        predicate: { op: 'eq', field: system, value: 'x' },
        order: [],
        limit: 5,
        columns: ['id'],
        types: {},
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
    await expect(
      connector.documentQuery!(ctx, select, {
        predicate: ALL,
        order: [{ field: system, direction: 'desc' }],
        limit: 5,
        columns: ['id'],
        types: {},
        keyColumns: ['id'],
      }),
    ).rejects.toMatchObject({ messageKey: 'sources.live.unsupported' });
  }
});

it('fetches Cosmos pkranges and merges cross-partition ORDER BY streams when gateway rejects un-ranged sorts', async () => {
  const ranges: Record<string, Array<Record<string, unknown>>> = {
    '0': [
      { id: 'd1', name: 'Delta', score: 40 },
      { id: 'd2', name: 'Bravo', score: 20 },
      { id: 'd3', name: 'NullA', score: null },
    ],
    '1': [
      { id: 'd4', name: 'Echo', score: 50 },
      { id: 'd5', name: 'Charlie', score: 30 },
      { id: 'd6', name: 'Missing' },
    ],
    '2': [
      { id: 'd7', name: 'Alpha', score: 10 },
      { id: 'd8', name: 'Tie', score: 30 },
    ],
  };
  const requests: Array<{
    url: string;
    query: string;
    rangeId: string | null;
    cross: string | null;
    pk: string | null;
  }> = [];
  const connector = createNoSqlConnector('cosmosdb', {
    fetch: async (url, init) => {
      if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const headers = new Headers(init.headers);
      if (url.endsWith('/pkranges')) {
        const cont = headers.get('x-ms-continuation');
        if (!cont)
          return answer(
            { PartitionKeyRanges: [{ id: '0' }, { id: '1' }] },
            { 'x-ms-continuation': 'pk-page-2' },
          );
        return answer({ PartitionKeyRanges: [{ id: '2' }] });
      }
      if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/id'] } });
      const body = JSON.parse(String(init.body)) as { query: string };
      const rangeId = headers.get('x-ms-documentdb-partitionkeyrangeid');
      const cross = headers.get('x-ms-documentdb-query-enablecrosspartition');
      const pk = headers.get('x-ms-documentdb-partitionkey');
      requests.push({ url, query: body.query, rangeId, cross, pk });
      if (body.query.includes('ORDER BY') && !pk && !rangeId) {
        return new Response(
          JSON.stringify({
            code: 'BadRequest',
            message: 'The provided cross partition query can not be directly served by the gateway.',
          }),
          { status: 400, headers: { 'content-type': 'application/json', 'x-ms-substatus': '1004' } },
        );
      }
      if (pk) {
        const key = JSON.parse(pk)[0] as string;
        const all = Object.values(ranges)
          .flat()
          .filter((doc) => doc.id === key);
        return answer({ Documents: all });
      }
      const docs = [...(ranges[rangeId ?? '0'] ?? [])];
      if (body.query.includes('ORDER BY c["score"] ASC')) {
        const rank = (v: unknown) => (v === undefined ? 0 : v === null ? 1 : 2);
        docs.sort((a, b) => {
          const ra = rank(a.score);
          const rb = rank(b.score);
          return ra !== rb ? ra - rb : ra === 2 ? Number(a.score) - Number(b.score) : 0;
        });
      } else if (body.query.includes('ORDER BY c["score"] DESC')) {
        const rank = (v: unknown) => (v === undefined ? 0 : v === null ? 1 : 2);
        docs.sort((a, b) => {
          const ra = rank(a.score);
          const rb = rank(b.score);
          return ra !== rb ? rb - ra : ra === 2 ? Number(b.score) - Number(a.score) : 0;
        });
      }
      // Simulate paging with an empty continuation page on range 0.
      const cont = headers.get('x-ms-continuation');
      if (rangeId === '0') {
        if (!cont) return answer({ Documents: [] }, { 'x-ms-continuation': 'r0-p1' });
        if (cont === 'r0-p1')
          return answer({ Documents: docs.slice(0, 2) }, { 'x-ms-continuation': 'r0-p2' });
        return answer({ Documents: docs.slice(2) });
      }
      const offset = Number(cont ?? 0);
      const page = docs.slice(offset, offset + 2);
      return answer(
        { Documents: page },
        offset + 2 < docs.length ? { 'x-ms-continuation': String(offset + 2) } : {},
      );
    },
  });

  const ctx = context('cosmosdb');
  const descRows = await connector.documentQuery!(ctx, select, {
    predicate: ALL,
    order: [{ field: 'score', direction: 'desc' }],
    limit: 20,
    columns: ['id', 'name', 'score'],
    types: { id: 'text', name: 'text', score: 'number' },
    keyColumns: ['id'],
  });
  expect(descRows.map((r) => r.values.id)).toEqual(['d4', 'd1', 'd5', 'd8', 'd2', 'd7', 'd3', 'd6']);
  const sortRequests = requests.filter((r) => r.query.includes('ORDER BY'));
  expect(sortRequests.length).toBeGreaterThan(0);
  expect(sortRequests.every((r) => r.rangeId !== null && r.cross === null)).toBe(true);

  const ascLimited = await connector.documentQuery!(ctx, select, {
    predicate: ALL,
    order: [{ field: 'score', direction: 'asc' }],
    limit: 4,
    columns: ['id', 'name', 'score'],
    types: { id: 'text', name: 'text', score: 'number' },
    keyColumns: ['id'],
  });
  expect(ascLimited.map((r) => r.values.id)).toEqual(['d6', 'd3', 'd7', 'd2']);

  // Single logical partition sort still routes with x-ms-documentdb-partitionkey directly.
  const beforeSingle = requests.length;
  const single = await connector.documentQuery!(ctx, select, {
    predicate: { op: 'eq', field: 'id', value: 'd1' },
    order: [{ field: 'score', direction: 'desc' }],
    limit: 5,
    columns: ['id', 'score'],
    types: { id: 'text', score: 'number' },
    keyColumns: ['id'],
  });
  expect(single.map((r) => r.values.id)).toEqual(['d1']);
  expect(requests.slice(beforeSingle).filter((r) => r.query.includes('ORDER BY'))).toEqual([
    {
      url: expect.stringMatching(/\/docs$/),
      query: 'SELECT * FROM c WHERE c["id"] = @p1 ORDER BY c["score"] DESC',
      rangeId: null,
      cross: null,
      pk: '["d1"]',
    },
  ]);

  // Cancellation aborts in-flight sorted range queries without continuing to later pages.
  const controller = new AbortController();
  const callsBeforeAbort = requests.length;
  controller.abort();
  await expect(
    connector.documentQuery!({ ...ctx, signal: controller.signal }, select, {
      predicate: ALL,
      order: [{ field: 'score', direction: 'desc' }],
      limit: 5,
      columns: ['id'],
      types: {},
      keyColumns: ['id'],
    }),
  ).rejects.toMatchObject({ messageKey: 'sources.test.timeout' });
  expect(requests.length).toBe(callsBeforeAbort);

  // Early generator break stops paging without fetching remaining continuations.
  const { cosmosBackend } = await import('./cosmos.js');
  const backend = cosmosBackend(ctx, ctx.connection as Extract<typeof ctx.connection, { kind: 'cosmosdb' }>, {
    fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      if (url.endsWith('/pkranges')) return answer({ PartitionKeyRanges: [{ id: '0' }, { id: '1' }] });
      if (!url.endsWith('/docs')) return answer({ partitionKey: { paths: ['/id'] } });
      const rangeId = headers.get('x-ms-documentdb-partitionkeyrangeid')!;
      const cont = headers.get('x-ms-continuation');
      requests.push({
        url,
        query: JSON.parse(String(init.body)).query as string,
        rangeId,
        cross: headers.get('x-ms-documentdb-query-enablecrosspartition'),
        pk: headers.get('x-ms-documentdb-partitionkey'),
      });
      if (!cont) {
        return answer(
          {
            Documents:
              rangeId === '0'
                ? [
                    { id: 'a', score: 10 },
                    { id: 'b', score: 9 },
                  ]
                : [{ id: 'c', score: 8 }],
          },
          { 'x-ms-continuation': `next-${rangeId}` },
        );
      }
      throw new Error(`Should not fetch continuation page ${cont} after early break`);
    },
  });
  const firstBatch: unknown[] = [];
  for await (const page of backend.pages(select.object, ALL, [{ field: 'score', direction: 'desc' }], 10)) {
    firstBatch.push(...page.documents);
    break;
  }
  expect(firstBatch).toHaveLength(2);
});
