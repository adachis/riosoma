import { trustedHTML } from '../security/trusted-types';
import { AttachmentId, cellValue, idsOf, LIMITS, type FieldMeta, type RowData } from '@riosoma/contracts';

export interface AttachmentClipboardCell {
  fieldId: string;
  ids: string[];
}
export type AttachmentClipboard = Array<Array<AttachmentClipboardCell | null>>;

/** Keep public clipboard text readable and carry field-scoped IDs in spreadsheet HTML. */
export function writeAttachmentClipboard(
  data: { text: string; html: string },
  fields: readonly FieldMeta[],
  rows: readonly RowData[],
): { text: string; html: string } {
  const document = new DOMParser().parseFromString(trustedHTML(data.html), 'text/html');
  document.querySelectorAll('tr').forEach((tr, r) => {
    tr.querySelectorAll('td').forEach((td, c) => {
      const field = fields[c],
        row = rows[r];
      if (field?.type !== 'attachment' || !row) return;
      td.setAttribute('data-rio-file-field', field.id);
      td.setAttribute('data-rio-file-ids', JSON.stringify(idsOf(cellValue(row, field))));
    });
  });
  return { text: data.text, html: document.body.innerHTML };
}

export function readAttachmentClipboard(html?: string | null): AttachmentClipboard | undefined {
  if (!html) return;
  const table = new DOMParser().parseFromString(trustedHTML(html), 'text/html').querySelector('table');
  if (!table) return;
  // Merged and nested foreign tables have different coordinates; they use normal text parsing.
  if (table.querySelector('[colspan], [rowspan], table')) return;
  return Array.from(table.querySelectorAll('tr'), (row) =>
    Array.from(row.children, (cell) => {
      const fieldId = cell.getAttribute('data-rio-file-field');
      if (!fieldId) return null;
      try {
        const ids: unknown = JSON.parse(cell.getAttribute('data-rio-file-ids') ?? 'null');
        if (
          !Array.isArray(ids) ||
          ids.length > LIMITS.attachmentsPerCell ||
          !ids.every((id): id is string => AttachmentId.safeParse(id).success)
        )
          return null;
        return { fieldId, ids: [...new Set(ids)] };
      } catch {
        return null;
      }
    }),
  );
}
