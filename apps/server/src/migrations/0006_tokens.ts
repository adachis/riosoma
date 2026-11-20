import type { Migration } from '@riosoma/db';

export const m0006: Migration = {
  id: '0006_tokens',
  sql: `
CREATE TABLE {{app}}.api_tokens (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  scopes text[] NOT NULL,
  databases text[],
  secret_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX api_tokens_owner ON {{app}}.api_tokens (org_id, user_id) WHERE revoked_at IS NULL;
`,
};
