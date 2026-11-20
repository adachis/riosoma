import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, paging = true) =>
  RestEndpoint.parse({
    name,
    path: `/${name}`,
    query: [
      { name: 'organization', value: '{value:organization}' },
      { name: 'count', value: '100' },
    ],
    records: 'collection',
    paging: paging ? { style: 'next-url', nextPath: 'pagination.next_page' } : { style: 'none' },
  });

export const calendly: AppPreset = {
  catalog: {
    id: 'calendly',
    name: 'Calendly',
    settings: [],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.calendly.tokenHelp',
      deniedMessageId: 'sources.app.calendly.deniedToken',
    },
    keyUrl: 'https://calendly.com/integrations/api_webhooks',
  },
  target: {
    address: 'https://api.calendly.com',
    auth: { method: 'bearer' },
    // Free accounts allow 50 requests per user per minute, and paid accounts allow 500.
    // One request every two seconds leaves room on both.
    // https://developer.calendly.com/api-docs/overview/rate-limits
    requestsPerSecond: 0.5,
  },
  bootstrap: {
    endpoint: RestEndpoint.parse({ name: 'me', path: '/users/me' }),
    values: { organization: 'resource.current_organization' },
  },
  // Leaving out a status filter includes canceled scheduled events.
  objects: ['scheduled_events', 'event_types', 'organization_memberships'].map((name) => ({
    name,
    key: 'uri',
    endpoint: endpoint(name),
  })),
  test: { name: 'scheduled_events', key: 'uri', endpoint: endpoint('scheduled_events', false) },
};
