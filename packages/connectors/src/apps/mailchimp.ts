import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const endpoint = (name: string) =>
  RestEndpoint.parse({
    name,
    path: `/3.0/${name}`,
    records: name,
    paging: { style: 'offset', limitParam: 'count', limit: 1_000, totalPath: 'total_items' },
  });

const audiences: AppObject = {
  name: 'audiences',
  labelMessageId: 'sources.app.mailchimp.audiences',
  key: 'id',
  endpoint: endpoint('lists'),
  omit: ['_links'],
};

export const mailchimp: AppPreset = {
  catalog: {
    id: 'mailchimp',
    name: 'Mailchimp',
    settings: [],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.mailchimp.keyHelp',
      deniedMessageId: 'sources.app.mailchimp.deniedKey',
    },
    keyUrl: 'https://mailchimp.com/help/about-api-keys/',
  },
  target: {
    address: { secret: 'apiKey', separator: '-', domain: 'api.mailchimp.com' },
    auth: { method: 'bearer' },
    // Mailchimp allows ten simultaneous connections.  Three requests per second leaves room.
    requestsPerSecond: 3,
  },
  objects: [
    audiences,
    ...['campaigns', 'templates', 'automations', 'reports'].map((name) => ({
      name,
      labelMessageId: `sources.app.mailchimp.${name}`,
      key: 'id',
      endpoint: endpoint(name),
      omit: ['_links'],
    })),
  ],
  test: audiences,
  discoveries: [
    {
      endpoint: audiences.endpoint,
      id: 'id',
      label: 'name',
      optional: true,
      paged: true,
      objects: [
        {
          name: 'members',
          labelMessageId: 'sources.app.mailchimp.members',
          path: '/3.0/lists/{object}/members',
          key: 'id',
          endpoint: endpoint('members'),
          omit: ['_links'],
        },
      ],
    },
  ],
};
