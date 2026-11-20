import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupI18n } from '@lingui/core';
import { cleanup, render } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  collectSettings,
  settingsPages,
  settingsSources,
  unregisteredSettings,
  readSettingsScreen,
} from '../../../build/settings-registry';
import { CelebrationSettings } from '../../features/celebrations/CelebrationSettings';
import { renderSharing, session } from '../database/share/testing';
import { LanguageSettings } from './LanguageSettings';
import { searchSettings, settingHref, settingsRegistry, visibleSettings } from './registry';
import { resolveSettingsPath } from './paths';
import { Setting } from './Setting';
import { useSettingTarget } from './useSettingTarget';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<object>()),
  useLocation: () => ({
    href: '/settings/preferences/language/language',
    pathname: '/settings/preferences/language/language',
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function TargetProbe() {
  const body = useRef<HTMLElement>(null);
  const target = settingsRegistry.find(
    (setting) => setting.page === 'language' && setting.id === 'language',
  )!;
  useSettingTarget(body, target);
  return (
    <section ref={body}>
      <Setting page={target} id={target.id} label={target.label}>
        <input aria-label="Language" />
      </Setting>
    </section>
  );
}

it('keeps a deep-link target focused and highlighted through repeated mount checks', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  const { container } = render(
    <StrictMode>
      <TargetProbe />
    </StrictMode>,
  );
  expect(document.activeElement).toBe(container.querySelector('input'));
  expect(container.querySelector<HTMLElement>('[data-setting-id]')?.dataset.settingHighlighted).toBe('true');
  expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'instant' });
});

it('builds every settings page from its rendered declarations and rejects unregistered controls', () => {
  const root = join(import.meta.dirname, '../..');
  const rows = collectSettings();
  expect(new Set(rows.map((row) => row.page))).toEqual(new Set(settingsPages()));
  for (const file of settingsSources(root)) {
    const source = readFileSync(file, 'utf8');
    if (source.includes('defineSettingsPage(')) expect(unregisteredSettings(source, file), file).toEqual([]);
  }
  const language = readFileSync(join(import.meta.dirname, 'LanguageSettings.tsx'), 'utf8');
  const changed = language.replace(
    '<div data-anchor="settings.language">',
    '<div data-anchor="settings.language"><TextField label={t({ id: "test.newSetting", message: "New setting" })} />',
  );
  expect(unregisteredSettings(changed, 'LanguageSettings.tsx')).toEqual([
    expect.stringContaining('TextField renders without a registered setting'),
  ]);
  const unwrapped = language.replace(/<Setting\b[\s\S]*?>|<\/Setting>/g, '');
  expect(unregisteredSettings(unwrapped, 'LanguageSettings.tsx')).toEqual([
    expect.stringContaining('RadioGroup renders without a registered setting'),
  ]);
  expect(rows.every((row) => row.label.id && row.pageLabel.id && Array.isArray(row.roles))).toBe(true);
  const renamed = language.replace(
    "label={t({ id: 'settings.language.label'",
    "label={t({ id: 'settings.language.renamed'",
  );
  expect(() => readSettingsScreen(renamed, 'LanguageSettings.tsx')).toThrow(
    'label differs from its rendered control',
  );
});

it('every rendered personal control has an individual registry entry', () => {
  const rendered = renderSharing(
    <>
      <LanguageSettings />
      <CelebrationSettings />
    </>,
  );
  for (const control of rendered.container.querySelectorAll('[role="radiogroup"]')) {
    const setting = control.closest<HTMLElement>('[data-setting-id]');
    expect(setting?.dataset.settingId).not.toBe('overview');
    expect(
      settingsRegistry.some(
        (entry) => entry.page === setting?.dataset.settingPage && entry.id === setting.dataset.settingId,
      ),
    ).toBe(true);
  }
  rendered.client.clear();
});

it('follows imported child components, aliases, and re-exports when checking settings controls', () => {
  const root = join(import.meta.dirname, 'registry-fixture');
  const sources: Record<string, string> = {
    [join(root, 'AiSettings.tsx')]: `
      import { Child as ImportedChild } from './children';
      export function AiSettings() { return <ImportedChild /> }
    `,
    [join(root, 'children.ts')]: `export { Child } from './Child'`,
    [join(root, 'Child.tsx')]: `
      import Zone from './Zone';
      export function Child() { return <Zone /> }
    `,
    [join(root, 'Zone.tsx')]: `
      export default function Zone() { return <ComboBox label={t({ id: 'test.zone' })} /> }
    `,
  };
  const filename = join(root, 'AiSettings.tsx');
  expect(unregisteredSettings(sources[filename]!, filename, (file) => sources[file])).toEqual([
    expect.stringContaining('Zone.tsx:2: ComboBox renders without a registered setting'),
  ]);
  sources[filename] = `
    import { Child as ImportedChild } from './children';
    export function AiSettings() {
      return <Setting id="zone"><ImportedChild /></Setting>
    }
  `;
  expect(unregisteredSettings(sources[filename]!, filename, (file) => sources[file])).toEqual([]);
});

it('finds imported electricity controls and gives each model tier its own destination', () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  for (const [query, id] of [
    ['Electricity zone', 'electricity-zone'],
    ['Quick answers', 'everyday'],
    ['Thorough work', 'power'],
  ]) {
    const results = searchSettings(i18n, session, query!);
    expect(results.some((setting) => setting.page === 'ai' && setting.id === id)).toBe(true);
    const target = results.find((setting) => setting.page === 'ai' && setting.id === id)!;
    expect(resolveSettingsPath(settingHref(target), visibleSettings(session)).target).toBe(target);
  }
});

it('finds personal autonomy for a member and resolves its AI deep link before the legacy admin page', () => {
  const member = { ...session, membership: { kind: 'member' as const, adminRoles: [] } };
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  for (const identity of [member, session]) {
    const target = searchSettings(i18n, identity, 'personal autonomy').find(
      (setting) => setting.page === 'rio',
    )!;
    expect(target).toBeDefined();
    expect(settingHref(target)).toBe('/settings/ai/rio/autonomy');
    expect(resolveSettingsPath(settingHref(target), visibleSettings(identity)).target).toBe(target);
  }
});

it('searches the tenant description in the reader’s language', () => {
  const i18n = setupI18n({
    locale: 'fr',
    messages: { fr: { 'sso.field.tenantHelp': 'Autoriser tous les comptes professionnels ou scolaires' } },
  });
  expect(searchSettings(i18n, session, 'comptes professionnels').map((setting) => setting.id)).toContain(
    'provider-tenant',
  );
  i18n.loadAndActivate({ locale: 'en-US', messages: {} });
  expect(searchSettings(i18n, session, 'any work or school account').map((setting) => setting.id)).toContain(
    'provider-tenant',
  );
});

it('keeps organization library limits out of delegated administrator results', () => {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const delegated = {
    ...session,
    membership: {
      kind: 'member' as const,
      adminRoles: [],
      unitAdminGrants: [{ unitId: 'unit_test', roles: ['ai' as const] }],
    },
  };
  const organization = { ...delegated, membership: { ...delegated.membership, adminRoles: ['ai'] } };
  for (const id of [
    'libraries-count-limit',
    'libraries-size-limit',
    'libraries-text-limit',
    'libraries-search-power',
    'libraries-classification-rules',
  ]) {
    const setting = settingsRegistry.find((entry) => entry.id === id)!;
    expect(visibleSettings(delegated)).not.toContain(setting);
    expect(searchSettings(i18n, delegated, i18n._(setting.label))).not.toContain(setting);
    expect(visibleSettings(organization)).toContain(setting);
  }
});

it('requires both organization roles and existing units for directory mapping destinations', () => {
  const target = settingsRegistry.find((setting) => setting.id === 'unit-mappings')!;
  for (const [hasUnits, adminRoles, shown] of [
    [true, ['security', 'people'], true],
    [true, ['security'], false],
    [true, ['people'], false],
    [false, ['security', 'people'], false],
  ] as const) {
    const identity = {
      ...session,
      hasUnits,
      membership: { kind: 'member' as const, adminRoles: [...adminRoles] },
    };
    expect(visibleSettings(identity).includes(target)).toBe(shown);
  }
});

it('searches translated labels, keywords, and help and folds accents in the reader’s language', () => {
  const i18n = setupI18n({
    locale: 'fr',
    messages: {
      fr: {
        'settings.language.label': 'Langue',
        'settings.nav.language': 'Langue',
        'settings.language.note': 'Dates et courriels selon votre préférence',
        'settings.search.keywords.language': 'traduction paramètres régionaux',
      },
    },
  });
  for (const query of ['langue', 'regionaux', 'courriels', 'preference']) {
    expect(
      searchSettings(i18n, session, query).some(
        (setting) => setting.page === 'language' && setting.id === 'language',
      ),
    ).toBe(true);
  }
  expect(searchSettings(i18n, session, 'unmatched')).toEqual([]);
  expect(searchSettings(i18n, session, '   ')).toEqual([]);
});

it('uses setting roles for members, guests, admins, and delegated administrators', () => {
  const member = { ...session, membership: { kind: 'member' as const, adminRoles: [] } };
  const guest = { ...session, membership: { kind: 'guest' as const, adminRoles: [] } };
  expect(visibleSettings(null)).toEqual([]);
  expect(visibleSettings(member).some((setting) => setting.page === 'files')).toBe(false);
  expect(
    visibleSettings(member).some((setting) => setting.id === 'default' && setting.page === 'levels'),
  ).toBe(false);
  expect(visibleSettings(guest).some((setting) => setting.page === 'tokens')).toBe(false);
  expect(visibleSettings(guest).some((setting) => setting.page === 'language')).toBe(true);
  const security = { ...member, membership: { ...member.membership, adminRoles: ['security'] } };
  expect(visibleSettings(security).some((setting) => setting.page === 'files')).toBe(true);
  expect(visibleSettings(security).some((setting) => setting.page === 'feedback')).toBe(false);
  const delegated = {
    ...member,
    hasUnits: true,
    membership: { ...member.membership, unitAdminGrants: [{ unitId: 'unit_test', roles: ['ai' as const] }] },
  };
  expect(
    visibleSettings(delegated).some((setting) => setting.page === 'ai' && setting.id === 'overview'),
  ).toBe(true);
  expect(visibleSettings(delegated).some((setting) => setting.page === 'ai' && setting.id === 'budget')).toBe(
    false,
  );
});

it('keeps legacy links, resolves canonical links, and strips only the invalid suffix', () => {
  const available = visibleSettings(session);
  expect(resolveSettingsPath('/settings/files', available).page).toBe('files');
  const language = available.find((setting) => setting.page === 'language' && setting.id === 'language')!;
  expect(settingHref(language)).toBe('/settings/preferences/language/language');
  expect(resolveSettingsPath(settingHref(language), available).target).toBe(language);
  expect(resolveSettingsPath('/admin/security/files/max-upload-bytes', available).target?.page).toBe('files');
  expect(resolveSettingsPath('/admin/security/files/missing', available).repair).toBe(
    '/admin/security/files',
  );
  expect(resolveSettingsPath('/admin/security/missing/setting', available).repair).toBe('/admin/security');
  expect(resolveSettingsPath('/admin/missing/page/setting', available).repair).toBe('/admin');
  expect(resolveSettingsPath('/admin/security/files/max-upload-bytes/extra', available).repair).toBe(
    '/admin/security/files/max-upload-bytes',
  );
  const member = { ...session, membership: { kind: 'member' as const, adminRoles: [] } };
  expect(
    resolveSettingsPath('/admin/security/files/max-upload-bytes', visibleSettings(member)).target,
  ).toBeUndefined();
});
