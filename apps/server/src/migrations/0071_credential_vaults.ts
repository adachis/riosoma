import type { Migration } from '@riosoma/db';

export const m0071: Migration = {
  id: '0071_credential_vaults',
  sql: `
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK
  (kind IN ('mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
    'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
    'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged', 'credentialVaultUnavailable'));
CREATE TABLE {{app}}.credential_policies (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  profile text NOT NULL DEFAULT 'database',
  key_id text NOT NULL DEFAULT 'instance',
  failed_profiles text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE {{app}}.credential_keys (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  id text NOT NULL,
  wrapped text NOT NULL,
  PRIMARY KEY (org_id, id)
);
CREATE TABLE {{app}}.credential_jobs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  actor_id text REFERENCES {{app}}.users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('move', 'rotate', 'migrate', 'undo')),
  previous jsonb NOT NULL,
  target jsonb NOT NULL,
  cursor text NOT NULL DEFAULT '',
  processed integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'failed', 'finished')),
  error text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE UNIQUE INDEX credential_jobs_running ON {{app}}.credential_jobs (org_id) WHERE state = 'running';
`,
};
