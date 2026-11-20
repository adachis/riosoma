import type { NoSqlConnection } from '@riosoma/contracts';
import { Leaf } from '../rest/records.js';
import { cachedToken, keepToken, tokenKey } from '../rest/http.js';
import { readServiceAccountKey, serviceAccountAssertion } from '../sheets/google.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { object, type DocumentBackend } from './backend.js';
import { client, endpoint, nextCursor, secret, type NoSqlOptions } from './http.js';
import type { Predicate, Scalar } from './query.js';
import { fieldParts } from './paths.js';

type Value = {
  nullValue?: null;
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  timestampValue?: string;
  bytesValue?: string;
  referenceValue?: string;
  geoPointValue?: { latitude: number; longitude: number };
  arrayValue?: { values?: Value[] };
  mapValue?: { fields?: Record<string, Value> };
};
type Document = { name: string; fields?: Record<string, Value> };
export function firestoreValue(v: Value): unknown {
  if (v.integerValue !== undefined)
    return Number.isSafeInteger(Number(v.integerValue))
      ? Number(v.integerValue)
      : new Leaf(v.integerValue, 'long', v.integerValue, v.integerValue);
  if (v.timestampValue !== undefined)
    return new Leaf({ date: v.timestampValue }, 'date', v.timestampValue, v.timestampValue);
  if (v.bytesValue !== undefined) return new Leaf(null, 'binary', undefined, null);
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(firestoreValue);
  if (v.mapValue)
    return Object.fromEntries(
      Object.entries(v.mapValue.fields ?? {}).map(([k, value]) => [k, firestoreValue(value)]),
    );
  return v.stringValue ?? v.doubleValue ?? v.booleanValue ?? v.referenceValue ?? v.geoPointValue ?? null;
}
export function firestoreDocument(document: Document): Record<string, unknown> {
  return {
    ...Object.fromEntries(Object.entries(document.fields ?? {}).map(([k, v]) => [k, firestoreValue(v)])),
    __name__: new Leaf(document.name, 'key', document.name, document.name),
  };
}
function typed(value: Scalar): Value {
  if (value === null) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
}
const fieldPath = (field: string) =>
  field === '__name__'
    ? field
    : fieldParts(field)
        .map((p) => '`' + p.replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`')
        .join('.');
function filter(p: Predicate): unknown {
  if ('terms' in p) {
    const parts = p.terms.map(filter).filter((part) => part !== undefined);
    if (!p.terms.length && p.op === 'or')
      return {
        fieldFilter: {
          field: { fieldPath: '__name__' },
          op: 'EQUAL',
          value: { referenceValue: 'projects/empty/databases/(default)/documents/empty/empty' },
        },
      };
    if (!parts.length) return undefined;
    return parts.length === 1 ? parts[0] : { compositeFilter: { op: p.op.toUpperCase(), filters: parts } };
  }
  return {
    fieldFilter: {
      field: { fieldPath: fieldPath(p.field) },
      op: {
        eq: 'EQUAL',
        ne: 'NOT_EQUAL',
        gt: 'GREATER_THAN',
        gte: 'GREATER_THAN_OR_EQUAL',
        lt: 'LESS_THAN',
        lte: 'LESS_THAN_OR_EQUAL',
      }[p.op],
      value: p.field === '__name__' ? { referenceValue: p.value } : typed(p.value),
    },
  };
}
export function firestoreBackend(
  ctx: ConnectorContext,
  connection: Extract<NoSqlConnection, { kind: 'firestore' }>,
  options: NoSqlOptions,
): DocumentBackend {
  const http = client(ctx, options);
  const base = endpoint(connection);
  const root = `/v1/projects/${encodeURIComponent(connection.projectId)}/databases/${encodeURIComponent(connection.database)}/documents`;
  async function authorization(): Promise<Record<string, string>> {
    // The emulator requires its reserved administrator marker for collection metadata.
    if (connection.emulator) return { authorization: 'Bearer owner' };
    const json = secret(ctx, 'serviceAccountJson');
    const key = tokenKey(['firestore', json]);
    const now = options.now?.().getTime() ?? Date.now();
    let token = cachedToken(key, now);
    if (!token) {
      const account = readServiceAccountKey(json);
      if (!account) throw new ConnectorError('sources.secretsMissing');
      const audience = 'https://oauth2.googleapis.com/token';
      const assertion = serviceAccountAssertion(
        account,
        'https://www.googleapis.com/auth/datastore',
        audience,
        Math.floor(now / 1000),
      );
      const response = await http<{ access_token: string; expires_in: number }>(audience, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion,
        }).toString(),
      });
      token = response.data.access_token;
      if (!token) throw new ConnectorError('sources.nosql.denied');
      keepToken(key, token, now + Math.min(response.data.expires_in || 3600, 3600) * 1000, now);
    }
    return { authorization: `Bearer ${token}` };
  }
  async function call<T>(path: string, body?: unknown): Promise<T> {
    return (
      await http<T>(base + path, {
        headers: { ...(await authorization()), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      })
    ).data;
  }
  return {
    async list() {
      const objects = connection.collectionGroups.map((name) => object(name, 'group'));
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await call<{ collectionIds?: string[]; nextPageToken?: string }>(
          root + ':listCollectionIds',
          { pageSize: 100, ...(cursor ? { pageToken: cursor } : {}) },
        );
        objects.push(...(page.collectionIds ?? []).map((name) => object(name)));
        cursor = nextCursor(seen, page.nextPageToken);
      } while (cursor);
      return objects;
    },
    async keys() {
      return ['__name__'];
    },
    async *pages(ref, predicate, order, limit) {
      const where = filter(predicate);
      const query = where !== undefined || order.length > 0 || ref.schema === 'group';
      const parent =
        root +
        (ref.schema && ref.schema !== 'group'
          ? '/' + ref.schema.split('/').map(encodeURIComponent).join('/')
          : '');
      let cursor: string | undefined;
      const seen = new Set<string>();
      let remaining = limit ?? Infinity;
      let last: Document | undefined;
      const inequalities = new Set<string>();
      const inspect = (p: Predicate): void => {
        if ('terms' in p) p.terms.forEach(inspect);
        else if (p.op !== 'eq') inequalities.add(p.field);
      };
      inspect(predicate);
      const sorts = [
        ...[...inequalities]
          .sort()
          .filter((field) => field !== '__name__')
          .map((field) => ({ field, direction: order.find((o) => o.field === field)?.direction ?? 'asc' })),
        ...order.filter((o) => o.field !== '__name__' && !inequalities.has(o.field)),
        { field: '__name__', direction: order.find((o) => o.field === '__name__')?.direction ?? 'asc' },
      ];
      do {
        const size = Math.min(1000, remaining);
        let documents: Document[];
        if (query) {
          const startValues = last
            ? sorts.map((o) =>
                o.field === '__name__'
                  ? { referenceValue: last!.name }
                  : fieldParts(o.field).reduce<Value | undefined>(
                      (value, key, i) => (i === 0 ? last!.fields?.[key] : value?.mapValue?.fields?.[key]),
                      undefined,
                    ),
              )
            : undefined;
          const rows = await call<{ document?: Document }[]>(parent + ':runQuery', {
            structuredQuery: {
              from: [{ collectionId: ref.name, allDescendants: ref.schema === 'group' }],
              ...(where ? { where } : {}),
              orderBy: sorts.map((o) => ({
                field: { fieldPath: fieldPath(o.field) },
                direction: o.direction === 'desc' ? 'DESCENDING' : 'ASCENDING',
              })),
              limit: size,
              ...(startValues ? { startAt: { values: startValues, before: false } } : {}),
            },
          });
          documents = rows.flatMap((r) => (r.document ? [r.document] : []));
          last = documents.at(-1);
          cursor = documents.length === size ? nextCursor(seen, last?.name) : undefined;
        } else {
          const page = await call<{ documents?: Document[]; nextPageToken?: string }>(
            `${parent}/${encodeURIComponent(ref.name)}?pageSize=${size}${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`,
          );
          documents = page.documents ?? [];
          cursor = nextCursor(seen, page.nextPageToken);
        }
        yield { documents: documents.map(firestoreDocument) };
        remaining -= documents.length;
      } while (cursor && remaining > 0);
    },
  };
}
