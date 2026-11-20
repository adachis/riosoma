import type { SettingDefinition } from './Setting';
import { settingHref } from './registry';

/** Keep the longest visible prefix, including when a saved link outlives a person's role. */
export function resolveSettingsPath(pathname: string, settings: readonly SettingDefinition[]) {
  const parts = pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return '';
      }
    });
  const area = parts[0] === 'admin' ? 'admin' : 'personal';
  const available = settings.filter((setting) => setting.area === area);
  const base = area === 'admin' ? '/admin' : '/settings';
  const fallback = available.find((setting) => setting.page === 'appearance') ?? available[0];
  if (area === 'admin' && !available.length) return { page: 'appearance', repair: '/settings' };
  // Existing page links retain their address and can also carry a setting suffix.
  const canonical = available.some((setting) => setting.section === parts[1] && setting.page === parts[2]);
  const legacy = !canonical && area === 'personal' && settings.find((setting) => setting.page === parts[1]);
  if (legacy) {
    const target = settings.find((setting) => setting.page === legacy.page && setting.id === parts[2]);
    const valid = parts.length <= 2 || (parts.length === 3 && target);
    return {
      page: legacy.page,
      target: valid ? target : undefined,
      repair: valid ? undefined : `/settings/${legacy.page}${target ? `/${target.id}` : ''}`,
    };
  }
  const section = available.filter((setting) => setting.section === parts[1]);
  if (parts.length > 1 && !section.length) return { page: fallback?.page, repair: base };
  const page = section.find((setting) => setting.page === parts[2]);
  if (parts.length > 2 && !page)
    return { page: section[0]?.page ?? fallback?.page, repair: `${base}/${encodeURIComponent(parts[1]!)}` };
  const target = page && section.find((setting) => setting.page === page.page && setting.id === parts[3]);
  return {
    page: page?.page ?? section[0]?.page ?? fallback?.page,
    target: parts.length === 4 ? target : undefined,
    repair:
      parts.length > 3 && (!target || parts.length > 4) && page
        ? settingHref(target ?? { area: page.area, section: page.section, page: page.page })
        : undefined,
  };
}
