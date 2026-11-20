import type { Migration } from '@riosoma/db';

export const m0091: Migration = {
  id: '0091_cross_database_links',
  sql: `ALTER TABLE {{app}}.links ALTER COLUMN right_field_id DROP NOT NULL;`,
};
