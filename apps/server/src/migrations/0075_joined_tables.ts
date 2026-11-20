import type { Migration } from '@riosoma/db';

export const m0075: Migration = {
  id: '0075_joined_tables',
  sql: `
ALTER TABLE {{app}}.tables ADD COLUMN joined jsonb;
ALTER TABLE {{app}}.tables ADD COLUMN allow_computed_overrides boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.tables ADD COLUMN history_retention_days integer NOT NULL DEFAULT 90
  CHECK (history_retention_days BETWEEN 1 AND 3650);
CREATE TABLE {{app}}.sync_runs (
  id text PRIMARY KEY,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running', 'succeeded', 'held', 'failed', 'canceled')),
  stats jsonb,
  error_key text,
  seq bigint
);
CREATE INDEX sync_runs_table_time ON {{app}}.sync_runs (table_id, started_at DESC, id DESC);
CREATE TABLE {{app}}.sync_record_changes (
  run_id text NOT NULL REFERENCES {{app}}.sync_runs(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  before_values jsonb NOT NULL,
  after_values jsonb NOT NULL,
  PRIMARY KEY (run_id, record_id)
);
CREATE INDEX sync_record_changes_record ON {{app}}.sync_record_changes (record_id, run_id);
`,
};
