import type { TilePlace } from '@riosoma/contracts';

/**
 * Tile placement on the dashboard's 12-column grid.  Tiles never overlap: whatever a moved or
 * resized tile lands on moves down below it, and a tile moved by the arrow keys trades places
 * with the neighbor it runs into, so the keys can carry a tile past any other.
 */
export const COLUMNS = 12;
export const MAX_HEIGHT = 12;
export const MAX_ROW = 1_000;

export type Place = TilePlace;

interface Placed {
  id: string;
  place: Place;
}

export function overlaps(a: Place, b: Place): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Keeps a place on the grid: at least one cell, no wider than the row, and never off the edge. */
export function clampPlace(place: Place): Place {
  const w = clamp(place.w, 1, COLUMNS);
  const h = clamp(place.h, 1, MAX_HEIGHT);
  return { x: clamp(place.x, 0, COLUMNS - w), y: clamp(place.y, 0, MAX_ROW), w, h };
}

/** The first spot, reading row by row from the top, where a tile of this size fits. */
export function firstFreeSpace(places: readonly Place[], w: number, h: number): Place {
  const size = clampPlace({ x: 0, y: 0, w, h });
  for (let y = 0; y <= MAX_ROW; y++)
    for (let x = 0; x + size.w <= COLUMNS; x++) {
      const candidate = { ...size, x, y };
      if (!places.some((place) => overlaps(place, candidate))) return candidate;
    }
  return size;
}

/** Tiles in reading order: by row, then by column, the order phones stack them in. */
export function readingOrder<T extends Placed>(tiles: readonly T[]): T[] {
  return [...tiles].sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x);
}

/**
 * Settles every tile that isn't fixed, in reading order, just below whatever settled tile it
 * overlaps.  Fixed tiles keep their places, and tiles that overlap nothing don't move.
 */
function settle(positions: Map<string, Place>, fixed: readonly string[]): void {
  const settled: Place[] = fixed.map((id) => positions.get(id)!);
  const rest = [...positions]
    .filter(([id]) => !fixed.includes(id))
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  for (const [id, start] of rest) {
    let place = start;
    for (let hit = settled.find((other) => overlaps(other, place)); hit;) {
      place = { ...place, y: hit.y + hit.h };
      hit = settled.find((other) => overlaps(other, place));
    }
    positions.set(id, place);
    settled.push(place);
  }
}

function apply<T extends Placed>(tiles: readonly T[], positions: ReadonlyMap<string, Place>): T[] {
  return tiles.map((tile) => {
    const place = positions.get(tile.id)!;
    const same =
      place.x === tile.place.x &&
      place.y === tile.place.y &&
      place.w === tile.place.w &&
      place.h === tile.place.h;
    return same ? tile : { ...tile, place };
  });
}

/** Puts one tile at a place, moving the tiles it lands on down below it. */
export function placeTile<T extends Placed>(tiles: readonly T[], id: string, place: Place): T[] {
  if (!tiles.some((tile) => tile.id === id)) return [...tiles];
  const positions = new Map(tiles.map((tile) => [tile.id, tile.place]));
  positions.set(id, clampPlace(place));
  settle(positions, [id]);
  return apply(tiles, positions);
}

/**
 * Moves a tile one cell.  Running into neighbors trades places with them: they take the tile's
 * old edge and the tile goes past them, so pressing an arrow always gets somewhere.
 */
export function nudgeTile<T extends Placed>(tiles: readonly T[], id: string, dx: number, dy: number): T[] {
  const tile = tiles.find((item) => item.id === id);
  if (!tile) return [...tiles];
  const from = tile.place;
  const target = clampPlace({ ...from, x: from.x + dx, y: from.y + dy });
  if (target.x === from.x && target.y === from.y) return [...tiles];
  const hits = tiles.filter((other) => other.id !== id && overlaps(other.place, target));
  if (!hits.length) return placeTile(tiles, id, target);
  const positions = new Map(tiles.map((item) => [item.id, item.place]));
  let moved: Place;
  if (dy > 0) {
    for (const hit of hits) positions.set(hit.id, { ...hit.place, y: from.y });
    moved = { ...from, y: from.y + Math.max(...hits.map((hit) => hit.place.h)) };
  } else if (dy < 0) {
    moved = { ...from, y: Math.min(...hits.map((hit) => hit.place.y)) };
    for (const hit of hits) positions.set(hit.id, { ...hit.place, y: hit.place.y + from.h });
  } else if (dx > 0) {
    for (const hit of hits) positions.set(hit.id, { ...hit.place, x: from.x });
    moved = { ...from, x: from.x + Math.max(...hits.map((hit) => hit.place.w)) };
  } else {
    moved = { ...from, x: Math.min(...hits.map((hit) => hit.place.x)) };
    for (const hit of hits) positions.set(hit.id, { ...hit.place, x: hit.place.x + from.w });
  }
  for (const hit of hits) positions.set(hit.id, clampPlace(positions.get(hit.id)!));
  positions.set(id, clampPlace(moved));
  // Neighbors traded in a column can still land on each other, so the tile settles first, then they do.
  settle(positions, [id]);
  return apply(tiles, positions);
}

/** Grows or shrinks a tile by one cell at its inline-end or bottom edge. */
export function resizeTile<T extends Placed>(tiles: readonly T[], id: string, dw: number, dh: number): T[] {
  const tile = tiles.find((item) => item.id === id);
  if (!tile) return [...tiles];
  const { place } = tile;
  const next = clampPlace({ ...place, w: Math.min(place.w + dw, COLUMNS - place.x), h: place.h + dh });
  if (next.w === place.w && next.h === place.h) return [...tiles];
  return placeTile(tiles, id, next);
}
