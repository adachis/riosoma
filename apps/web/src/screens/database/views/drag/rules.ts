import {
  isComputedType,
  readsSourceLive,
  roleAllows,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import type { CommandInput } from '../../../../data/types';
import { followsValues } from '../../joins/matched';
import { sourceReadOnly } from '../../synced/override';
import type { ViewComponentProps } from '../types';

export type Refusal = 'access' | 'record' | 'field' | 'computed' | 'source' | 'sorted' | 'view';

export function arrangementRefusal(props: ViewComponentProps): Refusal | null {
  if (props.readOnly || !props.canEdit || !roleAllows(props.session.role(), 'editSchema')) return 'access';
  const config = props.session.getSchema().viewById?.get(props.view.id)?.config ?? props.view.config;
  return config.locked ? 'view' : null;
}

/** Check the current access snapshot again at drop, since permissions can change during a gesture. */
export function dropRefusal(
  props: ViewComponentProps,
  row: RowData | undefined,
  fields: readonly FieldMeta[] = [],
  order = false,
): Refusal | null {
  if (props.readOnly || !roleAllows(props.session.role(), 'editRecords')) return 'access';
  const current = row ? (props.session.cachedRecord(props.table.id, row.id) ?? row) : undefined;
  if (current?.lock && !current.lock.canEdit) return 'record';
  const schema = props.session.getSchema();
  const table = schema.tableById?.get(props.table.id) ?? props.table;
  const config = schema.viewById?.get(props.view.id)?.config ?? props.view.config;
  if (order && config.locked) return 'view';
  if (order && config.sorts.length) return 'sorted';
  if (order && readsSourceLive(table.source)) return 'source';
  const access = schema.access;
  for (const shown of fields) {
    const field = schema.fieldById?.get(shown.id) ?? shown;
    if (isComputedType(field.type) || followsValues(field)) return 'computed';
    if (sourceReadOnly(field, table)) return 'source';
    if (access?.hiddenFields.has(field.id) || access?.fields.get(field.id)?.editable === false)
      return 'field';
  }
  return null;
}

export function orderCommand(
  props: ViewComponentProps,
  row: RowData,
  target: string,
  side: 'before' | 'after',
): CommandInput | null {
  if (row.id === target || dropRefusal(props, row, [], true)) return null;
  return {
    kind: 'record.move',
    tableId: props.table.id,
    viewId: props.view.id,
    recordIds: [row.id],
    place: side === 'before' ? { before: target } : { after: target },
  };
}
