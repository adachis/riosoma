import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ROUTINE_BELL_VALUES,
  ROUTINE_BELL_FIELDS,
  ROUTINE_BELL_RECORDS,
  type Notification,
  type RoutineApproval,
} from '@riosoma/contracts';
import { Button, Link } from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { approve, refreshRoutines, skip } from './api';
import { ChangeSummary } from './ChangeSummary';
import { UndoChanges } from './UndoChanges';
import { routineHref, useRoutineWords } from './words';

/**
 * What the bell lets a routine's owner do in place: see what a run left waiting, as the server
 * worked it out, and approve a small edit or skip anything, or undo the changes a run made.
 * Anything bigger, any email, and any new site is read and approved on the routine's page, and the
 * server holds a one-click approval to that too.
 */
export function RoutineNotificationActions({ notification }: { notification: Notification }) {
  const { target } = notification;
  if (notification.kind === 'routineReport' && target.groupId && target.databaseId)
    return (
      <div className="rio-notifications__actions">
        <UndoChanges databaseId={target.databaseId} groupId={target.groupId} />
      </div>
    );
  if (notification.kind === 'routineApproval' && target.approvalId)
    return <Waiting approvalId={target.approvalId} />;
  return null;
}

function Waiting({ approvalId }: { approvalId: string }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const message = useServerMessage();
  const client = useQueryClient();
  const key = ['routines', 'approval', approvalId] as const;
  const approval = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api<RoutineApproval>(`/api/rio/routine-approvals/${encodeURIComponent(approvalId)}`, { signal }),
  });
  const act = useMutation({
    mutationFn: (action: 'approve' | 'skip') =>
      action === 'approve'
        ? // The revision the bell shows is the one approved, which the server checks is still the one.
          approve(approvalId, { oneClick: true, revision: approval.data?.revision ?? 0 })
        : skip(approvalId),
    onSuccess: async (result) => {
      client.setQueryData(key, result);
      await refreshRoutines(client);
    },
    // A plan that changed since the bell showed it comes back as it is now, to be read again, and
    // one with nothing left to do comes back closed.
    onError: async (error) => {
      if (
        error instanceof ApiError &&
        (error.info.messageKey === 'routines.approval.stale' ||
          error.info.messageKey === 'routines.approval.nothingLeft')
      )
        await refreshRoutines(client);
    },
  });
  const current = approval.data;
  if (!current) return null;
  const failure = act.error
    ? message(act.error instanceof ApiError ? act.error.info.messageKey : 'errors.internal')
    : current.messageKey
      ? message(current.messageKey)
      : null;
  // Only a small record edit, with nothing deleted and every change shown right here, is approved in
  // one click.  Anything else, emails and sites included, is read and approved on the routine's page.
  const oneClick =
    current.kind === 'plan' &&
    Boolean(current.changes?.small) &&
    (current.changes?.tables.reduce((count, table) => count + (table.records?.length ?? 0), 0) ?? 0) <=
      ROUTINE_BELL_RECORDS &&
    Boolean(
      current.changes?.tables.every((table) =>
        table.records
          ? table.records.length <= ROUTINE_BELL_RECORDS &&
            table.records.every((record) => record.fields.length <= ROUTINE_BELL_FIELDS)
          : table.fields.every((field) => !field.more && field.values.length <= ROUTINE_BELL_VALUES),
      ),
    );
  const recipients = current.email ? words.list(current.email.to) : '';
  const subject = current.email?.subject ?? '';
  const sites = words.list(current.sites);
  return (
    <div className="rio-notifications__actions">
      {current.kind === 'plan' && current.changes ? (
        <ChangeSummary changes={current.changes} compact />
      ) : current.email ? (
        <p className="rio-notifications__detail">
          {t({ id: 'routines.approval.emailTo', message: `An email to ${recipients}: ${subject}` })}
        </p>
      ) : current.kind === 'hosts' ? (
        <p className="rio-notifications__detail">
          {t({ id: 'routines.approval.hostsList', message: `Read these new sites? ${sites}` })}
        </p>
      ) : null}
      {current.status === 'pending' ? (
        <>
          {oneClick ? (
            <Button
              size="sm"
              variant="primary"
              isPending={act.isPending}
              onPress={() => act.mutate('approve')}
            >
              {t({ id: 'routines.approval.approvePlan', message: 'Approve changes' })}
            </Button>
          ) : (
            <Link href={routineHref(current.databaseId, current.routineId)}>
              {t({ id: 'routines.approval.review', message: 'Review it to approve' })}
            </Link>
          )}
          <Button size="sm" isDisabled={act.isPending} onPress={() => act.mutate('skip')}>
            {t({ id: 'routines.approval.skip', message: 'Skip' })}
          </Button>
        </>
      ) : (
        <span className="rio-notifications__detail">{words.approvalStates[current.status]}</span>
      )}
      {current.receipt ? (
        <UndoChanges databaseId={current.receipt.databaseId} groupId={current.receipt.groupId} />
      ) : null}
      {failure ? <p role="alert">{failure}</p> : null}
    </div>
  );
}
