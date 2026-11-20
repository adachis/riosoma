import type { Migration } from '@riosoma/db';

export const m0083: Migration = {
  id: '0083_automation_steps',
  sql: `
ALTER TABLE {{app}}.automation_runs ADD COLUMN ai_reserved_usd numeric NOT NULL DEFAULT 0;
ALTER TABLE {{app}}.oauth_apps ADD COLUMN tenant_id text NOT NULL DEFAULT '';
ALTER TABLE {{app}}.ai_usage DROP CONSTRAINT ai_usage_feature_check;
ALTER TABLE {{app}}.ai_usage ADD CONSTRAINT ai_usage_feature_check
  CHECK (feature IN ('rio', 'aiFields', 'diagnose', 'routines', 'embedding', 'search', 'automations'));

-- Calendar events an undo removed from its history, waiting to be removed from the calendar too.
-- The undo writes a row in its own transaction, and a worker removes the event after the commit,
-- trying again after a passing failure, so a crash or an unreachable service never loses one.
CREATE TABLE {{app}}.calendar_removals (
  -- The undo's inverse command, so the same reversal never queues twice
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  database_id text NOT NULL REFERENCES {{app}}.databases(id) ON DELETE CASCADE,
  automation_id text NOT NULL,
  -- The person whose calendar connection created the event, and who undid it
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  -- The undo request, so its response can say how many removals are still waiting
  command_id text NOT NULL,
  provider text NOT NULL,
  calendar_id text NOT NULL,
  event_id text NOT NULL,
  account_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  lease_at timestamptz,
  lease_token text,
  created_at timestamptz NOT NULL,
  -- Set when the calendar refused or the tries ran out.  The row stays, so a redo still keeps the
  -- original event, and the person is told why it stayed.
  failed_at timestamptz,
  failure_key text
);
CREATE INDEX calendar_removals_due ON {{app}}.calendar_removals (next_attempt_at) WHERE failed_at IS NULL;
CREATE INDEX calendar_removals_command ON {{app}}.calendar_removals (org_id, command_id);
CREATE INDEX calendar_removals_event ON {{app}}.calendar_removals (org_id, event_id);
CREATE INDEX calendar_removals_failed ON {{app}}.calendar_removals (failed_at) WHERE failed_at IS NOT NULL;

-- Telling a person an event stayed in their calendar after an undo.  Migration 0088 replaces this
-- same constraint, and a missing lower-numbered migration can run after a newer one, so both must
-- name the same 22 kinds, whichever runs last.  Keep this list and 0088's identical.
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
  'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
  'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged',
  'credentialVaultUnavailable', 'securityEvent', 'backupFailed', 'updateFailed', 'calendarEventKept',
  'vaultUnavailable'
));
`,
};
