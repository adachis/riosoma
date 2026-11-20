import type { Migration } from '@riosoma/db';

export const m0014: Migration = {
  id: '0014_source_order',
  sql: `
-- Where each staged row came in the source's own order, so a sync adds new records in that order.
-- Rows staged before this column existed have no position, so they're added in key order instead.
ALTER TABLE {{app}}.source_stage ADD COLUMN ordinal bigint;
`,
};
