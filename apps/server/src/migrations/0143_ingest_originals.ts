import type { Migration } from '@riosoma/db';

export const m0143: Migration = {
  id: '0143_ingest_originals',
  sql: `
ALTER TABLE {{app}}.shared_views ADD COLUMN originals_access boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.published_sites ADD COLUMN originals_access boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.ingest_files ADD COLUMN original_expired_at timestamptz;
CREATE TABLE {{app}}.ingest_original_deletions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  storage text NOT NULL CHECK (storage IN ('local', 's3', 'azure-blob')),
  storage_key text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingest_original_deletions_retry ON {{app}}.ingest_original_deletions (retry_at);
`,
};
