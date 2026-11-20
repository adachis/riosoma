import type { Migration } from '@riosoma/db';

/**
 * Each list view's own order of records.  A record's place in a view is its position when it has
 * one, and otherwise its row number, so a record nobody has moved keeps the order it was added
 * in, and moving one record writes one row.  Positions are exact decimals, so there is always
 * room for another between any two.  Rows go with their view, and the purge removes the rows of
 * records it removes.
 */
export const m0023: Migration = {
  id: '0023_record_positions',
  sql: `
CREATE TABLE {{app}}.record_positions (
  view_id text NOT NULL REFERENCES {{app}}.views(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  position numeric NOT NULL,
  PRIMARY KEY (view_id, record_id)
);
CREATE INDEX record_positions_order ON {{app}}.record_positions (view_id, position);
`,
};
