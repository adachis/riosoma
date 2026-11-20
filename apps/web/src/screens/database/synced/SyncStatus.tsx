import { faGear, faLink, faPause, faRotate, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useRef, useState } from 'react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { roleAllows, type TableMeta, type TableSource } from '@riosoma/contracts';
import { Button, Spinner, useConfirm } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { useRelativeTime } from '../../../relative-time';
import { reportError } from '../../../grid/view/actions';
import { serverMessage } from '../../../messages/useServerMessage';
import { JoinsDialog } from '../joins/JoinsDialog';
import { SyncSettings } from './SyncSettings';
import { useCelebrations } from '../../../features/celebrations/useCelebrations';
import './synced.css';

export function SyncStatus({
  table,
  session,
}: {
  table: TableMeta & { source: TableSource };
  session: DatabaseSession;
}) {
  const { t, i18n } = useLingui();
  const ask = useConfirm();
  const [settings, setSettings] = useState(false);
  const [finding, setFinding] = useState(false);
  const [dismissed, setDismissed] = useState<TableSource['status']>();
  const [pending, setPending] = useState(false);
  const { status, sourceName: source } = table.source;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (status.state !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [status.state, status.lastSyncAt]);
  const seconds = Math.max(0, Math.floor((now - Date.parse(status.lastSyncAt ?? '')) / 1_000)) || 0;
  const rows = status.progress?.rowsRead ?? 0;
  const when = useRelativeTime(status.lastSuccessAt ?? '');
  const busy = pending || status.state === 'queued' || status.state === 'running';
  const canSync = roleAllows(session.role(), 'editSchema');
  // A live table reads its source whenever it's read, so it has no sync to run or wait for.
  const live = table.source.freshness === 'live' && !status.switchingToCopy;
  // A webhook's table fills as posts arrive, so it has no sync to run either.
  const hook = table.source.sourceKind === 'webhook';
  const switching = status.switchingToCopy === true;
  const firstCopy =
    !live && !hook && !switching && !status.lastSuccessAt && (busy || status.state === 'failed');
  const removing = status.held?.removing ?? 0;
  const total = status.held?.total ?? 0;
  const count = removing;
  // A table seen before its first sync worked celebrates the moment one does.  It's the person's
  // own only when they asked for the sync that worked.  A schedule's is someone else's, so it plays
  // no sound.
  const root = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const synced = status.lastSuccessAt !== null;
  const failed = status.state === 'failed';
  const { observe } = useCelebrations();
  useEffect(() => {
    if (failed) asked.current = false;
  }, [failed]);
  useEffect(() => {
    if (live) return;
    observe('syncFirstSuccess', table.id, synced, {
      anchor: root.current,
      cause: asked.current ? 'you' : 'others',
    });
    if (synced) asked.current = false;
  }, [live, synced, table.id, observe]);
  async function sync(confirmRemovals = false) {
    if (
      confirmRemovals &&
      !(await ask({
        title: t({
          id: 'synced.remove.title',
          message: plural(count, { one: 'Remove # record?', other: 'Remove # records?' }),
        }),
        message: t({
          id: 'synced.remove.body',
          message: 'They’re missing from the source.  Records return if the source has them again.',
        }),
        confirmLabel: t({ id: 'synced.removeThem', message: 'Remove them' }),
        tone: 'danger',
      }))
    )
      return;
    setPending(true);
    asked.current = true;
    try {
      await session.run([{ kind: 'table.sync', tableId: table.id, confirmRemovals }]).done;
    } catch (error) {
      asked.current = false;
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className={`rio-synced-status${firstCopy ? ' rio-synced-status--first-copy' : ''}`} ref={root}>
      <div role="status">
        {live ? (
          t({ id: 'synced.status.live', message: `Live from ${source}` })
        ) : hook ? (
          status.state === 'failed' ? (
            <>
              <Trans id="synced.status.hookFailed">The last post couldn’t be written.</Trans>
              {status.error && (
                <span>{serverMessage(i18n, status.error.messageKey, status.error.params)}</span>
              )}
            </>
          ) : status.lastSuccessAt ? (
            t({ id: 'synced.status.hookPosted', message: `Last post from ${source} ${when}` })
          ) : (
            t({ id: 'synced.status.hookWaiting', message: `Waiting for the first post to ${source}` })
          )
        ) : busy && switching ? (
          <>
            <Spinner size="sm" />
            {t({
              id: 'synced.status.switching',
              message: 'Making the first copy.  Reading live until it finishes…',
            })}
          </>
        ) : busy ? (
          <>
            <Spinner size="sm" />
            <Trans id="synced.status.syncing">Syncing…</Trans>
            {status.state === 'running' && !status.lastSuccessAt && (
              <span>
                <Trans id="synced.status.copyStarted">Copy started.</Trans>
              </span>
            )}
            {status.state === 'running' && status.progress && (
              <span>
                {t({
                  id: 'synced.status.rowsRead',
                  message: plural(rows, {
                    one: '# row read',
                    other: '# rows read',
                  }),
                })}
              </span>
            )}
          </>
        ) : status.state === 'failed' ? (
          <>
            <Trans id="synced.status.failed">The last sync failed.</Trans>
            {status.error && <span>{serverMessage(i18n, status.error.messageKey, status.error.params)}</span>}
            {status.error?.detail && <span>{status.error.detail}</span>}
          </>
        ) : status.state === 'held' && status.held ? (
          t({
            id: 'synced.status.held',
            message: plural(removing, {
              one: `This sync would remove # of ${total} records.`,
              other: `This sync would remove # of ${total} records.`,
            }),
          })
        ) : status.lastSuccessAt ? (
          t({ id: 'synced.status.synced', message: `Synced from ${source} ${when}` })
        ) : (
          t({ id: 'synced.status.never', message: `Waiting for the first sync from ${source}` })
        )}
      </div>
      {status.state === 'running' && !live && !hook && (
        <span className="rio-synced-elapsed">
          {t({
            id: 'synced.status.elapsed',
            message: plural(seconds, {
              one: '# second elapsed',
              other: '# seconds elapsed',
            }),
          })}
        </span>
      )}
      {live && (
        <Button
          size="sm"
          onPress={() => session.refreshTable?.(table.id)}
          icon={faRotate}
          aria-label={t({ id: 'synced.readAgain', message: 'Read again' })}
        />
      )}
      {canSync &&
        !busy &&
        !live &&
        !hook &&
        (status.state === 'held' && dismissed !== status ? (
          <>
            <Button
              size="sm"
              onPress={() => {
                void sync(true);
              }}
              aria-label={t({ id: 'synced.removeThem', message: 'Remove them' })}
              icon={faXmark}
            />
            <Button
              size="sm"
              variant="quiet"
              onPress={() => setDismissed(status)}
              icon={faPause}
              aria-label={t({ id: 'synced.keepThem', message: 'Keep them for now' })}
            />
          </>
        ) : (
          <Button
            size="sm"
            onPress={() => {
              void sync();
            }}
            icon={faRotate}
            aria-label={
              status.state === 'failed'
                ? t({ id: 'synced.tryAgain', message: 'Try again' })
                : t({ id: 'synced.syncNow', message: 'Sync now' })
            }
          />
        ))}
      {canSync && !live && !switching && (
        <Button
          size="sm"
          variant="quiet"
          onPress={() => setFinding(true)}
          icon={faLink}
          aria-label={t({ id: 'joins.find', message: 'Find links' })}
        />
      )}
      {canSync && (
        <Button
          size="sm"
          variant="quiet"
          onPress={() => setSettings(true)}
          icon={faGear}
          aria-label={t({ id: 'synced.settings', message: 'Sync settings' })}
        />
      )}
      {settings && <SyncSettings table={table} session={session} onClose={() => setSettings(false)} />}
      {finding && <JoinsDialog session={session} tableId={table.id} onClose={() => setFinding(false)} />}
    </div>
  );
}
