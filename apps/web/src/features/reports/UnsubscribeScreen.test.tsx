import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { failure, json, renderSharing } from '../../screens/database/share/testing';
import { UnsubscribeScreen } from './UnsubscribeScreen';

// A stand-in for a signed link's token, built here so it never reads as a stored secret.
const TOKEN = [btoa('{"r":"rpt"}'), btoa('signature')].join('.').replaceAll('=', '');

function open(token: string | null, answer: () => Response) {
  window.history.replaceState(
    null,
    '',
    token ? `/reports/unsubscribe?token=${token}` : '/reports/unsubscribe',
  );
  const requests: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url });
      if (url !== `/api/reports/unsubscribe?token=${token}`) throw new Error(`Unexpected request: ${url}`);
      return init?.method === 'POST' ? new Response(null, { status: 204 }) : answer();
    }),
  );
  renderSharing(<UnsubscribeScreen />, null);
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('UnsubscribeScreen', () => {
  it('asks first, so a link opened by a mail scanner changes nothing, then stops it in one press', async () => {
    const requests = open(TOKEN, () =>
      json({ reportName: 'Monday pipeline', viewName: 'Open deals', receiving: true }),
    );
    expect(await screen.findByRole('heading', { name: 'Stop receiving Monday pipeline?' })).toBeDefined();
    expect(
      screen.getByText(/scheduled report of the Open deals view\.\s+Nobody else stops getting it\./),
    ).toBeDefined();
    expect(requests.map((request) => request.method)).toEqual(['GET']);
    await userEvent.click(screen.getByRole('button', { name: 'Stop receiving it' }));
    expect(
      await screen.findByRole('heading', { name: 'You won’t get Monday pipeline anymore' }),
    ).toBeDefined();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
  });

  it('says so when it was already stopped', async () => {
    open(TOKEN, () => json({ reportName: 'Monday pipeline', viewName: 'Open deals', receiving: false }));
    expect(
      await screen.findByRole('heading', { name: 'You won’t get Monday pipeline anymore' }),
    ).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Stop receiving it' })).toBeNull();
  });

  it('explains a link that expired, was changed, or is missing its token', async () => {
    open(TOKEN, () => failure('reports.unsubscribe.expired', 404));
    expect(await screen.findByRole('heading', { name: 'That link didn’t work' })).toBeDefined();
    expect(screen.getByText(/This link has expired\./)).toBeDefined();
    cleanup();
    open(null, () => json({}));
    expect(await screen.findByText(/This link doesn’t work\./)).toBeDefined();
  });
});
