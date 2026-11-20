import { computedOverride } from './overrides.js';
import {
  AppError,
  templateFieldIds,
  type CellValue,
  type FieldSpec,
  type RowData,
  type NamedFunctionDefinition,
} from '@riosoma/contracts';
import {
  check,
  describe,
  evaluate,
  fieldType,
  isError,
  parse,
  references,
  resolve,
  type Ast,
  type EvaluationContext,
  type FormulaError,
  type FormulaField,
  type FormulaRecord,
  type FormulaType,
} from '@riosoma/formula';
import { compileSql, type SqlContext } from '@riosoma/formula/sql';
import { ident, sql, type Sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { columnRef, selectExpr, systemRef, SYSTEM } from './columns.js';
import { linkNamesError, linkNamesJson, relationError, relationExpr, resultType } from './relations.js';

function mapFields(
  ast: Ast,
  transform: (
    node: Extract<Ast, { kind: 'field' }>,
    parent?: Extract<Ast, { kind: 'call' }>,
    index?: number,
  ) => Ast,
): Ast {
  switch (ast.kind) {
    case 'field':
      return transform(ast);
    case 'unary':
      return { ...ast, operand: mapFields(ast.operand, transform) };
    case 'binary':
      return { ...ast, left: mapFields(ast.left, transform), right: mapFields(ast.right, transform) };
    case 'call':
      return {
        ...ast,
        args: ast.args.map((arg, index) =>
          arg.kind === 'field' ? transform(arg, ast, index) : mapFields(arg, transform),
        ),
      };
    default:
      return ast;
  }
}

function valueType(field: StoredField): FormulaType {
  // A range is its two ends and a signature its moment, which the engine knows how to read.
  if (field.type === 'dateRange' || field.type === 'signature' || field.type === 'changeLog')
    return fieldType(baseDescriptor(field));
  const type = resultType(field);
  if (field.type === 'lookup') return { array: type === 'array' ? 'text' : type };
  return type === 'array' ? { array: 'text' } : type;
}

/** The engine accepts scalar field descriptors; derived types supply the equivalent descriptor. */
function baseDescriptor(field: StoredField): FormulaField {
  return {
    id: field.id,
    tableId: field.tableId,
    tableName: field.tableName,
    name: field.name,
    type: field.type,
    options: {
      ...('includeTime' in field.options ? { includeTime: field.options.includeTime } : {}),
      ...('choices' in field.options ? { choices: field.options.choices } : {}),
    },
  };
}

/** A computed field keeps its own type, so the engine knows a lookup, and says what it holds. */
function descriptor(field: StoredField): FormulaField {
  if (!['count', 'rollup', 'lookup', 'link', 'formula'].includes(field.type)) return baseDescriptor(field);
  return { ...baseDescriptor(field), valueType: valueType(field) };
}

/** Types a lookup holds as JSON objects, which only JavaScript writes the way formulas read them. */
const OBJECT_ITEMS = new Set<string>(['dateRange', 'location', 'signature', 'multiCurrency', 'changeLog']);

/** Whether each item a lookup holds is a plain number, text, or true or false, which SQL can read. */
function plainItems(field: StoredField, seen = new Set<string>()): boolean {
  const target = field.relation?.target;
  if (!target || seen.has(target.id)) return true;
  if (OBJECT_ITEMS.has(target.type)) return false;
  const passes =
    target.type === 'lookup' || (target.type === 'rollup' && target.options.fn === 'arrayUnique');
  return !passes || plainItems(target, new Set([...seen, field.id]));
}

/**
 * The field IDs a stored formula's expression names, whether or not those fields are still there to
 * read, or null when the expression doesn't parse.
 */
export function expressionFieldIds(expression: string): string[] | null {
  const parsed = parse(expression);
  if ('error' in parsed) return null;
  return references(mapFields(parsed.ast, (node) => ({ ...node, fieldId: node.name })));
}

/**
 * Whether a field's dependencies lead back to it, in its own table or through others: through a
 * rollup of a formula elsewhere that reads a lookup of this one, through a link, whose linked
 * records' names are their primary field, or through an AI field, whose runs write its value from
 * what its prompt reads.  `table` holds the field's own table, whose formulas and prompts can name
 * it directly, where other tables' formulas and prompts have their fields written out.  `primary`
 * names a table's primary field as it's about to be, in place of the one it has.
 *
 * Answers `aiField` when an AI field is part of the loop, since its runs would set each other off
 * forever rather than fail to compute, `field` for any other loop, and false when there's none.
 */
export function readsBack(
  dependencies: readonly StoredField[],
  id: string,
  table: readonly StoredField[],
  primary?: { tableId: string; field: StoredField },
): false | 'field' | 'aiField' {
  const own = new Map(table.map((field) => [field.id, field]));
  const seen = new Set<string>();
  let throughAi = false;
  const visit = (field: StoredField): boolean => {
    if (field.id === id) return true;
    if (seen.has(field.id)) return false;
    seen.add(field.id);
    if (field.ai) {
      const reads = own.has(field.id)
        ? templateFieldIds(field.ai.prompt).flatMap((read) => own.get(read) ?? [])
        : (field.promptFields ?? []);
      if (!reads.some(visit)) return false;
      throughAi = true;
      return true;
    }
    if (field.type === 'formula') {
      if (!own.has(field.id)) return (field.formula?.fields ?? []).some(visit);
      const named = expressionFieldIds(field.options.expression) ?? [];
      return named.some((reference) => {
        const dependency = own.get(reference) ?? field.formula?.fields.find((item) => item.id === reference);
        return dependency ? visit(dependency) : false;
      });
    }
    if (field.type === 'link' || field.type === 'lineItems') {
      const name =
        primary && field.options.linkedTableId === primary.tableId ? primary.field : field.relation?.primary;
      return name ? visit(name) : false;
    }
    const target = field.relation?.target;
    return (target ? visit(target) : false) || (field.relation?.conditionFields ?? []).some(visit);
  };
  if (!dependencies.some(visit)) return false;
  return throughAi ? 'aiField' : 'field';
}

function resolved(
  expression: string,
  fields: readonly StoredField[],
  selfId: string,
  stored: boolean,
  tableId?: string,
  functions: readonly NamedFunctionDefinition[] = [],
) {
  const parsed = parse(expression);
  if ('error' in parsed) return parsed;
  const ids = new Set(fields.map((field) => field.id));
  const ast = mapFields(parsed.ast, (node) =>
    stored || ids.has(node.name)
      ? { ...node, fieldId: node.name, ...(stored && node.tableName ? { tableId: node.tableName } : {}) }
      : node,
  );
  const original = resolve(ast, fields.map(baseDescriptor), selfId, tableId);
  if ('error' in original) return original;
  const result = resolve(
    original.ast,
    fields.map(baseDescriptor),
    selfId,
    tableId,
    functions.map(({ name, parameters, body }) => ({ name, parameters, body })),
  );
  if ('error' in result) return result;
  const byId = new Map(fields.map((field) => [field.id, field]));
  return {
    originalAst: original.ast,
    ast: mapFields(result.ast, (node) => ({ ...node, valueType: valueType(byId.get(node.fieldId!)!) })),
  };
}

export function formulaValidation(error: FormulaError): never {
  throw new AppError('validation_failed', error.messageKey, {
    params: { ...error.params, start: error.start, end: error.end },
  });
}

/** Expand formula references so lazy branches and error handling retain engine semantics. */
export function prepareFormula(
  field: StoredField,
  fields: readonly StoredField[],
  people: ReadonlyMap<string, string> = new Map(),
  stored = true,
  functions: readonly NamedFunctionDefinition[] = field.namedFunctions ?? [],
): NonNullable<StoredField['formula']> {
  const byId = new Map(fields.map((item) => [item.id, item]));
  let error: FormulaError | undefined;
  const positionError = (node: Ast): void => {
    if (error) error = { ...error, start: node.start, end: node.end };
  };
  const visiting = new Set<string>();
  let expanded = 0;
  const expand = (current: StoredField, isStored: boolean): Ast | undefined => {
    if (current.type !== 'formula') return undefined;
    if (++expanded > 500 || visiting.size > 64) {
      error ??= { start: 0, end: current.options.expression.length, messageKey: 'formula.syntax.depth' };
      return undefined;
    }
    visiting.add(current.id);
    const result = resolved(
      current.options.expression,
      fields,
      current.id,
      isStored,
      current.tableId,
      functions,
    );
    if ('error' in result) {
      error ??= result.error;
      visiting.delete(current.id);
      return undefined;
    }
    const ast = mapFields(result.ast, (node, parent, index) => {
      const dependency = byId.get(node.fieldId!)!;
      if (dependency.type !== 'formula' || node.tableName !== undefined) return node;
      // Window keys retain their field identity for validation and read each record's computed value.
      if (
        parent &&
        index !== undefined &&
        ((['PREVIOUS', 'NEXT', 'RUNNINGSUM', 'RUNNINGCOUNT'].includes(parent.name) && index >= 1) ||
          (parent.name === 'RANK' && index === 2))
      )
        return node;
      if (visiting.has(dependency.id)) {
        error ??= { start: node.start, end: node.end, messageKey: 'formula.field.circular' };
        return node;
      }
      if (error) return node;
      expand(dependency, true);
      positionError(node);
      return node;
    });
    visiting.delete(current.id);
    return ast;
  };
  const ast = expand(field, stored);
  const checked = ast && check(ast);
  if (checked && 'error' in checked) error ??= checked.error;
  return {
    ...(ast ? { ast } : {}),
    ...(error ? { error } : {}),
    type: checked && 'type' in checked ? checked.type : valueType(field),
    fields: ast ? references(ast).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])) : [],
    people,
  };
}

export function formulaContext(field: StoredField, context?: EvaluationContext): EvaluationContext {
  return {
    now: context?.now ?? new Date(),
    timeZone:
      field.type === 'formula' && field.options.timeZone !== 'client'
        ? field.options.timeZone
        : (context?.timeZone ?? 'UTC'),
    records: context?.records,
    tables: context?.tables,
    people: field.formula?.people,
    choices: new Map([
      ...(field.formula?.fields ?? []).flatMap((dependency) =>
        dependency.type === 'singleSelect' || dependency.type === 'multipleSelect'
          ? dependency.options.choices.map((choice) => [choice.id, choice.name] as const)
          : [],
      ),
      ...(context?.choices ?? []),
    ]),
  };
}

/** Decimals a double can't hold: at least this large reads as infinity, and at most this small as zero. */
const TOO_LARGE = ((1n << 1024n) - (1n << 970n)).toString();
const TOO_SMALL = `0.${(5n ** 1075n).toString().padStart(1075, '0')}`;

/**
 * A number field's decimal, or a rollup's total, as the double a formula computes with.  A decimal
 * too large for any double is blank, as it is everywhere else, since JSON can't carry it either, and
 * one too small is zero.  A plain cast would fail the whole read over one such cell.
 */
function double(decimal: Sql): Sql {
  return sql`(SELECT CASE WHEN abs(stored.value) >= ${TOO_LARGE}::numeric THEN NULL
      WHEN abs(stored.value) <= ${TOO_SMALL}::numeric THEN 0::double precision
      ELSE stored.value::double precision END FROM (SELECT (${decimal})::numeric AS value) AS stored)`;
}

export function formulaExpression(
  field: StoredField,
  alias?: string,
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
  arrayResult = false,
): Sql | null {
  const plan = field.formula;
  if (!plan?.ast || plan.error) {
    return computedOverride(
      field,
      sql`${JSON.stringify({ error: '#ERROR!', messageKey: plan?.error?.messageKey ?? 'formula.field.unknown' })}::jsonb`,
      alias,
    );
  }
  const readContext = { now: new Date(context?.now ?? new Date()), timeZone: context?.timeZone ?? 'UTC' };
  const fields = new Map(plan.fields.map((dependency) => [dependency.id, { ...dependency, readContext }]));
  let depth = 0;
  const makeContext = (alias: string | undefined, tableId: string): SqlContext => ({
    ...formulaContext(field, context),
    arrayResult,
    choiceRef: (reference, id) => fields.get(reference.id)?.selectRead?.name(id) ?? null,
    columnRef: (reference) => {
      const dependency = fields.get(reference.id);
      if (!dependency) return null;
      // A link reads as its linked records' names, and a lookup of choices or links by their names.
      if (dependency.type === 'changeLog') return null;
      if (dependency.type === 'link' || dependency.type === 'lineItems')
        return linkNamesJson(dependency, alias);
      if (dependency.type === 'lookup' && !plainItems(dependency)) return null;
      if (dependency.type === 'lookup')
        return computedOverride(dependency, relationExpr(dependency, alias, true), alias);
      if (dependency.type === 'formula') {
        const inner = formulaExpression(dependency, alias, context, arrayResult);
        return inner
          ? arrayResult && typeof dependency.formula?.type === 'object'
            ? inner
            : scalarExpression(dependency, inner)
          : null;
      }
      const column = columnRef(dependency, alias);
      if (dependency.type === 'multiCurrency')
        return sql`(${column} ->> 'code') || ' ' || (${column} ->> 'amount')`;
      if (dependency.type === 'signature') return sql`((${column}) ->> 'signedAt')::timestamptz`;
      // Coordinates are stored rounded to six places, so their text matches JavaScript's.
      if (dependency.type === 'location')
        return sql`CASE WHEN ${column} IS NULL THEN NULL
          ELSE ((${column}) ->> 'lat') || ', ' || ((${column}) ->> 'lng') END`;
      const expr = selectExpr(dependency, alias);
      const type = valueType(dependency);
      if (type === 'number' && (dependency.type === 'number' || dependency.type === 'rollup'))
        return double(dependency.type === 'number' ? column : expr);
      return type === 'number'
        ? sql`(${expr})::double precision`
        : type === 'date'
          ? sql`(${expr})::date`
          : type === 'datetime'
            ? sql`(${expr})::timestamptz`
            : expr;
    },
    // A lookup or rollup of an erroring formula passes that error on, as it does in JavaScript, and
    // so does a link whose records have no name here.
    errorRef: (reference) => {
      const dependency = fields.get(reference.id);
      if (!dependency) return null;
      if (dependency.type === 'formula') {
        const value = formulaExpression(dependency, alias, context, arrayResult);
        return value ? sql`CASE WHEN jsonb_typeof(${value}) = 'object' THEN ${value} END` : null;
      }
      return dependency.type === 'link' || dependency.type === 'lineItems'
        ? linkNamesError(dependency, alias)
        : relationError(dependency, alias, true);
    },
    systemRef: (name) => systemRef(SYSTEM[name], alias ?? tableId),
    recordSource: (requested) => {
      if (!field.dataSchema) return null;
      const target = requested ?? tableId;
      if (target !== field.tableId && !plan.fields.some((item) => item.tableId === target)) return null;
      const record = `cross_${field.id}_${depth++}`;
      return {
        from: sql`${ident(field.dataSchema, target)} AS ${ident(record)}`,
        where: sql`${ident(record, '__deleted_at')} IS NULL AND NOT ${ident(record, '__source_gone')}
          AND ${plan.scope?.(target, record) ?? sql`TRUE`}`,
        context: makeContext(record, target),
      };
    },
  });
  const expression = compileSql(
    plan.ast,
    plan.fields.map(descriptor),
    makeContext(alias ?? field.tableId, field.tableId),
  );
  return expression ? computedOverride(field, expression, alias) : null;
}

/** Errors become SQL NULL before scalar casts used by filters, sorts, and display. */
export function formulaScalar(
  field: StoredField,
  alias?: string,
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
): Sql {
  const expression = formulaExpression(field, alias, context);
  if (!expression) throw new AppError('validation_failed', 'data.formula.notSortable');
  return scalarExpression(field, expression);
}

function scalarExpression(field: StoredField, expression: Sql): Sql {
  // Keep the formula shared between the type check and scalar read.  Inlining it duplicates
  // every subplan, including number formatting and linked-record reads.
  const value = sql`(SELECT CASE WHEN jsonb_typeof(formula_value.value) = 'object' THEN NULL
    ELSE formula_value.value #>> '{}' END FROM (SELECT ${expression} AS value OFFSET 0) AS formula_value)`;
  const type = field.formula?.type ?? valueType(field);
  return type === 'number'
    ? sql`(${value})::numeric`
    : type === 'boolean'
      ? sql`(${value})::boolean`
      : type === 'date'
        ? sql`(${value})::date`
        : type === 'datetime'
          ? sql`(${value})::timestamptz`
          : value;
}

export function formulaSpec(
  spec: FieldSpec,
  id: string,
  fields: readonly StoredField[],
  name?: string,
  tableId = fields[0]?.tableId ?? '',
  functions: readonly NamedFunctionDefinition[] = fields[0]?.namedFunctions ?? [],
): FieldSpec {
  if (spec.type !== 'formula') return spec;
  const candidate: StoredField = {
    ...spec,
    id,
    name: name ?? fields.find((field) => field.id === id)?.name ?? id,
    columnName: id,
    tableId,
    dataSchema: fields[0]?.dataSchema,
    description: '',
    position: 0,
    createdAt: '',
    updatedAt: '',
  };
  const available = [...fields.filter((field) => field.id !== id), candidate];
  const original = resolved(spec.options.expression, available, id, false, tableId, functions);
  if ('error' in original) formulaValidation(original.error);
  const plan = prepareFormula(candidate, available, new Map(), false, functions);
  if (plan.error) formulaValidation(plan.error);
  // A loop within this table is caught above.  One through other tables' fields, or through an AI
  // field's prompt, is caught here.
  const loop = readsBack(plan.fields, id, fields);
  if (loop)
    formulaValidation({
      start: 0,
      end: spec.options.expression.length,
      messageKey: loop === 'aiField' ? 'aiFields.loop' : 'formula.field.circular',
    });
  const expression = describe(
    original.originalAst,
    available.map((field) => ({ ...baseDescriptor(field), name: field.id, tableName: field.tableId })),
  );
  return {
    ...spec,
    options: {
      ...spec.options,
      expression,
      resultType: typeof plan.type === 'object' ? 'array' : plan.type === 'blank' ? 'text' : plan.type,
      sortable: formulaExpression({ ...candidate, formula: plan }) !== null,
    },
  };
}

export function formulaUsesClock(field: StoredField): boolean {
  const visit = (ast: Ast): boolean => {
    switch (ast.kind) {
      case 'call':
        return ['NOW', 'TODAY'].includes(ast.name) || ast.args.some(visit);
      case 'binary':
        return visit(ast.left) || visit(ast.right);
      case 'unary':
        return visit(ast.operand);
      default:
        return false;
    }
  };
  return !!field.formula?.ast && visit(field.formula.ast);
}

export function evaluateFormula(
  field: StoredField,
  row: FormulaRecord,
  context?: EvaluationContext,
): unknown {
  const plan = field.formula;
  if (plan?.error || !plan?.ast)
    return { error: '#ERROR!', messageKey: plan?.error?.messageKey ?? 'formula.field.unknown' };
  return evaluate(plan.ast, row, formulaContext(field, context));
}

export function setFormulaValue(row: RowData, field: StoredField, value: unknown): void {
  if (isError(value)) {
    row.values[field.id] = null;
    (row.errors ??= {})[field.id] = value.messageKey;
  } else row.values[field.id] = value as CellValue;
}
