import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRelativeTime } from './relative-time';

afterEach(() => {
  vi.useRealTimers();
});

function timeAgo(seconds: number): string {
  vi.useFakeTimers({ now: new Date('2026-09-27T12:00:00Z') });
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  const iso = new Date(Date.now() - seconds * 1000).toISOString();
  const { result } = renderHook(() => useRelativeTime(iso), {
    wrapper: ({ children }: { children: ReactNode }) => <I18nProvider i18n={i18n}>{children}</I18nProvider>,
  });
  return result.current;
}

it('reads just now under a minute and for a server clock slightly ahead', () => {
  expect(timeAgo(0)).toBe('just now');
  expect(timeAgo(59)).toBe('just now');
  expect(timeAgo(-5)).toBe('just now');
});

it('uses the largest whole unit without rounding up', () => {
  expect(timeAgo(3 * 60)).toBe('3 minutes ago');
  expect(timeAgo(59 * 60 + 59)).toBe('59 minutes ago');
  expect(timeAgo(3 * 3600)).toBe('3 hours ago');
  expect(timeAgo(86_400 + 60)).toBe('yesterday');
});
