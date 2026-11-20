import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { TimelineZoom } from '@riosoma/contracts';

/**
 * What a timeline's settings bar tells the timeline beside it: go to today, open dependency
 * actions, and, for people who can't change the view, the zoom they picked for themselves.  The
 * two are separate components, so they meet here, by view ID.
 */
interface Channel {
  zoom: TimelineZoom | null;
  listeners: Set<() => void>;
  today: Set<() => void>;
  dependencies: Set<() => void>;
}

const channels = new Map<string, Channel>();

function channel(viewId: string): Channel {
  let found = channels.get(viewId);
  if (!found) {
    found = { zoom: null, listeners: new Set(), today: new Set(), dependencies: new Set() };
    channels.set(viewId, found);
  }
  return found;
}

/** Asks the view to scroll to today. */
export function showToday(viewId: string): void {
  for (const listener of channel(viewId).today) listener();
}

/** Runs `listener` whenever the settings bar asks for today. */
export function useTodayRequests(viewId: string, listener: () => void): void {
  useEffect(() => {
    const listeners = channel(viewId).today;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [viewId, listener]);
}

/**
 * Asks the view to open dependency actions for the bar it has focus.  A touch screen has no key to
 * press and a bar too short to show the diamond, so the settings bar offers this instead.
 */
export function showDependencies(viewId: string): void {
  for (const listener of channel(viewId).dependencies) listener();
}

/** Runs `listener` whenever the settings bar asks for dependency actions. */
export function useDependencyRequests(viewId: string, listener: () => void): void {
  useEffect(() => {
    const listeners = channel(viewId).dependencies;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [viewId, listener]);
}

/**
 * The zoom to draw with.  People who can change the view save their zoom with it.  Everyone else
 * zooms for themselves, for as long as the page stays open.
 */
export function useZoom(
  viewId: string,
  saved: TimelineZoom,
  canSave: boolean,
): [TimelineZoom, (zoom: TimelineZoom) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const listeners = channel(viewId).listeners;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    [viewId],
  );
  const local = useSyncExternalStore(
    subscribe,
    () => channels.get(viewId)?.zoom ?? null,
    () => null,
  );
  const setLocal = useCallback(
    (zoom: TimelineZoom) => {
      const found = channel(viewId);
      found.zoom = zoom;
      for (const listener of found.listeners) listener();
    },
    [viewId],
  );
  return [canSave ? saved : (local ?? saved), setLocal];
}
