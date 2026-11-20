import { describe, expect, it } from 'vitest';
import { fitWindow, readWindowPosition } from './window-position';

describe('documentation window position', () => {
  it('keeps every edge in view after moving, resizing, or shrinking the browser', () => {
    expect(fitWindow({ x: -40, y: 900, width: 900, height: 800 }, { width: 800, height: 600 })).toEqual({
      x: 8,
      y: 8,
      width: 784,
      height: 584,
    });
    expect(fitWindow({ x: 700, y: 500, width: 500, height: 400 }, { width: 1000, height: 800 })).toEqual({
      x: 492,
      y: 392,
      width: 500,
      height: 400,
    });
  });

  it('enforces a readable minimum and uses the whole phone viewport', () => {
    expect(fitWindow({ x: 10, y: 20, width: 1, height: 1 }, { width: 1000, height: 800 })).toEqual({
      x: 10,
      y: 20,
      width: 360,
      height: 320,
    });
    expect(fitWindow({ x: 100, y: 200, width: 600, height: 500 }, { width: 390, height: 844 })).toEqual({
      x: 0,
      y: 0,
      width: 390,
      height: 844,
    });
  });

  it('rejects damaged stored positions without losing a usable window', () => {
    for (const value of ['invalid', '{}', '{"x":null,"y":2,"width":3,"height":4}'])
      expect(readWindowPosition(value, { width: 1000, height: 800 })).toEqual({
        x: 352,
        y: 48,
        width: 600,
        height: 640,
      });
    expect(
      readWindowPosition('{"x":20,"y":30,"width":500,"height":400}', { width: 1000, height: 800 }),
    ).toEqual({ x: 20, y: 30, width: 500, height: 400 });
  });
});
