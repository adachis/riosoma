import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import { newId, type SourceCommandResult } from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { api, currentCsrfToken } from '../../../api';
import { browserClock, browserWebSocket, clientId } from '../../../data/deps';
import { sharedRealtime } from '../../../data/realtime';
import { useSession } from '../../../session';
import { useServerMessage } from '../../../messages/useServerMessage';
import { errorInfo } from '../../setup/useSetup';
import { SOURCES_KEY } from './query';

export function useSourceCommands() {
  const { t } = useLingui();
  const cache = useQueryClient();
  const session = useSession();
  const message = useServerMessage();
  const refresh = () => cache.invalidateQueries({ queryKey: SOURCES_KEY });
  useEffect(() => {
    if (!session?.user.id || !session.csrfToken) return;
    return sharedRealtime(browserWebSocket, browserClock, clientId(), session.user.id, currentCsrfToken).add({
      databaseId: '',
      seq: () => 0,
      message: (event) => {
        if (event.type === 'homeChanged') void cache.invalidateQueries({ queryKey: SOURCES_KEY });
      },
      connection: (ready) => {
        if (ready) void cache.invalidateQueries({ queryKey: SOURCES_KEY });
      },
    });
  }, [session, cache]);
  return (title: string, commandId?: string) =>
    toast.show({
      tone: 'success',
      title,
      ...(commandId
        ? {
            action: {
              label: t({ id: 'sources.undo', message: 'Undo' }),
              onPress: () => {
                void api<SourceCommandResult>('/api/source-commands', {
                  body: { id: newId('command'), action: { kind: 'undo', commandId } },
                })
                  .then(refresh)
                  .catch((error: unknown) => {
                    const info = errorInfo(error);
                    toast.show({
                      tone: 'danger',
                      title: message(info?.key ?? 'errors.internal', info?.params),
                    });
                  });
              },
            },
          }
        : {}),
    });
}
