import { RestEndpoint, type RestPaging } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const cursor: RestPaging = {
  style: 'cursor',
  cursorPath: 'pages.next.starting_after',
  param: 'starting_after',
};

const object = (name: string, records: string, size?: number, paging?: RestPaging): AppObject => ({
  name,
  key: 'id',
  endpoint: RestEndpoint.parse({
    name,
    path: `/${name}`,
    records,
    query: size ? [{ name: 'per_page', value: String(size) }] : [],
    paging: paging ?? { style: 'none' },
    flattenDepth: 1,
  }),
});

export const intercom: AppPreset = {
  catalog: {
    id: 'intercom',
    name: 'Intercom',
    settings: [
      {
        key: 'region',
        type: 'choice',
        values: ['us', 'eu', 'au'],
        required: false,
        labelMessageId: 'sources.app.intercom.regionLabel',
        helpMessageId: 'sources.app.intercom.regionHelp',
        invalidMessageId: 'sources.app.intercom.regionInvalid',
      },
    ],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.intercom.tokenHelp',
      deniedMessageId: 'sources.app.intercom.deniedToken',
    },
    keyUrl: 'https://app.intercom.com/a/apps/_/developer-hub',
  },
  target: {
    address: {
      setting: 'region',
      default: 'us',
      choices: {
        us: 'https://api.intercom.io',
        eu: 'https://api.eu.intercom.io',
        au: 'https://api.au.intercom.io',
      },
    },
    auth: { method: 'bearer' },
    // Five per second leaves ample room under the app's 10,000 requests per minute allowance.
    requestsPerSecond: 5,
  },
  // Endpoints cannot declare Intercom-Version: 2.14, so the app's configured version applies.
  objects: [
    object('contacts', 'data', 150, cursor),
    // The plain list stops at 10,000 companies.  Larger workspaces need /companies/scroll.
    // https://developers.intercom.com/docs/references/2.14/rest-api/api.intercom.io/companies/listallcompanies
    object('companies', 'data', 60, { style: 'next-url', nextPath: 'pages.next' }),
    object('conversations', 'conversations', 150, cursor),
    // Admins, teams, and tags return one complete page.
    object('admins', 'admins'),
    object('teams', 'teams'),
    object('tags', 'data'),
    // A full final articles page needs one extra request for an empty page to stop.
    object('articles', 'data', 50, { style: 'page', param: 'page', start: 1, size: 50 }),
  ],
  // Tickets require a search POST with a body and cannot use this read-only REST preset.
  // Every valid access token can read its identity, even without access to the admins list.
  test: { name: 'me', key: 'id', endpoint: RestEndpoint.parse({ name: 'me', path: '/me' }) },
  // Some refusals only say access is denied.  Name a scope only when the response supplies one.
  permissionDenied: {
    names: { path: 'errors.0.message', pattern: /\b(read_[a-z_]+)\b/ },
  },
};
