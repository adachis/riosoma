import type { Migration } from '@riosoma/db';

/**
 * Single sign-on.  A provider belongs to one organization and keeps its client secret sealed with
 * the instance key.  An identity ties a person to the issuer and subject the provider vouches for,
 * so the same sign-in always reaches the same account, whatever the email address says later.
 */
export const m0013: Migration = {
  id: '0013_sso',
  sql: `
CREATE TABLE {{app}}.sso_providers (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('google', 'microsoft', 'oidc')),
  name text NOT NULL,
  issuer text NOT NULL,
  tenant text,
  client_id text NOT NULL,
  sealed_secret text NOT NULL,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  auto_create boolean NOT NULL DEFAULT false,
  link_by_email boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sso_providers_org ON {{app}}.sso_providers (org_id, created_at);

CREATE TABLE {{app}}.sso_identities (
  issuer text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES {{app}}.sso_providers(id) ON DELETE CASCADE,
  -- The address the provider reported the first time, kept for the audit trail only.
  email text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX sso_identities_provider ON {{app}}.sso_identities (provider_id);
CREATE INDEX sso_identities_user ON {{app}}.sso_identities (user_id);
`,
};
