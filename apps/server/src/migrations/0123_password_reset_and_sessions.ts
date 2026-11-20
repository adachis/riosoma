import type { Migration } from '@riosoma/db';

export const m0123: Migration = {
  id: '0123_password_reset_and_sessions',
  sql: `
CREATE SEQUENCE {{app}}.password_reset_requests;
CREATE TABLE {{app}}.password_reset_latest_requests (
  address_hash text PRIMARY KEY,
  request_number bigint NOT NULL
);
ALTER TABLE {{app}}.login_tokens ADD COLUMN reset_request bigint;
ALTER TABLE {{app}}.login_tokens ADD COLUMN reset_source text
  CHECK (reset_source IN ('request', 'admin', 'server'));
ALTER TABLE {{app}}.users ADD COLUMN credential_version integer NOT NULL DEFAULT 0;
ALTER TABLE {{app}}.sessions ADD COLUMN sign_in_method text NOT NULL DEFAULT 'unknown'
  CHECK (sign_in_method IN ('password', 'link', 'invitation', 'passkey', 'sso', 'unknown'));
UPDATE {{app}}.sessions SET sign_in_method = 'sso' WHERE sso_verified;
CREATE INDEX login_tokens_recover_user ON {{app}}.login_tokens (user_id, created_at) WHERE purpose = 'recover';
`,
};
