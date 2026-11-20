import type { Migration } from '@riosoma/db';

/**
 * Imports of whole bases from NocoDB, Baserow, and Grist.  A row is one import, as in
 * `airtable_imports`: who started it, which tool and at what address, which base or document, the
 * database it's making, and how far it's got.  The person's token is sealed with the instance key
 * while the import runs and set to null the moment it ends, however it ends.  The report stays with
 * the database, and goes when the database does.
 */
export const m0029: Migration = {
  id: '0029_platform_imports',
  sql: `
CREATE TABLE {{app}}.platform_imports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  platform text NOT NULL CHECK (platform IN ('nocodb', 'baserow', 'grist')),
  -- The tool's address, without anything secret in it.
  address text NOT NULL,
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
CREATE INDEX platform_imports_user ON {{app}}.platform_imports (user_id, created_at DESC);
CREATE INDEX platform_imports_database ON {{app}}.platform_imports (database_id);
CREATE INDEX platform_imports_active ON {{app}}.platform_imports (updated_at)
  WHERE state IN ('queued', 'running');
`,
};
