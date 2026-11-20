import { Leaf } from '../rest/records.js';
import type { NoSqlConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { object, type DocumentBackend } from './backend.js';
import { client, endpoint, nextCursor, secret, type NoSqlOptions } from './http.js';
import { mango, querySql } from './query.js';

type Doc = Record<string, unknown>;
function identified(doc: Doc): Doc {
  const id = doc._id;
  return { ...doc, ...(typeof id === 'string' ? { _id: new Leaf(id, 'key', id, id) } : {}) };
}
export function couchBackend(
  ctx: ConnectorContext,
  connection: Extract<NoSqlConnection, { kind: 'couchdb' | 'couchbase' }>,
  options: NoSqlOptions,
): DocumentBackend {
  const http = client(ctx, options);
  const base = endpoint(connection);
  const headers = {
    authorization: `Basic ${Buffer.from(`${connection.user}:${secret(ctx, 'password')}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  const call = async <T>(path: string, body?: unknown) =>
    (
      await http<T>(base + path, {
        headers,
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      })
    ).data;
  const query = async <T>(statement: string, args: unknown[] = []) => {
    const result = await call<{ results?: T[]; status: string }>('/query/service', {
      statement,
      args,
      readonly: true,
      scan_consistency: 'request_plus',
      timeout: `${ctx.timeoutMs ?? 30000}ms`,
    });
    if (result.status !== 'success' || !result.results) throw new ConnectorError('sources.sync.read');
    return result.results;
  };
  if (connection.kind === 'couchbase')
    return {
      async list() {
        const rows = await query<{ name: string; bucket?: string; scope?: string }>(
          'SELECT k.name, k.`bucket`, k.`scope` FROM system:keyspaces AS k',
        );
        return rows.map((row) =>
          object(
            row.bucket ? row.name : '_default',
            JSON.stringify([row.bucket ?? row.name, row.scope ?? '_default']),
          ),
        );
      },
      async keys() {
        return ['_id'];
      },
      async *pages(ref, predicate, order, limit) {
        let namespace: unknown;
        try {
          namespace = JSON.parse(ref.schema ?? '[]');
        } catch {
          throw new ConnectorError('sources.nosql.filter');
        }
        if (
          !Array.isArray(namespace) ||
          namespace.length !== 2 ||
          !namespace.every((p) => typeof p === 'string')
        )
          throw new ConnectorError('sources.nosql.filter');
        const target = [...namespace, ref.name]
          .map((p) => '`' + String(p).replaceAll('`', '``') + '`')
          .join('.');
        const compiled = querySql(predicate, 'couchbase');
        const sorts = [...order, { field: '_id', direction: 'asc' }];
        let offset = 0;
        for (;;) {
          const size = Math.min(1000, (limit ?? Infinity) - offset);
          if (size <= 0) break;
          const documents = await query<Doc>(
            `SELECT c.*, META(c).id AS _id FROM ${target} AS c WHERE ${compiled.where} ORDER BY ${sorts.map((o) => `(${compiled.field(o.field)} IS MISSING OR ${compiled.field(o.field)} IS NULL) ASC, ${compiled.field(o.field)} ${o.direction.toUpperCase()}`).join(', ')} LIMIT ${size} OFFSET ${offset}`,
            compiled.parameters,
          );
          yield { documents: documents.map(identified) };
          offset += documents.length;
          if (documents.length < size) break;
        }
      },
    };
  return {
    async list() {
      return (await call<string[]>('/_all_dbs'))
        .filter((name) => !name.startsWith('_'))
        .map((name) => object(name));
    },
    async keys() {
      return ['_id'];
    },
    async checkpoint(ref) {
      return String(
        (await call<{ update_seq: string | number }>(`/${encodeURIComponent(ref.name)}`)).update_seq,
      );
    },
    async *changes(ref, since) {
      const seen = new Set<string>();
      let cursor = since;
      for (;;) {
        const page = await call<{
          results: { id: string; deleted?: boolean; doc?: Doc }[];
          last_seq: string | number;
          pending?: number;
        }>(
          `/${encodeURIComponent(ref.name)}/_changes?include_docs=true&limit=1000&since=${encodeURIComponent(cursor)}`,
        );
        const documents = page.results
          .filter((r) => !r.deleted && r.doc && !r.id.startsWith('_design/'))
          .map((r) => r.doc!);
        const deleted = page.results
          .filter((r) => r.deleted && !r.id.startsWith('_design/'))
          .map((r) => r.id);
        cursor = String(page.last_seq);
        yield { documents: documents.map(identified), deleted, cursor };
        if (page.pending === 0 || page.results.length === 0) break;
        nextCursor(seen, cursor);
      }
    },
    async *pages(ref, predicate, order, limit) {
      const selector = mango(predicate);
      const filtered = Object.keys(selector).length > 0 || order.length > 0;
      let cursor: string | undefined;
      let remaining = limit ?? Infinity;
      const seen = new Set<string>();
      do {
        const size = Math.min(1000, remaining);
        let documents: Doc[];
        if (filtered) {
          const page = await call<{ docs: Doc[]; bookmark?: string }>(
            `/${encodeURIComponent(ref.name)}/_find`,
            {
              selector,
              limit: size,
              ...(order.length ? { sort: order.map((o) => ({ [o.field]: o.direction })) } : {}),
              ...(cursor ? { bookmark: cursor } : {}),
            },
          );
          documents = page.docs.filter(
            (doc) => typeof doc._id !== 'string' || !doc._id.startsWith('_design/'),
          );
          if (!page.docs.length) break;
          cursor = nextCursor(seen, page.bookmark);
        } else {
          const page = await call<{ rows: { id: string; doc?: Doc }[] }>(
            `/${encodeURIComponent(ref.name)}/_all_docs?include_docs=true&limit=${size}${cursor ? `&startkey=${encodeURIComponent(JSON.stringify(cursor))}&skip=1` : ''}`,
          );
          documents = page.rows.flatMap((r) => (r.doc && !r.id.startsWith('_design/') ? [r.doc] : []));
          cursor = page.rows.length === size ? nextCursor(seen, page.rows.at(-1)?.id) : undefined;
        }
        yield { documents: documents.map(identified) };
        remaining -= documents.length;
      } while (cursor && remaining > 0);
    },
  };
}
