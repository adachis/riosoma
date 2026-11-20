import { describe, expect, it } from 'vitest';
import { APP_PRESETS } from './index.js';
import { readOnlyGraphQuery } from '../api/graphql.js';

describe('Linear preset', () => {
  it('uses the fixed GraphQL address, a raw personal API key header, and a conservative request pace', () => {
    const preset = APP_PRESETS.find((app) => app.catalog.id === 'linear')!;
    expect(preset.catalog.secret!.name).toBe('apiKey');
    expect(preset.catalog.settings).toEqual([]);
    expect(preset.target.address).toBe('https://api.linear.app/graphql');
    expect(preset.target.auth).toEqual({ method: 'header', name: 'Authorization' });
    expect(preset.target.requestsPerSecond * 3_600).toBeLessThan(2_500);
    for (const object of [...preset.objects, preset.test]) {
      expect(object.key).toBe('id');
      if (!('graphql' in object)) throw new Error('Expected a GraphQL object');
      expect(readOnlyGraphQuery(object.graphql.query)).toBe(true);
      expect(object.graphql.query).toContain('(first: 100, after: $after)');
      expect(object.graphql.query).toContain('pageInfo { hasNextPage endCursor }');
      expect(object.graphql.query).not.toMatch(/__schema|comments|history|attachments|members/);
      expect(object.graphql.paging).toEqual({
        style: 'cursor',
        pageInfo: `data.${object.name}.pageInfo`,
        variable: 'after',
      });
    }
  });
});
