import {
  COLUMN_WIDTH,
  visibleFieldIds,
  type FieldMeta,
  type GridConfig,
  type ViewType,
} from '@riosoma/contracts';

/**
 * The choices a printout starts from: paper, orientation, and which fields, plus the name its file
 * is saved under.  Everything here is a pure function of the view and the person's language, so
 * the dialog and the tests read the same defaults.
 */

/** Paper sizes, named the way the PDF library names them. */
export const PAGE_SIZES = ['LETTER', 'A4'] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const ORIENTATIONS = ['portrait', 'landscape'] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/** The views that print: a grid as a table, a gallery and a kanban as cards. */
export const PRINTABLE_VIEW_TYPES = [
  'grid',
  'gallery',
  'kanban',
  'orgChart',
] as const satisfies readonly ViewType[];
export type PrintableViewType = (typeof PRINTABLE_VIEW_TYPES)[number];

export function isPrintableViewType(type: ViewType): type is PrintableViewType {
  return (PRINTABLE_VIEW_TYPES as readonly ViewType[]).includes(type);
}

/**
 * Where US Letter is the usual paper, from the Unicode CLDR's paper size data.  Everywhere else
 * uses A4.
 */
const LETTER_REGIONS = new Set([
  'BZ',
  'CA',
  'CL',
  'CO',
  'CR',
  'GT',
  'MX',
  'NI',
  'PA',
  'PH',
  'PR',
  'SV',
  'US',
  'VE',
]);

function parse(tag: string): Intl.Locale | null {
  try {
    return new Intl.Locale(tag);
  } catch {
    return null;
  }
}

/**
 * Letter or A4 for someone reading in `locale`.  Riosoma's languages mostly carry no region, so a
 * browser language in the same language with a region, such as `es-MX` or `en-GB`, decides first.
 */
export function defaultPageSize(locale: string, languages: readonly string[] = []): PageSize {
  const own = parse(locale);
  const browser = languages
    .map(parse)
    .find((tag) => tag !== null && tag.language === own?.language && tag.region !== undefined);
  const region = browser?.region ?? own?.region ?? own?.maximize().region;
  return region !== undefined && LETTER_REGIONS.has(region) ? 'LETTER' : 'A4';
}

/** A grid prints wide, so it starts in landscape.  Cards and records read top to bottom. */
export function defaultOrientation(kind: PrintableViewType | 'record'): Orientation {
  return kind === 'grid' || kind === 'orgChart' ? 'landscape' : 'portrait';
}

/** A field a printout can include, and whether it starts out included. */
export interface FieldChoice {
  field: FieldMeta;
  chosen: boolean;
}

/**
 * Every field in the view's order, with the primary field first.  The fields the view shows start
 * out chosen, and hidden ones keep their place, unchosen, so they can be added back.
 */
export function viewFieldChoices(
  config: GridConfig,
  fields: readonly FieldMeta[],
  primaryFieldId: string,
): FieldChoice[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const shown = new Set(visibleFieldIds(config, fields, primaryFieldId));
  return visibleFieldIds({ ...config, hiddenFieldIds: [] }, fields, primaryFieldId).flatMap((id) => {
    const field = byId.get(id);
    return field ? [{ field, chosen: shown.has(id) }] : [];
  });
}

/** A record prints the fields its card shows, in the card's order, with the primary field first. */
export function recordFieldChoices(fields: readonly FieldMeta[], primaryFieldId: string): FieldChoice[] {
  const primary = fields.filter((field) => field.id === primaryFieldId);
  return [...primary, ...fields.filter((field) => field.id !== primaryFieldId)].map((field) => ({
    field,
    chosen: true,
  }));
}

/**
 * The chosen fields in the order the choices list them.  The primary field is always included:
 * it names every card and record, and it is the grid's first column.
 */
export function chosenFields(
  choices: readonly FieldChoice[],
  chosenIds: ReadonlySet<string>,
  primaryFieldId: string,
): FieldMeta[] {
  return choices
    .filter(({ field }) => field.id === primaryFieldId || chosenIds.has(field.id))
    .map(({ field }) => field);
}

/** A column's width in the view, in CSS pixels, the same way the grid reads it. */
export function columnWidth(config: GridConfig, fieldId: string, primaryFieldId: string): number {
  return (
    config.columnWidths[fieldId] ?? (fieldId === primaryFieldId ? COLUMN_WIDTH.primary : COLUMN_WIDTH.default)
  );
}

/** Control characters, and the separators and reserved characters Windows and POSIX refuse. */
const UNSAFE_NAME = /[\\/:*?"<>|\p{Cc}\p{Cf}]/gu;

/** Short enough to leave room for a download folder and the extension. */
const NAME_PART = 60;

function tidy(name: string): string {
  return (
    name
      .replace(UNSAFE_NAME, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_PART)
      // A trailing dot or space disappears on Windows, which would leave a different name behind.
      .replace(/[.\s]+$/, '')
      .trim()
  );
}

/**
 * `<table> - <title>.pdf`, the way a CSV download is named, so a PDF of the same view sits next to
 * it in a downloads folder.  Only one part is kept when both say the same thing.
 */
export function pdfFileName(tableName: string, title: string, fallback: string): string {
  const parts = [tidy(tableName), tidy(title)].filter(Boolean);
  const unique = parts.length === 2 && parts[0] === parts[1] ? [parts[0]!] : parts;
  return `${unique.length ? unique.join(' - ') : tidy(fallback) || 'records'}.pdf`;
}
