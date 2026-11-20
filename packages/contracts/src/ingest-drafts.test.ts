import { expect, it } from 'vitest';
import { IngestDraftCommand, IngestSetupCommand, IngestSpotCheck, IngestDraftPlace, newId } from './index.js';

const base = { id: newId('command'), tableId: newId('table'), draftId: 'draft', revision: 1 };
it('uses the setup command schema and requires revisions for draft changes', () => {
  for (const input of [
    { ...base, kind: 'ingest.draft.correct', rows: [] },
    { ...base, kind: 'ingest.draft.discard' },
    { ...base, kind: 'ingest.draft.checks' },
    { ...base, kind: 'ingest.draft.answer', checkId: 'check', answer: { kind: 'typed', value: '1,200.50' } },
    { ...base, kind: 'ingest.draft.confirm' },
  ]) {
    expect(IngestDraftCommand.safeParse(input).success).toBe(true);
    expect(IngestSetupCommand.safeParse(input).success).toBe(true);
    const { revision: _revision, ...missing } = input;
    expect(IngestDraftCommand.safeParse(missing).success).toBe(false);
  }
});
it('accepts typed, choice, and none answers without accepting yes-or-no approval', () => {
  const input = { ...base, kind: 'ingest.draft.answer', checkId: 'check' };
  for (const answer of [
    { kind: 'typed', value: 'A' },
    { kind: 'choice', index: 3 },
    { kind: 'none', value: null },
  ])
    expect(IngestDraftCommand.safeParse({ ...input, answer }).success).toBe(true);
  for (const answer of [true, { kind: 'choice', index: 4 }, { kind: 'yes' }, { kind: 'none' }])
    expect(IngestDraftCommand.safeParse({ ...input, answer }).success).toBe(false);
});
it('does not allow an answer marker on check choices', () => {
  const check = {
    id: 'check',
    rowId: 'row',
    field: 'amount',
    name: 'Amount',
    meaning: 'The total.',
    at: { page: 1 },
    content: 'Source content',
    choices: [1200.5, 2100.5],
    noneMessageId: 'ingest.drafts.none',
    passed: false,
  };
  expect(IngestSpotCheck.safeParse(check).success).toBe(true);
  expect(IngestSpotCheck.safeParse({ ...check, draftedIndex: 0 }).success).toBe(false);
});

it('requires a named sheet row, an email table row, or a page for a spot check', () => {
  for (const place of [{ sheet: 'Input', row: 2 }, { table: 1, row: 2 }, { page: 1 }])
    expect(IngestDraftPlace.safeParse(place).success).toBe(true);
  for (const place of [{}, { row: 2 }, { sheet: 'Input' }, { sheet: '', row: 2 }])
    expect(IngestDraftPlace.safeParse(place).success).toBe(false);
});
it('allows correcting a whole draft larger than an ordinary record command', () => {
  expect(
    IngestDraftCommand.safeParse({
      ...base,
      kind: 'ingest.draft.correct',
      rows: Array.from({ length: 1001 }, (_, index) => ({
        values: { name: String(index) },
        at: { sheet: 'Input', row: index + 1 },
      })),
    }).success,
  ).toBe(true);
});
