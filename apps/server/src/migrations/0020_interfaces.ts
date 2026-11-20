import type { Migration } from '@riosoma/db';

/**
 * Interfaces: pages of blocks kept in a database beside its tables and dashboards.  The pages and
 * their blocks live in `pages`, checked against the contract whenever they change, and trash and
 * purge work like dashboards.
 */
export const m0020: Migration = {
  id: '0020_interfaces',
  sql: `
CREATE TABLE {{app}}.interfaces (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  position double precision NOT NULL,
  pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX interfaces_database ON {{app}}.interfaces (database_id, position);
`,
};
