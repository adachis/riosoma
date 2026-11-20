import { SettingsTestPage } from '../testing';
import type { ReactNode } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  UNIT_POLICY_KEYS,
  type EffectiveUnitPolicy,
  type OrgUnit,
  type SessionInfo,
  type UnitPolicyView,
} from '@riosoma/contracts';
import { SettingsScreen } from '../SettingsScreen';
import { json, personAt, renderAtLevel as renderPage } from '../../../levels/testing';
import { UnitSettings } from './UnitSettings';

const renderAtLevel = (children: ReactNode, identity: SessionInfo) =>
  renderPage(<SettingsTestPage>{children}</SettingsTestPage>, identity);

const place = vi.hoisted(() => ({ pathname: '/settings/appearance' }));

vi.mock('../AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../LanguageSettings', () => ({ LanguageSettings: () => null }));
vi.mock('../../../preferences', async (original) => ({
  ...(await original<object>()),
  themes: { list: async () => [], manifest: async () => ({}) },
}));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => undefined,
  useLocation: () => ({ pathname: place.pathname, href: place.pathname }),
  useParams: () => ({ section: 'appearance' }),
  useNavigate: () => () => {},
  Link: ({ params, children }: { params: { section: string }; children: ReactNode }) => (
    <a href={`/settings/${params.section}`}>{children}</a>
  ),
}));

afterEach(() => {
  place.pathname = '/settings/appearance';
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', window.location.pathname);
});

const research: OrgUnit = { id: 'oun_research', parentId: null, name: 'Research' };
const materials: OrgUnit = { id: 'oun_materials', parentId: research.id, name: 'Materials' };

function person(overrides: Partial<SessionInfo['membership']>, hasUnits: boolean): SessionInfo {
  const base = personAt({ level: 'advanced' });
  return { ...base, membership: { ...base.membership, ...overrides }, hasUnits };
}

/** A unit's policy screen: some settings its own, some from Research, the rest from the organization */
function policy(): UnitPolicyView {
  const origins = Object.fromEntries(
    UNIT_POLICY_KEYS.map((key) => [key, { id: null, name: 'Garden' }]),
  ) as EffectiveUnitPolicy['origins'];
  origins.passwordMinLength = { id: research.id, name: 'Research' };
  origins.publicLinks = { id: materials.id, name: 'Materials' };
  const values = {
    auditRetentionDays: 365,
    passwordMinLength: 16,
    requireMfa: false,
    requireSso: false,
    sessionMaxDays: 30,
    sessionIdleDays: 7,
    publicLinks: false,
    guestInvitations: true,
    externalSharing: true,
    newPeopleSharing: true,
    newPeopleAdministratorsOnly: false,
    newPeopleRole: 'guest',
    allowedEmailDomains: null,
    calendarFeeds: true,
    reportOutsideRecipients: false,
    syncOut: true,
    automationSms: false,
    feedbackPublishing: false,
    aiEnabled: true,
    aiFields: true,
    aiDiagnose: true,
    automationAi: true,
    aiRoutines: true,
    allowedThemes: null,
    guestLevel: 'advanced',
    defaultTheme: null,
    defaultLevel: 'standard',
    defaultLocale: null,
  } as const;
  return {
    values,
    origins,
    overridable: ['passwordMinLength', 'publicLinks', 'aiFields'],
    own: { publicLinks: false },
    inherited: { ...values, publicLinks: true },
    // The organization set this unit's own value, so a unit admin can't change it.
    setBy: { publicLinks: { id: null, name: 'Garden' } },
    changeable: ['passwordMinLength'],
  };
}

function server(pendingPreview = false) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      requests.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      if (pendingPreview && url.endsWith('/move') && String(init?.body).includes('"preview":true'))
        return new Promise<Response>(() => {});
      if (url === '/api/auth/session') return json(person({ kind: 'owner' }, true));
      if (url === '/api/org/units') return json([research, materials]);
      if (url === '/api/admin/unit-policy') return json(policy());
      if (url === `/api/org/units/${materials.id}/policy`) return json(policy());
      if (url === '/api/org/members') return json([]);
      if (url.endsWith('/admins')) return json([]);
      if (url.startsWith('/api/org/unit-audit')) return json([]);
      if (url === '/api/tokens') return json([]);
      return json({});
    }),
  );
  return requests;
}

describe('Organizational units in settings', () => {
  it('names the create and edit dialogs for assistive technology', async () => {
    server();
    renderAtLevel(<UnitSettings />, person({ kind: 'owner' }, true));
    const user = userEvent.setup();
    const add = await screen.findByRole('button', { name: 'Make a unit' });
    expect(add.getAttribute('data-icon-only')).toBe('true');
    expect(add.getAttribute('data-tooltip')).toBe('Make a unit');
    expect(add.textContent).toBe('');
    await user.click(add);
    const create = await screen.findByRole('dialog', { name: 'Make a unit' });
    expect(within(create).getByRole('textbox', { name: 'Name' })).toBeTruthy();
    await user.click(within(create).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Rename or move Materials' }));
    const edit = await screen.findByRole('dialog', { name: 'Rename or move' });
    expect(within(edit).getByRole('textbox', { name: 'Name' })).toHaveProperty('value', 'Materials');
  });

  it('opens a name deep link in a unit reached by the person’s People role', async () => {
    server();
    place.pathname = '/admin/organization/org-units/name';
    renderAtLevel(
      <UnitSettings />,
      person(
        { kind: 'member', adminRoles: [], unitAdminGrants: [{ unitId: materials.id, roles: ['people'] }] },
        true,
      ),
    );
    expect(((await screen.findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe(
      materials.name,
    );
    expect(screen.getByRole('button', { name: /Inside/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull();
  });

  it('commits an immediate parent move while its preview is pending', async () => {
    const requests = server(true);
    renderAtLevel(<UnitSettings />, person({ kind: 'owner' }, true));
    (await screen.findByRole('button', { name: 'Move Materials' })).focus();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/move'))).toHaveLength(2));
    expect(requests.filter((request) => request.url.endsWith('/move')).at(-1)?.body).toMatchObject({
      parentId: null,
    });
    expect(requests.filter((request) => request.url.endsWith('/move')).at(-1)?.body).not.toHaveProperty(
      'preview',
    );
  });

  it('checks a keyboard parent move before applying it and keeps unit selection in the address', async () => {
    const requests = server();
    const navigate = vi.spyOn(window.history, 'pushState');
    renderAtLevel(<UnitSettings />, person({ kind: 'owner' }, true));
    await userEvent.click(await screen.findByRole('button', { name: 'Materials' }));
    expect(navigate).toHaveBeenCalledWith(null, '', expect.stringContaining(`#unit=${materials.id}`));
    expect(window.location.hash).toBe(`#unit=${materials.id}`);
    screen.getByRole('button', { name: 'Move Materials' }).focus();
    await userEvent.keyboard(' {ArrowLeft}');
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/move'))).toHaveLength(1));
    expect(requests.find((request) => request.url.endsWith('/move'))?.body).toMatchObject({
      parentId: null,
      preview: true,
    });
    await waitFor(() => expect(document.querySelector('.rio-sortable-refusal')?.textContent).toBe(''));
    await userEvent.keyboard(' ');
    await waitFor(() => expect(requests.filter((request) => request.url.endsWith('/move'))).toHaveLength(2));
    expect(requests.filter((request) => request.url.endsWith('/move')).at(-1)?.body).toMatchObject({
      parentId: null,
    });
    expect(requests.filter((request) => request.url.endsWith('/move')).at(-1)?.body).not.toHaveProperty(
      'preview',
    );
  });

  it('stays out of the settings list until the first unit exists', async () => {
    const requests = server();
    renderAtLevel(<SettingsScreen />, person({ kind: 'owner' }, false));
    const nav = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    await waitFor(() => expect(nav.getByRole('link', { name: 'People' })).toBeDefined());
    expect(nav.queryByRole('link', { name: 'Organizational units' })).toBeNull();
    expect(requests.some((request) => request.url.startsWith('/api/org/units'))).toBe(false);
    cleanup();
    server();
    renderAtLevel(<SettingsScreen />, person({ kind: 'owner', unitId: null, unitAdminGrants: [] }, true));
    const listed = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    expect(await listed.findByRole('link', { name: 'Organizational units' })).toBeDefined();
  });

  it('shows a unit admin their units, where each setting comes from, and why it can’t change', async () => {
    const requests = server();
    const admin = person(
      {
        kind: 'member',
        unitId: research.id,
        unitAdminGrants: [{ unitId: research.id, roles: ['security'] }],
      },
      true,
    );
    renderAtLevel(<UnitSettings />, admin);
    await userEvent.click(await screen.findByRole('button', { name: 'Materials' }));
    expect(await screen.findByText('Set by Research')).toBeDefined();
    expect(screen.getByText('Set here')).toBeDefined();
    expect(screen.getAllByText('Set by the organization').length).toBeGreaterThan(0);
    // Settings the organization keeps, and those that need a role this admin lacks, say so.
    expect(screen.getAllByText('The organization doesn’t let units change this.').length).toBeGreaterThan(0);
    expect(screen.getByText('Changing this takes the AI role.')).toBeDefined();
    expect(screen.getByRole('switch', { name: 'AI fields' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('switch', { name: 'Require a second sign-in step' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('switch', { name: 'Sync out to outside systems' })).toBeDefined();
    // A value set from above says who set it, and stays out of reach.
    expect(
      screen.getByText('The organization set this here, so only its admins can change it.'),
    ).toBeDefined();
    expect(screen.getByRole('switch', { name: 'Public links and forms' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('textbox', { name: 'Shortest password allowed' })).toHaveProperty(
      'disabled',
      false,
    );
    // Only admins above Research can rename or delete it, and this admin has no People role.
    expect(screen.queryByRole('button', { name: /Rename or move/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'People' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Organization policy' })).toBeNull();
    // Nothing is saved until something changes.
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
  });

  it('offers renaming, moving, and deleting only the units below one the admin holds People for', async () => {
    server();
    const admin = person(
      { kind: 'member', unitId: research.id, unitAdminGrants: [{ unitId: research.id, roles: ['people'] }] },
      true,
    );
    renderAtLevel(<UnitSettings />, admin);
    expect(await screen.findByRole('button', { name: 'Rename or move Materials' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Delete Materials' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Rename or move Research' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Research' })).toBeNull();
  });

  it('refuses the screen to someone with no admin role', () => {
    server();
    renderAtLevel(
      <UnitSettings />,
      person({ kind: 'member', unitId: research.id, unitAdminGrants: [] }, true),
    );
    expect(screen.queryByRole('heading', { name: 'Units' })).toBeNull();
  });
});
