import { RestEndpoint } from '@riosoma/contracts';
import type { AppObject, AppPreset } from './types.js';

const definitions = [
  ['Contacts', 'ContactID', 'contacts'],
  ['Invoices', 'InvoiceID', 'invoices'],
  ['CreditNotes', 'CreditNoteID', 'invoices'],
  ['Payments', 'PaymentID', 'payments'],
  ['BankTransactions', 'BankTransactionID', 'banktransactions'],
  ['Accounts', 'AccountID', 'settings'],
  ['Items', 'ItemID', 'invoices'],
  ['TaxRates', 'TaxType', 'settings'],
  ['TrackingCategories', 'TrackingCategoryID', 'settings'],
  ['Quotes', 'QuoteID', 'invoices'],
  ['PurchaseOrders', 'PurchaseOrderID', 'invoices'],
  ['ManualJournals', 'ManualJournalID', 'manualjournals'],
] as const;

const objects: AppObject[] = definitions.map(([name, key, scope]) => ({
  name,
  key,
  labelMessageId: `sources.app.xero.${name}`,
  permission: `accounting.${scope}.read`,
  dateEncoding: 'dotnet',
  endpoint: RestEndpoint.parse({
    name,
    path: `/${name}`,
    records: name,
    // These settings endpoints return complete lists and do not support page parameters.
    paging: ['Accounts', 'Items', 'TaxRates', 'TrackingCategories'].includes(name)
      ? { style: 'none' }
      : { style: 'page', param: 'page', start: 1, size: 100 },
  }),
}));

export const xero: AppPreset = {
  catalog: {
    id: 'xero',
    name: 'Xero',
    connect: { provider: 'xero' },
    settings: [
      {
        key: 'tenantId',
        type: 'account-choice',
        required: true,
        labelMessageId: 'sources.app.xero.organization',
        helpMessageId: 'sources.app.xero.organizationHelp',
      },
    ],
  },
  target: {
    address: 'https://api.xero.com/api.xro/2.0',
    auth: { method: 'bearer' },
    headers: { 'xero-tenant-id': '{setting:tenantId}' },
    // Fewer than 60 calls a minute leaves room for retries and other apps.  The daily
    // budget stays below 5,000 calls, and the concurrency cap allows at most five reads.
    requestsPerSecond: 0.8,
    rateLimitKey: '{setting:tenantId}',
    maxConcurrent: 5,
    requestLimit: { count: 4_500, windowMs: 24 * 60 * 60_000 },
  },
  objects,
  test: objects[0]!,
};
