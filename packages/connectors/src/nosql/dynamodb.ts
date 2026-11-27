import type { NoSqlConnection } from '@riosoma/contracts';
import { payloadHash, signAwsRequest } from '../files/s3.js';
import { Leaf } from '../rest/records.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { object, type DocumentBackend, type DocumentPage } from './backend.js';
import { fieldName, fieldParts } from './paths.js';
import { client, endpoint, nextCursor, secret, type NoSqlOptions } from './http.js';
import { conjunction, equality, type Predicate, type Scalar } from './query.js';

type Attribute = {
  S?: string;
  N?: string;
  B?: string;
  BOOL?: boolean;
  NULL?: boolean;
  SS?: string[];
  NS?: string[];
  BS?: string[];
  M?: Record<string, Attribute>;
  L?: Attribute[];
};
type Item = Record<string, Attribute>;

export function dynamoValue(value: Attribute): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) {
    const number = Number(value.N);
    if (Number.isSafeInteger(number) && String(number) === value.N) return number;
    return new Leaf(value.N, 'decimal', value.N, value.N);
  }
  if (value.B !== undefined) return new Leaf(null, 'binary', undefined, null);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.M) return dynamoDocument(value.M);
  if (value.L) return value.L.map(dynamoValue);
  if (value.SS) return [...value.SS].sort();
  if (value.NS) return [...value.NS].sort().map((N) => dynamoValue({ N }));
  if (value.BS) return new Leaf(null, 'binary', undefined, null);
  return null;
}
export function dynamoDocument(item: Item): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, dynamoValue(value)]));
}
export function dynamoAttribute(value: Scalar): Attribute {
  if (value === null) return { NULL: true };
  if (typeof value === 'string') return { S: value };
  if (typeof value === 'boolean') return { BOOL: value };
  return { N: String(value) };
}
export function dynamoBackend(
  ctx: ConnectorContext,
  connection: Extract<NoSqlConnection, { kind: 'dynamodb' }>,
  options: NoSqlOptions,
): DocumentBackend {
  const http = client(ctx, options);
  const url = endpoint(connection);
  const call = async <T>(operation: string, data: unknown): Promise<T> => {
    const body = JSON.stringify(data);
    const headers = signAwsRequest({
      method: 'POST',
      url: new URL(url),
      region: connection.region,
      service: 'dynamodb',
      credentials: {
        accessKeyId: secret(ctx, 'accessKeyId'),
        secretAccessKey: secret(ctx, 'secretAccessKey'),
        ...(ctx.secrets.token ? { sessionToken: ctx.secrets.token } : {}),
      },
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': `DynamoDB_20120810.${operation}`,
      },
      hash: payloadHash(body),
      now: options.now?.(),
    });
    return (await http<T>(url, { method: 'POST', headers, body })).data;
  };
  const schema = async (name: string) =>
    (
      await call<{
        Table: {
          KeySchema: { AttributeName: string; KeyType: string }[];
          AttributeDefinitions?: { AttributeName: string; AttributeType: string }[];
        };
      }>('DescribeTable', { TableName: name })
    ).Table;
  return {
    async list() {
      const out = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await call<{ TableNames: string[]; LastEvaluatedTableName?: string }>('ListTables', {
          Limit: 100,
          ...(cursor ? { ExclusiveStartTableName: cursor } : {}),
        });
        out.push(...page.TableNames.map((name) => object(name)));
        cursor = nextCursor(seen, page.LastEvaluatedTableName);
      } while (cursor);
      return out;
    },
    async keys(ref) {
      return (await schema(ref.name)).KeySchema.sort((a, b) =>
        a.KeyType === b.KeyType ? 0 : a.KeyType === 'HASH' ? -1 : 1,
      ).map((k) => fieldName([k.AttributeName]));
    },
    async *pages(ref, predicate, order, limit) {
      const described = await schema(ref.name);
      const keys = described.KeySchema;
      const attributeTypes = new Map(
        (described.AttributeDefinitions ?? []).map((a) => [fieldName([a.AttributeName]), a.AttributeType]),
      );
      const hash = fieldName([keys.find((k) => k.KeyType === 'HASH')!.AttributeName]);
      const rangeKey = keys.find((k) => k.KeyType === 'RANGE');
      const range = rangeKey && fieldName([rangeKey.AttributeName]);
      const hashValue = equality(predicate, hash);
      let query = hashValue !== undefined && hashValue !== null;
      const names: Record<string, string> = {};
      const values: Record<string, Attribute> = {};
      const field = (name: string) =>
        fieldParts(name)
          .map((part) => {
            const key = `#n${Object.keys(names).length}`;
            names[key] = part;
            return key;
          })
          .join('.');
      const compile = (p: Predicate): string => {
        if ('terms' in p)
          return p.terms.length
            ? '(' + p.terms.map(compile).join(p.op === 'and' ? ' AND ' : ' OR ') + ')'
            : p.op === 'and'
              ? ''
              : `(attribute_exists(${field(hash)}) AND attribute_not_exists(${field(hash)}))`;
        const name = field(p.field);
        const key = `:v${Object.keys(values).length}`;
        values[key] =
          attributeTypes.get(p.field) === 'N' &&
          typeof p.value === 'string' &&
          /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(p.value)
            ? { N: p.value }
            : dynamoAttribute(p.value);
        return `${name} ${{ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[p.op]} ${key}`;
      };
      const terms = conjunction(predicate);
      const keyTerms = query
        ? terms.filter(
            (p) =>
              'field' in p && ((p.field === hash && p.op === 'eq') || (p.field === range && p.op !== 'ne')),
          )
        : [];
      const referencesKey = (p: Predicate): boolean =>
        'terms' in p ? p.terms.some(referencesKey) : p.field === hash || p.field === range;
      const residual = terms.filter((p) => !keyTerms.includes(p));
      if (
        keyTerms.filter((p) => 'field' in p && p.field === hash).length !== 1 ||
        keyTerms.filter((p) => 'field' in p && p.field === range).length > 1 ||
        residual.some(referencesKey)
      )
        query = false;
      const keyExpression = query ? keyTerms.map(compile).filter(Boolean).join(' AND ') : '';
      const rest = query ? residual : terms;
      const filter = rest.map(compile).filter(Boolean).join(' AND ');
      if (order.some((o) => o.field !== range)) throw new ConnectorError('sources.live.unsupported');
      const count = query || limit !== undefined ? 1 : connection.segments;
      const cursors: Array<Item | undefined> = Array.from({ length: count });
      const done = new Set<number>();
      const seen = Array.from({ length: count }, () => new Set<string>());
      let remaining = limit ?? Infinity;
      while (done.size < count && remaining > 0) {
        const active = Array.from({ length: count }, (_, i) => i).filter((i) => !done.has(i));
        const pages = await Promise.all(
          active.map(async (segment) => {
            const result = await call<{ Items?: Item[]; LastEvaluatedKey?: Item }>(query ? 'Query' : 'Scan', {
              TableName: ref.name,
              Limit: Math.min(1000, remaining),
              ...(count > 1 ? { Segment: segment, TotalSegments: count } : {}),
              ...(query
                ? { KeyConditionExpression: keyExpression, ScanIndexForward: order[0]?.direction !== 'desc' }
                : {}),
              ...(filter ? { FilterExpression: filter } : {}),
              ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
              ...(cursors[segment] ? { ExclusiveStartKey: cursors[segment] } : {}),
            });
            const next =
              result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length
                ? result.LastEvaluatedKey
                : undefined;
            nextCursor(seen[segment]!, next);
            cursors[segment] = next;
            if (!next) done.add(segment);
            return {
              documents: (result.Items ?? []).map((item) => {
                const document = dynamoDocument(item);
                for (const key of keys) {
                  const value = item[key.AttributeName]?.S;
                  if (value !== undefined) document[key.AttributeName] = new Leaf(value, 'key', value, value);
                }
                return document;
              }),
            } satisfies DocumentPage;
          }),
        );
        for (const page of pages) {
          remaining -= page.documents.length;
          yield page;
        }
      }
    },
  };
}
