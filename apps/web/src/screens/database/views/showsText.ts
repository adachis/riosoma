import { isSignatureValue, type CellValue, type FieldMeta } from '@riosoma/contracts';

/**
 * Whether CardValue shows this value's formatCell text as visible words.  A checkbox shows a
 * mark and keeps its word for screen readers only, and a signature shows a drawing or a typed
 * name instead of the words formatCell gives, so both read as marks.  Every other branch shows
 * its text, choice pills and button labels included.  A control's name says the visible words
 * first, as one run, and the words of marks after them.
 */
export function showsText(field: FieldMeta, value: CellValue): boolean {
  if (field.type === 'checkbox') return false;
  if (field.type === 'signature') return !isSignatureValue(value);
  return true;
}
