import { newId, type CommandBatchResult } from '@riosoma/contracts';
import { api, ApiError } from '../../api';

/**
 * Trashing and restoring a whole database happen outside it, on the home screen, so they post
 * straight to its command route instead of going through an open database session.
 */
export async function runDatabaseCommand(
  databaseId: string,
  kind: 'database.trash' | 'database.restore',
): Promise<void> {
  const result = await api<CommandBatchResult>(`/api/databases/${databaseId}/commands`, {
    method: 'POST',
    body: {
      clientId: newId('client'),
      commands: [{ id: newId('command'), groupId: newId('action'), kind }],
    },
  });
  const rejected = result.results.find((item) => item.status === 'rejected');
  if (rejected?.error) throw new ApiError(400, rejected.error);
}
