import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHOICE_COLORS, type ChoiceColor } from '@riosoma/contracts';
import { contrastRatio, mix } from '@riosoma/tokens';

/**
 * Colored cells, rows, bars, and cards keep their text readable in the six themes the visual tests
 * use: text on every fill the colors draw passes WCAG AA (4.5:1), and every edge and mark stands out
 * at 3:1 against pages and cards.  The fills mirror colors.css and paint.ts: a cell tint is the
 * tier's `-soft` color, a record's row mixes it half and half with the page, and a scale mixes two
 * tints in OKLab.
 */
const ROOT = join(import.meta.dirname, '../../../../../..');
const THEMES: Array<{ theme: string; scheme?: string }> = [
  { theme: 'nature', scheme: 'grove' },
  { theme: 'nature', scheme: 'night-grove' },
  { theme: 'y2k' },
  { theme: 'bauhaus' },
  { theme: 'synthwave' },
  { theme: 'system-7' },
];

interface Manifest {
  defaultScheme: string;
  legibility: Record<string, Record<string, Record<string, string>>>;
}
type Rgba = [number, number, number, number];
type Baseline = Record<string, { schemes: Record<string, { default: Record<string, Rgba | string> }> }>;

const baseline = JSON.parse(readFileSync(join(ROOT, 'tools/semantic-baseline.json'), 'utf8')) as Baseline;
const toolbarCss = readFileSync(join(ROOT, 'apps/web/src/components/responsive-toolbar.css'), 'utf8');
const activeToolbar = toolbarCss.match(
  /\.rio-responsive-toolbar__button\[data-active\]\[data-variant='quiet'\]\s*\{([^}]+)\}/,
)![1]!;
const hex = (color: Rgba | string) =>
  typeof color === 'string'
    ? color
    : `#${color
        .slice(0, 3)
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('')}`;

function palette(theme: string, requested?: string) {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'themes', theme, 'theme.json'), 'utf8')) as Manifest;
  const scheme = requested ?? manifest.defaultScheme;
  const tier = manifest.legibility[scheme]!.default!;
  const page = baseline[theme]!.schemes[scheme]!.default;
  return {
    name: `${theme} ${scheme}`,
    text: tier['--rio-aa-choice-text']!,
    soft: (color: ChoiceColor) => tier[`--rio-aa-choice-${color}-soft`]!,
    line: (color: ChoiceColor) => tier[`--rio-aa-choice-${color}`]!,
    bg: hex(page.bg!),
    surface: hex(page.surface!),
    token: (name: string) => tier[name] ?? hex(page[name.replace('--rio-', '')]!),
  };
}

describe.each(THEMES.map(({ theme, scheme }) => palette(theme, scheme)))('$name', (theme) => {
  it('reads active toolbar labels and icons at 4.5:1 against their fill', () => {
    const foreground = activeToolbar.match(/(?:^|;)\s*color:\s*var\((--rio-[\w-]+)\)/)![1]!;
    const background = activeToolbar.match(/background:\s*var\((--rio-[\w-]+)\)/)![1]!;
    expect(foreground).toMatch(/^--rio-aa-/);
    expect(contrastRatio(theme.token(foreground), theme.token(background))).toBeGreaterThanOrEqual(4.5);
  });

  it('reads text at 4.5:1 on every cell tint and every record’s row tint', () => {
    for (const color of CHOICE_COLORS) {
      expect(contrastRatio(theme.text, theme.soft(color)), `${color} cell`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme.text, mix(theme.soft(color), theme.bg, 0.5)),
        `${color} row`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('reads text at 4.5:1 all along every color scale', () => {
    for (const from of CHOICE_COLORS)
      for (const to of CHOICE_COLORS)
        for (let step = 1; step < 10; step++) {
          const fill = mix(theme.soft(to), theme.soft(from), step / 10);
          expect(contrastRatio(theme.text, fill), `${from} to ${to} at ${step * 10}%`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
  });

  it('reads a data bar’s value at 4.5:1 beside the bar as well as on it', () => {
    expect(contrastRatio(theme.text, theme.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.text, theme.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('shows edges, marks, and bar ends at 3:1 against pages and cards', () => {
    for (const color of CHOICE_COLORS) {
      expect(contrastRatio(theme.line(color), theme.bg), `${color} on the page`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(theme.line(color), theme.surface), `${color} on a card`).toBeGreaterThanOrEqual(3);
    }
  });
});
