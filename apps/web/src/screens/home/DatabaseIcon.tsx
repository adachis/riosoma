import { Icon } from '@riosoma/icons';
import type { DatabaseSummary } from '@riosoma/contracts';
import { faDatabase, faStar } from '@fortawesome/free-solid-svg-icons';
import { lazy, Suspense } from 'react';
import './home.css';
import { preloadImport } from '../../asset-recovery';

// Default files need no icon catalog.  Custom icons keep the same box while their paths load.
const NamedDatabaseIcon = lazy(() =>
  preloadImport(() => import('./databaseIcons'))
    .then(({ databaseIcon }) => ({
      default: ({ name }: { name: string }) => <Icon icon={databaseIcon(name)} />,
    }))
    .catch(() => ({ default: () => <Icon icon={faDatabase} /> })),
);

export function DatabaseIcon({ database }: { database: Pick<DatabaseSummary, 'icon' | 'color'> }) {
  const standard = !database.icon || database.icon === 'database' || database.icon === 'star';
  const fallback = <Icon icon={database.icon === 'star' ? faStar : faDatabase} />;
  return (
    <span
      className="rio-database-icon"
      style={{ background: `var(--rio-aa-choice-${database.color ?? 'gray'})` }}
      aria-hidden="true"
    >
      {standard ? (
        fallback
      ) : (
        <Suspense fallback={fallback}>
          <NamedDatabaseIcon name={database.icon!} />
        </Suspense>
      )}
    </span>
  );
}
