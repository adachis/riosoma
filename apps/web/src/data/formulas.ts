import {
  cellValue,
  FieldOptions,
  idsOf,
  type CellValue,
  type FieldMeta,
  type FieldSpec,
  type ResultType,
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
  readsRecords,
  resolve,
  type Ast,
  type EvaluationContext,
  type FormulaError,
  type FormulaField,
  type FormulaType,
  type FormulaValue,
} from '@riosoma/formula';

/** The kind of value a field holds, as the server works it out for formulas, lookups, and rollups. */
export function resultType(field: FieldSpec): ResultType {
  switch (field.type) {
    case 'number':
    case 'count':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating':
    case 'autoNumber':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
      return field.options.includeTime ? 'datetime' : 'date';
    case 'createdTime':
    case 'lastModifiedTime':
      return 'datetime';
    case 'multipleSelect':
    case 'lineItems':
    case 'link':
    case 'user':
      return 'array';
    case 'lookup':
    case 'rollup':
    case 'formula':
      return field.options.resultType;
    default:
      return 'text';
  }
}

/** A scalar presentation of a computed result, shared by drawing and filter controls. */
export function resultField(field: FieldMeta): FieldMeta {
  if (!['lookup', 'rollup', 'count', 'formula'].includes(field.type)) return field;
  const type = resultType(field);
  const precision = 'precision' in field.options ? field.options.precision : null;
  if (type === 'number')
    return { ...field, type: 'number', options: FieldOptions.number.parse({ precision }) };
  if (type === 'boolean') return { ...field, type: 'checkbox', options: FieldOptions.checkbox.parse({}) };
  if (type === 'date' || type === 'datetime')
    return {
      ...field,
      type: 'date',
      options: FieldOptions.date.parse({ ...field.options, includeTime: type === 'datetime' }),
    };
  return { ...field, type: 'text', options: {} };
}

function mapAst(ast: Ast, field: (node: Extract<Ast, { kind: 'field' }>) => Ast): Ast {
  switch (ast.kind) {
    case 'field':
      return field(ast);
    case 'unary':
      return { ...ast, operand: mapAst(ast.operand, field) };
    case 'binary':
      return { ...ast, left: mapAst(ast.left, field), right: mapAst(ast.right, field) };
    case 'call':
      return { ...ast, args: ast.args.map((arg) => mapAst(arg, field)) };
    default:
      return ast;
  }
}

function valueType(field: FieldMeta, fields: readonly FieldMeta[], seen = new Set<string>()): FormulaType {
  if (seen.has(field.id)) return 'blank';
  seen.add(field.id);
  // A range is its two ends and a signature its moment, which the engine knows how to read.
  if (field.type === 'dateRange' || field.type === 'signature') return fieldType(formulaFields([field])[0]!);
  // Lookup resultType describes each item, while its stored value is always a list.
  if (field.type === 'lookup') {
    const target = fields.find((other) => other.id === field.options.targetFieldId);
    const item = target ? valueType(target, fields, seen) : field.options.resultType;
    return typeof item === 'object' ? item : { array: item === 'array' ? 'text' : item };
  }
  const type = resultType(field);
  return type === 'array' ? { array: 'text' } : type;
}

function formulaFields(
  fields: readonly FieldMeta[],
  tables: readonly { id: string; name: string }[] = [],
): FormulaField[] {
  return fields.map((field) => ({
    id: field.id,
    tableId: field.tableId,
    tableName: tables.find((table) => table.id === field.tableId)?.name,
    name: field.name,
    type: field.type,
    options: {
      ...('includeTime' in field.options ? { includeTime: field.options.includeTime } : {}),
      ...('choices' in field.options ? { choices: field.options.choices } : {}),
    },
  }));
}

export type CheckedFormula =
  | {
      ast: Ast;
      originalAst: Ast;
      type: ResultType;
      expression: string;
      /** Lookups the formula reads as their one value, by field ID */
      oneValue: readonly string[];
    }
  | { error: FormulaError };

function resolvedExpression(
  expression: string,
  fields: readonly FieldMeta[],
  selfId: string | undefined,
  tables: readonly { id: string; name: string }[],
  tableId: string | undefined,
) {
  const parsed = parse(expression);
  if ('error' in parsed) return parsed;
  const byId = new Map(fields.map((field) => [field.id, field]));
  const stable = mapAst(parsed.ast, (node) => (byId.has(node.name) ? { ...node, fieldId: node.name } : node));
  return resolve(stable, formulaFields(fields, tables), selfId, tableId);
}

/** IDs survive renames; editable names and saved IDs both resolve through the same path. */
export function checkFormula(
  expression: string,
  fields: readonly FieldMeta[],
  selfId?: string,
  tables: readonly { id: string; name: string }[] = [],
  tableId = fields.find((field) => field.id === selfId)?.tableId ?? fields[0]?.tableId,
  functions: readonly NamedFunctionDefinition[] = [],
): CheckedFormula {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const original = resolvedExpression(expression, fields, selfId, tables, tableId);
  if ('error' in original) return original;
  const resolved = resolve(
    original.ast,
    formulaFields(fields, tables),
    selfId,
    tableId,
    functions.map(({ name, parameters, body }) => ({ name, parameters, body })),
  );
  if ('error' in resolved) return resolved;
  const ast = mapAst(resolved.ast, (node) => ({
    ...node,
    valueType: valueType(byId.get(node.fieldId!)!, fields),
  }));
  if (selfId) {
    const visits = new Set<string>();
    const reachesSelf = (id: string): boolean => {
      if (id === selfId) return true;
      if (visits.has(id)) return false;
      visits.add(id);
      const field = byId.get(id);
      if (field?.type !== 'formula') return false;
      const other = checkFormula(
        field.options.expression,
        fields,
        undefined,
        tables,
        field.tableId,
        functions,
      );
      return 'ast' in other && references(other.ast).some(reachesSelf);
    };
    if (references(ast).some(reachesSelf))
      return { error: { messageKey: 'formula.field.circular', start: 0, end: expression.length } };
  }
  const checked = check(ast);
  if ('error' in checked) return checked;
  return {
    ast,
    originalAst: original.ast,
    type: typeof checked.type === 'object' ? 'array' : checked.type === 'blank' ? 'text' : checked.type,
    oneValue: checked.oneValue ?? [],
    expression: describe(
      original.ast,
      formulaFields(fields).map((field) => ({ ...field, name: field.id, tableName: field.tableId })),
    ),
  };
}

export function formulaDisplay(
  expression: string,
  fields: readonly FieldMeta[],
  tables: readonly { id: string; name: string }[] = [],
  tableId?: string,
): string {
  // Field names remain readable while a missing function or invalid call is being repaired.
  const formula = resolvedExpression(expression, fields, undefined, tables, tableId ?? fields[0]?.tableId);
  return 'ast' in formula ? describe(formula.ast, formulaFields(fields, tables)) : expression;
}

function cellResult(value: FormulaValue): CellValue {
  if (isError(value)) return null;
  if (!Array.isArray(value)) return value;
  return value.flatMap((item) => {
    const flat = cellResult(item);
    return flat === null ? [] : Array.isArray(flat) ? flat : [flat];
  });
}

/**
 * What formulas computed here read beyond the row: the records' names the server gave, by record
 * ID, every field in the database by ID, for what a lookup reaches, and every table by ID, for the
 * primary fields that name records.
 */
export interface ComputeContext extends EvaluationContext {
  namedFunctions?: readonly NamedFunctionDefinition[];
  names?: ReadonlyMap<string, string>;
  fieldById?: ReadonlyMap<string, FieldMeta>;
  tableById?: ReadonlyMap<string, { primaryFieldId: string }>;
}

/** Whether each primary field formula names its records, by the schema it's part of */
const naming = new WeakMap<object, Map<string, boolean>>();

/**
 * Whether formulas can read the names of a table's records.  They can't when its primary field is
 * a formula with an error, or one only JavaScript computes, which the server reads as an error, so
 * a formula here keeps what the server gave it.
 */
function readableNames(tableId: string, context: ComputeContext): boolean {
  const primaryId = context.tableById?.get(tableId)?.primaryFieldId;
  const primary = primaryId ? context.fieldById?.get(primaryId) : undefined;
  if (primary?.type !== 'formula' || !context.fieldById) return true;
  let known = naming.get(context.fieldById);
  if (!known) {
    known = new Map();
    naming.set(context.fieldById, known);
  }
  let readable = known.get(primary.id);
  if (readable === undefined) {
    const siblings = [...context.fieldById.values()].filter((field) => field.tableId === primary.tableId);
    readable =
      primary.options.sortable &&
      'ast' in
        checkFormula(
          primary.options.expression,
          siblings,
          primary.id,
          [],
          primary.tableId,
          context.namedFunctions,
        );
    known.set(primary.id, readable);
  }
  return readable;
}

/**
 * The field a lookup reaches through lookups of lookups, when formulas read it by another name
 * than the lookup holds: a choice, held as its ID, or a linked record, held as its ID.
 */
function namedTarget(
  field: FieldMeta,
  fieldById: ReadonlyMap<string, FieldMeta> | undefined,
  seen = new Set<string>(),
): FieldMeta | undefined {
  if (field.type !== 'lookup' || seen.has(field.id)) return undefined;
  const target = fieldById?.get(field.options.targetFieldId);
  if (!target) return undefined;
  if (
    target.type === 'singleSelect' ||
    target.type === 'multipleSelect' ||
    target.type === 'link' ||
    target.type === 'lineItems'
  )
    return target;
  return namedTarget(target, fieldById, new Set([...seen, field.id]));
}

/**
 * A link's or a lookup's value as formulas read it, by name, the way the server reads it: a link as
 * each linked record's name, and a lookup of choices or links as their names, leaving out blank
 * ones as a lookup leaves out every blank.  Undefined when a record's name isn't known here yet.
 */
function readByName(field: FieldMeta, value: CellValue, context: ComputeContext): CellValue | undefined {
  const name = (id: string) => context.names?.get(id);
  if (field.type === 'link' || field.type === 'lineItems') {
    if (!readableNames(field.options.linkedTableId, context)) return undefined;
    const names = idsOf(value).map(name);
    return names.every((item) => item !== undefined) ? (names as string[]) : undefined;
  }
  const target = namedTarget(field, context.fieldById);
  if (!target) return value;
  if (
    (target.type === 'link' || target.type === 'lineItems') &&
    !readableNames(target.options.linkedTableId, context)
  )
    return undefined;
  const choices =
    target.type === 'singleSelect' || target.type === 'multipleSelect'
      ? new Map(target.options.choices.map((choice) => [choice.id, choice.name]))
      : undefined;
  const names: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue;
    const found = choices ? (choices.get(item) ?? '') : name(item);
    if (found === undefined) return undefined;
    if (found !== '') names.push(found);
  }
  return names;
}

/** Prepare once per schema; rows and clocks are deliberately never captured by this cache. */
export function formulaComputer(
  fields: readonly FieldMeta[],
  functions: readonly NamedFunctionDefinition[] = [],
) {
  const prepared = new Map(
    fields
      .filter((field) => field.type === 'formula')
      .map((field) => [
        field.id,
        checkFormula(field.options.expression, fields, field.id, [], field.tableId, functions),
      ]),
  );
  const serverComputed = new Set(
    fields
      .filter((field) => {
        if (field.type !== 'formula') return false;
        const formula = prepared.get(field.id);
        const parsed = parse(field.options.expression);
        return (
          ('ast' in parsed && readsRecords(parsed.ast)) ||
          (!!formula && 'ast' in formula && readsRecords(formula.ast))
        );
      })
      .map((field) => field.id),
  );
  const byName = fields.filter(
    (field) => field.type === 'link' || field.type === 'lineItems' || field.type === 'lookup',
  );
  return (row: RowData, context: ComputeContext): RowData => {
    if (!prepared.size) return row;
    const values = { ...row.values };
    const errors = { ...row.errors };
    // Links and lookups of choices and links, as formulas read them.  A formula over names this
    // session doesn't know yet keeps the value the server gave it.
    const named = new Map<string, CellValue>();
    const unknown = new Set<string>();
    for (const field of byName) {
      const value = readByName(field, cellValue(row, field), context);
      if (value === undefined) unknown.add(field.id);
      else named.set(field.id, value);
    }
    const done = new Set<string>();
    const visiting = new Set<string>();
    const compute = (id: string): void => {
      if (done.has(id) || serverComputed.has(id)) return;
      const formula = prepared.get(id);
      if (!formula) return;
      if (visiting.has(id)) {
        errors[id] = 'formula.field.circular';
        values[id] = null;
        return;
      }
      visiting.add(id);
      if ('error' in formula) {
        errors[id] = formula.error.messageKey;
        values[id] = null;
      } else if (references(formula.ast).some((reference) => unknown.has(reference))) {
        values[id] = row.values[id] ?? null;
        if (row.errors?.[id]) errors[id] = row.errors[id];
        else delete errors[id];
      } else {
        references(formula.ast).forEach(compute);
        // Error values remain visible to ISERROR and lazy branches of dependent formulas.
        const inputs = { ...values };
        for (const field of fields)
          if (field.type !== 'formula')
            inputs[field.id] = named.has(field.id)
              ? named.get(field.id)!
              : cellValue({ ...row, values }, field);
        for (const reference of references(formula.ast))
          if (errors[reference])
            Object.assign(inputs, { [reference]: { error: '#ERROR!', messageKey: errors[reference] } });
        const result = evaluate(formula.ast, { ...row, values: inputs }, context);
        values[id] = cellResult(result);
        if (isError(result)) errors[id] = result.messageKey;
        else delete errors[id];
      }
      visiting.delete(id);
      done.add(id);
    };
    prepared.forEach((_, id) => compute(id));
    return { ...row, values, errors };
  };
}

/**
 * The tables whose records' names a table's formulas read, through links and lookups of links, so
 * a change to one of those records changes the formulas.
 */
export function namesRead(
  fields: readonly FieldMeta[],
  fieldById: ReadonlyMap<string, FieldMeta>,
  functions: readonly NamedFunctionDefinition[] = [],
): Set<string> {
  const byId = fieldById;
  const tables = new Set<string>();
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const field = byId.get(id);
    if (field?.type === 'link') tables.add(field.options.linkedTableId);
    if (field?.type === 'lookup') {
      const target = namedTarget(field, fieldById);
      if (target?.type === 'link') tables.add(target.options.linkedTableId);
    }
    if (field?.type === 'formula') {
      const formula = checkFormula(
        field.options.expression,
        [...fieldById.values()],
        field.id,
        [],
        field.tableId,
        functions,
      );
      if ('ast' in formula) {
        if (readsRecords(formula.ast)) {
          tables.add(field.tableId);
          references(formula.ast).forEach((id) => {
            const dependency = fieldById.get(id);
            if (dependency) tables.add(dependency.tableId);
          });
        }
        references(formula.ast).forEach(visit);
      }
    }
  };
  for (const field of fields) if (field.type === 'formula') visit(field.id);
  return tables;
}
