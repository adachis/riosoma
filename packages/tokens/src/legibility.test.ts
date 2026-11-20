import { describe, expect, it } from 'vitest';
import vectors from '../../../tools/legibility-vectors.json';
import { adjustForContrast, contrastRatio, legibleOn, mix } from './legibility';

const isHex = /^#[\da-f]{6}$/;

describe('shared legibility vectors', () => {
  it.each(vectors.adjust)('$id', ({ color, backgrounds, target, expected }) => {
    const result = adjustForContrast(color, backgrounds, target);
    expect(result).toBe(expected);
    if (result !== null) {
      expect(result).toMatch(isHex);
      for (const background of backgrounds)
        expect(contrastRatio(result, background)).toBeGreaterThanOrEqual(target);
      if (backgrounds.some((bg) => contrastRatio(color, bg) < target)) {
        for (const background of backgrounds)
          expect(contrastRatio(result, background)).toBeGreaterThanOrEqual(target + 0.1);
      }
    }
  });

  it.each(vectors.on)('$id', ({ fill, candidates, target, expected }) => {
    const result = legibleOn(fill, candidates, target);
    expect(result).toBe(expected);
    if (result !== null) {
      expect(result).toMatch(isHex);
      expect(contrastRatio(result, fill)).toBeGreaterThanOrEqual(target);
    }
  });
});

describe('WCAG contrast', () => {
  it('matches known luminance ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#777', '#fff')).toBeCloseTo(4.478, 3);
    expect(contrastRatio('#123456', '#123456')).toBe(1);
  });

  it.each(vectors.adjust)('is symmetric for $id', ({ color, backgrounds }) => {
    for (const background of backgrounds) {
      expect(contrastRatio(color, background)).toBe(contrastRatio(background, color));
    }
  });

  it('preserves a passing color even when it misses the adjustment margin', () => {
    expect(adjustForContrast('#767676', ['#ffffff'], 4.5)).toBe('#767676');
    expect(contrastRatio('#767676', '#ffffff')).toBeLessThan(4.6);
  });

  it('rejects invalid colors and targets', () => {
    for (const color of ['red', '#abcd', '#gggggg', '']) {
      expect(() => contrastRatio(color, '#ffffff')).toThrow(TypeError);
    }
    for (const target of [0, NaN, Infinity]) {
      expect(() => adjustForContrast('#777777', ['#ffffff'], target)).toThrow(RangeError);
      expect(() => legibleOn('#ffffff', [], target)).toThrow(RangeError);
    }
  });

  it('keeps varied gamut boundaries valid', () => {
    for (const r of [0, 51, 128, 204, 255]) {
      for (const g of [0, 51, 128, 204, 255]) {
        for (const b of [0, 51, 128, 204, 255]) {
          const color = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
          for (const background of ['#ffffff', '#111111']) {
            const result = adjustForContrast(color, [background], 4.5);
            expect(result).not.toBeNull();
            expect(result).toMatch(isHex);
            expect(contrastRatio(result!, background)).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    }
  });
});

describe('mix', () => {
  it('matches the endpoints and stays between them', () => {
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#ff0000');
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#0000ff');
    const middle = contrastRatio(mix('#000000', '#ffffff', 0.5), '#ffffff');
    expect(middle).toBeGreaterThan(1.5);
    expect(middle).toBeLessThan(15);
  });
});
