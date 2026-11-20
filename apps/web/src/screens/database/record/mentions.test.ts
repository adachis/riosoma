import { describe, expect, it } from 'vitest';
import { MENTION_PATTERN } from '@riosoma/contracts';
import { commentParts, findPeople, insertMention, mentionAt, mentionedIds } from './mentions';

const SAM = 'usr00000000000002';
const SANA = 'usr00000000000003';
const people = [
  { id: SAM, name: 'Sam Lee', email: 'sam@example.test' },
  { id: SANA, name: 'Sana Ali', email: 'sana@example.test' },
];

describe('reading mentions', () => {
  it('splits a body into its text and its mentions', () => {
    expect(commentParts('Nothing here')).toEqual([{ text: 'Nothing here' }]);
    expect(commentParts(`Thanks @[Sam Lee](${SAM})!`)).toEqual([
      { text: 'Thanks ' },
      { mentionId: SAM, writtenName: 'Sam Lee' },
      { text: '!' },
    ]);
    expect(commentParts(`@[Sam Lee](${SAM}) and @[Sana Ali](${SANA})`)).toEqual([
      { mentionId: SAM, writtenName: 'Sam Lee' },
      { text: ' and ' },
      { mentionId: SANA, writtenName: 'Sana Ali' },
    ]);
  });

  it('leaves text that only looks like a mention alone', () => {
    expect(commentParts('sam@example.test and @[broken')).toEqual([
      { text: 'sam@example.test and @[broken' },
    ]);
  });

  it('keeps only the people who can read the database, once each', () => {
    expect(mentionedIds(`@[Sam Lee](${SAM}) @[Sana Ali](${SANA}) @[Sam Lee](${SAM})`, [SAM])).toEqual([SAM]);
    expect(mentionedIds('no one', [SAM])).toEqual([]);
  });

  it('writes markup the contracts accept', () => {
    const { text } = insertMention('@', { start: 0, end: 1, query: '' }, people[0]!);
    expect([...text.matchAll(MENTION_PATTERN)].map((match) => match[2])).toEqual([SAM]);
  });
});

describe('finding the mention being written', () => {
  it.each([
    ['@', 1, ''],
    ['@sa', 3, 'sa'],
    ['Thanks @sa', 10, 'sa'],
    ['Thanks @sa again', 10, 'sa'],
    ['one\ntwo @sa', 11, 'sa'],
  ])('finds %j at %i', (text, caret, query) => {
    expect(mentionAt(text, caret)).toEqual({ start: text.lastIndexOf('@', caret - 1), end: caret, query });
  });

  it.each([
    ['sam@example.test', 16],
    ['no mention', 10],
    [`@[Sam Lee](${SAM})`, 26],
    ['@sa', 0],
    ['a@sa', 4],
  ])('finds nothing in %j at %i', (text, caret) => {
    expect(mentionAt(text, caret)).toBeNull();
  });
});

describe('writing a mention', () => {
  it('replaces the query with markup, a space, and the caret after it', () => {
    const next = insertMention('Thanks @sa!', { start: 7, end: 10, query: 'sa' }, people[1]!);
    expect(next.text).toBe(`Thanks @[Sana Ali](${SANA}) !`);
    expect(next.caret).toBe(`Thanks @[Sana Ali](${SANA}) `.length);
  });

  it('keeps markup out of a name', () => {
    const next = insertMention(
      '@',
      { start: 0, end: 1, query: '' },
      {
        id: SAM,
        name: 'Sa[m]\nLee',
      },
    );
    expect(next.text).toBe(`@[SamLee](${SAM}) `);
  });
});

describe('offering people', () => {
  it('matches a name or an address, whatever its case', () => {
    expect(findPeople(people, 'sam', 'en-US').map((person) => person.id)).toEqual([SAM]);
    expect(findPeople(people, 'SANA@', 'en-US').map((person) => person.id)).toEqual([SANA]);
    expect(findPeople(people, 'nobody', 'en-US')).toEqual([]);
    expect(findPeople(people, 'example.test', 'en-US').map((person) => person.id)).toEqual([SAM, SANA]);
  });

  it('offers everyone up to a limit on an empty query', () => {
    expect(findPeople(people, '', 'en-US')).toHaveLength(2);
    expect(findPeople(people, '', 'en-US', 1)).toHaveLength(1);
  });
});
