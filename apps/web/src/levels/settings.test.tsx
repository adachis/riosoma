import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import type { Level, SessionInfo } from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '../screens/settings/SettingsScreen';
import { json, personAt, renderAtLevel } from './testing';

vi.mock('../screens/settings/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../screens/settings/LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useLocation: () => ({ pathname: '/settings/appearance', href: '/settings/appearance' }),
  useParams: () => ({ section: 'appearance' }),
  useNavigate: () => () => {},
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Settings for a person, with the tokens they hold, and every request it made */
function settings(person: SessionInfo, tokens = 0) {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      if (url === '/api/tokens')
        return json(
          Array.from({ length: tokens }, (_, index) => ({ id: `tok${index}`, name: `Token ${index}` })),
        );
      return json({});
    }),
  );
  renderAtLevel(<SettingsScreen />, person);
  const nav = within(screen.getByRole('navigation', { name: 'Settings sections' }));
  return { nav, requests };
}

const at = (level: Level, kind: SessionInfo['membership']['kind'] = 'member') => personAt({ level, kind });

describe('personal access tokens in settings', () => {
  it('lists the section from Advanced, and below it only for someone who already has tokens', async () => {
    const standard = settings(at('standard'));
    await waitFor(() => expect(standard.requests).toContain('/api/tokens'));
    expect(standard.nav.queryByRole('link', { name: 'Personal access tokens' })).toBeNull();
    cleanup();

    const holder = settings(at('simple'), 2);
    expect(await holder.nav.findByRole('link', { name: 'Personal access tokens' })).toBeDefined();
    cleanup();

    // At Advanced the section is there without asking what the person holds.
    const advanced = settings(at('advanced'));
    expect(advanced.nav.getByRole('link', { name: 'Personal access tokens' })).toBeDefined();
    expect(advanced.requests).not.toContain('/api/tokens');
  });

  it('never lists tokens for a guest, who can’t hold any', async () => {
    const guest = settings(at('advanced', 'guest'), 2);
    expect(guest.nav.getByRole('link', { name: 'Experience level' })).toBeDefined();
    expect(guest.nav.queryByRole('link', { name: 'Personal access tokens' })).toBeNull();
    expect(guest.requests).not.toContain('/api/tokens');
  });
});

describe('admin settings', () => {
  it('are never tidied, whatever the level', () => {
    const { nav } = settings(at('simple', 'owner'));
    for (const name of [
      'People',
      'Single sign-on',
      'Provisioning',
      'Sign-in policy',
      'Data sources',
      'Export and import',
    ])
      expect(nav.getByRole('link', { name })).toBeDefined();
  });
});
