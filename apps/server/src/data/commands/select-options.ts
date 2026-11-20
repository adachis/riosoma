import { isDeepStrictEqual } from 'node:util';
import { ident, query, sql } from '@riosoma/db';
import type { StoredField } from '../types.js';
import { validateRecords } from './validation.js';
import {
  AppError,
  choicesForRecord,
  idsOf,
  checkCondition,
  readsSourceLive,
  SELECT_SOURCE_TYPES,
  type FieldSpec,
} from '@riosoma/contracts';
import { loadField, loadFields } from '../metadata.js';
import { relationalConditions } from '../physical/conditional.js';
import { readsBack } from '../physical/formulas.js';
import { isSelect } from '../select-options.js';
import { invalid, scopeOf, table, visibleField, type CommandContext } from './context.js';

/** Check references while the command still has a chance to roll back every schema change. */
export async function selectSpec(
  c: CommandContext,
  tableId: string,
  spec: FieldSpec,
  id: string,
): Promise<FieldSpec> {
  if (!isSelect(spec)) return spec;
  const { cascade, source } = spec.options;
  if (cascade && source) invalid('data.select.oneSource');
  if (cascade) {
    const parent = await visibleField(c, cascade.fieldId);
    if (parent.tableId !== tableId || !isSelect(parent) || parent.options.source)
      invalid('data.select.parent');
    const seen = new Set([id]);
    let ancestor: StoredField = parent;
    while (true) {
      if (seen.has(ancestor.id)) invalid('data.select.cycle');
      seen.add(ancestor.id);
      if (!isSelect(ancestor) || !ancestor.options.cascade) break;
      ancestor = await visibleField(c, ancestor.options.cascade.fieldId);
    }
    const parentIds = new Set(parent.options.choices.map((choice) => choice.id));
    const childIds = new Set(spec.options.choices.map((choice) => choice.id));
    if (
      Object.entries(cascade.mapping).some(
        ([key, values]) => !parentIds.has(key) || values.some((value) => !childIds.has(value)),
      )
    )
      invalid('data.select.mapping');
  }
  if (source) {
    const targetTable = await table(c, source.tableId);
    if (readsSourceLive(targetTable.source)) invalid('sources.live.viewUnsupported');
    if (targetTable.id === tableId) invalid('data.select.otherTable');
    const target = await visibleField(c, source.fieldId ?? targetTable.primaryFieldId!);
    if (
      target.tableId !== targetTable.id ||
      !(SELECT_SOURCE_TYPES as readonly string[]).includes(target.type)
    )
      invalid('data.select.sourceField');
    const dependencies = [target];
    for (const condition of relationalConditions(source.filter)) {
      const input = await visibleField(c, condition.fieldId);
      if (
        input.tableId !== targetTable.id ||
        condition.currentFieldId ||
        !checkCondition(input, condition).valid
      )
        invalid('data.select.filter');
      dependencies.push(input);
    }
    if (readsBack(dependencies, id, await loadFields(c.db, c.schemas, [tableId])))
      invalid('data.select.cycle');
    await scopeOf(c, targetTable.id);
    (c.sourceChoiceTables ??= new Set()).add(targetTable.id);
    return { ...spec, options: { ...spec.options, choices: [] } };
  }
  return spec;
}

export async function validateSelectSchema(
  c: CommandContext,
  tableId: string,
  changedId: string,
  before?: StoredField,
): Promise<void> {
  const fields = await loadFields(c.db, c.schemas, [tableId]);
  const changed = fields.find((field) => field.id === changedId);
  if (!changed) return;
  const shape = (field: StoredField | undefined) =>
    field && isSelect(field)
      ? {
          type: field.type,
          ids: field.options.choices.map((choice) => choice.id),
          cascade: field.options.cascade,
        }
      : null;
  if (isDeepStrictEqual(shape(before), shape(changed))) return;
  const cascades = fields.filter(
    (field) =>
      isSelect(field) &&
      field.options.cascade &&
      (field.id === changedId || field.options.cascade.fieldId === changedId),
  );
  if (!cascades.length) return;
  for (const field of cascades) {
    if (!isSelect(field) || !field.options.cascade) continue;
    const parent = await loadField(c.db, c.schemas, field.options.cascade.fieldId);
    if (!parent || parent.trashed || !isSelect(parent)) invalid('data.select.parentInUse');
  }
  const inputs = new Set(
    cascades.flatMap((field) =>
      isSelect(field) && field.options.cascade ? [field.id, field.options.cascade.fieldId] : [],
    ),
  );
  const checked = fields
    .filter((field) => inputs.has(field.id))
    .map(
      (field) =>
        ({
          ...field,
          options: {
            ...field.options,
            validation: undefined,
            ...(!cascades.some((cascade) => cascade.id === field.id) ? { cascade: undefined } : {}),
          },
        }) as StoredField,
    );
  const result = await query<{ id: string }>(
    c.db,
    sql`SELECT __id AS id FROM ${ident(c.schemas.data, tableId)} WHERE __deleted_at IS NULL AND NOT __source_gone`,
  );
  for (let start = 0; start < result.rows.length; start += 1000)
    await validateRecords(
      c,
      tableId,
      checked,
      result.rows.slice(start, start + 1000).map((row) => ({ id: row.id, values: {} })),
      true,
      [],
      true,
    );
}

/** Include cascade inputs without applying unrelated validation rules during a schema edit. */
export function cascadeValidationFields(fields: readonly StoredField[], changed: StoredField): StoredField[] {
  const relevant = fields.filter(
    (field) =>
      field.id === changed.id ||
      (isSelect(changed) && changed.options.cascade?.fieldId === field.id) ||
      (isSelect(field) && field.options.cascade?.fieldId === changed.id),
  );
  return relevant.map((field) =>
    field.id === changed.id
      ? changed
      : ({
          ...field,
          options: {
            ...field.options,
            validation: undefined,
            ...(isSelect(field) && field.options.cascade?.fieldId !== changed.id
              ? { cascade: undefined }
              : {}),
          },
        } as StoredField),
  );
}

/** Removing a parent option must not leave dependent selections invalid. */
export async function requireRemovableChoices(
  c: CommandContext,
  parent: StoredField,
  removed: string[],
): Promise<void> {
  if (!removed.length || !isSelect(parent)) return;
  const fields = await loadFields(c.db, c.schemas, [parent.tableId]);
  const column = ident(parent.columnName);
  const predicate =
    parent.type === 'singleSelect'
      ? sql`${column} = ANY(${removed}::text[])`
      : sql`${column} && ${removed}::text[]`;
  for (const child of fields) {
    if (!isSelect(child) || child.options.cascade?.fieldId !== parent.id) continue;
    const rows = await query<{ parent: string | string[]; child: string | string[] | null }>(
      c.db,
      sql`SELECT ${column} AS parent, ${ident(child.columnName)} AS child
        FROM ${ident(c.schemas.data, parent.tableId)} WHERE __deleted_at IS NULL AND NOT __source_gone AND ${predicate}`,
    );
    const count = rows.rows.filter((row) => {
      const kept = idsOf(Array.isArray(row.parent) ? row.parent : [row.parent]).filter(
        (id) => !removed.includes(id),
      );
      const allowed = new Set(
        choicesForRecord(child.options, { [parent.id]: kept }).map((choice) => choice.id),
      );
      return (typeof row.child === 'string' ? [row.child] : idsOf(row.child)).some((id) => !allowed.has(id));
    }).length;
    if (!count) continue;
    const scope = await scopeOf(c, parent.tableId);
    if (!scope.visibleFields(parent.tableId, [child]).length)
      throw new AppError('validation_failed', 'data.select.hiddenDependency');
    throw new AppError('validation_failed', 'data.select.dependentValues', {
      params: { field: child.name, count },
    });
  }
}
