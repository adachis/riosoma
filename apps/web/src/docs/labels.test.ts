import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../../../..');

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, suffix);
    return name.endsWith(suffix) ? [path] : [];
  });
}

/** The American English catalog's messages by ID, which every label has to be in. */
function catalog(): Map<string, string> {
  const text = readFileSync(join(ROOT, 'apps/web/src/locales/en-US/messages.po'), 'utf8');
  return new Map(
    [...text.matchAll(/^msgid "([^"]+)"\nmsgstr ((?:"[^\n]*"\n?)+)/gm)].map((m) => [
      m[1]!,
      [...m[2]!.matchAll(/"(.*)"/g)].map((part) => part[1]).join(''),
    ]),
  );
}

/** Every `{{ui:}}` macro in the help articles, with the article it's in. */
function macros(): Array<{ path: string; id: string }> {
  return files(join(ROOT, 'docs/modules'), '.md').flatMap((path) =>
    [...readFileSync(path, 'utf8').matchAll(/\{\{ui:([^}]+)\}\}/g)].map((m) => ({
      path: path.slice(ROOT.length + 1),
      id: m[1]!,
    })),
  );
}

describe('help articles', () => {
  it('only name interface labels that exist, so help never shows a raw key', () => {
    const messages = catalog();
    const missing = macros().filter(({ id }) => !messages.has(id));
    expect(missing.map(({ path, id }) => `${path}: ${id}`)).toEqual([]);
  });

  it('never name a label with a placeholder, plural, or select, since help has no values to fill them', () => {
    // Help renders a label with no values, so a placeholder shows up empty and a count shows NaN.
    const messages = catalog();
    const filled = macros().filter(({ id }) => (messages.get(id) ?? '').includes('{'));
    expect(filled.map(({ path, id }) => `${path}: ${id} (${messages.get(id)})`)).toEqual([]);
  });
});
