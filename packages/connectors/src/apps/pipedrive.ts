import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, limit = 500) =>
  RestEndpoint.parse({
    name,
    path: `/api/v2/${name}`,
    query: [{ name: 'limit', value: String(limit) }],
    records: 'data',
    paging:
      limit === 1
        ? { style: 'none' }
        : { style: 'cursor', cursorPath: 'additional_data.next_cursor', param: 'cursor' },
  });

export const pipedrive: AppPreset = {
  catalog: {
    id: 'pipedrive',
    name: 'Pipedrive',
    settings: [],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.pipedrive.tokenHelp',
      deniedMessageId: 'sources.app.pipedrive.deniedToken',
    },
    keyUrl: 'https://app.pipedrive.com/settings/api',
  },
  target: {
    address: 'https://api.pipedrive.com',
    auth: { method: 'header', name: 'x-api-token' },
    // The lowest API token burst limit is 20 requests per two seconds.  Five per second leaves room.
    // https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting
    requestsPerSecond: 5,
  },
  objects: ['persons', 'organizations', 'deals', 'activities', 'products'].map((name) => ({
    name,
    key: 'id',
    endpoint: endpoint(name),
  })),
  test: { name: 'persons', key: 'id', endpoint: endpoint('persons', 1) },
};
