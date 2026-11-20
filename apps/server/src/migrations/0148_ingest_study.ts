import type { Migration } from '@riosoma/db';

export const m0148: Migration = {
  id: '0148_ingest_study',
  sql: `
CREATE TABLE {{app}}.ingest_studies (
  org_id text NOT NULL,
  table_id text NOT NULL,
  file_id text NOT NULL,
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, table_id, file_id),
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files(org_id, table_id, id) ON DELETE CASCADE
);
ALTER TABLE {{app}}.ingest_formats ADD COLUMN study_file_id text;
ALTER TABLE {{app}}.ingest_formats ADD COLUMN ignored_headings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE {{app}}.ingest_formats ADD COLUMN unknown_sender_id text;
`,
};
