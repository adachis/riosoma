import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { pairValuesEqual, type ExtractedSource } from '@riosoma/ingest';
import type { IngestDraftRow } from '@riosoma/contracts';
import { checkChoices, chooseChecks, nearMisses, surroundingContent, type DraftField } from './checks.js';

const field = (key: string, required = true): DraftField => ({
  key,
  name: key,
  meaning: `The ${key} value.`,
  required,
  type: 'text',
});
const source: ExtractedSource = {
  kind: 'text',
  name: 'input.csv',
  warnings: [],
  sheets: [
    {
      name: 'Input',
      hidden: false,
      rows: Array.from({ length: 15 }, (_, index) => [{ v: `Source ${index}`, t: 'text' }]),
    },
  ],
};
const rows = (count: number, keys: string[]): IngestDraftRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    values: Object.fromEntries(keys.map((key) => [key, `${key}-${index}`])),
    at: { sheet: 'Input', row: index + 1 },
    doubts: [],
    corrected: [],
    needsCorrection: false,
  }));

it('chooses five cells from 12 rows, starts with a doubted cell, and spreads checks across rows', () => {
  const drafted = rows(12, ['name', 'amount', 'day']);
  drafted[9]!.doubts = ['day'];
  const checks = chooseChecks(
    drafted,
    ['name', 'amount', 'day'].map((key) => field(key)),
    new Set(),
    source,
  );
  expect(checks).toHaveLength(5);
  expect(checks[0]).toMatchObject({ rowId: 'row-9', field: 'day' });
  expect(new Set(checks.map((check) => check.rowId)).size).toBe(5);
  expect(new Set(checks.map((check) => check.field))).toEqual(new Set(['name', 'amount', 'day']));
});
it('covers required fields across two drafts even with repeated doubts', () => {
  const fields = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => field(key));
  const drafted = rows(
    12,
    fields.map((field) => field.key),
  );
  for (const row of drafted) row.doubts = ['a'];
  const first = chooseChecks(drafted, fields, new Set(), source);
  const second = chooseChecks(drafted, fields, new Set(first.map((check) => check.field)), source);
  expect(first.length).toBeGreaterThanOrEqual(5);
  expect(second).toHaveLength(5);
  expect(new Set([...first, ...second].map((check) => check.field))).toEqual(
    new Set(fields.map((field) => field.key)),
  );
});
it('checks all three cells of a small draft', () => {
  expect(
    chooseChecks(
      rows(1, ['a', 'b', 'c']),
      ['a', 'b', 'c'].map((key) => field(key)),
      new Set(),
      source,
    ),
  ).toHaveLength(3);
});
it('shows file content and never quotes a model answer outside the shuffled choices', () => {
  const marker = 'PLANTED-DRAFT-VALUE';
  const drafted = rows(1, ['a', 'b']);
  drafted[0]!.values = { a: marker, b: marker };
  const checks = chooseChecks(
    drafted,
    ['a', 'b'].map((key) => field(key)),
    new Set(),
    source,
  );
  for (const check of checks) {
    const { choices, ...body } = check;
    expect(JSON.stringify(body)).not.toContain(marker);
    expect(choices).toContain(marker);
    expect(Object.keys(check)).not.toEqual(
      expect.arrayContaining(['correctIndex', 'draftedIndex', 'answer']),
    );
  }
  expect(checks[0]!.choices).not.toEqual(checks[1]!.choices);
});
it('uses typed values for binary fields', () => {
  expect(checkChoices(true, [false], 'boolean')).toEqual([]);
});
it('does not reveal the drafted choice through the public check identifier', () => {
  const drafted = rows(1, ['a']);
  drafted[0]!.values.a = 'PRIVATE-DRAFT-CELL';
  let recovered = 0;
  for (let trial = 0; trial < 20; trial++) {
    const check = chooseChecks(drafted, [field('a')], new Set(), source)[0]!;
    const publicOrder = check.choices
      .map((_, index) => ({ index, rank: createHash('sha256').update(`${check.id}:${index}`).digest('hex') }))
      .sort((left, right) => left.rank.localeCompare(right.rank));
    const predicted = publicOrder.findIndex(({ index }) => index === 0);
    if (check.choices[predicted] === drafted[0]!.values.a) recovered++;
  }
  expect(recovered).toBeLessThan(20);
});
describe('plain near misses', () => {
  it('transposes digits and changes a number by a step and a scale', () => {
    expect(nearMisses(123.5, 'number')).toEqual([213.5, 124.5, 1235]);
  });
  it('offers neighboring days', () => {
    expect(nearMisses('2026-03-01', 'date')).toEqual(['2026-02-28', '2026-03-02', '2026-03-08']);
  });
  it('changes a unit and transposes text characters', () => {
    expect(nearMisses('12 kg', 'text')).toContain('12 lb');
    expect(nearMisses('ABCD', 'text')).toContain('BACD');
  });
  for (const [value, type, nearby] of [
    ['1,200.50', 'number', [1200.5, '1200.500', 1201.5]],
    ['2026-03-01', 'date', ['03/01/2026', '2026-03-02']],
    ['12 kg', 'text', [' 12 kg ', '12 lb']],
  ] as const)
    it(`deduplicates ${type} alternatives using field comparisons`, () => {
      const choices = checkChoices(value, [...nearby], type);
      expect(choices.length).toBeLessThanOrEqual(4);
      for (const [index, choice] of choices.entries())
        for (const other of choices.slice(index + 1))
          expect(pairValuesEqual(choice, other, type)).toBe(false);
    });
});
it('shows sheet rows, page text, and email table content at their own places', () => {
  expect(surroundingContent(source, { sheet: 'Input', row: 4 })).toBe('Source 2\nSource 3\nSource 4');
  expect(
    surroundingContent(
      { ...source, pages: [{ number: 2, text: 'Page evidence', textQuality: 'clean' }] },
      { page: 2 },
    ),
  ).toBe('Page evidence');
  expect(
    surroundingContent(
      {
        kind: 'email',
        name: 'input.eml',
        warnings: [],
        email: {
          from: '',
          subject: '',
          date: '',
          messageId: '',
          bodyText: '',
          tables: [[['Email evidence']]],
        },
      },
      { table: 1, row: 1 },
    ),
  ).toBe('Email evidence');
});

it('keeps multiple doubts in the same field ahead of required fields', () => {
  const drafted = rows(12, ['name', 'amount', 'day']);
  drafted[2]!.doubts = ['name'];
  drafted[9]!.doubts = ['name'];
  const checks = chooseChecks(
    drafted,
    ['name', 'amount', 'day'].map((key) => field(key)),
    new Set(),
    source,
  );
  expect(checks).toHaveLength(5);
  expect(checks.slice(0, 2).map((check) => check.field)).toEqual(['name', 'name']);
  expect(new Set(checks.map((check) => check.field))).toEqual(new Set(['name', 'amount', 'day']));
});
