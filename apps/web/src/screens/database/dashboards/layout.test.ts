import { describe, expect, it } from 'vitest';
import {
  clampPlace,
  firstFreeSpace,
  nudgeTile,
  overlaps,
  placeTile,
  readingOrder,
  resizeTile,
  type Place,
} from './layout';

const tile = (id: string, x: number, y: number, w: number, h: number) => ({ id, place: { x, y, w, h } });
const places = (tiles: ReadonlyArray<{ id: string; place: Place }>) =>
  Object.fromEntries(tiles.map((item) => [item.id, item.place]));
function valid(tiles: ReadonlyArray<{ id: string; place: Place }>): boolean {
  return tiles.every(
    (a, index) =>
      a.place.x >= 0 &&
      a.place.x + a.place.w <= 12 &&
      tiles.slice(index + 1).every((b) => !overlaps(a.place, b.place)),
  );
}

describe('dashboard layout', () => {
  it('keeps places on the grid', () => {
    expect(clampPlace({ x: 10, y: -3, w: 4, h: 20 })).toEqual({ x: 8, y: 0, w: 4, h: 12 });
    expect(clampPlace({ x: -1, y: 2, w: 0, h: 0 })).toEqual({ x: 0, y: 2, w: 1, h: 1 });
  });

  it('puts new tiles in the first free space, reading row by row', () => {
    expect(firstFreeSpace([], 6, 4)).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    const taken = [tile('a', 0, 0, 6, 4).place, tile('b', 6, 0, 3, 2).place];
    expect(firstFreeSpace(taken, 3, 2)).toEqual({ x: 9, y: 0, w: 3, h: 2 });
    expect(firstFreeSpace(taken, 4, 2)).toEqual({ x: 6, y: 2, w: 4, h: 2 });
    expect(firstFreeSpace([...taken, tile('c', 9, 0, 3, 4).place], 12, 1)).toEqual({
      x: 0,
      y: 4,
      w: 12,
      h: 1,
    });
  });

  it('orders tiles by row, then column', () => {
    const tiles = [tile('c', 0, 3, 1, 1), tile('b', 6, 0, 1, 1), tile('a', 0, 0, 1, 1)];
    expect(readingOrder(tiles).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('pushes the tiles a placed tile lands on down below it, and leaves the rest alone', () => {
    const tiles = [
      tile('a', 0, 0, 6, 2),
      tile('b', 0, 2, 6, 2),
      tile('c', 6, 0, 6, 2),
      tile('d', 0, 4, 12, 1),
    ];
    const next = placeTile(tiles, 'c', { x: 0, y: 1, w: 12, h: 2 });
    expect(places(next)).toEqual({
      a: { x: 0, y: 3, w: 6, h: 2 },
      b: { x: 0, y: 5, w: 6, h: 2 },
      c: { x: 0, y: 1, w: 12, h: 2 },
      d: { x: 0, y: 7, w: 12, h: 1 },
    });
    expect(valid(next)).toBe(true);
    const still = placeTile(tiles, 'd', { x: 0, y: 6, w: 12, h: 1 });
    expect(still[0]).toBe(tiles[0]);
    expect(still[3]!.place).toEqual({ x: 0, y: 6, w: 12, h: 1 });
  });

  it('moves a tile one cell with the arrow keys and trades places with the neighbor it meets', () => {
    const tiles = [tile('a', 0, 0, 6, 2), tile('b', 0, 2, 6, 3), tile('c', 6, 0, 6, 2)];
    expect(places(nudgeTile(tiles, 'a', 0, 1))).toMatchObject({
      a: { x: 0, y: 3 },
      b: { x: 0, y: 0 },
    });
    expect(places(nudgeTile(tiles, 'b', 0, -1))).toMatchObject({
      a: { x: 0, y: 3 },
      b: { x: 0, y: 0 },
    });
    expect(places(nudgeTile(tiles, 'a', 1, 0))).toMatchObject({
      a: { x: 6, y: 0 },
      c: { x: 0, y: 0 },
    });
    expect(places(nudgeTile(tiles, 'c', -1, 0))).toMatchObject({
      a: { x: 6, y: 0 },
      c: { x: 0, y: 0 },
    });
    expect(places(nudgeTile(tiles, 'b', 1, 0))).toMatchObject({ b: { x: 1, y: 2 } });
    expect(places(nudgeTile([tile('a', 0, 0, 4, 2)], 'a', 0, 1))).toEqual({ a: { x: 0, y: 1, w: 4, h: 2 } });
    for (const [dx, dy] of [
      [0, 1],
      [0, -1],
      [1, 0],
      [-1, 0],
    ] as const)
      for (const item of tiles) expect(valid(nudgeTile(tiles, item.id, dx, dy))).toBe(true);
  });

  it('stays put at the edges', () => {
    const tiles = [tile('a', 0, 0, 12, 2)];
    expect(nudgeTile(tiles, 'a', -1, 0)[0]!.place).toEqual(tiles[0]!.place);
    expect(nudgeTile(tiles, 'a', 1, 0)[0]!.place).toEqual(tiles[0]!.place);
    expect(nudgeTile(tiles, 'a', 0, -1)[0]!.place).toEqual(tiles[0]!.place);
    expect(resizeTile(tiles, 'a', 1, 0)[0]!.place).toEqual(tiles[0]!.place);
    expect(resizeTile([tile('a', 0, 0, 1, 1)], 'a', -1, -1)[0]!.place).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('resizes from the inline-end and bottom edges, pushing what it grows into', () => {
    const tiles = [tile('a', 0, 0, 3, 2), tile('b', 3, 0, 3, 2), tile('c', 0, 2, 3, 2)];
    expect(places(resizeTile(tiles, 'a', 1, 0))).toMatchObject({
      a: { x: 0, y: 0, w: 4, h: 2 },
      b: { x: 3, y: 2 },
      c: { x: 0, y: 2 },
    });
    const taller = resizeTile(tiles, 'a', 0, 1);
    expect(places(taller)).toMatchObject({ a: { w: 3, h: 3 }, c: { y: 3 } });
    expect(valid(taller)).toBe(true);
    expect(places(resizeTile(tiles, 'b', -1, -1))).toMatchObject({ b: { x: 3, y: 0, w: 2, h: 1 } });
  });
});
