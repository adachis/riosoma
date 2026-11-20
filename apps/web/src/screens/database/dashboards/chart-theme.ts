/**
 * Chart colors come from the theme's variables, read where the chart sits, so a nested color
 * scheme applies and every theme and scheme gets charts in its own colors.  The accent leads, and
 * the legible choice colors follow, since they stay readable against the page in every scheme.
 */
export interface ChartTheme {
  palette: string[];
  text: string;
  muted: string;
  border: string;
  surface: string;
  font: string;
}

const SERIES = [
  '--rio-accent',
  '--rio-aa-choice-blue',
  '--rio-aa-choice-orange',
  '--rio-aa-choice-green',
  '--rio-aa-choice-purple',
  '--rio-aa-choice-red',
  '--rio-aa-choice-teal',
  '--rio-aa-choice-pink',
  '--rio-aa-choice-yellow',
  '--rio-aa-choice-brown',
  '--rio-aa-choice-gray',
] as const;

/** What charts draw with before a theme loads, and in tests */
export const FALLBACK_THEME: ChartTheme = {
  palette: [
    '#2f6b4f',
    '#3b82f6',
    '#d9731a',
    '#2f9e44',
    '#9b59d0',
    '#e5484d',
    '#0f9a8f',
    '#d6409f',
    '#b88a00',
    '#9c6b3f',
    '#7c7c7c',
  ],
  text: '#1d1d1b',
  muted: '#5c5c57',
  border: '#d9d9d3',
  surface: '#ffffff',
  font: 'system-ui, sans-serif',
};

let canvas: CanvasRenderingContext2D | null | undefined;

/**
 * A computed CSS color as `rgb()` or `rgba()`, which the chart library can blend for hover
 * states.  Colors outside sRGB, like `oklch()`, go through a one-pixel canvas.
 */
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
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${((a ?? 0) / 255).toFixed(3)})`;
}

export function readChartTheme(element: HTMLElement): ChartTheme {
  const probe = document.createElement('span');
  probe.hidden = true;
  element.append(probe);
  try {
    const read = (variable: string, fallback: string) => {
      probe.style.color = '';
      probe.style.color = `var(${variable})`;
      const value = getComputedStyle(probe).color;
      return (value && toRgb(value)) || fallback;
    };
    return {
      palette: SERIES.map((variable, index) => read(variable, FALLBACK_THEME.palette[index]!)),
      text: read('--rio-text', FALLBACK_THEME.text),
      muted: read('--rio-aa-text-muted', FALLBACK_THEME.muted),
      border: read('--rio-border', FALLBACK_THEME.border),
      surface: read('--rio-surface', FALLBACK_THEME.surface),
      font: getComputedStyle(element).fontFamily || FALLBACK_THEME.font,
    };
  } finally {
    probe.remove();
  }
}

/** Calls back when the page's theme, color scheme, or mode changes. */
export function watchTheme(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-scheme', 'data-mode', 'data-surface', 'style'],
  });
  return () => observer.disconnect();
}
