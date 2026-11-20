import { preloadImport, recoverImport } from '../../asset-recovery';
import { useLingui } from '@lingui/react/macro';
import { DEFAULT_TRASH_WINDOW, type TrashWindow } from '@riosoma/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api } from '../../api';
import { isDemoSession } from '../../demo';

/**
 * The window the administrator chose for one database.  Countdowns and delete confirmations name
 * it instead of assuming the default, which is only what a server without a policy of its own uses.
 */
const TrashWindows = createContext<TrashWindow>(DEFAULT_TRASH_WINDOW);

export function trashWindowQuery(databaseId: string, speculative = false) {
  return {
    queryKey: ['trash-window', databaseId],
    // An answer that isn't a window leaves the default in place, so a countdown is never blank.
    queryFn: async ({ signal }: { signal?: AbortSignal }) => {
      if (isDemoSession()) return DEFAULT_TRASH_WINDOW;
      const { TrashWindow } = await (speculative ? preloadImport : recoverImport)(
        () => import('./window-validation'),
      );
      const answer = TrashWindow.safeParse(
        await api<unknown>(
          `/api/databases/${encodeURIComponent(databaseId)}/trash-window`,
          signal ? { signal } : {},
        ),
      );
      return answer.success ? answer.data : DEFAULT_TRASH_WINDOW;
    },
    staleTime: 60_000,
  };
}

/** Reads a database's window before a confirmation can open, so its first rendering names it. */
export async function prefetchTrashWindow(client: QueryClient, databaseId: string): Promise<void> {
  await client.prefetchQuery(trashWindowQuery(databaseId, true)).catch(() => undefined);
}

export function TrashWindowProvider({ databaseId, children }: { databaseId: string; children: ReactNode }) {
  const { data } = useQuery(trashWindowQuery(databaseId));
  return <TrashWindows.Provider value={data ?? DEFAULT_TRASH_WINDOW}>{children}</TrashWindows.Provider>;
}

/** The window for the database on screen, or the default before a server answers. */
export function useTrashWindow(): TrashWindow {
  return useContext(TrashWindows);
}

/** The window for a database named here, for screens outside one, such as home. */
export function useTrashWindowFor(databaseId: string | null | undefined): TrashWindow {
  const { data } = useQuery({ ...trashWindowQuery(databaseId ?? ''), enabled: Boolean(databaseId) });
  return data ?? DEFAULT_TRASH_WINDOW;
}

/**
 * How a promise of the trash ends, as one phrase every confirmation can finish its sentence with.
 * A hold or a policy with no limit keeps deleted things, so neither names a number of days.
 */
export function useTrashPhrase(chosen?: TrashWindow): string {
  const { t } = useLingui();
  const routed = useTrashWindow();
  const { days, legalHold } = chosen ?? routed;
  if (legalHold) return t({ id: 'trash.window.held', message: 'while a legal hold keeps it' });
  if (days === null) return t({ id: 'trash.window.kept', message: 'with no time limit' });
  return t({ id: 'trash.window.days', message: `for ${days} days` });
}
