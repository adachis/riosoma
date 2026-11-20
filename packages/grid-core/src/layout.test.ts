import { describe, expect, it } from 'vitest';
import {
  columnDestination,
  frozenCount,
  inlineOffset,
  logicalPoint,
  prefixWidths,
  visibleColumns,
  visibleRows,
} from './layout.js';

describe('row windows', () => {
  it('uses exclusive ends and includes partial rows', () => {
    expect(visibleRows(100, 32, 0, 64)).toEqual({ start: 0, end: 2 });
    expect(visibleRows(100, 32, 0.25, 64)).toEqual({ start: 0, end: 3 });
    expect(visibleRows(100, 32, 64, 64, 2)).toEqual({ start: 0, end: 6 });
    expect(visibleRows(1_000_000, 32, 31_999_936, 64, 2)).toEqual({ start: 999_996, end: 1_000_000 });
  });
  it('handles empty or hidden grids', () => {
    expect(visibleRows(0, 32, 0, 64)).toEqual({ start: 0, end: 0 });
    expect(visibleRows(100, 32, 0, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe('column windows', () => {
  const prefix = prefixWidths([{ width: 60 }, { width: 140 }, { width: 80 }, { width: 200 }]);
  it('builds prefix sums including the final edge', () => {
    expect(prefix).toEqual([0, 60, 200, 280, 480]);
    expect(prefixWidths([])).toEqual([0]);
  });
  it('finds exact, partial, and overscanned windows', () => {
    expect(visibleColumns(prefix, 60, 140)).toEqual({ start: 1, end: 2 });
    expect(visibleColumns(prefix, 60.5, 140)).toEqual({ start: 1, end: 3 });
    expect(visibleColumns(prefix, 200, 80, 1)).toEqual({ start: 1, end: 4 });
    expect(visibleColumns(prefix, 480, 0)).toEqual({ start: 0, end: 0 });
    expect(visibleColumns([0], 0, 100)).toEqual({ start: 0, end: 0 });
  });
  it('keeps frozen and scrolling ranges separate, even when frozen columns fill the viewport', () => {
    expect(visibleColumns(prefix, 0, 100, 1, 0, 2)).toEqual({ start: 0, end: 2 });
    expect(visibleColumns(prefix, 280, 100, 1, 2)).toEqual({ start: 2, end: 4 });
    expect(visibleColumns(prefix, 200, 0, 1, 2)).toEqual({ start: 2, end: 2 });
  });
});

describe('frozen boundaries and mirroring', () => {
  it('clamps frozen counts and keeps moves within their group', () => {
    expect(frozenCount(20, 4)).toBe(4);
    expect(frozenCount(-1, 4)).toBe(0);
    expect(columnDestination(0, 4, 4, 2)).toBe(1);
    expect(columnDestination(3, 0, 4, 2)).toBe(2);
    expect(columnDestination(1, 4, 4, 0)).toBe(3);
    expect(columnDestination(3, 1, 4, 0)).toBe(1);
  });
  it('keeps columns reachable when a frozen field fills a narrow viewport', () => {
    const widths = [0, 240, 400, 560];
    expect(frozenCount(1, 3, widths, 236)).toBe(0);
    expect(frozenCount(1, 3, widths, 240)).toBe(0);
    expect(frozenCount(2, 3, widths, 300)).toBe(1);
    expect(frozenCount(2, 3, widths, 480)).toBe(2);
    expect(frozenCount(3, 3, widths, 600)).toBe(3);
    expect(frozenCount(1, 3, widths, 0)).toBe(0);
  });
  it('mirrors logical coordinates without changing column order', () => {
    expect(inlineOffset(75.5, 'ltr')).toBe(75.5);
    expect(inlineOffset(75.5, 'rtl')).toBe(-75.5);
    expect(logicalPoint(40, 10, 100, 'ltr')).toBe(30);
    expect(logicalPoint(80, 10, 100, 'rtl')).toBe(30);
    expect(inlineOffset(inlineOffset(123, 'rtl'), 'rtl')).toBe(123);
  });
});
