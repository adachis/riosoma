import { fieldDefault, type CellValue, type FieldMeta } from '@riosoma/contracts';

/**
 * A form's first answers.  A box checked by default starts checked, so leaving it and clearing it
 * are both answers.  Every other question starts empty, and the server gives one left blank its
 * field's default.
 */
export function startingAnswers(
  fields: ReadonlyArray<FieldMeta | null | undefined>,
): Record<string, CellValue> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = field?.type === 'checkbox' ? fieldDefault(field) : undefined;
      return field && value?.kind === 'value' && value.value === true ? [[field.id, true]] : [];
    }),
  );
}
