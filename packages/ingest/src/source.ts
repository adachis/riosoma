/**
 * Every incoming file is turned into one uniform shape before anything reads it for meaning:
 * raw grids for a workbook, text for each page of a document, an envelope for an email.  Readers
 * work from this shape alone, so a new file type is one extractor and nothing else changes.
 */

/** What a cell holds, as the file stored it.  Blank is its own type, so it stays distinct from zero. */
export type CellType = 'text' | 'number' | 'date' | 'bool' | 'empty';

/**
 * One cell of a raw grid.  A date is an ISO string (`2026-03-01` or `2026-03-01T09:30:00`).  An
 * identifier keeps its text, leading zeros included, so it is `text` even when it is all digits.
 */
export interface Cell {
  v: string | number | boolean | null;
  t: CellType;
}

/** A sheet as a raw grid.  No header is assumed and blank rows are kept, so positions mean something. */
export interface SourceSheet {
  name: string;
  hidden: boolean;
  rows: Cell[][];
  /** One-based inclusive ranges.  Only the top-left cell has a value, which readers can fill down. */
  merges?: SourceMerge[];
}

export interface SourceMerge {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Whether a page's text layer can be trusted: it reads as words, as noise, or there is none. */
export type TextQuality = 'clean' | 'garbled' | 'none';

export interface SourcePage {
  /** Counted from 1. */
  number: number;
  text: string;
  textQuality: TextQuality;
}

/** An email's envelope and body.  A forwarded message also carries who first sent it and when. */
export interface SourceEmail {
  from: string;
  originalFrom?: string;
  subject: string;
  /** ISO date and time. */
  date: string;
  originalDate?: string;
  bodyText: string;
  /** Each table found in the body, as rows of cell text. */
  tables: string[][][];
  messageId: string;
}

export interface SourceImage {
  index: number;
  width: number;
  height: number;
}

export type SourceKind = 'workbook' | 'text' | 'pdf' | 'email' | 'image' | 'tree' | 'archive';

/** Child bytes stay in memory.  Names are labels, never filesystem paths. */
export interface SourcePart {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  inline?: boolean;
  contentId?: string;
  archiveDepth: number;
  emailDepth: number;
  /** Nested messages are read one level deep.  Their attachments remain parts. */
  source?: ExtractedSource;
}

export interface ExtractedSource {
  kind: SourceKind;
  name: string;
  sheets?: SourceSheet[];
  pages?: SourcePage[];
  email?: SourceEmail;
  images?: SourceImage[];
  /** JSON, XML, and similar structured files, parsed. */
  tree?: unknown;
  parts?: SourcePart[];
  /** Message catalog IDs for things the extractor noticed and worked around. */
  warnings: string[];
}

/** Where a row came from, so a person can be shown the place and a question can quote it. */
export interface RowLocation {
  sheet?: string;
  /** Counted from 1, as a person reads the sheet. */
  row?: number;
  page?: number;
  /** A line on a page, counted from 1. */
  line?: number;
  /** An email body table, counted from 1. */
  table?: number;
}

/**
 * One row read from a file.  `values` is keyed by the output format's stable field keys, never by
 * a field's name or ID, so renaming a field breaks nothing.  `raw` keeps the text as received for
 * any value a cleaner changed.
 */
export interface IngestRow {
  values: Record<string, unknown>;
  at: RowLocation;
  raw: Record<string, string>;
}

/** What a cleaner returns.  It never guesses: a value it is unsure of says so. */
export interface Cleaned<T> {
  value: T | null;
  certain: boolean;
}

export const EMPTY_CELL: Cell = Object.freeze({ v: null, t: 'empty' as const });

/**
 * Types a value as a cell.  Text that is only white space is blank.  A string is never turned into
 * a number here, because an identifier such as `00412` must keep its zeros.
 */
export function cell(value: string | number | boolean | Date | null | undefined): Cell {
  if (value === null || value === undefined) return EMPTY_CELL;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? EMPTY_CELL : { v: isoDate(value), t: 'date' };
  if (typeof value === 'boolean') return { v: value, t: 'bool' };
  if (typeof value === 'number') return Number.isFinite(value) ? { v: value, t: 'number' } : EMPTY_CELL;
  return value.trim() === '' ? EMPTY_CELL : { v: value, t: 'text' };
}

/** Whether every cell in a row is blank.  A row of zeros is not blank. */
export function isBlankRow(row: readonly Cell[]): boolean {
  return row.every((item) => item.t === 'empty');
}

/** A calendar day when the time is midnight UTC, and a date and time otherwise. */
function isoDate(value: Date): string {
  const text = value.toISOString();
  return text.endsWith('T00:00:00.000Z') ? text.slice(0, 10) : text.slice(0, 19);
}
