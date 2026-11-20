import type { Migration } from '@riosoma/db';

export const m0086: Migration = {
  id: '0086_arrangement_order',
  sql: `ALTER TABLE {{app}}.user_database_state ADD COLUMN favorite_position double precision NOT NULL DEFAULT 0`,
};
