import { useCallback, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';

interface SourceRoute {
  source?: string;
  kind?: string;
  help?: string;
}
const changed = 'source-route';
const snapshot = () => window.location.search;
function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(changed, listener);
  };
}

/** Source forms keep only their navigation state in the address, never their settings or secrets. */
export function useSourceRoute(): [SourceRoute, (route: SourceRoute, replace?: boolean) => void] {
  const router = useRouter({ warn: false });
  const watch = useCallback(
    (listener: () => void) => {
      const stop = subscribe(listener);
      const stopRouter = router?.subscribe('onResolved', listener);
      return () => {
        stop();
        stopRouter?.();
      };
    },
    [router],
  );
  const search = new URLSearchParams(useSyncExternalStore(watch, snapshot));
  return [
    {
      source: search.get('source') ?? undefined,
      kind: search.get('kind') ?? undefined,
      help: search.get('help') ?? undefined,
    },
    (route, replace = false) => {
      const url = new URL(window.location.href);
      for (const key of ['source', 'kind'] as const) {
        if (route[key]) url.searchParams.set(key, route[key]);
        else url.searchParams.delete(key);
      }
      window.history[replace ? 'replaceState' : 'pushState'](window.history.state, '', url);
      window.dispatchEvent(new Event(changed));
    },
  ];
}
