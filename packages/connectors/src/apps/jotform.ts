import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const endpoint = (name: string, path: string, testing = false) =>
  RestEndpoint.parse({
    name,
    path,
    records: 'content',
    query: testing ? [{ name: 'limit', value: '1' }] : [],
    paging: testing ? { style: 'none' } : { style: 'offset', limit: 1_000 },
    flattenDepth: 0,
  });

export const jotform: AppPreset = {
  catalog: {
    id: 'jotform',
    name: 'Jotform',
    settings: [
      {
        key: 'region',
        type: 'choice',
        values: ['default', 'eu', 'hipaa'],
        required: false,
        labelMessageId: 'sources.app.jotform.region',
        helpMessageId: 'sources.app.jotform.regionHelp',
      },
    ],
    secret: {
      name: 'apiKey',
      helpMessageId: 'sources.app.jotform.keyHelp',
      deniedMessageId: 'sources.app.jotform.deniedKey',
    },
    keyUrl: 'https://www.jotform.com/myaccount/api',
  },
  target: {
    address: {
      setting: 'region',
      default: 'default',
      choices: {
        default: 'https://api.jotform.com',
        eu: 'https://eu-api.jotform.com',
        hipaa: 'https://hipaa-api.jotform.com',
      },
    },
    auth: { method: 'header', name: 'APIKEY' },
    // Two seconds between requests and 1,000 records per page avoid bursts and needless calls.
    // A shared 500-call rolling daily budget, including retries, leaves half the free plan's
    // 1,000 daily calls available for other uses.  https://api.jotform.com/docs/
    requestsPerSecond: 0.5,
    requestLimit: { count: 500, windowMs: 24 * 60 * 60_000 },
  },
  response: { code: 'responseCode', success: 200, message: 'message', denied: [401, 403] },
  objects: [{ name: 'forms', key: 'id', endpoint: endpoint('forms', '/user/forms') }],
  test: { name: 'forms', key: 'id', endpoint: endpoint('forms', '/user/forms', true) },
  discovery: {
    endpoint: endpoint('forms', '/user/forms'),
    id: 'id',
    label: 'title',
    object: {
      path: '/form/{object}/submissions',
      key: 'id',
      endpoint: endpoint('submissions', '/form/{object}/submissions'),
      projection: {
        definitions: { path: '/form/{object}/questions', records: 'content' },
        member: 'answers',
        label: 'text',
        fallback: 'name',
        value: 'answer',
        keep: ['id', 'created_at', 'updated_at', 'status', 'ip'],
      },
    },
    optional: false,
    paged: true,
  },
};
