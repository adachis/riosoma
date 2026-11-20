import type { CelebrationSize } from './registry';

/**
 * A small particle system for confetti and sparkles, drawn on one canvas.  Every particle lives
 * less than the longest a celebration may last, and nothing is ever drawn inside the boxes it is
 * told to keep clear, such as the field someone is typing in.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Particle {
  x: number;
  y: number;
  /** Pixels a second */
  vx: number;
  vy: number;
  /** Radians, and radians a second */
  angle: number;
  spin: number;
  /** How far through a flip the ribbon is, which makes it flutter */
  flip: number;
  size: number;
  color: string;
  shape: 'ribbon' | 'dot' | 'sparkle';
  /** Seconds lived, seconds to wait before appearing, and seconds to live */
  age: number;
  delay: number;
  life: number;
  /** Pixels a second squared */
  gravity: number;
}

/** The longest any celebration lasts, start to finish */
export const CELEBRATION_MS = 1400;
const MAX_SECONDS = CELEBRATION_MS / 1000;

type Random = () => number;

const between = (random: Random, low: number, high: number) => low + (high - low) * random();

/** Keeps a particle's wait and life inside the celebration's time. */
function fit(delay: number, life: number): { delay: number; life: number } {
  const wait = Math.min(delay, MAX_SECONDS / 3);
  return { delay: wait, life: Math.min(life, MAX_SECONDS - wait) };
}

export interface BurstOptions {
  x: number;
  y: number;
  count: number;
  colors: readonly string[];
  /** The direction the burst aims, in radians, with 0 straight up and positive toward the right */
  direction: number;
  /** How wide the burst fans, in radians */
  spread: number;
  speed: readonly [number, number];
  life: readonly [number, number];
  random?: Random;
}

/** Confetti thrown from one point. */
export function burst(options: BurstOptions): Particle[] {
  const random = options.random ?? Math.random;
  const colors = options.colors.length ? options.colors : ['currentColor'];
  return Array.from({ length: options.count }, (_, index) => {
    const aim = options.direction + (random() - 0.5) * options.spread;
    const speed = between(random, options.speed[0], options.speed[1]);
    const shape = random() < 0.7 ? 'ribbon' : 'dot';
    return {
      x: options.x,
      y: options.y,
      vx: Math.sin(aim) * speed,
      vy: -Math.cos(aim) * speed,
      angle: random() * Math.PI * 2,
      spin: between(random, -10, 10),
      flip: random() * Math.PI * 2,
      size: shape === 'ribbon' ? between(random, 7, 12) : between(random, 3, 5),
      color: colors[index % colors.length]!,
      shape,
      age: 0,
      gravity: 1100,
      ...fit(random() * 0.06, between(random, options.life[0], options.life[1])),
    };
  });
}

/** Little four-pointed stars just outside a box's edges, which twinkle in turn and don't move. */
export function sparkles(
  box: Box,
  colors: readonly string[],
  options: { count?: number; random?: Random } = {},
): Particle[] {
  const random = options.random ?? Math.random;
  const count = options.count ?? 8;
  const palette = colors.length ? colors : ['currentColor'];
  const gap = 6;
  const perimeter = 2 * (box.width + box.height + 4 * gap);
  return Array.from({ length: count }, (_, index) => {
    // Evenly around the outline, nudged a little so they don't look like a pattern.
    let along = ((index + between(random, -0.25, 0.25)) / count) * perimeter;
    const across = box.width + 2 * gap;
    const down = box.height + 2 * gap;
    let x: number;
    let y: number;
    if (along < across) {
      x = box.left - gap + along;
      y = box.top - gap;
    } else if ((along -= across) < down) {
      x = box.left + box.width + gap;
      y = box.top - gap + along;
    } else if ((along -= down) < across) {
      x = box.left + box.width + gap - along;
      y = box.top + box.height + gap;
    } else {
      along -= across;
      x = box.left - gap;
      y = box.top + box.height + gap - Math.min(along, down);
    }
    return {
      x,
      y,
      vx: 0,
      vy: 0,
      angle: random() * 0.6,
      spin: 0,
      flip: 0,
      size: between(random, 5, 8),
      color: palette[index % palette.length]!,
      shape: 'sparkle' as const,
      age: 0,
      gravity: 0,
      ...fit((index / count) * 0.25, between(random, 0.5, 0.7)),
    };
  });
}

/** The particles for one celebration, sized to the viewport and starting from its element. */
export function particlesFor(
  size: CelebrationSize,
  anchor: Box | null,
  viewport: { width: number; height: number },
  colors: readonly string[],
  random: () => number = Math.random,
): Particle[] {
  const { width, height } = viewport;
  const center = anchor
    ? { x: anchor.left + anchor.width / 2, y: anchor.top + anchor.height / 2 }
    : { x: width / 2, y: height / 3 };
  if (size === 'small') {
    const box = anchor ?? { left: center.x - 16, top: center.y - 16, width: 32, height: 32 };
    return sparkles(box, colors, { random });
  }
  if (size === 'medium')
    return burst({
      ...center,
      count: 56,
      colors,
      direction: 0,
      spread: 1.5,
      speed: [360, 700],
      life: [0.9, 1.25],
      random,
    });
  const side = { count: 70, colors, spread: 0.7, speed: [950, 1450] as const, life: [1.1, 1.35] as const };
  return [
    ...burst({ ...side, x: width * 0.08, y: height + 8, direction: 0.5, random }),
    ...burst({ ...side, x: width * 0.92, y: height + 8, direction: -0.5, random }),
    ...(anchor
      ? burst({
          ...center,
          count: 36,
          colors,
          direction: 0,
          spread: 1.6,
          speed: [320, 620],
          life: [0.9, 1.2],
          random,
        })
      : []),
  ];
}
