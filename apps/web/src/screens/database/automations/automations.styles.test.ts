import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'automations.css'), 'utf8');

it('colors the canvas hint with the contrast-safe muted text variable', () => {
  const rule = /\.rio-automation-canvas__hint\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  expect(rule).toContain('var(--rio-aa-text-muted)');
});
