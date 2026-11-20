import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const boards: AppObject = {
  name: 'boards',
  key: 'id',
  endpoint: RestEndpoint.parse({
    name: 'boards',
    path: '/members/me/boards',
    query: [
      { name: 'key', value: '{setting:key}' },
      { name: 'filter', value: 'open' },
    ],
    // Member boards return the complete list in one response, with no paging parameters.
    // https://developer.atlassian.com/cloud/trello/rest/api-group-members/#api-members-id-boards-get
    paging: { style: 'none' },
  }),
};

export const trello: AppPreset = {
  catalog: {
    id: 'trello',
    name: 'Trello',
    settings: [
      {
        key: 'key',
        type: 'text',
        required: true,
        maxLength: 32,
        pattern: '^[a-f0-9]{32}$',
        labelMessageId: 'sources.app.trello.keyLabel',
        helpMessageId: 'sources.app.trello.keyHelp',
        requiredMessageId: 'sources.app.trello.keyRequired',
        invalidMessageId: 'sources.app.trello.keyInvalid',
      },
    ],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.trello.tokenHelp',
      deniedMessageId: 'sources.app.trello.deniedToken',
    },
    keyUrl: 'https://trello.com/power-ups/admin',
  },
  target: {
    address: 'https://api.trello.com/1',
    auth: { method: 'query', name: 'token' },
    // Two per second leaves room under 100 calls per 10 seconds per token and 300 per key.
    requestsPerSecond: 2,
  },
  // Board cards need value lookups and joined fields on discovered objects, which the frame lacks.
  // The /boards/{id}/cards/all and /boards/{id}/lists paths have no documented paging parameters.
  // https://developer.atlassian.com/cloud/trello/rest/api-group-boards/
  objects: [boards],
  test: boards,
};
