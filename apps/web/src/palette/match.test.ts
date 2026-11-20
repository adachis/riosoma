import { describe, expect, it } from 'vitest';
import { entryScore, fuzzyScore, GROUP_CAP, selectGroups } from './match';
import type { PaletteEntry, PaletteGroup } from './types';

function entry(id: string, group: PaletteGroup, label: string, secondary?: string): PaletteEntry {
  return { id, group, label, ...(secondary === undefined ? {} : { secondary }), path: `/${id}` };
}

const tables = (...labels: string[]) => labels.map((label, index) => entry(`t${index}`, 'tables', label));

describe('fuzzyScore', () => {
  it('matches characters in order, and only in order', () => {
    expect(fuzzyScore('proj', 'Projects')).not.toBeNull();
    expect(fuzzyScore('pjct', 'Projects')).not.toBeNull();
    expect(fuzzyScore('jorp', 'Projects')).toBeNull();
    expect(fuzzyScore('px', 'Projects')).toBeNull();
    // Nothing typed matches everything, and matches it equally.
    expect(fuzzyScore('', 'Projects')).toBe(0);
    expect(fuzzyScore('   ', 'Projects')).toBe(0);
  });

  it('ignores case', () => {
    expect(fuzzyScore('PROJ', 'projects')).toEqual(fuzzyScore('proj', 'Projects'));
  });

  it('ranks a name that starts with the query above one that merely holds it', () => {
    const starts = fuzzyScore('proj', 'Projects')!;
    const holds = fuzzyScore('proj', 'Reprojected')!;
    expect(starts).toBeLessThan(holds);
  });

  it('ranks a match at the start of a word above one in the middle of a word', () => {
    const wordStart = fuzzyScore('db', 'My db')!;
    const buried = fuzzyScore('db', 'Mydb')!;
    expect(wordStart).toBeLessThan(buried);
  });

  it('ranks an earlier match above a later one', () => {
    // Both hold the characters once, in the middle of a single word; only the position differs.
    expect(fuzzyScore('an', 'Banana')!).toBeLessThan(fuzzyScore('an', 'Plantain')!);
  });

  it('ranks a tight match above one that skips characters', () => {
    expect(fuzzyScore('tb', 'Tb')!).toBeLessThan(fuzzyScore('tb', 'Table')!);
  });

  it('counts the second line, but never above the label', () => {
    const inLabel = entryScore('proj', { label: 'Projects' });
    const inSecondary = entryScore('proj', { label: 'My stuff', secondary: 'Projects' });
    expect(inLabel).not.toBeNull();
    expect(inSecondary).not.toBeNull();
    expect(inLabel!).toBeLessThan(inSecondary!);
    expect(entryScore('proj', { label: 'Nothing', secondary: 'Nothing' })).toBeNull();
    expect(entryScore('', { label: 'Anything' })).toBe(0);
  });
});

describe('selectGroups', () => {
  it('keeps settings already matched through translated keywords or help', () => {
    const setting = entry('language', 'settings', 'Langue', 'Préférences');
    expect(selectGroups('regionaux traduction', [setting])).toEqual([
      { group: 'settings', entries: [setting] },
    ]);
  });

  it('keeps every row, in group order, when nothing is typed', () => {
    const sections = selectGroups('', [
      entry('cmd', 'commands', 'Go home'),
      ...tables('One', 'Two'),
      entry('db', 'databases', 'Projects'),
    ]);
    expect(sections.map((section) => section.group)).toEqual(['databases', 'tables', 'commands']);
    expect(sections[1]!.entries.map((row) => row.label)).toEqual(['One', 'Two']);
  });

  it('drops the rows a query doesn’t match, and the groups that are left empty', () => {
    const sections = selectGroups('proj', [
      entry('db', 'databases', 'Projects'),
      entry('other', 'databases', 'Budget'),
      entry('cmd', 'commands', 'Go home'),
      ...tables('Tasks'),
    ]);
    expect(sections.map((section) => section.group)).toEqual(['databases']);
    expect(sections[0]!.entries.map((row) => row.id)).toEqual(['db']);
    expect(selectGroups('zzz', tables('One', 'Two'))).toEqual([]);
  });

  it('ranks inside a group and stops at the cap', () => {
    const many = Array.from({ length: 10 }, (_, index) => entry(`z${index}`, 'tables', `Zebra ${index}`));
    const sections = selectGroups('a', [...many, entry('best', 'tables', 'apple')]);
    expect(sections[0]!.entries).toHaveLength(GROUP_CAP);
    // The best match leads even though it was offered last; the rest keep their order.
    expect(sections[0]!.entries.map((row) => row.id)).toEqual([
      'best',
      'z0',
      'z1',
      'z2',
      'z3',
      'z4',
      'z5',
      'z6',
    ]);
  });

  it('takes the cap from the caller', () => {
    const sections = selectGroups('e', tables('One', 'Two', 'Three'), 2);
    expect(sections[0]!.entries.map((row) => row.label)).toEqual(['One', 'Three']);
  });
});
