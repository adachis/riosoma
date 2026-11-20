import type { Migration } from '@riosoma/db';

export const m0141: Migration = {
  id: '0141_ingest_pipeline',
  sql: `
CREATE TABLE {{app}}.ingest_pipeline_jobs (
  org_id text NOT NULL,
  table_id text NOT NULL,
  file_id text NOT NULL,
  run_id text NOT NULL,
  prepared jsonb,
  question_ids jsonb NOT NULL DEFAULT '[]',
  notified_questions jsonb NOT NULL DEFAULT '[]',
  notified boolean NOT NULL DEFAULT false,
  attempts jsonb NOT NULL DEFAULT '{}',
  started_at timestamptz,
  parts_created boolean NOT NULL DEFAULT false,
  PRIMARY KEY (org_id, table_id, file_id),
  FOREIGN KEY (org_id, table_id, file_id) REFERENCES {{app}}.ingest_files (org_id, table_id, id) ON DELETE CASCADE
);
CREATE INDEX ingest_pipeline_recent ON {{app}}.ingest_pipeline_jobs (org_id, table_id, started_at);
`,
};
