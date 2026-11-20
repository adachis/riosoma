import type { Migration } from '@riosoma/db';

/**
 * Organization keys and foreign keys keep provisioning references inside their tenant.  Starts at
 * 0044, since the numbers before it were taken by work built alongside this.
 */
export const m0044: Migration = {
  id: '0044_scim',
  sql: `
CREATE TABLE {{app}}.scim_settings (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  dry_run boolean NOT NULL DEFAULT false,
  delete_action text NOT NULL DEFAULT 'suspend' CHECK (delete_action IN ('suspend', 'remove'))
);
CREATE TABLE {{app}}.scim_tokens (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  created_by text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  rate_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rate_count integer NOT NULL DEFAULT 0
);
CREATE INDEX scim_tokens_org ON {{app}}.scim_tokens (org_id);

CREATE TABLE {{app}}.groups (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  scim_managed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (org_id, id)
);
CREATE UNIQUE INDEX groups_name ON {{app}}.groups (org_id, lower(name));
CREATE TABLE {{app}}.group_members (
  org_id text NOT NULL,
  group_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (org_id, group_id, user_id),
  FOREIGN KEY (org_id, group_id) REFERENCES {{app}}.groups(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX group_members_person ON {{app}}.group_members (org_id, user_id);

CREATE TABLE {{app}}.folders (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (org_id, id)
);
ALTER TABLE {{app}}.databases ADD UNIQUE (org_id, id);
CREATE TABLE {{app}}.folder_databases (
  org_id text NOT NULL,
  folder_id text NOT NULL,
  database_id text NOT NULL,
  PRIMARY KEY (org_id, database_id),
  FOREIGN KEY (org_id, folder_id) REFERENCES {{app}}.folders(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, database_id) REFERENCES {{app}}.databases(org_id, id) ON DELETE CASCADE
);
ALTER TABLE {{app}}.grants DROP CONSTRAINT grants_resource_kind_check;
ALTER TABLE {{app}}.grants ADD CHECK (resource_kind IN ('database', 'folder'));

CREATE TABLE {{app}}.scim_users (
  org_id text NOT NULL,
  user_id text NOT NULL UNIQUE,
  external_id text,
  document jsonb NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id),
  FOREIGN KEY (org_id, user_id) REFERENCES {{app}}.memberships(org_id, user_id) ON DELETE CASCADE,
  UNIQUE (org_id, external_id)
);
-- The directory's login name, such as a user principal name, is kept apart from the person's email.
CREATE UNIQUE INDEX scim_users_user_name ON {{app}}.scim_users (org_id, lower(document->>'userName'))
  WHERE deleted_at IS NULL;
CREATE TABLE {{app}}.scim_groups (
  org_id text NOT NULL,
  group_id text NOT NULL,
  external_id text,
  document jsonb NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, group_id),
  FOREIGN KEY (org_id, group_id) REFERENCES {{app}}.groups(org_id, id) ON DELETE CASCADE,
  UNIQUE (org_id, external_id)
);

-- A domain is verified by one organization at most.  Verification takes an advisory lock on the
-- domain, so two organizations can't verify it at once.  Verified domains are rechecked daily,
-- and three failed checks in a row take verification away.
CREATE TABLE {{app}}.sso_domain_verifications (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  provider_id text NOT NULL REFERENCES {{app}}.sso_providers(id) ON DELETE CASCADE,
  domain text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '1 day',
  verified_at timestamptz,
  checked_at timestamptz,
  failed_checks integer NOT NULL DEFAULT 0 CHECK (failed_checks >= 0),
  PRIMARY KEY (org_id, provider_id, domain)
);
CREATE INDEX sso_domain_verifications_domain ON {{app}}.sso_domain_verifications (domain)
  WHERE verified_at IS NOT NULL;

-- Security administrators hear when a verified domain loses its verification.
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified'));
`,
};
