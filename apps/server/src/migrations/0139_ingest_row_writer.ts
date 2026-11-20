import type { Migration } from '@riosoma/db';

export const m0139: Migration = {
  id: '0139_ingest_row_writer',
  sql: `
-- One row for each batch a run has committed, so a run that starts again writes nothing twice.
CREATE TABLE {{app}}.ingest_write_batches (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  file_id text NOT NULL,
  run_id text NOT NULL,
  operation text NOT NULL,
  batch integer NOT NULL CHECK (batch >= 0),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  PRIMARY KEY (org_id, table_id, file_id, run_id, operation, batch),
  CONSTRAINT ingest_write_batches_file FOREIGN KEY (org_id, table_id, file_id)
    REFERENCES {{app}}.ingest_files (org_id, table_id, id) ON DELETE CASCADE
);

-- What the process last wrote to a record: its values, where they came from, and why it was flagged.
ALTER TABLE {{app}}.ingest_row_state
  ADD COLUMN "values" jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN at jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN reasons jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN created_by_file_id text,
  ADD COLUMN history jsonb NOT NULL DEFAULT '[]';
UPDATE {{app}}.ingest_row_state SET created_by_file_id = file_id WHERE created_by_file_id IS NULL;
ALTER TABLE {{app}}.ingest_row_state ADD CONSTRAINT ingest_row_state_creator
  FOREIGN KEY (org_id, table_id, created_by_file_id) REFERENCES {{app}}.ingest_files (org_id, table_id, id);
`,
};
