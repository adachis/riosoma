import { describe, expect, it } from 'vitest';
import { alignScroll, createScrollMap, MAX_NATIVE_SIZE } from './scroll.js';

describe('content and native scroll mapping', () => {
  it.each([0, 32, 3200, 8_000_000, 32_000_000])(
    'round trips a %i pixel document including its edges',
    (size) => {
      const map = createScrollMap(size, 640);
      expect(map.nativeSize).toBeLessThanOrEqual(MAX_NATIVE_SIZE);
      expect(map.toContent(map.nativeRange)).toBe(map.contentRange);
      expect(map.toNative(map.contentRange)).toBe(map.nativeRange);
      for (const ratio of [0, 0.0001, 0.125, 0.5, 0.99999, 1]) {
        const content = map.contentRange * ratio;
        const native = map.nativeRange * ratio;
        expect(map.toContent(map.toNative(content))).toBeCloseTo(content, 6);
        expect(map.toNative(map.toContent(native))).toBeCloseTo(native, 6);
      }
      expect(map.toContent(-100)).toBe(0);
      expect(map.toNative(-100)).toBe(0);
      expect(map.toContent(Infinity)).toBe(map.contentRange);
      expect(map.toNative(Infinity)).toBe(map.nativeRange);
    },
  );

  it('keeps short documents one to one and fractional content positions precise', () => {
    expect(createScrollMap(1000, 640).scale).toBe(1);
    const map = createScrollMap(32_000_000, 640);
    expect(map.toContent(map.toNative(32.125))).toBe(32.125);
    expect(map.nativeSize).toBe(8_000_000);
    expect(map.toContent(map.nativeRange)).toBe(31_999_360);
  });

  it('handles a viewport larger than the document or cap', () => {
    const map = createScrollMap(100, 500, 200);
    expect(map.nativeSize).toBe(500);
    expect(map.contentRange).toBe(0);
    expect(map.toContent(100)).toBe(0);
  });
});

describe('cell alignment', () => {
  it('preserves visible cells and minimally reveals clipped cells', () => {
    expect(alignScroll(32, 64, 32, 96, 'nearest')).toBe(32);
    expect(alignScroll(32, 0, 32, 96, 'nearest')).toBe(0);
    expect(alignScroll(32, 128, 32, 96, 'nearest')).toBe(64);
    expect(alignScroll(32, 64, 200, 96, 'nearest')).toBe(64);
  });
  it('aligns starts and centers', () => {
    expect(alignScroll(0, 320, 32, 96, 'start')).toBe(320);
    expect(alignScroll(0, 320, 32, 96, 'center')).toBe(288);
  });
});
