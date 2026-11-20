import type { AttachmentMeta, Collaborator, RowData } from '@riosoma/contracts';
import type { FormatContext } from '../../format.js';
import type { StoredField } from '../../types.js';
import { exportPages, type ExportOrder, type ExportSource } from '../source.js';

/**
 * A view's records for a document, which is built whole: the first `limit` in the view's order,
 * each with the names its page read for it.  Only this many are ever held, however large the view.
 */

export interface HeldRecord {
  row: RowData;
  context: FormatContext;
  /** Every field the record's page holds, including the ones buttons fill their links from */
  read: ReadonlyMap<string, StoredField>;
}

export interface HeldRecords {
  records: HeldRecord[];
  /** How many records the view holds for this person, which a capped file says it stops short of */
  total: number;
  /** The names every page read, together, for headings that span pages */
  context: FormatContext;
}

export async function holdRecords(
  source: ExportSource,
  order: ExportOrder,
  limit: number,
): Promise<HeldRecords> {
  const total = Math.min(order.total, limit);
  // Pages stop at the limit too, so the last one never reads past it.
  const capped: ExportOrder = {
    total,
    page: (offset, count, fields) => order.page(offset, Math.min(count, total - offset), fields),
  };
  const records: HeldRecord[] = [];
  const people = new Map<string, Collaborator>();
  const files = new Map<string, AttachmentMeta>();
  const linked = new Map<string, string>();
  for await (const page of exportPages(source, capped)) {
    for (const [id, person] of page.context.people) people.set(id, person);
    for (const [id, file] of page.context.files) files.set(id, file);
    for (const [id, name] of page.context.linked) linked.set(id, name);
    for (const row of page.rows) records.push({ row, context: page.context, read: page.read });
  }
  return {
    records,
    total: order.total,
    context: { locale: source.locale, timeZone: source.timeZone, people, files, linked },
  };
}
