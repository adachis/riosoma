import type { Migration } from '@riosoma/db';

export const m0058: Migration = {
  id: '0058_published_sites',
  sql: `
CREATE TABLE {{app}}.published_sites (
  slug text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  interface_id text NOT NULL UNIQUE REFERENCES {{app}}.interfaces(id) ON DELETE CASCADE,
  publisher_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  domain_id text UNIQUE REFERENCES {{app}}.custom_domains(id) ON DELETE SET NULL,
  settings jsonb NOT NULL,
  pages jsonb NOT NULL,
  published boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
ALTER TABLE {{app}}.custom_domains DROP CONSTRAINT custom_domains_kinds_check;
ALTER TABLE {{app}}.custom_domains ADD CONSTRAINT custom_domains_kinds_check
  CHECK (cardinality(kinds) > 0 AND kinds <@ ARRAY['forms', 'views', 'bookings', 'signing', 'sites']);
`,
};
