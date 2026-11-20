import { overrideDescription } from '../../screens/database/synced/override';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { cellValue, type FieldMeta, type RowData } from '@riosoma/contracts';
import { formatCell, type FormatContext } from '../format';
import { buttonLabel, buttonTarget } from '../../fields/buttons';

export type Translate = (message: MessageDescriptor) => string;

export function describeCell(
  field: FieldMeta,
  row: RowData,
  rowIndex: number,
  format: FormatContext,
  t: Translate,
): string {
  const stored = cellValue(row, field);
  const value = row.errors?.[field.id]
    ? t(msg({ id: 'grid.formula.error', message: '#ERROR' }))
    : field.type === 'button'
      ? t({
          ...(buttonTarget(field, row, format).ok
            ? msg({ id: 'fields.button.describe', message: '{label} button' })
            : msg({ id: 'fields.button.describeOff', message: '{label} button, unavailable' })),
          values: { label: buttonLabel(field) },
        })
      : field.type === 'checkbox'
        ? t(
            stored === true
              ? msg({ id: 'grid.cell.checked', message: 'checked' })
              : msg({ id: 'grid.cell.unchecked', message: 'not checked' }),
          )
        : formatCell(field, stored, format) || t(msg({ id: 'grid.cell.empty', message: 'empty' }));
  return (
    t({
      ...msg({ id: 'grid.cell.describe', message: '{field}, row {row}: {value}' }),
      values: { field: field.name, row: rowIndex + 1, value },
    }) + (row.overrides?.[field.id] ? ` ${overrideDescription(field, row, format, t)}` : '')
  );
}
