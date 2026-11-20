import type { Migration } from '@riosoma/db';

export const m0089: Migration = {
  id: '0089_cell_comments',
  sql: `
-- Keep the anchor through field trash and restore without turning a cell thread into a record thread.
ALTER TABLE IF EXISTS {{app}}.comments ADD COLUMN field_id text;
`,
};
