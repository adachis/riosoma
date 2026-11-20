import { faArrowsRotate, faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import type { OutboundSync, ViewSyncOut } from '@riosoma/contracts';
import { Banner, Button, Link, Menu, MenuItem, MenuTrigger, Spinner, Switch } from '@riosoma/ui';
import { Icon } from '@riosoma/icons';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../messages/errorInfo';
import { useRelativeTime } from '../../relative-time';
import { anchor } from '../../demos/anchors';
import { KIND_ICONS, useSyncOutWords } from './words';

/** Narrower than this the Sync now button is its icon alone, so the head row never wraps. */
function useNarrow(query = '(max-width: 599px)'): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.(query).matches),
  );
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return narrow;
}

/** The last run, as a relative time, rendered only when there is one so the hook never sees null. */
function Synced({ at, problems }: { at: string; problems: boolean }) {
  const { t } = useLingui();
  const when = useRelativeTime(at);
  return (
    <>
      {problems
        ? t({ id: 'syncOut.status.problems', message: `Synced ${when}, with problems.` })
        : t({ id: 'syncOut.status.synced', message: `Synced ${when}.` })}
    </>
  );
}

function StatusLine({ sync }: { sync: OutboundSync }) {
  const { t } = useLingui();
  const words = useSyncOutWords();
  const message = useServerMessage();
  const { status } = sync;
  if (!sync.enabled && sync.stoppedBecause)
    return (
      <p className="rio-sync-out__status" data-tone="warning" role="status">
        {t({ id: 'syncOut.status.stopped', message: 'Turned itself off.' })} {message(sync.stoppedBecause)}
      </p>
    );
  if (!sync.enabled)
    return (
      <p className="rio-sync-out__status" role="status">
        {t({ id: 'syncOut.status.off', message: 'Turned off.' })}
      </p>
    );
  if (status.state === 'running')
    return (
      <p className="rio-sync-out__status" role="status">
        <Spinner size="sm" />
        {status.progress
          ? t({
              id: 'syncOut.status.progress',
              message: `Syncing… ${status.progress.done} of ${status.progress.total} rows`,
            })
          : t({ id: 'syncOut.status.running', message: 'Syncing…' })}
      </p>
    );
  if (status.state === 'queued')
    return (
      <p className="rio-sync-out__status" role="status">
        <Spinner size="sm" />
        {t({ id: 'syncOut.status.queued', message: 'Waiting to start…' })}
      </p>
    );
  if (status.state === 'failed')
    return (
      <p className="rio-sync-out__status" data-tone="danger" role="status">
        {t({ id: 'syncOut.status.failed', message: 'The last sync didn’t finish.' })}{' '}
        {status.error ? message(status.error.messageKey, status.error.params) : null}
      </p>
    );
  // idle
  if (status.error && status.lastRunAt)
    return (
      <p className="rio-sync-out__status" data-tone="warning" role="status">
        <Synced at={status.lastRunAt} problems /> {message(status.error.messageKey, status.error.params)}
      </p>
    );
  if (!status.lastRunAt)
    return (
      <p className="rio-sync-out__status" role="status">
        {t({ id: 'syncOut.status.never', message: 'Hasn’t synced yet.' })}
      </p>
    );
  return (
    <p className="rio-sync-out__status" role="status">
      <Synced at={status.lastRunAt} problems={false} />
      {status.nextRunAt
        ? ` ${t({ id: 'syncOut.status.next', message: `Next sync ${words.moment(status.nextRunAt)}.` })}`
        : null}
    </p>
  );
}

function SyncItem({
  sync,
  busy,
  onToggle,
  onRun,
  onEdit,
  onRuns,
  onDelete,
}: {
  sync: OutboundSync;
  busy: boolean;
  onToggle(enabled: boolean): void;
  onRun(): void;
  onEdit(): void;
  onRuns(): void;
  onDelete(): void;
}) {
  const { t } = useLingui();
  const words = useSyncOutWords();
  const narrow = useNarrow();
  const name = sync.name;
  const menuLabel = t({ id: 'syncOut.item.more', message: `More for ${name}` });
  const where =
    sync.destination.kind === 'airtable'
      ? t({
          id: 'syncOut.where.airtable',
          message: `${sync.destination.table.name} in ${sync.destination.baseName}, Airtable`,
        })
      : t({ id: 'syncOut.where.smartsheet', message: `${sync.destination.table.name}, Smartsheet` });
  const busyState = sync.status.state === 'queued' || sync.status.state === 'running';
  const syncNowLabel =
    sync.status.state === 'failed'
      ? t({ id: 'syncOut.tryAgain', message: 'Try again' })
      : t({ id: 'syncOut.syncNow', message: 'Sync now' });
  return (
    <li className="rio-sync-out__item" data-state={sync.status.state} data-enabled={sync.enabled}>
      <div className="rio-sync-out__head">
        <div className="rio-sync-out__title">
          <Icon icon={KIND_ICONS[sync.destination.kind]} className="rio-sync-out__kind" aria-hidden="true" />
          {sync.canEdit ? (
            <Switch isSelected={sync.enabled} isDisabled={busy} onChange={onToggle}>
              {name}
            </Switch>
          ) : (
            <strong className="rio-sync-out__name">{name}</strong>
          )}
        </div>
        <div className="rio-sync-out__head-actions">
          {sync.canRun ? (
            narrow ? (
              <Button
                variant="secondary"
                size="sm"
                icon={faArrowsRotate}
                aria-label={syncNowLabel}
                isDisabled={busyState}
                onPress={onRun}
              />
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={faArrowsRotate}
                isDisabled={busyState}
                onPress={onRun}
              >
                {syncNowLabel}
              </Button>
            )
          ) : null}
          <MenuTrigger>
            <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menuLabel} />
            <Menu aria-label={menuLabel}>
              <MenuItem id="history" onAction={onRuns}>
                {t({ id: 'syncOut.item.history', message: 'History' })}
              </MenuItem>
              {sync.canEdit ? (
                <MenuItem id="edit" onAction={onEdit}>
                  {t({ id: 'syncOut.item.edit', message: 'Change settings' })}
                </MenuItem>
              ) : null}
              {sync.canDelete ? (
                <MenuItem id="delete" tone="danger" onAction={onDelete}>
                  {t({ id: 'syncOut.item.delete', message: 'Delete' })}
                </MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        </div>
      </div>
      <dl className="rio-sync-out__facts">
        <div>
          <dt>{t({ id: 'syncOut.fact.destination', message: 'Goes to' })}</dt>
          <dd>
            {where}
            {sync.destination.table.url ? (
              <>
                {' '}
                <Link external href={sync.destination.table.url} className="rio-sync-out__open">
                  {t({ id: 'syncOut.open', message: 'Open' })}
                </Link>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t({ id: 'syncOut.fact.schedule', message: 'Schedule' })}</dt>
          <dd>{words.interval(sync.settings.everyMinutes)}</dd>
        </div>
        {sync.status.stats ? (
          <div>
            <dt>{t({ id: 'syncOut.fact.last', message: 'Last sync' })}</dt>
            <dd>{words.counts(sync.status.stats)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t({ id: 'syncOut.fact.by', message: 'Set up by' })}</dt>
          <dd>{sync.creator.name}</dd>
        </div>
      </dl>
      <StatusLine sync={sync} />
      {sync.status.withheld.length > 0 ? (
        <p className="rio-sync-out__note">
          {t({
            id: 'syncOut.withheld',
            message: plural(sync.status.withheld.length, {
              one: `# field isn’t sent because of its classification: ${new Intl.ListFormat(words.locale, { type: 'conjunction' }).format(sync.status.withheld.map((field) => field.fieldName))}`,
              other: `# fields aren’t sent because of their classification: ${new Intl.ListFormat(words.locale, { type: 'conjunction' }).format(sync.status.withheld.map((field) => field.fieldName))}`,
            }),
          })}
        </p>
      ) : null}
    </li>
  );
}

/** The "Set up a sync" button, which carries the setup anchor wherever it shows. */
function AddSync({ variant, onPress }: { variant: 'primary' | 'secondary'; onPress(): void }) {
  return (
    <Button variant={variant} onPress={onPress} {...anchor('syncOut.add')}>
      <Trans id="syncOut.add">Set up a sync</Trans>
    </Button>
  );
}

export function SyncOutList({
  data,
  loading,
  queryError,
  commandError,
  busyId,
  onRetry,
  onSetup,
  onToggle,
  onRun,
  onEdit,
  onRuns,
  onDelete,
}: {
  data: ViewSyncOut | undefined;
  loading: boolean;
  queryError: unknown;
  commandError: unknown;
  busyId: string | null;
  onRetry(): void;
  onSetup(): void;
  onToggle(sync: OutboundSync, enabled: boolean): void;
  onRun(sync: OutboundSync): void;
  onEdit(sync: OutboundSync): void;
  onRuns(sync: OutboundSync): void;
  onDelete(sync: OutboundSync): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const syncs = data?.syncs ?? [];
  return (
    <div className="rio-sync-out">
      <p className="rio-sync-out__intro">
        <Trans id="syncOut.intro">
          {
            'Keep a copy of this view’s rows in another tool.  Riosoma sends the fields and rows the view shows, and updates the copy when they change.'
          }
        </Trans>
      </p>
      {data && data.unavailable ? <Banner tone="info">{message(data.unavailable)}</Banner> : null}
      {queryError ? <RetryBanner error={queryError} onRetry={onRetry} /> : null}
      <ErrorBanner error={errorInfo(commandError)} />
      {loading ? (
        <Spinner label={t({ id: 'syncOut.loading', message: 'Loading syncs…' })} />
      ) : syncs.length === 0 ? (
        data?.canCreate ? (
          <div className="rio-sync-out__empty">
            <p>
              <Trans id="syncOut.empty">This view isn’t synced anywhere yet.</Trans>
            </p>
            <AddSync variant="primary" onPress={onSetup} />
          </div>
        ) : (
          <p className="rio-sync-out__empty">
            <Trans id="syncOut.empty">This view isn’t synced anywhere yet.</Trans>
          </p>
        )
      ) : (
        <>
          {data?.canCreate ? (
            <div className="rio-sync-out__actions">
              <AddSync variant="secondary" onPress={onSetup} />
            </div>
          ) : null}
          <ul className="rio-sync-out__list">
            {syncs.map((sync) => (
              <SyncItem
                key={sync.id}
                sync={sync}
                busy={busyId === sync.id}
                onToggle={(enabled) => onToggle(sync, enabled)}
                onRun={() => onRun(sync)}
                onEdit={() => onEdit(sync)}
                onRuns={() => onRuns(sync)}
                onDelete={() => onDelete(sync)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The failed-query banner with a "Try again" that refetches the list. */
function RetryBanner({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const info = errorInfo(error);
  return (
    <Banner tone="danger">
      {info ? message(info.key, info.params) : null}
      <Button size="sm" onPress={onRetry}>
        {t({ id: 'syncOut.retry', message: 'Try again' })}
      </Button>
    </Banner>
  );
}
