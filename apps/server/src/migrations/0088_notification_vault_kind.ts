import type { Migration } from '@riosoma/db';

/**
 * The alert for a vault that can't be reached when the organization's own notification connections
 * are read joins the kinds a notification may have.  A credential profile that failed keeps its
 * own kind, which points at the credential vaults instead.
 *
 * Replacing the constraint replaces the whole list, so it names every kind, not only the new one:
 * the 20 from 0073, `calendarEventKept` from 0083, and `vaultUnavailable`.  Keep this list and the
 * one in 0083 identical.  The runner applies a missing lower-numbered migration after newer ones,
 * so either may run last, and a shorter list would drop the other migration's kind.
 */
export const m0088: Migration = {
  id: '0088_notification_vault_kind',
  sql: `
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
