import { isRecordObject, Leaf } from '../rest/records.js';
import { createHmac } from 'node:crypto';
import type { NoSqlConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { identify, object, type DocumentBackend } from './backend.js';
import { client, endpoint, nextCursor, secret, type NoSqlOptions } from './http.js';
import { conjunction, querySql, scalar, type DocumentOrder, type Predicate } from './query.js';
import { fieldName, fieldParts } from './paths.js';

export const COSMOS_SYSTEM_FIELDS = new Set(['_rid', '_self', '_etag', '_attachments', '_ts']);

function usesSystemField(predicate: Predicate): boolean {
  return 'terms' in predicate
    ? predicate.terms.some(usesSystemField)
    : COSMOS_SYSTEM_FIELDS.has(predicate.field);
}

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

function readField(document: Record<string, unknown>, field: string): unknown {
  let current: unknown = document;
  for (const part of fieldParts(field)) {
    if (!isRecordObject(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current instanceof Leaf ? current.json : current;
}

function cosmosRank(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null) return 1;
  if (typeof value === 'boolean') return 2;
  if (typeof value === 'number') return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

function compareCosmosValues(a: unknown, b: unknown): number {
  const ra = cosmosRank(a);
  const rb = cosmosRank(b);
  if (ra !== rb) return ra - rb;
  if (ra <= 1) return 0;
  if (ra === 2) return Number(a) - Number(b);
  if (ra === 3) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ra === 4) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  const ja = JSON.stringify(a) ?? '';
  const jb = JSON.stringify(b) ?? '';
  return ja < jb ? -1 : ja > jb ? 1 : 0;
}

function compareDocuments(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  order: readonly DocumentOrder[],
): number {
  for (const entry of order) {
    const cmp = compareCosmosValues(readField(a, entry.field), readField(b, entry.field));
    if (cmp !== 0) return entry.direction === 'desc' ? -cmp : cmp;
  }
  return 0;
}

function annotateDocument(document: Record<string, unknown>, partitionPaths: readonly string[]): void {
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
      if (usesSystemField(predicate) || order.some((o) => COSMOS_SYSTEM_FIELDS.has(o.field)))
        throw new ConnectorError('sources.live.unsupported');
      let remaining = limit ?? Infinity;
      if (remaining <= 0) return;
      const partitionPaths = await paths(ref.name);
      const partitionFields = new Set(partitionPaths.map((path) => fieldName(path.slice(1).split('/'))));
      const decoded = decodeKeys(predicate, partitionFields);
      const terms = conjunction(decoded);
      const partition = [...partitionFields].map((field) => {
        const match = terms.find((p) => 'field' in p && p.field === field && p.op === 'eq');
        return match && 'value' in match ? (match.missing ? {} : match.value) : undefined;
      });
      const singlePartition = partition.length > 0 && partition.every((v) => v !== undefined);
      const compiled = querySql(decoded, 'cosmosdb');
      const query = `SELECT * FROM c WHERE ${compiled.where}${order.length ? ' ORDER BY ' + order.map((o) => `${compiled.field(o.field)} ${o.direction.toUpperCase()}`).join(', ') : ''}`;
      const link = `${database}/colls/${ref.name}`;
      const parameters = compiled.parameters.map((value, index) => ({ name: `@p${index + 1}`, value }));
      const queryPage = (pageSize: number, scope: Record<string, string>) =>
        call<{ Documents: Record<string, unknown>[] }>(
          `${link}/docs`,
          'docs',
          link,
          { query, parameters },
          {
            'x-ms-documentdb-isquery': 'true',
            'x-ms-max-item-count': String(Math.max(1, Math.min(1000, pageSize))),
            ...scope,
          },
        );
      const streamSingle = async function* (scope: Record<string, string>) {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const result = await queryPage(remaining, {
            ...scope,
            ...(cursor ? { 'x-ms-continuation': cursor } : {}),
          });
          const documents = result.data.Documents.slice(0, remaining);
          for (const document of documents) annotateDocument(document, partitionPaths);
          yield { documents };
          remaining -= documents.length;
          cursor = nextCursor(seen, result.headers.get('x-ms-continuation'));
        } while (cursor && remaining > 0);
      };
      if (singlePartition) {
        yield* streamSingle({ 'x-ms-documentdb-partitionkey': JSON.stringify(partition) });
        return;
      }
      if (!order.length) {
        yield* streamSingle({ 'x-ms-documentdb-query-enablecrosspartition': 'true' });
        return;
      }
      const rangeIds: string[] = [];
      let rangeCursor: string | undefined;
      const seenRanges = new Set<string>();
      do {
        const result = await call<{ PartitionKeyRanges?: { id: string }[] }>(
          `${link}/pkranges`,
          'pkranges',
          link,
          undefined,
          rangeCursor ? { 'x-ms-continuation': rangeCursor } : {},
        );
        for (const range of result.data.PartitionKeyRanges ?? []) rangeIds.push(range.id);
        rangeCursor = nextCursor(seenRanges, result.headers.get('x-ms-continuation'));
      } while (rangeCursor);
      if (!rangeIds.length) return;
      if (rangeIds.length === 1) {
        yield* streamSingle({ 'x-ms-documentdb-partitionkeyrangeid': rangeIds[0]! });
        return;
      }
      // The Cosmos REST gateway rejects cross-partition ORDER BY, so query each range and merge.
      const streams = rangeIds.map((rangeId) => ({
        rangeId,
        cursor: undefined as string | undefined,
        seen: new Set<string>(),
        buffer: [] as Record<string, unknown>[],
        index: 0,
        done: false,
      }));
      const fill = async (stream: (typeof streams)[number]) => {
        while (!stream.done && stream.index >= stream.buffer.length) {
          const result = await queryPage(remaining, {
            'x-ms-documentdb-partitionkeyrangeid': stream.rangeId,
            ...(stream.cursor ? { 'x-ms-continuation': stream.cursor } : {}),
          });
          stream.buffer = result.data.Documents;
          stream.index = 0;
          stream.cursor = nextCursor(stream.seen, result.headers.get('x-ms-continuation'));
          if (!stream.cursor) stream.done = true;
        }
      };
      for (const stream of streams) await fill(stream);
      const batchLimit = Math.max(1, Math.min(1000, remaining));
      let batch: Record<string, unknown>[] = [];
      while (remaining > 0) {
        let bestIndex = -1;
        for (let i = 0; i < streams.length; i++) {
          const stream = streams[i]!;
          if (stream.index >= stream.buffer.length) continue;
          if (
            bestIndex === -1 ||
            compareDocuments(
              stream.buffer[stream.index]!,
              streams[bestIndex]!.buffer[streams[bestIndex]!.index]!,
              order,
            ) < 0
          )
            bestIndex = i;
        }
        if (bestIndex === -1) break;
        const best = streams[bestIndex]!;
        const doc = best.buffer[best.index++]!;
        annotateDocument(doc, partitionPaths);
        batch.push(doc);
        remaining--;
        const needsRefill = best.index >= best.buffer.length && !best.done;
        if (remaining > 0 && needsRefill) {
          if (batch.length > 0) {
            yield { documents: batch };
            batch = [];
          }
          await fill(best);
        } else if (batch.length >= batchLimit) {
          yield { documents: batch };
          batch = [];
        }
      }
      if (batch.length > 0) yield { documents: batch };
    },
  };
}
