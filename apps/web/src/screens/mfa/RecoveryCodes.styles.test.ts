import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.each(['overlay', 'modal'])('keeps recovery-code %s contents opaque during transitions', (part) => {
  const styles = readFileSync(join(import.meta.dirname, 'mfa.css'), 'utf8');
  const rule = styles.match(/([^{}]*rio-mfa-codes-overlay[^{}]*)\{([^}]+)\}/);
  expect(rule?.[1] ?? '').toContain(`.rio-mfa-codes-${part}:is([data-entering], [data-exiting])`);
  expect(rule?.[2] ?? '').toMatch(/animation:\s*none/);
});
