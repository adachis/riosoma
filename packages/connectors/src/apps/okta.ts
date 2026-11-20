import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const endpoint = (name: string, limit = 200) =>
  RestEndpoint.parse({
    name,
    path: `/api/v1/${name}`,
    query: [{ name: 'limit', value: String(limit) }],
    paging: { style: 'link-header' },
  });

const users: AppObject = {
  name: 'users',
  labelMessageId: 'sources.app.okta.users',
  key: 'id',
  endpoint: endpoint('users'),
};

export const okta: AppPreset = {
  catalog: {
    id: 'okta',
    name: 'Okta',
    settings: [
      {
        key: 'organization',
        required: true,
        type: 'address',
        // Address settings accept one domain, so this preset supports okta.com organizations only.
        domain: 'okta.com',
        allowBareName: true,
        subdomainRequired: true,
        labelMessageId: 'sources.app.okta.organizationLabel',
        helpMessageId: 'sources.app.okta.organizationHelp',
        requiredMessageId: 'sources.app.okta.organizationRequired',
        invalidMessageId: 'sources.app.okta.organizationInvalid',
        addressMessageIds: {
          invalid: 'sources.app.okta.organizationInvalid',
          https: 'sources.app.okta.organizationHttps',
          host: 'sources.app.okta.organizationHost',
          credentials: 'sources.app.okta.organizationCredentials',
          port: 'sources.app.okta.organizationPort',
          path: 'sources.app.okta.organizationPath',
          query: 'sources.app.okta.organizationQuery',
          fragment: 'sources.app.okta.organizationFragment',
        },
      },
    ],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.okta.tokenHelp',
      deniedMessageId: 'sources.app.okta.deniedToken',
    },
    keyUrl: 'https://help.okta.com/en-us/content/topics/security/api.htm',
  },
  target: {
    address: { setting: 'organization', domain: 'okta.com' },
    auth: { method: 'header', name: 'Authorization', prefix: 'SSWS ' },
    // Applications allow only 50 requests per minute, below users, groups, and logs.
    // One request every two seconds stays under the lowest path limit.
    requestsPerSecond: 0.5,
  },
  objects: [
    users,
    {
      name: 'groups',
      labelMessageId: 'sources.app.okta.groups',
      key: 'id',
      endpoint: endpoint('groups'),
      keep: ['id', 'type', 'created', 'lastUpdated', 'profile'],
    },
    {
      name: 'applications',
      labelMessageId: 'sources.app.okta.applications',
      key: 'id',
      endpoint: endpoint('apps'),
      keep: ['id', 'label', 'name', 'status', 'signOnMode', 'created', 'lastUpdated'],
    },
    {
      name: 'system_log',
      labelMessageId: 'sources.app.okta.systemLog',
      key: 'uuid',
      // Without a since setting, Okta returns only the last seven days of system log events.
      endpoint: endpoint('logs', 1_000),
    },
  ],
  test: users,
  permissionDenied: {
    code: { path: 'errorCode', values: ['E0000006'] },
    messageId: 'sources.app.okta.objectNotAllowed',
  },
  discoveries: [
    {
      endpoint: endpoint('groups'),
      id: 'id',
      label: 'profile.name',
      optional: true,
      paged: true,
      objects: [
        {
          name: 'members',
          labelMessageId: 'sources.app.okta.members',
          path: '/api/v1/groups/{object}/users',
          key: 'id',
          endpoint: endpoint('users'),
        },
      ],
    },
  ],
};
