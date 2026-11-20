import { faPlus, faRepeat } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { Icon } from '@riosoma/icons';
import { Button } from '@riosoma/ui';
import { rioStatusQuery } from '../rio/status';
import { listKey, listRoutines } from './api';
import { RoutineDialog } from './RoutineForm';
import { routineHref } from './words';
import './routines.css';

/**
 * The sidebar's list of the person's own routines in this database, with a way to set up another.
 * It shows while routines are on for them, and while they have one here to open.
 */
export function RoutineSidebar({
  databaseId,
  activeRoutineId,
}: {
  databaseId: string;
  activeRoutineId: string | null;
}) {
  const { t } = useLingui();
  const id = useId();
  const [adding, setAdding] = useState(false);
  const status = useQuery(rioStatusQuery);
  const routines = useQuery({
    queryKey: listKey(databaseId),
    queryFn: ({ signal }) => listRoutines(databaseId, signal),
    enabled: Boolean(status.data?.enabled),
  });
  const listed = routines.data ?? [];
  const canAdd = Boolean(status.data?.routines);
  if (!listed.length && !canAdd) return null;
  return (
    <section className="rio-routine-list" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="rio-routine-list__heading">
        {t({ id: 'routines.section', message: 'Routines' })}
      </h2>
      {listed.length ? (
        <ul className="rio-routine-list__items">
          {listed.map((routine) => (
            <li
              key={routine.id}
              className="rio-routine-list__item"
              data-active={routine.id === activeRoutineId || undefined}
              data-paused={routine.paused || undefined}
            >
              <Link
                to={routineHref(databaseId, routine.id)}
                className="rio-routine-list__open"
                aria-current={routine.id === activeRoutineId ? 'page' : undefined}
              >
                <Icon icon={faRepeat} />
                <span>{routine.name}</span>
                {routine.waiting ? (
                  <span className="rio-routine-list__badge">
                    {t({ id: 'routines.sidebar.waiting', message: 'Waiting' })}
                  </span>
                ) : routine.paused ? (
                  <span className="rio-routine-list__badge">
                    {t({ id: 'routines.sidebar.paused', message: 'Paused' })}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {canAdd ? (
        <Button
          className="rio-routine-list__add"
          variant="quiet"
          icon={faPlus}
          onPress={() => setAdding(true)}
          aria-label={t({ id: 'routines.add', message: 'Add a routine' })}
        />
      ) : null}
      {adding ? <RoutineDialog databaseId={databaseId} onClose={() => setAdding(false)} /> : null}
    </section>
  );
}
