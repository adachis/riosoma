import { newId, type HomeAction, type HomeListing } from '@riosoma/contracts';
import { queryOptions, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api, currentCsrfToken } from '../../api';
import { browserClock, browserWebSocket, clientId } from '../../data/deps';
import { sharedRealtime } from '../../data/realtime';
import { invalidateNow } from '../../data/refresh';
import { useSession } from '../../session';

export const homeQuery = queryOptions({
  queryKey: ['home'],
  queryFn: ({ signal }) => api<HomeListing>('/api/home', { signal }),
  refetchInterval: 30_000,
});

export async function homeCommand(action: HomeAction | HomeAction[]) {
  return api<{ id: string }>('/api/home/commands', {
    method: 'POST',
    body: {
      id: newId('command'),
      action: Array.isArray(action) ? action[0] : action,
      ...(Array.isArray(action) && action.length > 1 ? { actions: action } : {}),
    },
  });
}

export function databaseCreationFolder(): string | null {
  return window.location.pathname.startsWith('/home/folders/')
    ? (window.location.pathname.split('/')[3] ?? null)
    : null;
}

/** Filing uses the starting destination because navigation can change who inherits access. */
export async function fileCreatedDatabase(databaseId: string, folderId: string | null): Promise<void> {
  if (folderId)
    await homeCommand({ kind: 'database.move', databaseId, parentId: folderId, confirmedLosses: [] });
}

export function useHomeRealtime() {
  const session = useSession();
  const cache = useQueryClient();
  useEffect(() => {
    if (!session?.user?.id || !session.csrfToken) return;
    const refresh = () => {
      for (const queryKey of [['home'], ['databases'], ['org', 'folders'], ['folders'], ['trash']])
        void invalidateNow(cache, queryKey);
    };
    const realtime = sharedRealtime(
      browserWebSocket,
      browserClock,
      clientId(),
      session.user.id,
      currentCsrfToken,
    );
    return realtime.add({
      databaseId: '',
      seq: () => 0,
      message: (message) => {
        if (message.type === 'homeChanged') refresh();
      },
      connection: (ready) => {
        if (ready) refresh();
      },
    });
  }, [session, cache]);
}
