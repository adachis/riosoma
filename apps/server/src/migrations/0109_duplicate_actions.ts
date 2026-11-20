import type { Migration } from '@riosoma/db';

export const m0109: Migration = {
  id: '0109_duplicate_actions',
  sql: `
ALTER TABLE {{app}}.files DROP CONSTRAINT files_storage_key_key;
CREATE INDEX files_storage_key ON {{app}}.files (storage_key);
CREATE TABLE {{app}}.table_copies (
  id text PRIMARY KEY,
  command_id text NOT NULL UNIQUE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'finished', 'failed', 'canceled')),
  copied integer NOT NULL DEFAULT 0,
  total integer NOT NULL,
  result jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`,
};
