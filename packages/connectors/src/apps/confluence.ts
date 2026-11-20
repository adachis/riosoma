import { RestEndpoint } from '@riosoma/contracts';
import { atlassianCatalog, atlassianTarget } from './atlassian.js';
import type { AppPreset } from './types.js';

const endpoint = (name: string, limit = 100) =>
  RestEndpoint.parse({
    name,
    path: `/wiki/api/v2/${name}`,
    query: [{ name: 'limit', value: String(limit) }],
    records: 'results',
    paging: limit === 1 ? { style: 'none' } : { style: 'link-header' },
  });

export const confluence: AppPreset = {
  catalog: { ...atlassianCatalog, id: 'confluence', name: 'Confluence' },
  target: atlassianTarget,
  // The v2 endpoints omit page bodies unless a body format is requested.
  objects: ['spaces', 'pages', 'blogposts'].map((name) => ({ name, key: 'id', endpoint: endpoint(name) })),
  test: { name: 'spaces', key: 'id', endpoint: endpoint('spaces', 1) },
};
