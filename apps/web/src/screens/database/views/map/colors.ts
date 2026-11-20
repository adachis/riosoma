import { CHOICE_COLORS, type ChoiceColor } from '@riosoma/contracts';

/**
 * The colors a map draws with, read from the theme where the map sits, since the map draws on a
 * canvas that can't read CSS variables itself.
 */
export interface MapColors {
  choices: Record<ChoiceColor, string>;
  /** Pins without a color, and clusters */
  accent: string;
  /** A cluster's count, on the accent */
  onAccent: string;
  /** The ring around each pin */
  ring: string;
}

/** What the map draws with before the theme is read, and in tests. */
export const FALLBACK_COLORS: MapColors = {
  choices: {
    gray: '#7c7c7c',
    red: '#e5484d',
    orange: '#d9731a',
    yellow: '#b88a00',
    green: '#2f9e44',
    teal: '#0f9a8f',
    blue: '#3b82f6',
    purple: '#9b59d0',
    pink: '#d6409f',
    brown: '#9c6b3f',
  },
  accent: '#2f6b4f',
  onAccent: '#ffffff',
  ring: '#ffffff',
};

let canvas: CanvasRenderingContext2D | null | undefined;

/** A computed color as `rgb()`, which the map understands, even when the theme uses `oklch()`. */
function toRgb(color: string): string | null {
  if (!color) return null;
  if (/^rgba?\(/.test(color)) return color;
  if (canvas === undefined) {
    try {
      const element = document.createElement('canvas');
      element.width = element.height = 1;
      canvas = element.getContext('2d', { willReadFrequently: true });
    } catch {
      canvas = null;
    }
  }
  if (!canvas) return null;
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b] = canvas.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

export function readMapColors(element: HTMLElement): MapColors {
  const probe = document.createElement('span');
  probe.hidden = true;
  element.append(probe);
  try {
    const read = (variable: string, fallback: string) => {
      probe.style.color = '';
      probe.style.color = `var(${variable})`;
      return toRgb(getComputedStyle(probe).color) || fallback;
    };
    const choices = { ...FALLBACK_COLORS.choices };
    for (const color of CHOICE_COLORS) choices[color] = read(`--rio-aa-choice-${color}`, choices[color]);
    return {
      choices,
      accent: read('--rio-accent', FALLBACK_COLORS.accent),
      onAccent: read('--rio-aa-on-accent', FALLBACK_COLORS.onAccent),
      ring: read('--rio-surface', FALLBACK_COLORS.ring),
    };
  } finally {
    probe.remove();
  }
}
