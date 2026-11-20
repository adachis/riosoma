import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLATFORM_REPORT_MESSAGES } from './reportMessages';

const SERVER = join(import.meta.dirname, '../../../../../server/src/data/imports');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Report keys the imports from other tools can write, from their source. */
function reportKeys(): string[] {
  const keys = new Set<string>();
  for (const file of [...sources(join(SERVER, 'platforms')), ...sources(join(SERVER, 'core'))])
    for (const match of readFileSync(file, 'utf8').matchAll(/'(import\.platform\.report\.[A-Za-z]+)'/g))
      keys.add(match[1]!);
  return [...keys].sort();
}

describe('platform import report messages', () => {
  it('have text for every line the server can write', () => {
    const keys = reportKeys();
    // Without the server's own keys the check would pass while reading nothing.
    expect(keys).toContain('import.platform.report.viewsNeedSignIn');
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((key) => !PLATFORM_REPORT_MESSAGES[key])).toEqual([]);
  });

  it('use their keys as their IDs', () => {
    expect(
      Object.entries(PLATFORM_REPORT_MESSAGES).filter(([key, descriptor]) => descriptor.id !== key),
    ).toEqual([]);
  });
});
