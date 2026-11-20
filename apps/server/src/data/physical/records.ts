import { lineItemTotals, totalsColumn } from './line-items.js';
import {
  cellValue,
  numericList,
  choicesForRecord,
  type Choice,
  isOverrideType,
  sameValue,
  type ChangeBody,
  type CellValue,
  type CellValues,
  type RowData,
  type Override,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable, type Sql } from '@riosoma/db';
import {
  hiddenLinkCount,
  linkIdsExpr,
  linkNamesError,
  linkNamesJson,
  readsByName,
  relationError,
  relationExpr,
} from './relations.js';
import { captureLinkPositions, replaceLinks, type LinkPositions } from './links.js';
import { matchedLinks, MatchRefresh } from './matches.js';
import type { StoredField } from '../types.js';
import { recordError } from '../value-errors.js';
import { SOURCE_CELL_ERRORS } from '../source-cell-errors.js';
import { refuseManagedValues, type ManagedGrant } from '../managed.js';
import { columnRef, columnType, decodeValue, jsonValueExpr, selectExpr, SYSTEM_SELECT } from './columns.js';
import { evaluateFormula, formulaExpression, setFormulaValue } from './formulas.js';
import { computedOverride } from './overrides.js';
import { readsRecords, type ErrorValue, type EvaluationContext, type FormulaRecord } from '@riosoma/formula';

export interface RecordInput {
  id: string;
  values: CellValues;
  overrides?: Record<string, Override | null>;
}

interface StoredRow extends Record<string, unknown> {
  __overrides: Record<string, Override> | null;
  __rid: string;
  __id: string;
  __created_at: string;
  __created_by: string | null;
  __updated_at: string;
  __updated_by: string | null;
}

/** The column holding a lookup's or rollup's error, beside its value. */
const errorColumn = (fieldId: string) => `__error_${fieldId}`;
/** The column holding how many of a link's records a record rule hides from the reader. */
const hiddenColumn = (fieldId: string) => `__hidden_${fieldId}`;
/** The columns holding a link's or lookup's value as formulas read it, by name, and its error. */
const namedColumn = (fieldId: string) => `__named_${fieldId}`;
const namedErrorColumn = (fieldId: string) => `__named_error_${fieldId}`;

/** Whether formulas read a field by names its value doesn't hold: a link, or a lookup of choices or links. */
const readByName = (field: StoredField) =>
  field.type === 'link' || field.type === 'lineItems' || readsByName(field);
/** A list read by name, with a number too large for JavaScript as a blank, as a lookup reads it. */
const namedList = (raw: unknown): CellValue =>
  Array.isArray(raw)
    ? (raw.map((item: unknown) =>
        typeof item === 'number' && !Number.isFinite(item) ? null : item,
      ) as CellValue)
    : [];

function selectTarget(field: StoredField): StoredField | undefined {
  const seen = new Set<string>();
  while (field.type === 'lookup' && field.relation?.target && !seen.has(field.id)) {
    seen.add(field.id);
    field = field.relation.target;
  }
  return field.selectRead ? field : undefined;
}

function rowSelect(
  fields: readonly StoredField[],
  alias?: string,
  includeTrashedLinks = false,
  formulas?: ReadonlyMap<string, Sql | null>,
): Sql {
  return join(
    [
      SYSTEM_SELECT(alias),
      ...fields
        .filter((field) => field.type === 'lineItems')
        .map((field) => sql`${lineItemTotals(field, alias)} AS ${totalsColumn(field.id)}`),
      ...fields.flatMap((field) =>
        (field.sparklineSources ?? []).map(
          (source, index) =>
            sql`${relationExpr(source.field, alias)} AS ${ident(`__sparkline_${field.id}_${index}`)}`,
        ),
      ),
      ...fields.flatMap((field) => {
        const target = selectTarget(field);
        if (!target?.selectRead) return [];
        const ids =
          field.type === 'lookup'
            ? sql`ARRAY(SELECT jsonb_array_elements_text(${selectExpr(field, alias)}))`
            : field.type === 'multipleSelect'
              ? columnRef(field, alias)
              : sql`ARRAY[${columnRef(field, alias)}]`;
        return [sql`${target.selectRead.choices(ids)} AS ${ident(`__choices_${field.id}`)}`];
      }),
      ...fields
        .filter((f) => f.type !== 'formula' || formulas?.has(f.id))
        .map(
          (field) =>
            sql`${field.type === 'formula' ? (formulas?.get(field.id) ?? sql`NULL::jsonb`) : (field.type === 'link' || field.type === 'lineItems') && includeTrashedLinks ? linkIdsExpr(field, alias, true) : selectExpr(field, alias)} AS ${ident(field.id)}`,
        ),
      ...fields.flatMap((field) => {
        const error = relationError(field, alias);
        return error ? [sql`${error} AS ${ident(errorColumn(field.id))}`] : [];
      }),
      ...fields.flatMap((field) => {
        const hidden = includeTrashedLinks ? null : hiddenLinkCount(field, alias);
        return hidden ? [sql`${hidden} AS ${ident(hiddenColumn(field.id))}`] : [];
      }),
    ],
    ', ',
  );
}

/** The reason in an error value, as a formula or a lookup or rollup of one gives it. */
function reasonOf(value: unknown): string | null {
  return typeof value === 'object' &&
    value !== null &&
    'messageKey' in value &&
    typeof value.messageKey === 'string'
    ? value.messageKey
    : null;
}

function decodeRow(row: StoredRow, fields: readonly StoredField[]): RowData {
  const values: Record<string, CellValue> = Object.fromEntries(
    fields
      .filter(
        (f) =>
          columnType(f) || ['link', 'lineItems', 'lookup', 'rollup', 'count', 'changeLog'].includes(f.type),
      )
      .map((field) => [field.id, decodeValue(field, row[field.id])]),
  );
  // A lookup or rollup of an erroring formula is blank, with the reason beside it, as a formula is.
  const errors: Record<string, string> = {};
  const sourceErrors = row.__overrides?.[SOURCE_CELL_ERRORS] as unknown as
    Record<string, unknown> | undefined;
  for (const field of fields) {
    const sourceReason = reasonOf(sourceErrors?.[field.id]);
    if (sourceReason && field.source && !row.__overrides?.[field.id]) {
      values[field.id] = null;
      errors[field.id] = sourceReason;
    }

    const reason = reasonOf(row[errorColumn(field.id)]);
    if (!reason) continue;
    values[field.id] = null;
    errors[field.id] = reason;
  }
  for (const field of fields) {
    if ((field.type !== 'singleSelect' && field.type !== 'multipleSelect') || !field.options.cascade)
      continue;
    if (!Object.hasOwn(values, field.options.cascade.fieldId)) continue;
    const value = values[field.id];
    const selected = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    const allowed = new Set(choicesForRecord(field.options, values).map((choice) => choice.id));
    if (selected.some((id) => typeof id === 'string' && !allowed.has(id)))
      errors[field.id] = 'data.select.parentChoice';
  }
  const hiddenLinks: Record<string, number> = {};
  for (const field of fields) {
    const count = Number(row[hiddenColumn(field.id)] ?? 0);
    if (count > 0) hiddenLinks[field.id] = count;
  }
  const overrides = Object.fromEntries(
    Object.entries(row.__overrides ?? {}).filter(([id]) =>
      fields.some((field) => field.id === id && !field.joinedPartial),
    ),
  );
  const selectChoices: Record<string, Choice[]> = {};
  for (const field of fields) {
    const target = selectTarget(field);
    if (!target) continue;
    const choices = new Map((selectChoices[target.id] ?? []).map((choice) => [choice.id, choice]));
    for (const choice of (row[`__choices_${field.id}`] ?? []) as Choice[]) choices.set(choice.id, choice);
    selectChoices[target.id] = [...choices.values()];
  }
  return {
    id: row.__id,
    ...(fields.some((field) => field.sparklineSources?.length)
      ? {
          sparklineValues: Object.fromEntries(
            fields.flatMap((field) =>
              (field.sparklineSources ?? []).map((source, index) => [
                source.key,
                numericList(row[`__sparkline_${field.id}_${index}`]),
              ]),
            ),
          ),
        }
      : {}),
    ...(Object.keys(selectChoices).length ? { selectChoices } : {}),
    ...(Object.keys(overrides).length
      ? {
          overrides,
        }
      : {}),
    values,
    ...(fields.some((field) => field.type === 'lineItems')
      ? {
          lineItemTotals: Object.fromEntries(
            fields
              .filter((field) => field.type === 'lineItems')
              .map((field) => [field.id, row[`__totals_${field.id}`] ?? {}]),
          ) as Record<string, Record<string, number>>,
        }
      : {}),
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(Object.keys(hiddenLinks).length ? { hiddenLinks } : {}),
    createdAt: row.__created_at,
    createdBy: row.__created_by,
    updatedAt: row.__updated_at,
    updatedBy: row.__updated_by,
  };
}

interface FormulaRead {
  select: Sql;
  decode(raw: StoredRow): RowData;
}

interface FormulaRecordSet {
  column: string;
  fields: StoredField[];
  read: FormulaRead;
}

/** Fetch hidden dependencies for fallback evaluation, but return only the requested fields. */
export function formulaRead(
  fields: readonly StoredField[],
  context: Pick<EvaluationContext, 'now' | 'timeZone'> = { now: new Date(), timeZone: 'UTC' },
  asOperand = false,
  includeTrashedLinks = false,
): FormulaRead {
  const readContext = { now: new Date(context.now), timeZone: context.timeZone };
  fields = fields.map((field) => ({ ...field, readContext }));
  const selected = new Map(fields.map((field) => [field.id, field]));
  const expressions = new Map<string, Sql | null>();
  for (const field of selected.values()) {
    if (field.type !== 'formula' || !field.formula) continue;
    const expression = formulaExpression(field, undefined, context);
    expressions.set(field.id, expression);
    if (!expression)
      for (const dependency of field.formula?.fields ?? [])
        if (dependency.tableId === field.tableId && !selected.has(dependency.id))
          selected.set(dependency.id, { ...dependency, readContext });
  }
  const all = [...selected.values()];
  // JavaScript reads a link as its records' names, and a lookup of choices or links by their names,
  // from the same expressions SQL reads them with.
  const named = new Map<string, StoredField>();
  if (asOperand) for (const field of all) if (readByName(field)) named.set(field.id, field);
  for (const field of all)
    if (field.type === 'formula' && !expressions.get(field.id))
      for (const dependency of field.formula?.fields ?? [])
        if (dependency.tableId === field.tableId && readByName(dependency))
          named.set(dependency.id, dependency);
  const namedSelect = [...named.values()].flatMap((field) => {
    const error =
      field.type === 'link' || field.type === 'lineItems'
        ? linkNamesError(field)
        : relationError(field, undefined, true);
    return [
      sql`${field.type === 'link' || field.type === 'lineItems' ? linkNamesJson(field) : computedOverride(field, relationExpr(field, undefined, true))} AS ${ident(namedColumn(field.id))}`,
      ...(error ? [sql`${error} AS ${ident(namedErrorColumn(field.id))}`] : []),
    ];
  });
  const recordSets = new Map<string, Map<string, FormulaRecordSet>>();
  const recordSelect: Sql[] = [];
  for (const field of fields) {
    const plan = field.formula;
    if (expressions.get(field.id) || !plan?.ast || !readsRecords(plan.ast) || !field.dataSchema) continue;
    const groups = new Map<string, StoredField[]>([[field.tableId, []]]);
    for (const dependency of plan.fields) {
      const group = groups.get(dependency.tableId) ?? [];
      group.push(dependency);
      groups.set(dependency.tableId, group);
    }
    const sets = new Map<string, FormulaRecordSet>();
    for (const [tableId, fields] of groups) {
      const read = formulaRead(fields, context, true);
      const column = `__records_${field.id}_${tableId}`;
      sets.set(tableId, { column, fields, read });
      // JavaScript-only arguments need complete source records under the same scope as SQL calls.
      recordSelect.push(sql`(SELECT COALESCE(jsonb_agg(to_jsonb(source) ORDER BY source.__created_at, source.__id), '[]'::jsonb)
        FROM (SELECT ${read.select} FROM ${ident(field.dataSchema, tableId)}
          WHERE __deleted_at IS NULL AND NOT __source_gone AND ${plan.scope?.(tableId, tableId) ?? sql`TRUE`}) AS source) AS ${ident(column)}`);
    }
    recordSets.set(field.id, sets);
  }
  const evaluationContext = (field: StoredField, raw: StoredRow): EvaluationContext => {
    const choices = new Map<string, string>();
    for (const dependency of all) {
      const values = raw[`__choices_${dependency.id}`];
      if (Array.isArray(values)) for (const choice of values as Choice[]) choices.set(choice.id, choice.name);
    }
    const resolvedContext = { ...context, choices };
    const sets = recordSets.get(field.id);
    if (!sets) return resolvedContext;
    const tables = new Map<string, FormulaRecord[]>();
    for (const [tableId, set] of sets) {
      const source = raw[set.column];
      const records = Array.isArray(source) ? (source as StoredRow[]) : [];
      tables.set(
        tableId,
        records.map((item) => {
          const row = set.read.decode(item);
          for (const selected of Object.values(row.selectChoices ?? {}))
            for (const choice of selected) choices.set(choice.id, choice.name);
          const values: FormulaRecord['values'] = Object.fromEntries(
            set.fields.map((dependency) => {
              const reason = row.errors?.[dependency.id];
              return [
                dependency.id,
                reason ? { error: '#ERROR!', messageKey: reason } : cellValue(row, dependency),
              ];
            }),
          );
          return { ...row, values };
        }),
      );
    }
    return { ...resolvedContext, tables, records: tables.get(field.tableId) };
  };
  return {
    select: join(
      [
        rowSelect(all, undefined, includeTrashedLinks, expressions),
        ...namedSelect,
        ...recordSelect,
        // Only pinned records need a second computation to compare with the value beneath the pin.
        ...fields
          .filter((field) => isOverrideType(field.type))
          .map(
            (field) =>
              sql`CASE WHEN ${ident('__overrides')} -> ${field.id} ? 'value'
                THEN ${selectExpr({ ...field, ignoreOverride: true })} END AS ${ident(`__computed_${field.id}`)}`,
          ),
      ],
      ', ',
    ),
    decode(raw: StoredRow): RowData {
      const row = decodeRow(raw, all);
      // System values also supply created-by and modified-by dependencies to the evaluator, and a
      // lookup's or rollup's error reaches it as an error value.
      const record = {
        ...row,
        values: Object.fromEntries(
          all
            .filter((field) => field.type !== 'formula')
            .map((field) => {
              const reason = named.has(field.id)
                ? reasonOf(raw[namedErrorColumn(field.id)])
                : row.errors?.[field.id];
              const failed: ErrorValue | undefined = reason
                ? { error: '#ERROR!', messageKey: reason }
                : undefined;
              const value = named.has(field.id)
                ? namedList(raw[namedColumn(field.id)])
                : cellValue(row, field);
              return [field.id, failed ?? value];
            }),
        ),
      };
      // A formula reads its dependencies' values, so those are set first, and a pin wins over both.
      const evaluated = new Set<string>();
      const evaluateField = (field: StoredField): void => {
        if (field.type !== 'formula' || !field.formula || evaluated.has(field.id)) return;
        evaluated.add(field.id);
        if (!expressions.get(field.id))
          for (const dependency of field.formula.fields) evaluateField(dependency);
        const evaluation = evaluationContext(field, raw);
        // The scoped record set includes computed ordering and partition fields needed by fallback.
        const current = evaluation.records?.find((item) => item.id === record.id) ?? record;
        const pin = field.ignoreOverride ? undefined : row.overrides?.[field.id];
        const value =
          pin && Object.hasOwn(pin, 'value')
            ? pin.value
            : expressions.get(field.id)
              ? raw[field.id]
              : evaluateFormula(field, current, evaluation);
        setFormulaValue(row, field, value);
        record.values[field.id] = value as CellValue | ErrorValue;
      };
      for (const field of all) evaluateField(field);
      // A pin that now equals the value beneath it goes away, and one that differs shows it.
      for (const field of fields) {
        if (!isOverrideType(field.type) || field.ignoreOverride) continue;
        const pin = row.overrides?.[field.id];
        if (!pin || !Object.hasOwn(pin, 'value')) continue;
        const evaluation = evaluationContext(field, raw);
        const current = evaluation.records?.find((item) => item.id === record.id) ?? record;
        const source =
          field.type === 'formula' && !expressions.get(field.id)
            ? (evaluateFormula(field, current, evaluation) as CellValue)
            : decodeValue(field, raw[`__computed_${field.id}`]);
        if (sameValue(pin.value, source)) delete row.overrides![field.id];
        else row.overrides![field.id] = { ...pin, source };
        row.values[field.id] = pin.value ?? null;
        if (row.errors) delete row.errors[field.id];
      }
      if (asOperand)
        for (const field of named.values()) {
          row.values[field.id] = namedList(raw[namedColumn(field.id)]);
          const reason = reasonOf(raw[namedErrorColumn(field.id)]);
          if (reason) (row.errors ??= {})[field.id] = reason;
        }
      const requested = new Set(fields.map((field) => field.id));
      for (const id of Object.keys(row.values)) if (!requested.has(id)) delete row.values[id];
      for (const id of Object.keys(row.errors ?? {})) if (!requested.has(id)) delete row.errors![id];
      const requestedChoices = new Set(fields.flatMap((field) => selectTarget(field)?.id ?? []));
      if (row.selectChoices)
        for (const id of Object.keys(row.selectChoices))
          if (!requestedChoices.has(id)) delete row.selectChoices[id];
      if (row.errors && !Object.keys(row.errors).length) delete row.errors;
      for (const id of Object.keys(row.hiddenLinks ?? {}))
        if (!requested.has(id)) delete row.hiddenLinks![id];
      if (row.hiddenLinks && !Object.keys(row.hiddenLinks).length) delete row.hiddenLinks;
      return row;
    },
  };
}

/**
 * Adds records.  `simulatedRids`, given for a change that's rolled back afterward, are the new
 * records' row numbers, and each auto number is the one its sequence would hand out next, read
 * without taking it, so the insert moves no sequence.  The records a simulation already added to
 * the table in the same transaction, which alone have row numbers below zero, count toward it.
 */
export async function insertRecords(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  rows: readonly RecordInput[],
  actorId: string | null,
  simulatedRids?: readonly number[],
  managed?: ManagedGrant,
): Promise<RowData[]> {
  if (!rows.length) return [];
  refuseManagedValues(fields, rows, managed);
  const writable = fields.filter((f) => columnType(f) && f.type !== 'autoNumber');
  const numbered = simulatedRids ? fields.filter((f) => columnType(f) && f.type === 'autoNumber') : [];
  const table = ident(dataSchema, tableId);
  const items = simulatedRids ? rows.map((row, index) => ({ ...row, rid: simulatedRids[index] })) : rows;
  const result = await query<StoredRow>(
    db,
    sql`
    INSERT INTO ${table} AS r
      (${join(
        [
          sql`__id`,
          sql`__created_by`,
          sql`__updated_by`,
          ...(simulatedRids ? [sql`__rid`] : []),
          ...writable.map((f) => sql`${ident(f.columnName)}`),
          ...numbered.map((f) => sql`${ident(f.columnName)}`),
        ],
        ', ',
      )})
    SELECT ${join(
      [
        sql`item ->> 'id'`,
        sql`${actorId}::text`,
        sql`${actorId}::text`,
        ...(simulatedRids ? [sql`(item ->> 'rid')::bigint`] : []),
        ...writable.map((f) => jsonValueExpr(f, sql`item -> 'values' -> ${f.id}`)),
        ...numbered.map(
          (f) => sql`COALESCE(
            pg_sequence_last_value(to_regclass(${`"${dataSchema}"."${f.id}"`})),
            (SELECT max(${ident(f.columnName)}) FROM ${table} WHERE __rid > 0), 0)
            + (SELECT count(*) FROM ${table} WHERE __rid < 0) + position`,
        ),
      ],
      ', ',
    )}
    FROM jsonb_array_elements(${JSON.stringify(items)}::jsonb) WITH ORDINALITY AS batch(item, position)
    ORDER BY position
    RETURNING ${rowSelect(fields, 'r')}`,
  );
  const byId = new Map(result.rows.map((row) => [row.__id, decodeRow(row, fields)]));
  return rows.map((row) => byId.get(row.id)!);
}

export interface UpdatedRecord extends RecordInput {
  prev: CellValues;
  prevOverrides?: Record<string, Override | null>;
  updatedAt: string;
  updatedBy: string | null;
}

export async function updateRecords(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  rows: readonly RecordInput[],
  actorId: string | null,
  restorePositions: readonly LinkPositions[] = [],
  managed?: ManagedGrant,
  /** Fields the writer can't see, by ID, whose kept links a changed value doesn't check again */
  unseen?: ReadonlySet<string>,
): Promise<{
  updated: UpdatedRecord[];
  missing: string[];
  linkChanges?: ChangeBody[];
  linkPositions?: LinkPositions[];
  /** Lists of links that follow a changed value, read as they're recorded */
  matchChanges?: AsyncIterable<ChangeBody>;
}> {
  if (!rows.length) return { updated: [], missing: [] };
  refuseManagedValues(fields, rows, managed);
  // The payment service's answer lands even when its record went to the trash meanwhile.
  const includeTrashed = Boolean(managed && rows.every((row) => managed.recordIds.has(row.id)));
  const requested = new Set(rows.flatMap((row) => Object.keys(row.values)));
  const writable = fields.filter(
    (f) =>
      f.type !== 'autoNumber' &&
      requested.has(f.id) &&
      (columnType(f) ||
        f.type === 'link' ||
        f.type === 'lineItems' ||
        (isOverrideType(f.type) && rows.some((row) => Object.hasOwn(row.overrides ?? {}, f.id)))),
  );
  const read = formulaRead(writable, undefined, false, true);
  const result = await query<StoredRow>(
    db,
    sql`SELECT ${read.select}
    FROM ${ident(dataSchema, tableId)} WHERE __id = ANY(${rows.map((r) => r.id)}::text[])
    AND (${includeTrashed} OR __deleted_at IS NULL) AND NOT __source_gone ORDER BY __rid FOR UPDATE`,
  );
  const stored = new Map(result.rows.map((row) => [row.__id, read.decode(row)]));
  const missing: string[] = [];
  const changes = new Map<
    string,
    RecordInput & { prev: CellValues; prevOverrides?: Record<string, Override | null> }
  >();
  // Repeated record IDs coalesce by cell, so each surviving value keeps its own request position.
  const positions = new Map<string, Map<string, number>>();
  for (const [index, row] of rows.entries()) {
    const before = stored.get(row.id);
    if (!before) {
      missing.push(row.id);
      continue;
    }
    const change: RecordInput & { prev: CellValues; prevOverrides?: Record<string, Override | null> } =
      changes.get(row.id) ?? { id: row.id, values: {}, prev: {} };
    const cellPositions = positions.get(row.id) ?? new Map<string, number>();
    for (const field of writable) {
      if (!Object.hasOwn(row.values, field.id)) continue;
      const value = row.values[field.id]!;
      const overrideChanged =
        row.overrides &&
        Object.hasOwn(row.overrides, field.id) &&
        JSON.stringify(row.overrides[field.id] ?? null) !==
          JSON.stringify(before.overrides?.[field.id] ?? null);
      if (sameValue(value, before.values[field.id]) && !overrideChanged) {
        delete change.values[field.id];
        delete change.prev[field.id];
        cellPositions.delete(field.id);
      } else {
        change.values[field.id] = value;
        change.prev[field.id] = before.values[field.id] ?? null;
        cellPositions.set(field.id, index);
        if (row.overrides && Object.hasOwn(row.overrides, field.id)) {
          (change.overrides ??= {})[field.id] = row.overrides[field.id] ?? null;
          (change.prevOverrides ??= {})[field.id] = before.overrides?.[field.id] ?? null;
        }
      }
    }
    changes.set(row.id, change);
    positions.set(row.id, cellPositions);
  }
  const changed = [...changes.values()].filter((r) => Object.keys(r.values).length);
  if (!changed.length) return { updated: [], missing };
  const touched = new Set(changed.flatMap((r) => Object.keys(r.values)));
  const assignments = writable
    .filter((f) => touched.has(f.id) && columnType(f))
    .map(
      (f) => sql`
    ${ident(f.columnName)} = CASE WHEN item -> 'values' ? ${f.id}
      THEN ${jsonValueExpr(f, sql`item -> 'values' -> ${f.id}`)}
      ELSE ${ident('r', f.columnName)} END`,
    );
  assignments.push(
    sql`__overrides = (SELECT jsonb_object_agg(key, value) FROM jsonb_each(COALESCE(r.__overrides, '{}'::jsonb) || COALESCE(item -> 'overrides', '{}'::jsonb)) WHERE value <> 'null'::jsonb)`,
  );
  const linkPositions = await captureLinkPositions(db, dataSchema, fields, changed);
  const written = await query<StoredRow>(
    db,
    sql`UPDATE ${ident(dataSchema, tableId)} AS r
    SET ${join([...assignments, sql`__updated_at = statement_timestamp()`, sql`__updated_by = ${actorId}`], ', ')}
    FROM jsonb_array_elements(${JSON.stringify(changed.map(({ id, values, overrides }) => ({ id, values, overrides })))}::jsonb) AS batch(item)
    WHERE r.__id = item ->> 'id'
    RETURNING ${SYSTEM_SELECT('r')}`,
  );
  const limitChecks: Array<() => Promise<void>> = [];
  const linkChanges = await replaceLinks(
    db,
    dataSchema,
    fields,
    changed,
    actorId,
    restorePositions,
    limitChecks,
    unseen,
  ).catch((error: unknown) => {
    throw recordError(error, (recordId, fieldId) => positions.get(recordId)?.get(fieldId));
  });
  const metadata = new Map(written.rows.map((row) => [row.__id, row]));
  // Links that follow a changed value move with it, in the same transaction.
  const refresh = new MatchRefresh(db, dataSchema, actorId);
  const ids = changed.map((row) => row.id);
  for (const link of matchedLinks(fields))
    if (touched.has(link.relation!.match!.field.id))
      await refresh.refresh(link, sql`t.__id = ANY(${ids}::text[])`);
  for (const check of limitChecks)
    await check().catch((error: unknown) => {
      throw recordError(error, (recordId) => rows.findIndex((row) => row.id === recordId));
    });
  return {
    linkChanges,
    linkPositions,
    matchChanges: refresh.changes(),
    updated: changed.map((row) => ({
      ...row,
      updatedAt: metadata.get(row.id)!.__updated_at,
      updatedBy: metadata.get(row.id)!.__updated_by,
    })),
    missing,
  };
}

export async function trashRecords(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  ids: readonly string[],
  actorId: string | null,
): Promise<string[]> {
  if (!ids.length) return [];
  const result = await query<{ __id: string }>(
    db,
    sql`UPDATE ${ident(dataSchema, tableId)}
    SET __deleted_at = statement_timestamp(), __trashed_by = ${actorId}, __updated_at = statement_timestamp(), __updated_by = ${actorId}
    WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL AND NOT __source_gone RETURNING __id`,
  );
  const changed = new Set(result.rows.map((row) => row.__id));
  return [...new Set(ids)].filter((id) => changed.has(id));
}

export async function restoreRecords(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  ids: readonly string[],
): Promise<RowData[]> {
  if (!ids.length) return [];
  const result = await query<StoredRow>(
    db,
    sql`UPDATE ${ident(dataSchema, tableId)} AS r
    SET __deleted_at = NULL, __trashed_by = NULL WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NOT NULL
    RETURNING ${rowSelect(fields, 'r')}`,
  );
  const byId = new Map(result.rows.map((row) => [row.__id, decodeRow(row, fields)]));
  return [...new Set(ids)].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

async function fetchRows(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  ids: readonly string[] | readonly number[],
  byRid: boolean,
  includeTrashedLinks = false,
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
): Promise<RowData[]> {
  if (!ids.length) return [];
  const key = byRid ? sql`__rid` : sql`__id`;
  const array = byRid ? sql`${ids}::bigint[]` : sql`${ids}::text[]`;
  const read = formulaRead(fields, context, false, includeTrashedLinks);
  const result = await query<StoredRow>(
    db,
    sql`SELECT ${read.select}
    FROM ${ident(dataSchema, tableId)} WHERE ${key} = ANY(${array}) AND __deleted_at IS NULL AND NOT __source_gone`,
  );
  const byKey = new Map(result.rows.map((row) => [byRid ? String(row.__rid) : row.__id, read.decode(row)]));
  return ids.flatMap((id) => (byKey.has(String(id)) ? [byKey.get(String(id))!] : []));
}

export async function fetchRowsByRid(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  rids: readonly number[],
): Promise<RowData[]> {
  return fetchRows(db, dataSchema, tableId, fields, rids, true);
}

export async function fetchRowsById(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  ids: readonly string[],
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
): Promise<RowData[]> {
  return fetchRows(db, dataSchema, tableId, fields, ids, false, false, context);
}

export async function fetchRecord(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  id: string,
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
): Promise<RowData | null> {
  return (await fetchRowsById(db, dataSchema, tableId, fields, [id], context))[0] ?? null;
}

export async function currentValues(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  ids: readonly string[],
  includeTrashedLinks = false,
): Promise<Map<string, CellValues>> {
  const rows = await fetchRows(db, dataSchema, tableId, fields, ids, false, includeTrashedLinks);
  return new Map(
    rows.map((row) => [row.id, Object.fromEntries(fields.map((f) => [f.id, cellValue(row, f)]))]),
  );
}

export async function clearChoices(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  field: StoredField,
  choiceIds: readonly string[],
  actorId: string | null,
): Promise<Array<{ id: string; prev: CellValue }>> {
  if (!choiceIds.length || (field.type !== 'singleSelect' && field.type !== 'multipleSelect')) return [];
  const column = ident(field.columnName);
  const predicate =
    field.type === 'singleSelect'
      ? sql`${column} = ANY(${choiceIds}::text[])`
      : sql`${column} && ${choiceIds}::text[]`;
  const value =
    field.type === 'singleSelect'
      ? sql`NULL::text`
      : sql`NULLIF(ARRAY(SELECT choice FROM unnest(r.${column}) WITH ORDINALITY AS choices(choice, position)
        WHERE NOT (choice = ANY(${choiceIds}::text[])) ORDER BY position), ARRAY[]::text[])`;
  // Trashed records must also lose removed choices before they can be restored.
  const result = await query<{ __id: string; prev: unknown }>(
    db,
    sql`
    WITH previous AS MATERIALIZED (
      SELECT __rid, ${column} AS prev FROM ${ident(dataSchema, tableId)}
      WHERE ${predicate} ORDER BY __rid FOR UPDATE
    ), changed AS (UPDATE ${ident(dataSchema, tableId)} AS r
    SET ${column} = ${value}, __updated_at = statement_timestamp(), __updated_by = ${actorId}
    FROM previous WHERE r.__rid = previous.__rid RETURNING r.__rid, r.__id, previous.prev)
    SELECT __id, prev FROM changed ORDER BY __rid`,
  );
  return result.rows.map((row) => ({ id: row.__id, prev: decodeValue(field, row.prev) }));
}

/** Stored row fingerprints include hidden values without disclosing them to the reader. */
export async function recordFingerprints(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  ids: readonly string[],
  scopePredicate: Sql,
): Promise<Array<{ recordId: string; hash: string }>> {
  const result = await query<{ recordId: string; hash: string }>(
    db,
    sql`
    SELECT __id AS "recordId", encode(sha256(convert_to(to_jsonb(r)::text, 'UTF8')), 'hex') AS hash
    FROM ${ident(dataSchema, tableId)} r
    WHERE __id = ANY(${ids}::text[]) AND NOT __source_gone AND (${scopePredicate})
    ORDER BY __id`,
  );
  return result.rows;
}

/** Preserve snapshot positions even when records disappear or access changes between pages. */
export async function fetchPageByRid(
  db: Queryable,
  dataSchema: string,
  tableId: string,
  fields: readonly StoredField[],
  rids: readonly number[],
  scopePredicate: Sql = sql`TRUE`,
  context?: Pick<EvaluationContext, 'now' | 'timeZone'>,
  trashed = false,
): Promise<Array<RowData | null>> {
  if (!rids.length) return [];
  const read = formulaRead(fields, context);
  const result = await query<StoredRow>(
    db,
    sql`SELECT ${read.select} FROM ${ident(dataSchema, tableId)}
      WHERE __rid = ANY(${rids}::bigint[]) AND ${trashed ? sql`__deleted_at IS NOT NULL` : sql`__deleted_at IS NULL`}
        AND NOT __source_gone AND (${scopePredicate})`,
  );
  const byRid = new Map(result.rows.map((row) => [Number(row.__rid), read.decode(row)]));
  return rids.map((rid) => byRid.get(rid) ?? null);
}
