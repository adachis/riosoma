import { joinedSources, type TableMeta } from '@riosoma/contracts';

/**
 * Settings that name fields, such as a view's filter, a dashboard's tiles, or an automation's
 * steps, can hold values of those fields: a filter's "is more than 100,000", a step's "set Salary
 * to".  A person who can't see a field gets such settings with those values taken out, and can't
 * change settings that use a field they can't see, so what they send back never loses what they
 * weren't shown.
 */

/**
 * A copy of a setting without the values of fields in `hidden`: a filter condition on one keeps
 * its field and operator but loses its value, and a map keyed by field ID loses that key.
 */
export function redactConfig<T>(value: T, hidden: ReadonlySet<string>): T {
  if (!hidden.size) return value;
  return redact(value, hidden) as T;
}

function redact(value: unknown, hidden: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, hidden));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const hiddenField = 'fieldId' in value && typeof value.fieldId === 'string' && hidden.has(value.fieldId);
  for (const [key, item] of Object.entries(value)) {
    if (hidden.has(key)) continue;
    if (hiddenField && 'operator' in value && key === 'value') continue;
    // Empty comparisons keep show-if conditions valid and dormant without revealing hidden values.
    if (hiddenField && key === 'equals') {
      out[key] = '';
      continue;
    }
    out[key] = redact(item, hidden);
  }
  return out;
}

/** Whether a setting names any of these fields anywhere, including inside text such as a template. */
export function mentionsAny(value: unknown, ids: ReadonlySet<string>): boolean {
  if (!ids.size || value === undefined || value === null) return false;
  const text = JSON.stringify(value);
  for (const id of ids) if (text.includes(id)) return true;
  return false;
}

/** Source diagnostics follow the same field and record access on every read and delivery path. */
export function sourceDiagnostic<T extends { messageKey: string; params?: unknown; detail?: string }>(
  error: T,
  limited: boolean,
  hidden: ReadonlySet<string>,
): T {
  // Source errors can quote row values, and missing columns can name restricted fields.
  const withhold =
    (error.messageKey === 'sources.sync.keyDuplicate' && (limited || hidden.size > 0)) ||
    (['sources.sync.read', 'sources.sync.failed'].includes(error.messageKey) &&
      (limited || hidden.size > 0)) ||
    (error.messageKey === 'sources.sync.columnMissing' && hidden.size > 0);
  if (!withhold) return error;
  const { params: _params, detail: _detail, ...shown } = error;
  return shown as T;
}

/**
 * A table as someone a record rule limits may see it: a synced table's counts of added, changed,
 * and held records cover records they can't see, so they go.
 */
export function limitTable<T extends TableMeta>(
  table: T,
  limited: boolean,
  hidden: ReadonlySet<string> = new Set(),
  sourceHidden: ReadonlySet<string> = hidden,
): T {
  if (table.recordLock) table = { ...table, recordLock: redactConfig(table.recordLock, hidden) };
  if (table.joined)
    table = {
      ...table,
      joined: {
        ...table.joined,
        fields: table.joined.fields.flatMap((mapping) => {
          if (hidden.has(mapping.outputFieldId)) return [];
          const sources = joinedSources(mapping).filter((source) => !hidden.has(source.fieldId));
          if (!sources.length) return [];
          return [
            {
              ...sources[0]!,
              outputFieldId: mapping.outputFieldId,
              ...(sources.length > 1 ? { sources } : {}),
            },
          ];
        }),
      },
    };
  if (!table.source) return table;
  const status = table.source.status;
  const error = status.error;
  const shown = error ? sourceDiagnostic(error, limited, sourceHidden) : error;
  if (!limited && shown === error) return table;
  return {
    ...table,
    source: {
      ...table.source,
      status: {
        ...status,
        ...(limited ? { stats: null, held: null, progress: undefined } : {}),
        error: shown,
      },
    },
  };
}
