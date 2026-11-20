import { faDownload } from '@fortawesome/free-solid-svg-icons';
import { LazyBoundary } from '../../shell/lazy';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type ReactNode,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { SharedViewId, type SharedView, type SharedViewOpen } from '@riosoma/contracts';
import { DEFAULT_THEME, type ThemeChoice } from '@riosoma/tokens';
import { Button, PasswordField, SearchField, Spinner } from '@riosoma/ui';
import { api, ApiError, apiFile, setPublicViewPass } from '../../api';
import { onPublicDomain } from '../../public-domain';
import { useSchema, useViewRows } from '../../data/hooks';
import type { FormatContext } from '../../grid/format';
import { useServerMessage } from '../../messages/useServerMessage';
import { useTheme } from '../../shell/useAppliedTheme';
import { saveFile } from '../database/view/download';
import { VIEW_DEFINITIONS } from '../database/views/registry';
import type { ViewComponentProps } from '../database/views/types';
import { SharedGrid } from './SharedGrid';
import { SharedRecord } from './SharedRecord';
import { SharedViewSession } from './session';
import './shared-view.css';

/** How often an open page reads the view again, besides whenever it's looked at again. */
export const REFRESH_MS = 5 * 60_000;
/** Looking away and back more often than this doesn't read everything again. */
const FOCUS_REFRESH_MS = 30_000;
const SEARCH_DELAY_MS = 250;

/** A view shared by link, at `/v/:linkId`: anyone can read it, signed in or not. */
export function SharedViewScreen() {
  const { linkId } = useParams({ from: '/v/$linkId' });
  return <SharedViewPage linkId={linkId} />;
}

export function SharedViewPage({ linkId }: { linkId: string }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const known = SharedViewId.safeParse(linkId).success;
  const layout = useQuery({
    queryKey: ['public', 'views', linkId],
    queryFn: () => api<SharedView>(`/api/public/views/${encodeURIComponent(linkId)}`),
    enabled: known,
    refetchOnWindowFocus: false,
  });
  // A link whose person is suspended answers "gone" and reads the same as one that was never there.
  const missing =
    !known ||
    (layout.error instanceof ApiError &&
      (layout.error.info.code === 'not_found' || layout.error.info.code === 'gone'));
  const theme: ThemeChoice | null = layout.data
    ? layout.data.theme
      ? { theme: layout.data.theme.id, scheme: layout.data.theme.scheme }
      : DEFAULT_THEME
    : missing || layout.isError
      ? DEFAULT_THEME
      : null;
  useTheme(theme);

  if (missing) return <Unavailable />;
  // A failed refresh keeps showing what was already read; only a first read that fails says so.
  if (!layout.data && layout.isError)
    return (
      <PublicLayout>
        <div className="rio-shared-view__card" role="alert">
          <p>
            {layout.error instanceof ApiError
              ? message(layout.error.info.messageKey, layout.error.info.params)
              : message('errors.internal')}
          </p>
          <Button onPress={() => void layout.refetch()}>
            {t({ id: 'shareView.retry', message: 'Try again' })}
          </Button>
        </div>
      </PublicLayout>
    );
  if (!layout.data)
    return (
      <PublicLayout>
        <div className="rio-shared-view__card" aria-busy="true">
          <Spinner aria-label={t({ id: 'shareView.loading', message: 'Loading the view' })} />
        </div>
      </PublicLayout>
    );
  if (layout.data.status === 'locked')
    return (
      <PasswordPrompt linkId={linkId} checking={layout.isFetching} onUnlocked={() => void layout.refetch()} />
    );
  return (
    <Reading
      key={linkId}
      linkId={linkId}
      shared={layout.data}
      loadedAt={layout.dataUpdatedAt}
      onReload={() => void layout.refetch()}
    />
  );
}

/** True inside another site's page, where the page keeps to the essentials. */
function framed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // A cross-origin parent refuses to be read, which is itself the answer.
    return true;
  }
}

function PublicLayout({ children, reading = false }: { children: ReactNode; reading?: boolean }) {
  const { t } = useLingui();
  return (
    <main className="rio-shared-view" data-reading={reading || undefined} data-framed={framed() || undefined}>
      {children}
      <footer className="rio-shared-view__footer">
        {t({ id: 'shareView.poweredBy', message: 'Made with Riosoma' })}
      </footer>
    </main>
  );
}

function Unavailable() {
  const { t } = useLingui();
  return (
    <PublicLayout>
      <div className="rio-shared-view__card">
        <h1>{t({ id: 'shareView.unavailable', message: 'This view isn’t available.' })}</h1>
        <p>
          {t({
            id: 'shareView.unavailableHelp',
            message: 'It may have been unshared or deleted.  Check the link with whoever sent it.',
          })}
        </p>
      </div>
    </PublicLayout>
  );
}

function PasswordPrompt({
  linkId,
  checking,
  onUnlocked,
}: {
  linkId: string;
  /** The layout is being read again after a password was accepted */
  checking: boolean;
  onUnlocked(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const inFrame = framed();
  const publicDomain = onPublicDomain();

  async function unlock() {
    if (pending || !password) return;
    setPending(true);
    setError('');
    setAccepted(false);
    try {
      const result = await api<{ pass: string } | undefined>(
        `/api/public/views/${encodeURIComponent(linkId)}/password`,
        { body: { password } },
      );
      if (result?.pass) setPublicViewPass(linkId, result.pass);
      setAccepted(true);
      onUnlocked();
    } catch (reason) {
      const info = reason instanceof ApiError ? reason.info : null;
      setError(message(info?.messageKey ?? 'errors.internal', info?.params));
    } finally {
      setPending(false);
    }
  }

  return (
    <PublicLayout>
      <form
        className="rio-shared-view__card"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <h1>{t({ id: 'shareView.locked.title', message: 'This view has a password' })}</h1>
        <p>
          {publicDomain
            ? t({
                id: 'shareView.locked.tabHelp',
                message:
                  'Enter it to see the view.  Reloading or closing this tab asks for the password again.',
              })
            : t({
                id: 'shareView.locked.help',
                message: 'Enter it to see the view.  This device remembers it for a few hours.',
              })}
        </p>
        <PasswordField
          label={t({ id: 'shareView.locked.password', message: 'Password' })}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
          isInvalid={Boolean(error)}
          errorMessage={error}
        />
        <Button type="submit" variant="primary" isPending={pending} isDisabled={!password}>
          {t({ id: 'shareView.locked.open', message: 'Open view' })}
        </Button>
        {/* The password was right, yet the page still asks: the browser refused the cookie that remembers it. */}
        {accepted && !checking && !publicDomain && (
          <p className="rio-shared-view__kept" role="status">
            {inFrame
              ? t({
                  id: 'shareView.locked.framed',
                  message: 'This browser won’t remember the password inside another site’s page.',
                })
              : t({
                  id: 'shareView.locked.cookies',
                  message:
                    'This browser didn’t remember the password.  Allow cookies for this site, then try again.',
                })}
            {inFrame && (
              <a href={window.location.href} target="_blank" rel="noopener noreferrer">
                {t({ id: 'shareView.locked.openTab', message: 'Open the view in its own tab' })}
              </a>
            )}
          </p>
        )}
      </form>
    </PublicLayout>
  );
}

function Reading({
  linkId,
  shared,
  loadedAt,
  onReload,
}: {
  linkId: string;
  shared: SharedViewOpen;
  loadedAt: number;
  onReload(): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  // The session reads nothing until a view opens a list, so making a spare one is harmless.
  const [session] = useState(() => new SharedViewSession(linkId, shared));
  const schema = useSchema(session) ?? session.getSchema();
  const status = useSyncExternalStore(session.subscribeStatus, session.status, session.status);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [notice, setNotice] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reload = useRef(onReload);
  useEffect(() => {
    reload.current = onReload;
  });

  useEffect(() => {
    session.update(shared);
  }, [session, shared]);

  // A newer layout after the link asked for its password again, or went quiet, reads everything again.
  const statusKind = status.kind;
  useEffect(() => {
    if (statusKind === 'locked' || statusKind === 'gone') reload.current();
  }, [statusKind]);
  useEffect(() => {
    if (session.status().kind !== 'ready') session.retry();
  }, [session, loadedAt]);

  // No realtime here: the page reads again when it's looked at again, and every few minutes.
  useEffect(() => {
    let last = Date.now();
    const refresh = () => {
      last = Date.now();
      reload.current();
      session.refresh();
    };
    const look = () => {
      if (document.visibilityState === 'visible' && Date.now() - last > FOCUS_REFRESH_MS) refresh();
    };
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', look);
      document.removeEventListener('visibilitychange', look);
      clearInterval(timer);
      clearTimeout(searchTimer.current);
    };
  }, [session]);

  useEffect(() => {
    const previous = document.title;
    document.title = shared.name;
    return () => {
      document.title = previous;
    };
  }, [shared.name]);

  const table = schema.tables[0]!;
  const view = schema.views.get(table.id)![0]!;
  const fields = schema.fields.get(table.id) ?? [];
  const locale = i18n.locale || 'en-US';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = useMemo<FormatContext>(
    () => ({
      locale,
      timeZone,
      collaborators: session.people,
      linked: session.linked,
      attachments: session.attachments,
      fieldsById: schema.fieldById,
    }),
    [locale, timeZone, session, schema.fieldById],
  );

  function search(value: string) {
    setText(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      session.setQuery(value);
      setQuery(value.trim());
    }, SEARCH_DELAY_MS);
  }

  async function download() {
    if (downloading) return;
    setDownloading(true);
    setNotice('');
    try {
      const params = new URLSearchParams({ timeZone, locale });
      const file = await apiFile(`/api/public/views/${encodeURIComponent(linkId)}/download?${params}`);
      saveFile(file.blob, file.filename ?? `${shared.name}.csv`);
    } catch (reason) {
      const info = reason instanceof ApiError ? reason.info : null;
      setNotice(
        `${t({ id: 'shareView.downloadFailed', message: 'The download didn’t work.' })}  ${message(
          info?.messageKey ?? 'errors.internal',
          info?.params,
        )}`,
      );
    } finally {
      setDownloading(false);
    }
  }

  const expandedRow = expanded ? session.cachedRecord(table.id, expanded) : undefined;
  const viewProps: ViewComponentProps = {
    session,
    table,
    view,
    fields,
    format,
    canEdit: false,
    readOnly: true,
    onConfig: () => undefined,
    onExpand: setExpanded,
    attachment: (id) => session.attachments.get(id),
  };
  const definition = VIEW_DEFINITIONS[view.type];
  const noCopy = !shared.allowCopy;

  return (
    <PublicLayout reading>
      <header className="rio-shared-view__header">
        <h1>{shared.name}</h1>
        <div className="rio-shared-view__tools">
          <SearchField
            aria-label={t({ id: 'shareView.search', message: 'Search' })}
            placeholder={t({ id: 'shareView.search', message: 'Search' })}
            size="sm"
            value={text}
            onChange={search}
            className="rio-shared-view__search"
          />
          {shared.allowCopy && (
            <Button
              size="sm"
              isPending={downloading}
              onPress={() => void download()}
              aria-label={t({ id: 'shareView.download', message: 'Download CSV' })}
              icon={faDownload}
            />
          )}
        </div>
      </header>
      {definition.readingTools && definition.Settings && (
        <LazyBoundary size="controls">
          <definition.Settings key={query} {...viewProps} />
        </LazyBoundary>
      )}
      <div className="rio-shared-view__notice" role="alert">
        {status.kind === 'failed' ? (
          <>
            <span>{message(status.messageKey, status.params)}</span>
            <Button size="sm" onPress={() => session.retry()}>
              {t({ id: 'shareView.retry', message: 'Try again' })}
            </Button>
          </>
        ) : (
          notice
        )}
      </div>
      <section
        className="rio-shared-view__body"
        aria-label={shared.name}
        data-copy={noCopy ? 'off' : undefined}
        onCopy={
          noCopy
            ? (event: ClipboardEvent) => {
                event.preventDefault();
              }
            : undefined
        }
      >
        {view.type === 'grid' ? (
          <GridRows key={query} session={session} viewProps={viewProps} allowCopy={shared.allowCopy} />
        ) : definition.View ? (
          <LazyBoundary>
            <definition.View key={query} {...viewProps} />
          </LazyBoundary>
        ) : null}
      </section>
      {expandedRow && (
        <SharedRecord
          row={expandedRow}
          table={table}
          view={view}
          fields={fields}
          format={format}
          attachment={(id) => session.attachments.get(id)}
          onClose={() => setExpanded(null)}
        />
      )}
    </PublicLayout>
  );
}

function GridRows({
  session,
  viewProps,
  allowCopy,
}: {
  session: SharedViewSession;
  viewProps: ViewComponentProps;
  allowCopy: boolean;
}) {
  const rows = useViewRows(session, viewProps.view.id);
  if (!rows) return null;
  return (
    <SharedGrid
      rows={rows}
      table={viewProps.table}
      view={viewProps.view}
      fields={viewProps.fields}
      format={viewProps.format}
      allowCopy={allowCopy}
      storageKey={`grid-groups:public:${session.linkId}`}
      onExpand={viewProps.onExpand}
    />
  );
}
