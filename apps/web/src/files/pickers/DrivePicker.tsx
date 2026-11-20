import { faChevronRight, faFolder } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import type { BrowsedProvider, DriveEntry } from '@riosoma/contracts';
import { Icon } from '@riosoma/icons';
import {
  Banner,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  SearchField,
  Spinner,
} from '@riosoma/ui';
import { useEffect, useState } from 'react';
import { GridList, GridListItem, type Selection } from 'react-aria-components';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { fileIcons, fileKind, fileSize } from '../fileKind';
import { connectionStore, listDrive, thumbnailUrl, type RemotePick } from './api';
import { ConnectPrompt, useConnection, useProviderNames } from './ConnectPrompt';

interface Place {
  id: string;
  name: string;
}

/** A small picture from the drive, or the file's kind when there's none. */
function Thumbnail({ provider, entry }: { provider: BrowsedProvider; entry: DriveEntry }) {
  const [failed, setFailed] = useState(false);
  if (entry.kind === 'folder') return <Icon icon={faFolder} />;
  if (entry.thumbnail && !failed)
    return (
      <img src={thumbnailUrl(provider, entry.id)} alt="" loading="lazy" onError={() => setFailed(true)} />
    );
  return <Icon icon={fileIcons[fileKind({ name: entry.name, type: '' })]} />;
}

/**
 * Riosoma's own picker for Dropbox and Box, through their APIs alone: folders to open, a search
 * across the drive, thumbnails, sizes, and several files at once, kept while moving between
 * folders.  The list is a grid of rows, so arrow keys move between entries, Space picks a file,
 * and Enter opens a folder.  It fills a phone's screen.
 */
export function DrivePicker({
  provider,
  locale,
  onPick,
  onClose,
}: {
  provider: BrowsedProvider;
  locale: string;
  onPick(picks: RemotePick[]): void;
  onClose(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const names = useProviderNames();
  const name = names[provider];
  const { loaded, connection } = useConnection(provider);
  const connected = Boolean(connection?.account && !connection.account.needsReconnect);
  const [trail, setTrail] = useState<Place[]>([{ id: '', name }]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<ReadonlyMap<string, DriveEntry>>(new Map());
  const [more, setMore] = useState(false);
  const folder = trail.at(-1)!;
  const place = { folder: search ? '' : folder.id, query: search };
  // Connecting again gives the account a new date, which reads the listing again.
  const key = [connected, connection?.account?.connectedAt, place.folder, place.query].join('\u0000');
  const [result, setResult] = useState<{
    key: string;
    entries: DriveEntry[];
    cursor: string | null;
    error: ApiError | null;
  } | null>(null);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    listDrive(provider, { ...place, cursor: '' }, controller.signal).then(
      (page) => setResult({ key, entries: page.entries, cursor: page.cursor, error: null }),
      (failure: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ key, entries: [], cursor: null, error: failure instanceof ApiError ? failure : null });
        // The server marked the account for reconnecting, which the shared store should show too.
        if (failure instanceof ApiError && failure.info.messageKey === 'drives.reconnect')
          void connectionStore.load(true);
      },
    );
    return () => controller.abort();
    // The key names everything the listing depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const current = result?.key === key ? result : null;
  const entries = current?.entries ?? [];
  const cursor = current?.cursor ?? null;
  const error = current?.error ?? null;
  const loading = connected && (!current || more);

  async function showMore() {
    if (!current?.cursor) return;
    setMore(true);
    try {
      const page = await listDrive(provider, { ...place, cursor: current.cursor });
      setResult((latest) =>
        latest?.key === key
          ? { ...latest, entries: [...latest.entries, ...page.entries], cursor: page.cursor }
          : latest,
      );
    } catch (failure) {
      setResult((latest) =>
        latest?.key === key ? { ...latest, error: failure instanceof ApiError ? failure : null } : latest,
      );
    } finally {
      setMore(false);
    }
  }

  const needsAccount =
    loaded &&
    (!connected ||
      error?.info.messageKey === 'drives.reconnect' ||
      error?.info.messageKey === 'drives.notConnected');
  const files = entries.filter((entry) => entry.kind === 'file');
  const selected: Selection = new Set(files.filter((entry) => picked.has(entry.id)).map((entry) => entry.id));
  const open = (entry: DriveEntry) => {
    setSearch('');
    setQuery('');
    setTrail((current) => [...current, { id: entry.id, name: entry.name }]);
  };

  return (
    <Modal
      isOpen
      isDismissable
      size="lg"
      className="rio-drive-picker"
      onOpenChange={(open) => !open && onClose()}
    >
      <Dialog>
        <DialogTitle>{t({ id: 'drives.picker.title', message: `Add from ${name}` })}</DialogTitle>
        <DialogBody>
          {!loaded ? (
            <Spinner aria-label={t({ id: 'drives.picker.loading', message: 'Loading' })} />
          ) : needsAccount ? (
            <ConnectPrompt provider={provider} reconnect={Boolean(connection?.account)} />
          ) : (
            <>
              <div role="search" className="rio-drive-picker__search">
                <SearchField
                  aria-label={t({ id: 'drives.picker.search', message: `Search ${name}` })}
                  placeholder={t({ id: 'drives.picker.searchPlaceholder', message: 'Search by name' })}
                  value={query}
                  onChange={setQuery}
                  onSubmit={(value) => setSearch(value.trim())}
                  onClear={() => setSearch('')}
                />
              </div>
              <nav aria-label={t({ id: 'drives.picker.folders', message: 'Folders' })}>
                <ol className="rio-drive-picker__trail">
                  {search ? (
                    <li>
                      <Button
                        variant="quiet"
                        size="sm"
                        onPress={() => {
                          setSearch('');
                          setQuery('');
                        }}
                      >
                        {name}
                      </Button>
                      <Icon icon={faChevronRight} />
                      <span aria-current="page">
                        {t({ id: 'drives.picker.results', message: `Results for “${search}”` })}
                      </span>
                    </li>
                  ) : (
                    trail.map((place, index) => (
                      <li key={place.id || 'top'}>
                        {index > 0 && <Icon icon={faChevronRight} />}
                        {index === trail.length - 1 ? (
                          <span aria-current="page">{place.name}</span>
                        ) : (
                          <Button
                            variant="quiet"
                            size="sm"
                            onPress={() => setTrail(trail.slice(0, index + 1))}
                          >
                            {place.name}
                          </Button>
                        )}
                      </li>
                    ))
                  )}
                </ol>
              </nav>
              {error && <Banner tone="danger">{message(error.info.messageKey, error.info.params)}</Banner>}
              <GridList
                aria-label={
                  search ? t({ id: 'drives.picker.searchResults', message: 'Search results' }) : folder.name
                }
                className="rio-drive-picker__list"
                items={entries}
                selectionMode="multiple"
                selectedKeys={selected}
                disabledKeys={entries.filter((entry) => entry.kind === 'folder').map((entry) => entry.id)}
                disabledBehavior="selection"
                onSelectionChange={(keys) => {
                  const next = new Map(picked);
                  for (const entry of files) {
                    if (keys === 'all' || keys.has(entry.id)) next.set(entry.id, entry);
                    else next.delete(entry.id);
                  }
                  setPicked(next);
                }}
                onAction={(key) => {
                  const entry = entries.find((candidate) => candidate.id === key);
                  if (!entry) return;
                  if (entry.kind === 'folder') return open(entry);
                  // A row with an action takes a click or a tap as that action, never as picking,
                  // so a press on a file picks or unpicks it, the way Space does.
                  const next = new Map(picked);
                  if (next.has(entry.id)) next.delete(entry.id);
                  else next.set(entry.id, entry);
                  setPicked(next);
                }}
                renderEmptyState={() =>
                  loading ? null : (
                    <p className="rio-drive-picker__empty">
                      {search
                        ? t({ id: 'drives.picker.noResults', message: 'Nothing matches that search.' })
                        : t({ id: 'drives.picker.emptyFolder', message: 'This folder is empty.' })}
                    </p>
                  )
                }
              >
                {(entry) => (
                  <GridListItem id={entry.id} textValue={entry.name} className="rio-drive-picker__entry">
                    {({ isSelected }) => (
                      <>
                        <span
                          className="rio-drive-picker__check"
                          data-checked={isSelected || undefined}
                          aria-hidden="true"
                        />
                        <span className="rio-drive-picker__thumbnail" aria-hidden="true">
                          <Thumbnail provider={provider} entry={entry} />
                        </span>
                        <span className="rio-drive-picker__name">{entry.name}</span>
                        <span className="rio-drive-picker__size">
                          {entry.kind === 'folder'
                            ? t({ id: 'drives.picker.folder', message: 'Folder' })
                            : entry.size !== null
                              ? fileSize(entry.size, locale)
                              : ''}
                        </span>
                      </>
                    )}
                  </GridListItem>
                )}
              </GridList>
              {loading && <Spinner aria-label={t({ id: 'drives.picker.loading', message: 'Loading' })} />}
              {cursor && !loading && (
                <Button onPress={() => void showMore()}>
                  {t({ id: 'drives.picker.more', message: 'Show more' })}
                </Button>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          {picked.size > 0 && (
            <span className="rio-drive-picker__count" aria-live="polite">
              {t({ id: 'drives.picker.count', message: `${picked.size} selected` })}
            </span>
          )}
          <Button onPress={onClose}>{t({ id: 'drives.picker.cancel', message: 'Cancel' })}</Button>
          <Button
            variant="primary"
            isDisabled={!picked.size}
            onPress={() => {
              onPick(
                [...picked.values()].map((entry) => ({
                  provider,
                  fileId: entry.id,
                  name: entry.name,
                  size: entry.size,
                })),
              );
              onClose();
            }}
          >
            {t({ id: 'drives.picker.add', message: 'Add' })}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
