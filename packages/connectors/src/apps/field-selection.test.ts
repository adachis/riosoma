import { RestEndpoint } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import { fieldEndpoints } from './field-selection.js';
import type { AppPreset } from './types.js';

const endpoint = RestEndpoint.parse({ name: 'records', path: '/records', records: 'data' });
const rule: NonNullable<AppPreset['fieldSelection']> = {
  endpoint,
  records: 'fields',
  name: 'name',
  param: 'fields',
  template: '{fields}',
  maxFields: 3,
  maxUrlLength: 16_000,
};

describe('discovered field selections', () => {
  it('keeps the join key in every group, preserves order, and removes duplicate metadata', () => {
    const groups = fieldEndpoints(
      { fields: ['Name', 'id', 'A', 'B', 'A', 'C'].map((name) => ({ name })) },
      rule,
      endpoint,
      'https://api.example.test',
      'Leads',
      'id',
    );
    expect(groups.map((group) => group.query)).toEqual([
      [{ name: 'fields', value: 'id,Name,A' }],
      [{ name: 'fields', value: 'id,B,C' }],
    ]);
  });

  it('bounds the entire encoded address and each shared query value', () => {
    const groups = fieldEndpoints(
      { fields: Array.from({ length: 80 }, (_, index) => ({ name: `Field_${index}_${'x'.repeat(40)}` })) },
      { ...rule, maxFields: undefined, template: 'SELECT {fields} FROM {object}', maxUrlLength: 700 },
      endpoint,
      'https://api.example.test',
      'Account',
      'Id',
    );
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      const url = new URL('https://api.example.test/records');
      url.searchParams.set('fields', group.query[0]!.value);
      expect(url.href.length).toBeLessThan(700);
      expect(group.query[0]!.value.length).toBeLessThanOrEqual(2_000);
      expect(group.query[0]!.value).toMatch(/^SELECT Id,/);
    }
  });

  it('requests the key even when metadata has no other fields', () => {
    expect(
      fieldEndpoints({ fields: [] }, rule, endpoint, 'https://api.example.test', 'Leads', 'id')[0]!.query,
    ).toEqual([{ name: 'fields', value: 'id' }]);
  });

  it.each([
    undefined,
    {},
    { fields: [{}] },
    { fields: [{ name: 'Name,Secret' }] },
    { fields: [{ name: 'Name FROM Secret' }] },
    { fields: [{ name: 'Name\n' }] },
  ])('refuses malformed metadata without including its contents', (document) => {
    expect(() => fieldEndpoints(document, rule, endpoint, 'https://api.example.test', 'Leads', 'id')).toThrow(
      'sources.app.discovery',
    );
  });

  it('refuses an identifier that cannot fit safely with the join key', () => {
    expect(() =>
      fieldEndpoints(
        { fields: [{ name: 'x'.repeat(2_001) }] },
        rule,
        endpoint,
        'https://api.example.test',
        'Leads',
        'id',
      ),
    ).toThrow('sources.app.propertyTooLong');
  });

  it('refuses object identifiers containing query syntax', () => {
    expect(() =>
      fieldEndpoints({ fields: [] }, rule, endpoint, 'https://api.example.test', 'Leads WHERE Id', 'id'),
    ).toThrow('sources.app.discovery');
  });
});
