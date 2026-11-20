import type { Migration } from '@riosoma/db';

export const m0147: Migration = {
  id: '0147_ingest_drafts',
  sql: `
CREATE TABLE {{app}}.ingest_drafts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  table_id text NOT NULL,
  format_id text NOT NULL,
  file_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 0),
  state text NOT NULL CHECK (state IN ('drafting', 'ready', 'failed', 'confirmed', 'discarded')),
  document jsonb NOT NULL,
  run_token text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, table_id, format_id) REFERENCES {{app}}.ingest_formats(org_id, table_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files(org_id, table_id, id) ON DELETE CASCADE,
  UNIQUE (org_id, table_id, file_id)
);
CREATE INDEX ingest_drafts_format ON {{app}}.ingest_drafts (org_id, table_id, format_id);
`,
};
