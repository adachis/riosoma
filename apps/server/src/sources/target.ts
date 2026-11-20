import type { SourceConnection } from '@riosoma/contracts';

const SAME_TARGET = new Set([
  // A time-series source's window, step, and bounds choose what to read from the same address.
  'windowMinutes',
  'stepSeconds',
  'start',
  'end',
  // A scan budget changes what may run, without changing where credentials are sent.
  'maxScannedBytes',
  'database',
  'schema',
  'dataset',
  'warehouse',
  'role',
  'catalog',
  'location',
  // A bucket's prefix and a file's format and sheet choose what to read from the same place.
  'prefix',
  'format',
  'sheet',
  // An API's endpoints are paths under its base address, and its pace is its own business.
  'endpoints',
  'requestsPerSecond',
  'query',
  'variables',
  'paging',
  'maxPages',
  // How a MongoDB source's documents flatten is a matter of reading, not of where.
  'flattenDepth',
  'arrays',
  // A Google Sheets source's key only ever goes to Google, whichever spreadsheets it reads, and the
  // service account's address is copied from the key itself.
  'spreadsheets',
  'headerRow',
  'serviceAccountEmail',
  // An Airtable source's token only ever goes to Airtable, whichever bases it offers.
  'bases',
  // A Microsoft 365 source's secret only ever goes to Entra, for the same tenant and app, whichever
  // sites, workbooks, or environment its tokens then read.
  'sites',
  'workbooks',
  'environmentUrl',
  // A webhook's secret checks what's posted to it and goes nowhere, so how it reads posts, and
  // how it checks them, can change and keep it.
  'records',
  'split',
  'signature',
  'postsPerMinute',
  'paused',
]);

export function retargets(before: SourceConnection, after: SourceConnection): boolean {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].some(
    (name) =>
      !SAME_TARGET.has(name) &&
      !(
        name === 'path' &&
        ['sftp', 'ftp', 'ftps', 'webdav'].includes(before.kind) &&
        before.kind === after.kind
      ) &&
      JSON.stringify(a[name]) !== JSON.stringify(b[name]),
  );
}
