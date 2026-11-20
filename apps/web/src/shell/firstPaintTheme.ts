import type { ThemeChoice } from '@riosoma/tokens';
import { themes } from '../preferences';

/** Font swaps can wrap a toolbar, so resolve its text metrics before the first controls appear. */
export async function firstPaintTheme(choice: ThemeChoice, fonts = document.fonts): Promise<void> {
  await themes.apply(choice).catch(() => undefined);
  const style = getComputedStyle(document.documentElement);
  const families = new Set(
    ['--rio-font-body', '--rio-font-display', '--rio-font-mono']
      .map((property) => style.getPropertyValue(property).trim())
      .filter(Boolean),
  );
  await Promise.all(
    [...families].flatMap((family) =>
      [400, 500, 700].map((weight) => fonts.load(`${weight} 1rem ${family}`).catch(() => [])),
    ),
  );
}
