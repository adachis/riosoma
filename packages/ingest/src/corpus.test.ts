import { describe, expect, it } from 'vitest';
import {
  ARCHETYPES,
  ARCHETYPE_IDS,
  generateArchetype,
  generateCorpus,
  REFERENCE_READINGS,
  rowsEqual,
} from './corpus.js';
import { interpretLayout } from './interpreter.js';
import { findSignatureMismatches, matchSignature } from './signatures.js';
import type { IngestRow } from './source.js';

describe('seeded archetype corpus', () => {
  it('generates all 15 shapes deterministically with meaningful size and seed parameters', () => {
    for (const id of ARCHETYPE_IDS) {
      const small = generateArchetype(id, { seed: 31, size: 2 });
      expect(generateArchetype(id, { seed: 31, size: 2 })).toEqual(small);
      expect(generateArchetype(id, { seed: 32, size: 2 }).expected).not.toEqual(small.expected);
      expect(generateArchetype(id, { seed: 31, size: 12 }).expected.length).toBeGreaterThan(
        small.expected.length,
      );
    }
    expect(generateCorpus({ seed: 31, size: 2 })).toHaveLength(15);
    expect(ARCHETYPES.map((archetype) => archetype.generate({ seed: 31, size: 2 }))).toEqual(
      generateCorpus({ seed: 31, size: 2 }),
    );
    expect(() => generateArchetype(1, { size: 0 })).toThrow('ingest.corpus.invalidSize');
    expect(() => generateArchetype(1, { size: 1, seed: NaN })).toThrow('ingest.corpus.invalidSeed');
  });
  for (const id of [1, 2, 3, 4] as const)
    for (const size of [2, 27])
      for (const seed of [20, 31]) {
        it(`reads shape ${id} using only its layout at size ${size} and seed ${seed}`, () => {
          const example = generateArchetype(id, { size, seed });
          const input = JSON.stringify(example.source);
          const result = interpretLayout(example.source, example.layout);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(
            rowsEqual(result.rows, example.expected, {
              numberFields: ['amount'],
              dateFields: ['date', 'period'],
            }),
          ).toBe(true);
          expect(result.rows.map((row) => row.values)).toEqual(example.expected.map((row) => row.values));
          expect(result.rows.map((row) => row.at)).toEqual(example.expected.map((row) => row.at));
          expect(result.checks.every((check) => check.status === 'passed')).toBe(true);
          expect(JSON.stringify(example.source)).toBe(input);
        });
      }
  for (const id of [5, 6, 7, 8, 9, 10, 11, 12, 13] as const)
    for (const size of [2, 27])
      for (const seed of [20, 31]) {
        it(`reads shape ${id} with toolkit functions at size ${size} and seed ${seed}`, () => {
          const example = generateArchetype(id, { size, seed });
          const before = JSON.stringify(example.source);
          const result = REFERENCE_READINGS[id](example.source);
          expect(result.map((row) => row.values)).toEqual(example.expected.map((row) => row.values));
          expect(result.map((row) => row.at)).toEqual(example.expected.map((row) => row.at));
          expect(
            rowsEqual(result, example.expected, { numberFields: ['amount', 'quantity', 'units', 'hold'] }),
          ).toBe(true);
          expect(JSON.stringify(example.source)).toBe(before);
        });
      }
  it('keeps scan and mixed-document examples without reference readings', () => {
    for (const id of [14, 15] as const) {
      const example = generateArchetype(id, { size: 6 });
      expect(example.expected).toHaveLength(6);
      expect(example.layout).toBeUndefined();
      expect(REFERENCE_READINGS).not.toHaveProperty(String(id));
    }
    const scan = generateArchetype(14, { size: 2 }).source;
    expect(scan.pages?.map((page) => page.textQuality)).toEqual(['none', 'garbled']);
  });
  it('has no cross-signature matches among recognizable examples', () => {
    const corpus = generateCorpus({ size: 5 }).filter((example) => example.id !== 14);
    for (const example of corpus) expect(matchSignature(example.source, example.signature)).not.toBeNull();
    expect(
      findSignatureMismatches(
        corpus.map((example) => example.signature),
        corpus.map((example) => ({
          id: String(example.id),
          signatureId: example.signature.id,
          source: example.source,
        })),
      ),
    ).toEqual([]);
  });
  it('reports the broad scan signature colliding with other PDF examples', () => {
    const corpus = generateCorpus({ size: 5 });
    for (const example of corpus) expect(matchSignature(example.source, example.signature)).not.toBeNull();
    const mismatches = findSignatureMismatches(
      corpus.map((example) => example.signature),
      corpus.map((example) => ({
        id: String(example.id),
        signatureId: example.signature.id,
        source: example.source,
      })),
    );
    expect(mismatches.map((mismatch) => [mismatch.exampleId, mismatch.matchedSignatureId])).toEqual([
      ['11', 'archetype-14'],
      ['15', 'archetype-14'],
    ]);
  });
});
describe('row equivalence', () => {
  const rows = (values: Record<string, unknown>[]): IngestRow[] =>
    values.map((value) => ({ values: value, at: {}, raw: {} }));
  it('compares trimmed Unicode text, exact numeric values, and dates while preserving case and order', () => {
    expect(
      rowsEqual(
        rows([{ label: ' Cafe\u0301 ', amount: '1.00', date: '2026-3-1' }]),
        rows([{ label: 'Café', amount: 1, date: '2026-03-01' }]),
        { numberFields: ['amount'], dateFields: ['date'] },
      ),
    ).toBe(true);
    expect(rowsEqual(rows([{ id: '0042' }]), rows([{ id: '42' }]))).toBe(false);
    expect(rowsEqual(rows([{ label: 'Crest' }]), rows([{ label: 'crest' }]))).toBe(false);
    expect(rowsEqual(rows([{ id: '1' }, { id: '2' }]), rows([{ id: '2' }, { id: '1' }]))).toBe(false);
    expect(rowsEqual([], rows([{ id: '1' }]))).toBe(false);
    expect(rowsEqual(rows([{ id: '1', other: null }]), rows([{ id: '1' }]))).toBe(false);
    expect(
      rowsEqual(rows([{ amount: 'bad' }]), rows([{ amount: 'junk' }]), { numberFields: ['amount'] }),
    ).toBe(false);
    expect(
      rowsEqual(rows([{ date: '2026-02-30' }]), rows([{ date: '2026-02-31' }]), { dateFields: ['date'] }),
    ).toBe(false);
  });
});
