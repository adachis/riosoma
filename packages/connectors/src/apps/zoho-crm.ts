import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const regions = ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'uk'];
const choice = (choices: Record<string, string>) => ({ setting: 'region', default: 'com', choices });
const endpoint = RestEndpoint.parse({
  name: 'records',
  path: '/crm/v8/{object}',
  records: 'data',
  query: [
    { name: 'per_page', value: '200' },
    { name: 'sort_by', value: 'id' },
    { name: 'sort_order', value: 'asc' },
  ],
  paging: { style: 'cursor', cursorPath: 'info.next_page_token', param: 'page_token' },
});

export const zohoCrm: AppPreset = {
  catalog: {
    id: 'zoho-crm',
    name: 'Zoho CRM',
    settings: [
      {
        key: 'region',
        type: 'choice',
        values: regions,
        required: false,
        labelMessageId: 'sources.app.zoho.regionLabel',
        helpMessageId: 'sources.app.zoho.regionHelp',
        invalidMessageId: 'sources.app.zoho.regionInvalid',
      },
      {
        key: 'clientId',
        type: 'text',
        maxLength: 60,
        // Zoho's client IDs have varied in length after the period (30 and 32 characters seen).
        pattern: '^1000\\.[A-Za-z0-9]{16,54}$',
        required: true,
        labelMessageId: 'sources.app.zoho.clientIdLabel',
        helpMessageId: 'sources.app.zoho.clientIdHelp',
        requiredMessageId: 'sources.app.zoho.clientIdRequired',
        invalidMessageId: 'sources.app.zoho.clientIdInvalid',
      },
    ],
    secret: {
      name: 'clientSecret',
      helpMessageId: 'sources.app.zoho.secretHelp',
      deniedMessageId: 'sources.app.zoho.deniedKey',
    },
    additionalSecrets: [
      {
        name: 'refreshToken',
        labelMessageId: 'sources.app.zoho.refreshTokenLabel',
        helpMessageId: 'sources.app.zoho.refreshTokenHelp',
      },
    ],
    keyUrl: 'https://api-console.zoho.com/',
  },
  target: {
    address: choice(Object.fromEntries(regions.map((region) => [region, `https://www.zohoapis.${region}`]))),
    auth: {
      method: 'oauth-client',
      grant: 'refresh_token',
      clientId: '{setting:clientId}',
      clientAuth: 'body',
      // Canada uses zohocloud for sign-in and zohoapis for records, as documented for multi-DC OAuth.
      tokenUrl: choice(
        Object.fromEntries(
          regions.map((region) => [
            region,
            `https://accounts.${region === 'ca' ? 'zohocloud.ca' : `zoho.${region}`}/oauth/v2/token`,
          ]),
        ),
      ),
    },
    // One request every two seconds conserves the daily API credits shared by an edition's users.
    requestsPerSecond: 0.5,
  },
  objects: [],
  test: {
    name: 'organization',
    key: 'id',
    endpoint: RestEndpoint.parse({ name: 'organization', path: '/crm/v8/org', records: 'org' }),
  },
  discovery: {
    endpoint: RestEndpoint.parse({ name: 'modules', path: '/crm/v8/settings/modules', records: 'modules' }),
    id: 'api_name',
    label: 'plural_label',
    include: [{ api_supported: true }],
    optional: false,
    reportDenied: true,
    object: { path: '/crm/v8/{object}', key: 'id', endpoint },
  },
  fieldSelection: {
    endpoint: RestEndpoint.parse({
      name: 'fields',
      path: '/crm/v8/settings/fields',
      query: [{ name: 'module', value: '{object}' }],
      records: 'fields',
    }),
    records: 'fields',
    name: 'api_name',
    param: 'fields',
    template: '{fields}',
    maxFields: 50,
    maxUrlLength: 16_000,
  },
  lastPage: { path: 'info.more_records', value: false },
  permissionDenied: {
    reportTest: true,
    code: { path: 'code', values: ['OAUTH_SCOPE_MISMATCH'] },
    permission: 'ZohoCRM.modules.READ',
    permissions: {
      '/crm/v8/settings/': 'ZohoCRM.settings.READ',
      '/crm/v8/org': 'ZohoCRM.org.READ',
      '/crm/v8/users': 'ZohoCRM.users.READ',
    },
  },
  objectUnavailable: {
    path: 'code',
    statuses: [400, 403, 405],
  },
};
