import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, limit = 100) =>
  RestEndpoint.parse({
    name,
    path: `/crm/v3/objects/${name}`,
    query: [{ name: 'limit', value: String(limit) }],
    records: 'results',
    paging:
      limit === 1 ? { style: 'none' } : { style: 'cursor', cursorPath: 'paging.next.after', param: 'after' },
    flattenDepth: 1,
  });

export const hubspot: AppPreset = {
  catalog: {
    id: 'hubspot',
    name: 'HubSpot',
    settings: [],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.hubspot.tokenHelp',
      deniedMessageId: 'sources.app.hubspot.deniedToken',
    },
    keyUrl: 'https://app.hubspot.com/private-apps/',
  },
  target: {
    address: 'https://api.hubapi.com',
    auth: { method: 'bearer' },
    // Private apps allow 190 requests per 10 seconds on Professional and Enterprise, and 100
    // on Free and Starter.  Five per second leaves room on both.
    // https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines
    requestsPerSecond: 5,
  },
  objects: ['contacts', 'companies', 'deals', 'tickets'].map((name) => ({
    name,
    key: 'id',
    endpoint: endpoint(name),
  })),
  test: { name: 'contacts', key: 'id', endpoint: endpoint('contacts', 1) },
  permissionDenied: {
    code: { path: 'category', values: ['MISSING_SCOPES'] },
    names: { path: 'message', pattern: /requires one of \[([^\]]+)\]/ },
  },
  discovery: {
    endpoint: RestEndpoint.parse({ name: 'schemas', path: '/crm/v3/schemas', records: 'results' }),
    id: 'objectTypeId',
    label: 'labels.plural',
    object: { path: '/crm/v3/objects/{object}', key: 'id', endpoint: endpoint('custom') },
    optional: true,
  },
  properties: {
    path: '/crm/v3/properties/{object}',
    records: 'results',
    name: 'name',
    hidden: 'hidden',
    param: 'properties',
    member: 'properties',
  },
};
