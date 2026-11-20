import { describe, expect, it } from 'vitest';
import { compile, sql } from '@riosoma/db';
import { matches, parseFilter, filterSql } from './filter.js';

const person = {
  userName: 'bjensen@example.test',
  displayName: 'Barbara Jensen',
  externalId: 'A123',
  emails: [{ type: 'work', value: 'bjensen@example.test' }],
};

describe('SCIM filters', () => {
  it.each([
    ['userName eq "BJensen@example.test"', true],
    ['userName co "jensen"', true],
    ['userName sw "bjen"', true],
    ['userName pr', true],
    ['externalId eq "A123"', true],
    ['externalId eq "a123"', false],
    ['emails.value co "@example.test"', true],
    ['displayName sw "Barbara"', true],
    ['displayName eq "Nobody" or userName pr and externalId eq "A123"', true],
    ['(displayName eq "Nobody" or userName pr) and externalId eq "missing"', false],
    ['UserName EQ "bjensen@example.test"', true],
    [`displayName co ${JSON.stringify('"')}`, false],
  ])('evaluates %s', (source, expected) => {
    expect(matches(parseFilter(source), person)).toBe(expected);
  });

  it.each([
    '',
    'userName',
    'userName eq',
    'userName eq "unclosed',
    'userName xx "x"',
    'userName eq "x" trailing',
    'unknown pr',
    'userName pr or',
    '(userName pr',
    'userName co true',
    'userName eq "\\q"',
  ])('rejects malformed filter %s', (source) => {
    expect(() => parseFilter(source)).toThrow(
      expect.objectContaining({ status: 400, scimType: 'invalidFilter' }),
    );
  });

  it('treats SQL punctuation and wildcard characters as ordinary values', () => {
    const value = ['%', "'", '_', ' OR true'].join('');
    const source = `userName co ${JSON.stringify(value)}`;
    const statement = compile(filterSql(parseFilter(source), sql`resource.document`));
    expect(statement.text).not.toContain(value);
    expect(statement.values).toContain(value.toLowerCase());
  });

  it('limits nesting and input size', () => {
    expect(() => parseFilter(`${'('.repeat(18)}userName pr${')'.repeat(18)}`)).toThrow();
    expect(() => parseFilter(`userName eq "${'x'.repeat(4096)}"`)).toThrow();
  });

  it('evaluates value filters against the same array item', () => {
    const filter = parseFilter('type eq "work" and value sw "bjen"', 'emails');
    expect(matches(filter, person.emails[0])).toBe(true);
    expect(matches(filter, { type: 'home', value: person.emails[0]!.value })).toBe(false);
  });

  it.each([
    ['emails[type eq "work"].value eq "BJENSEN@example.test"', true],
    ['emails[type eq "home"].value eq "bjensen@example.test"', false],
    ['emails[type eq "work" and value co "jensen"]', true],
    ['emails[type eq "work"].value pr', true],
    ['emails[type eq "work"].type eq "work" and displayName pr', true],
  ])('evaluates the value path %s', (source, expected) => {
    expect(matches(parseFilter(source), person)).toBe(expected);
  });

  it('reads quoted booleans in any case', () => {
    expect(matches(parseFilter('active eq "True"'), { active: true })).toBe(true);
    expect(matches(parseFilter('active eq "FALSE"'), { active: true })).toBe(false);
  });

  it('compares group member IDs exactly', () => {
    const filter = parseFilter('members[value eq "usrAbc"]');
    expect(matches(filter, { members: [{ value: 'usrAbc' }] })).toBe(true);
    expect(matches(filter, { members: [{ value: 'usrabc' }] })).toBe(false);
  });

  it.each(['userName eq "\\u0000"', `userName eq "a${String.fromCharCode(0)}"`, 'userName eq "\\udc00"'])(
    'rejects NUL and lone surrogates in %j',
    (source) => {
      expect(() => parseFilter(source)).toThrow(expect.objectContaining({ scimType: 'invalidFilter' }));
    },
  );
});
