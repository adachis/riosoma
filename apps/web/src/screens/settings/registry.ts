import './settings-registry';
import type { I18n } from '@lingui/core';
import type { SessionInfo } from '@riosoma/contracts';
import { settingsRegistry } from 'virtual:settings-registry';
import { runsServer } from '../../features/updates/query';
import { canOpenUnits } from './units/access';
import type { SettingDefinition, SettingRole } from './Setting';

export { settingsRegistry };

function hasRole(session: SessionInfo, role: SettingRole): boolean {
  const member = session.membership;
  if (role === 'personal') return true;
  if (role === 'account') return member.kind !== 'guest';
  if (role === 'server') return runsServer(session);
  if (role === 'units') return canOpenUnits(session);
  if (role === 'units-existing') return Boolean(session.hasUnits) && canOpenUnits(session);
  if (member.kind === 'owner') return true;
  if (member.kind === 'guest' || role === 'owner') return false;
  if (role === 'admin') return member.adminRoles.length > 0;
  if (role.startsWith('organization-')) return member.adminRoles.includes(role.slice('organization-'.length));
  return (
    member.adminRoles.includes(role) ||
    (['people', 'data_sources', 'ai'].includes(role) &&
      Boolean(member.unitAdminGrants?.some((grant) => grant.roles.some((granted) => granted === role))))
  );
}

export function visibleSettings(session: SessionInfo | null): SettingDefinition[] {
  return settingsRegistry.filter((setting) => canSeeSetting(session, setting));
}

export function canSeeSetting(
  session: SessionInfo | null,
  setting: Pick<SettingDefinition, 'roles' | 'requiredRoles'>,
): boolean {
  return Boolean(
    session?.membership &&
    setting.roles.some((role) => hasRole(session, role)) &&
    (setting.requiredRoles?.every((role) => hasRole(session, role)) ?? true),
  );
}

export function settingHref(
  setting: Pick<SettingDefinition, 'area' | 'section' | 'page'> & { id?: string },
): string {
  return `/${[setting.area === 'admin' ? 'admin' : 'settings', setting.section, setting.page, setting.id]
    .filter(Boolean)
    .map((part) => encodeURIComponent(part!))
    .join('/')}`;
}

export function settingWords(i18n: I18n, setting: SettingDefinition) {
  return {
    label: i18n._(setting.label),
    pageLabel: i18n._(setting.pageLabel),
    keywords: setting.keywords ? i18n._(setting.keywords) : '',
    help: setting.help ? i18n._(setting.help) : '',
  };
}

const normalize = (text: string, locale: string) =>
  text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase(locale);

export function searchSettings(i18n: I18n, session: SessionInfo | null, query: string): SettingDefinition[] {
  const terms = normalize(query.trim(), i18n.locale).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return visibleSettings(session).filter((setting) => {
    const words = settingWords(i18n, setting);
    const text = normalize(Object.values(words).join(' '), i18n.locale);
    return terms.every((term) => text.includes(term));
  });
}
