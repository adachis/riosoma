import type { Migration } from '@riosoma/db';

/**
 * Whole databases as archives: snapshots of a database, the background copies that turn a
 * snapshot or a live database into a new database, and templates an organization saves from its
 * own databases.  Snapshots and templates keep their archive gzip-compressed.  A snapshot goes
 * with its database when the database is purged.  A copy's row outlives both ends, since it's the
 * record of what happened.
 */
export const m0024: Migration = {
  id: '0024_database_archives',
  sql: `
CREATE TABLE {{app}}.database_snapshots (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('manual', 'automatic')),
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- The UTC day an automatic snapshot stands for, so each database gets at most one a day.
  day date,
  change_seq bigint NOT NULL,
  tables integer NOT NULL,
  records bigint NOT NULL,
  size bigint NOT NULL,
  archive bytea NOT NULL,
  CHECK ((kind = 'automatic') = (day IS NOT NULL))
);
CREATE INDEX database_snapshots_database ON {{app}}.database_snapshots (database_id, created_at DESC);
CREATE UNIQUE INDEX database_snapshots_daily ON {{app}}.database_snapshots (database_id, day)
  WHERE kind = 'automatic';

CREATE TABLE {{app}}.database_copies (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('snapshot', 'duplicate')),
  -- What it copies: a snapshot, or a live database with or without its records.
  source_database_id text NOT NULL,
  snapshot_id text,
  with_records boolean NOT NULL DEFAULT true,
  name text NOT NULL,
  database_id text REFERENCES {{app}}.databases(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'failed')),
  progress jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  error jsonb,
  report jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  -- A running copy touches this at least every 20 seconds, so one a stopped server left behind
  -- can be told apart from one still at work.
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finished_at timestamptz
);
CREATE INDEX database_copies_user ON {{app}}.database_copies (user_id, created_at DESC);
CREATE INDEX database_copies_active ON {{app}}.database_copies (updated_at)
  WHERE state IN ('queued', 'running');

CREATE TABLE {{app}}.org_templates (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text,
  color text,
  category text NOT NULL CHECK (category IN ('work', 'personal', 'organizations')),
  table_names text[] NOT NULL,
  samples integer NOT NULL DEFAULT 0,
  source_database_id text,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  archive bytea NOT NULL
);
CREATE INDEX org_templates_org ON {{app}}.org_templates (org_id, created_at DESC);
`,
};
