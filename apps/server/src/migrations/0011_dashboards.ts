import type { Migration } from '@riosoma/db';

/**
 * Dashboards: pages of tiles kept in a database beside its tables.  The tiles live in `config`,
 * checked against the contract whenever it changes, and trash and purge work like views.
 */
export const m0011: Migration = {
  id: '0011_dashboards',
  sql: `
CREATE TABLE {{app}}.dashboards (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  position double precision NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX dashboards_database ON {{app}}.dashboards (database_id, position);
`,
};
