import type { AppPreset } from './types.js';

export const atlassianCatalog = {
  settings: [
    {
      key: 'site',
      required: true,
      type: 'address',
      domain: 'atlassian.net',
      allowBareName: true,
      subdomainRequired: true,
      labelMessageId: 'sources.app.atlassian.siteLabel',
      helpMessageId: 'sources.app.atlassian.siteHelp',
      requiredMessageId: 'sources.app.atlassian.siteRequired',
      invalidMessageId: 'sources.app.atlassian.siteInvalid',
      addressMessageIds: {
        invalid: 'sources.app.atlassian.siteInvalid',
        https: 'sources.app.atlassian.siteHttps',
        host: 'sources.app.atlassian.siteHost',
        credentials: 'sources.app.atlassian.siteCredentials',
        port: 'sources.app.atlassian.sitePort',
        path: 'sources.app.atlassian.sitePath',
        query: 'sources.app.atlassian.siteQuery',
        fragment: 'sources.app.atlassian.siteFragment',
      },
    },
    {
      key: 'email',
      required: true,
      type: 'text',
      maxLength: 254,
      pattern:
        "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$",
      labelMessageId: 'sources.app.atlassian.emailLabel',
      helpMessageId: 'sources.app.atlassian.emailHelp',
      requiredMessageId: 'sources.app.atlassian.emailRequired',
      invalidMessageId: 'sources.app.atlassian.emailInvalid',
    },
  ],
  secret: {
    name: 'password',
    helpMessageId: 'sources.app.atlassian.tokenHelp',
    deniedMessageId: 'sources.app.atlassian.deniedToken',
  },
  keyUrl: 'https://id.atlassian.com/manage-profile/security/api-tokens',
} as const satisfies Omit<AppPreset['catalog'], 'id' | 'name'>;

export const atlassianTarget: AppPreset['target'] = {
  address: { setting: 'site', domain: 'atlassian.net' },
  auth: { method: 'basic', user: '{setting:email}' },
  // API tokens use burst limits.  Jira documents 100 GET requests per second by default,
  // and Confluence also documents per-second burst limits.  Two per second keeps a conservative
  // pace across both apps, with the API transport honoring each site's Retry-After responses.
  // https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
  // https://developer.atlassian.com/cloud/confluence/rate-limiting/
  requestsPerSecond: 2,
};
