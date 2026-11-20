import { sourceReadOnly } from '../../synced/override';
import { cellValue, EMPTY_STACK, idsOf, roleAllows } from '@riosoma/contracts';
import type { CellValue, ChoiceColor, FieldMeta, RowData } from '@riosoma/contracts';
import type { ViewComponentProps } from '../types';

export interface Stack {
  id: string;
  name: string;
  color?: ChoiceColor;
  person?: boolean;
}

export function isStackField(field: FieldMeta): boolean {
  return field.type === 'singleSelect' || (field.type === 'user' && !field.options.allowMultiple);
}

/**
 * Whether cards can move and be added: that's editing records, so it takes the role that edits
 * records, not the one that changes the view.  Arranging stacks changes the view (`canEdit`).
 */
export function editable(props: ViewComponentProps): boolean {
  const field = props.fields.find((field) => field.id === props.view.config.kanban.stackFieldId);
  return (
    !props.readOnly &&
    roleAllows(props.session.role(), 'editRecords') &&
    (!field || !sourceReadOnly(field, props.table))
  );
}

export function stackValue(field: FieldMeta, stack: string): CellValue {
  return stack === EMPTY_STACK ? null : field.type === 'user' ? [stack] : stack;
}

export function rowStack(row: RowData, field: FieldMeta): string {
  const value = cellValue(row, field);
  return field.type === 'user'
    ? (idsOf(value)[0] ?? EMPTY_STACK)
    : typeof value === 'string'
      ? value
      : EMPTY_STACK;
}

export function orderStacks(stacks: Stack[], order: readonly string[]): Stack[] {
  const byId = new Map(stacks.map((stack) => [stack.id, stack]));
  const result: Stack[] = [];
  for (const id of order) {
    const stack = byId.get(id);
    if (stack) result.push(stack);
    byId.delete(id);
  }
  return [...result, ...byId.values()];
}

/** Only local arrivals need comparison; existing positions remain the server's snapshot order. */
export function compareCards(a: RowData, b: RowData, props: ViewComponentProps): number {
  const collator = new Intl.Collator('und', { numeric: true, sensitivity: 'base' });
  for (const sort of props.view.config.sorts) {
    const field = props.fields.find((candidate) => candidate.id === sort.fieldId);
    if (!field) continue;
    const sortable = (row: RowData): CellValue => {
      const value = cellValue(row, field);
      if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
        const id = field.type === 'singleSelect' ? value : idsOf(value)[0];
        const index = field.options.choices.findIndex((choice) => choice.id === id);
        return index < 0 ? null : index;
      }
      if (field.type === 'user') return props.format.collaborators.get(idsOf(value)[0] ?? '')?.name || null;
      if (field.type === 'createdBy' || field.type === 'lastModifiedBy')
        return props.format.collaborators.get(String(value))?.name || null;
      if (field.type === 'attachment') return props.attachment?.(idsOf(value)[0] ?? '')?.name || null;
      if (field.type === 'link') return props.format.linked?.get(idsOf(value)[0] ?? '') || null;
      if (Array.isArray(value)) return value[0] ?? null;
      return value === '' ? null : value;
    };
    const left = sortable(a),
      right = sortable(b);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
      continue;
    }
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : typeof left === 'boolean' && typeof right === 'boolean'
          ? Number(left) - Number(right)
          : collator.compare(String(left), String(right));
    if (compared) return sort.direction === 'desc' ? -compared : compared;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
