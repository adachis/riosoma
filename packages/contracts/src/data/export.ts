import { z } from 'zod';
import { isTimeZone, LIMITS } from './fields.js';
import { WhereToken } from './filters.js';

/**
 * Downloading a view as a file: `GET /api/views/:viewId/export?format=&timeZone=&locale=`
 * (session, read access).  The file holds the view's records in its order, with its filter and
 * visible fields, and values as the app shows them in the person's language and time zone.
 * A `where` token narrows this reader's download, as it narrows the grid, without changing the view.
 * Excel files keep numbers, dates, checkboxes, and percentages as real values with matching
 * formats.  The response streams, so a million records never sit in memory.
 *
 * Word documents and PowerPoint decks are made for reading rather than for a spreadsheet, so they
 * take a title, and a deck takes a layout and the accent color its titles are drawn in.  Both are
 * built whole before they're sent, so each holds at most the records its limit below allows and
 * says so when the view has more.
 *
 * One record as a Word document: `GET /api/tables/:tableId/records/:recordId/export?format=docx
 * &timeZone=&locale=&comments=` (session, read access), with every field the person can see in the
 * record card's order, its images, and its comments when asked for.
 */
export const EXPORT_FORMATS = ['csv', 'xlsx', 'docx', 'pptx'] as const;
export const ExportFormat = z.enum(EXPORT_FORMATS);
export type ExportFormat = z.infer<typeof ExportFormat>;

/** A deck's records: a slide for each, or a table of them across as many slides as it takes */
export const DECK_LAYOUTS = ['records', 'table'] as const;
export const DeckLayout = z.enum(DECK_LAYOUTS);
export type DeckLayout = z.infer<typeof DeckLayout>;

/** A color as six hexadecimal digits, with no `#` */
export const HexColor = z.string().regex(/^[0-9A-Fa-f]{6}$/);

export const ExportQuery = z.object({
  /** Narrows an authenticated download for this reader alone */
  where: WhereToken.optional(),
  format: ExportFormat,
  timeZone: z.string().refine(isTimeZone),
  locale: z.string().min(2).max(35),
  /** A Word document's or deck's title.  Left out or blank, it's the view's name. */
  title: z.string().trim().max(LIMITS.nameLength).optional(),
  layout: DeckLayout.default('records'),
  /** The color a deck's titles are drawn in, which the app sends from the person's theme */
  accent: HexColor.optional(),
});
export type ExportQuery = z.infer<typeof ExportQuery>;

export const RECORD_EXPORT_FORMATS = ['docx'] as const;

export const RecordExportQuery = z.object({
  format: z.enum(RECORD_EXPORT_FORMATS),
  timeZone: z.string().refine(isTimeZone),
  locale: z.string().min(2).max(35),
  /** Whether the record's comments follow its fields */
  comments: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type RecordExportQuery = z.infer<typeof RecordExportQuery>;

/**
 * How much each document holds at most.  A workbook or a CSV file streams, so it holds every
 * record.  A Word document or a deck is built whole before it goes, so it stops at its limit and
 * says so on its first page.
 */
export const OFFICE_LIMITS = {
  /** Rows in a Word document's table, across every group */
  documentRecords: 5_000,
  /**
   * Values in a Word document's table.  A view that shows many fields stops at fewer records, so a
   * wide document takes no more to build than a narrow one.
   */
  documentValues: 50_000,
  /** Slides in a deck with a slide for each record, after the title slide */
  recordSlides: 200,
  /** Rows on each slide of a table deck */
  tableSlideRows: 12,
  /** Rows in a table deck, across every slide */
  tableRecords: 1_200,
  /** Fields on a record's slide, after its title */
  slideFields: 8,
  /** Columns on a table deck's slides, which get too narrow to read past this */
  tableSlideColumns: 8,
  /** Images a record's Word document shows */
  recordImages: 20,
  /** A Word document turns sideways once its table has more columns than this */
  portraitColumns: 6,
} as const;
