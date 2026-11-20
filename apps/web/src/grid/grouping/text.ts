import { msg } from '@lingui/core/macro';
import type { CellValue, FieldMeta } from '@riosoma/contracts';
import { resultField } from '../../data/formulas';
import type { Translate } from '../cells/describe';
import { displayField, formatCell, type FormatContext } from '../format';
import { SUMMARY_LABELS } from '../summary/text';

/** Buckets name a calendar date, and false is a value rather than an empty group. */
export function groupValueText(
  field: FieldMeta | undefined,
  value: unknown,
  format: FormatContext,
  t: Translate,
): string {
  const empty = () => t(msg({ id: 'grid.group.empty', message: '(Empty)' }));
  if (!field || value == null) return empty();
  if (field.type === 'lookup' && Array.isArray(value)) {
    const target = displayField(field, format);
    return (
      value
        .map((item) =>
          groupValueText(
            target,
            ['multipleSelect', 'link', 'user', 'attachment'].includes(target.type) ? [item] : item,
            format,
            t,
          ),
        )
        .join(', ') || empty()
    );
  }
  const scalar = resultField(field);
  if (scalar.type === 'checkbox' && typeof value === 'boolean')
    return t(SUMMARY_LABELS[value ? 'checked' : 'unchecked']);
  if (scalar.type === 'date' && typeof value === 'string')
    return formatCell({ ...scalar, options: { ...scalar.options, includeTime: false } }, value, format);
  if (field.type === 'createdTime' || field.type === 'lastModifiedTime')
    return formatCell(
      { ...field, options: { ...field.options, includeTime: false } },
      value as CellValue,
      format,
    );
  return formatCell(field, value as CellValue, format) || empty();
}
