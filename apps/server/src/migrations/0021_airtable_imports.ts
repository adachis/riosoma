import type { Migration } from '@riosoma/db';

/**
 * Imports of whole Airtable bases.  A row is one import: who started it, which base, the database
 * it's making, and how far it's got.  The person's token is sealed with the instance key while the
 * import runs and set to null the moment it ends, however it ends.  The report stays with the
 * database, and goes when the database does.
 */
export const m0021: Migration = {
  id: '0021_airtable_imports',
  sql: `
CREATE TABLE {{app}}.airtable_imports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  base_id text NOT NULL,
  name text NOT NULL,
  database_id text REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'failed', 'canceled')),
  progress jsonb NOT NULL,
  -- Goes up with every change, so people watching can wait for the next one.
  version integer NOT NULL DEFAULT 0,
  sealed_token text,
  cancel_requested boolean NOT NULL DEFAULT false,
  -- Why it stopped, as a message key and its parameters.
  error jsonb,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- A running import touches this at least every 20 seconds, so one left behind by a stopped
  -- server can be told apart from one still at work.
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finished_at timestamptz,
  CHECK (sealed_token IS NULL OR state IN ('queued', 'running'))
);
CREATE INDEX airtable_imports_user ON {{app}}.airtable_imports (user_id, created_at DESC);
CREATE INDEX airtable_imports_database ON {{app}}.airtable_imports (database_id);
CREATE INDEX airtable_imports_active ON {{app}}.airtable_imports (updated_at)
  WHERE state IN ('queued', 'running');
`,
};
