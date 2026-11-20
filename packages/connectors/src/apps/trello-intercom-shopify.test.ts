import { describe, expect, it } from 'vitest';
import { APP_PRESETS } from './index.js';

const preset = (id: string) => APP_PRESETS.find((preset) => preset.catalog.id === id)!;

describe('Trello, Intercom, and Shopify presets', () => {
  it('keeps Trello on its fixed API address with a public key setting and a secret token query parameter', () => {
    const app = preset('trello');
    expect(app.target.address).toBe('https://api.trello.com/1');
    expect(app.target.auth).toEqual({ method: 'query', name: 'token' });
    expect(app.catalog.secret).toMatchObject({ name: 'apiKey' });
    expect(app.target.requestsPerSecond * 10).toBeLessThan(100);
    expect(app.objects.map((object) => object.name)).toEqual(['boards']);
    expect(app.objects[0]).toMatchObject({
      key: 'id',
      endpoint: {
        path: '/members/me/boards',
        paging: { style: 'none' },
        query: [
          { name: 'key', value: '{setting:key}' },
          { name: 'filter', value: 'open' },
        ],
      },
    });
  });

  it('declares every Intercom region and readable object with its response member', () => {
    const app = preset('intercom');
    expect(app.target.address).toEqual({
      setting: 'region',
      default: 'us',
      choices: {
        us: 'https://api.intercom.io',
        eu: 'https://api.eu.intercom.io',
        au: 'https://api.au.intercom.io',
      },
    });
    expect(app.target.auth).toEqual({ method: 'bearer' });
    expect(app.target.requestsPerSecond).toBe(5);
    expect(
      app.objects.map((object) => [object.name, 'endpoint' in object && object.endpoint.records]),
    ).toEqual([
      ['contacts', 'data'],
      ['companies', 'data'],
      ['conversations', 'conversations'],
      ['admins', 'admins'],
      ['teams', 'teams'],
      ['tags', 'data'],
      ['articles', 'data'],
    ]);
    expect(app.objects.every((object) => object.key === 'id' && !('graphql' in object))).toBe(true);
  });

  it('keeps Shopify paths versioned and paged through Link headers without extracting nested product lists', () => {
    const app = preset('shopify');
    expect(app.target.address).toEqual({ setting: 'store', domain: 'myshopify.com' });
    expect(app.target.auth).toEqual({ method: 'header', name: 'X-Shopify-Access-Token' });
    expect(app.target.requestsPerSecond).toBeLessThanOrEqual(2);
    expect(app.objects.map((object) => object.name)).toEqual([
      'products',
      'custom_collections',
      'smart_collections',
      'customers',
      'orders',
      'draft_orders',
    ]);
    for (const object of app.objects) {
      expect(object.key).toBe('id');
      expect(object).toMatchObject({
        endpoint: {
          path: `/admin/api/2026-10/${object.name}.json`,
          records: object.name,
          paging: { style: 'link-header' },
          query: expect.arrayContaining([{ name: 'limit', value: '250' }]),
        },
      });
      expect(object.fields).toBeUndefined();
    }
  });
});
