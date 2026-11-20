import type { Migration } from '@riosoma/db';

/**
 * Databases, tables, fields, views, who can open them, and the change log that realtime, undo,
 * and idempotency share.  Records themselves live in one physical table per Riosoma table in the
 * data schema, created by the data layer.  See docs/architecture/data-core.md.
 */
export const m0002: Migration = {
  id: '0002_data_core',
  sql: `
CREATE TABLE {{app}}.databases (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text,
  color text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The last change's sequence number.  Incremented just before each command commits, so the
  -- row lock orders commits and sequence numbers have no gaps.
  change_seq bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX databases_org ON {{app}}.databases (org_id);

CREATE TABLE {{app}}.tables (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  primary_field_id text NOT NULL,
  position double precision NOT NULL,
  -- Bumped by every record change, so cached view orders know when they're stale.
  data_version bigint NOT NULL DEFAULT 0,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX tables_database ON {{app}}.tables (database_id);

CREATE TABLE {{app}}.fields (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  type text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The physical column.  It starts as the field's ID and changes when a type conversion writes
  -- a new column, keeping the old one in column_backups for undo.
  column_name text NOT NULL,
  position double precision NOT NULL,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX fields_table ON {{app}}.fields (table_id);
-- Field names are unique within a table, ignoring case, among fields that aren't trashed.
CREATE UNIQUE INDEX fields_name ON {{app}}.fields (table_id, lower(name)) WHERE trashed_at IS NULL;

CREATE TABLE {{app}}.column_backups (
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  column_name text NOT NULL,
  field_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_id, column_name)
);

CREATE TABLE {{app}}.views (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  position double precision NOT NULL,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  trashed_at timestamptz,
  trashed_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL
);
CREATE INDEX views_table ON {{app}}.views (table_id);

-- Who can open what.  Folders, groups, and inheritance arrive with sharing.
CREATE TABLE {{app}}.grants (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  resource_kind text NOT NULL CHECK (resource_kind IN ('database')),
  resource_id text NOT NULL,
  principal_kind text NOT NULL CHECK (principal_kind IN ('user', 'group', 'org')),
  principal_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'creator', 'editor', 'commenter', 'reader')),
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resource_kind, resource_id, principal_kind, principal_id)
);
CREATE INDEX grants_principal ON {{app}}.grants (principal_kind, principal_id);

-- Every committed change, in order per database.  Realtime replays it, undo reads prev from it,
-- and later record history builds on it.
CREATE TABLE {{app}}.changes (
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  org_id text NOT NULL,
  table_id text,
  command_id text NOT NULL,
  group_id text NOT NULL,
  actor_id text,
  client_id text,
  kind text NOT NULL,
  body jsonb NOT NULL,
  -- What undo needs to reverse the change.  Never sent to clients.
  prev jsonb,
  undo_of text,
  redo_of text,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (database_id, seq)
);
CREATE INDEX changes_group ON {{app}}.changes (group_id);
CREATE INDEX changes_at ON {{app}}.changes (at);

-- Commands already applied, so a resent command answers the same way instead of applying twice.
CREATE TABLE {{app}}.commands (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  actor_id text,
  database_id text,
  status text NOT NULL CHECK (status IN ('applied', 'rejected')),
  result jsonb NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commands_at ON {{app}}.commands (at);

CREATE TABLE {{app}}.undo_groups (
  group_id text PRIMARY KEY,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('done', 'undone')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes the server added to record tables for sorts and filters people use.
CREATE TABLE {{app}}.data_indexes (
  index_name text PRIMARY KEY,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  field_ids text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Natural text order ("Item 2" before "Item 10") where Postgres has ICU.  Without it, text sorts
-- use the database's default collation.
DO $$
BEGIN
  CREATE COLLATION {{data}}.rio_natural (provider = icu, locale = 'und-u-kn-true');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ICU collation unavailable; text sorts use the default collation';
END $$;
`,
};
