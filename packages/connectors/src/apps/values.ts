import { isRecordObject, valueAt } from '../rest/records.js';
import { ConnectorError } from '../types.js';
import type { AppObject } from './types.js';

type Values = NonNullable<AppObject['values']>;

/** Resolve duplicate display names deterministically, including collisions with native field IDs. */
export function fieldLabels(document: unknown, values: Values): Map<string, string> {
  const labels = values.labels!;
  const records = valueAt(document, labels.endpoint.records);
  if (!Array.isArray(records)) throw new ConnectorError('sources.app.discovery');
  const fields = new Map<string, string>();
  const reserved = new Set<string>();
  const pattern = new RegExp(labels.pattern);
  for (const record of records) {
    const id = valueAt(record, labels.id);
    const name = valueAt(record, labels.name);
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !name.trim() ||
      Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw new ConnectorError('sources.app.discovery');
    reserved.add(id);
    if (pattern.test(id)) {
      if (fields.has(id)) throw new ConnectorError('sources.app.discovery');
      fields.set(id, name.trim());
    }
  }
  const counts = new Map<string, number>();
  const maximum = 255 - values.member.length - 1;
  for (const name of fields.values()) {
    const shortened = name.slice(0, maximum);
    counts.set(shortened, (counts.get(shortened) ?? 0) + 1);
  }
  const result = new Map<string, string>();
  for (const [id, name] of [...fields].sort(([a], [b]) => a.localeCompare(b))) {
    let candidate = name.slice(0, maximum);
    let attempt = 0;
    while (reserved.has(candidate) || (counts.get(candidate) ?? 0) > 1) {
      const suffix = attempt++ === 0 ? ` (${id})` : ` (${id}, ${attempt})`;
      candidate = name.slice(0, Math.max(0, maximum - suffix.length)) + suffix;
    }
    reserved.add(candidate);
    result.set(id, candidate);
  }
  return result;
}

const TEXT_BLOCKS = new Set([
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'listItem',
  'bulletList',
  'orderedList',
  'table',
  'tableRow',
  'panel',
  'expand',
]);

/** Keep readable text, inline references, and block boundaries from a structured document. */
export function documentText(document: unknown): string {
  const render = (node: unknown): string => {
    if (!isRecordObject(node)) return '';
    if (node.type === 'text') return typeof node.text === 'string' ? node.text : '';
    if (node.type === 'hardBreak') return '\n';
    if (isRecordObject(node.attrs)) {
      if (node.type === 'status') return typeof node.attrs.text === 'string' ? node.attrs.text : '';
      if (node.type === 'date') {
        const timestamp = node.attrs.timestamp;
        if (typeof timestamp !== 'string' || !/^-?\d+$/.test(timestamp)) return '';
        const date = new Date(Number(timestamp));
        // UTC keeps date-only values independent of the sync host's time zone.
        return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
      }
      if (node.type === 'mention' || node.type === 'emoji')
        return String(node.attrs.text ?? node.attrs.shortName ?? '');
      if (node.type === 'inlineCard' || node.type === 'blockCard')
        return typeof node.attrs.url === 'string' ? node.attrs.url : '';
    }
    const text = Array.isArray(node.content) ? node.content.map(render).join('') : '';
    return TEXT_BLOCKS.has(String(node.type)) && !text.endsWith('\n') ? `${text}\n` : text;
  };
  return render(document).replace(/\n+$/, '');
}

function plainValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainValues);
  if (!isRecordObject(value)) return value;
  if (value.type === 'doc' && value.version === 1 && Array.isArray(value.content)) return documentText(value);
  return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, plainValues(inner)]));
}

/** Transform only record values, leaving keys and paging information intact. */
export function projectValues(
  document: unknown,
  recordsPath: string,
  values: Values,
  labels: ReadonlyMap<string, string>,
): unknown {
  const records = valueAt(document, recordsPath);
  if (!Array.isArray(records)) throw new ConnectorError('sources.app.records');
  for (const record of records) {
    if (!isRecordObject(record)) throw new ConnectorError('sources.app.records');
    const member = record[values.member];
    if (!isRecordObject(member)) continue;
    const seen = new Set<string>();
    record[values.member] = Object.fromEntries(
      Object.entries(member).map(([id, value]) => {
        const name = labels.get(id) ?? id;
        // Unlisted fields must never overwrite a discovered field with the same display name.
        if (seen.has(name)) throw new ConnectorError('sources.app.discovery');
        seen.add(name);
        return [name, values.richText ? plainValues(value) : value];
      }),
    );
  }
  return document;
}
