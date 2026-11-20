import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const endpoint = (name: string, path: string, query: { name: string; value: string }[] = []) =>
  RestEndpoint.parse({
    name,
    path,
    query: [{ name: 'per_page', value: '100' }, ...query],
    paging: { style: 'link-header' },
  });

const projects: AppObject = {
  name: 'projects',
  labelMessageId: 'sources.app.gitlab.projects',
  key: 'id',
  endpoint: endpoint('projects', '/projects', [{ name: 'membership', value: 'true' }]),
};

export const gitlab: AppPreset = {
  catalog: {
    id: 'gitlab',
    name: 'GitLab',
    settings: [],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.gitlab.tokenHelp',
      deniedMessageId: 'sources.app.gitlab.deniedToken',
    },
    keyUrl: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  },
  target: {
    // This preset reaches GitLab.com only.  Self-managed GitLab can use the generic API source.
    address: 'https://gitlab.com/api/v4',
    auth: { method: 'bearer' },
    // GitLab.com allows 2,000 authenticated requests per user per minute.  Five per second leaves room.
    requestsPerSecond: 5,
  },
  objects: [
    projects,
    {
      name: 'groups',
      labelMessageId: 'sources.app.gitlab.groups',
      key: 'id',
      endpoint: endpoint('groups', '/groups'),
    },
  ],
  test: projects,
  permissionDenied: {
    code: { path: 'error', values: ['insufficient_scope'] },
    names: { path: 'scope', separator: /\s+/ },
  },
  discoveries: [
    {
      endpoint: projects.endpoint,
      id: 'id',
      label: 'path_with_namespace',
      optional: true,
      paged: true,
      // The global issues list can fail even when project issues are readable.
      objects: ['issues', 'merge_requests'].map((name) => ({
        name,
        labelMessageId: `sources.app.gitlab.${name}`,
        path: `/projects/{object}/${name}`,
        key: 'id',
        endpoint: endpoint(name, '', [{ name: 'scope', value: 'all' }]),
        fields: {
          author: 'author.username',
          assignees: { path: 'assignees', item: 'username', separator: ', ' },
        },
      })),
    },
  ],
};
