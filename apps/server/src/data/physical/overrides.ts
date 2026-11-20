import { ident, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';

/** Keep explicit null pins distinct from the absence of a pin. */
export function computedOverride(field: StoredField, source: Sql, alias?: string): Sql {
  if (field.ignoreOverride) return source;
  const stored = alias ? ident(alias, '__overrides') : ident('__overrides');
  return sql`CASE WHEN ${stored} -> ${field.id} ? 'value'
    THEN ${stored} -> ${field.id} -> 'value' ELSE ${source} END`;
}

/** A valid pin supplies a value even when the unpinned computation has an error. */
export function computedError(field: StoredField, error: Sql, alias?: string): Sql {
  if (field.ignoreOverride) return error;
  const stored = alias ? ident(alias, '__overrides') : ident('__overrides');
  return sql`CASE WHEN ${stored} -> ${field.id} ? 'value' THEN NULL::jsonb ELSE ${error} END`;
}
