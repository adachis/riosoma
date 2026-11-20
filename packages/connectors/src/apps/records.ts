import type { RestEndpoint } from '@riosoma/contracts';
import { isRecordObject, textAt, valueAt } from '../rest/records.js';
import { ConnectorError } from '../types.js';
import type { AppPreset, AppRecordProjection, AppValueProjection } from './types.js';

/** Envelope failures expose the declared status without carrying the API's answer into diagnostics. */
export function checkResponse(document: unknown, response: AppPreset['response']): unknown {
  if (!response) return document;
  const code = valueAt(document, response.code);
  if (code !== response.success)
    throw new ConnectorError(
      typeof code === 'number' && response.denied.includes(code)
        ? 'sources.rest.deniedKey'
        : 'sources.rest.status',
      undefined,
      typeof code === 'number' ? { status: code } : undefined,
    );
  return document;
}

/** Object parts read as words, while lists retain the API source's comma-separated conversion. */
function answerValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(answerValue);
  if (!isRecordObject(value)) return value;
  return Object.values(value)
    .map(answerValue)
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => (Array.isArray(part) ? part.join(', ') : (textAt({ part }, 'part') ?? String(part))))
    .join(' ');
}

/** A declared discriminator selects only the API fields the preset names. */
function projectedValue(record: unknown, rule: AppValueProjection, definition?: unknown): unknown {
  if (typeof rule === 'string') return rule === '' ? record : answerValue(valueAt(record, rule));
  const type = valueAt(record, rule.discriminator);
  if (typeof type !== 'string' || !Object.hasOwn(rule.variants, type))
    throw new ConnectorError('sources.app.records');
  const variant = rule.variants[type]!;
  if (typeof variant === 'string') return answerValue(valueAt(record, variant));
  if ('first' in variant)
    return variant.first
      .map((path) => answerValue(valueAt(record, path)))
      .find((value) => value != null && value !== '');
  return variant.join
    .map((path) =>
      answerValue(
        typeof path === 'string'
          ? valueAt(record, path)
          : (valueAt(record, path.path) ?? valueAt(definition, path.definitionFallback)),
      ),
    )
    .filter((value) => value != null)
    .join(variant.separator);
}

/** Complete definitions keep column names stable across pages, previews, and later reads. */
export function recordProjection(
  projection: AppRecordProjection,
  endpoint: RestEndpoint,
  definitions: unknown,
) {
  const questions = valueAt(definitions, projection.definitions.records);
  const entries: Array<[string, unknown]> = [];
  if (projection.definitions.id) {
    const visit = (records: unknown) => {
      if (!Array.isArray(records)) throw new ConnectorError('sources.app.records');
      for (const record of records) {
        if (!isRecordObject(record)) throw new ConnectorError('sources.app.records');
        const children = projection.definitions.children
          ? valueAt(record, projection.definitions.children)
          : undefined;
        if (children !== undefined) visit(children);
        else {
          const id = textAt(record, projection.definitions.id!);
          if (!id) throw new ConnectorError('sources.app.records');
          entries.push([id, record]);
        }
      }
    };
    visit(questions);
  } else {
    if (!isRecordObject(questions)) throw new ConnectorError('sources.app.records');
    entries.push(...Object.entries(questions));
  }
  const columns = new Map<string, { name: string; definition: unknown }>();
  const used = new Set([...projection.keep, ...Object.keys(projection.fields ?? {})]);
  const unique = (base: string) => {
    base = base.slice(0, 255);
    let name = base;
    for (let suffix = 2; used.has(name); suffix++) {
      const tail = ` (${suffix})`;
      name = `${base.slice(0, 255 - tail.length)}${tail}`;
    }
    used.add(name);
    return name;
  };
  for (const [id, question] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!isRecordObject(question) || columns.has(id)) throw new ConnectorError('sources.app.records');
    const label = textAt(question, projection.label)?.trim();
    columns.set(id, {
      name: unique(label || textAt(question, projection.fallback)?.trim() || id),
      definition: question,
    });
  }
  const additionalNames = new Map<string, string>();
  const members = (value: unknown, id?: string): Array<[string, unknown]> => {
    if (value === null || value === undefined) return [];
    if (id) {
      if (!Array.isArray(value)) throw new ConnectorError('sources.app.records');
      const seen = new Set<string>();
      return value.map((record) => {
        const key = textAt(record, id);
        if (!key || seen.has(key)) throw new ConnectorError('sources.app.records');
        seen.add(key);
        return [key, record];
      });
    }
    if (!isRecordObject(value)) throw new ConnectorError('sources.app.records');
    return Object.entries(value);
  };
  return Object.assign(
    (document: unknown): unknown => {
      const rows = valueAt(document, endpoint.records);
      if (!Array.isArray(rows)) throw new ConnectorError('sources.app.records');
      for (let index = 0; index < rows.length; index++) {
        const row: unknown = rows[index];
        if (!isRecordObject(row)) throw new ConnectorError('sources.app.records');
        const mapped = Object.fromEntries([
          ...projection.keep.map((name) => [name, row[name] ?? null]),
          ...Object.entries(projection.fields ?? {}).map(([name, path]) => [
            name,
            valueAt(row, path) ?? null,
          ]),
          ...[...columns.values()].map(({ name }) => [name, null]),
        ]);
        for (const [id, answer] of members(valueAt(row, projection.member), projection.id)) {
          const column = columns.get(id);
          // An unknown question must not move an answer into another question's saved column.
          if (!column) throw new ConnectorError('sources.app.records');
          if (projection.value !== '' && !isRecordObject(answer))
            throw new ConnectorError('sources.app.records');
          mapped[column.name] = projectedValue(answer, projection.value, column.definition) ?? null;
        }
        for (const extra of projection.additional ?? [])
          for (const [id, value] of members(valueAt(row, extra.member), extra.id).sort(([a], [b]) =>
            a.localeCompare(b),
          )) {
            const key = `${extra.member}:${id}`;
            if (!additionalNames.has(key)) additionalNames.set(key, unique(`${extra.prefix}${id}`));
            Object.defineProperty(mapped, additionalNames.get(key)!, {
              value: projectedValue(value, extra.value) ?? null,
              enumerable: true,
            });
          }
        rows[index] = mapped;
      }
      return document;
    },
    { columns: [...used] },
  );
}
