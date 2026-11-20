import { expect, it } from 'vitest';
import light from './fixtures/page-light.pgm?raw';
import dark from './fixtures/page-dark.pgm?raw';
import { detectEdges, perspective, validCorners, type Corners, type Raster } from './scan';

function fixture(source: string): Raster {
  const [, width, height, , ...pixels] = source.trim().split(/\s+/);
  const data = new Uint8ClampedArray(Number(width) * Number(height) * 4);
  pixels.forEach((value, i) => {
    data.fill(Number(value), i * 4, i * 4 + 3);
    data[i * 4 + 3] = 255;
  });
  return { width: Number(width), height: Number(height), data };
}

it.each([
  [
    light,
    [
      [12, 10],
      [82, 15],
      [77, 69],
      [17, 64],
    ],
  ],
  [
    dark,
    [
      [10, 14],
      [80, 9],
      [86, 64],
      [14, 70],
    ],
  ],
] as const)('detects a skewed page in a fixture with text and uneven brightness', (source, expected) => {
  const corners = detectEdges(fixture(source));
  corners.forEach((point, index) => {
    expect(Math.abs(point.x - expected[index]![0])).toBeLessThanOrEqual(2);
    expect(Math.abs(point.y - expected[index]![1])).toBeLessThanOrEqual(2);
  });
});

it('falls back to the whole photo when there is no detectable page', () => {
  const blank = fixture('P2 8 6 255 ' + Array(48).fill(125).join(' '));
  expect(detectEdges(blank)).toEqual([
    { x: 0, y: 0 },
    { x: 7, y: 0 },
    { x: 7, y: 5 },
    { x: 0, y: 5 },
  ]);
});

function gradient(): Raster {
  const image: Raster = { width: 100, height: 100, data: new Uint8ClampedArray(40000) };
  for (let y = 0; y < 100; y++)
    for (let x = 0; x < 100; x++) {
      const i = (y * 100 + x) * 4;
      image.data.set([x * 2, y * 2, 100, 255], i);
    }
  return image;
}

it('maps all four corners and the diagonal intersection through a true perspective transform', () => {
  const corners: Corners = [
    { x: 10, y: 10 },
    { x: 90, y: 20 },
    { x: 70, y: 80 },
    { x: 20, y: 80 },
  ];
  const result = perspective(gradient(), corners);
  const pixel = (x: number, y: number) => [
    ...result.data.slice((y * result.width + x) * 4, (y * result.width + x) * 4 + 3),
  ];
  expect(pixel(0, 0)).toEqual([20, 20, 100]);
  expect(pixel(result.width - 1, 0)).toEqual([180, 40, 100]);
  expect(pixel(result.width - 1, result.height - 1)).toEqual([140, 160, 100]);
  expect(pixel(0, result.height - 1)).toEqual([40, 160, 100]);
  // The diagonals intersect at (48.2, 54.5), rather than at the average corner position.
  const center = pixel(Math.floor(result.width / 2), Math.floor(result.height / 2));
  expect(Math.abs(center[0]! - 96.4)).toBeLessThan(3);
  expect(Math.abs(center[1]! - 109)).toBeLessThan(3);
});

it('produces opaque binary pixels in black-and-white mode and preserves color otherwise', () => {
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 99, y: 0 },
    { x: 99, y: 99 },
    { x: 0, y: 99 },
  ];
  const result = perspective(gradient(), corners, true);
  const tones = new Set<number>();
  for (let i = 0; i < result.data.length; i += 4) {
    tones.add(result.data[i]!);
    expect(result.data[i]).toBe(result.data[i + 1]);
    expect(result.data[i]).toBe(result.data[i + 2]);
    expect(result.data[i + 3]).toBe(255);
  }
  expect(tones).toEqual(new Set([0, 255]));
  expect(perspective(gradient(), corners).data[2]).toBe(100);
});

it('rejects crossing and collapsed corners before allocating a corrected image', () => {
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 80, y: 80 },
    { x: 80, y: 0 },
    { x: 0, y: 80 },
  ];
  expect(validCorners(corners)).toBe(false);
  expect(() => perspective(gradient(), corners)).toThrow('invalid scan corners');
  expect(
    validCorners([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]),
  ).toBe(false);
});
