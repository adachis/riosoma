import { isRecordObject, Leaf } from '../rest/records.js';
import { createHmac } from 'node:crypto';
import type { NoSqlConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { identify, object, type DocumentBackend } from './backend.js';
import { client, endpoint, nextCursor, secret, type NoSqlOptions } from './http.js';
import { conjunction, querySql, scalar, type Predicate } from './query.js';
import { fieldName } from './paths.js';

const PARTITION_TAG = '\u0000';
/** Ordinary text keeps its identity, while tagged parts distinguish missing, null, and scalar types. */
function partitionKey(value: unknown): string {
  if (typeof value === 'string' && value !== '' && !value.startsWith(PARTITION_TAG)) return value;
  return PARTITION_TAG + JSON.stringify(value === undefined ? [] : [value]);
}

function decodeKeys(predicate: Predicate, partitionFields: ReadonlySet<string>): Predicate {
  if ('terms' in predicate)
    return { ...predicate, terms: predicate.terms.map((p) => decodeKeys(p, partitionFields)) };
  if (
    !predicate.key ||
    !partitionFields.has(predicate.field) ||
    typeof predicate.value !== 'string' ||
    !predicate.value.startsWith(PARTITION_TAG)
  )
    return predicate;
  let decoded: unknown;
  try {
    decoded = JSON.parse(predicate.value.slice(PARTITION_TAG.length));
  } catch {
    throw new ConnectorError('sources.sync.keyEmpty');
  }
  if (!Array.isArray(decoded) || decoded.length > 1 || (decoded.length === 1 && !scalar(decoded[0])))
    throw new ConnectorError('sources.sync.keyEmpty');
  return { ...predicate, value: decoded.length ? decoded[0] : null, missing: decoded.length === 0 };
}

export function cosmosAuthorization(
  key: string,
  method: string,
  type: string,
  link: string,
  date: string,
): string {
  const payload = `${method.toLowerCase()}\n${type.toLowerCase()}\n${link}\n${date.toLowerCase()}\n\n`;
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(payload).digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${signature}`);
}
export function cosmosBackend(
  ctx: ConnectorContext,
  connection: Extract<NoSqlConnection, { kind: 'cosmosdb' }>,
  options: NoSqlOptions,
): DocumentBackend {
  const http = client(ctx, options);
  const base = endpoint(connection);
  const database = `dbs/${connection.database}`;
  const call = async <T>(
    path: string,
    type: string,
    link: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const date = (options.now?.() ?? new Date()).toUTCString();
    const method = body === undefined ? 'GET' : 'POST';
    const authorization =
      connection.auth === 'entra'
        ? encodeURIComponent(`type=aad&ver=1.0&sig=${secret(ctx, 'token')}`)
        : cosmosAuthorization(secret(ctx, 'secretAccessKey'), method, type, link, date);
    return http<T>(`${base}/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method,
      headers: {
        authorization,
        'x-ms-date': date,
        'x-ms-version': '2018-12-31',
        'content-type': body === undefined ? 'application/json' : 'application/query+json',
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const paths = async (name: string) =>
    (
      await call<{ partitionKey?: { paths: string[] } }>(
        `${database}/colls/${name}`,
        'colls',
        `${database}/colls/${name}`,
      )
    ).data.partitionKey?.paths ?? [];
  return {
    async list() {
      const out = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await call<{ DocumentCollections: { id: string }[] }>(
          `${database}/colls`,
          'colls',
          database,
          undefined,
          cursor ? { 'x-ms-continuation': cursor } : {},
        );
        out.push(...result.data.DocumentCollections.map((c) => object(c.id)));
        cursor = nextCursor(seen, result.headers.get('x-ms-continuation'));
      } while (cursor);
      return out;
    },
    async keys(ref) {
      return [...new Set([...(await paths(ref.name)).map((p) => fieldName(p.slice(1).split('/'))), 'id'])];
    },
    async *pages(ref, predicate, order, limit) {
      const partitionPaths = await paths(ref.name);
      const partitionFields = new Set(partitionPaths.map((path) => fieldName(path.slice(1).split('/'))));
      const decoded = decodeKeys(predicate, partitionFields);
      const terms = conjunction(decoded);
      const partition = [...partitionFields].map((field) => {
        const match = terms.find((p) => 'field' in p && p.field === field && p.op === 'eq');
        return match && 'value' in match ? (match.missing ? {} : match.value) : undefined;
      });
      const compiled = querySql(decoded, 'cosmosdb');
      const query = `SELECT * FROM c WHERE ${compiled.where}${order.length ? ' ORDER BY ' + order.map((o) => `${compiled.field(o.field)} ${o.direction.toUpperCase()}`).join(', ') : ''}`;
      const link = `${database}/colls/${ref.name}`;
      let cursor: string | undefined;
      const seen = new Set<string>();
      let remaining = limit ?? Infinity;
      do {
        const result = await call<{ Documents: Record<string, unknown>[] }>(
          `${link}/docs`,
          'docs',
          link,
          {
            query,
            parameters: compiled.parameters.map((value, index) => ({ name: `@p${index + 1}`, value })),
          },
          {
            'x-ms-documentdb-isquery': 'true',
            'x-ms-max-item-count': String(Math.min(1000, remaining)),
            ...(partition.length && partition.every((v) => v !== undefined)
              ? { 'x-ms-documentdb-partitionkey': JSON.stringify(partition) }
              : { 'x-ms-documentdb-query-enablecrosspartition': 'true' }),
            ...(cursor ? { 'x-ms-continuation': cursor } : {}),
          },
        );
        const documents = result.data.Documents.slice(0, remaining);
        for (const document of documents) {
          const identity = new Map<string, string>();
          for (const path of ['/id', ...partitionPaths]) {
            const parts = path.slice(1).split('/');
            let parent: Record<string, unknown> | undefined = document;
            for (const part of parts.slice(0, -1)) {
              const value: unknown = parent && Object.hasOwn(parent, part) ? parent[part] : undefined;
              parent = isRecordObject(value) ? value : undefined;
            }
            const last = parts.at(-1)!;
            const raw = parent && Object.hasOwn(parent, last) ? parent[last] : undefined;
            const value = raw instanceof Leaf ? raw.json : raw;
            if (partitionPaths.includes(path)) identity.set(fieldName(parts), partitionKey(value));
            else if (typeof value === 'string') identity.set(fieldName(parts), value);
            if (parent && typeof value === 'string') parent[last] = new Leaf(value, 'key', value, value);
          }
          identify(document, identity);
        }
        yield { documents };
        remaining -= documents.length;
        cursor = nextCursor(seen, result.headers.get('x-ms-continuation'));
      } while (cursor && remaining > 0);
    },
  };
}
