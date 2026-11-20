import { faEllipsis, faPlus } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Routine } from '@riosoma/contracts';
import { Button, ConfirmDialog, Link, Menu, MenuItem, MenuTrigger, Spinner, toast } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { deleteRoutine, listKey, listRoutines, pauseRoutine, refreshRoutines, runRoutine } from './api';
import { RoutineDialog } from './RoutineForm';
import { routineHref, useRoutineWords } from './words';
import './routines.css';

/** Pausing, resuming, running now, and deleting a routine, with the dialog each needs. */
export function useRoutineActions() {
  const { t } = useLingui();
  const client = useQueryClient();
  const [editing, setEditing] = useState<Routine | null>(null);
  const [deleting, setDeleting] = useState<Routine | null>(null);
  const pause = useMutation({
    mutationFn: (routine: Routine) => pauseRoutine(routine.id, !routine.paused),
    onSuccess: () => refreshRoutines(client),
  });
  const run = useMutation({
    mutationFn: (routine: Routine) => runRoutine(routine.id),
    onSuccess: async (_run, routine) => {
      const name = routine.name;
      toast.show({
        tone: 'info',
        title: t({ id: 'routines.running', message: `${name} is running` }),
        description: t({
          id: 'routines.running.detail',
          message: 'Its report arrives in your notifications when it’s done.',
        }),
      });
      await refreshRoutines(client);
    },
  });
  const remove = useMutation({
    mutationFn: (routine: Routine) => deleteRoutine(routine.id),
    onSuccess: () => refreshRoutines(client),
  });
  const deletingName = deleting?.name ?? '';
  const dialogs = (
    <>
      {editing ? <RoutineDialog routine={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'routines.delete.title', message: `Delete ${deletingName}?` })}
          message={t({
            id: 'routines.delete.message',
            message: 'It stops running, and its history and anything waiting for your approval go with it.',
          })}
          confirmLabel={t({ id: 'routines.delete.confirm', message: 'Delete routine' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting)}
        />
      ) : null}
    </>
  );
  return {
    dialogs,
    error: errorInfo(pause.error ?? run.error ?? remove.error),
    busy: pause.isPending || run.isPending,
    edit: setEditing,
    confirmDelete: (routine: Routine) => {
      remove.reset();
      setDeleting(routine);
    },
    togglePause: (routine: Routine) => {
      pause.reset();
      pause.mutate(routine);
    },
    runNow: (routine: Routine) => {
      run.reset();
      run.mutate(routine);
    },
  };
}

/** The menu of what a person can do with their own routine. */
export function RoutineMenu({
  routine,
  actions,
  open = true,
}: {
  routine: Routine;
  actions: ReturnType<typeof useRoutineActions>;
  /** Whether to offer opening its page */
  open?: boolean;
}) {
  const { t } = useLingui();
  const name = routine.name;
  const label = t({ id: 'routines.actions', message: `More for ${name}` });
  return (
    <MenuTrigger>
      <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={label} isDisabled={actions.busy} />
      <Menu aria-label={label}>
        {open ? (
          <MenuItem id="open" href={routineHref(routine.databaseId, routine.id)}>
            {t({ id: 'routines.open', message: 'Open' })}
          </MenuItem>
        ) : null}
        {/* A paused routine runs by no path, and only an admin lifts an admin's pause. */}
        <MenuItem id="run" isDisabled={routine.paused} onAction={() => actions.runNow(routine)}>
          {t({ id: 'routines.runNow', message: 'Run now' })}
        </MenuItem>
        <MenuItem id="pause" isDisabled={routine.adminPaused} onAction={() => actions.togglePause(routine)}>
          {routine.paused
            ? t({ id: 'routines.resume', message: 'Resume' })
            : t({ id: 'routines.pause', message: 'Pause' })}
        </MenuItem>
        <MenuItem id="edit" onAction={() => actions.edit(routine)}>
          {t({ id: 'routines.edit', message: 'Edit' })}
        </MenuItem>
        {/* Only an admin deletes a routine an admin paused. */}
        <MenuItem
          id="delete"
          tone="danger"
          isDisabled={routine.adminPaused}
          onAction={() => actions.confirmDelete(routine)}
        >
          {t({ id: 'routines.delete', message: 'Delete' })}
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}

/** Where a routine stands: paused and why, or when it runs next, and how its last run went. */
export function RoutineStatus({ routine }: { routine: Routine }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const message = useServerMessage();
  const next = routine.nextRunAt ? words.moment(routine.nextRunAt, routine.timeZone) : null;
  const last = routine.lastRun;
  const lastState = last ? words.runStates[last.state] : '';
  const waiting = routine.waiting;
  return (
    <>
      {routine.paused ? (
        <p className="rio-routines__status" data-tone="warning">
          {t({ id: 'routines.status.paused', message: 'Paused.' })}{' '}
          {routine.pausedBecause ? message(routine.pausedBecause) : null}
        </p>
      ) : next ? (
        <p className="rio-routines__status">
          {t({ id: 'routines.status.next', message: `Next runs ${next}` })}
        </p>
      ) : null}
      {last ? (
        <p className="rio-routines__status">
          {t({ id: 'routines.status.last', message: `Last run: ${lastState}` })}
          {last.messageKey ? ` ${message(last.messageKey)}` : null}
        </p>
      ) : null}
      {waiting > 0 ? (
        <p className="rio-routines__status" data-tone="attention">
          {t({
            id: 'routines.status.waiting',
            message: `${waiting} waiting for your approval`,
          })}
        </p>
      ) : null}
    </>
  );
}

/** A person's own routines, in one database or in all of them. */
export function RoutineList({ databaseId, onNew }: { databaseId?: string; onNew?(): void }) {
  const { t } = useLingui();
  const words = useRoutineWords();
  const actions = useRoutineActions();
  const routines = useQuery({
    queryKey: listKey(databaseId),
    queryFn: ({ signal }) => listRoutines(databaseId, signal),
  });
  if (routines.isPending)
    return <Spinner label={t({ id: 'routines.loading', message: 'Loading routines' })} />;
  const listed = routines.data ?? [];
  return (
    <div className="rio-routines">
      <ErrorBanner error={errorInfo(routines.error) ?? actions.error} />
      {listed.length === 0 && !routines.isError ? (
        <p className="rio-routines__note">
          <Trans id="routines.empty">
            {
              'No routines yet.  A routine is a job Rio does for you on a schedule, described in your own words.'
            }
          </Trans>
        </p>
      ) : null}
      {onNew ? (
        <div className="rio-routines__actions">
          <Button
            variant="primary"
            onPress={onNew}
            aria-label={t({ id: 'routines.new', message: 'New routine' })}
            icon={faPlus}
          />
        </div>
      ) : null}
      <ul className="rio-routines__list">
        {listed.map((routine) => (
          <li key={routine.id} className="rio-routines__item" data-paused={routine.paused || undefined}>
            <div className="rio-routines__head">
              <Link href={routineHref(routine.databaseId, routine.id)}>{routine.name}</Link>
              <RoutineMenu routine={routine} actions={actions} open={false} />
            </div>
            <p className="rio-routines__note">
              {words.schedule(routine.schedule)}
              {databaseId ? null : ` · ${routine.databaseName}`}
            </p>
            <RoutineStatus routine={routine} />
          </li>
        ))}
      </ul>
      {actions.dialogs}
    </div>
  );
}
