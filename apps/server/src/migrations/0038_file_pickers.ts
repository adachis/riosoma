import type { Migration } from '@riosoma/db';

/**
 * Accounts people connect to add attachments from cloud drives.
 *
 * `oauth_apps` keeps an organization's app for each provider when an admin sets it up in admin
 * settings rather than in the server's settings, with the client secret sealed, and whether an
 * admin turned the provider off.  `oauth_flows` holds each connection that has started and not yet
 * come back: a hash of its state, the session that started it, and its sealed PKCE verifier, for
 * ten minutes and one use.  `oauth_connections` holds each person's account at a provider, with
 * its tokens sealed.
 */
export const m0038: Migration = {
  id: '0038_file_pickers',
  sql: `
CREATE TABLE {{app}}.oauth_apps (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  client_id text NOT NULL DEFAULT '',
  sealed_secret text NOT NULL DEFAULT '',
  api_key text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  updated_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (org_id, provider)
);

CREATE TABLE {{app}}.oauth_flows (
  state_hash text PRIMARY KEY,
  session_id text NOT NULL REFERENCES {{app}}.sessions(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  sealed_verifier text NOT NULL,
  next text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE INDEX oauth_flows_expires ON {{app}}.oauth_flows (expires_at);

CREATE TABLE {{app}}.oauth_connections (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_id text NOT NULL,
  account_name text NOT NULL DEFAULT '',
  account_email text,
  sealed_tokens text NOT NULL,
  scope text NOT NULL DEFAULT '',
  expires_at timestamptz,
  broken_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (org_id, user_id, provider)
);
`,
};
