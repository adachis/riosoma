import { RestEndpoint } from '@riosoma/contracts';
import { atlassianCatalog, atlassianTarget } from './atlassian.js';
import type { AppObject, AppPreset } from './types.js';

const projects: AppObject = {
  name: 'projects',
  key: 'id',
  endpoint: RestEndpoint.parse({
    name: 'projects',
    path: '/rest/api/3/project/search',
    records: 'values',
    paging: {
      style: 'offset',
      offsetParam: 'startAt',
      limitParam: 'maxResults',
      limit: 50,
      lastPath: 'isLast',
    },
  }),
};

export const jira: AppPreset = {
  catalog: { ...atlassianCatalog, id: 'jira', name: 'Jira' },
  target: atlassianTarget,
  objects: [
    projects,
    {
      name: 'issues',
      key: 'id',
      endpoint: RestEndpoint.parse({
        name: 'issues',
        path: '/rest/api/3/search/jql',
        query: [
          // Jira rejects unbounded JQL.  This lower bound covers the account's issue history.
          { name: 'jql', value: 'created >= "1970-01-01" order by created asc' },
          { name: 'fields', value: '*navigable' },
          { name: 'maxResults', value: '100' },
        ],
        records: 'issues',
        paging: { style: 'cursor', cursorPath: 'nextPageToken', param: 'nextPageToken' },
      }),
      values: {
        member: 'fields',
        labels: {
          endpoint: RestEndpoint.parse({ name: 'fields', path: '/rest/api/3/field' }),
          id: 'id',
          name: 'name',
          pattern: '^customfield_[0-9]+$',
        },
        richText: 'atlassian-document',
      },
    },
  ],
  test: {
    ...projects,
    endpoint: RestEndpoint.parse({
      ...projects.endpoint,
      paging: { style: 'none' },
      query: [{ name: 'maxResults', value: '1' }],
    }),
  },
};
