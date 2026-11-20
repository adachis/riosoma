import type { Migration } from '@riosoma/db';

export const m0031: Migration = {
  id: '0031_uploads_scanning',
  sql: `
ALTER TABLE {{app}}.files
  ADD COLUMN scan_state text NOT NULL DEFAULT 'clean'
    CHECK (scan_state IN ('clean', 'quarantined', 'infected', 'unavailable')),
  ADD COLUMN scan_signature text,
  ADD COLUMN scan_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN scan_next_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX files_scan_pending ON {{app}}.files (scan_next_at)
  WHERE scan_state IN ('quarantined', 'unavailable');
CREATE TABLE {{app}}.file_uploads (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  created_by text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  table_id text NOT NULL REFERENCES {{app}}.tables(id) ON DELETE CASCADE,
  field_id text NOT NULL REFERENCES {{app}}.fields(id) ON DELETE CASCADE,
  record_id text NOT NULL,
  name text NOT NULL,
  metadata text NOT NULL,
  length bigint NOT NULL CHECK (length >= 0),
  offset_bytes bigint NOT NULL DEFAULT 0 CHECK (offset_bytes >= 0 AND offset_bytes <= length),
  storage text NOT NULL CHECK (storage IN ('postgres', 'local', 's3', 'azure-blob')),
  completed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX file_uploads_expiry ON {{app}}.file_uploads (expires_at);
CREATE TABLE {{app}}.file_upload_chunks (
  upload_id text NOT NULL REFERENCES {{app}}.file_uploads(id) ON DELETE CASCADE,
  offset_bytes bigint NOT NULL,
  bytes bytea NOT NULL,
  PRIMARY KEY (upload_id, offset_bytes)
);
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan'));
`,
};
