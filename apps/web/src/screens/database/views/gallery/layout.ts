import type { GallerySettings } from '@riosoma/contracts';

export const GAP = 16;
export const PADDING = 16;
const WIDTHS = { small: 180, medium: 260, large: 360 };
export const COVER_HEIGHTS = { small: 120, medium: 164, large: 220 };

export function galleryLayout(width: number, size: GallerySettings['cardSize'], fields: number) {
  const columns = Math.max(1, Math.floor((width - 2 * PADDING + GAP) / (WIDTHS[size] + GAP)));
  const cardHeight = COVER_HEIGHTS[size] + 68 + fields * 44;
  return { columns, cardHeight, stride: cardHeight + GAP };
}

export function visibleRows(scroll: number, height: number, stride: number, total: number) {
  const start = Math.min(total, Math.max(0, Math.floor((scroll - PADDING) / stride)));
  const end = Math.min(total, Math.max(start, Math.ceil((scroll + height - PADDING) / stride)));
  return { start, end };
}
