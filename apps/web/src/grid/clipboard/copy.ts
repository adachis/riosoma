import {
  cellValue,
  isLocationValue,
  isMultiCurrencyValue,
  multiCurrencyText,
  locationText,
  type CellValue,
  type FieldMeta,
  type RowData,
} from '@riosoma/contracts';
import { formatCell, type FormatContext } from '../format';

/**
 * A cell's text on the clipboard: what it shows, except a place, which keeps its coordinates
 * beside its label so pasting it into another location field brings the whole place along, and
 * rich text, which keeps its Markdown so pasting it keeps the formatting.
 */
export function copyText(field: FieldMeta, value: CellValue, format: FormatContext): string {
  if (field.type === 'multiCurrency' && isMultiCurrencyValue(value)) return multiCurrencyText(value);
  if ((field.type === 'longText' || field.type === 'time') && typeof value === 'string') return value;
  return field.type === 'location' && isLocationValue(value)
    ? locationText(value)
    : formatCell(field, value, format);
}
import type { CellSelection } from './plan';

/** The caller loads the selected rows before copying; computed values come from record metadata. */
export function copyCells(
  selection: CellSelection,
  fields: readonly FieldMeta[],
  rowAt: (index: number) => RowData,
  format: FormatContext,
): string[][] {
  const cells: string[][] = [];
  const lastCol = Math.min(selection.end.col, fields.length - 1);
  for (let row = selection.start.row; row <= selection.end.row; row += 1) {
    const record = rowAt(row);
    const texts: string[] = [];
    for (let col = selection.start.col; col <= lastCol; col += 1) {
      const field = fields[col]!;
      texts.push(copyText(field, cellValue(record, field), format));
    }
    cells.push(texts);
  }
  return cells;
}
