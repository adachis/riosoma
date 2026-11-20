import type { Migration } from '@riosoma/db';

export const m0144: Migration = {
  id: '0144_ingest_build',
  sql: `
ALTER TABLE {{app}}.ingest_examples ADD COLUMN builder_shown boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.ingest_formats ADD COLUMN blind_failures integer NOT NULL DEFAULT 0 CHECK (blind_failures >= 0);
ALTER TABLE {{app}}.ingest_formats ADD COLUMN value_sources jsonb NOT NULL DEFAULT '{}';
CREATE TABLE {{app}}.ingest_builds (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  table_id text NOT NULL,
  format_id text NOT NULL,
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'waiting', 'passed', 'blindFailed', 'stopped', 'ceiling', 'unavailable', 'canceled')),
  status jsonb NOT NULL,
  draft jsonb,
  facts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, table_id, format_id) REFERENCES {{app}}.ingest_formats(org_id, table_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX ingest_builds_active ON {{app}}.ingest_builds (org_id, table_id, format_id)
  WHERE state IN ('queued', 'running', 'waiting');
CREATE INDEX ingest_builds_format ON {{app}}.ingest_builds (org_id, table_id, format_id, created_at DESC);
`,
};
