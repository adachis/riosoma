import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { Autonomy } from '@riosoma/contracts';
import { json, session } from '../database/share/testing';
import { rioStatusQuery } from '../../features/rio/status';
import { renderSettings } from './testing';
import { RioSettings } from './RioSettings';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(cap: Autonomy, choice?: Autonomy) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url === '/api/rio/status'
      ? json({ autonomy: cap, autonomyCap: cap })
      : json(JSON.parse(String(init?.body))),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderSettings(<RioSettings />, {
    ...session,
    membership: { kind: 'member', adminRoles: [] },
    preferences: choice ? { rioAutonomy: choice } : {},
  });
  const saveBar = () => within(screen.getByRole('region', { name: 'Save changes' }));
  return { ...view, fetcher, saveBar };
}

it('offers every choice under the highest cap and persists only from the save bar', async () => {
  const view = setup('instant');
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Make changes right away' })).toHaveProperty('disabled', false),
  );
  expect(screen.getAllByRole('radio').every((radio) => !(radio as HTMLInputElement).disabled)).toBe(true);
  expect(screen.getByText('Review and approve every change before Rio makes it.')).toBeTruthy();
  await user.click(screen.getByRole('radio', { name: 'Always preview first' }));
  expect(view.fetcher.mock.calls.filter(([url]) => url === '/api/me/preferences')).toHaveLength(0);
  await user.click(view.saveBar().getByRole('button', { name: 'Discard' }));
  expect(screen.getByRole('radio', { name: 'Make changes right away' })).toHaveProperty('checked', true);
  await user.click(screen.getByRole('radio', { name: 'Always preview first' }));
  await user.click(view.saveBar().getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(view.fetcher).toHaveBeenCalledWith(
      '/api/me/preferences',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rioAutonomy: 'ask' }) }),
    ),
  );
  view.client.clear();
});

it('disables choices above the cap while keeping a stricter personal choice available', async () => {
  const view = setup('previewBig', 'ask');
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Always preview first' })).toHaveProperty('disabled', false),
  );
  expect(screen.getByRole('radio', { name: 'Always preview first' })).toHaveProperty('checked', true);
  const limited = screen.getByRole('radio', { name: 'Make changes right away' });
  expect(limited).toHaveProperty('disabled', true);
  expect(screen.getByText(/Your organization limits this\./)).toBeTruthy();
  await userEvent.setup().click(limited);
  expect(view.saveBar().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  view.client.clear();
});

it('shows the effective cap when an admin lowers it without rewriting the saved choice', async () => {
  const view = setup('instant', 'instant');
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Make changes right away' })).toHaveProperty('disabled', false),
  );
  view.client.setQueryData(rioStatusQuery.queryKey, { autonomy: 'ask', autonomyCap: 'ask' });
  await waitFor(() =>
    expect(screen.getByRole('radio', { name: 'Make changes right away' })).toHaveProperty('disabled', true),
  );
  expect(screen.getByRole('radio', { name: 'Make changes right away' })).toHaveProperty('checked', true);
  expect(screen.getByText(/Rio currently uses “Always preview first”/)).toBeTruthy();
  expect(view.saveBar().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  view.client.clear();
});

it('keeps a disabled saved choice outside the enabled native group after focus renders', async () => {
  const view = setup('ask', 'instant');
  const first = screen.getByRole('radio', { name: 'Always preview first' }) as HTMLInputElement;
  const saved = screen.getByRole('radio', { name: 'Make changes right away' }) as HTMLInputElement;
  await waitFor(() => expect(first.disabled).toBe(false));
  const user = userEvent.setup();
  await user.hover(screen.getByText('Always preview first'));
  first.focus();
  // Controlled input updates restore the group name independently of the setting's render.
  saved.name = first.name;
  await waitFor(() => expect(saved.name).not.toBe(first.name));
  expect(first.tabIndex).toBe(0);
  expect(saved.checked).toBe(true);
  expect(saved.disabled).toBe(true);
  expect(view.saveBar().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
  view.client.clear();
});

it.each([
  { choice: 'instant', cap: 'previewBig', label: 'Preview big changes, do small ones right away' },
  { choice: 'instant', cap: 'ask', label: 'Always preview first' },
  { choice: 'previewBig', cap: 'ask', label: 'Always preview first' },
] as const)(
  'keeps keyboard selection available when $choice is capped at $cap',
  async ({ choice, cap, label }) => {
    const view = setup('instant', choice);
    const user = userEvent.setup();
    const saved = screen.getByRole('radio', {
      name:
        choice === 'instant' ? 'Make changes right away' : 'Preview big changes, do small ones right away',
    });
    await waitFor(() => expect(saved).toHaveProperty('disabled', false));
    view.client.setQueryData(rioStatusQuery.queryKey, { autonomy: cap, autonomyCap: cap });
    await waitFor(() => expect(saved).toHaveProperty('disabled', true));
    expect(saved).toHaveProperty('checked', true);
    expect(view.saveBar().getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);

    await user.tab();
    const first = screen.getByRole('radio', { name: 'Always preview first' });
    const allowed = screen.getByRole('radio', { name: label });
    expect(document.activeElement).toBe(first);
    expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toEqual([first]);
    expect(saved).toHaveProperty('checked', true);
    await user.keyboard(' ');
    expect(first).toHaveProperty('checked', true);
    expect(saved).toHaveProperty('checked', false);
    if (cap === 'previewBig') {
      await user.keyboard('{ArrowDown}');
      expect(allowed).toHaveProperty('checked', true);
      expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toEqual([allowed]);
      await user.keyboard('{ArrowDown}');
      expect(screen.getByRole('radio', { name: 'Always preview first' })).toHaveProperty('checked', true);
      expect(screen.getAllByRole('radio').filter((radio) => radio.tabIndex === 0)).toEqual([
        screen.getByRole('radio', { name: 'Always preview first' }),
      ]);
      await user.keyboard('{ArrowUp}');
      expect(allowed).toHaveProperty('checked', true);
    }
    expect(view.fetcher.mock.calls.filter(([url]) => url === '/api/me/preferences')).toHaveLength(0);
    await user.tab();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(allowed);
    await user.click(view.saveBar().getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(view.fetcher).toHaveBeenCalledWith(
        '/api/me/preferences',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ rioAutonomy: cap }) }),
      ),
    );
    view.client.clear();
  },
);
