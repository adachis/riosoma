import { sourceReadOnly } from '../../screens/database/synced/override';
import { followsValues } from '../../screens/database/joins/matched';
import type { TableMeta } from '@riosoma/contracts';
import {
  COLUMN_WIDTH,
  isComputedType,
  visibleFieldIds,
  type FieldMeta,
  type FieldType,
  type ViewMeta,
} from '@riosoma/contracts';
import { resultType } from '../../data/formulas';
import type { GridColumn } from '../../../../../packages/grid-core/src/types';

const EDIT: Record<FieldType, GridColumn['edit']> = {
  text: 'inline',
  longText: 'multiline',
  number: 'inline',
  checkbox: 'none',
  date: 'custom',
  singleSelect: 'custom',
  multipleSelect: 'custom',
  email: 'inline',
  url: 'inline',
  phone: 'inline',
  createdTime: 'none',
  lastModifiedTime: 'none',
  createdBy: 'none',
  lastModifiedBy: 'none',
  recordId: 'none',
  link: 'custom',
  lineItems: 'custom',
  lookup: 'none',
  rollup: 'none',
  count: 'none',
  formula: 'none',
  currency: 'inline',
  percent: 'inline',
  duration: 'inline',
  rating: 'custom',
  user: 'custom',
  autoNumber: 'none',
  attachment: 'custom',
  barcode: 'custom',
  time: 'custom',
  multiCurrency: 'custom',
  changeLog: 'none',
  dateRange: 'custom',
  json: 'custom',
  location: 'custom',
  signature: 'custom',
  // The cell holds a real link, and the record card holds a button for the keyboard.
  button: 'none',
};

/** Types whose values line up at the end, like numbers in a spreadsheet */
const END_ALIGNED = new Set<FieldType>(['number', 'currency', 'percent', 'duration', 'autoNumber']);

export function gridColumns(
  view: ViewMeta,
  fields: readonly FieldMeta[],
  primaryFieldId: string,
  table?: TableMeta,
): GridColumn[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const collapsed = new Set<string>();
  const displayed = visibleFieldIds(view.config, fields, primaryFieldId).filter((id) => {
    if (id === primaryFieldId) return true;
    const group = view.config.columnGroups?.find((item) => item.fieldIds.includes(id));
    if (!group?.collapsed) return true;
    if (collapsed.has(group.id)) return false;
    collapsed.add(group.id);
    return true;
  });
  return displayed.map((id) => {
    const field = byId.get(id)!;
    return {
      id,
      headerColor: view.config.headerColors?.[id],
      group: view.config.columnGroups?.find((group) => group.fieldIds.includes(id)),
      width:
        view.config.columnWidths[id] ?? (id === primaryFieldId ? COLUMN_WIDTH.primary : COLUMN_WIDTH.default),
      minWidth: COLUMN_WIDTH.min,
      // Links that follow matching values show their links but change only with the values.
      // Long text keeps its starting value and remains open while a save checks for concurrent edits.
      edit:
        sourceReadOnly(field, table) || followsValues(field)
          ? 'none'
          : field.type === 'longText'
            ? 'custom'
            : EDIT[field.type],
      // Formulas, lookups, and rollups of numbers line up like numbers, and ratings show their stars.
      ...(END_ALIGNED.has(field.type) || (isComputedType(field.type) && resultType(field) === 'number')
        ? { align: 'end' as const }
        : {}),
      ...(field.type === 'checkbox' && !sourceReadOnly(field, table) ? { toggle: true } : {}),
    };
  });
}
