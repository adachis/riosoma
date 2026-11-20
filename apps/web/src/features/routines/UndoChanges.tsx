import { useLingui } from '@lingui/react/macro';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { undoSkipped } from '../../grid/view/actions';
import { ApiError } from '../../api';
import { undoChanges } from './api';

/** Undo for everything one run, or one approved plan, changed: one step, like any other undo. */
export function UndoChanges({ databaseId, groupId }: { databaseId: string; groupId: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const undo = useMutation({
    mutationFn: () => undoChanges(databaseId, groupId),
    onSuccess: (result) => {
      if (result.skipped || result.pending) undoSkipped(result.skipped, result.pending);
    },
  });
  const rejected = undo.data?.status === 'rejected' ? undo.data.error?.messageKey : null;
  const failure =
    rejected ??
    (undo.error ? (undo.error instanceof ApiError ? undo.error.info.messageKey : 'errors.internal') : null);
  if (undo.isSuccess && !rejected)
    return (
      <p role="status" className="rio-routines__note">
        {t({ id: 'routines.undone', message: 'Undone' })}
      </p>
    );
  return (
    <div className="rio-routines__actions">
      <Button size="sm" isPending={undo.isPending} onPress={() => undo.mutate()}>
        {t({ id: 'routines.undo', message: 'Undo these changes' })}
      </Button>
      {failure ? <p role="alert">{message(failure)}</p> : null}
    </div>
  );
}
