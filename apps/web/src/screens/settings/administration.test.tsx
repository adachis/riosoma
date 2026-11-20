import { renderSettings as renderSharing } from './testing';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuditEntry, Member, OrganizationPresetPreview } from '@riosoma/contracts';
import { json, session } from '../database/share/testing';
import { AdminRoles } from './people/AdminRoles';
import { OrganizationPresets } from './security/OrganizationPresets';
import { AuditSettings } from './audit/AuditSettings';

const member: Member = {
  id: 'member',
  name: 'Morgan',
  email: '',
  kind: 'member',
  adminRoles: [],
  deactivated: false,
};
const entry: AuditEntry = {
  id: '42',
  sequence: '7',
  actorId: 'owner',
  actorName: 'Owner',
  action: 'organization.roles',
  resource: member.id,
  at: '2026-09-29T12:00:00Z',
  metadata: { before: [], after: ['audit'] },
  prevHash: null,
  hash: 'a'.repeat(64),
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

it('saves a custom role through the command bus and offers undo', async () => {
  let roles: string[] = [];
  const commands: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        const body = JSON.parse(String(options.body));
        commands.push(body);
        roles = body.kind === 'organization.undo' ? [] : body.roles;
        return json({ eventId: '42', undoable: true });
      }
      return json({ roles });
    }),
  );
  renderSharing(<AdminRoles member={member} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('checkbox', { name: 'Audit' }));
  await user.click(screen.getByRole('checkbox', { name: 'Security' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/Admin roles saved\.\s+The member will receive an email and a notification\./);
  expect(commands[0]).toEqual({ kind: 'organization.roles', userId: 'member', roles: ['audit', 'security'] });
  await user.click(screen.getByRole('checkbox', { name: 'Audit' }));
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', false);
  await user.click(screen.getByRole('checkbox', { name: 'Audit' }));
  expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  expect(commands).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Undo change' }));
  await waitFor(() =>
    expect((screen.getByRole('checkbox', { name: 'Audit' }) as HTMLInputElement).checked).toBe(false),
  );
  expect(commands[1]).toEqual({ kind: 'organization.undo', eventId: '42' });
});

it('previews current and new values without applying until the button is pressed', async () => {
  window.history.replaceState({}, '', '/settings/security?preset=balanced');
  const preview: OrganizationPresetPreview = {
    preset: 'balanced',
    revision: 'b'.repeat(64),
    diff: [{ key: 'passwordMinLength', before: 12, after: 14, allowed: true }],
  };
  const calls: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/auth/session') return json(session);
      if (options?.method === 'POST') {
        calls.push(JSON.parse(String(options.body)));
        return json({ eventId: '43', undoable: true });
      }
      return json(preview);
    }),
  );
  renderSharing(<OrganizationPresets />);
  await screen.findByText('Shortest password allowed');
  expect(screen.getByText(/Current:/).parentElement?.textContent).toContain('12');
  expect(screen.getByText(/New:/).parentElement?.textContent).toContain('14');
  expect(calls).toEqual([]);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Apply preset' }));
  expect(calls).toEqual([]);
  await userEvent.setup().click(
    within(screen.getByRole('region', { name: 'Save changes' })).getByRole('button', {
      name: /^Save$/,
    }),
  );
  await screen.findByText('Preset applied.');
  expect(calls).toEqual([{ kind: 'organization.preset', preset: 'balanced', revision: preview.revision }]);
});

it('keeps audit filters in links, loads details, and identifies a broken event', async () => {
  window.history.replaceState({}, '', '/settings/audit?action=organization.roles&event=42');
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/org/audit/42') return json(entry);
      if (url === '/api/org/audit/integrity') return json({ checked: 7, firstBreak: '42' });
      return json({ events: [entry], next: null });
    }),
  );
  renderSharing(<AuditSettings />, { ...session, membership: { kind: 'member', adminRoles: ['audit'] } });
  await screen.findByRole('heading', { name: 'Event details' });
  const details = screen.getByRole('region', { name: 'Event details' });
  expect(within(details).getByText('Recorded details')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'organization.roles' }).getAttribute('href')).toContain(
    'action=organization.roles',
  );
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Person' }), 'Owner');
  await user.click(screen.getByRole('button', { name: 'Filter events' }));
  await waitFor(() => expect(urls.some((url) => url.includes('person=Owner'))).toBe(true));
  expect(window.location.search).toContain('person=Owner');
  expect(window.location.search).not.toContain('event=');
  await user.click(screen.getByRole('button', { name: 'Check integrity' }));
  await screen.findByText('The first break is at event 42.');
  expect(screen.getByRole('link', { name: 'Event details' }).getAttribute('href')).toContain('person=Owner');
});

it('keeps the audit viewer and organization presets out of other admin areas', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  renderSharing(
    <>
      <AuditSettings />
      <OrganizationPresets />
    </>,
    { ...session, membership: { kind: 'member', adminRoles: ['people'] } },
  );
  expect(screen.queryByRole('button', { name: 'Check integrity' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Organization presets' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows offset time ranges in UTC without changing their meaning', async () => {
  const filters = new URLSearchParams({ from: '2026-09-29T12:00:00+02:00' });
  window.history.replaceState({}, '', `/settings/audit?${filters}`);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ events: [], next: null })),
  );
  renderSharing(<AuditSettings />);
  await screen.findByText('No events match these filters.');
  expect((screen.getByLabelText('From, UTC') as HTMLInputElement).value).toBe('2026-09-29T10:00');
});

it('keeps Enter in an audit filter from submitting the filter form', async () => {
  window.history.replaceState({}, '', '/settings/audit');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ events: [], next: null })),
  );
  renderSharing(<AuditSettings />);
  await screen.findByText('No events match these filters.');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Action' }), 'organization.roles{Enter}');
  expect(window.location.search).toBe('');
  await user.click(screen.getByRole('button', { name: 'Filter events' }));
  await waitFor(() => expect(window.location.search).toContain('action=organization.roles'));
});

it('provides one audit filter destination containing every filter control', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ events: [], next: null })),
  );
  const { container } = renderSharing(<AuditSettings />);
  await screen.findByText('No events match these filters.');
  const targets = container.querySelectorAll('[data-setting-page="audit"][data-setting-id="audit-filters"]');
  expect(targets).toHaveLength(1);
  for (const label of ['Search events', 'Person', 'Action', 'Resource', 'From, UTC', 'To, UTC'])
    expect(within(targets[0] as HTMLElement).getByLabelText(label)).toBeTruthy();
});

it('keeps an invalid audit filter editable and focuses its field before changing the address', async () => {
  window.history.replaceState({}, '', '/settings/audit');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ events: [], next: null })),
  );
  renderSharing(<AuditSettings />);
  await screen.findByText('No events match these filters.');
  const user = userEvent.setup();
  const field = screen.getByRole('textbox', { name: 'Resource' });
  const value = '記録🌊مرحبا'.repeat(30);
  await user.type(field, value);
  await user.click(screen.getByRole('button', { name: 'Filter events' }));
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(field).toHaveProperty('value', value);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(window.location.search).toBe('');
  await user.clear(field);
  await user.type(field, '記録🌊مرحبا');
  await user.click(screen.getByRole('button', { name: 'Filter events' }));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('resource')).toBe('記録🌊مرحبا'),
  );
});
