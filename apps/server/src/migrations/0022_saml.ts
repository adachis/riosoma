import type { Migration } from '@riosoma/db';

/**
 * SAML identity providers.  A SAML provider keeps its identity provider's entity ID in `issuer`,
 * where an OpenID Connect provider keeps its issuer, and adds the address the identity provider
 * signs people in at, the certificates it signs with, and whether it verifies email addresses.
 *
 * Every assertion that signs someone in is remembered until it expires, so none works twice.
 */
export const m0022: Migration = {
  id: '0022_saml',
  sql: `
ALTER TABLE {{app}}.sso_providers DROP CONSTRAINT sso_providers_kind_check;
ALTER TABLE {{app}}.sso_providers
  ADD CONSTRAINT sso_providers_kind_check CHECK (kind IN ('google', 'microsoft', 'oidc', 'saml')),
  ADD COLUMN sso_url text,
  ADD COLUMN certificates text[] NOT NULL DEFAULT '{}',
  ADD COLUMN verifies_emails boolean NOT NULL DEFAULT false;

CREATE TABLE {{app}}.saml_assertions (
  provider_id text NOT NULL REFERENCES {{app}}.sso_providers(id) ON DELETE CASCADE,
  assertion_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider_id, assertion_id)
);
CREATE INDEX saml_assertions_expiry ON {{app}}.saml_assertions (expires_at);
`,
};
