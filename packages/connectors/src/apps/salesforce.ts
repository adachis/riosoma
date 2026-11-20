import { RestEndpoint } from '@riosoma/contracts';
import type { AppPreset } from './types.js';

const root = '/services/data/v68.0';
const standard = [
  'Account',
  'Contact',
  'Lead',
  'Opportunity',
  'OpportunityLineItem',
  'Case',
  'Campaign',
  'CampaignMember',
  'Task',
  'Event',
  'User',
  'Product2',
  'Pricebook2',
  'PricebookEntry',
  'Contract',
  'Order',
  'Asset',
];
const endpoint = RestEndpoint.parse({
  name: 'records',
  path: `${root}/query`,
  records: 'records',
  paging: { style: 'next-url', nextPath: 'nextRecordsUrl' },
});

export const salesforce: AppPreset = {
  catalog: {
    id: 'salesforce',
    name: 'Salesforce',
    settings: [
      {
        key: 'instance',
        type: 'address',
        domain: 'my.salesforce.com',
        subdomainRequired: true,
        required: true,
        labelMessageId: 'sources.app.salesforce.instanceLabel',
        helpMessageId: 'sources.app.salesforce.instanceHelp',
        requiredMessageId: 'sources.app.salesforce.instanceRequired',
        invalidMessageId: 'sources.app.salesforce.instanceInvalid',
        addressMessageIds: Object.fromEntries(
          ['invalid', 'https', 'host', 'credentials', 'port', 'path', 'query', 'fragment'].map((problem) => [
            problem,
            `sources.app.salesforce.instance${problem[0]!.toUpperCase()}${problem.slice(1)}`,
          ]),
        ),
      },
      {
        key: 'clientId',
        type: 'text',
        maxLength: 512,
        pattern: '^[A-Za-z0-9._-]+$',
        required: true,
        labelMessageId: 'sources.app.salesforce.clientIdLabel',
        helpMessageId: 'sources.app.salesforce.clientIdHelp',
        requiredMessageId: 'sources.app.salesforce.clientIdRequired',
        invalidMessageId: 'sources.app.salesforce.clientIdInvalid',
      },
    ],
    secret: {
      name: 'clientSecret',
      helpMessageId: 'sources.app.salesforce.secretHelp',
      deniedMessageId: 'sources.app.salesforce.deniedKey',
    },
    keyUrl:
      'https://help.salesforce.com/s/articleView?id=xcloud.external_client_app_oauth_client_credentials.htm&type=5',
  },
  target: {
    address: { setting: 'instance', domain: 'my.salesforce.com' },
    auth: {
      method: 'oauth-client',
      grant: 'client_credentials',
      tokenUrl: '{setting:instance}/services/oauth2/token',
      clientId: '{setting:clientId}',
      clientAuth: 'body',
    },
    // Salesforce counts calls per rolling day (15,000 on Developer Edition, far more on paid
    // editions) rather than per second.  Two a second keeps a sync quick, and reading every standard
    // object costs a few hundred calls, so a sync never spends a meaningful share of the day.
    requestsPerSecond: 2,
  },
  objects: [],
  test: {
    name: 'objects',
    key: 'name',
    endpoint: RestEndpoint.parse({ name: 'objects', path: `${root}/sobjects`, records: 'sobjects' }),
  },
  discovery: {
    endpoint: RestEndpoint.parse({ name: 'objects', path: `${root}/sobjects`, records: 'sobjects' }),
    id: 'name',
    label: 'labelPlural',
    optional: false,
    include: [
      { name: standard, queryable: true },
      { custom: true, queryable: true },
    ],
    object: { path: `${root}/query`, key: 'Id', omit: ['attributes'], endpoint },
  },
  lastPage: { path: 'done', value: true },
  fieldSelection: {
    endpoint: RestEndpoint.parse({
      name: 'fields',
      path: `${root}/sobjects/{object}/describe`,
      records: 'fields',
    }),
    records: 'fields',
    name: 'name',
    param: 'q',
    template: 'SELECT {fields} FROM {object} ORDER BY Id',
    maxUrlLength: 16_000,
  },
  permissionDenied: {
    code: {
      path: '0.errorCode',
      values: [
        'INVALID_TYPE',
        'INSUFFICIENT_ACCESS',
        'INSUFFICIENT_ACCESS_OR_READONLY',
        'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY',
      ],
    },
  },
};
