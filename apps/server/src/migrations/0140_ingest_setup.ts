import type { Migration } from '@riosoma/db';

export const m0140: Migration = {
  id: '0140_ingest_setup',
  sql: `
ALTER TABLE {{app}}.files ALTER COLUMN field_id DROP NOT NULL;
ALTER TABLE {{app}}.files ADD COLUMN ingest_file_id text;
ALTER TABLE {{app}}.files ADD CONSTRAINT files_owner CHECK ((field_id IS NULL) <> (ingest_file_id IS NULL));
ALTER TABLE {{app}}.files ADD CONSTRAINT files_ingest_owner FOREIGN KEY (org_id, table_id, ingest_file_id)
  REFERENCES {{app}}.ingest_files (org_id, table_id, id);
CREATE UNIQUE INDEX files_ingest_original ON {{app}}.files (org_id, table_id, ingest_file_id) WHERE ingest_file_id IS NOT NULL;
ALTER TABLE {{app}}.commands ADD COLUMN ingest_result jsonb;
ALTER TABLE {{app}}.ingest_formats ADD COLUMN checks jsonb NOT NULL DEFAULT '{}';
`,
};
