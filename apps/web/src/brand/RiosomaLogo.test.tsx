import wordmark from '../../public/brand/riosoma-wordmark.svg?raw';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderHome } from '../screens/home/test-support';
import { RiosomaLogo } from './RiosomaLogo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('stills reduced motion, preserves the addressable parts, and introduces the mark only once', async () => {
  const query = { matches: true };
  const parser = vi.spyOn(DOMParser.prototype, 'parseFromString');
  const request = vi.fn(async () => ({
    ok: true,
    text: async () => wordmark,
  }));
  vi.stubGlobal('fetch', request);
  vi.stubGlobal('matchMedia', () => query);
  const still = renderHome(<RiosomaLogo animate />);
  expect(screen.getByRole('img', { name: 'Riosoma' }).getAttribute('data-introduce')).toBeNull();
  expect(still.container.querySelector('svg')).toBeNull();
  expect(request).not.toHaveBeenCalled();
  still.unmount();
  query.matches = false;
  const first = renderHome(<RiosomaLogo animate />);
  expect(screen.getByRole('img', { name: 'Riosoma' }).getAttribute('data-pending')).toBe('true');
  await waitFor(() =>
    expect(screen.getByRole('img', { name: 'Riosoma' }).getAttribute('data-introduce')).toBe('true'),
  );
  for (const id of ['letter-r', 'leaf', 'letter-i', 'letters-oso', 'letter-m', 'letter-a'])
    expect(first.container.querySelector(`[id="${id}"]`)).toBeTruthy();
  // The app's interface shows the wordmark without the mascot.
  expect(first.container.querySelector('[id="riosoma-mascot"]')).toBeNull();
  expect(screen.getByRole('img', { name: 'Riosoma' }).getAttribute('data-variant')).toBe('wordmark');
  expect(first.container.querySelector('#leaf')?.getAttribute('style')).toContain('transform-origin');
  expect(parser).toHaveBeenCalledWith(expect.not.stringContaining(' style='), 'image/svg+xml');
  first.unmount();
  const next = renderHome(<RiosomaLogo animate />);
  expect(screen.getByRole('img', { name: 'Riosoma' }).getAttribute('data-introduce')).toBeNull();
  expect(next.container.querySelector('svg')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});
