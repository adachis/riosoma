import { useCallback, useState, useSyncExternalStore } from 'react';

function previewStore() {
  let revision: unknown;
  let serial = 0;
  const entries = new Map<string, { pending: boolean; reason?: string }>();
  const listeners = new Set<() => void>();
  return {
    snapshot: () => serial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check(
      nextRevision: unknown,
      key: string,
      request: () => Promise<unknown>,
      describe: (error: unknown) => string,
    ): { pending: boolean; reason?: string } {
      if (revision !== nextRevision) {
        revision = nextRevision;
        entries.clear();
      }
      const known = entries.get(key);
      if (known) return known;
      const pending = { pending: true };
      entries.set(key, pending);
      const finish = (reason?: string) => {
        if (revision !== nextRevision || entries.get(key) !== pending) return;
        entries.set(key, { pending: false, reason });
        serial++;
        listeners.forEach((listener) => listener());
      };
      void request().then(
        () => finish(),
        (error: unknown) => finish(describe(error)),
      );
      return pending;
    },
  };
}

/** Preflight results belong to the listing revision whose permissions and parents they checked. */
export function useDropPreview() {
  const [store] = useState(previewStore);
  const serial = useSyncExternalStore(store.subscribe, store.snapshot);
  return useCallback(
    (...args: Parameters<typeof store.check>) => {
      // A completed preflight must also refresh an unmoving pointer's drop proposal.
      return { ...store.check(...args), revision: serial };
    },
    [store, serial],
  );
}
