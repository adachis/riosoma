import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const endpoint = (name: string) =>
  RestEndpoint.parse({
    name,
    path: `/api/v2/${name}`,
    query: [{ name: 'per_page', value: '100' }],
    paging: { style: 'link-header' },
  });

const tickets: AppObject = {
  name: 'tickets',
  labelMessageId: 'sources.app.freshdesk.tickets',
  key: 'id',
  // Without updated_since, only the last 30 days are listed.  Freshdesk stops at 300 pages.
  endpoint: RestEndpoint.parse({
    ...endpoint('tickets'),
    query: [...endpoint('tickets').query, { name: 'updated_since', value: '2000-01-01T00:00:00Z' }],
    maxPages: 300,
  }),
};

export const freshdesk: AppPreset = {
  catalog: {
    id: 'freshdesk',
    name: 'Freshdesk',
    settings: [
      {
        key: 'helpdesk',
        required: true,
        type: 'address',
        domain: 'freshdesk.com',
        allowBareName: true,
        subdomainRequired: true,
        labelMessageId: 'sources.app.freshdesk.helpdeskLabel',
        helpMessageId: 'sources.app.freshdesk.helpdeskHelp',
        requiredMessageId: 'sources.app.freshdesk.helpdeskRequired',
        invalidMessageId: 'sources.app.freshdesk.helpdeskInvalid',
        addressMessageIds: {
          invalid: 'sources.app.freshdesk.helpdeskInvalid',
          https: 'sources.app.freshdesk.helpdeskHttps',
          host: 'sources.app.freshdesk.helpdeskHost',
          credentials: 'sources.app.freshdesk.helpdeskCredentials',
          port: 'sources.app.freshdesk.helpdeskPort',
          path: 'sources.app.freshdesk.helpdeskPath',
          query: 'sources.app.freshdesk.helpdeskQuery',
          fragment: 'sources.app.freshdesk.helpdeskFragment',
        },
      },
    ],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.freshdesk.keyHelp',
      deniedMessageId: 'sources.app.freshdesk.deniedKey',
    },
    keyUrl: 'https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key',
  },
  target: {
    address: { setting: 'helpdesk', domain: 'freshdesk.com' },
    auth: { method: 'basic', user: 'X', secretAsUsername: true },
    // The free plan has a low allowance.  Thirty requests per minute stays below 50.
    requestsPerSecond: 0.5,
  },
  objects: [
    tickets,
    ...['contacts', 'companies', 'agents', 'groups'].map((name) => ({
      name,
      labelMessageId: `sources.app.freshdesk.${name}`,
      key: 'id',
      endpoint: endpoint(name),
    })),
  ],
  test: tickets,
};
