import { readNamedFunctions } from '../data/named-functions.js';
import { FieldSpec, newId } from '@riosoma/contracts';
import { ident, query, sql, type Sql } from '@riosoma/db';
import { FUNCTIONS, check, parse, type Ast } from '@riosoma/formula';
import type { TableAccess } from '../api-v1/reads.js';
import { loadCollaborators } from '../data/metadata.js';
import { formulaExpression, prepareFormula } from '../data/physical/formulas.js';
import { formulaRead } from '../data/physical/records.js';
import type { ReadContext, StoredField } from '../data/types.js';
import { invalidFormula } from './errors.js';

/**
 * `filterByFormula` through Riosoma's formula engine, which takes Airtable's formula language and
 * function names.  A record is kept when the formula's result isn't 0, false, empty text, an empty
 * list, blank, or an error, as in Airtable.  The formula can name only the fields the caller can
 * see, so a filter can't find out what a hidden field holds.
 */

const LONGEST = 10_000;
/**
 * The most records a formula only JavaScript can work out filters, among those the caller can see.
 * Past this, reading every record into the server for each list would cost too much.
 */
export const SCAN_LIMIT = 100_000;

function calls(ast: Ast, into: Set<string>): Set<string> {
  switch (ast.kind) {
    case 'call':
      into.add(ast.name);
      for (const arg of ast.args) calls(arg, into);
      break;
    case 'unary':
      calls(ast.operand, into);
      break;
    case 'binary':
      calls(ast.left, into);
      calls(ast.right, into);
      break;
  }
  return into;
}

/** Why a formula can't filter, the way Airtable words it. */
function problem(messageKey: string, params: Readonly<Record<string, string | number>> = {}): string {
  switch (messageKey) {
    case 'formula.field.unknown':
    case 'formula.field.unresolved':
      return `Unknown field names: ${String(params.name ?? '')}`;
    case 'formula.field.ambiguous':
      return `More than one field is named ${String(params.name ?? '')}`;
    case 'formula.function.unknown':
      return `Unknown function names: ${String(params.name ?? '')}`;
    case 'formula.function.arity':
      return 'A function was given the wrong number of arguments';
    default:
      return 'Invalid formula. Please check your formula text.';
  }
}

/**
 * The formula checked against the table's visible fields, ready to compile for any moment.  It
 * throws `INVALID_FILTER_BY_FORMULA` when the formula can't be read or names something unknown.
 */
export async function filterFormula(text: string, access: TableAccess): Promise<StoredField> {
  if (text.length > LONGEST) throw invalidFormula(`The formula is longer than ${LONGEST} characters`);
  const parsed = parse(text);
  if ('error' in parsed) throw invalidFormula(problem(parsed.error.messageKey));
  const functions = await readNamedFunctions(
    access.pool,
    access.schemas,
    access.table.databaseId,
    access.scope,
  );
  const unknown = [...calls(parsed.ast, new Set())].filter(
    (name) =>
      !Object.hasOwn(FUNCTIONS, name) &&
      !functions.some((definition) => definition.name.toUpperCase() === name),
  );
  if (unknown.length) throw invalidFormula(`Unknown function names: ${unknown.join(', ')}`);
  const id = newId('field');
  const spec = FieldSpec.parse({ type: 'formula', options: { expression: text } });
  if (spec.type !== 'formula') throw new Error('a formula spec parsed as another type');
  const candidate: StoredField = {
    ...spec,
    // Request formulas have no stored cell or pin, and their generated ID must not change offsets.
    ignoreOverride: true,
    id,
    tableId: access.table.id,
    name: id,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
    columnName: id,
  };
  const people = new Map(
    (await loadCollaborators(access.pool, access.schemas, access.actor.orgId, access.scope)).map((person) => [
      person.id,
      person.name,
    ]),
  );
  const plan = prepareFormula(candidate, [...access.fields, candidate], people, false, functions);
  if (plan.error) throw invalidFormula(problem(plan.error.messageKey, plan.error.params));
  return { ...candidate, formula: plan };
}

/**
 * Whether the database can work the formula out itself.  Some functions, like `FIND`, `LOWER`, and
 * `ROUND`, run only in JavaScript, which `matchingIds` does instead.
 */
export function inDatabase(formula: StoredField, timeZone: string): boolean {
  return formulaExpression(formula, undefined, { now: new Date(), timeZone }) !== null;
}

/** SQL that holds for the records the formula keeps, at the read's moment and in its time zone. */
export function filterPredicate(formula: StoredField, context: ReadContext): Sql {
  const expression = formulaExpression(formula, undefined, context);
  if (!expression) throw new Error('filterPredicate needs a formula the database can work out');
  return sql`(SELECT CASE jsonb_typeof(kept.value)
      WHEN 'boolean' THEN (kept.value)::boolean
      WHEN 'number' THEN (kept.value)::numeric <> 0
      WHEN 'string' THEN (kept.value #>> '{}') <> ''
      WHEN 'array' THEN jsonb_array_length(kept.value) > 0
      ELSE false END FROM (SELECT ${expression} AS value) AS kept)`;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value !== '';
  return value === true;
}

type Raw = Parameters<ReturnType<typeof formulaRead>['decode']>[0];
const BATCH = 1_000;

/**
 * The functions that keep a formula out of the database: each call SQL can't work out although it
 * can work out the call's arguments.  A call that gives a list is one, since SQL never keeps a list
 * partway through a formula.
 */
export function outsideDatabase(formula: StoredField, context: ReadContext): string[] {
  const plan = formula.formula;
  if (!plan?.ast) return [];
  const names = new Set<string>();
  const inSql = (ast: Ast) =>
    formulaExpression({ ...formula, formula: { ...plan, ast } }, undefined, context) !== null;
  const visit = (ast: Ast): boolean => {
    const children =
      ast.kind === 'call'
        ? ast.args
        : ast.kind === 'binary'
          ? [ast.left, ast.right]
          : ast.kind === 'unary'
            ? [ast.operand]
            : [];
    if (!children.length) return true;
    const results = children.map(visit);
    if (results.includes(false)) return false;
    const checked = check(ast);
    const list = 'type' in checked && typeof checked.type === 'object';
    if (!list && inSql(ast)) return true;
    if (ast.kind === 'call') names.add(ast.name);
    return false;
  };
  visit(plan.ast);
  return [...names];
}

/**
 * The IDs of the records `predicate` allows that the formula keeps, worked out in JavaScript a
 * batch at a time, for formulas the database can't compute.  More than `limit` records to work
 * through gets `INVALID_FILTER_BY_FORMULA`, naming the functions that kept the formula out of SQL.
 */
export async function matchingIds(
  formula: StoredField,
  access: TableAccess,
  context: ReadContext,
  predicate: Sql,
  limit = SCAN_LIMIT,
): Promise<string[]> {
  const table = ident(access.schemas.data, access.table.id);
  const counted = await query<{ count: string }>(
    access.pool,
    sql`SELECT count(*) AS count FROM (SELECT 1 FROM ${table}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND (${predicate}) LIMIT ${limit + 1}) AS visible`,
  );
  if (Number(counted.rows[0]!.count) > limit) {
    const names = outsideDatabase(formula, context);
    const records = limit.toLocaleString('en-US');
    throw invalidFormula(
      names.length
        ? `it uses ${names.join(', ')}, which Riosoma can't apply to a table of more than ${records} records`
        : `Riosoma can't apply it to a table of more than ${records} records`,
    );
  }
  const read = formulaRead([formula], context);
  const kept: string[] = [];
  for (let after = 0; ;) {
    const result = await query<Raw>(
      access.pool,
      sql`SELECT ${read.select} FROM ${table}
      WHERE __deleted_at IS NULL AND NOT __source_gone AND __rid > ${after} AND (${predicate})
      ORDER BY __rid LIMIT ${BATCH}`,
    );
    for (const raw of result.rows) {
      const row = read.decode(raw);
      if (!row.errors?.[formula.id] && truthy(row.values[formula.id])) kept.push(row.id);
    }
    if (result.rows.length < BATCH) return kept;
    after = Number(result.rows.at(-1)!.__rid);
  }
}
