import { LIMITS, type RestEndpoint } from '@riosoma/contracts';
import { isRecordObject, valueAt } from '../rest/records.js';
import { ConnectorError } from '../types.js';
import type { AppPreset } from './types.js';

/** Split by encoded address length, including this page's cursor, rather than by field count. */
export function propertyRequests(url: URL, param: string, names: readonly string[]): URL[] {
  const requests: URL[] = [];
  let group: string[] = [];
  const address = (values: string[]) => {
    const next = new URL(url.href);
    next.searchParams.set(param, values.join(','));
    return next;
  };
  for (const name of names) {
    const next = [...group, name];
    if (address(next).href.length > LIMITS.urlLength || next.join(',').length > 2_000) {
      if (!group.length) throw new ConnectorError('sources.app.propertyTooLong');
      requests.push(address(group));
      group = [name];
      if (address(group).href.length > LIMITS.urlLength)
        throw new ConnectorError('sources.app.propertyTooLong');
    } else group = next;
  }
  if (group.length) requests.push(address(group));
  if (!requests.length) {
    const empty = new URL(url.href);
    empty.searchParams.delete(param);
    if (empty.href.length > LIMITS.urlLength) throw new ConnectorError('sources.app.propertyTooLong');
    requests.push(empty);
  }
  return requests;
}

export function propertyNames(document: unknown, properties: NonNullable<AppPreset['properties']>): string[] {
  const records = valueAt(document, properties.records);
  if (!Array.isArray(records)) throw new ConnectorError('sources.app.discovery');
  const names = new Set<string>();
  for (const record of records) {
    if (!isRecordObject(record)) throw new ConnectorError('sources.app.discovery');
    if (valueAt(record, properties.hidden) === true) continue;
    const name = valueAt(record, properties.name);
    if (
      typeof name !== 'string' ||
      !name ||
      name.includes(',') ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new ConnectorError('sources.app.discovery');
    names.add(name);
  }
  return [...names];
}

/** Join the same page by its declared key, refusing a changed page instead of losing records. */
export function mergePropertyPages(
  documents: unknown[],
  endpoint: RestEndpoint,
  key: string,
  member: string,
  names: readonly string[],
): unknown {
  const first = documents[0];
  const rows = valueAt(first, endpoint.records);
  if (!Array.isArray(rows)) throw new ConnectorError('sources.app.records');
  const byKey = new Map<unknown, Record<string, unknown>>();
  const allowed = new Set(names);
  for (const row of rows) {
    if (!isRecordObject(row) || !['string', 'number'].includes(typeof valueAt(row, key)))
      throw new ConnectorError('sources.app.batchChanged');
    const id = valueAt(row, key);
    if (byKey.has(id)) throw new ConnectorError('sources.app.batchChanged');
    const values = row[member];
    row[member] = isRecordObject(values)
      ? Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)))
      : {};
    byKey.set(id, row);
  }
  for (const document of documents.slice(1)) {
    const extra = valueAt(document, endpoint.records);
    if (!Array.isArray(extra) || extra.length !== rows.length)
      throw new ConnectorError('sources.app.batchChanged');
    if (
      endpoint.paging.style === 'cursor' &&
      valueAt(document, endpoint.paging.cursorPath) !== valueAt(first, endpoint.paging.cursorPath)
    )
      throw new ConnectorError('sources.app.batchChanged');
    const seen = new Set<unknown>();
    for (const row of extra) {
      if (!isRecordObject(row)) throw new ConnectorError('sources.app.batchChanged');
      const id = valueAt(row, key);
      const target = byKey.get(id);
      const values = row[member];
      if (!target || seen.has(id) || !isRecordObject(values))
        throw new ConnectorError('sources.app.batchChanged');
      seen.add(id);
      Object.assign(
        target[member] as Record<string, unknown>,
        Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name))),
      );
    }
  }
  return first;
}
