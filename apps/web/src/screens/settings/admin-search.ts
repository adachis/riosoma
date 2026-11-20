import { useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';

const subscribe = (listener: () => void) => {
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
};

type NavigationOptions = { afterSave?: boolean };
let navigation: ((href: string, options?: NavigationOptions) => void) | null = null;

/** The shell routes address changes through the same draft guard as links and browser history. */
export function registerAdminNavigation(navigate: (href: string, options?: NavigationOptions) => void) {
  navigation = navigate;
  return () => {
    if (navigation === navigate) navigation = null;
  };
}

/** Keep filters and selected people in the address, including browser Back and Forward */
export function useAdminSearch() {
  return useCommittedAdminSearch();
}

/** A form with a leave prompt must keep reading the current tab until navigation is confirmed. */
export function useCommittedAdminSearch() {
  const router = useRouter({ warn: false });
  // Read the committed history location so a blocked Back keeps the current tab mounted.
  const search = useSyncExternalStore(
    router ? (listener) => router.history.subscribe(listener) : subscribe,
    () => router?.history.location.search ?? window.location.search,
  );
  return new URLSearchParams(search);
}

export function setAdminSearch(
  values: Record<string, string | undefined>,
  options?: NavigationOptions,
): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  navigateAdmin(`${url.pathname}${url.search}${url.hash}`, options);
}

/** Routes changes to a settings path through the shell's draft guard. */
export function navigateAdmin(href: string, options?: NavigationOptions): void {
  if (navigation) {
    navigation(href, options);
    return;
  }
  window.history.pushState(window.history.state, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
