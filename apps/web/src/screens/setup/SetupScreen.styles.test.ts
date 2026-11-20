import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('lets long account addresses wrap within the setup and sign-in layout', () => {
  const styles = readFileSync(join(import.meta.dirname, 'SetupScreen.css'), 'utf8');
  const layout = styles.match(/\.rio-setup\s*\{([^}]+)\}/)?.[1];
  // An unbroken address must contribute a small minimum width rather than widening the page.
  expect(layout).toMatch(/overflow-wrap:\s*anywhere/);
  expect(layout).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
});
