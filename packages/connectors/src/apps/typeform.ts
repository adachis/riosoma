import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset, AppValueProjection } from './types.js';

const endpoint = (name: string) =>
  RestEndpoint.parse({
    name,
    path: `/${name}`,
    records: 'items',
    paging: { style: 'page', param: 'page', size: 200, sizeParam: 'page_size', countPath: 'page_count' },
  });
const answer: AppValueProjection = {
  discriminator: 'type',
  variants: {
    text: 'text',
    email: 'email',
    url: 'url',
    file_url: 'file_url',
    phone_number: 'phone_number',
    number: 'number',
    boolean: 'boolean',
    date: 'date',
    choice: { first: ['choice.label', 'choice.other'] },
    choices: 'choices.labels',
    payment: {
      join: ['payment.amount', { path: 'payment.currency', definitionFallback: 'properties.currency' }],
      separator: ' ',
    },
  },
};

export const typeform: AppPreset = {
  catalog: {
    id: 'typeform',
    name: 'Typeform',
    settings: [
      {
        key: 'region',
        type: 'choice',
        values: ['default', 'eu', 'eu-new'],
        required: false,
        labelMessageId: 'sources.app.typeform.region',
        helpMessageId: 'sources.app.typeform.regionHelp',
        invalidMessageId: 'sources.app.typeform.regionInvalid',
      },
    ],
    secret: {
      name: 'token',
      helpMessageId: 'sources.app.typeform.tokenHelp',
      deniedMessageId: 'sources.app.typeform.deniedToken',
    },
    keyUrl: 'https://admin.typeform.com/user/tokens',
  },
  target: {
    address: {
      setting: 'region',
      default: 'default',
      choices: {
        default: 'https://api.typeform.com',
        eu: 'https://api.eu.typeform.com',
        'eu-new': 'https://api.typeform.eu',
      },
    },
    auth: { method: 'bearer' },
    // One request per second leaves half the account's two-request allowance for other uses.
    // https://www.typeform.com/developers/get-started/
    requestsPerSecond: 1,
  },
  objects: ['forms', 'workspaces'].map((name) => ({
    name,
    key: 'id',
    permission: `${name}:read`,
    endpoint: endpoint(name),
  })),
  test: { name: 'forms', key: 'id', permission: 'forms:read', endpoint: endpoint('forms') },
  discoveries: [
    {
      endpoint: endpoint('forms'),
      id: 'id',
      label: 'title',
      paged: true,
      optional: true,
      permission: 'forms:read',
      object: {
        path: '/forms/{object}/responses',
        key: 'response_id',
        permission: 'responses:read',
        endpoint: RestEndpoint.parse({
          name: 'responses',
          path: '/responses',
          records: 'items',
          flattenDepth: 0,
          paging: {
            style: 'last-record',
            cursorPath: 'token',
            param: 'before',
            size: 1_000,
            sizeParam: 'page_size',
          },
        }),
        projection: {
          definitions: {
            path: '/forms/{object}',
            records: 'fields',
            id: 'id',
            children: 'properties.fields',
          },
          member: 'answers',
          id: 'field.id',
          label: 'title',
          fallback: 'ref',
          value: answer,
          keep: ['response_id', 'token', 'landed_at', 'submitted_at'],
          fields: { 'calculated.score': 'calculated.score' },
          additional: [
            { member: 'hidden', value: '', prefix: 'hidden.' },
            { member: 'variables', id: 'key', value: answer, prefix: 'variables.' },
          ],
        },
      },
    },
  ],
};
