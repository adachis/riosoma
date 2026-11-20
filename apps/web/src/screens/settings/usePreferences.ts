import { saveDemoPreferences } from '../../demo';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Preferences, PreferencesUpdate, SessionInfo } from '@riosoma/contracts';
import { api } from '../../api';
import { sessionQuery } from '../../session';

/** Preferences as a change carries them: a null or missing value is one at its default. */
type Values = Partial<Record<keyof Preferences, unknown>>;

// Saves go out one at a time, across every screen that saves preferences, so an older request
// can't land after a newer one.
let queue: Promise<unknown> = Promise.resolve();

/** The preferences with a change applied.  A cleared one goes back to its default, which is its absence. */
export function applied(preferences: Preferences, patch: Values): Preferences {
  const next: Values = { ...preferences };
  for (const [key, value] of Object.entries(patch) as Array<[keyof Preferences, unknown]>) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as Preferences;
}

/** Saves part of the person's preferences and shows the change right away. */
export function useSavePreferences() {
  const queryClient = useQueryClient();
  const current = (): Values =>
    queryClient.getQueryData<SessionInfo | null>(sessionQuery.queryKey)?.preferences ?? {};
  const merge = (patch: Values) =>
    queryClient.setQueryData(sessionQuery.queryKey, (old: SessionInfo | null | undefined) =>
      old ? { ...old, preferences: applied(old.preferences, patch) } : old,
    );
  const pick = (from: Values, keys: Array<keyof Preferences>): Values =>
    Object.fromEntries(keys.map((k) => [k, from[k] ?? null]));

  return useMutation({
    mutationFn: (patch: PreferencesUpdate) => {
      const session = queryClient.getQueryData<SessionInfo | null>(sessionQuery.queryKey);
      if (session?.demo) {
        const saved = applied(session.preferences, patch);
        saveDemoPreferences(saved);
        return Promise.resolve(saved);
      }
      const run = queue.then(() => api<Preferences>('/api/me/preferences', { method: 'PATCH', body: patch }));
      queue = run.catch(() => undefined);
      return run;
    },
    onMutate: (patch) => {
      const keys = Object.keys(patch) as Array<keyof Preferences>;
      const before = pick(current(), keys);
      merge(patch);
      return { before, keys };
    },
    onError: (_error, patch, context) => {
      if (!context) return;
      // Undo only what this change set, and only where nothing newer has replaced it since.
      const now = current();
      const restore = context.keys.filter((k) => (now[k] ?? null) === (patch[k] ?? null));
      merge(pick(context.before, restore));
    },
    // The server answers with every preference, but only the ones this change touched are news;
    // taking the rest could undo a newer change still in flight.
    onSuccess: (saved, patch) => {
      merge(pick(saved, Object.keys(patch) as Array<keyof Preferences>));
      if (patch.rioAutonomy !== undefined)
        void queryClient.invalidateQueries({ queryKey: ['rio', 'status'] });
    },
  });
}
