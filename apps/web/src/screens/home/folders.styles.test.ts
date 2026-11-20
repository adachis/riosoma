import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'folders.css'), 'utf8');

it('wraps the file links on a phone instead of scrolling the page sideways', () => {
  const phone = css.slice(css.lastIndexOf('.rio-home-files__sidebar {'));
  expect(phone).toContain('flex-wrap: wrap');
  expect(phone).not.toContain('overflow-x: auto');
});
