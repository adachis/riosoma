import type { GridGroup } from '@riosoma/contracts';
import { ident, join, keyword, sql, type Sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { columnRef, selectExpr } from './columns.js';
import { formulaExpression, formulaScalar } from './formulas.js';
import { displayExpr, resultType } from './relations.js';

/** One key per record, including the complete combination in a multiple-value field. */
export function groupExpression(
  field: StoredField | undefined,
  group: GridGroup,
  ctx: ReadContext,
  computed?: ReadonlyMap<string, Sql>,
): Sql {
  if (!field || field.type === 'changeLog') return sql`NULL::text`;
  const type = resultType(field);
  const evaluated = computed?.get(field.id);
  const col = evaluated
    ? field.type === 'lookup' || type === 'array'
      ? evaluated
      : sql`(${evaluated} #>> '{}')`
    : field.type === 'formula'
      ? type === 'array'
        ? (formulaExpression(field, undefined, ctx) ?? sql`NULL::jsonb`)
        : formulaScalar(field, undefined, ctx)
      : columnRef(field);
  if (type === 'date' || type === 'datetime') {
    let dated: StoredField = field;
    const seen = new Set<string>();
    while (dated.type === 'lookup' && dated.relation?.target && !seen.has(dated.id)) {
      seen.add(dated.id);
      dated = dated.relation.target;
    }
    const zone =
      'timeZone' in dated.options && dated.options.timeZone !== 'client'
        ? dated.options.timeZone
        : ctx.timeZone;
    const bucket = (value: Sql) => {
      const day =
        type === 'date'
          ? sql`(${value})::date::timestamp`
          : sql`((${value})::timestamptz AT TIME ZONE ${zone})`;
      return sql`to_char(date_trunc(${group.dateGranularity ?? 'day'}, ${day}), 'YYYY-MM-DD')`;
    };
    if (field.type === 'lookup')
      return sql`NULLIF((SELECT jsonb_agg(value ORDER BY value) FROM
      (SELECT DISTINCT ${bucket(sql`member`)} AS value FROM (SELECT ${col} AS value) grouped_dates,
        LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(grouped_dates.value) = 'array'
          THEN grouped_dates.value ELSE '[]'::jsonb END) member) days), '[]'::jsonb)`;
    return bucket(col);
  }
  if (
    field.type === 'multipleSelect' ||
    field.type === 'user' ||
    field.type === 'link' ||
    field.type === 'attachment'
  )
    return sql`NULLIF(to_jsonb(ARRAY(SELECT DISTINCT member FROM unnest(${col}) member ORDER BY member)), '[]'::jsonb)`;
  if (field.type === 'lookup' || type === 'array')
    return sql`NULLIF((SELECT jsonb_agg(member ORDER BY member) FROM (SELECT ${col} AS value) grouped_array,
      LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(grouped_array.value) = 'array'
        THEN grouped_array.value ELSE '[]'::jsonb END) member), '[]'::jsonb)`;
  if (type === 'number') return sql`(${col})::numeric`;
  if (type === 'boolean') return sql`COALESCE((${col})::boolean, false)`;
  if (field.type === 'location' || field.type === 'signature' || field.type === 'multiCurrency') return col;
  if (field.type === 'dateRange') return selectExpr(field);
  return sql`NULLIF((${col})::text, '') COLLATE "C"`;
}

/** A group's value order, with an exact key tie-breaker so equal labels never interleave. */
export function groupOrder(
  value: Sql,
  field: StoredField | undefined,
  direction: GridGroup['direction'],
  appSchema?: string,
): Sql {
  const way = keyword(direction === 'desc' ? 'DESC' : 'ASC');
  const ordered = (label: Sql) => sql`${label} ${way} NULLS LAST, ${value} ${way} NULLS LAST`;
  if (field?.type === 'multiCurrency')
    return sql`(${value} ->> 'code') COLLATE "C" ${way} NULLS LAST,
      (${value} ->> 'amount')::numeric ${way} NULLS LAST`;
  if (field?.type === 'singleSelect')
    return ordered(
      field.selectRead?.rank(value) ??
        sql`array_position(${field.options.choices.map((choice) => choice.id)}::text[], ${value})`,
    );
  if (field?.type === 'multipleSelect') {
    const rank =
      field.selectRead?.rank(sql`member`) ??
      sql`array_position(${field.options.choices.map((choice) => choice.id)}::text[], member)`;
    return ordered(
      sql`(SELECT array_agg(${rank} ORDER BY ${rank}) FROM jsonb_array_elements_text(${value}) member)`,
    );
  }
  if (appSchema && field?.type === 'user')
    return ordered(sql`(SELECT array_agg(COALESCE(person.name, member) ORDER BY COALESCE(person.name, member) COLLATE "C")
      FROM jsonb_array_elements_text(${value}) member LEFT JOIN ${ident(appSchema, 'users')} person ON person.id = member)`);
  if (appSchema && (field?.type === 'createdBy' || field?.type === 'lastModifiedBy'))
    return ordered(
      sql`(SELECT person.name FROM ${ident(appSchema, 'users')} person WHERE person.id = ${value})`,
    );
  if (field?.type === 'link' && field.relation?.primary) {
    const relation = field.relation;
    const name = displayExpr(relation.primary!, 'group_name');
    return ordered(sql`(SELECT array_agg(${name} ORDER BY ${name} COLLATE "C")
      FROM ${ident(relation.dataSchema, relation.linkedTableId)} group_name
      WHERE group_name.__id IN (SELECT jsonb_array_elements_text(${value})))`);
  }
  return sql`${value} ${way} NULLS LAST`;
}

export function compileGroupOrder(
  groups: readonly GridGroup[],
  fields: ReadonlyMap<string, StoredField>,
  ctx: ReadContext,
  computed?: ReadonlyMap<string, Sql>,
  appSchema?: string,
): Sql {
  if (!groups.length) return sql``;
  return sql`${join(
    groups.map((group) =>
      groupOrder(
        groupExpression(fields.get(group.fieldId), group, ctx, computed),
        fields.get(group.fieldId),
        group.direction,
        appSchema,
      ),
    ),
    ', ',
  )}, `;
}
