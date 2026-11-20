import { afterEach, expect, it, vi } from 'vitest';
import { api, setCsrfToken, setPublicViewPass } from './api';
import { onPublicDomain, publicPagePath } from './public-domain';

let marker: HTMLMetaElement | undefined;
afterEach(() => {
  marker?.remove();
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

it('omits cookies and session credentials while keeping a view pass scoped to its link', async () => {
  marker = document.createElement('meta');
  marker.name = 'rio-public-domain';
  document.head.append(marker);
  expect(onPublicDomain()).toBe(true);
  const csrf = ['csrf', 'value'].join('-');
  const pass = ['public', 'pass'].join('-');
  setCsrfToken(csrf);
  setPublicViewPass('one', pass);
  const fetcher = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);
  await api('/api/public/views/one/rows', { body: {} });
  await api('/api/public/views/two/rows');
  await api('/api/config');
  const first = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  const second = fetcher.mock.calls[1] as unknown as [string, RequestInit];
  expect(first[1].credentials).toBe('omit');
  expect(new Headers(first[1].headers).get('x-csrf-token')).toBeNull();
  expect(new Headers(first[1].headers).get('x-public-view-pass')).toBe(pass);
  expect(new Headers(second[1].headers).get('x-public-view-pass')).toBeNull();
  expect(fetcher).toHaveBeenLastCalledWith(
    '/api/public/config',
    expect.objectContaining({ credentials: 'omit' }),
  );
});

it('recognizes only public page navigation paths', () => {
  for (const path of ['/f/form', '/v/view', '/b/page', '/signatures', '/bookings/cancel'])
    expect(publicPagePath(path)).toBe(true);
  for (const path of ['/', '/sign-in', '/setup', '/settings/custom-domains', '/f/form/extra'])
    expect(publicPagePath(path)).toBe(false);
});
