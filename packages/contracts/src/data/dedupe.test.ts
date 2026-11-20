import { describe, expect, it } from 'vitest';
import {
  Command,
  DuplicatesRequest,
  FieldMeta,
  combinableField,
  defaultMergeChoice,
  duplicateMatches,
  mergeableField,
  mergedValue,
  mergedValues,
  sameInEvery,
  type MergeRecord,
} from './index.js';

const TABLE = 'tbl00000000000001';
const meta = (spec: unknown, id: string, tableId = TABLE): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId,
    name: 'F',
    description: '',
    position: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...(spec as object),
  });

const name = meta({ type: 'text' }, 'fld00000000000001');
const email = meta({ type: 'email' }, 'fld00000000000002');
const tags = meta({ type: 'multipleSelect', options: { choices: [] } }, 'fld00000000000003');
const owner = meta({ type: 'user' }, 'fld00000000000004');
const people = meta({ type: 'user', options: { allowMultiple: true } }, 'fld00000000000005');
const related = meta({ type: 'link', options: { linkedTableId: TABLE } }, 'fld00000000000006');
const company = meta(
  { type: 'link', options: { linkedTableId: 'tbl00000000000002', prefersSingle: true } },
  'fld00000000000007',
);
const matched = meta(
  {
    type: 'link',
    options: {
      linkedTableId: 'tbl00000000000002',
      match: { fieldId: 'fld00000000000002', linkedFieldId: 'fld00000000000099' },
    },
  },
  'fld00000000000008',
);
const formula = meta({ type: 'formula', options: { expression: '1' } }, 'fld00000000000009');

const kept: MergeRecord = {
  id: 'rec00000000000001',
  values: { [name.id]: 'Ada', [email.id]: null, [tags.id]: ['a'], [related.id]: ['rec00000000000002'] },
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const older: MergeRecord = {
  id: 'rec00000000000002',
  values: {
    [name.id]: 'ada',
    [email.id]: 'older@example.test',
    [tags.id]: ['b', 'a'],
    [related.id]: ['rec00000000000001', 'rec00000000000004'],
  },
  updatedAt: '2026-09-02T00:00:00.000Z',
};
const newer: MergeRecord = {
  id: 'rec00000000000003',
  values: { [name.id]: null, [email.id]: 'newer@example.test', [tags.id]: ['c'], [related.id]: [] },
  updatedAt: '2026-09-03T00:00:00.000Z',
};
const set = [kept, older, newer];

describe('finding duplicates', () => {
  it('compares text exactly, loosely, or as similar text, and other values exactly', () => {
    expect(duplicateMatches(name)).toEqual(['exact', 'loose', 'similar']);
    expect(duplicateMatches(tags)).toEqual(['exact']);
    expect(duplicateMatches(meta({ type: 'attachment' }, 'fld00000000000010'))).toEqual([]);
    expect(duplicateMatches(formula)).toEqual([]);
  });

  it('asks for one to three different fields', () => {
    const field = (fieldId: string) => ({ fieldId, match: 'exact' });
    expect(DuplicatesRequest.safeParse({ fields: [] }).success).toBe(false);
    expect(DuplicatesRequest.safeParse({ fields: [field(name.id), field(name.id)] }).success).toBe(false);
    expect(
      DuplicatesRequest.safeParse({ fields: [name, email, tags, people].map((item) => field(item.id)) })
        .success,
    ).toBe(false);
    expect(DuplicatesRequest.safeParse({ fields: [field(name.id), field(email.id)] }).success).toBe(true);
  });
});

describe('merging duplicates', () => {
  it('writes what people enter, and combines what holds lists', () => {
    expect([name, tags, related, company].every(mergeableField)).toBe(true);
    expect([formula, matched].some(mergeableField)).toBe(false);
    expect([tags, people, related].every(combinableField)).toBe(true);
    expect([name, owner, company, matched].some(combinableField)).toBe(false);
  });

  it('keeps the kept record’s value, or the most recently changed one when it’s empty, and combines lists', () => {
    expect(defaultMergeChoice(name, set)).toBe(kept.id);
    expect(defaultMergeChoice(email, set)).toBe(newer.id);
    expect(defaultMergeChoice(tags, set)).toBe('combine');
    expect(defaultMergeChoice(owner, set)).toBe(kept.id);
    expect(mergedValue(tags, set)).toEqual(['a', 'b', 'c']);
    expect(mergedValue(email, set)).toBe('newer@example.test');
    expect(mergedValue(email, set, older.id)).toBe('older@example.test');
    expect(mergedValue(tags, set, older.id)).toEqual(['b', 'a']);
  });

  it('collapses links within the set onto the kept record, which never links to itself', () => {
    // The kept record linked to a duplicate, and the duplicate to it and to a fourth record.
    expect(mergedValue(related, set)).toEqual(['rec00000000000004']);
    expect(mergedValue(related, set, older.id)).toEqual(['rec00000000000004']);
    const own = { ...kept, values: { ...kept.values, [related.id]: [kept.id] } };
    expect(mergedValue(related, [own, older])).toEqual([kept.id, 'rec00000000000004']);
  });

  it('gives every field it writes a value, and leaves computed ones alone', () => {
    const values = mergedValues([name, email, tags, formula, matched], set, { [name.id]: older.id });
    expect(values).toEqual({
      [name.id]: 'ada',
      [email.id]: 'newer@example.test',
      [tags.id]: ['a', 'b', 'c'],
    });
    expect(sameInEvery(name, [kept, { ...older, values: { [name.id]: 'Ada' } }])).toBe(true);
    expect(sameInEvery(email, set)).toBe(false);
  });

  it('merges one set per command, choosing among records or combining', () => {
    const command = Command.parse({
      id: 'cmd00000000000001',
      groupId: 'act00000000000001',
      kind: 'record.merge',
      tableId: TABLE,
      recordId: kept.id,
      mergeIds: [older.id, newer.id],
    });
    expect(command).toMatchObject({ kind: 'record.merge', choices: {} });
    expect(
      Command.safeParse({ ...command, choices: { [name.id]: 'combine', [email.id]: older.id } }).success,
    ).toBe(true);
    expect(Command.safeParse({ ...command, choices: { [name.id]: 'first' } }).success).toBe(false);
    expect(Command.safeParse({ ...command, mergeIds: [] }).success).toBe(false);
  });
});
