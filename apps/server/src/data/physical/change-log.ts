import { ident, sql, type Sql } from '@riosoma/db';
import { recordHistoryQuery } from '../history-query.js';
import type { StoredField } from '../types.js';

/**
 * The same fields naming only the history fields in `allowed`, at any depth.  A shared view's
 * history respects the fields its owner chose to share, and a change log a lookup's target, a link's
 * primary field, a formula, or a lookup's own filter and sort reaches names no history outside
 * `allowed` either.
 */
export function limitHistoryFields(
  fields: readonly StoredField[],
  allowed: ReadonlySet<string>,
): StoredField[] {
  const memo = new Map<string, StoredField>();
  const limit = (field: StoredField): StoredField => {
    const known = memo.get(field.id);
    if (known) return known;
    const result = { ...field };
    memo.set(field.id, result);
    if (field.historyFields)
      result.historyFields = field.historyFields.filter((item) => allowed.has(item.id));
    if (field.formula) result.formula = { ...field.formula, fields: field.formula.fields.map(limit) };
    if (field.relation)
      result.relation = {
        ...field.relation,
        ...(field.relation.target ? { target: limit(field.relation.target) } : {}),
        ...(field.relation.primary ? { primary: limit(field.relation.primary) } : {}),
        ...(field.relation.conditionFields
          ? { conditionFields: field.relation.conditionFields.map(limit) }
          : {}),
      };
    return result;
  };
  return fields.map(limit);
}

/** History names only current fields admitted by the reader's access scope. */
export function changeLogExpression(field: StoredField, alias?: string): Sql {
  if (!field.appSchema || !field.dataSchema || !field.historyFields?.length) return sql`NULL::jsonb`;
  const record = sql`${ident(alias ?? field.tableId, '__id')}`;
  const database = sql`(SELECT database_id FROM ${ident(field.appSchema, 'tables')} WHERE id = ${field.tableId})`;
  const history = recordHistoryQuery({ app: field.appSchema }, database, field.tableId, record);
  const allowed = field.historyFields.map((item) => item.id);
  return sql`(SELECT jsonb_agg(entry ORDER BY seq DESC) FROM (
    SELECT h.seq, jsonb_build_object('at', h.at, 'actorId', h.actor_id, 'fieldIds', names.ids) AS entry
    FROM (${history}) h
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(DISTINCT keys.id ORDER BY keys.id) AS ids
      FROM jsonb_array_elements(COALESCE(h.body -> 'records', '[]'::jsonb)) history_value,
        jsonb_object_keys(COALESCE(history_value -> 'values', '{}'::jsonb)) keys(id)
      WHERE history_value ->> 'id' = ${record} AND keys.id = ANY(${allowed}::text[])
    ) names
    WHERE names.ids IS NOT NULL ORDER BY h.seq DESC LIMIT 50
  ) entries)`;
}
