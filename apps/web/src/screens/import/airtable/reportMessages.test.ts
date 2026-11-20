import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROLLUP_FUNCTIONS } from '@riosoma/contracts';
import { REPORT_MESSAGES, ROLLUP_NAMES } from './reportMessages';

const SERVER = join(import.meta.dirname, '../../../../../server/src/data/imports/airtable');

/** Report keys the import can write, from its source. */
function reportKeys(): string[] {
  const keys = new Set<string>();
  for (const name of readdirSync(SERVER)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const text = readFileSync(join(SERVER, name), 'utf8');
    for (const match of text.matchAll(/'(import\.airtable\.report\.[A-Za-z]+)'/g)) keys.add(match[1]!);
  }
  return [...keys].sort();
}

describe('Airtable import report messages', () => {
  it('have text for every line the server can write', () => {
    const keys = reportKeys();
    // Without the server's own keys the check would pass while reading nothing.
    expect(keys).toContain('import.airtable.report.formulaFunctions');
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((key) => !REPORT_MESSAGES[key])).toEqual([]);
  });

  it('use their keys as their IDs', () => {
    expect(Object.entries(REPORT_MESSAGES).filter(([key, descriptor]) => descriptor.id !== key)).toEqual([]);
  });

  it('name every rollup function', () => {
    expect(ROLLUP_FUNCTIONS.filter((fn) => !ROLLUP_NAMES[fn])).toEqual([]);
  });
});
