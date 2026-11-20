import type { Migration } from '@riosoma/db';

/**
 * Indexing a library document moves off the upload's connection and onto a queue, so an upload
 * answers as soon as its bytes are stored and the extraction and embedding that follow survive a
 * restart.  A document waiting for its turn reads as `indexing`, which the library screen shows
 * and can stop.  Each job carries the bytes it extracts, or none at all when it re-embeds the text
 * its document already holds, and a lease so a stopped server's work is picked up again.  Each
 * document also records the command that last wrote it.
 */
export const m0087: Migration = {
  id: '0087_knowledge_index_jobs',
  sql: `
ALTER TABLE {{app}}.knowledge_documents DROP CONSTRAINT knowledge_documents_status_check;
ALTER TABLE {{app}}.knowledge_documents ADD CONSTRAINT knowledge_documents_status_check
  CHECK (status IN ('indexing', 'ready', 'failed', 'blocked'));
-- A document waiting to be read has no extracted text yet, but a searchable one always has its text.
ALTER TABLE {{app}}.knowledge_documents DROP CONSTRAINT knowledge_documents_source_text_check;
ALTER TABLE {{app}}.knowledge_documents ADD CONSTRAINT knowledge_documents_source_text_check
  CHECK (length(source_text) <= 500000 AND (status <> 'ready' OR length(source_text) >= 1));
-- The command that last wrote the document.  Indexing never changes it, so undo can tell a later
-- replacement from a finished job even when the two share a name and a size.
ALTER TABLE {{app}}.knowledge_documents ADD COLUMN revision text NOT NULL DEFAULT '';
CREATE TABLE {{app}}.knowledge_index_jobs (
  id uuid PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  library_id uuid NOT NULL REFERENCES {{app}}.knowledge_libraries(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES {{app}}.knowledge_documents(id) ON DELETE CASCADE,
  -- Whoever queued the work.  Once they are gone the job reports failure instead of running.
  user_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  -- The uploaded file's own name, which decides how its bytes are read.  Empty for stored text.
  file_name text NOT NULL DEFAULT '',
  -- The uploaded bytes, or none when the job re-embeds the text its document already carries.
  payload bytea NOT NULL DEFAULT '',
  -- A restore of an archived document rechecks organization administration, not library management.
  restoring boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_at timestamptz,
  lease_token text
);
-- One job per document, so a re-index replaces the work still waiting for it.
CREATE UNIQUE INDEX knowledge_index_jobs_document ON {{app}}.knowledge_index_jobs(document_id);
CREATE INDEX knowledge_index_jobs_due ON {{app}}.knowledge_index_jobs(queued_at, id);
`,
};
