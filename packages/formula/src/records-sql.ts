import { ident, join, sql, type Sql } from '@riosoma/db';
import { lowerSql } from './casing.js';
import { fieldList, fieldType, type Ast, type Fields } from './ast.js';
import type { SqlContext } from './sql.js';

const error = (messageKey: string) => sql`${JSON.stringify({ error: '#ERROR!', messageKey })}::jsonb`;
const scalar = (value: Sql) => sql`(${value} #>> '{}')`;
const blank = (value: Sql) =>
  sql`(${value} IS NULL OR ${value} = 'null'::jsonb OR ${value} = '""'::jsonb OR ${value} = '[]'::jsonb)`;
const fold = (value: Sql): Sql => lowerSql(value) ?? sql`lower(${value})`;
const normalize = (value: Sql) => sql`CASE WHEN ${blank(value)} THEN 'null'::jsonb
  WHEN jsonb_typeof(${value}) = 'string' THEN to_jsonb(${fold(scalar(value))}) ELSE ${value} END`;
const equal = (a: Sql, b: Sql) => sql`${normalize(a)} = ${normalize(b)}`;

/** A pattern is assembled a character at a time so user text never becomes a regular expression. */
function likePattern(body: Sql): Sql {
  return sql`(SELECT COALESCE(string_agg(CASE
    WHEN token[1] = '*' THEN '%' WHEN token[1] = '?' THEN '_'
    ELSE replace(replace(replace(CASE WHEN left(token[1], 1) = '~' AND length(token[1]) > 1
      THEN substr(token[1], 2) ELSE token[1] END, chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') END,
    '' ORDER BY position), '') FROM regexp_matches(${body}, '~.|.', 'gs') WITH ORDINALITY AS tokens(token, position))`;
}

function preparedCriterion(criterion: Sql): Sql {
  const overflow = ((1n << 1024n) - (1n << 970n)).toString();
  const underflow = `0.${(5n ** 1075n).toString().padStart(1075, '0')}`;
  return sql`SELECT parsed.*, ${likePattern(fold(sql`body`))} AS pattern, ${fold(sql`body`)} AS folded,
    CASE WHEN body ~ '^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]{1,4})?$' AND length(body) < 320
      THEN (SELECT CASE WHEN abs(n) >= ${overflow}::numeric THEN n
        WHEN abs(n) <= ${underflow}::numeric THEN 0::numeric
        ELSE (n::double precision)::text::numeric END FROM (SELECT body::numeric AS n OFFSET 0) AS numeric_input)
      END AS number
    FROM (SELECT c, COALESCE(substring(${scalar(sql`c`)} FROM '^(<=|>=|<>|=|<|>)'), '=') AS op,
      regexp_replace(${scalar(sql`c`)}, '^(<=|>=|<>|=|<|>)', '') AS body
      FROM (SELECT ${criterion} AS c OFFSET 0) AS input) AS parsed`;
}
function preparedMatch(value: Sql, name: string): Sql {
  const c = sql`${ident(name, 'c')}`,
    op = sql`${ident(name, 'op')}`;
  const body = sql`${ident(name, 'body')}`,
    pattern = sql`${ident(name, 'pattern')}`,
    number = sql`${ident(name, 'number')}`;
  return sql`(SELECT CASE WHEN jsonb_typeof(v) = 'object' OR jsonb_typeof(${c}) = 'object' THEN false
    WHEN ${blank(sql`v`)} OR ${blank(sql`expected`)} THEN
      CASE ${op} WHEN '=' THEN ${blank(sql`v`)} AND ${blank(sql`expected`)}
        WHEN '<>' THEN NOT (${blank(sql`v`)} AND ${blank(sql`expected`)}) ELSE false END
    WHEN jsonb_typeof(v) <> jsonb_typeof(expected) THEN ${op} = '<>'
    WHEN jsonb_typeof(v) = 'string' AND ${op} IN ('=', '<>') THEN
      (${fold(scalar(sql`v`))} LIKE ${pattern}) = (${op} = '=')
    ELSE CASE ${op} WHEN '=' THEN ${equal(sql`v`, sql`expected`)} WHEN '<>' THEN NOT (${equal(sql`v`, sql`expected`)})
      WHEN '<' THEN ${normalize(sql`v`)} < ${normalize(sql`expected`)} WHEN '<=' THEN ${normalize(sql`v`)} <= ${normalize(sql`expected`)}
      WHEN '>' THEN ${normalize(sql`v`)} > ${normalize(sql`expected`)} WHEN '>=' THEN ${normalize(sql`v`)} >= ${normalize(sql`expected`)} END END
    FROM (SELECT v, CASE WHEN jsonb_typeof(v) = 'number' AND ${number} IS NOT NULL THEN to_jsonb(${number})
      WHEN jsonb_typeof(${c}) = 'string' THEN to_jsonb(${body}) ELSE ${c} END AS expected
      FROM (SELECT ${value} AS v OFFSET 0) AS input OFFSET 0) AS criteria)`;
}
/** Plain text ranges avoid boxing every candidate while sharing the same prepared criterion. */
function preparedTextMatch(value: Sql, name: string): Sql {
  const c = sql`${ident(name, 'c')}`,
    op = sql`${ident(name, 'op')}`;
  const body = sql`${ident(name, 'folded')}`,
    pattern = sql`${ident(name, 'pattern')}`;
  const folded = fold(value);
  const empty = sql`(${value} IS NULL OR ${value} = '')`;
  const expectedEmpty = sql`(${c} IS NULL OR ${c} = 'null'::jsonb OR (jsonb_typeof(${c}) = 'string' AND ${body} = '') OR ${c} = '[]'::jsonb)`;
  return sql`(CASE WHEN jsonb_typeof(${c}) = 'object' THEN false
    WHEN ${empty} OR ${expectedEmpty} THEN CASE ${op}
      WHEN '=' THEN ${empty} AND ${expectedEmpty}
      WHEN '<>' THEN NOT (${empty} AND ${expectedEmpty}) ELSE false END
    WHEN jsonb_typeof(${c}) <> 'string' THEN ${op} = '<>'
    ELSE CASE ${op} WHEN '=' THEN ${folded} LIKE ${pattern} WHEN '<>' THEN NOT (${folded} LIKE ${pattern})
      WHEN '<' THEN ${folded} < ${body} WHEN '<=' THEN ${folded} <= ${body}
      WHEN '>' THEN ${folded} > ${body} WHEN '>=' THEN ${folded} >= ${body} END END)`;
}

export function criterionSql(value: Sql, criterion: Sql): Sql {
  return sql`(WITH criterion AS MATERIALIZED (${preparedCriterion(criterion)})
    SELECT ${preparedMatch(value, 'criterion')} FROM criterion)`;
}

type Compile = (ast: Ast, fields: Fields, context: SqlContext) => Sql | null;

/** Each source is scoped before aggregation or windowing, independently of the outer view. */
export function compileRecords(
  node: Extract<Ast, { kind: 'call' }>,
  fields: Fields,
  context: SqlContext,
  compile: Compile,
): Sql | null {
  const cross = node.name === 'XLOOKUP' || node.name.endsWith('IFS');
  const range = node.args[node.name === 'XLOOKUP' ? 1 : 0];
  const source = context.recordSource?.(cross && range?.kind === 'field' ? range.tableId : undefined);
  if (!source) return null;
  const read = (arg: Ast | undefined, context: SqlContext): Sql | null => {
    if (!arg) return sql`'null'::jsonb`;
    if (arg.kind === 'field') {
      const field = fieldList(fields).find((field) => field.id === arg.fieldId);
      const reference = field && context.columnRef(field);
      if (
        field &&
        reference &&
        !['formula', 'lookup', 'rollup', 'link', 'singleSelect', 'createdBy', 'lastModifiedBy'].includes(
          field.type,
        ) &&
        ['number', 'text', 'boolean'].includes(String(fieldType(field)))
      )
        return sql`to_jsonb(${reference})`;
    }
    return compile(
      arg.kind === 'field' && arg.tableName !== undefined
        ? { ...arg, tableName: undefined, tableId: undefined }
        : arg,
      fields,
      { ...context, arrayResult: true },
    );
  };
  const inner = (i: number) => read(node.args[i], source.context);
  const outer = (i: number) => read(node.args[i], context);
  const ownId = context.systemRef?.('id'),
    rowId = source.context.systemRef?.('id');
  const created = source.context.systemRef?.('createdAt');
  if (!ownId || !rowId || !created) return null;
  const from = sql`FROM ${source.from} WHERE ${source.where}`;
  const totalOf = (values: Sql, mean = false): Sql => {
    const reference: Extract<Ast, { kind: 'field' }> = {
      kind: 'field',
      name: 'values',
      fieldId: 'values',
      fieldType: 'lookup',
      valueType: { array: 'number' },
      start: node.start,
      end: node.end,
    };
    // Reuse the ordered numeric fold so overflow stays a cell error and rounding matches evaluation.
    return compile(
      { ...node, name: mean ? 'AVERAGE' : 'SUM', args: [reference] },
      [{ id: 'values', name: 'values', type: 'lookup', valueType: { array: 'number' } }],
      { ...source.context, columnRef: () => values, errorRef: () => null },
    )!;
  };
  if (node.name === 'XLOOKUP') {
    const subject = outer(0),
      key = inner(1),
      returned = inner(2),
      fallback = outer(3);
    const numericOption = (value: Sql | null): Sql | null =>
      value &&
      sql`CASE
      WHEN ${blank(value)} THEN '0'::jsonb WHEN ${value} = 'true'::jsonb THEN '1'::jsonb
      WHEN ${value} = 'false'::jsonb THEN '0'::jsonb ELSE ${value} END`;
    const mode = node.args[4] ? numericOption(outer(4)) : sql`'0'::jsonb`;
    const search = node.args[5] ? numericOption(outer(5)) : sql`'1'::jsonb`;
    if (!subject || !key || !returned || !fallback || !mode || !search) return null;
    const exact = equal(sql`candidate.key`, sql`input.value`);
    return sql`(SELECT CASE WHEN jsonb_typeof(input.value) = 'object' THEN input.value
      WHEN input.mode NOT IN ('0'::jsonb, '-1'::jsonb, '1'::jsonb, '2'::jsonb)
        OR input.search NOT IN ('1'::jsonb, '-1'::jsonb) THEN ${error('formula.runtime.argument')}
      ELSE COALESCE((SELECT CASE WHEN jsonb_typeof(candidate.key) = 'object' THEN candidate.key ELSE candidate.value END FROM
        (SELECT ${key} AS key, COALESCE(${returned}, 'null'::jsonb) AS value, ${created} AS created, ${rowId} AS id ${from}) AS candidate
        WHERE jsonb_typeof(candidate.key) = 'object' OR CASE WHEN input.mode = '2'::jsonb THEN ${criterionSql(sql`candidate.key`, sql`CASE WHEN jsonb_typeof(input.value) = 'string' THEN to_jsonb('=' || ${scalar(sql`input.value`)}) ELSE input.value END`)}
          ELSE ${exact} OR (jsonb_typeof(candidate.key) = jsonb_typeof(input.value) AND NOT ${blank(sql`candidate.key`)} AND
            ((input.mode = '-1'::jsonb AND ${normalize(sql`candidate.key`)} < ${normalize(sql`input.value`)}) OR
             (input.mode = '1'::jsonb AND ${normalize(sql`candidate.key`)} > ${normalize(sql`input.value`)}))) END
        ORDER BY (jsonb_typeof(candidate.key) = 'object') DESC, (CASE WHEN input.mode <> '2'::jsonb THEN ${exact} ELSE false END) DESC,
          CASE WHEN input.mode = '-1'::jsonb THEN ${normalize(sql`candidate.key`)} END DESC,
          CASE WHEN input.mode = '1'::jsonb THEN ${normalize(sql`candidate.key`)} END ASC,
          CASE WHEN input.search = '1'::jsonb THEN candidate.created END ASC,
          CASE WHEN input.search = '-1'::jsonb THEN candidate.created END DESC,
          CASE WHEN input.search = '1'::jsonb THEN candidate.id END ASC,
          CASE WHEN input.search = '-1'::jsonb THEN candidate.id END DESC LIMIT 1), ${fallback}) END
      FROM (SELECT ${subject} AS value, ${mode} AS mode, ${search} AS search) AS input)`;
  }
  if (cross) {
    const conditions: Sql[] = [],
      failures: Sql[] = [],
      criteria: Sql[] = [],
      names: Sql[] = [];
    for (let i = node.name === 'COUNTIFS' ? 0 : 1; i < node.args.length; i += 2) {
      const value = inner(i),
        criterion = outer(i + 1);
      if (!value || !criterion) return null;
      const name = `criterion_${i}`;
      criteria.push(sql`${ident(name)} AS MATERIALIZED (${preparedCriterion(criterion)})`);
      names.push(sql`${ident(name)}`);
      const range = node.args[i];
      const field = range?.kind === 'field' && fieldList(fields).find((item) => item.id === range.fieldId);
      const plainText = field && ['text', 'longText', 'email', 'url', 'phone', 'json'].includes(field.type);
      const column = plainText && source.context.columnRef(field);
      conditions.push(column ? preparedTextMatch(column, name) : preparedMatch(value, name));
      failures.push(sql`CASE WHEN jsonb_typeof(${ident(name, 'c')}) = 'object' THEN ${ident(name, 'c')} END`);
    }
    const selected = node.name === 'COUNTIFS' ? sql`'1'::jsonb` : inner(0);
    if (!selected) return null;
    if (node.name === 'SUMIFS' || node.name === 'AVERAGEIFS') {
      const total = totalOf(sql`totals.values`, node.name === 'AVERAGEIFS');
      const number = sql`CASE WHEN jsonb_typeof(value) = 'number' THEN (${scalar(sql`value`)})::double precision END`;
      // A generous bound leaves ordinary sums on the native ordered aggregate.  Extreme values use
      // the checked fold, since the database otherwise raises instead of returning a cell error.
      const result =
        node.name === 'SUMIFS'
          ? sql`CASE WHEN totals.safe THEN to_jsonb(COALESCE(totals.fast, 0::double precision)) ELSE ${total} END`
          : total;
      return sql`(WITH ${join(criteria, ', ')} SELECT COALESCE(${join(failures, ', ')},
        (SELECT COALESCE(totals.error, ${result}) FROM (SELECT
          COALESCE(jsonb_agg(value ORDER BY created, id), '[]'::jsonb) AS values,
          (jsonb_agg(value ORDER BY created, id) FILTER (WHERE jsonb_typeof(value) = 'object')) -> 0 AS error,
          bool_and(safe) AS safe,
          sum(CASE WHEN safe THEN ${number} END ORDER BY created, id) AS fast
          FROM (SELECT matching.*, COALESCE(sum(abs((${number})::numeric)) OVER (), 0) < 1e300::numeric AS safe
            FROM (SELECT ${selected} AS value, ${created} AS created, ${rowId} AS id ${from}
              AND ${join(conditions, ' AND ')}) AS matching) AS checked) AS totals)) FROM ${join(names, ', ')})`;
    }
    const number = sql`CASE WHEN jsonb_typeof(value) = 'number' THEN (${scalar(sql`value`)})::double precision END`;
    const total =
      node.name === 'COUNTIFS'
        ? sql`count(*)::double precision`
        : node.name === 'AVERAGEIFS'
          ? sql`avg(${number})`
          : node.name === 'MAXIFS'
            ? sql`COALESCE(max(${number}), 0::double precision)`
            : node.name === 'MINIFS'
              ? sql`COALESCE(min(${number}), 0::double precision)`
              : sql`COALESCE(sum(${number}), 0::double precision)`;
    return sql`(WITH ${join(criteria, ', ')} SELECT COALESCE(${join(failures, ', ')},
      (SELECT COALESCE((jsonb_agg(value) FILTER (WHERE jsonb_typeof(value) = 'object')) -> 0,
        ${node.name === 'AVERAGEIFS' ? sql`CASE WHEN count(${number}) = 0 THEN ${error('formula.runtime.divisionByZero')} END,` : sql``}
        to_jsonb(${total})) FROM (SELECT ${selected} AS value ${from} AND ${join(conditions, ' AND ')}) AS matching)) FROM ${join(names, ', ')})`;
  }
  const value = node.args[0] ? inner(0) : sql`'1'::jsonb`;
  const ordered =
    node.name === 'RANK'
      ? value
      : node.args[1] && !(node.args[1].kind === 'call' && node.args[1].name === 'BLANK')
        ? inner(1)
        : sql`to_jsonb(${created})`;
  const partition = node.args[2] ? inner(2) : sql`'null'::jsonb`;
  const direction = node.name === 'RANK' && node.args[1] ? outer(1) : sql`'0'::jsonb`;
  if (!value || !ordered || !partition || !direction) return null;
  const window = sql`PARTITION BY partition ORDER BY ordered ASC NULLS LAST, created, id ROWS UNBOUNDED PRECEDING`;
  let computed: Sql;
  if (node.name === 'RANK') {
    computed = sql`CASE WHEN jsonb_typeof(value) = 'object' THEN value WHEN ${blank(sql`value`)} THEN 'null'::jsonb
      WHEN ${direction} NOT IN ('0'::jsonb, '1'::jsonb, 'null'::jsonb) THEN ${error('formula.runtime.argument')}
      ELSE to_jsonb(CASE WHEN ${direction} = '1'::jsonb THEN rank() OVER (PARTITION BY partition ORDER BY ordered ASC NULLS LAST)
        ELSE rank() OVER (PARTITION BY partition ORDER BY ordered DESC NULLS LAST) END) END`;
  } else if (node.name === 'PREVIOUS' || node.name === 'NEXT') {
    computed =
      node.name === 'PREVIOUS' ? sql`lag(value) OVER (${window})` : sql`lead(value) OVER (${window})`;
  } else if (node.name === 'RUNNINGSUM') {
    const total = totalOf(sql`windowed.values`);
    return sql`(SELECT COALESCE(windowed.error, ${total}) FROM (SELECT id,
      jsonb_agg(value) OVER (${window}) AS values,
      (jsonb_agg(value) FILTER (WHERE jsonb_typeof(value) = 'object') OVER (${window})) -> 0 AS error FROM
      (SELECT ${rowId} AS id, ${created} AS created, ${value} AS value,
        CASE WHEN jsonb_typeof(${ordered}) <> 'object' AND NOT ${blank(ordered)} THEN ${ordered} END AS ordered,
        CASE WHEN ${blank(partition)} THEN 'null'::jsonb ELSE ${partition} END AS partition ${from}) AS input) AS windowed
      WHERE id = ${ownId})`;
  } else {
    const total =
      node.name === 'RUNNINGCOUNT'
        ? sql`count(*) FILTER (WHERE NOT ${blank(sql`value`)}) OVER (${window})`
        : sql`COALESCE(sum(CASE WHEN jsonb_typeof(value) = 'number' THEN (${scalar(sql`value`)})::double precision END) OVER (${window}), 0)`;
    computed = sql`COALESCE((jsonb_agg(value) FILTER (WHERE jsonb_typeof(value) = 'object') OVER (${window})) -> 0, to_jsonb(${total}))`;
  }
  return sql`(SELECT result FROM (SELECT id, ${computed} AS result FROM
    (SELECT ${rowId} AS id, ${created} AS created, ${value} AS value,
      CASE WHEN jsonb_typeof(${ordered}) <> 'object' AND NOT ${blank(ordered)} THEN ${ordered} END AS ordered, CASE WHEN ${blank(partition)} THEN 'null'::jsonb ELSE ${partition} END AS partition ${from}) AS input) AS windowed
    WHERE id = ${ownId})`;
}
