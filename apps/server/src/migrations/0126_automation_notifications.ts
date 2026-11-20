import type { Migration } from '@riosoma/db';

/** The shared list retains every notification source when migrations arrive out of order. */
export const m0126: Migration = {
  id: '0126_automation_notifications',
  sql: `
ALTER TABLE {{app}}.notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE {{app}}.notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'mention', 'share', 'automationStopped', 'automationFailed', 'syncFailed', 'syncHeld',
  'reportStopped', 'feedbackReply', 'fileScan', 'webhookFailed', 'domainUnverified',
  'customDomainUnverified', 'routineReport', 'routineApproval', 'routinePaused', 'adminRolesChanged',
  'credentialVaultUnavailable', 'securityEvent', 'backupFailed', 'updateFailed', 'calendarEventKept',
  'vaultUnavailable', 'automationNotification'
));
`,
};
