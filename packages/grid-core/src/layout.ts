import { clamp } from './scroll.js';
import type { GridColumn } from './types.js';

export interface IndexRange {
  start: number;
  end: number;
}

export function prefixWidths(columns: readonly Pick<GridColumn, 'width'>[]): number[] {
  const result = [0];
  let width = 0;
  for (const column of columns) {
    width += Math.max(0, column.width);
    result.push(width);
  }
  return result;
}

function bound(values: readonly number[], value: number, upper: boolean): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! < value || (upper && values[mid] === value)) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function visibleRows(
  count: number,
  height: number,
  scroll: number,
  size: number,
  margin = 0,
): IndexRange {
  if (size <= 0 || count === 0) return { start: 0, end: 0 };
  return {
    start: clamp(Math.floor(scroll / height) - margin, 0, count),
    end: clamp(Math.ceil((scroll + size) / height) + margin, 0, count),
  };
}

export function visibleColumns(
  prefix: readonly number[],
  scroll: number,
  size: number,
  margin = 0,
  minimum = 0,
  maximum = prefix.length - 1,
): IndexRange {
  if (size <= 0 || minimum >= maximum) return { start: minimum, end: minimum };
  const start = clamp(bound(prefix, scroll, true) - 1, minimum, maximum);
  const end = clamp(bound(prefix, scroll + size, false), minimum, maximum);
  return { start: Math.max(minimum, start - margin), end: Math.min(maximum, end + margin) };
}

export function frozenCount(
  count: number,
  columns: number,
  prefix?: readonly number[],
  availableWidth = Infinity,
): number {
  let frozen = clamp(Math.floor(count), 0, columns);
  // A frozen section that fills the viewport leaves no way to reach scrolling fields.
  while (frozen > 0 && prefix && prefix[frozen]! >= availableWidth) frozen--;
  return frozen;
}

export function columnDestination(from: number, slot: number, count: number, frozen: number): number {
  const boundary = frozenCount(frozen, count);
  const destination = slot > from ? slot - 1 : slot;
  return from < boundary ? clamp(destination, 0, boundary - 1) : clamp(destination, boundary, count - 1);
}

export function inlineOffset(position: number, direction: 'ltr' | 'rtl'): number {
  return direction === 'rtl' ? -position : position;
}

export function logicalPoint(clientX: number, left: number, width: number, direction: 'ltr' | 'rtl'): number {
  return direction === 'rtl' ? left + width - clientX : clientX - left;
}
