import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const objects: AppObject[] = [
  'Customer',
  'Vendor',
  'Employee',
  'Item',
  'Account',
  'Invoice',
  'Bill',
  'Payment',
  'BillPayment',
  'Estimate',
  'SalesReceipt',
  'PurchaseOrder',
  'CreditMemo',
  'JournalEntry',
  'Class',
  'Department',
  'TaxCode',
].map((name) => ({
  name,
  key: 'Id',
  labelMessageId: `sources.app.quickbooks.${name}`,
  emptyRecords: true,
  endpoint: RestEndpoint.parse({
    name,
    path: '/v3/company/{value:realmId}/query',
    records: `QueryResponse.${name}`,
    query: [{ name: 'minorversion', value: '75' }],
    paging: {
      style: 'page',
      param: 'query',
      start: 1,
      step: 1_000,
      size: 1_000,
      valueTemplate: `SELECT * FROM ${name} STARTPOSITION {page} MAXRESULTS 1000`,
    },
  }),
}));

export const quickbooks: AppPreset = {
  catalog: {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connect: { provider: 'quickbooks' },
    settings: [
      {
        key: 'environment',
        type: 'choice',
        values: ['production', 'sandbox'],
        valueMessageIds: {
          production: 'sources.app.quickbooks.production',
          sandbox: 'sources.app.quickbooks.sandbox',
        },
        required: false,
        labelMessageId: 'sources.app.quickbooks.environment',
        helpMessageId: 'sources.app.quickbooks.environmentHelp',
      },
    ],
  },
  target: {
    address: {
      setting: 'environment',
      choices: {
        production: 'https://quickbooks.api.intuit.com',
        sandbox: 'https://sandbox-quickbooks.api.intuit.com',
      },
      default: 'production',
    },
    auth: { method: 'bearer' },
    // Four calls a second stays below 500 a minute and leaves room for other apps.
    // Shared pacing spreads concurrent reads instead of starting ten calls together.
    requestsPerSecond: 4,
    rateLimitKey: '{value:realmId}',
    maxConcurrent: 10,
  },
  fault: {
    errors: 'Fault.Error',
    code: 'code',
    message: 'Message',
    reconnect: { path: 'Fault.type', values: ['AuthenticationFault'] },
  },
  objects,
  test: objects[0]!,
};
