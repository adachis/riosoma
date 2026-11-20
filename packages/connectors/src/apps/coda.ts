import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, path: string, query: RestEndpoint['query'] = []) =>
  RestEndpoint.parse({
    name,
    path,
    records: 'items',
    flattenDepth: 0,
    query: [{ name: 'limit', value: '100' }, ...query],
    paging: { style: 'cursor', cursorPath: 'nextPageToken', param: 'pageToken' },
  });

export const coda: AppPreset = {
  catalog: {
    id: 'coda',
    name: 'Coda',
    settings: [],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.coda.tokenHelp',
      deniedMessageId: 'sources.app.coda.deniedToken',
    },
    keyUrl: 'https://coda.io/account',
  },
  target: {
    address: 'https://coda.io/apis/v1',
    auth: { method: 'bearer' },
    // One request every two seconds leaves room under both 100 reads and four doc listings per six seconds.
    // https://coda.io/developers/apis/v1
    requestsPerSecond: 0.5,
  },
  objects: [{ name: 'docs', key: 'id', endpoint: endpoint('docs', '/docs') }],
  test: { name: 'docs', key: 'id', endpoint: endpoint('docs', '/docs') },
  discoveries: [
    {
      endpoint: endpoint('docs', '/docs'),
      id: 'id',
      label: 'name',
      parameter: 'doc',
      paged: true,
      optional: false,
      discoveries: [
        {
          endpoint: endpoint('tables', '/docs/{discovery:doc}/tables', [
            { name: 'tableTypes', value: 'table' },
          ]),
          id: 'id',
          label: 'name',
          labelSeparator: ': ',
          parameter: 'table',
          paged: true,
          optional: true,
          permission: 'read',
          object: {
            path: '/docs/{discovery:doc}/tables/{discovery:table}/rows',
            key: 'id',
            permission: 'read',
            endpoint: endpoint('rows', '/rows', [
              { name: 'useColumnNames', value: 'true' },
              { name: 'valueFormat', value: 'simple' },
            ]),
            projection: {
              definitions: {
                path: '/docs/{discovery:doc}/tables/{discovery:table}/columns',
                records: 'items',
                id: 'name',
                query: [{ name: 'limit', value: '100' }],
                paging: { style: 'cursor', cursorPath: 'nextPageToken', param: 'pageToken' },
              },
              member: 'values',
              label: 'name',
              fallback: 'id',
              value: '',
              keep: ['id', 'name', 'index', 'createdAt', 'updatedAt', 'browserLink'],
            },
          },
        },
      ],
    },
  ],
};
