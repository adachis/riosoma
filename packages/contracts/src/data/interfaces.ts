import { z } from 'zod';
import { safeLink } from './button.js';
import { ChartTileSettings, NumberTileSettings, TilePlace, type TileData } from './dashboards.js';
import { AttachmentId, FieldId, LIMITS, Name, RecordId, TableId, ViewId, type FieldMeta } from './fields.js';
import { checkCondition, FilterGroup, operatorsForField, type FilterCondition } from './filters.js';
import type { RowsPage } from './rows.js';

/**
 * Interfaces: pages people build from blocks to work with a database's records without seeing its
 * tables.  An interface keeps its pages in order, and each page lays its blocks out on the same
 * 12-column grid as a dashboard's tiles.  Every block reads through the same access rules as the
 * grid, so two people can see different records on one page.
 *
 * Interfaces change through commands (`interface.create`, `interface.update`, `interface.move`,
 * `interface.trash`, `interface.restore`), so they undo, broadcast, and go to the trash like
 * dashboards.  Blocks read through routes (session, read access):
 * - `POST /api/interfaces/:interfaceId/data` (`InterfaceDataRequest`) → `InterfaceData`: a page's
 *   number and chart blocks, computed the way dashboard tiles are
 * - `POST /api/interfaces/:interfaceId/records` (`InterfaceRecordsRequest`) → `InterfaceRecordsPage`:
 *   part of one records block's records in its view's order, narrowed by the block's own filter
 *   and by what the person chose in the page's filter blocks
 */
export const InterfaceId = z.string().regex(/^itf[0-9A-Za-z]{14}$/);
/** Unique within its interface */
export const InterfacePageId = z.string().regex(/^[0-9A-Za-z_-]{6,40}$/);
/** Unique within its interface */
export const BlockId = z.string().regex(/^[0-9A-Za-z_-]{6,40}$/);

export const INTERFACE_LIMITS = {
  pages: 20,
  /** Characters in each code source */
  codeLength: 50_000,
  blocksPerPage: 50,
  /** Fields a records block shows beside each record's name */
  listFields: 20,
  /** Fields a record block shows */
  recordFields: 100,
  /** Records one request reads */
  pageSize: 100,
  /** Characters a search box takes */
  searchLength: 200,
} as const;

export const BLOCK_KINDS = [
  'records',
  'record',
  'number',
  'chart',
  'text',
  'hero',
  'media',
  'filter',
  'button',
  'code',
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** Records can show as a list, table, card grid, native disclosures, or alternating sections. */
export const RECORDS_DISPLAYS = ['list', 'table', 'cards', 'accordion', 'sections'] as const;
export type RecordsDisplay = (typeof RECORDS_DISPLAYS)[number];

export const TEXT_STYLES = ['heading', 'paragraph', 'lead'] as const;
export type TextStyle = (typeof TEXT_STYLES)[number];

/** A filter block offers a field's choices, people, or checkbox states, or a box to type text into. */
export const FILTER_CONTROLS = ['choice', 'search'] as const;
export const FilterControl = z.enum(FILTER_CONTROLS);
export type FilterControl = z.infer<typeof FilterControl>;

/** Where a records block's records come from: a view of a table, then the block's own filter. */
export const RecordsSource = z.object({
  tableId: TableId,
  viewId: ViewId,
  filter: FilterGroup.nullable().default(null),
});
export type RecordsSource = z.infer<typeof RecordsSource>;

export const ButtonBlockAction = z.discriminatedUnion('kind', [
  /** Opens one of a table's form views in a dialog, to add a record to the table */
  z.object({ kind: z.literal('form'), tableId: TableId, viewId: ViewId }),
  /** Opens a safe web address */
  z.object({ kind: z.literal('url'), url: z.string().max(LIMITS.urlLength).refine(safeLink) }),
  /** Opens another page of the same interface or published site */
  z.object({ kind: z.literal('page'), pageId: InterfacePageId }),
]);
export type ButtonBlockAction = z.infer<typeof ButtonBlockAction>;

export const RecordAttachment = z.object({
  tableId: TableId,
  recordId: RecordId,
  fieldId: FieldId,
  attachmentId: AttachmentId,
});
export type RecordAttachment = z.infer<typeof RecordAttachment>;
export const HeroButton = z.object({
  label: z.string().trim().min(1).max(LIMITS.buttonLabelLength),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('url'), url: z.string().max(LIMITS.urlLength).refine(safeLink) }),
    z.object({ kind: z.literal('page'), pageId: InterfacePageId }),
  ]),
});
export type HeroButton = z.infer<typeof HeroButton>;

export const BLOCK_BANDS = ['none', 'quiet', 'accent', 'inverse'] as const;
export type BlockBand = (typeof BLOCK_BANDS)[number];
const band = { band: z.enum(BLOCK_BANDS).optional() };
const playback = { playback: z.enum(['controls', 'loop']).optional() };

const blockBase = {
  id: BlockId,
  title: z.string().max(LIMITS.nameLength).default(''),
  place: TilePlace,
};

export const InterfaceCode = z.object({
  html: z.string().max(INTERFACE_LIMITS.codeLength).default(''),
  css: z.string().max(INTERFACE_LIMITS.codeLength).default(''),
  javascript: z.string().max(INTERFACE_LIMITS.codeLength).default(''),
});
export type InterfaceCode = z.infer<typeof InterfaceCode>;

/** Only records blocks on this page can supply records to custom code */
export const InterfaceCodeRequest = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('records'),
    blockId: BlockId,
    offset: z.number().int().min(0).max(1_000_000_000).default(0),
  }),
  z.object({ method: z.literal('selected'), blockId: BlockId }),
  z.object({ method: z.literal('open'), blockId: BlockId, recordId: RecordId }),
  z.object({
    method: z.literal('change'),
    blockId: BlockId,
    recordId: RecordId,
    values: z
      .record(FieldId, z.unknown())
      .refine(
        (value) =>
          Object.keys(value).length > 0 && Object.keys(value).length <= INTERFACE_LIMITS.recordFields,
      ),
  }),
]);
export type InterfaceCodeRequest = z.infer<typeof InterfaceCodeRequest>;

export const Block = z.discriminatedUnion('kind', [
  z.object({ ...blockBase, kind: z.literal('code'), ...InterfaceCode.shape }),
  z.object({
    ...blockBase,
    kind: z.literal('records'),
    ...band,
    source: RecordsSource,
    /** Fields shown with each record's name, in order */
    fieldIds: z.array(FieldId).max(INTERFACE_LIMITS.listFields).default([]),
    display: z.enum(RECORDS_DISPLAYS).default('list'),
    /** Readers default to 25 so older blocks keep their saved settings unchanged. */
    pageSize: z.number().int().min(1).max(INTERFACE_LIMITS.pageSize).optional(),
    /** Lists and cards can use the first selected value as the record heading. */
    showFieldNames: z.boolean().default(true),
    /** An explicitly selected attachment field for card covers or section media */
    coverFieldId: FieldId.nullable().optional(),
    enlarge: z.boolean().optional(),
    altFieldId: FieldId.nullable().optional(),
    linkFieldId: FieldId.nullable().optional(),
    linkLabelFieldId: FieldId.nullable().optional(),
    ...playback,
  }),
  z.object({
    ...blockBase,
    kind: z.literal('record'),
    /** The records block on the same page whose selected record this shows */
    recordsBlockId: BlockId.nullable().default(null),
    /** Fields shown, in order.  Every field, in the table's order, when empty */
    fieldIds: z.array(FieldId).max(INTERFACE_LIMITS.recordFields).default([]),
  }),
  z.object({ ...blockBase, ...band, kind: z.literal('number'), ...NumberTileSettings.shape }),
  z.object({ ...blockBase, ...band, kind: z.literal('chart'), ...ChartTileSettings.shape }),
  z.object({
    ...blockBase,
    kind: z.literal('text'),
    ...band,
    style: z.enum(TEXT_STYLES).default('paragraph'),
    /** Saved paragraphs retain note formatting, while leads and headings use the safe site subset. */
    text: z.string().max(LIMITS.descriptionLength).default(''),
  }),
  z.object({
    ...blockBase,
    kind: z.literal('hero'),
    ...band,
    ...playback,
    mediaType: z.enum(['image', 'video']).optional(),
    heading: z.string().max(LIMITS.nameLength).default(''),
    text: z.string().max(LIMITS.descriptionLength).default(''),
    buttons: z.array(HeroButton).max(2).default([]),
    image: RecordAttachment.nullable().default(null),
    alt: z.string().max(LIMITS.descriptionLength).default(''),
  }),
  z.object({
    ...blockBase,
    kind: z.literal('media'),
    ...band,
    ...playback,
    enlarge: z.boolean().optional(),
    mediaType: z.enum(['image', 'video']).default('image'),
    attachment: RecordAttachment.nullable().default(null),
    alt: z.string().max(LIMITS.descriptionLength).default(''),
    caption: z.string().max(LIMITS.descriptionLength).default(''),
  }),
  z.object({
    ...blockBase,
    kind: z.literal('filter'),
    control: FilterControl.default('choice'),
    tableId: TableId,
    fieldId: FieldId,
    /** The records blocks it narrows.  Every records block of its table on the page when empty */
    blockIds: z.array(BlockId).max(INTERFACE_LIMITS.blocksPerPage).default([]),
  }),
  z.object({
    ...blockBase,
    kind: z.literal('button'),
    ...band,
    label: z.string().max(LIMITS.buttonLabelLength).default(''),
    action: ButtonBlockAction,
  }),
]);
export type Block = z.infer<typeof Block>;
export type CodeBlock = Extract<Block, { kind: 'code' }>;
export type RecordsBlock = Extract<Block, { kind: 'records' }>;
export type RecordBlock = Extract<Block, { kind: 'record' }>;
export type NumberBlock = Extract<Block, { kind: 'number' }>;
export type ChartBlock = Extract<Block, { kind: 'chart' }>;
export type TextBlock = Extract<Block, { kind: 'text' }>;
export type HeroBlock = Extract<Block, { kind: 'hero' }>;
export type MediaBlock = Extract<Block, { kind: 'media' }>;
export type FilterBlock = Extract<Block, { kind: 'filter' }>;
export type ButtonBlock = Extract<Block, { kind: 'button' }>;
/** A block computed the way a dashboard tile is */
export type SummaryBlock = NumberBlock | ChartBlock;

export function isSummaryBlock(block: Block): block is SummaryBlock {
  return block.kind === 'number' || block.kind === 'chart';
}

export const InterfacePage = z.object({
  id: InterfacePageId,
  name: Name,
  blocks: z.array(Block).max(INTERFACE_LIMITS.blocksPerPage).default([]),
});
export type InterfacePage = z.infer<typeof InterfacePage>;

export const InterfacePages = z.array(InterfacePage).max(INTERFACE_LIMITS.pages);

export const InterfaceMeta = z.object({
  id: InterfaceId,
  databaseId: z.string(),
  name: Name,
  position: z.number(),
  pages: InterfacePages,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InterfaceMeta = z.infer<typeof InterfaceMeta>;

export const InterfaceCreate = z.object({
  id: InterfaceId,
  name: Name,
  pages: InterfacePages.default([]),
});
export type InterfaceCreate = z.infer<typeof InterfaceCreate>;

export const InterfaceDataRequest = z.object({
  pageId: InterfacePageId,
  /** Blocks to compute, or every number and chart block on the page when left out */
  blockIds: z.array(BlockId).max(INTERFACE_LIMITS.blocksPerPage).optional(),
  /** For date buckets and relative date filters */
  timeZone: z.string().min(1).max(64),
});
export type InterfaceDataRequest = z.infer<typeof InterfaceDataRequest>;

export interface InterfaceData {
  /** Each number and chart block's data, or the reason it has none, as dashboard tiles answer */
  blocks: Record<string, TileData>;
}

/** What someone chose in a filter block: a choice's or person's ID, a checkbox state, or text to find */
export const FilterBlockValue = z.union([z.string().max(INTERFACE_LIMITS.searchLength), z.boolean()]);
export type FilterBlockValue = z.infer<typeof FilterBlockValue>;

export const InterfaceRecordsRequest = z.object({
  pageId: InterfacePageId,
  blockId: BlockId,
  /** What the person chose in the page's filter blocks, by block.  A block left out narrows nothing. */
  filters: z.record(BlockId, FilterBlockValue).optional(),
  offset: z.number().int().min(0).max(1_000_000_000),
  limit: z.number().int().min(1).max(INTERFACE_LIMITS.pageSize),
  /** The order to page through, from an earlier answer, so records don't shift between pages */
  snapshot: z
    .string()
    .regex(/^[0-9A-Za-z_-]{1,64}$/)
    .optional(),
  /** Takes the order afresh, after records changed */
  refresh: z.boolean().optional(),
  /** For relative date filters and fields that show each person their own time zone */
  timeZone: z.string().min(1).max(64),
});
export type InterfaceRecordsRequest = z.infer<typeof InterfaceRecordsRequest>;

/** Records in the view's order from `offset`, the way a view's rows arrive, with the table they're from */
export type InterfaceRecordsPage = RowsPage & { tableId: string };

const CHOICE_TYPES: ReadonlySet<FieldMeta['type']> = new Set([
  'singleSelect',
  'multipleSelect',
  'user',
  'createdBy',
  'lastModifiedBy',
  'checkbox',
]);

/** The controls a filter block can offer for a field. */
export function filterControls(field: Pick<FieldMeta, 'type' | 'options'>): FilterControl[] {
  const controls: FilterControl[] = [];
  if (CHOICE_TYPES.has(field.type)) controls.push('choice');
  if (operatorsForField(field).includes('contains')) controls.push('search');
  return controls;
}

/**
 * The condition a filter block adds for what someone chose, or null when it narrows nothing: no
 * choice yet, empty text, or a value that doesn't suit the field.  A choice keeps the records that
 * hold it, and a search the records whose field contains the text.
 */
export function filterBlockCondition(
  control: FilterControl,
  field: FieldMeta,
  value: FilterBlockValue | undefined,
): FilterCondition | null {
  if (value === undefined || !filterControls(field).includes(control)) return null;
  const condition = (operator: FilterCondition['operator'], operand: unknown): FilterCondition => ({
    id: 'block',
    fieldId: field.id,
    operator,
    value: operand,
  });
  let result: FilterCondition | null = null;
  if (control === 'search') {
    if (typeof value === 'string' && value.trim()) result = condition('contains', value.trim());
  } else if (field.type === 'checkbox') {
    if (typeof value === 'boolean') result = condition('is', value);
  } else if (typeof value === 'string' && value) {
    result =
      field.type === 'multipleSelect' || field.type === 'user'
        ? condition('hasAnyOf', [value])
        : condition('is', value);
  }
  return result && checkCondition(field, result).usable ? result : null;
}

/**
 * The filter blocks on a page that narrow a records block: the ones that name it, and the ones for
 * its table that name no block at all.
 */
export function filtersFor(page: Pick<InterfacePage, 'blocks'>, block: RecordsBlock): FilterBlock[] {
  return page.blocks.filter(
    (item): item is FilterBlock =>
      item.kind === 'filter' &&
      item.tableId === block.source.tableId &&
      (item.blockIds.length ? item.blockIds.includes(block.id) : true),
  );
}

/** Spanning blocks join the rows they cross, so a band never splits a block. */
export function blockBands(blocks: readonly Block[]): Array<{ band: BlockBand; blocks: Block[] }> {
  const rows: Array<{ band: BlockBand; blocks: Block[]; end: number }> = [];
  for (const block of [...blocks].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x)) {
    const previous = rows.at(-1);
    const value = 'band' in block ? (block.band ?? 'none') : 'none';
    if (previous && block.place.y < previous.end) {
      previous.blocks.push(block);
      previous.end = Math.max(previous.end, block.place.y + block.place.h);
      if (previous.band !== value) previous.band = 'none';
    } else rows.push({ band: value, blocks: [block], end: block.place.y + block.place.h });
  }
  const groups: typeof rows = [];
  for (const row of rows) {
    const previous = groups.at(-1);
    if (previous && previous.band === row.band && row.blocks[0]!.place.y === previous.end) {
      previous.blocks.push(...row.blocks);
      previous.end = row.end;
    } else groups.push(row);
  }
  return groups.map(({ band: value, blocks: items }) => ({ band: value, blocks: items }));
}
