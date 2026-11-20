import type { Migration } from '@riosoma/db';

/**
 * Scripts saved with a database for its script panel.  They change through commands like
 * automations do, and trash and purge work like interfaces.  Runs aren't stored: each one lives
 * only as long as the panel's connection, and its writes are in the change log like anyone's.
 */
export const m0033: Migration = {
  id: '0033_scripts',
  sql: `
CREATE TABLE {{app}}.scripts (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  position double precision NOT NULL,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX scripts_database ON {{app}}.scripts (database_id, position);
`,
};
