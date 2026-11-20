import { z } from 'zod';
import { FieldId, LIMITS, RecordId, isTimeZone } from './fields.js';
import { WhereToken } from './filters.js';

/** How far find and replace go at once. */
export const SEARCH_LIMITS = {
  /** Characters in the text to find */
  queryLength: 1_000,
  /** Matches in one page of results */
  pageSize: 1_000,
  /** Matches a search lists in order.  The count goes on past it. */
  listed: 100_000,
  /** Cells one Replace all changes, as one undoable step */
  replaceCells: 10_000,
} as const;

/** A well-formed language tag.  Formatting falls back to a nearby language when one isn't installed. */
function isLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

/**
 * `POST /api/views/:viewId/search`.  Finds text the way the view's cells show it: every record the
 * view's filter admits, in the view's visible fields, ignoring case.  Numbers and dates match as
 * they read in `locale` and `tz`, select fields by their choice names, and people by their names.
 */
export const ViewSearchRequest = z.object({
  query: z.string().min(1).max(SEARCH_LIMITS.queryLength),
  /** Only these fields, in the view's order, or every visible field when left out */
  fieldIds: z.array(FieldId).max(LIMITS.fieldsPerTable).optional(),
  /** The snapshot the grid is showing, so positions line up with its rows */
  snapshot: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(SEARCH_LIMITS.pageSize).default(200),
  locale: z.string().min(2).max(35).refine(isLocale).default('en-US'),
  /** The viewer's IANA time zone, for dates that follow each viewer */
  tz: z.string().refine(isTimeZone).optional(),
  /** Also answer each match's text, for replacing.  Only text fields have one. */
  withText: z.boolean().default(false),
  /** The `where` token the grid's rows were read with */
  where: WhereToken.optional(),
});
export type ViewSearchRequest = z.input<typeof ViewSearchRequest>;

export const ViewSearchMatch = z.object({
  recordId: RecordId,
  fieldId: FieldId,
  /** The record's position in the snapshot */
  index: z.number().int().min(0),
  /** The cell's text, when asked for and the field holds plain text */
  text: z.string().optional(),
});
export type ViewSearchMatch = z.infer<typeof ViewSearchMatch>;

export const ViewSearchResult = z.object({
  snapshot: z.string(),
  /** True when the requested snapshot was gone and positions come from a new one */
  rebuilt: z.boolean(),
  /** Changes whenever the matches do, so a reader paging through knows to start over */
  key: z.string(),
  /** Every matching cell */
  total: z.number().int().min(0),
  /** Matching cells in each field */
  fields: z.record(z.string(), z.number().int().min(0)),
  /** How many matches are listed in order, at most `SEARCH_LIMITS.listed` */
  listed: z.number().int().min(0),
  offset: z.number().int().min(0),
  /** The page's matches in view order: by record, then by field */
  matches: z.array(ViewSearchMatch),
  /** Where the next page starts, or null after the last one */
  next: z.number().int().min(0).nullable(),
});
export type ViewSearchResult = z.infer<typeof ViewSearchResult>;
