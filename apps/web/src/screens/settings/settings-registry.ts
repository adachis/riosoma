declare module 'virtual:settings-registry' {
  import type { MessageDescriptor } from '@lingui/core';
  export type SettingRole =
    | 'personal'
    | 'account'
    | 'owner'
    | 'admin'
    | 'security'
    | 'people'
    | 'organization-people'
    | 'integrations'
    | 'data_sources'
    | 'ai'
    | 'organization-ai'
    | 'audit'
    | 'feedback'
    | 'units'
    | 'units-existing'
    | 'server';

  export interface SettingsPage {
    area: 'personal' | 'admin';
    section: string;
    page: string;
    label: MessageDescriptor;
    roles: readonly SettingRole[];
    keywords?: MessageDescriptor;
    requiredRoles?: readonly SettingRole[];
  }

  export interface SettingDefinition extends SettingsPage {
    id: string;
    label: MessageDescriptor;
    pageLabel: MessageDescriptor;
    help?: MessageDescriptor;
  }
  export const settingsRegistry: readonly SettingDefinition[];
}
