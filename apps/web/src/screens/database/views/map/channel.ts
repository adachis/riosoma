import { useEffect, useRef } from 'react';

/**
 * What a map's settings bar asks of the map beside it: frame every pin, or show one record's pin.
 * The two are separate components, so they meet here, by view ID.
 */
export type MapRequest = { kind: 'fit' } | { kind: 'show'; recordId: string };

const channels = new Map<string, Set<(request: MapRequest) => void>>();

export function requestMap(viewId: string, request: MapRequest): void {
  for (const listener of channels.get(viewId) ?? []) listener(request);
}

/** Runs `listener` whenever the settings bar asks something of this view's map. */
export function useMapRequests(viewId: string, listener: (request: MapRequest) => void): void {
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    let listeners = channels.get(viewId);
    if (!listeners) {
      listeners = new Set();
      channels.set(viewId, listeners);
    }
    const call = (request: MapRequest) => latest.current(request);
    listeners.add(call);
    return () => {
      listeners.delete(call);
      if (!listeners.size) channels.delete(viewId);
    };
  }, [viewId]);
}
