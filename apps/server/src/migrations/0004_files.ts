import type { Migration } from '@riosoma/db';

export const m0004: Migration = {
  id: '0004_files',
  sql: `
CREATE TABLE {{app}}.files (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id),
  table_id text NOT NULL REFERENCES {{app}}.tables(id),
  field_id text NOT NULL REFERENCES {{app}}.fields(id),
  name text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  type text NOT NULL,
  width integer,
  height integer,
  sha256 text NOT NULL,
  storage text NOT NULL CHECK (storage IN ('postgres', 'local')),
  storage_key text NOT NULL UNIQUE,
  thumbnails jsonb,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  attached_at timestamptz
);
CREATE INDEX files_unattached ON {{app}}.files (created_at) WHERE attached_at IS NULL;
CREATE INDEX files_field ON {{app}}.files (field_id);
CREATE TABLE {{app}}.file_chunks (
  storage_key text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= 1048576),
  PRIMARY KEY (storage_key, position)
);
`,
};
