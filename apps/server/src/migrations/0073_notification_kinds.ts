import type { Migration } from '@riosoma/db';

/** Migration 0071 replaced the kind list without the admin alert kinds, so this one names them all. */
export const m0073: Migration = {
  id: '0073_notification_kinds',
  sql: `
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
  'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
  'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged',
  'credentialVaultUnavailable', 'securityEvent', 'backupFailed', 'updateFailed'
));
`,
};
