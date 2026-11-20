import {
  cellValue,
  fillTemplate,
  templateText,
  type FieldMeta,
  type FilledLink,
  type RowData,
} from '@riosoma/contracts';
import type { FormatContext } from '../grid/format';

type ButtonField = Extract<FieldMeta, { type: 'button' }>;

/** What a button field's button says: its label, or the field's name when it has none. */
export function buttonLabel(field: ButtonField): string {
  return field.options.label || field.name;
}

/**
 * The link a button opens for a record, filled from the fields the viewer can see.  The server
 * fills the same template the same way for downloads and the REST API.
 */
export function buttonTarget(field: ButtonField, row: RowData | null, ctx: FormatContext): FilledLink {
  if (field.options.action.kind !== 'openUrl') return { ok: false, reason: 'empty' };
  return fillTemplate(field.options.action.urlTemplate, (id) => {
    const source = ctx.fieldsById?.get(id);
    if (!source || !row) return undefined;
    return templateText(source, cellValue(row, source), {
      person: (person) => ctx.collaborators.get(person)?.name,
      record: (record) => ctx.linked?.get(record),
      file: (file) => ctx.attachments?.get(file)?.name,
    });
  });
}

/** The database screen owns execution and the script panel across every record presentation. */
export function requestButtonRun(fieldId: string, recordId: string): void {
  window.dispatchEvent(new CustomEvent('rio-button-run', { detail: { fieldId, recordId } }));
}
