import { conditionalPredicate } from './conditional.js';
import type { FieldSpec, ResultType } from '@riosoma/contracts';
import { ident, join, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef, selectExpr } from './columns.js';
import { formulaExpression } from './formulas.js';

export function resultType(field: FieldSpec): ResultType {
  switch (field.type) {
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
    case 'number':
    case 'count':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
      return field.options.includeTime ? 'datetime' : 'date';
    case 'createdTime':
    case 'lastModifiedTime':
      return 'datetime';
    case 'changeLog':
    case 'user':
    case 'multipleSelect':
    case 'lineItems':
    case 'link':
      return 'array';
    case 'lookup':
    case 'rollup':
    case 'formula':
      return field.options.resultType;
    default:
      return 'text';
  }
}

export function rollupType(
  fn: Extract<FieldSpec, { type: 'rollup' }>['options']['fn'],
  target: FieldSpec,
): ResultType {
  switch (fn) {
    case 'sum':
    case 'average':
    case 'count':
    case 'countAll':
    case 'countUnique':
      return 'number';
    case 'and':
    case 'or':
      return 'boolean';
    case 'concatenate':
      return 'text';
    case 'arrayUnique':
      return 'array';
    default:
      return resultType(target);
  }
}

/** A choice's name, from the ID a single or multiple select holds, or NULL for an ID that isn't one. */
export function choiceName(field: StoredField, id: Sql): Sql {
  if (field.selectRead) return field.selectRead.name(id);
  const choices = 'choices' in field.options ? field.options.choices : [];
  if (!choices.length) return sql`NULL::text`;
  return sql`CASE ${join(
    choices.map((choice) => sql`WHEN ${id} = ${choice.id}::text THEN ${choice.name}::text`),
    ' ',
  )} ELSE NULL::text END`;
}

/** A multiple select's choices' names, in order, leaving out any ID that isn't a choice. */
function choiceNames(field: StoredField, alias?: string): Sql {
  return sql`ARRAY(SELECT named.name FROM (SELECT ${choiceName(field, sql`chosen.id`)} AS name, chosen.position
      FROM unnest(${columnRef(field, alias)}) WITH ORDINALITY AS chosen(id, position)) AS named
    WHERE named.name IS NOT NULL ORDER BY named.position)`;
}

export function displayExpr(field: StoredField, alias?: string): Sql {
  if (field.type === 'user') {
    if (!field.appSchema) throw new Error('People display requires the app schema');
    return sql`COALESCE((SELECT string_agg(u.name, ', ' ORDER BY person.position)
      FROM unnest(${columnRef(field, alias)}) WITH ORDINALITY AS person(id, position)
      JOIN ${ident(field.appSchema, 'users')} u ON u.id = person.id), '')`;
  }
  // A formula's value is JSON: its text shows without quotes, and an error shows nothing.  One that
  // only JavaScript computes has no text here, so it names nothing rather than failing the read.
  if (field.type === 'formula') {
    const expression = formulaExpression(field, alias);
    if (!expression) return sql`''::text`;
    const shown = sql`(SELECT CASE WHEN jsonb_typeof(shown.value) = 'object' THEN NULL
      ELSE shown.value #>> '{}' END FROM (SELECT ${expression} AS value) AS shown)`;
    return resultType(field) === 'number'
      ? sql`COALESCE(trim_scale((${shown})::numeric)::text, '')`
      : sql`COALESCE(${shown}, '')`;
  }
  if (resultType(field) === 'number')
    return sql`COALESCE(trim_scale((${columnRef(field, alias)})::numeric)::text, '')`;
  return sql`COALESCE((${selectExpr(field, alias)})::text, '')`;
}

/** Aliases include the field ID so nested lookups and self-links cannot shadow the outer row. */
export function linkedSource(field: StoredField, alias?: string, includeTrashed = false) {
  const relation = field.relation;
  if (!relation) return null;
  const other = relation.side === 'left' ? 'right' : 'left';
  const edge = `e_${field.id}`;
  const record = `r_${field.id}`;
  const draft = relation.draft?.alias === alias ? relation.draft : undefined;
  const edges = draft
    ? sql`FROM unnest(${draft.ids}::text[]) WITH ORDINALITY AS ${ident(edge)} (id, position)
      JOIN ${ident(relation.dataSchema, relation.linkedTableId)} AS ${ident(record)}
        ON ${ident(record, '__id')} = ${ident(edge, 'id')} WHERE TRUE`
    : sql`FROM ${ident(relation.dataSchema, `lnk_${relation.linkId}`)} AS ${ident(edge)}
    JOIN ${ident(relation.dataSchema, relation.linkedTableId)} AS ${ident(record)}
      ON ${ident(record, '__rid')} = ${ident(edge, `${other}_rid`)}
    WHERE ${ident(edge, `${relation.side}_rid`)} = ${ident(alias ?? field.tableId, '__rid')}`;
  let source = sql`${edges}
      AND ${includeTrashed ? sql`TRUE` : sql`${ident(record, '__deleted_at')} IS NULL AND NOT ${ident(record, '__source_gone')}`}
      AND ${relation.scope ? sql`(${relation.scope(record)})` : sql`TRUE`}
      AND ${conditionalPredicate(field, record, alias ?? field.tableId)}`;
  let position = draft ? sql`${ident(edge, 'position')}` : sql`${ident(edge, `${relation.side}_pos`)}`;
  if (field.type === 'lookup' && (field.options.sort?.length || field.options.limit)) {
    const fields = new Map(
      relation.conditionFields?.map((item) => [item.id, { ...item, readContext: field.readContext }]),
    );
    const order = (field.options.sort ?? []).flatMap((sort) => {
      const dependency = fields.get(sort.fieldId);
      return dependency
        ? [
            sql`${columnRef(dependency, record)} ${sort.direction === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`}`,
          ]
        : [];
    });
    order.push(position);
    const sorted = join(order, ', ');
    source = sql`FROM (SELECT ${ident(record)}.*, row_number() OVER (ORDER BY ${sorted}) AS __lookup_position
      ${source} ORDER BY ${sorted} ${field.options.limit ? sql`LIMIT ${field.options.limit}` : sql``}) AS ${ident(record)}`;
    position = sql`${ident(record, '__lookup_position')}`;
  }
  return { source, record, position };
}

/**
 * How many live records a link holds that a record rule hides from the reader, or null when no
 * rule limits the linked table.  They show as "Hidden record", with nothing about them but that.
 */
export function hiddenLinkCount(field: StoredField, alias?: string): Sql | null {
  const relation = field.relation;
  if ((field.type !== 'link' && field.type !== 'lineItems') || !relation?.scope) return null;
  const other = relation.side === 'left' ? 'right' : 'left';
  const edge = `h_${field.id}`;
  const record = `hr_${field.id}`;
  return sql`(SELECT count(*)::int FROM ${ident(relation.dataSchema, `lnk_${relation.linkId}`)} AS ${ident(edge)}
    JOIN ${ident(relation.dataSchema, relation.linkedTableId)} AS ${ident(record)}
      ON ${ident(record, '__rid')} = ${ident(edge, `${other}_rid`)}
    WHERE ${ident(edge, `${relation.side}_rid`)} = ${ident(alias ?? field.tableId, '__rid')}
      AND ${ident(record, '__deleted_at')} IS NULL AND NOT ${ident(record, '__source_gone')}
      AND (${relation.scope(record)}) IS NOT TRUE)`;
}

export function linkNamesExpr(field: StoredField, alias?: string, first = false): Sql {
  const linked = linkedSource(field, alias);
  const primary = field.relation?.primary;
  if (!linked || !primary) return sql`NULL::text`;
  const name = displayExpr(primary, linked.record);
  return first
    ? sql`(SELECT ${name} ${linked.source} ORDER BY ${linked.position} LIMIT 1)`
    : sql`(SELECT string_agg(${name}, ', ' ORDER BY ${linked.position}) ${linked.source})`;
}

/**
 * A link's linked records' names as a JSONB array of text, in link order, which is how formulas
 * read a link.  Each name is the record's primary field as `displayExpr` shows it, empty or not, so
 * a link names as many records as it holds.
 */
export function linkNamesJson(field: StoredField, alias?: string): Sql {
  const linked = linkedSource(field, alias);
  const primary = field.relation?.primary;
  if (!linked || !primary) return sql`'[]'::jsonb`;
  return sql`(SELECT COALESCE(jsonb_agg(to_jsonb(${displayExpr(primary, linked.record)})
    ORDER BY ${linked.position}), '[]'::jsonb) ${linked.source})`;
}

/**
 * Why a link's names can't be read, as JSONB, or SQL NULL when they can.  A primary field formula
 * that only JavaScript computes has no name here, so a link to any record of that table fails
 * rather than read as nameless, as a lookup of that formula does.  So does a primary field formula
 * with an error of its own, such as one that reads its own names back through links.
 */
export function linkNamesError(field: StoredField, alias?: string): Sql | null {
  const linked = linkedSource(field, alias);
  const primary = field.relation?.primary;
  if (!linked || primary?.type !== 'formula') return null;
  const broken = primary.formula?.error?.messageKey;
  const reason =
    broken === 'formula.field.circular'
      ? CIRCULAR
      : broken || !formulaExpression(primary, linked.record)
        ? UNNAMED
        : null;
  return reason ? sql`CASE WHEN EXISTS (SELECT 1 ${linked.source}) THEN ${reason} END` : null;
}

/**
 * Whether a lookup holds something formulas read by another name than the lookup's own value:
 * choices, which it holds as IDs, and links, which it holds as record IDs.
 */
export function readsByName(field: StoredField, seen = new Set<string>()): boolean {
  const target = field.relation?.target;
  if (field.type !== 'lookup' || !target || seen.has(target.id)) return false;
  return (
    ['singleSelect', 'multipleSelect', 'link'].includes(target.type) ||
    readsByName(target, new Set([...seen, field.id]))
  );
}

export function linkIdsExpr(field: StoredField, alias?: string, includeTrashed = false): Sql {
  const linked = linkedSource(field, alias, includeTrashed);
  return linked
    ? sql`ARRAY(SELECT ${ident(linked.record, '__id')} ${linked.source} ORDER BY ${linked.position})`
    : sql`ARRAY[]::text[]`;
}

/** What a lookup or rollup reads when its target is a formula that only JavaScript can compute. */
const UNSUPPORTED = sql`${JSON.stringify({ error: '#ERROR!', messageKey: 'formula.relation.unsupported' })}::jsonb`;
/**
 * What a formula reads from a link when the linked table's primary field is such a formula, or
 * one with an error, and when it's one that reads its own names back.
 */
const UNNAMED = sql`${JSON.stringify({ error: '#ERROR!', messageKey: 'formula.link.unnamed' })}::jsonb`;
const CIRCULAR = sql`${JSON.stringify({ error: '#ERROR!', messageKey: 'formula.field.circular' })}::jsonb`;

type Linked = NonNullable<ReturnType<typeof linkedSource>>;

/**
 * The target's value in each linked record, as JSONB with its link position, and the target's
 * error there, or SQL NULL.  `fails` is false when the target can't have an error at all.  A
 * formula's error arrives as its value, an object, where every other formula result is a scalar or
 * a list.  A lookup or rollup target brings its own error.  `named` reads the target as formulas
 * do: choices and linked records by name, where the lookup itself holds their IDs.
 */
function targetRows(target: StoredField, linked: Linked, named = false): { rows: Sql; fails: boolean } {
  if (target.type === 'formula') {
    const expression = formulaExpression(target, linked.record);
    if (!expression)
      return {
        rows: sql`SELECT NULL::jsonb AS value, ${UNSUPPORTED} AS error, ${linked.position} AS position ${linked.source}`,
        fails: true,
      };
    // Keep nested formula work shared when both the value and error read it.
    // Inlining duplicates these calculations at every level of a chain of rollups.
    return {
      rows: sql`WITH target_row AS MATERIALIZED (
          SELECT ${expression} AS raw, ${linked.position} AS position ${linked.source}
        )
        SELECT CASE WHEN jsonb_typeof(target_row.raw) = 'object' THEN NULL ELSE target_row.raw END AS value,
          CASE WHEN jsonb_typeof(target_row.raw) = 'object' THEN target_row.raw END AS error, target_row.position
        FROM target_row`,
      fails: true,
    };
  }
  const raw = named ? namedValue(target, linked.record) : null;
  const value =
    raw ?? (target.type === 'number' ? columnRef(target, linked.record) : selectExpr(target, linked.record));
  const error =
    named && (target.type === 'link' || target.type === 'lineItems')
      ? linkNamesError(target, linked.record)
      : relationError(target, linked.record, named);
  return {
    rows: sql`SELECT to_jsonb(${value}) AS value, ${error ?? sql`NULL::jsonb`} AS error, ${linked.position} AS position ${linked.source}`,
    fails: error !== null,
  };
}

/** A lookup target's value as formulas read it, where that differs from its own value, or null. */
function namedValue(target: StoredField, alias: string): Sql | null {
  if (target.type === 'singleSelect') return choiceName(target, columnRef(target, alias));
  if (target.type === 'multipleSelect') return choiceNames(target, alias);
  if (target.type === 'link' || target.type === 'lineItems') return linkNamesJson(target, alias);
  if (target.type === 'lookup' && readsByName(target)) return relationExpr(target, alias, true);
  return null;
}

/**
 * A lookup's or rollup's error for this record, as JSONB, or SQL NULL: the first error its target
 * has in a linked record, in link order.  Null when the field can't have one, like a count.
 */
export function relationError(field: StoredField, alias?: string, named = false): Sql | null {
  if (field.type !== 'lookup' && field.type !== 'rollup') return null;
  if (field.type === 'rollup' && field.options.fn === 'countAll') return null;
  const linked = linkedSource(field, alias);
  const target = field.relation?.target;
  if (!linked || !target) return null;
  const { rows, fails } = targetRows(target, linked, named && field.type === 'lookup');
  return fails
    ? computedError(
        field,
        sql`(SELECT failures.error FROM (${rows}) AS failures
      WHERE failures.error IS NOT NULL ORDER BY failures.position LIMIT 1)`,
        alias,
      )
    : null;
}

/**
 * A relational field's value.  A lookup or rollup whose target has an error in any linked record is
 * blank, and `relationError` says why.  Values of a type the rollup can't use, from a target whose
 * type changed, are left out rather than cast.  A lookup read `named` holds what formulas read:
 * choices' and linked records' names in place of their IDs.
 */
export function relationExpr(field: StoredField, alias?: string, named = false): Sql {
  const linked = linkedSource(field, alias);
  if (field.type === 'link' || field.type === 'lineItems') return linkIdsExpr(field, alias);
  if (field.type === 'count')
    return linked ? sql`(SELECT count(*)::numeric ${linked.source})` : sql`0::numeric`;
  const target = field.relation?.target;
  if (!linked || !target) return field.type === 'lookup' ? sql`'[]'::jsonb` : sql`NULL::numeric`;
  if (field.type === 'rollup' && field.options.fn === 'countAll')
    return sql`(SELECT count(*)::numeric ${linked.source})`;
  const { rows, fails } = targetRows(target, linked, named && field.type === 'lookup');
  // Scalar and list targets share one ordered stream, retaining duplicate values.
  const stream = sql`SELECT item.value, row.position, item.ordinality, row.error FROM (${rows}) AS row
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(row.value) = 'array'
      THEN row.value ELSE jsonb_build_array(row.value) END) WITH ORDINALITY AS item(value, ordinality)`;
  const nonempty = sql`value IS NOT NULL AND value <> 'null'::jsonb AND value <> '""'::jsonb`;
  const read = (aggregate: Sql, from: Sql = sql`(${stream}) AS values`) =>
    fails
      ? sql`(SELECT CASE WHEN bool_or(error IS NOT NULL) THEN NULL ELSE ${aggregate} END FROM ${from})`
      : sql`(SELECT ${aggregate} FROM ${from})`;
  if (field.type === 'lookup')
    return read(
      sql`COALESCE(jsonb_agg(value ORDER BY position, ordinality) FILTER (WHERE ${nonempty}), '[]'::jsonb)`,
    );
  if (field.type !== 'rollup') return sql`NULL`;
  let leaf = target;
  const visited = new Set<string>();
  while (leaf.type === 'lookup' && leaf.relation?.target && !visited.has(leaf.id)) {
    visited.add(leaf.id);
    leaf = leaf.relation.target;
  }
  if (leaf.type === 'multiCurrency' && ['sum', 'average'].includes(field.options.fn))
    return sql`NULL::numeric`;
  const scalar =
    leaf.type === 'multiCurrency'
      ? sql`(value ->> 'code') || ' ' || (value ->> 'amount')`
      : sql`value #>> '{}'`;
  const number = sql`CASE WHEN jsonb_typeof(value) = 'number' THEN (${scalar})::numeric END`;
  const flag = sql`CASE WHEN jsonb_typeof(value) = 'boolean' THEN (${scalar})::boolean END`;
  // Whether a value counts as true, as formulas decide it: numbers other than zero, and any text.
  const truthy = sql`CASE jsonb_typeof(value) WHEN 'boolean' THEN (${scalar})::boolean
    WHEN 'number' THEN (${scalar})::numeric <> 0 ELSE true END`;
  const type = resultType(target);
  const typed = type === 'number' ? number : type === 'boolean' ? flag : scalar;
  const only = sql`FILTER (WHERE ${nonempty})`;
  switch (field.options.fn) {
    case 'count':
      return read(sql`(count(*) ${only})::numeric`);
    case 'countUnique':
      return read(sql`(count(DISTINCT value) ${only})::numeric`);
    case 'sum':
      return read(sql`COALESCE(sum(${number}) ${only}, 0)`);
    case 'average':
      return read(sql`avg(${number}) ${only}`);
    case 'min':
    case 'earliest':
      return read(type === 'boolean' ? sql`bool_and(${typed}) ${only}` : sql`min(${typed}) ${only}`);
    case 'max':
    case 'latest':
      return read(type === 'boolean' ? sql`bool_or(${typed}) ${only}` : sql`max(${typed}) ${only}`);
    case 'and':
      return read(sql`COALESCE(bool_and(${truthy}) ${only}, true)`);
    case 'or':
      return read(sql`COALESCE(bool_or(${truthy}) ${only}, false)`);
    case 'concatenate':
      return read(sql`COALESCE(string_agg(${scalar}, ', ' ORDER BY position, ordinality) ${only}, '')`);
    case 'arrayUnique':
      // Each distinct value once, where it first appears.
      return read(
        sql`COALESCE(jsonb_agg(value ORDER BY position, ordinality) FILTER (WHERE ${nonempty} AND first), '[]'::jsonb)`,
        sql`(SELECT items.*, row_number() OVER (PARTITION BY value ORDER BY position, ordinality) = 1 AS first
          FROM (${stream}) AS items) AS unique_items`,
      );
  }
  return sql`NULL`;
}
import { computedError } from './overrides.js';
