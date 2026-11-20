import { Icon } from '@riosoma/icons';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { faLock, faLockOpen } from '@fortawesome/free-solid-svg-icons';
import { canBypassRecordLock, roleAllows, type RowData } from '@riosoma/contracts';
import { Banner, Button, TextField } from '@riosoma/ui';
import { useSchema, type DatabaseSession } from '../../../data';

export function RecordLockControl({
  session,
  tableId,
  row,
}: {
  session?: DatabaseSession;
  tableId: string;
  row: RowData;
}) {
  const { t } = useLingui();
  const schema = useSchema(session ?? null);
  const [editing, setEditing] = useState(false);
  const [draftReason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const change = async (locked: boolean) => {
    if (!session) return;
    setPending(true);
    setFailed(false);
    try {
      const result = await session.run([
        { kind: 'record.setLock', tableId, recordIds: [row.id], locked, reason: draftReason },
      ]).done;
      setFailed(Boolean(result.rejected));
      if (!result.rejected) setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const canChange = session && roleAllows(schema?.database.role ?? null, 'editRecords');
  const canUnlock =
    session && canBypassRecordLock(schema?.tableById.get(tableId)?.recordLock, schema?.database.role ?? null);
  // A draft can no longer be applied after losing edit access or receiving a lock.
  if (editing && (!canChange || row.lock)) {
    setEditing(false);
    setReason('');
  }
  const reason =
    row.lock?.reason ||
    (row.lock?.manual
      ? t({ id: 'locks.record.manualReason', message: 'Locked by hand' })
      : t({ id: 'locks.record.conditionReason', message: 'Matches the table lock condition' }));
  return (
    <div className="rio-record-lock">
      {row.lock && (
        <p role="status">
          <Icon icon={faLock} aria-hidden="true" />{' '}
          {t({ id: 'locks.record.reason', message: `Locked: ${reason}` })}
        </p>
      )}
      {canChange && (!row.lock || (row.lock.manual && canUnlock)) && (
        <Button
          icon={row.lock?.manual ? faLockOpen : faLock}
          isDisabled={pending}
          onPress={() => (row.lock?.manual ? change(false) : setEditing(!editing))}
        >
          {row.lock?.manual
            ? t({ id: 'locks.record.unlock', message: 'Unlock record' })
            : t({ id: 'locks.record.lock', message: 'Lock record' })}
        </Button>
      )}
      {editing && (
        <>
          <TextField
            label={t({ id: 'locks.reason', message: 'Lock reason' })}
            value={draftReason}
            onChange={setReason}
          />
          <Button isDisabled={pending} onPress={() => change(true)}>
            {t({ id: 'locks.record.confirm', message: 'Confirm lock' })}
          </Button>
        </>
      )}
      {failed && (
        <Banner tone="danger">
          {t({ id: 'locks.record.failed', message: 'The lock could not be changed.' })}
        </Banner>
      )}
    </div>
  );
}
