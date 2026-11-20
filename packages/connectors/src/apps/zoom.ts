import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, path = `/v2/${name}`) =>
  RestEndpoint.parse({
    name,
    path,
    records: name,
    query: name === 'groups' ? [] : [{ name: 'page_size', value: '300' }],
    paging: { style: 'cursor', cursorPath: 'next_page_token', param: 'next_page_token' },
  });

export const zoom: AppPreset = {
  catalog: {
    id: 'zoom',
    name: 'Zoom',
    settings: ['accountId', 'clientId'].map((key) => ({
      key,
      type: 'text' as const,
      maxLength: 256,
      pattern: '^[A-Za-z0-9_-]+$',
      required: true,
      labelMessageId: `sources.app.zoom.${key}Label`,
      helpMessageId: `sources.app.zoom.${key}Help`,
      requiredMessageId: `sources.app.zoom.${key}Required`,
      invalidMessageId: `sources.app.zoom.${key}Invalid`,
    })),
    secret: {
      name: 'clientSecret',
      helpMessageId: 'sources.app.zoom.secretHelp',
      deniedMessageId: 'sources.app.zoom.deniedKey',
    },
    keyUrl: 'https://developers.zoom.us/docs/internal-apps/s2s-oauth/',
  },
  target: {
    address: 'https://api.zoom.us',
    auth: {
      method: 'oauth-client',
      grant: 'account_credentials',
      tokenUrl: 'https://zoom.us/oauth/token',
      clientId: '{setting:clientId}',
      clientAuth: 'basic',
      tokenParams: { account_id: '{setting:accountId}' },
    },
    // Two requests per second stays within the light API limits and leaves room for other clients.
    requestsPerSecond: 2,
  },
  // Recordings require month-sized date windows, so they are excluded from this complete copy.
  objects: ['users', 'groups'].map((name) => ({
    name,
    labelMessageId: `sources.app.zoom.${name}`,
    key: 'id',
    endpoint: endpoint(name),
  })),
  test: {
    name: 'me',
    key: 'id',
    singleRecord: true,
    endpoint: RestEndpoint.parse({ name: 'me', path: '/v2/users/me' }),
  },
  discovery: {
    endpoint: { ...endpoint('users'), name: 'meetings' },
    id: 'id',
    labelFields: ['first_name', 'last_name'],
    optional: true,
    reportDenied: true,
    paged: true,
    object: {
      path: '/v2/users/{object}/meetings',
      key: 'id',
      labelMessageId: 'sources.app.zoom.meetings',
      endpoint: endpoint('meetings'),
    },
  },
  permissionDenied: {
    reportTest: true,
    code: { path: 'code', values: ['4711'] },
    names: { path: 'message', pattern: /scopes:\[([^\]]+)\]/ },
  },
  allowNoObjects: true,
};
