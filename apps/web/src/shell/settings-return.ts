import { safeSignInNext } from '@riosoma/contracts';

/** Settings keeps the originating screen in the address, including its query and fragment. */
export function settingsReturn(value: unknown): string {
  const address = typeof value === 'string' ? safeSignInNext(value) : '/';
  return /^\/(?:settings|admin)(?:\/|\?|#|$)/.test(address) ? '/' : address;
}

/** Add the return address without carrying another settings page's filters or selections. */
export function withSettingsReturn(address: string, value: unknown): string {
  if (typeof value !== 'string') return address;
  const fragmentAt = address.indexOf('#');
  const fragment = fragmentAt < 0 ? '' : address.slice(fragmentAt);
  const destination = fragmentAt < 0 ? address : address.slice(0, fragmentAt);
  const queryAt = destination.indexOf('?');
  const path = queryAt < 0 ? destination : destination.slice(0, queryAt);
  const search = new URLSearchParams(queryAt < 0 ? '' : destination.slice(queryAt + 1));
  search.set('returnTo', settingsReturn(value));
  return `${path}?${search}${fragment}`;
}
