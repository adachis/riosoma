import type { IconDefinition } from '@riosoma/icons';
import {
  faArrowPointer,
  faChartColumn,
  faCode,
  faFilter,
  faFont,
  faHashtag,
  faIdCard,
  faList,
  faObjectGroup,
  faImage,
  faBullhorn,
} from '@fortawesome/free-solid-svg-icons';
import {
  INTERFACE_LIMITS,
  type Block,
  type BlockKind,
  type FieldMeta,
  type InterfacePage,
  type RecordsBlock,
} from '@riosoma/contracts';
import type { SchemaState } from '../../../data/types';

/** The icon for interfaces wherever they're listed */
export const INTERFACE_ICON = faObjectGroup;

export const KIND_ICONS: Record<BlockKind, IconDefinition> = {
  hero: faBullhorn,
  media: faImage,
  code: faCode,
  records: faList,
  record: faIdCard,
  number: faHashtag,
  chart: faChartColumn,
  text: faFont,
  filter: faFilter,
  button: faArrowPointer,
};

/** The size a new block of each kind starts at, in columns and rows */
export const BLOCK_SIZES: Record<BlockKind, { w: number; h: number }> = {
  hero: { w: 12, h: 5 },
  media: { w: 6, h: 4 },
  code: { w: 6, h: 4 },
  records: { w: 6, h: 5 },
  record: { w: 6, h: 5 },
  number: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  text: { w: 6, h: 1 },
  filter: { w: 3, h: 1 },
  button: { w: 3, h: 1 },
};

export const MAX_BLOCKS = INTERFACE_LIMITS.blocksPerPage;
export const MAX_PAGES = INTERFACE_LIMITS.pages;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function random(prefix: string): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${[...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}

/** A block ID, unique within its interface */
export const newBlockId = () => random('blk');
/** A page ID, unique within its interface */
export const newPageId = () => random('page');

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A block's settings without where it sits, which the page decides */
export type BlockContent = DistributiveOmit<Block, 'id' | 'place'>;

/** The records blocks on a page, which record and filter blocks can follow. */
export function recordsBlocks(page: Pick<InterfacePage, 'blocks'>): RecordsBlock[] {
  return page.blocks.filter((block): block is RecordsBlock => block.kind === 'records');
}

/** The records block a record block follows, when it's still on the page. */
export function followed(page: Pick<InterfacePage, 'blocks'>, recordsBlockId: string | null) {
  return recordsBlocks(page).find((block) => block.id === recordsBlockId);
}

/** The fields a record block shows: its chosen ones in order, or every field of the table. */
export function shownFields(
  schema: SchemaState,
  tableId: string,
  fieldIds: readonly string[],
): readonly FieldMeta[] {
  const fields = schema.fields.get(tableId) ?? [];
  if (!fieldIds.length) return fields;
  return fieldIds.flatMap((id) => fields.filter((field) => field.id === id));
}
