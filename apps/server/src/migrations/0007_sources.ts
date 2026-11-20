import type { Migration } from '@riosoma/db';

export const m0007: Migration = {
  id: '0007_sources',
  sql: `
CREATE TABLE {{app}}.sources (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind text NOT NULL,
  connection jsonb NOT NULL,
  sealed_secrets text NOT NULL,
  access text NOT NULL CHECK (access IN ('admins', 'creators')),
  last_test jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sources_org ON {{app}}.sources (org_id);
CREATE TABLE {{app}}.table_sources (
  table_id text PRIMARY KEY REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES {{app}}.sources(id),
  settings jsonb NOT NULL,
  status jsonb NOT NULL,
  next_sync_at timestamptz,
  lease_at timestamptz,
  lease_token text,
  queued_again boolean NOT NULL DEFAULT false,
  failures integer NOT NULL DEFAULT 0,
  confirm_removals boolean NOT NULL DEFAULT false,
  held_token text
);
CREATE INDEX table_sources_source ON {{app}}.table_sources (source_id);
CREATE INDEX table_sources_due ON {{app}}.table_sources (next_sync_at);
ALTER TABLE {{app}}.fields ADD COLUMN source jsonb;
-- Shared visibility and override columns keep every record reader on the same predicate.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id FROM {{app}}.tables LOOP
    EXECUTE format('ALTER TABLE {{data}}.%I ADD COLUMN __source_gone boolean NOT NULL DEFAULT false, ADD COLUMN __overrides jsonb', item.id);
  END LOOP;
END $$;
CREATE TABLE {{app}}.source_stage (
  token text NOT NULL,
  table_id text NOT NULL REFERENCES {{app}}.table_sources(table_id) ON DELETE CASCADE,
  source_key text NOT NULL,
  record_id text NOT NULL,
  values jsonb NOT NULL,
  PRIMARY KEY (token, source_key)
);
CREATE INDEX source_stage_table ON {{app}}.source_stage (table_id);
`,
};
