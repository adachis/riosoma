import { compileRecords } from './records-sql.js';
import { readsRecords } from './resolve.js';
import { RECORD_FUNCTIONS } from './records.js';
import { ident, join, sql, type Sql } from '@riosoma/db';
import { check, sameType, singleReads } from './check.js';
import {
  fieldList,
  fieldType,
  type Ast,
  type EvaluationContext,
  type Fields,
  type FormulaField,
  type FormulaType,
} from './ast.js';
import { dateUnit, today } from './dates.js';
import { lowerSql, upperSql } from './casing.js';

export interface SqlContext extends EvaluationContext {
  arrayResult?: boolean;
  recordSource?: (tableId?: string) => { from: Sql; where: Sql; context: SqlContext } | null;
  /**
   * A field's value as SQL, typed as the field's formula type.  A date range field's is its JSON
   * value, `{ "start": …, "end": … }`, which only START() and END() read.  A lookup's is a JSONB
   * array of its items, each a JSON number, string, or boolean, with dates as ISO text.  Return
   * null for a lookup whose items are anything else, such as date ranges, which JavaScript reads.
   * A link's is a JSONB array of its linked records' names, in link order, the same names the
   * caller hands `evaluate`.  A single select's is its choice ID, and a multiple select's its
   * `text[]` of choice IDs, which read as names through `choices`.
   */
  columnRef: (field: FormulaField) => Sql | null;
  choiceRef?: (field: FormulaField, id: Sql) => Sql | null;
  /**
   * A field's own error as JSONB, the same `{ "error": "#ERROR!", "messageKey": … }` value evaluate
   * reads from a record, or SQL NULL where the field's value is fine.  A rollup of an erroring
   * formula has one.  Return null, or leave this out, for fields that can't fail.
   */
  errorRef?: (field: FormulaField) => Sql | null;
  systemRef?: (column: 'id' | 'createdAt' | 'updatedAt') => Sql | null;
}
interface Expression {
  value: Sql;
  error: Sql;
  type: FormulaType;
}
const NO_ERROR = sql`NULL::jsonb`;
const FALSE = sql`${false}::boolean`;
const TRUE = sql`${true}::boolean`;
const reason = (messageKey: string) => sql`${JSON.stringify({ error: '#ERROR!', messageKey })}::jsonb`;
function castNull(type: FormulaType): Sql {
  if (type === 'number') return sql`NULL::double precision`;
  if (type === 'boolean') return sql`NULL::boolean`;
  if (type === 'date') return sql`NULL::date`;
  if (type === 'datetime') return sql`NULL::timestamptz`;
  return sql`NULL::text`;
}
function blank(a: Expression): Sql {
  if (typeof a.type === 'object') return sql`(jsonb_array_length(${a.value}) = ${0})`;
  return a.type === 'text'
    ? sql`(${a.value} IS NULL OR ${a.value} = ${''}::text)`
    : sql`(${a.value} IS NULL)`;
}
function truth(a: Expression): Sql {
  if (typeof a.type === 'object') return sql`(jsonb_array_length(${a.value}) > ${0})`;
  switch (a.type) {
    case 'blank':
      return FALSE;
    case 'boolean':
      return sql`COALESCE(${a.value}, ${false})`;
    case 'number':
      return sql`COALESCE(${a.value} <> ${0}::double precision, ${false})`;
    case 'text':
      return sql`NOT ${blank(a)}`;
    default:
      return sql`${a.value} IS NOT NULL`;
  }
}
function number(a: Expression): Sql {
  if (a.type === 'blank') return sql`${0}::double precision`;
  if (a.type === 'boolean')
    return sql`CASE WHEN ${a.value} THEN ${1}::double precision ELSE ${0}::double precision END`;
  return sql`COALESCE(${a.value}, ${0}::double precision)`;
}
/** A number's text, in parts: its sign, its whole digits, its fraction, and its exponent. */
const PRINTED_NUMBER = '^(-?)([0-9]+)(?:[.]([0-9]+))?(?:e([-+][0-9]+))?$';
/** The least magnitude that rounds to infinity, half a step past the largest finite number. */
const OVERFLOW = ((1n << 1024n) - (1n << 970n)).toString();
/**
 * A number as JavaScript's `String()` writes it.  PostgreSQL prints the shortest digits that read
 * back as the same number (with its default `extra_float_digits`, which the database driver relies
 * on too), laid out its own way, as in `1e+15` and `1e-05`.  So this takes the digits `s`, `k` of
 * them, and the decimal point's place `n` from that text, and lays them out again as ECMAScript's
 * Number::toString does: whole numbers up to 21 digits, fractions down to six zeros after the
 * point, and exponents beyond those, like `1e+21` and `1.5e-7`.  Negative zero is `0`.
 *
 * PostgreSQL never picks a decimal that lies exactly halfway to a neighboring number, though it
 * reads back as this one.  JavaScript does when it's shorter: 1e23 prints as `1e+23`, where
 * PostgreSQL prints `9.999999999999999e+22`.  A halfway point has so few digits only at 2^53 and
 * above, where both are whole numbers, so there the two halfway points are worked out exactly from
 * the number's bits, and the shorter one wins when it reads back as this number.
 */
function numberText(value: Sql): Sql {
  // Keep the digit calculations shared.  Inlining them into every use below makes PostgreSQL
  // turn a small formula into a large query plan when it is both filtered and sorted.
  const shorter = sql`length(rtrim(round(candidate.b)::text, '0'))`;
  return sql`(SELECT CASE
      WHEN laid.m IS NULL THEN laid.t
      WHEN laid.s = '' THEN '0'
      WHEN laid.k <= laid.n AND laid.n <= 21 THEN laid.m[1] || laid.s || repeat('0', laid.n - laid.k)
      WHEN laid.n > 0 AND laid.n <= 21 THEN laid.m[1] || left(laid.s, laid.n) || '.' || substr(laid.s, laid.n + 1)
      WHEN laid.n > -6 AND laid.n <= 0 THEN laid.m[1] || '0.' || repeat('0', -laid.n) || laid.s
      ELSE laid.m[1] || left(laid.s, 1) || CASE WHEN laid.k > 1 THEN '.' || substr(laid.s, 2) ELSE '' END
        || 'e' || CASE WHEN laid.n > 0 THEN '+' ELSE '-' END || abs(laid.n - 1)::text
    END
    FROM (SELECT digits.t, digits.m, COALESCE(halfway.s, digits.s) AS s,
        length(COALESCE(halfway.s, digits.s)) AS k, COALESCE(halfway.n, digits.n) AS n
      FROM (SELECT printed.t, printed.m, rtrim(printed.lead, '0') AS s,
          length(printed.m[2]) + COALESCE(printed.m[4]::integer, 0) - length(printed.whole) + length(printed.lead) AS n
        FROM (SELECT source.t, source.m, source.m[2] || COALESCE(source.m[3], '') AS whole,
            ltrim(source.m[2] || COALESCE(source.m[3], ''), '0') AS lead
          FROM (SELECT (${value})::text AS t, regexp_match((${value})::text, ${PRINTED_NUMBER}) AS m OFFSET 0) AS source)
          AS printed OFFSET 0) AS digits
      LEFT JOIN LATERAL (SELECT rtrim(round(candidate.b)::text, '0') AS s, length(round(candidate.b)::text) AS n
        FROM (SELECT exact.x, exact.x + exact.half AS above,
            exact.x - CASE WHEN exact.fraction = 0 THEN exact.half / 2 ELSE exact.half END AS below
          FROM (SELECT parts.fraction, power(2::numeric, parts.e - 1) AS half,
              (parts.fraction + 4503599627370496)::numeric * power(2::numeric, parts.e) AS x
            FROM (SELECT raw.bits & 4503599627370495 AS fraction, ((raw.bits >> 52) & 2047)::integer - 1075 AS e
              FROM (SELECT ('x' || encode(float8send(abs(${value})), 'hex'))::bit(64)::bigint AS bits
                WHERE abs(${value}) >= 9007199254740992 AND abs(${value}) < 'Infinity'::double precision) AS raw)
              AS parts) AS exact) AS bounds
        CROSS JOIN LATERAL (VALUES (bounds.above), (bounds.below)) AS candidate(b)
        WHERE candidate.b = trunc(candidate.b) AND ${shorter} < length(digits.s)
          AND CASE WHEN candidate.b < ${OVERFLOW}::numeric THEN candidate.b::double precision = abs(${value}) ELSE false END
        ORDER BY ${shorter}, abs(candidate.b - bounds.x), right(rtrim(round(candidate.b)::text, '0'), 1)::integer % 2
        LIMIT 1) AS halfway ON TRUE OFFSET 0) AS laid)`;
}
/** Decimals at most this small read as zero, since no double lies nearer to them. */
const UNDERFLOW = `0.${(5n ** 1075n).toString().padStart(1075, '0')}`;
/**
 * A lookup's list as a JSONB array.  SQL NULL, which a lookup with an error reads as, and JSON null
 * hold nothing, and a lone value is a list of one, as JavaScript reads them.
 */
function listOf(value: Sql): Sql {
  return sql`CASE WHEN ${value} IS NULL OR jsonb_typeof(${value}) = 'null' THEN '[]'::jsonb
    WHEN jsonb_typeof(${value}) = 'array' THEN ${value} ELSE jsonb_build_array(${value}) END`;
}
/** A choice's or person's name, from its ID, or NULL for an ID that isn't among them. */
function named(id: Sql, names: EvaluationContext['choices']): Sql {
  const cases = [...(names ?? [])].map(
    ([known, name]) => sql`WHEN ${id} = ${known}::text THEN ${name}::text`,
  );
  return cases.length ? sql`CASE ${join(cases, ' ')} ELSE NULL::text END` : sql`NULL::text`;
}
/**
 * A multiple select's choice IDs as a JSONB array of their names, in order, with JSON null for an
 * ID that isn't a choice, as JavaScript reads them.  Nothing chosen is an empty list.
 */
function choiceNames(ids: Sql, choices: EvaluationContext['choices']): Sql {
  return sql`COALESCE((SELECT jsonb_agg(to_jsonb(${named(sql`chosen.id`, choices)}) ORDER BY chosen.position)
    FROM unnest(${ids}) WITH ORDINALITY AS chosen(id, position)), '[]'::jsonb)`;
}
/**
 * A list item's number, or NULL when it isn't one.  A decimal too large for any double is blank, as
 * the server reads it, and one too small is zero, where a plain cast would fail the whole read.
 */
function itemNumber(item: Sql): Sql {
  return sql`CASE WHEN jsonb_typeof(${item}) = 'number' THEN (SELECT CASE
      WHEN abs(item_decimal.value) >= ${OVERFLOW}::numeric THEN NULL::double precision
      WHEN abs(item_decimal.value) <= ${UNDERFLOW}::numeric THEN ${0}::double precision
      ELSE item_decimal.value::double precision END
    FROM (SELECT (${item})::numeric AS value) AS item_decimal) END`;
}
/** A list item as text, the way JavaScript writes it, or NULL for a blank item. */
function itemText(item: Sql, number: Sql): Sql {
  return sql`CASE jsonb_typeof(${item}) WHEN 'string' THEN ${item} #>> '{}'
    WHEN 'number' THEN CASE WHEN ${number} IS NULL THEN NULL::text ELSE ${numberText(number)} END
    WHEN 'boolean' THEN CASE WHEN (${item})::boolean THEN ${'1'}::text ELSE ${'0'}::text END END`;
}
/** A list's items as rows: each `item` as JSON, its `position`, and its `number` when it's one. */
function listItems(list: Sql): Sql {
  return sql`(SELECT listed.item, listed.position, ${itemNumber(sql`listed.item`)} AS number
    FROM jsonb_array_elements(${list}) WITH ORDINALITY AS listed(item, position)) AS items`;
}
/** Whether a list item is blank: nothing, empty text, or a number no double can hold. */
const BLANK_ITEM = sql`(jsonb_typeof(items.item) = 'null' OR items.item = '""'::jsonb
  OR (jsonb_typeof(items.item) = 'number' AND items.number IS NULL))`;
/** A lookup's one item, read as the type the checker gave it, as JavaScript's `itemAs` does. */
function itemValue(item: Sql, type: FormulaType): Sql {
  switch (type) {
    case 'number':
      return itemNumber(item);
    case 'boolean':
      return sql`CASE WHEN jsonb_typeof(${item}) = 'boolean' THEN (${item})::boolean END`;
    case 'date':
      return sql`CASE WHEN jsonb_typeof(${item}) = 'string' THEN (${item} #>> '{}')::date END`;
    case 'datetime':
      return sql`CASE WHEN jsonb_typeof(${item}) = 'string'
        THEN date_trunc(${'milliseconds'}, (${item} #>> '{}')::timestamptz) END`;
    case 'text':
      return sql`(SELECT ${itemText(sql`one.item`, sql`one.number`)}
        FROM (SELECT ${item} AS item, ${itemNumber(item)} AS number) AS one)`;
    default:
      return castNull(type);
  }
}
function text(a: Expression): Sql | null {
  // A list joins its items with a comma and a space, a blank item as empty text.
  if (typeof a.type === 'object')
    return sql`COALESCE((SELECT string_agg(COALESCE(${itemText(sql`items.item`, sql`items.number`)}, ${''}::text),
      ${', '}::text ORDER BY items.position) FROM ${listItems(a.value)}), ${''}::text)`;
  switch (a.type) {
    case 'blank':
      return sql`${''}::text`;
    case 'text':
      return sql`COALESCE(${a.value}, ${''}::text)`;
    case 'number':
      return sql`CASE WHEN ${a.value} IS NULL THEN ${''}::text ELSE ${numberText(a.value)} END`;
    case 'boolean':
      return sql`CASE WHEN ${a.value} IS NULL THEN ${''}::text WHEN ${a.value} THEN ${'1'}::text ELSE ${'0'}::text END`;
    case 'date':
      return sql`COALESCE(to_char(${a.value}, ${'YYYY-MM-DD'}), ${''}::text)`;
    case 'datetime':
      return sql`COALESCE(to_char(${a.value} AT TIME ZONE ${'UTC'}, ${'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'}), ${''}::text)`;
    // Lists join their items in JavaScript.
    default:
      return null;
  }
}
function textLength(value: Sql): Sql {
  return sql`(char_length(${value}) + char_length(regexp_replace(${value}, ${'[\u0001-\uFFFF]'}, ${''}, ${'g'})))::double precision`;
}
/** Characters outside the Basic Multilingual Plane, which take two UTF-16 units each */
const ASTRAL = '\\U00010000-\\U0010FFFF';
/**
 * How many characters of `value` start before UTF-16 position `units`, a whole number no longer
 * than the text: the characters a search from there passes over, one more when the position falls
 * inside a character that takes two units.  Each character becomes an `x`, followed by a `y` when
 * it takes two, and the `x`s before the position are counted.
 */
function charactersBefore(value: Sql, units: Sql): Sql {
  const laid = sql`regexp_replace(regexp_replace(${value} COLLATE "C", ${`[^${ASTRAL}]`}, ${'x'}, ${'g'}), ${`[${ASTRAL}]`}, ${'xy'}, ${'g'})`;
  return sql`char_length(replace(left(${laid}, ${units}), ${'y'}, ${''}))`;
}
function compare(a: Expression, b: Expression, op: string, context: SqlContext): Sql | null {
  if (typeof a.type === 'object' || typeof b.type === 'object') return null;
  const av =
    a.type === 'blank' ? castNull(b.type) : a.type === 'boolean' && b.type === 'number' ? number(a) : a.value;
  const bv =
    b.type === 'blank' ? castNull(a.type) : b.type === 'boolean' && a.type === 'number' ? number(b) : b.value;
  const datePair =
    (a.type === 'date' || a.type === 'datetime') && (b.type === 'date' || b.type === 'datetime');
  const left = datePair && a.type === 'date' ? sql`${av}::timestamp AT TIME ZONE ${context.timeZone}` : av;
  const right = datePair && b.type === 'date' ? sql`${bv}::timestamp AT TIME ZONE ${context.timeZone}` : bv;
  let comparison: Sql;
  switch (op) {
    case '=':
      comparison = sql`${left} = ${right}`;
      break;
    case '!=':
    case '<>':
      comparison = sql`${left} <> ${right}`;
      break;
    case '<':
      comparison = sql`${left} < ${right}`;
      break;
    case '<=':
      comparison = sql`${left} <= ${right}`;
      break;
    case '>':
      comparison = sql`${left} > ${right}`;
      break;
    case '>=':
      comparison = sql`${left} >= ${right}`;
      break;
    default:
      return null;
  }
  // UTF-16 ordering differs from database collations; equality is bytewise and portable.
  if ((a.type === 'text' || b.type === 'text') && !['=', '!=', '<>'].includes(op)) return null;
  return sql`CASE WHEN ${blank(a)} OR ${blank(b)} THEN ${op === '=' ? sql`(${blank(a)} AND ${blank(b)})` : FALSE} ELSE COALESCE(${comparison}, ${false}) END`;
}

/** Returns a JSONB scalar, null, or the same structured error value as evaluate. */
export function compileSql(ast: Ast, fields: Fields, context: SqlContext): Sql | null {
  return compile(ast, fields, context);
}

function compile(
  ast: Ast,
  fields: Fields,
  context: SqlContext,
  parentSingles: ReadonlySet<Ast> = new Set(),
): Sql | null {
  const list = fieldList(fields),
    byId = new Map(list.map((f) => [f.id, f]));
  if ('error' in check(ast, byId)) return null;
  // Correlated operands retain the scalar reads required by their enclosing function.
  const singles = new Set([...parentSingles, ...singleReads(ast, byId)]);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: context.timeZone }).format(new Date(context.now));
  } catch {
    return null;
  }
  const clauses: Sql[] = [];
  const slot = (value: Sql, error: Sql, type: FormulaType): Expression => {
    const alias = `f${clauses.length}`;
    clauses.push(sql`LATERAL (SELECT ${value} AS value, ${error} AS error OFFSET ${0}) AS ${ident(alias)}`);
    return { value: sql`${ident(alias, 'value')}`, error: sql`${ident(alias, 'error')}`, type };
  };
  const propagated = (args: readonly Expression[]) =>
    args.length
      ? sql`COALESCE(${join(
          args.map((a) => a.error),
          ', ',
        )}, ${NO_ERROR})`
      : NO_ERROR;
  const local = (a: Expression) =>
    a.type === 'date' ? sql`${a.value}::timestamp` : sql`${a.value} AT TIME ZONE ${context.timeZone}`;
  const instant = (a: Expression) =>
    a.type === 'date' ? sql`${a.value}::timestamp AT TIME ZONE ${context.timeZone}` : a.value;
  const exactNumbers = new Map<Expression, Sql>();
  const exactNumber = (a: Expression): Sql => {
    const cached = exactNumbers.get(a);
    if (cached) return cached;
    // Decimal casts discard binary digits needed at overflow and subnormal boundaries.
    const bits = slot(
      sql`(${'x'} || encode(float8send(${number(a)}), ${'hex'}))::bit(64)::bigint`,
      NO_ERROR,
      'number',
    );
    const exponent = slot(
      sql`greatest(((${bits.value} >> ${52}) & ${2047}), ${1})::integer - ${1075}`,
      NO_ERROR,
      'number',
    );
    const mantissa = slot(
      sql`((${bits.value} & ${'4503599627370495'}::bigint) + CASE WHEN ((${bits.value} >> ${52}) & ${2047}) = ${0} THEN ${0}::bigint ELSE ${'4503599627370496'}::bigint END)::numeric`,
      NO_ERROR,
      'number',
    );
    const value = slot(
      sql`(CASE WHEN ${bits.value} < ${0} THEN ${-1}::numeric ELSE ${1}::numeric END) * ${mantissa.value} * CASE WHEN ${exponent.value} >= ${0} THEN power(${2}::numeric, ${exponent.value}) ELSE power(${5}::numeric, -${exponent.value}) * (${'1e'} || ${exponent.value}::text)::numeric END`,
      NO_ERROR,
      'number',
    ).value;
    exactNumbers.set(a, value);
    return value;
  };
  const arithmetic = (a: Expression, b: Expression, operator: string): Expression => {
    const x = number(a),
      y = number(b);
    const nx = exactNumber(a),
      ny = exactNumber(b);
    let exact: Sql, value: Sql;
    if (operator === '+') {
      exact = sql`${nx} + ${ny}`;
      value = sql`${x} + ${y}`;
    } else if (operator === '-') {
      exact = sql`${nx} - ${ny}`;
      value = sql`${x} - ${y}`;
    } else if (operator === '*') {
      exact = sql`${nx} * ${ny}`;
      value = sql`${x} * ${y}`;
    } else {
      exact = nx;
      value = sql`${x} / NULLIF(${y}, ${0})`;
    }
    const raw = slot(exact, propagated([a, b]), 'number');
    const overflowThreshold = ((1n << 1024n) - (1n << 970n)).toString();
    const scale = operator === '/' ? sql`abs(${ny})` : sql`${1}::numeric`;
    const overflow = sql`abs(${raw.value}) >= ${overflowThreshold}::numeric * ${scale}`;
    const underflowThreshold = `0.${(5n ** 1075n).toString().padStart(1075, '0')}`;
    const underflow = sql`abs(${raw.value}) <= ${underflowThreshold}::numeric * ${scale}`;
    const error = sql`COALESCE(${raw.error}, CASE WHEN ${operator === '/' ? sql`${y} = ${0}` : FALSE} THEN ${reason('formula.runtime.divisionByZero')} WHEN ${overflow} THEN ${reason('formula.runtime.number')} ELSE ${NO_ERROR} END)`;
    // Postgres raises on underflow; the host runtime rounds it to zero or a subnormal.
    const safe = sql`CASE WHEN ${overflow} OR ${underflow} THEN ${0}::double precision ELSE (${value}) END`;
    return slot(safe, error, 'number');
  };
  /**
   * A list's numbers added to a running total one at a time, in order, as JavaScript adds them.
   * PostgreSQL fails a whole query when a sum overflows, so each step first checks, on halves that
   * can't overflow, whether it would: halving is exact where it matters, and rounding keeps its
   * place when halved, so the halves' sum reaches 2^1023 exactly when the whole sum would round to
   * infinity.  Values below one don't change that answer, so they count as zero there, where
   * halving them could underflow.  The first overflow stops the sum with an error, as JavaScript's
   * infinity does.
   */
  const addList = (total: Expression, list: Expression): Expression => {
    const half = (value: Sql) =>
      sql`CASE WHEN abs(${value}) >= ${1}::double precision THEN ${value} * ${0.5}::double precision ELSE ${0}::double precision END`;
    const sum = slot(
      sql`(WITH RECURSIVE list_numbers AS (
          SELECT row_number() OVER (ORDER BY items.position) AS i, items.number AS x
          FROM ${listItems(list.value)} WHERE items.number IS NOT NULL),
        list_sum(i, s) AS (
          SELECT ${0}::bigint, ${total.value}
          UNION ALL
          SELECT list_sum.i + 1, CASE WHEN abs(${half(sql`list_sum.s`)} + ${half(sql`list_numbers.x`)})
              >= ${2 ** 1023}::double precision THEN 'Infinity'::double precision
            ELSE list_sum.s + list_numbers.x END
          FROM list_sum JOIN list_numbers ON list_numbers.i = list_sum.i + 1
          WHERE list_sum.s <> 'Infinity'::double precision)
        SELECT list_sum.s FROM list_sum ORDER BY list_sum.i DESC LIMIT 1)`,
      NO_ERROR,
      'number',
    );
    const overflow = sql`${sum.value} = 'Infinity'::double precision`;
    return slot(
      sql`CASE WHEN ${overflow} THEN ${0}::double precision ELSE ${sum.value} END`,
      sql`COALESCE(${total.error}, CASE WHEN ${overflow} THEN ${reason('formula.runtime.number')} ELSE ${NO_ERROR} END)`,
      'number',
    );
  };
  const walk = (node: Ast): Expression | null => {
    if (node.kind === 'literal') {
      if (typeof node.value === 'number')
        return slot(sql`${node.value}::double precision`, NO_ERROR, 'number');
      if (typeof node.value === 'boolean') return slot(sql`${node.value}::boolean`, NO_ERROR, 'boolean');
      if (
        node.value.includes('\0') ||
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(node.value)
      )
        return null;
      return slot(sql`${node.value}::text`, NO_ERROR, 'text');
    }
    if (node.kind === 'field') {
      const field = byId.get(node.fieldId ?? '');
      if (!field) return null;
      let ref = context.columnRef(field);
      if (!ref) return null;
      const type = fieldType(field);
      if (typeof type === 'object') {
        // A lookup's list and a link's names are JSON, and a multiple select's choices become names
        // here.  Anything else that holds a list is left to JavaScript.
        if (typeof type.array === 'object') return null;
        let list: Sql;
        if (field.type === 'lookup' || field.type === 'link') list = listOf(ref);
        else if (field.type === 'multipleSelect') {
          const name = context.choiceRef?.(field, sql`selected.id`);
          list = name
            ? sql`(SELECT COALESCE(jsonb_agg(named.name ORDER BY named.position), '[]'::jsonb)
            FROM (SELECT ${name} AS name, selected.position FROM unnest(${ref}) WITH ORDINALITY AS selected(id, position)) named
            WHERE named.name IS NOT NULL)`
            : choiceNames(ref, context.choices);
        } else if (context.arrayResult && field.type === 'user') list = choiceNames(ref, context.people);
        else if (context.arrayResult && field.type === 'attachment') list = sql`to_jsonb(${ref})`;
        else if (context.arrayResult && field.type === 'dateRange')
          list = sql`CASE WHEN ${ref} IS NOT NULL THEN jsonb_build_array(${ref} -> 'start', ${ref} -> 'end') END`;
        else return null;
        const items = slot(list, context.errorRef?.(field) ?? NO_ERROR, type);
        if (!singles.has(node)) return items;
        // Read as its one item: blank when there's none, and an error when there are several.
        const count = sql`jsonb_array_length(${items.value})`;
        return slot(
          itemValue(sql`CASE WHEN ${count} = ${1} THEN ${items.value} -> 0 END`, type.array),
          sql`COALESCE(${items.error}, CASE WHEN ${count} > ${1} THEN ${reason('formula.list.several')} ELSE ${NO_ERROR} END)`,
          type.array,
        );
      }
      if (field.type === 'singleSelect' || field.type === 'createdBy' || field.type === 'lastModifiedBy')
        ref =
          (field.type === 'singleSelect' ? context.choiceRef?.(field, ref) : null) ??
          named(ref, field.type === 'singleSelect' ? context.choices : context.people);
      return slot(
        type === 'number'
          ? sql`(${ref})::double precision`
          : type === 'datetime'
            ? sql`date_trunc(${'milliseconds'}, ${ref})`
            : ref,
        context.errorRef?.(field) ?? NO_ERROR,
        type,
      );
    }
    if (node.kind === 'unary') {
      const a = walk(node.operand);
      return a ? slot(sql`-(${number(a)})`, a.error, 'number') : null;
    }
    if (node.kind === 'binary') {
      const a = walk(node.left),
        b = walk(node.right);
      if (!a || !b) return null;
      if (['+', '-', '*', '/'].includes(node.operator)) return arithmetic(a, b, node.operator);
      if (node.operator === '&') {
        const x = text(a),
          y = text(b);
        return x && y ? slot(sql`${x} || ${y}`, propagated([a, b]), 'text') : null;
      }
      if (node.operator === '&&' || node.operator === '||') {
        const condition = node.operator === '&&' ? truth(a) : sql`NOT (${truth(a)})`;
        return slot(
          sql`CASE WHEN ${condition} THEN ${truth(b)} ELSE ${node.operator === '||'}::boolean END`,
          sql`COALESCE(${a.error}, CASE WHEN ${condition} THEN ${b.error} ELSE ${NO_ERROR} END)`,
          'boolean',
        );
      }
      const value = compare(a, b, node.operator, context);
      return value ? slot(value, propagated([a, b]), 'boolean') : null;
    }
    if (RECORD_FUNCTIONS.has(node.name)) {
      const compiled = compileRecords(node, fields, context, (operand, fields, context) =>
        compile(operand, fields, context, singles),
      );
      const checked = check(node, byId);
      if (!compiled || 'error' in checked) return null;
      const raw = slot(compiled, NO_ERROR, 'text');
      const type = checked.type;
      return slot(
        typeof type === 'object' ? sql`COALESCE(${raw.value}, 'null'::jsonb)` : itemValue(raw.value, type),
        sql`CASE WHEN jsonb_typeof(${raw.value}) = 'object' THEN ${raw.value} END`,
        type,
      );
    }
    // A date range field reads as JSON with `start` and `end`.  Its ends compile, and the list doesn't.
    if ((node.name === 'START' || node.name === 'END') && node.args.length === 1) {
      const arg = node.args[0]!;
      const field = arg.kind === 'field' ? byId.get(arg.fieldId ?? '') : undefined;
      const type = field ? fieldType(field) : undefined;
      const ref = field?.type === 'dateRange' && typeof type === 'object' ? context.columnRef(field) : null;
      if (!ref || typeof type !== 'object') return null;
      const end = node.name === 'START' ? sql`(${ref}) ->> 'start'` : sql`(${ref}) ->> 'end'`;
      return type.array === 'datetime'
        ? slot(sql`date_trunc(${'milliseconds'}, (${end})::timestamptz)`, NO_ERROR, 'datetime')
        : slot(sql`(${end})::date`, NO_ERROR, 'date');
    }
    const args: Expression[] = [];
    for (const child of node.args) {
      const arg = walk(child);
      if (!arg) return null;
      args.push(arg);
    }
    const inferred = check(node, byId);
    if ('error' in inferred) return null;
    const type = inferred.type;
    // A list comes out of IF or SWITCH only in JavaScript.
    if (typeof type === 'object') return null;
    const a = args[0],
      b = args[1],
      c = args[2];
    const error = propagated(args);
    const finish = (value: Sql, ownError: Sql = NO_ERROR) =>
      slot(value, sql`COALESCE(${error}, ${ownError})`, type);
    const branchValue = (arg: Expression | undefined): Sql =>
      !arg || arg.type === 'blank' ? castNull(type) : arg.value;
    const literal = (i: number) => {
      const arg = node.args[i];
      if (arg?.kind === 'literal') return arg.value;
      if (arg?.kind === 'unary' && arg.operand.kind === 'literal' && typeof arg.operand.value === 'number')
        return -arg.operand.value;
      return undefined;
    };
    switch (node.name) {
      case 'TRUE':
        return finish(TRUE);
      case 'FALSE':
        return finish(FALSE);
      case 'BLANK':
        return finish(castNull('blank'));
      case 'ERROR':
        return args.length ? null : slot(castNull('blank'), reason('formula.runtime.explicit'), 'blank');
      case 'ISERROR':
        return slot(sql`${a!.error} IS NOT NULL`, NO_ERROR, 'boolean');
      case 'IF':
        return slot(
          sql`CASE WHEN ${truth(a!)} THEN ${branchValue(b)} ELSE ${branchValue(c)} END`,
          sql`COALESCE(${a!.error}, CASE WHEN ${truth(a!)} THEN ${b!.error} ELSE ${c?.error ?? NO_ERROR} END)`,
          type,
        );
      case 'SWITCH': {
        let value = args.length % 2 === 0 ? branchValue(args.at(-1)) : castNull(type);
        let err = args.length % 2 === 0 ? args.at(-1)!.error : NO_ERROR;
        for (let i = args.length % 2 === 0 ? args.length - 3 : args.length - 2; i >= 1; i -= 2) {
          const condition = compare(a!, args[i]!, '=', context);
          if (!condition) return null;
          value = sql`CASE WHEN ${condition} THEN ${branchValue(args[i + 1])} ELSE ${value} END`;
          err = sql`COALESCE(${args[i]!.error}, CASE WHEN ${condition} THEN ${args[i + 1]!.error} ELSE ${err} END)`;
        }
        return slot(value, sql`COALESCE(${a!.error}, ${err})`, type);
      }
      case 'AND':
      case 'OR': {
        let value = node.name === 'AND' ? TRUE : FALSE,
          err = NO_ERROR;
        for (const arg of [...args].reverse()) {
          const condition = node.name === 'AND' ? truth(arg) : sql`NOT (${truth(arg)})`;
          value = sql`CASE WHEN ${condition} THEN ${value} ELSE ${node.name === 'OR'}::boolean END`;
          err = sql`COALESCE(${arg.error}, CASE WHEN ${condition} THEN ${err} ELSE ${NO_ERROR} END)`;
        }
        return slot(value, err, type);
      }
      case 'NOT':
        return finish(sql`NOT (${truth(a!)})`);
      case 'XOR': {
        let total = sql`${0}::integer`;
        for (const arg of args)
          total = sql`(${total} + CASE WHEN ${truth(arg)} THEN ${1}::integer ELSE ${0}::integer END)`;
        return finish(sql`mod(${total}, ${2}) = ${1}`);
      }
      case 'ABS':
        return finish(sql`abs(${number(a!)})`);
      case 'INT':
        return finish(sql`floor(${number(a!)})`);
      case 'MAX':
      case 'MIN': {
        // A list's numbers join the others, and its other items, like blanks, are left out.
        const values = args.flatMap((arg) =>
          arg.type === 'number'
            ? [arg.value]
            : typeof arg.type === 'object'
              ? [
                  node.name === 'MAX'
                    ? sql`(SELECT max(items.number) FROM ${listItems(arg.value)})`
                    : sql`(SELECT min(items.number) FROM ${listItems(arg.value)})`,
                ]
              : [],
        );
        if (!values.length) return finish(sql`${0}::double precision`);
        return finish(
          node.name === 'MAX'
            ? sql`COALESCE(greatest(${join(values, ', ')}), ${0}::double precision)`
            : sql`COALESCE(least(${join(values, ', ')}), ${0}::double precision)`,
        );
      }
      case 'SUM':
      case 'AVERAGE': {
        // Numbers add up in order, a list's where it stands among the arguments, as JavaScript adds them.
        let result = slot(sql`${0}::double precision`, error, 'number');
        let count = sql`${0}::double precision`;
        for (const arg of args) {
          if (arg.type === 'number') {
            result = arithmetic(result, arg, '+');
            count = sql`(${count} + CASE WHEN ${arg.value} IS NULL THEN ${0}::integer ELSE ${1}::integer END)`;
          } else if (typeof arg.type === 'object') {
            result = addList(result, arg);
            count = sql`(${count} + (SELECT count(items.number) FROM ${listItems(arg.value)})::integer)`;
          }
        }
        return node.name === 'SUM' ? result : arithmetic(result, slot(count, NO_ERROR, 'number'), '/');
      }
      case 'COUNT':
      case 'COUNTA':
      case 'COUNTALL': {
        let total = sql`${0}::double precision`;
        for (const arg of args) {
          // A list counts its items, as though each were an argument of its own.
          if (typeof arg.type === 'object') {
            const counted =
              node.name === 'COUNTALL'
                ? sql`jsonb_array_length(${arg.value})`
                : node.name === 'COUNTA'
                  ? sql`(SELECT count(*) FROM ${listItems(arg.value)} WHERE NOT ${BLANK_ITEM})`
                  : sql`(SELECT count(items.number) FROM ${listItems(arg.value)})`;
            total = sql`(${total} + (${counted})::integer)`;
            continue;
          }
          const condition =
            node.name === 'COUNTALL'
              ? TRUE
              : node.name === 'COUNTA'
                ? sql`NOT ${blank(arg)}`
                : arg.type === 'number'
                  ? sql`${arg.value} IS NOT NULL`
                  : FALSE;
          total = sql`(${total} + CASE WHEN ${condition} THEN ${1}::integer ELSE ${0}::integer END)`;
        }
        return finish(total);
      }
      case 'CONCATENATE': {
        let result = sql`${''}::text`;
        for (const arg of args) {
          const value = text(arg);
          if (!value) return null;
          result = sql`${result} || ${value}`;
        }
        return finish(result);
      }
      case 'LEN': {
        const value = text(a!);
        return value ? finish(textLength(value)) : null;
      }
      case 'TRIM': {
        const value = text(a!);
        return value
          ? finish(
              sql`btrim(${value}, ${'\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'})`,
            )
          : null;
      }
      case 'LOWER':
      case 'UPPER': {
        const value = text(a!);
        if (!value) return null;
        const cased = (node.name === 'LOWER' ? lowerSql : upperSql)(slot(value, NO_ERROR, 'text').value);
        return cased ? finish(cased) : null;
      }
      case 'FIND':
      case 'SEARCH': {
        // JavaScript's `indexOf` on UTF-16 text, from a start it holds to the text, with SEARCH
        // lowering both texts first, so positions count in the lowered text as they do there.
        const needle = text(a!),
          haystack = text(b!);
        if (!needle || !haystack) return null;
        const lowered = node.name === 'SEARCH';
        const cased = (value: Sql) => (lowered ? lowerSql(value) : value);
        const n = cased(needle),
          h = cased(haystack);
        if (!n || !h) return null;
        const sought = slot(n, NO_ERROR, 'text');
        const within = slot(h, NO_ERROR, 'text');
        const units = slot(textLength(within.value), NO_ERROR, 'number');
        const start = slot(
          args.length > 2
            ? sql`least(greatest(trunc(${number(c!)}) - ${1}, ${0}::double precision), ${units.value})::integer`
            : sql`${0}::integer`,
          NO_ERROR,
          'number',
        );
        // Characters are UTF-16 units until one takes two.
        const skipped = slot(
          sql`CASE WHEN ${units.value} = char_length(${within.value}) THEN ${start.value}
            ELSE ${charactersBefore(within.value, start.value)} END`,
          NO_ERROR,
          'number',
        );
        const found = slot(
          sql`strpos(substr(${within.value} COLLATE "C", ${skipped.value} + ${1}), ${sought.value} COLLATE "C")`,
          NO_ERROR,
          'number',
        );
        return finish(sql`CASE WHEN char_length(${sought.value}) = ${0} THEN (${start.value} + ${1})::double precision
          WHEN ${found.value} = ${0} THEN ${lowered ? sql`NULL::double precision` : sql`${0}::double precision`}
          ELSE ${textLength(sql`left(${within.value}, ${skipped.value} + ${found.value} - ${1})`)} + ${1} END`);
      }
      case 'ROUND': {
        // The scale is JavaScript's own `10 ** precision`, which PostgreSQL's `power` needn't match,
        // so the precision has to be written into the formula.  Math.round breaks ties toward
        // positive infinity: up from a half or more above the floor.
        const digits = literal(1);
        if (typeof digits !== 'number') return null;
        const precision = Math.trunc(digits);
        if (precision < -308 || precision > 308)
          return finish(castNull(type), reason('formula.runtime.number'));
        const scale = slot(sql`${10 ** precision}::double precision`, NO_ERROR, 'number');
        const scaled = arithmetic(a!, scale, '*');
        const whole = slot(
          sql`floor(${scaled.value}) + CASE WHEN ${scaled.value} - floor(${scaled.value}) >= ${0.5}::double precision
            THEN ${1}::double precision ELSE ${0}::double precision END`,
          scaled.error,
          'number',
        );
        return arithmetic(whole, scale, '/');
      }
      case 'ARRAYJOIN': {
        const separator = args.length > 1 ? text(b!) : sql`${', '}::text`;
        if (!separator) return null;
        if (a!.type === 'blank') return finish(sql`${''}::text`);
        if (typeof a!.type !== 'object') return null;
        return finish(sql`COALESCE((SELECT string_agg(COALESCE(${itemText(sql`items.item`, sql`items.number`)}, ${''}::text),
          ${separator} ORDER BY items.position) FROM ${listItems(a!.value)}), ${''}::text)`);
      }
      case 'T':
        return finish(a!.type === 'text' ? a!.value : sql`NULL::text`);
      case 'SUBSTITUTE': {
        if (args.length !== 3) return null;
        const x = text(a!),
          y = text(b!),
          z = text(c!);
        return x && y && z ? finish(sql`replace(${x}, ${y}, ${z})`) : null;
      }
      case 'REPT': {
        const x = text(a!),
          n = number(b!);
        if (!x) return null;
        const invalid = sql`trunc(${n}) < ${0} OR trunc(${n}) > ${1_000_000} OR ${textLength(x)} * trunc(${n}) > ${1_000_000}`;
        return finish(
          sql`CASE WHEN ${invalid} THEN NULL::text ELSE repeat(${x}, trunc(${n})::integer) END`,
          sql`CASE WHEN ${invalid} THEN ${reason('formula.runtime.limit')} ELSE ${NO_ERROR} END`,
        );
      }
      case 'TODAY':
        return finish(sql`${today(context)}::date`);
      case 'NOW':
        return finish(sql`${new Date(context.now).toISOString()}::timestamptz`);
      case 'RECORD_ID':
      case 'CREATED_TIME':
      case 'LAST_MODIFIED_TIME': {
        if (args.length) return null;
        const ref = context.systemRef?.(
          node.name === 'RECORD_ID' ? 'id' : node.name === 'CREATED_TIME' ? 'createdAt' : 'updatedAt',
        );
        return ref
          ? finish(node.name === 'RECORD_ID' ? ref : sql`date_trunc(${'milliseconds'}, ${ref})`)
          : null;
      }
      case 'YEAR':
      case 'MONTH':
      case 'DAY':
      case 'HOUR':
      case 'MINUTE':
      case 'SECOND': {
        if (a!.type === 'blank') return finish(castNull(type));
        if (a!.type !== 'date' && a!.type !== 'datetime') return null;
        const value = local(a!);
        const extracted =
          node.name === 'YEAR'
            ? sql`extract(year FROM ${value})`
            : node.name === 'MONTH'
              ? sql`extract(month FROM ${value})`
              : node.name === 'DAY'
                ? sql`extract(day FROM ${value})`
                : node.name === 'HOUR'
                  ? sql`extract(hour FROM ${value})`
                  : node.name === 'MINUTE'
                    ? sql`extract(minute FROM ${value})`
                    : sql`floor(extract(second FROM ${value}))`;
        return finish(sql`(${extracted})::double precision`);
      }
      case 'DATESTR':
      case 'TIMESTR': {
        if (a!.type === 'blank') return finish(castNull(type));
        if (a!.type !== 'date' && a!.type !== 'datetime') return null;
        return finish(sql`to_char(${local(a!)}, ${node.name === 'DATESTR' ? 'YYYY-MM-DD' : 'HH24:MI:SS'})`);
      }
      case 'IS_BEFORE':
      case 'IS_AFTER': {
        if (a!.type === 'blank' || b!.type === 'blank') return finish(FALSE);
        if (
          !['date', 'datetime'].includes(String(a!.type)) ||
          !['date', 'datetime'].includes(String(b!.type))
        )
          return null;
        return finish(
          sql`COALESCE(${node.name === 'IS_BEFORE' ? sql`${instant(a!)} < ${instant(b!)}` : sql`${instant(a!)} > ${instant(b!)}`}, ${false})`,
        );
      }
      case 'DATETIME_DIFF':
      case 'IS_SAME': {
        if (a!.type === 'blank' || b!.type === 'blank')
          return finish(node.name === 'IS_SAME' ? FALSE : castNull(type));
        if (
          !['date', 'datetime'].includes(String(a!.type)) ||
          !['date', 'datetime'].includes(String(b!.type))
        )
          return null;
        const unit = dateUnit(args.length < 3 ? 'second' : String(literal(2)));
        if (!unit) return null;
        if (node.name === 'IS_SAME') {
          if (unit === 'week') return null;
          const truncate = unit === 'millisecond' ? 'milliseconds' : unit;
          return finish(
            sql`COALESCE(date_trunc(${truncate}, ${local(a!)}) = date_trunc(${truncate}, ${local(b!)}), ${false})`,
          );
        }
        const divisor = {
          millisecond: 0.001,
          second: 1,
          minute: 60,
          hour: 3600,
          day: 86400,
          week: 604800,
          month: 0,
          quarter: 0,
          year: 0,
        }[unit];
        if (!divisor) return null;
        const difference =
          unit === 'day' || unit === 'week'
            ? sql`${local(a!)} - ${local(b!)}`
            : sql`${instant(a!)} - ${instant(b!)}`;
        return finish(
          sql`trunc(extract(epoch FROM (${difference})) / ${divisor}::numeric)::double precision`,
        );
      }
      case 'DATEADD': {
        if (a!.type === 'blank') return finish(castNull(type));
        if (!['date', 'datetime'].includes(String(a!.type)) || context.timeZone !== 'UTC') return null;
        const unit = dateUnit(String(literal(2)));
        const amount = literal(1);
        // PostgreSQL interval range failures cannot be caught inside a scalar expression.
        if (!unit || typeof amount !== 'number' || Math.abs(amount) > 100_000) return null;
        const milliseconds = { millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000 };
        if (
          unit in milliseconds &&
          !Number.isSafeInteger(amount * milliseconds[unit as keyof typeof milliseconds])
        )
          return null;
        const count =
          unit === 'day' || unit === 'week'
            ? Math.round(amount * (unit === 'week' ? 7 : 1))
            : unit === 'month' || unit === 'quarter' || unit === 'year'
              ? Math.trunc(amount * (unit === 'quarter' ? 3 : unit === 'year' ? 12 : 1))
              : amount;
        const interval = `${count} ${unit === 'week' ? 'day' : unit === 'quarter' || unit === 'year' ? 'month' : unit}`;
        return finish(sql`(${local(a!)} + ${interval}::interval) AT TIME ZONE ${context.timeZone}`);
      }
      case 'WEEKDAY':
      case 'WEEKNUM': {
        if (a!.type === 'blank') return finish(castNull(type));
        if (!['date', 'datetime'].includes(String(a!.type))) return null;
        const start = args.length < 2 ? 'sunday' : String(literal(1)).toLowerCase();
        if (!['sunday', 'monday'].includes(start)) return null;
        const shift = start === 'monday' ? 6 : 0;
        if (node.name === 'WEEKDAY')
          return finish(sql`mod(extract(dow FROM ${local(a!)}) + ${shift}, ${7})::double precision`);
        return finish(
          sql`(floor((extract(doy FROM ${local(a!)}) - ${1} + mod(extract(dow FROM date_trunc(${'year'}, ${local(a!)})) + ${shift}, ${7})) / ${7}) + ${1})::double precision`,
        );
      }
      default:
        return null;
    }
  };
  const result = walk(ast);
  // A list result stays with JavaScript, which writes its items as they are.
  if (!result || (typeof result.type === 'object' && !context.arrayResult && !readsRecords(ast))) return null;
  let value = result.value;
  if (result.type === 'date') value = sql`to_char(${value}, ${'YYYY-MM-DD'})`;
  if (result.type === 'datetime')
    value = sql`to_char(${value} AT TIME ZONE ${'UTC'}, ${'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'})`;
  if (sameType(result.type, 'blank')) value = sql`NULL::text`;
  const from = clauses.reduce(
    (all, clause, i) => (i === 0 ? clause : sql`${all} CROSS JOIN ${clause}`),
    sql``,
  );
  return sql`(SELECT CASE WHEN ${result.error} IS NOT NULL THEN ${result.error} ELSE to_jsonb(${value}) END FROM ${from})`;
}
