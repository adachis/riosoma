import type { Migration } from '@riosoma/db';

export const m0070: Migration = {
  id: '0070_notification_channels',
  sql: `
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
  'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
  'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged',
  'credentialVaultUnavailable', 'securityEvent', 'backupFailed', 'updateFailed'
));
ALTER TABLE {{app}}.notifications ADD COLUMN channels_queued boolean NOT NULL DEFAULT false;
ALTER TABLE {{app}}.notifications ADD COLUMN digested_at timestamptz;
UPDATE {{app}}.notifications SET channels_queued = true;
ALTER TABLE {{app}}.notification_preferences ADD COLUMN channels jsonb NOT NULL DEFAULT '{}';
ALTER TABLE {{app}}.notification_preferences ADD COLUMN digest jsonb NOT NULL DEFAULT '{"frequency":"off","hour":9,"timeZone":"UTC"}';
ALTER TABLE {{app}}.notification_preferences ADD COLUMN digest_slot text;
CREATE TABLE {{app}}.notification_organizations (
  org_id text PRIMARY KEY REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  enabled jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE {{app}}.notification_credentials (
  scope_key text NOT NULL,
  org_id text REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  sealed text NOT NULL,
  PRIMARY KEY (scope_key, name),
  CHECK ((scope_key = 'install' AND org_id IS NULL) OR (org_id IS NOT NULL AND scope_key = org_id))
);
CREATE TABLE {{app}}.notification_devices (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  sealed text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_devices_person ON {{app}}.notification_devices(org_id, user_id);
CREATE TABLE {{app}}.notification_phones (
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  sealed text NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE {{app}}.notification_actions (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  before jsonb NOT NULL,
  after jsonb NOT NULL,
  undone boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE {{app}}.notification_deliveries (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES {{app}}.orgs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES {{app}}.users(id) ON DELETE CASCADE,
  notification_id text REFERENCES {{app}}.notifications(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('push', 'slack', 'teams', 'sms', 'digest', 'verify')),
  device_id text,
  attempted_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_deliveries_pending ON {{app}}.notification_deliveries(created_at) WHERE state = 'pending';
CREATE INDEX notification_deliveries_rate ON {{app}}.notification_deliveries(org_id, user_id, channel, created_at);
CREATE INDEX notification_deliveries_sms_rate ON {{app}}.notification_deliveries(org_id, user_id, attempted_at) WHERE channel = 'sms' AND attempted_at IS NOT NULL;
CREATE TABLE {{app}}.notification_alert_events (
  event_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
};
