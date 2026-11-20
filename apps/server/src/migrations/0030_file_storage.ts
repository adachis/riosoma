import type { Migration } from '@riosoma/db';

/**
 * Attachments in S3-compatible buckets and Azure Blob Storage containers, and moves between
 * stores.  A move copies a file's bytes to the new store, checks them there, and then points the
 * file's row at them, leaving the old copy where it was.  `file_moves` remembers each old copy, by
 * its store and keys, until an admin removes the old copies, so the removal deletes exactly what
 * moves left behind and nothing else.  It outlives the file's row on purpose: a file deleted after
 * it moved still has an old copy to remove.
 */
export const m0030: Migration = {
  id: '0030_file_storage',
  sql: `
ALTER TABLE {{app}}.files DROP CONSTRAINT files_storage_check;
ALTER TABLE {{app}}.files ADD CONSTRAINT files_storage_check
  CHECK (storage IN ('postgres', 'local', 's3', 'azure-blob'));
CREATE TABLE {{app}}.file_moves (
  file_id text NOT NULL,
  -- The store the old copy is in.
  storage text NOT NULL CHECK (storage IN ('postgres', 'local', 's3', 'azure-blob')),
  -- The file's key and its previews' keys, as they were in that store.
  storage_keys text[] NOT NULL,
  moved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file_id, storage)
);
`,
};
