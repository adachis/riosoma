import { defineSettingsPage, defineSettingItems } from '../Setting';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { UnitAdminRole, UnitPolicyKey, UnitPreset } from '@riosoma/contracts';

export const policyLabels: Record<UnitPolicyKey, MessageDescriptor> = {
  auditRetentionDays: msg({
    id: 'orgUnits.policy.auditRetentionDays',
    message: 'Shortest audit retention, in days',
  }),
  passwordMinLength: msg({ id: 'orgUnits.policy.passwordMinLength', message: 'Shortest password allowed' }),
  requireMfa: msg({ id: 'orgUnits.policy.requireMfa', message: 'Require a second sign-in step' }),
  requireSso: msg({ id: 'orgUnits.policy.requireSso', message: 'Require single sign-on' }),
  sessionMaxDays: msg({ id: 'orgUnits.policy.sessionMaxDays', message: 'Longest session, in days' }),
  sessionIdleDays: msg({ id: 'orgUnits.policy.sessionIdleDays', message: 'Longest idle session, in days' }),
  publicLinks: msg({ id: 'orgUnits.policy.publicLinks', message: 'Public links and forms' }),
  guestInvitations: msg({ id: 'orgUnits.policy.guestInvitations', message: 'Inviting guests' }),
  externalSharing: msg({
    id: 'orgUnits.policy.externalSharing',
    message: 'Sharing outside the organization',
  }),
  newPeopleSharing: msg({
    id: 'orgUnits.policy.newPeopleSharing',
    message: 'Sharing with people who aren’t members yet',
  }),
  newPeopleAdministratorsOnly: msg({
    id: 'orgUnits.policy.newPeopleAdministratorsOnly',
    message: 'Only People administrators may share with new people',
  }),
  newPeopleRole: msg({ id: 'orgUnits.policy.newPeopleRole', message: 'Role for new people' }),
  allowedEmailDomains: msg({ id: 'orgUnits.policy.allowedEmailDomains', message: 'Allowed email domains' }),
  calendarFeeds: msg({ id: 'orgUnits.policy.calendarFeeds', message: 'Calendar feeds' }),
  reportOutsideRecipients: msg({
    id: 'orgUnits.policy.reportOutsideRecipients',
    message: 'Scheduled reports to outside addresses',
  }),
  syncOut: msg({ id: 'orgUnits.policy.syncOut', message: 'Sync out to outside systems' }),
  automationSms: msg({ id: 'orgUnits.policy.automationSms', message: 'Text messages from automations' }),
  feedbackPublishing: msg({ id: 'orgUnits.policy.feedbackPublishing', message: 'Publishing feedback' }),
  aiEnabled: msg({ id: 'orgUnits.policy.aiEnabled', message: 'Rio' }),
  aiFields: msg({ id: 'orgUnits.policy.aiFields', message: 'AI fields' }),
  automationAi: msg({ id: 'orgUnits.policy.automationAi', message: 'Automation AI steps' }),
  aiDiagnose: msg({ id: 'orgUnits.policy.aiDiagnose', message: 'Diagnosing automation runs' }),
  aiRoutines: msg({ id: 'orgUnits.policy.aiRoutines', message: 'Routines' }),
  allowedThemes: msg({ id: 'orgUnits.policy.allowedThemes', message: 'Themes people can choose' }),
  guestLevel: msg({ id: 'orgUnits.policy.guestLevel', message: 'Highest level for guests' }),
  defaultTheme: msg({ id: 'orgUnits.policy.defaultTheme', message: 'Default theme' }),
  defaultLevel: msg({ id: 'orgUnits.policy.defaultLevel', message: 'Default experience level' }),
  defaultLocale: msg({ id: 'orgUnits.policy.defaultLocale', message: 'Default language' }),
};

export const roleLabels: Record<UnitAdminRole, MessageDescriptor> = {
  people: msg({ id: 'orgUnits.role.people', message: 'People' }),
  security: msg({ id: 'orgUnits.role.security', message: 'Security' }),
  data_sources: msg({ id: 'orgUnits.role.data_sources', message: 'Data Sources' }),
  ai: msg({ id: 'orgUnits.role.ai', message: 'AI' }),
  integrations: msg({ id: 'orgUnits.role.integrations', message: 'Integrations' }),
  audit: msg({ id: 'orgUnits.role.audit', message: 'Audit' }),
};

export const presetLabels: Record<UnitPreset, MessageDescriptor> = {
  open: msg({ id: 'orgUnits.preset.open', message: 'Open' }),
  balanced: msg({ id: 'orgUnits.preset.balanced', message: 'Balanced' }),
  strict: msg({ id: 'orgUnits.preset.strict', message: 'Strict' }),
  regulated: msg({ id: 'orgUnits.preset.regulated', message: 'Regulated' }),
};

export const auditLabels: Record<string, MessageDescriptor> = {
  'org.unit.created': msg({ id: 'orgUnits.audit.created', message: 'Unit created' }),
  'org.unit.updated': msg({ id: 'orgUnits.audit.updated', message: 'Unit renamed or moved' }),
  'org.unit.deleted': msg({ id: 'orgUnits.audit.deleted', message: 'Unit deleted' }),
  'org.unit.person_moved': msg({ id: 'orgUnits.audit.personMoved', message: 'Person moved' }),
  'org.unit.admin_changed': msg({ id: 'orgUnits.audit.adminChanged', message: 'Unit admin roles changed' }),
  'org.unit.policy_changed': msg({ id: 'orgUnits.audit.policyChanged', message: 'Unit policy changed' }),
  'org.unit.organization_policy_changed': msg({
    id: 'orgUnits.audit.organizationPolicyChanged',
    message: 'Organization policy changed',
  }),
  'org.unit.scim_mapping_changed': msg({
    id: 'orgUnits.audit.mappingChanged',
    message: 'Provisioning mappings changed',
  }),
  'org.unit.membership_imported': msg({ id: 'orgUnits.audit.imported', message: 'Unit placement imported' }),
  'org.second_step.reset': msg({ id: 'orgUnits.audit.secondStepReset', message: 'Second steps reset' }),
  'people.account.removed': msg({ id: 'orgUnits.audit.accountRemoved', message: 'Account removed' }),
};

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'org-units',
  label: msg({ id: 'settings.nav.orgUnits', message: 'Organizational units' }),
  roles: ['units-existing'],
});
export const unitSettings = defineSettingItems(settingsPage, {
  newPeopleSharing: { label: policyLabels.newPeopleSharing },
  newPeopleAdministratorsOnly: { label: policyLabels.newPeopleAdministratorsOnly },
  newPeopleRole: { label: policyLabels.newPeopleRole },
  allowedEmailDomains: { label: policyLabels.allowedEmailDomains },
  auditRetentionDays: { label: policyLabels.auditRetentionDays },
  passwordMinLength: { label: policyLabels.passwordMinLength },
  requireMfa: { label: policyLabels.requireMfa },
  requireSso: { label: policyLabels.requireSso },
  sessionMaxDays: { label: policyLabels.sessionMaxDays },
  sessionIdleDays: { label: policyLabels.sessionIdleDays },
  publicLinks: { label: policyLabels.publicLinks },
  guestInvitations: { label: policyLabels.guestInvitations },
  externalSharing: { label: policyLabels.externalSharing },
  calendarFeeds: { label: policyLabels.calendarFeeds },
  reportOutsideRecipients: { label: policyLabels.reportOutsideRecipients },
  syncOut: { label: policyLabels.syncOut },
  automationSms: { label: policyLabels.automationSms },
  feedbackPublishing: { label: policyLabels.feedbackPublishing },
  aiEnabled: { label: policyLabels.aiEnabled },
  aiFields: { label: policyLabels.aiFields },
  automationAi: { label: policyLabels.automationAi },
  aiDiagnose: { label: policyLabels.aiDiagnose },
  aiRoutines: { label: policyLabels.aiRoutines },
  allowedThemes: { label: policyLabels.allowedThemes },
  guestLevel: { label: policyLabels.guestLevel },
  defaultTheme: { label: policyLabels.defaultTheme },
  defaultLevel: { label: policyLabels.defaultLevel },
  defaultLocale: { label: policyLabels.defaultLocale },
});

export const sharingSettingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'sign-in-policy',
  label: msg({ id: 'mfa.nav.policy', message: 'Sign-in policy' }),
  roles: ['security'],
});
export const sharingSettings = defineSettingItems(sharingSettingsPage, {
  newPeopleSharing: { label: policyLabels.newPeopleSharing },
  newPeopleAdministratorsOnly: { label: policyLabels.newPeopleAdministratorsOnly },
  newPeopleRole: { label: policyLabels.newPeopleRole },
  allowedEmailDomains: { label: policyLabels.allowedEmailDomains },
});
