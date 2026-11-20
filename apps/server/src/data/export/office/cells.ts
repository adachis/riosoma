import { cellValue, markdownLine, markdownToDoc, type RichDoc, type RowData } from '@riosoma/contracts';
import { formatCellText, type FormatContext } from '../../format.js';
import type { StoredField } from '../../types.js';
import { resolvedField } from '../xlsx.js';

/**
 * A value as a document shows it.  Everything reads the way a CSV cell words it, in the person's
 * language and time zone, except where a page can do better: a checked box is a check mark, and
 * rich text keeps its bold, italics, lists, and links.
 */
export type DocumentValue =
  | { kind: 'text'; text: string; numeric: boolean }
  | { kind: 'check'; checked: boolean }
  | { kind: 'rich'; doc: RichDoc; source: string };

/** What a checked box shows as on a page */
export const CHECK_MARK = '✓';

/** Types whose values line up at the end of a column, the way the grid lines up numbers */
const NUMERIC = new Set<StoredField['type']>([
  'number',
  'currency',
  'percent',
  'duration',
  'autoNumber',
  'count',
  'rating',
]);

export function documentValue(
  stored: StoredField,
  row: RowData,
  fields: ReadonlyMap<string, StoredField>,
  context: FormatContext,
): DocumentValue {
  const field = resolvedField(stored);
  const value = cellValue(row, stored);
  if (field.type === 'checkbox') return { kind: 'check', checked: value === true };
  if (field.type === 'longText' && field.options.richText && typeof value === 'string')
    return { kind: 'rich', doc: markdownToDoc(value), source: value };
  return {
    kind: 'text',
    text: formatCellText(stored, row, fields, context),
    numeric: NUMERIC.has(field.type),
  };
}

/** A value on one line, for a slide's list or table, where there's no room for paragraphs. */
export function valueLine(value: DocumentValue): string {
  switch (value.kind) {
    case 'check':
      return value.checked ? CHECK_MARK : '';
    case 'text':
      return value.text.replace(/\s*\n\s*/g, ' ');
    case 'rich':
      return markdownLine(value.source);
  }
}
