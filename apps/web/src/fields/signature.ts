import { LIMITS } from '@riosoma/contracts';

export interface Point {
  x: number;
  y: number;
}

/** One stroke as path data: a move to its first point, then lines by whole-pixel steps. */
function strokePath(stroke: readonly Point[], step: number): string {
  let x = Math.round(stroke[0]!.x);
  let y = Math.round(stroke[0]!.y);
  let lines = '';
  for (let index = step; index < stroke.length + step - 1; index += step) {
    const point = stroke[Math.min(index, stroke.length - 1)]!;
    const nextX = Math.round(point.x);
    const nextY = Math.round(point.y);
    if (nextX === x && nextY === y) continue;
    lines += `${lines ? ' ' : ''}${nextX - x} ${nextY - y}`;
    x = nextX;
    y = nextY;
  }
  // A tap is a dot, which a round line cap draws from a line of no length.
  return `M${Math.round(stroke[0]!.x)} ${Math.round(stroke[0]!.y)}l${lines || '0 0'}`;
}

/**
 * Compact SVG path data for a drawing: moves and relative lines in whole pixels.  A drawing too
 * long to store keeps every second point, then every fourth, until it fits.
 */
export function strokesPath(strokes: readonly (readonly Point[])[]): string {
  const drawn = strokes.filter((stroke) => stroke.length > 0);
  for (let step = 1; step <= 64; step *= 2) {
    const path = drawn.map((stroke) => strokePath(stroke, step)).join(' ');
    if (path.length <= LIMITS.signaturePathLength) return path;
  }
  // Nothing a person draws by hand runs this long, so a drawing that did is left out.
  return '';
}
