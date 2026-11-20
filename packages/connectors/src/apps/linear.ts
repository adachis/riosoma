import { GraphQlConnection } from '@riosoma/contracts';
import type { GraphQlNestedConnection } from '../api/graphql.js';
import type { AppObject, AppPreset } from './types.js';

const object = (
  name: string,
  fields: string,
  projection?: AppObject['fields'],
  nestedConnections?: readonly GraphQlNestedConnection[],
): AppObject => ({
  name,
  key: 'id',
  ...(projection ? { fields: projection } : {}),
  ...(nestedConnections ? { nestedConnections } : {}),
  graphql: GraphQlConnection.parse({
    kind: 'graphql',
    baseUrl: 'https://api.linear.app/graphql',
    query: `query Page($after: String) {
      ${name}(first: 100, after: $after) {
        nodes { ${fields} }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    variables: { after: null },
    records: `data.${name}.nodes`,
    paging: { style: 'cursor', pageInfo: `data.${name}.pageInfo`, variable: 'after' },
  }),
});

const issues = object(
  'issues',
  `id identifier title description priority estimate
   state { id name } team { id name } assignee { id name }
   project { id name } cycle { id name }
   labels(first: 50) { nodes { id name } pageInfo { hasNextPage endCursor } }
   dueDate createdAt updatedAt completedAt canceledAt url`,
  {
    state: 'state.name',
    team: 'team.name',
    assignee: 'assignee.name',
    project: 'project.name',
    cycle: 'cycle.name',
    labels: { path: 'labels.nodes', item: 'name', separator: ', ' },
  },
  [
    {
      path: 'labels',
      parentKey: 'id',
      parentVariable: 'id',
      query: `query LabelPage($id: String!, $after: String) {
      issue(id: $id) {
        labels(first: 100, after: $after) {
          nodes { id name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
      connection: 'data.issue.labels',
      cursorVariable: 'after',
    },
  ],
);

export const linear: AppPreset = {
  catalog: {
    id: 'linear',
    name: 'Linear',
    settings: [],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.linear.keyHelp',
      deniedMessageId: 'sources.app.linear.deniedKey',
    },
    keyUrl: 'https://linear.app/settings/account/security',
  },
  target: {
    address: 'https://api.linear.app/graphql',
    auth: { method: 'header', name: 'Authorization' },
    // API keys allow 2,500 requests per hour per user.  One every two seconds leaves room.
    // https://linear.app/developers/rate-limiting
    requestsPerSecond: 0.5,
  },
  objects: [
    issues,
    object(
      'projects',
      `id name description priority status { id name } lead { id name }
       startDate targetDate createdAt updatedAt completedAt canceledAt url`,
      { status: 'status.name', lead: 'lead.name' },
    ),
    object('teams', 'id name key description timezone createdAt updatedAt'),
    object('users', 'id name displayName email active admin guest createdAt updatedAt url'),
    object(
      'cycles',
      'id name number description startsAt endsAt completedAt createdAt updatedAt team { id name }',
      { team: 'team.name' },
    ),
  ],
  test: issues,
};
