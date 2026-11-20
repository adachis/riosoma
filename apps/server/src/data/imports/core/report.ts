import type { AirtableReport, AirtableReportItem } from '@riosoma/contracts';

type Subject = AirtableReportItem['subject'];

/** Something the report says about one table, field, view, or the whole import. */
export interface Note {
  status: 'exact' | 'changed' | 'omitted';
  /** A report message key, like `import.airtable.report.renamed` */
  key: string;
  params?: Record<string, string | number>;
  detail?: { messageKey: string; params?: Record<string, string | number> };
}

/**
 * The report an import leaves with its database: a line for each table, field, and view that came
 * across exactly, and one for each way something changed or was left out.
 */
export class ReportBuilder {
  private readonly items: AirtableReportItem[] = [];

  /** `exact` is the message key for something that came across as it was. */
  constructor(private readonly exact: string) {}

  add(subject: Subject, table: string | null, name: string | null, note: Note): void {
    this.items.push({
      status: note.status,
      subject,
      table,
      name,
      messageKey: note.key,
      params: note.params ?? {},
      ...(note.detail
        ? { detail: { messageKey: note.detail.messageKey, params: note.detail.params ?? {} } }
        : {}),
    });
  }

  /** Every note about one thing, or a line saying it came across exactly when there are none. */
  describe(subject: Subject, table: string | null, name: string | null, notes: readonly Note[]): void {
    if (!notes.length) this.add(subject, table, name, { status: 'exact', key: this.exact });
    for (const note of notes) this.add(subject, table, name, note);
  }

  build(counts: Omit<AirtableReport, 'items'>): AirtableReport {
    // What changed and what was left out come first, in the order they were found.
    const rank = { omitted: 0, changed: 1, exact: 2 } as const;
    const items = this.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => rank[a.item.status] - rank[b.item.status] || a.index - b.index)
      .map(({ item }) => item);
    return { ...counts, items };
  }
}
