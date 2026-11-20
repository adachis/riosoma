import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import type { Camera } from './layout';

export interface ChartLocation extends Camera {
  collapsed: string[];
  allCollapsed: boolean;
  active: string | null;
  search: string;
}
const INITIAL: ChartLocation = {
  x: 24,
  y: 24,
  zoom: 1,
  collapsed: [],
  allCollapsed: false,
  active: null,
  search: '',
};
const MAX_COLLAPSED = 100;

export function readChartLocation(search: string, viewId: string): ChartLocation {
  try {
    const value: unknown = JSON.parse(new URLSearchParams(search).get('org') ?? 'null');
    if (!value || typeof value !== 'object') return INITIAL;
    const state = value as Record<string, unknown>;
    if (state.view !== viewId) return INITIAL;
    const number = (key: string, fallback: number) =>
      typeof state[key] === 'number' && Number.isFinite(state[key]) ? (state[key] as number) : fallback;
    const validId = (id: unknown): id is string =>
      typeof id === 'string' && /^rec[0-9A-Za-z]{1,64}$/.test(id);
    return {
      x: Math.max(-1e8, Math.min(1e8, number('x', 24))),
      y: Math.max(-1e8, Math.min(1e8, number('y', 24))),
      zoom: Math.max(0.00001, Math.min(2, number('zoom', 1))),
      collapsed:
        Array.isArray(state.collapsed) && state.collapsed.length <= MAX_COLLAPSED
          ? state.collapsed.filter(validId)
          : [],
      allCollapsed: state.allCollapsed === true,
      active: validId(state.active) ? state.active : null,
      search: typeof state.search === 'string' ? state.search.slice(0, 200) : '',
    };
  } catch {
    return INITIAL;
  }
}

/**
 * Whether an address belongs to this chart: a public link's route, or one of the app's own routes
 * naming this view.  A chart drawn over another page, as a plan preview draws a planned view in a
 * dialog, keeps its camera in memory instead of writing the host page's address.
 */
function ownsAddress(pathname: string, viewId: string): boolean {
  return pathname.startsWith('/v/') || pathname.split('/').includes(viewId);
}

/** Public routes identify the link even when the shared session recreates its stand-in IDs. */
export function useChartLocation(viewId: string, interacting = false) {
  const router = useRouter({ warn: false });
  const subscribe = useCallback(
    (listener: () => void) => {
      window.addEventListener('popstate', listener);
      const stop = router?.subscribe('onResolved', listener);
      return () => {
        window.removeEventListener('popstate', listener);
        stop?.();
      };
    },
    [router],
  );
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  const key = pathname.match(/^\/v\/[^/]+/)?.[0] ?? viewId;
  const initial = useMemo(() => readChartLocation(window.location.search, key), [key]);
  const [location, setLocation] = useState(initial);
  useEffect(() => {
    const read = () => setLocation(readChartLocation(window.location.search, key));
    window.addEventListener('popstate', read);
    return () => window.removeEventListener('popstate', read);
  }, [key]);
  useEffect(() => {
    if (interacting) return;
    const timer = setTimeout(() => {
      const url = new URL(window.location.href);
      if (url.pathname !== pathname) return;
      // A chart drawn over another page, as a plan preview is, leaves that page's address alone.
      if (!ownsAddress(pathname, viewId)) return;
      const state = { view: key, ...location };
      // Bound copied addresses even when individual IDs or a custom selection are large.
      if (state.collapsed.length > MAX_COLLAPSED || encodeURIComponent(JSON.stringify(state)).length > 5500) {
        state.collapsed = [];
        state.allCollapsed = false;
      }
      const encoded = JSON.stringify(state);
      if (url.searchParams.get('org') === encoded) return;
      url.searchParams.set('org', encoded);
      try {
        window.history.replaceState(window.history.state, '', url);
      } catch {
        // Browsers can refuse history writes while the in-memory camera remains usable.
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [key, viewId, location, interacting, pathname]);
  const change = useCallback((patch: Partial<ChartLocation>) => {
    setLocation((previous) => ({ ...previous, ...patch }));
  }, []);
  return [location, change, initial !== INITIAL] as const;
}
