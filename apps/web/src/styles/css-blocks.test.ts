import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../../..');
const FOLDERS = ['packages/ui/src', 'apps/web/src', 'packages/grid-core/src'];

/** Blocks that one folder styles on purpose for another's elements. */
const SHARED = new Set([
  // Attachment editors build on the cell editors' popover.
  'rio-cell-editor',
  // Attachment previews and the editors draw inside the grid's cells.
  'rio-cell-value',
  // The app's cell styles extend the grid engine's.
  'rio-grid',
]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

describe('styles', () => {
  it('take every type size from the tokens', () => {
    const literal: string[] = [];
    for (const folder of FOLDERS) {
      for (const file of cssFiles(join(ROOT, folder))) {
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const match of text.matchAll(/font-size:\s*([^;}]+)/g)) {
          const value = match[1]!.trim();
          // A fluid size may still be built from tokens, so only a literal size is a finding.
          if (!/[0-9](px|pt|pc|rem|em)\b/.test(value)) continue;
          literal.push(`${relative(ROOT, file)}: ${value}`);
        }
      }
    }
    expect(literal).toEqual([]);
  });

  it('give every class block one home, so two parts never style each other by accident', () => {
    const owners = new Map<string, Set<string>>();
    for (const folder of FOLDERS) {
      for (const file of cssFiles(join(ROOT, folder))) {
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const rule of text.matchAll(/([^{}]+)\{/g)) {
          for (const selector of rule[1]!.split(',')) {
            const block = /^\s*\.(rio-[a-z0-9-]+?)(?:__|--|[\s:.[>+~]|$)/.exec(selector)?.[1];
            if (!block || SHARED.has(block)) continue;
            const set = owners.get(block) ?? new Set<string>();
            set.add(relative(ROOT, dirname(file)));
            owners.set(block, set);
          }
        }
      }
    }
    const shared = [...owners]
      .filter(([, folders]) => folders.size > 1)
      .map(([block, folders]) => `${block}: ${[...folders].join(', ')}`);
    expect(shared).toEqual([]);
  });
});
