import { describe, expect, it } from 'vitest';
import { IngestExampleResult } from './ingest-tables.js';

describe('stored pair results', () => {
  it('retains legacy cell differences without requiring new metadata', () => {
    const result = { passed: false, differences: [{ row: 0, key: 'amount', expected: '1', actual: '2' }] };
    expect(IngestExampleResult.parse(result)).toEqual(result);
  });

  it('retains row differences, both positions, identities, typed failures, and each repeated run', () => {
    const difference = {
      row: 2,
      key: null,
      kind: 'missing-row',
      messageId: 'ingest.pairs.missingRow',
      expected: { id: 'A', amount: '1.2' },
      actual: null,
      identity: { id: 'A' },
      expectedPosition: 2,
      actualPosition: null,
      run: 2,
    };
    const failure = {
      kind: 'read-failed',
      messageId: 'ingest.pairs.readFailed',
      reasonId: 'ingest.layout.headerNotFound',
      details: { sheet: 'Orders' },
      run: 2,
    };
    const result = {
      passed: false,
      status: 'failed',
      differences: [difference],
      failure,
      runs: [
        { run: 1, passed: true, differences: [] },
        { run: 2, passed: false, differences: [difference], failure },
      ],
    };
    expect(IngestExampleResult.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('refuses unknown outcomes, difference kinds, and impossible row positions or run numbers', () => {
    const base = { row: 0, key: 'amount', expected: '1', actual: '2' };
    for (const invalid of [
      { ...base, kind: 'tolerated' },
      { ...base, actualPosition: -1 },
      { ...base, expectedPosition: 0.5 },
      { ...base, run: 3 },
    ])
      expect(IngestExampleResult.safeParse({ passed: false, differences: [invalid] }).success).toBe(false);
    expect(IngestExampleResult.safeParse({ passed: false, status: 'pending', differences: [] }).success).toBe(
      false,
    );
    expect(
      IngestExampleResult.safeParse({
        passed: false,
        differences: [],
        failure: { kind: 'ignored', messageId: 'ingest.pairs.readFailed' },
      }).success,
    ).toBe(false);
  });
});
