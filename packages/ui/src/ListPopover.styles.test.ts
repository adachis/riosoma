import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'ListPopover.css'), 'utf8');
const surface = /\.rio-list-popover \{([^}]*)\}/.exec(css)?.[1] ?? '';

it('sizes list surfaces from their contents and caps them inside the viewport', () => {
  expect(surface).toContain('inline-size: max-content');
  expect(surface).toMatch(/max-inline-size:\s*calc\(\s*100dvi - var\(--rio-space-4\)/);
  expect(surface).toContain('env(safe-area-inset-left) - env(safe-area-inset-right)');
});
