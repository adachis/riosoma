import { describe, expect, it } from 'vitest';
import {
  ADMIN_NOTIFICATION_KINDS,
  adminNotification,
  DEFAULT_NOTIFICATION_EMAIL,
  MarkNotificationsRead,
  NOTIFICATION_KINDS,
  NotificationEmail,
  NotificationPreferencesUpdate,
  NotificationTarget,
  idKind,
  newId,
  notificationPath,
} from './index.js';

const databaseId = newId('database');
const tableId = newId('table');
const viewId = newId('view');
const recordId = newId('record');
const automationId = newId('automation');
const target = { databaseId, databaseName: 'Sales' };

describe('notifications', () => {
  it('get their own kind of ID', () => {
    expect(idKind(newId('notification'))).toBe('notification');
  });

  it('lead to the record, the database, the automation, the synced table, or the report’s view', () => {
    expect(
      notificationPath({ kind: 'mention', target: { ...target, tableId, viewId, recordId, excerpt: 'Hi' } }),
    ).toBe(`/${databaseId}/${tableId}/${viewId}/${recordId}`);
    // Without a view to open it in, a mention opens the table.
    expect(notificationPath({ kind: 'mention', target: { ...target, tableId, recordId } })).toBe(
      `/${databaseId}/${tableId}`,
    );
    expect(notificationPath({ kind: 'share', target: { ...target, role: 'editor' } })).toBe(`/${databaseId}`);
    for (const kind of ['automationStopped', 'automationFailed', 'calendarEventKept'] as const)
      expect(notificationPath({ kind, target: { ...target, automationId } })).toBe(
        `/${databaseId}/automations/${automationId}`,
      );
    for (const kind of [
      'syncFailed',
      'syncHeld',
      'ingest.question',
      'ingest.file.read',
      'ingest.file.held',
      'ingest.sender.unapproved',
      'ingest.format.needsApproval',
      'ingest.paused',
    ] as const)
      expect(notificationPath({ kind, target: { ...target, tableId } })).toBe(`/${databaseId}/${tableId}`);
    const reportId = newId('report');
    expect(
      notificationPath({ kind: 'reportStopped', target: { ...target, tableId, viewId, reportId } }),
    ).toBe(`/${databaseId}/${tableId}/${viewId}`);
    // A reply to feedback belongs to no database, and opens what the person sent.
    expect(notificationPath({ kind: 'feedbackReply', target: { feedbackId: newId('feedback') } })).toBe(
      '/settings/my-feedback',
    );
    // A webhook's failed post opens the sources, where its delivery log is.
    expect(notificationPath({ kind: 'webhookFailed', target: { sourceId: newId('source') } })).toBe(
      '/settings/sources',
    );
    // A domain that lost its verification opens the provisioning settings, where it's verified again.
    expect(notificationPath({ kind: 'domainUnverified', target: { domain: 'example.test' } })).toBe(
      '/settings/scim',
    );
    // A custom domain that lost its verification opens the custom domain settings.
    expect(
      notificationPath({ kind: 'customDomainUnverified', target: { domain: 'forms.example.test' } }),
    ).toBe('/settings/custom-domains');
    // A vault that can't be reached opens the organization's own channels, where its connections
    // are, and a credential profile that failed opens the credential vaults.
    expect(notificationPath({ kind: 'vaultUnavailable', target: {} })).toBe(
      '/settings/notifications#organization',
    );
    expect(notificationPath({ kind: 'credentialVaultUnavailable', target: {} })).toBe(
      '/settings/credential-vaults',
    );
    // News about a routine opens the routine, whatever the news.
    const routineId = newId('routine');
    for (const kind of ['routineReport', 'routineApproval', 'routinePaused'] as const)
      expect(notificationPath({ kind, target: { ...target, routineId } })).toBe(
        `/${databaseId}/routines/${routineId}`,
      );
  });

  it('alerts administrators about a vault that can’t be reached', () => {
    expect(NOTIFICATION_KINDS).toContain('vaultUnavailable');
    expect(ADMIN_NOTIFICATION_KINDS).toContain('vaultUnavailable');
    expect(adminNotification('vaultUnavailable')).toBe(true);
    // Administrators have to act on it, so email starts on.
    expect(DEFAULT_NOTIFICATION_EMAIL.vaultUnavailable).toBe(true);
    expect(NotificationEmail.parse(DEFAULT_NOTIFICATION_EMAIL).vaultUnavailable).toBe(true);
  });

  it('email the kinds people usually act on unless they choose otherwise', () => {
    expect(NotificationEmail.parse(DEFAULT_NOTIFICATION_EMAIL)).toEqual({
      adminRolesChanged: true,
      mention: true,
      share: true,
      automationStopped: true,
      automationFailed: false,
      syncFailed: false,
      syncHeld: true,
      reportStopped: true,
      feedbackReply: true,
      fileScan: false,
      webhookFailed: true,
      credentialVaultUnavailable: true,
      vaultUnavailable: true,
      domainUnverified: true,
      customDomainUnverified: true,
      routineReport: false,
      routineApproval: true,
      routinePaused: true,
      securityEvent: true,
      backupFailed: true,
      updateFailed: true,
      calendarEventKept: true,
      automationNotification: true,
      'ingest.question': true,
      'ingest.file.read': false,
      'ingest.file.held': true,
      'ingest.sender.unapproved': true,
      'ingest.format.needsApproval': true,
      'ingest.paused': true,
    });
    expect(Object.keys(DEFAULT_NOTIFICATION_EMAIL).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    expect(NotificationPreferencesUpdate.safeParse({ email: { syncFailed: true } }).success).toBe(true);
    expect(NotificationPreferencesUpdate.safeParse({ email: { birthdays: true } }).success).toBe(false);
  });

  it('check what they point at and what marks them read', () => {
    expect(NotificationTarget.safeParse({ ...target, excerpt: 'x'.repeat(141) }).success).toBe(false);
    expect(NotificationTarget.safeParse({ ...target, tableId: 'not-a-table' }).success).toBe(false);
    expect(MarkNotificationsRead.safeParse({ all: true }).success).toBe(true);
    expect(MarkNotificationsRead.safeParse({ ids: [newId('notification')] }).success).toBe(true);
    expect(MarkNotificationsRead.safeParse({ ids: [] }).success).toBe(false);
    expect(MarkNotificationsRead.safeParse({ all: false }).success).toBe(false);
  });
});
