import { msg } from '@lingui/core/macro';
import type { FieldMeta, RowData, TableMeta } from '@riosoma/contracts';
import type { Translate } from '../../../grid/cells/describe';
import { formatCell, type FormatContext } from '../../../grid/format';

export function sourceReadOnly(field: FieldMeta, table: TableMeta | undefined): boolean {
  return Boolean(field.source && table?.source && !table.source.allowOverrides);
}
export function overrideDescription(
  field: FieldMeta,
  row: RowData,
  format: FormatContext,
  t: Translate,
): string {
  const override = row.overrides?.[field.id];
  if (!override) return '';
  const value =
    formatCell(field, override.source, format) || t(msg({ id: 'synced.override.empty', message: 'nothing' }));
  return t(msg({ id: 'synced.override.mark', message: `Changed here.  The source says ${value}.` }));
}
export const overridesOff = msg({
  id: 'synced.override.off',
  message: 'This comes from the source, and this table doesn’t allow changes to source values.',
});
