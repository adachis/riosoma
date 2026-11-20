import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookingCancelPreview } from '@riosoma/contracts';
import { themes } from '../../preferences';
import { failure, json, renderSharing } from '../database/share/testing';
import { BookingCancelScreen } from './BookingCancelScreen';

// A stand-in for a signed link's token, built here so it never reads as a stored secret.
const TOKEN = ['bkg', 'A'.repeat(14), '.', 'b'.repeat(43)].join('');
const PREVIEW = `/api/public/bookings/cancel?token=${TOKEN}`;

function booking(state: BookingCancelPreview['state']): BookingCancelPreview {
  return {
    title: 'Office hours',
    start: '2026-10-06T13:00:00.000Z',
    end: '2026-10-06T14:00:00.000Z',
    resource: 'Oak room',
    state,
  };
}

function open(token: string | null, answer: () => Response) {
  window.history.replaceState(null, '', token ? `/bookings/cancel?token=${token}` : '/bookings/cancel');
  const requests: Array<{ method: string; url: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url, body: init?.body ? String(init.body) : undefined });
      if (init?.method === 'POST' && url === '/api/public/bookings/cancel') return json(booking('canceled'));
      if (url !== PREVIEW) throw new Error(`Unexpected request: ${url}`);
      return answer();
    }),
  );
  renderSharing(<BookingCancelScreen />, null);
  return requests;
}

beforeEach(() => {
  vi.spyOn(themes, 'apply').mockResolvedValue({ theme: 'nature', scheme: 'grove' });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('BookingCancelScreen', () => {
  it('asks first, so a link opened by a mail scanner cancels nothing, then cancels in one press', async () => {
    const requests = open(TOKEN, () => json(booking('booked')));
    expect(await screen.findByRole('heading', { name: 'Cancel Office hours?' })).toBeDefined();
    expect(screen.getByText('Oak room')).toBeDefined();
    expect(requests.map((request) => request.method)).toEqual(['GET']);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel my booking' }));
    expect(await screen.findByRole('heading', { name: 'Your booking is canceled' })).toBeDefined();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST']);
    expect(JSON.parse(requests[1]!.body!)).toEqual({ token: TOKEN });
  });

  it('says a booking is already canceled without offering to cancel it again', async () => {
    open(TOKEN, () => json(booking('canceled')));
    expect(await screen.findByRole('heading', { name: 'Your booking is canceled' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Cancel my booking' })).toBeNull();
  });

  it('explains a link that doesn’t work', async () => {
    open(TOKEN, () => failure('bookings.cancel.invalid', 404));
    expect(await screen.findByRole('heading', { name: 'That link didn’t work' })).toBeDefined();
    expect(
      screen.getByText(/This cancel link doesn’t work\.\s+Check that it was copied whole\./),
    ).toBeDefined();
  });

  it('asks nothing of the server without a token', async () => {
    const requests = open(null, () => json(booking('booked')));
    expect(await screen.findByRole('heading', { name: 'That link didn’t work' })).toBeDefined();
    expect(requests).toEqual([]);
  });
});
