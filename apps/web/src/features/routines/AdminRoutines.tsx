import { faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminRoutine } from '@riosoma/contracts';
import { Button, ConfirmDialog, Heading, Spinner } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { adminDelete, adminKey, adminPause, adminRoutines, refreshRoutines } from './api';
import { useRoutineWords } from './words';
import './routines.css';

/**
 * Every routine in the organization, for admins with the AI role: whose it is, where, and how its
 * last run went, with a way to pause any of them, lift their own pauses, and delete them.  Only an
 * admin deletes a routine an admin paused.  What it does, and when, shows only for a database the
 * admin can open themselves.
 */
export function AdminRoutines() {
  const { t } = useLingui();
  const words = useRoutineWords();
  const message = useServerMessage();
  const client = useQueryClient();
  const routines = useQuery({ queryKey: adminKey, queryFn: ({ signal }) => adminRoutines(signal) });
  const pause = useMutation({
    mutationFn: ({ routineId, paused }: { routineId: string; paused: boolean }) =>
      adminPause(routineId, paused),
    onSuccess: () => refreshRoutines(client),
  });
  const [deleting, setDeleting] = useState<AdminRoutine | null>(null);
  const remove = useMutation({
    mutationFn: (routine: AdminRoutine) => adminDelete(routine.id),
    onSuccess: () => refreshRoutines(client),
  });
  const listed = routines.data ?? [];
  const deletingName = deleting?.name ?? '';
  const deletingOwner = deleting?.owner.name ?? '';
  return (
    <section className="rio-routines" aria-labelledby="ai-routines-heading">
      <Heading level={2} id="ai-routines-heading">
        <Trans id="ai.routines.list">Everyone’s routines</Trans>
      </Heading>
      <ErrorBanner error={errorInfo(routines.error ?? pause.error ?? remove.error)} />
      {routines.isPending ? (
        <Spinner label={t({ id: 'routines.loading', message: 'Loading routines' })} />
      ) : listed.length === 0 ? (
        <p className="rio-routines__note">
          <Trans id="ai.routines.none">Nobody has set up a routine yet.</Trans>
        </p>
      ) : (
        <ul className="rio-routines__list">
          {listed.map((routine) => {
            const owner = routine.owner.name;
            const database = routine.databaseName;
            const lastState = routine.lastRun ? words.runStates[routine.lastRun.state] : null;
            const name = routine.name;
            const sites = words.list(routine.details?.approvedSites ?? []);
            return (
              <li key={routine.id} className="rio-routines__item" data-paused={routine.paused || undefined}>
                <div className="rio-routines__head">
                  <strong>{name}</strong>
                  {routine.adminPaused ? (
                    <Button
                      size="sm"
                      isPending={pause.isPending && pause.variables?.routineId === routine.id}
                      aria-label={t({ id: 'ai.routines.resumeOne', message: `Resume ${name}` })}
                      onPress={() => pause.mutate({ routineId: routine.id, paused: false })}
                    >
                      {t({ id: 'ai.routines.resume', message: 'Resume' })}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      isPending={pause.isPending && pause.variables?.routineId === routine.id}
                      aria-label={t({ id: 'ai.routines.pauseOne', message: `Pause ${name}` })}
                      onPress={() => pause.mutate({ routineId: routine.id, paused: true })}
                    >
                      {t({ id: 'ai.routines.pause', message: 'Pause' })}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="quiet"
                    aria-label={t({ id: 'ai.routines.deleteOne', message: `Delete ${name}` })}
                    onPress={() => {
                      remove.reset();
                      setDeleting(routine);
                    }}
                    icon={faTrashCan}
                  />
                </div>
                <p className="rio-routines__note">
                  {t({ id: 'ai.routines.whose', message: `${owner}’s, in ${database}` })}
                  {routine.details ? ` · ${words.schedule(routine.details.schedule)}` : null}
                </p>
                {routine.details ? (
                  <>
                    <p className="rio-routines__note">{routine.details.plan.summary}</p>
                    {routine.details.approvedSites.length ? (
                      <p className="rio-routines__note rio-routines__sites">
                        {t({
                          id: 'ai.routines.sites',
                          message: `Reads the home pages of ${sites}`,
                        })}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="rio-routines__note">
                    {t({
                      id: 'ai.routines.withheld',
                      message: 'You can’t open its database, so what it does stays with its owner.',
                    })}
                  </p>
                )}
                {routine.paused ? (
                  <p className="rio-routines__status" data-tone="warning">
                    {t({ id: 'routines.status.paused', message: 'Paused.' })}{' '}
                    {routine.pausedBecause ? message(routine.pausedBecause) : null}
                  </p>
                ) : null}
                {lastState ? (
                  <p className="rio-routines__status">
                    {t({ id: 'routines.status.last', message: `Last run: ${lastState}` })}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'ai.routines.delete.title', message: `Delete ${deletingName}?` })}
          message={t({
            id: 'ai.routines.delete.message',
            message: `It stops running for ${deletingOwner} for good, and its history and anything waiting for their approval go with it.`,
          })}
          confirmLabel={t({ id: 'routines.delete.confirm', message: 'Delete routine' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting)}
        />
      ) : null}
    </section>
  );
}
