import './settings-registry';
import type { SettingsPage, SettingDefinition, SettingRole } from 'virtual:settings-registry';
export type { SettingsPage, SettingDefinition, SettingRole } from 'virtual:settings-registry';
import type { MessageDescriptor } from '@lingui/core';
import type { ReactNode } from 'react';

/** The build reads these declarations without importing a screen's feature dependencies. */
export function defineSettingsPage(page: SettingsPage): SettingsPage {
  return page;
}

type Item = Pick<SettingDefinition, 'label' | 'help' | 'keywords' | 'requiredRoles'> & {
  roles?: readonly SettingRole[];
};

/** Dynamic rows keep their messages in the same map the screen renders. */
export function defineSettingItems<T extends Record<string, Item>>(
  page: SettingsPage,
  items: T,
): Record<keyof T, SettingDefinition> {
  return Object.fromEntries(
    Object.entries(items).map(([id, item]) => [id, { ...page, pageLabel: page.label, ...item, id }]),
  ) as Record<keyof T, SettingDefinition>;
}

export function SettingItem({
  definition,
  children,
  as: Tag = 'div',
  className,
}: {
  definition: SettingDefinition;
  children: ReactNode;
  as?: 'div' | 'tr' | 'fieldset' | 'label';
  className?: string;
}) {
  return (
    <Tag
      className={['rio-setting', className].filter(Boolean).join(' ')}
      data-setting-id={definition.id}
      data-setting-page={definition.page}
      tabIndex={-1}
    >
      {children}
    </Tag>
  );
}

export interface SettingProps {
  page: SettingsPage;
  id: string;
  label: MessageDescriptor;
  keywords?: MessageDescriptor;
  help?: MessageDescriptor;
  roles?: readonly SettingRole[];
  requiredRoles?: readonly SettingRole[];
  children: ReactNode;
}

/** A focusable destination surrounds the actual control, including its label and help. */
export function Setting({ page, id, children }: SettingProps) {
  return (
    <div className="rio-setting" data-setting-id={id} data-setting-page={page.page} tabIndex={-1}>
      {children}
    </div>
  );
}
