import { PassThrough, type Readable } from 'node:stream';
import { OFFICE_LIMITS, type DeckLayout, type RowData } from '@riosoma/contracts';
import type { FormatContext } from '../../format.js';
import { loadCollaborators } from '../../metadata.js';
import type { StoredField } from '../../types.js';
import type { ExportOrder, ExportSource } from '../source.js';
import { documentValue, valueLine, type DocumentValue } from './cells.js';
import { OFFICE_COPY, say } from './copy.js';
import type { DeckRecord } from './deck.js';
import { describeFilter, filterRecordNames } from './filter-words.js';
import { groupItems, groupPlan } from './groups.js';
import { fieldFiles, isPicture, loadImage, type ImageSource } from './images.js';
import { deckWriter, wordWriter } from './load.js';
import { holdRecords, type HeldRecord, type HeldRecords } from './records.js';
import type { WordGroup } from './word.js';

/**
 * A view as a Word document or a deck.  The records are read the way every download reads them,
 * through the person's own access and in the view's order, up to the document's limit, and the
 * words around them follow the person's language and time zone.
 */

export type OfficeFormat = 'docx' | 'pptx';

export interface OfficeOptions {
  format: OfficeFormat;
  /** The title the person typed, or empty for the view's name */
  title?: string | undefined;
  layout: DeckLayout;
  /** The theme's accent color, as six hexadecimal digits */
  accent?: string | undefined;
  /** Where attachment images are read from, for a deck's pictures */
  images: Omit<ImageSource, 'table'>;
  now: Date;
}

/** How many records a document of this kind holds at most, with `columns` fields to a record. */
export function officeLimit(format: OfficeFormat, layout: DeckLayout, columns: number): number {
  if (format === 'docx')
    return Math.min(
      OFFICE_LIMITS.documentRecords,
      Math.floor(OFFICE_LIMITS.documentValues / Math.max(1, columns)),
    );
  return layout === 'table' ? OFFICE_LIMITS.tableRecords : OFFICE_LIMITS.recordSlides;
}

/** When a document was made, in the reader's words and zone. */
export function madeAt(now: Date, locale: string, timeZone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone }).format(now);
}

/** The lines under a view document's title: where it's from, how many records, and the filter. */
async function aboutLines(source: ExportSource, held: HeldRecords, now: Date): Promise<string[]> {
  const { read, locale } = source;
  const fields = new Map(read.fields.map((field) => [field.id, field]));
  const records = await filterRecordNames(
    source.pool,
    source.schemas,
    source.scope,
    read.view.config.filter,
    fields,
  );
  // A filter can name someone no record holds, while the reader's directory visibility still applies.
  const people = await loadCollaborators(source.pool, source.schemas, read.table.orgId, source.scope);
  const filter = describeFilter(read.view.config.filter, fields, {
    ...held.context,
    people: new Map(people.map((person) => [person.id, person])),
    records,
  });
  return [
    say(OFFICE_COPY.source, locale, {
      view: read.view.name,
      table: read.table.name,
      time: madeAt(now, locale, source.timeZone),
    }),
    say(OFFICE_COPY.count, locale, { count: held.total }),
    filter ? say(OFFICE_COPY.filter, locale, { filter }) : say(OFFICE_COPY.noFilter, locale),
  ];
}

function cappedNote(source: ExportSource, held: HeldRecords, limit: number): string | null {
  return held.total > limit
    ? say(OFFICE_COPY.capped, source.locale, { shown: limit, total: held.total })
    : null;
}

function valuesOf(fields: readonly StoredField[], record: HeldRecord): DocumentValue[] {
  return fields.map((field) => documentValue(field, record.row, record.read, record.context));
}

function recordTitle(source: ExportSource, record: HeldRecord): string {
  const primary = source.fields.find((field) => field.id === source.read.table.primaryFieldId);
  const title = primary
    ? valueLine(documentValue(primary, record.row, record.read, record.context)).trim()
    : '';
  return title || say(OFFICE_COPY.untitled, source.locale);
}

/** Wider columns for what usually runs long: the primary field and long text. */
function weight(field: StoredField, primaryFieldId: string): number {
  if (field.type === 'longText') return 2.5;
  if (field.id === primaryFieldId) return 1.6;
  return 1;
}

function wordGroups(source: ExportSource, held: HeldRecords): WordGroup[] {
  const plan = groupPlan(source.read);
  const rows = (records: readonly HeldRecord[]) => records.map((record) => valuesOf(source.fields, record));
  if (!plan) return held.records.length ? [{ heading: null, rows: rows(held.records) }] : [];
  const context: FormatContext = held.context;
  return groupItems(plan, held.records, (record: HeldRecord): RowData => record.row, context).map(
    (group) => ({
      heading: say(OFFICE_COPY.group, source.locale, { group: group.name, count: group.items.length }),
      rows: rows(group.items),
    }),
  );
}

async function wordView(source: ExportSource, order: ExportOrder, options: OfficeOptions): Promise<Buffer> {
  const limit = officeLimit('docx', options.layout, source.fields.length);
  const held = await holdRecords(source, order, limit);
  const { locale } = source;
  const primaryFieldId = source.read.table.primaryFieldId;
  const word = await wordWriter();
  return word.viewDocument({
    title: options.title || source.read.view.name,
    lines: await aboutLines(source, held, options.now),
    note: cappedNote(source, held, limit),
    columns: source.fields.map((field) => ({ name: field.name, weight: weight(field, primaryFieldId) })),
    groups: wordGroups(source, held),
    empty: say(OFFICE_COPY.noRecords, locale),
    paper: word.paperFor(locale),
    landscape: source.fields.length > OFFICE_LIMITS.portraitColumns,
    pageLabel: say(OFFICE_COPY.page, locale, { page: word.PAGE_SLOT, count: word.PAGES_SLOT }),
  });
}

/** The first picture in a record's first attachment field, at a size a slide can use. */
async function slideImage(
  images: ImageSource,
  field: StoredField | undefined,
  record: HeldRecord,
): Promise<DeckRecord['image']> {
  if (!field) return null;
  const file = (await fieldFiles(images, field, record.row)).find(isPicture);
  return file ? loadImage(images, file, 1_280) : null;
}

async function deckView(source: ExportSource, order: ExportOrder, options: OfficeOptions): Promise<Buffer> {
  const deck = await deckWriter();
  const limit = officeLimit('pptx', options.layout, source.fields.length);
  const held = await holdRecords(source, order, limit);
  const { locale } = source;
  const lines = await aboutLines(source, held, options.now);
  const columns = source.fields.slice(0, OFFICE_LIMITS.tableSlideColumns);
  if (options.layout === 'table' && source.fields.length > columns.length)
    lines.push(
      say(OFFICE_COPY.fieldsLeftOut, locale, { shown: columns.length, total: source.fields.length }),
    );
  const base = {
    title: options.title || source.read.view.name,
    lines,
    note: cappedNote(source, held, limit),
    accent: deck.readableAccent(options.accent),
    empty: say(OFFICE_COPY.noRecords, locale),
  };
  if (options.layout === 'table')
    return deck.tableDeck({
      ...base,
      columns: columns.map((field) => field.name),
      rows: held.records.map((record) => valuesOf(columns, record).map(valueLine)),
      rowsPerSlide: OFFICE_LIMITS.tableSlideRows,
      range: (first, last) => say(OFFICE_COPY.rows, locale, { first, last, total: held.records.length }),
    });
  const images: ImageSource = { ...options.images, table: source.read.table };
  const primaryFieldId = source.read.table.primaryFieldId;
  const shown = source.fields
    .filter((field) => field.id !== primaryFieldId)
    .slice(0, OFFICE_LIMITS.slideFields);
  const pictures = source.fields.find((field) => field.type === 'attachment');
  const records: DeckRecord[] = [];
  for (const record of held.records)
    records.push({
      title: recordTitle(source, record),
      fields: shown.map((field) => ({
        label: field.name,
        value: valueLine(documentValue(field, record.row, record.read, record.context)),
      })),
      image: await slideImage(images, pictures, record),
    });
  return deck.recordDeck({ ...base, records });
}

/** The document, built whole. */
export function officeView(
  source: ExportSource,
  order: ExportOrder,
  options: OfficeOptions,
): Promise<Buffer> {
  return options.format === 'docx' ? wordView(source, order, options) : deckView(source, order, options);
}

/**
 * The document as a stream a reply can send once its headers are settled.  A document can't be
 * written a page at a time the way a workbook can, so the stream carries it once it's built.
 */
export function officeStream(source: ExportSource, order: ExportOrder, options: OfficeOptions): Readable {
  const output = new PassThrough();
  officeView(source, order, options).then(
    (bytes) => output.end(bytes),
    (error: unknown) => {
      // The status and headers are long gone, so all that's left is to end a truncated file.
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    },
  );
  return output;
}
