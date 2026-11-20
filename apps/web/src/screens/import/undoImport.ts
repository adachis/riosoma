import { newId, type UndoResult } from '@riosoma/contracts';
import { api, ApiError } from '../../api';
import { clientId } from '../../data/deps';
import type { UndoOutcome } from '../../data/types';
import { confirmMajorUndo } from '../../data/undo-confirmation';

/** Undoes everything an import wrote, which shares one action. */
export async function undoImport(databaseId: string, groupId: string): Promise<UndoOutcome> {
  if (!(await confirmMajorUndo(databaseId, groupId))) return { nothing: true, skipped: 0, canceled: true };
  const answer = await api<UndoResult>(`/api/databases/${databaseId}/undo`, {
    body: { clientId: clientId(), groupId, commandId: newId('command'), confirmedMajorCreation: true },
  });
  if (answer.status === 'rejected')
    throw new ApiError(
      400,
      answer.error ?? { code: 'internal', messageKey: 'errors.internal', userFault: false },
    );
  return {
    nothing: answer.status !== 'applied' || answer.state === 'done',
    skipped: answer.skipped,
    ...(answer.pending ? { pending: answer.pending } : {}),
  };
}
