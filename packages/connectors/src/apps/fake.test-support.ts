import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

export const fake: AppPreset = {
  catalog: {
    id: 'example',
    name: 'Example',
    settings: [
      {
        key: 'account',
        required: true,
        type: 'address',
        domain: 'example.test',
        labelMessageId: 'sources.app.settingRequired',
        helpMessageId: 'sources.app.settingInvalid',
      },
      {
        key: 'region',
        required: true,
        type: 'choice',
        values: ['us', 'eu'],
        labelMessageId: 'sources.app.settingRequired',
        helpMessageId: 'sources.app.settingInvalid',
      },
    ],
    secret: {
      name: 'password',
      helpMessageId: 'sources.app.secretMissing',
      deniedMessageId: 'sources.app.authenticate',
    },
    keyUrl: 'https://example.test/settings',
  },
  target: {
    address: { setting: 'account', domain: 'example.test' },
    auth: { method: 'basic', user: 'reader' },
    requestsPerSecond: 5,
  },
  objects: [
    {
      name: 'items',
      key: 'id',
      endpoint: RestEndpoint.parse({
        name: 'items',
        path: '/items',
        query: [{ name: 'region', value: '{setting:region}' }],
        records: 'data',
      }),
    },
  ],
  test: {
    name: 'items',
    key: 'id',
    endpoint: RestEndpoint.parse({
      name: 'items',
      path: '/items',
      query: [{ name: 'region', value: '{setting:region}' }],
      records: 'data',
    }),
  },
};
