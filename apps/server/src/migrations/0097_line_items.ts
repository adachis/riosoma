import type { Migration } from '@riosoma/db';

export const m0097: Migration = {
  id: '0097_line_items',
  sql: `ALTER TABLE {{app}}.tables ADD COLUMN line_items jsonb;
    ALTER TABLE {{app}}.tables ADD CONSTRAINT tables_line_items_object
      CHECK (line_items IS NULL OR jsonb_typeof(line_items) = 'object');`,
};
