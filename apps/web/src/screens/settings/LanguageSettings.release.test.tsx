import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type * as LocaleModule from '@riosoma/i18n';
import { renderSharing } from '../database/share/testing';
import { LanguageSettings } from './LanguageSettings';
import { PolicyField, POLICY_GROUPS } from './units/PolicyFields';

const build = vi.hoisted(() => ({ locales: ['en-US'] }));
vi.mock('@riosoma/i18n', async (original) => {
  const module = await original<typeof LocaleModule>();
  return {
    ...module,
    get HAS_LANGUAGE_CHOICE() {
      return build.locales.length > 1;
    },
    get LOCALES() {
      return module.LOCALES.filter((locale) => build.locales.includes(locale.code));
    },
  };
});

afterEach(cleanup);

it('hides the personal and organization language controls in an English-only release', () => {
  const view = renderSharing(
    <>
      <LanguageSettings />
      <PolicyField setting="defaultLocale" value="fr" isDisabled={false} onChange={() => {}} />
    </>,
  );
  expect(view.queryByRole('radiogroup', { name: 'Language' })).toBeNull();
  expect(view.queryByRole('button', { name: /Default language/ })).toBeNull();
  expect(view.container.childElementCount).toBe(0);
  expect(POLICY_GROUPS.flatMap((group) => group.keys)).not.toContain('defaultLocale');
  view.client.clear();
});

it('shows exactly the two enabled languages in personal settings', () => {
  build.locales = ['en-US', 'fr'];
  const view = renderSharing(<LanguageSettings />);
  expect(view.getByRole('radiogroup', { name: 'Language' })).toBeTruthy();
  expect(view.getAllByRole('radio').map((control) => control.getAttribute('value'))).toEqual(['en-US', 'fr']);
  expect(view.queryByText('Español')).toBeNull();
  view.client.clear();
});
