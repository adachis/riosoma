import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const endpoint = (name: string, path: string, query: { name: string; value: string }[] = []) =>
  RestEndpoint.parse({
    name,
    path,
    query: [{ name: 'per_page', value: '100' }, ...query],
    records: '',
    paging: { style: 'link-header' },
    flattenDepth: 0,
  });

const repositories = endpoint('repositories', '/user/repos', [{ name: 'sort', value: 'full_name' }]);
const fields: AppObject['fields'] = {
  user: 'user.login',
  assignee: 'assignee.login',
  assignees: { path: 'assignees', item: 'login', separator: ', ' },
  labels: { path: 'labels', item: 'name', separator: ', ' },
  milestone: 'milestone.title',
};

export const github: AppPreset = {
  catalog: {
    id: 'github',
    name: 'GitHub',
    settings: [],
    connect: { provider: 'github' },
  },
  target: {
    address: 'https://api.github.com',
    auth: { method: 'bearer' },
    headers: {
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    // OAuth accounts allow 5,000 requests an hour.  An even one per second and a shared
    // rolling budget leave room for the person's other uses, including retries and discovery.
    requestsPerSecond: 1,
    requestLimit: { count: 4_500, windowMs: 60 * 60_000 },
  },
  objects: [
    {
      name: 'repositories',
      key: 'id',
      labelMessageId: 'sources.app.github.repositories',
      endpoint: repositories,
      fields: { owner: 'owner.login' },
    },
  ],
  test: { name: 'repositories', key: 'id', endpoint: repositories },
  rateLimited: {
    remainingHeader: 'x-ratelimit-remaining',
    message: { path: 'message', pattern: /secondary rate limit|abuse detection/i },
  },
  discoveries: [
    {
      endpoint: repositories,
      id: 'id',
      label: 'full_name',
      parameters: { owner: 'owner.login', repo: 'name' },
      paged: true,
      optional: false,
      objects: ['issues', 'pulls'].map((kind) => ({
        name: kind,
        labelMessageId: `sources.app.github.${kind}`,
        path: `/repos/{discovery:owner}/{discovery:repo}/${kind}`,
        key: 'id',
        endpoint: endpoint(kind, '/', [{ name: 'state', value: 'all' }]),
        fields: { ...fields, ...(kind === 'issues' ? { is_pull_request: { exists: 'pull_request' } } : {}) },
      })),
    },
  ],
};
