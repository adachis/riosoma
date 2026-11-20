import { useSyncExternalStore } from 'react';

/** True while a CSS media query matches, updating when it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Phone widths, where the shell and screens switch to their one-column layouts */
export const PHONE_QUERY = '(max-width: 767px)';

/** True at phone widths. */
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
