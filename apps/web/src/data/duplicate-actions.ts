import { msg, plural } from '@lingui/core/macro';
import { LIMITS } from '@riosoma/contracts';
import type { DatabaseSession } from './types';
import { i18n } from '../i18n';
import { undoToast } from '../grid/view/actions';

export async function duplicateRecords(
  session: DatabaseSession,
  tableId: string,
  recordIds: string[],
  viewId?: string,
  timeZone?: string,
): Promise<void> {
  const action = session.run(
    Array.from({ length: Math.ceil(recordIds.length / LIMITS.recordsPerCommand) }, (_, index) => ({
      kind: 'record.duplicate' as const,
      tableId,
      viewId,
      timeZone,
      recordIds: recordIds.slice(index * LIMITS.recordsPerCommand, (index + 1) * LIMITS.recordsPerCommand),
    })),
  );
  const result = await action.done;
  if (!result.rejected) {
    const count = recordIds.length;
    undoToast(
      session,
      i18n._(
        msg({
          id: 'duplicate.records.done',
          message: plural(count, { one: 'Duplicated # record', other: 'Duplicated # records' }),
        }),
      ),
      action.groupId,
    );
  }
}
