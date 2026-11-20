import { canCompareCurrentField, checkCondition, type FieldSpec } from '@riosoma/contracts';
import { relationalConditions, relationalReads } from '../physical/conditional.js';
import { readsBack } from '../physical/formulas.js';
import { resultType } from '../physical/relations.js';
import { invalid, visibleField, visibleFieldsOf, type CommandContext } from './context.js';

export async function validateConditional(
  c: CommandContext,
  tableId: string,
  linkedTableId: string,
  spec: Extract<FieldSpec, { type: 'link' | 'lookup' | 'rollup' | 'count' }>,
  id: string,
): Promise<void> {
  const fields = await Promise.all(relationalReads(spec).map((id) => visibleField(c, id, false, 'read')));
  const byId = new Map(fields.map((field) => [field.id, field]));
  for (const condition of relationalConditions(spec.options.filter)) {
    const field = byId.get(condition.fieldId);
    if (!field || field.tableId !== linkedTableId) invalid('data.field.unknown');
    if (condition.currentFieldId) {
      const current = byId.get(condition.currentFieldId);
      if (
        !current ||
        current.tableId !== tableId ||
        resultType(current) !== resultType(field) ||
        !canCompareCurrentField(field, condition.operator) ||
        !canCompareCurrentField(current, condition.operator)
      )
        invalid('errors.validationFailed');
    } else if (!checkCondition(field, condition).valid) invalid('errors.validationFailed');
  }
  if (spec.type === 'lookup')
    for (const sort of spec.options.sort ?? []) {
      const field = byId.get(sort.fieldId);
      if (
        !field ||
        field.tableId !== linkedTableId ||
        field.type === 'button' ||
        (field.type === 'formula' && !field.options.sortable)
      )
        invalid('data.field.unknown');
    }
  if (readsBack(fields, id, await visibleFieldsOf(c, tableId))) invalid('formula.field.circular');
}
