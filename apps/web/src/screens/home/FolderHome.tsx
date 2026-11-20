import { lazyFeature, LazyBoundary } from '../../shell/lazy';
import { HomeArrangement, HomeDragItem, HomeDropTarget, HOME_TRASH } from './HomeArrangement';
import { HomeTagsContext, TagPill, TagPills } from './Tags';
import { Shortcuts } from './ShortcutList';
import { HomeList } from './HomeList';
import { shortcutDrop, SHORTCUT_DRAG_TYPE } from './shortcuts';
import {
  faArrowRight,
  faFolderPlus,
  faShareNodes,
  faTrashCan,
  faRotateLeft,
} from '@fortawesome/free-solid-svg-icons';
import { FolderRow } from '../database/shell/FolderRow';
import { useLingui } from '@lingui/react/macro';
import {
  newId,
  roleAllows,
  type AccessLoss,
  type DatabaseSummary,
  type HomeAction,
  type HomeFolder,
} from '@riosoma/contracts';
import { Button, Heading, toast } from '@riosoma/ui';
import { MenuItem } from '../../shell/menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api';
import { invalidateNow } from '../../data/refresh';
import { ErrorBanner } from '../../shell/ShellErrorBanner';
import { errorInfo } from '../../messages/errorInfo';
import { useMinuteClock } from '../../relative-time';
import { useSession } from '../../session';

import { navigateOnPlainClick } from '../database/shell/navigation';

import { homeCommand, homeQuery, useHomeRealtime } from './folders';
import './folders.css';

const ConfirmDialog = lazyFeature(() =>
  import('../../shell/ConfirmDialog').then((module) => ({ default: module.ConfirmDialog })),
);
const FolderEditDialog = lazyFeature(() =>
  import('./FolderEditDialog').then((module) => ({ default: module.FolderEditDialog })),
);

const TagsDialog = lazyFeature(() =>
  import('./TagsDialog').then((module) => ({ default: module.TagsDialog })),
);

const ShareDialog = lazyFeature(() =>
  import('../database/share/ShareDialog').then((module) => ({ default: module.ShareDialog })),
);

const DeletedDatabasesList = lazyFeature(() =>
  import('../trash/DeletedDatabasesDialog').then((module) => ({ default: module.DeletedDatabasesList })),
);

const FolderMoveDialog = lazyFeature(() =>
  import('./FolderMoveDialog').then((module) => ({ default: module.FolderMoveDialog })),
);

type Moving = { kind: 'folder' | 'database'; id: string; name: string };

export function FolderHome({
  databases,
  children,
}: {
  databases: DatabaseSummary[];
  children(
    databases: DatabaseSummary[],
    onMove: (database: DatabaseSummary) => void,
    canCreate: boolean,
    initialLoading: boolean,
  ): ReactNode;
}) {
  const { t } = useLingui();
  const session = useSession();
  const now = useMinuteClock();
  const query = useQuery(homeQuery);
  const cache = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  useHomeRealtime();
  const folderId = location.pathname.startsWith('/home/folders/')
    ? decodeURIComponent(location.pathname.split('/')[3] ?? '')
    : null;
  const tagId = location.pathname.startsWith('/home/tags/')
    ? decodeURIComponent(location.pathname.split('/')[3] ?? '')
    : null;
  const selectedTag = query.data?.tags?.find((tag) => tag.id === tagId);
  const tagged = (kind: 'folder' | 'database', id: string) =>
    !tagId ||
    Boolean(
      query.data?.tagLinks?.some(
        (link) => link.tagId === tagId && link.resource.kind === kind && link.resource.id === id,
      ),
    );
  const [tagsOpen, setTagsOpen] = useState(false);
  const section = folderId ? 'folder' : (location.pathname.split('/')[2] ?? 'my');
  const folders = query.data?.folders ?? [];
  const current = folders.find((folder) => folder.id === folderId && !folder.trashed);
  const [editing, setEditing] = useState<HomeFolder | 'new' | null>(null);
  const [name, setName] = useState('');
  const [newParent, setNewParent] = useState<string | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [destination, setDestination] = useState<string>('root');
  const sharingId = typeof location.search?.share === 'string' ? location.search.share : null;
  const sharing = folders.find((folder) => folder.id === sharingId && !folder.trashed);
  const setSharing = (folder: HomeFolder | null) => {
    void navigate({
      to: '.',
      replace: true,
      search: (previous: Record<string, unknown>) => ({ ...previous, share: folder?.id }),
    });
  };
  const [trashing, setTrashing] = useState<HomeFolder | null>(null);
  const [undoing, setUndoing] = useState<{ id: string; losses: AccessLoss[] } | null>(null);
  const [losses, setLosses] = useState<AccessLoss[] | null>(null);
  const refresh = async () => {
    await Promise.all([
      invalidateNow(cache, ['home']),
      invalidateNow(cache, ['databases']),
      invalidateNow(cache, ['trash']),
    ]);
  };
  const change = useMutation({
    mutationFn: homeCommand,
    onSuccess: async (result) => {
      setEditing(null);
      setMoving(null);
      setLosses(null);
      await refresh();
      toast.show({
        title: t({ id: 'home.folders.saved', message: 'Saved' }),
        tone: 'success',
        action: {
          label: t({ id: 'home.deleted.undo', message: 'Undo' }),
          onPress: () => {
            void api(`/api/home/undo/${result.id}`, { method: 'POST', body: { id: newId('command') } })
              .then(refresh)
              .catch((error: unknown) => {
                if (
                  error instanceof ApiError &&
                  error.info.messageKey === 'home.folders.confirmLoss' &&
                  typeof error.info.params?.losses === 'string'
                ) {
                  const people: unknown = JSON.parse(error.info.params.losses);
                  if (
                    Array.isArray(people) &&
                    people.every(
                      (person) => typeof person?.id === 'string' && typeof person?.name === 'string',
                    )
                  ) {
                    setUndoing({ id: result.id, losses: people as AccessLoss[] });
                    return;
                  }
                }
                toast.show({
                  title: t({
                    id: 'home.folders.undoConflict',
                    message: 'This change can no longer be undone.',
                  }),
                  tone: 'danger',
                });
              });
          },
        },
      });
    },
  });
  const go = (to: string) => {
    void navigate({ to });
  };
  const moveAction = (item: Moving, parentId: string | null, confirmedLosses: string[] = []): HomeAction =>
    item.kind === 'folder'
      ? { kind: 'folder.move', folderId: item.id, parentId, confirmedLosses }
      : { kind: 'database.move', databaseId: item.id, parentId, confirmedLosses };
  const preview = useMutation({
    mutationFn: ({ item, parentId }: { item: Moving; parentId: string | null }) =>
      api<AccessLoss[]>('/api/home/move-preview', {
        method: 'POST',
        body: { id: newId('command'), action: moveAction(item, parentId) },
      }),
    onSuccess: (people, { item, parentId }) => {
      if (people.length) setLosses(people);
      else change.mutate(moveAction(item, parentId));
    },
  });
  const startMove = (item: Moving, parentId?: string) => {
    change.reset();
    preview.reset();
    setMoving(item);
    setDestination(parentId ?? 'root');
    setLosses(null);
    if (parentId) preview.mutate({ item, parentId });
  };
  const visibleFolders = folders.filter((folder) =>
    section === 'trash'
      ? folder.trashed &&
        (!folder.parentId || !folders.some((parent) => parent.id === folder.parentId && parent.trashed))
      : !folder.trashed &&
        tagged('folder', folder.id) &&
        (tagId
          ? true
          : folderId
            ? folder.parentId === folderId
            : section === 'shared'
              ? folder.shared && !folders.some((parent) => parent.id === folder.parentId && parent.shared)
              : section === 'my' &&
                (folder.ownerId === session?.user?.id || !folder.shared) &&
                (!folder.parentId || !folders.some((parent) => parent.id === folder.parentId))),
  );
  const items =
    query.data?.databases?.filter((database) => {
      if (tagId) return tagged('database', database.id);
      if (section === 'tags') return false;
      if (folderId) return database.parentId === folderId;
      if (section === 'shared') return database.shared;
      if (section === 'favorites') return database.favorite;
      if (section === 'recent')
        return Boolean(database.openedAt && Date.parse(database.openedAt) >= now - 30 * 86_400_000);
      if (section === 'trash') return false;
      return (
        (database.owned || !database.shared) &&
        (!database.parentId || !folders.some((folder) => folder.id === database.parentId))
      );
    }) ?? (folderId || section === 'trash' ? [] : databases);
  if (section === 'favorites')
    items.sort((a, b) => (a.favoritePosition ?? 0) - (b.favoritePosition ?? 0) || a.id.localeCompare(b.id));
  if (section === 'recent') {
    items.sort((a, b) => (b.openedAt ?? '').localeCompare(a.openedAt ?? ''));
    items.splice(8);
  }
  const links = [
    {
      id: 'my',
      href: session?.demo ? '/home/my' : '/',
      label: t({ id: 'home.myFiles', message: 'My files' }),
    },
    { id: 'shared', href: '/home/shared', label: t({ id: 'home.shared', message: 'Shared with me' }) },
    { id: 'recent', href: '/home/recent', label: t({ id: 'home.recent', message: 'Recent' }) },
    { id: 'favorites', href: '/home/favorites', label: t({ id: 'home.favorites', message: 'Favorites' }) },
    { id: 'trash', href: '/home/trash', label: t({ id: 'trash.open', message: 'Trash' }) },
  ];
  const pending = change.isPending || preview.isPending;
  const error = change.error ?? preview.error ?? query.error;
  const canCreate =
    session?.membership?.kind !== 'guest' &&
    (!folderId || (current && roleAllows(current.role, 'editRecords')));
  const destinations = folders.filter(
    (folder) =>
      !folder.trashed &&
      roleAllows(folder.role, 'editRecords') &&
      !(moving?.kind === 'folder' && (folder.id === moving.id || folder.path.includes(moving.id))),
  );
  return (
    <HomeTagsContext.Provider value={query.data}>
      <HomeArrangement
        key={location.pathname}
        parentId={folderId}
        visibleIds={[
          ...visibleFolders.filter((folder) => !folder.trashed).map((folder) => folder.id),
          ...(query.data?.shortcuts ?? [])
            .filter(
              (item) =>
                !item.trashed && item.parentId === folderId && (section === 'my' || section === 'folder'),
            )
            .map((item) => item.id),
          ...items.map((database) => database.id),
        ]}
        listing={query.data?.folders && query.data.databases ? query.data : { folders: [], databases: [] }}
        favorites={section === 'favorites'}
        rootIsContainer={section === 'my' || section === 'folder'}
        pending={pending || !query.data}
        change={(actions) => change.mutate(actions)}
      >
        <div
          className="rio-home-files"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(SHORTCUT_DRAG_TYPE)) event.preventDefault();
          }}
          onDrop={async (event) => {
            const action = await shortcutDrop(event, folderId);
            if (action) change.mutate(action);
          }}
        >
          <nav
            className="rio-home-files__sidebar"
            aria-label={t({ id: 'home.navigation', message: 'Files' })}
          >
            {links.map((link) => (
              <HomeDropTarget
                key={link.id}
                enabled={link.id === 'my' || link.id === 'trash'}
                parentId={link.id === 'trash' ? HOME_TRASH : null}
              >
                <a
                  href={link.href}
                  aria-current={section === link.id ? 'page' : undefined}
                  onClick={(event) => navigateOnPlainClick(event, () => go(link.href))}
                >
                  {link.label}
                </a>
              </HomeDropTarget>
            ))}
            <HomeList
              items={folders.filter((folder) => !folder.trashed)}
              className="rio-home-files__folder-links"
              label={t({ id: 'home.navigation', message: 'Files' })}
            >
              {(folder) => (
                <li>
                  <HomeDropTarget parentId={folder.id}>
                    <a
                      href={`/home/folders/${folder.id}`}
                      title={folder.name}
                      onClick={(event) => navigateOnPlainClick(event, () => go(`/home/folders/${folder.id}`))}
                    >
                      {folder.name}
                    </a>
                  </HomeDropTarget>
                </li>
              )}
            </HomeList>
            <a
              href="/home/tags"
              aria-current={section === 'tags' && !tagId ? 'page' : undefined}
              onClick={(event) => navigateOnPlainClick(event, () => go('/home/tags'))}
            >
              {t({ id: 'home.tags.title', message: 'Tags' })}
            </a>
            {query.data?.tags?.length ? (
              <HomeList
                items={query.data.tags}
                className="rio-home-files__folder-links"
                label={t({ id: 'home.tags.title', message: 'Tags' })}
              >
                {(tag) => (
                  <li>
                    <a
                      key={tag.id}
                      href={`/home/tags/${encodeURIComponent(tag.id)}`}
                      aria-current={tag.id === tagId ? 'page' : undefined}
                      onClick={(event) =>
                        navigateOnPlainClick(event, () => go(`/home/tags/${encodeURIComponent(tag.id)}`))
                      }
                    >
                      <TagPill tag={tag} />
                    </a>
                  </li>
                )}
              </HomeList>
            ) : null}
          </nav>
          <div className="rio-home-files__content">
            {error ? <ErrorBanner error={errorInfo(error)} /> : null}
            {/* At the top of a section the path would only repeat the heading under it. */}
            {current ? (
              <nav
                className="rio-home-files__breadcrumbs"
                aria-label={t({ id: 'home.folders.breadcrumbs', message: 'Folder path' })}
              >
                <a href="/" onClick={(event) => navigateOnPlainClick(event, () => go('/'))}>
                  {links[0]!.label}
                </a>
                {current.path
                  .map((id) => folders.find((folder) => folder.id === id))
                  .filter((folder): folder is HomeFolder => Boolean(folder))
                  .map((folder) => (
                    <a
                      key={folder.id}
                      href={`/home/folders/${folder.id}`}
                      title={folder.name}
                      onClick={(event) => navigateOnPlainClick(event, () => go(`/home/folders/${folder.id}`))}
                    >
                      {folder.name}
                    </a>
                  ))}
                <span aria-current="page" title={current.name}>
                  {current.name}
                </span>
              </nav>
            ) : null}
            <div className="rio-home-files__heading">
              <Heading level={2}>
                {selectedTag?.name ??
                  current?.name ??
                  (section === 'tags'
                    ? t({ id: 'home.tags.title', message: 'Tags' })
                    : links.find((link) => link.id === section)?.label)}
              </Heading>
              {section !== 'trash' ? (
                <Button isDisabled={!query.data} onPress={() => setTagsOpen(true)}>
                  {t({ id: 'home.tags.manage', message: 'Tags and colors' })}
                </Button>
              ) : null}
              {canCreate && section !== 'trash' ? (
                <Button
                  icon={faFolderPlus}
                  onPress={() => {
                    change.reset();
                    setName('');
                    setNewParent(folderId);
                    setEditing('new');
                  }}
                  aria-label={t({ id: 'home.folders.new', message: 'New folder' })}
                />
              ) : null}
            </div>
            {tagId && query.data && !selectedTag ? (
              <p>{t({ id: 'home.tags.unavailable', message: 'This tag is no longer available.' })}</p>
            ) : folderId && query.data && !current ? (
              <p>{t({ id: 'home.folders.unavailable', message: 'This folder is no longer available.' })}</p>
            ) : (
              <>
                <HomeList
                  items={visibleFolders}
                  className="rio-home-files__folders"
                  label={t({ id: 'home.myFiles', message: 'My files' })}
                  revealId={
                    change.variables &&
                    !Array.isArray(change.variables) &&
                    change.variables.kind === 'folder.create'
                      ? change.variables.folderId
                      : undefined
                  }
                >
                  {(folder) => (
                    <HomeDragItem key={folder.id} id={folder.id} name={folder.name} as="li">
                      <HomeDropTarget parentId={folder.id}>
                        <FolderRow
                          name={folder.name}
                          onNavigate={folder.trashed ? undefined : () => go(`/home/folders/${folder.id}`)}
                          onRename={
                            !folder.trashed && folder.role === 'owner'
                              ? (name) =>
                                  change.mutateAsync({ kind: 'folder.rename', folderId: folder.id, name })
                              : undefined
                          }
                          onNewInside={
                            !folder.trashed && roleAllows(folder.role, 'editRecords')
                              ? () => {
                                  change.reset();
                                  setName('');
                                  setNewParent(folder.id);
                                  setEditing('new');
                                }
                              : undefined
                          }
                        >
                          {!folder.trashed ? (
                            <MenuItem icon={faShareNodes} onAction={() => setSharing(folder)}>
                              {t({ id: 'home.folders.share', message: 'Share' })}
                            </MenuItem>
                          ) : null}
                          {!folder.trashed && folder.role === 'owner' ? (
                            <MenuItem
                              icon={faArrowRight}
                              onAction={() => startMove({ kind: 'folder', id: folder.id, name: folder.name })}
                            >
                              {t({ id: 'home.folders.move', message: 'Move to…' })}
                            </MenuItem>
                          ) : null}
                          {!folder.trashed && folder.role === 'owner' ? (
                            <MenuItem icon={faTrashCan} tone="danger" onAction={() => setTrashing(folder)}>
                              {t({ id: 'home.folders.trash', message: 'Move to Trash' })}
                            </MenuItem>
                          ) : null}
                          {folder.trashed && folder.role === 'owner' ? (
                            <MenuItem
                              icon={faRotateLeft}
                              onAction={() => change.mutate({ kind: 'folder.restore', folderId: folder.id })}
                            >
                              {t({ id: 'home.folders.restore', message: 'Restore folder' })}
                            </MenuItem>
                          ) : null}
                        </FolderRow>
                        <TagPills resource={{ kind: 'folder', id: folder.id }} />
                      </HomeDropTarget>
                    </HomeDragItem>
                  )}
                </HomeList>
                {query.data ? (
                  <Shortcuts
                    listing={query.data}
                    parentId={folderId}
                    section={section}
                    change={(action) => change.mutate(action)}
                    pending={pending}
                  />
                ) : null}
                {section === 'trash' ? (
                  <LazyBoundary>
                    <DeletedDatabasesList showEmpty={visibleFolders.length === 0} />
                  </LazyBoundary>
                ) : (
                  children(
                    items,
                    (database) => startMove({ kind: 'database', id: database.id, name: database.name }),
                    Boolean(canCreate),
                    // Keep the controls in place, but wait for the initial layout before opening menus.
                    query.isPending,
                  )
                )}
              </>
            )}
          </div>
          {tagsOpen && query.data ? (
            <LazyBoundary size="dialog" onDismiss={() => setTagsOpen(false)}>
              <TagsDialog listing={query.data} onClose={() => setTagsOpen(false)} />
            </LazyBoundary>
          ) : null}
          {editing ? (
            <LazyBoundary size="dialog" onDismiss={() => setEditing(null)}>
              <FolderEditDialog
                editing={editing}
                name={name}
                onName={setName}
                folderId={newParent}
                pending={pending}
                error={change.error}
                onClose={() => setEditing(null)}
                onChange={(action) => change.mutate(action)}
              />
            </LazyBoundary>
          ) : null}
          {moving && (
            <LazyBoundary size="dialog" onDismiss={() => setMoving(null)}>
              <FolderMoveDialog
                moving={moving}
                pending={pending}
                error={error}
                destination={destination}
                onDestination={(key) => {
                  setDestination(key);
                  setLosses(null);
                }}
                destinations={destinations}
                folders={folders}
                rootLabel={links[0]!.label}
                losses={losses}
                onClose={() => setMoving(null)}
                onMove={() => {
                  const parentId = destination === 'root' ? null : destination;
                  if (losses)
                    change.mutate(
                      moveAction(
                        moving,
                        parentId,
                        losses.map((person) => person.id),
                      ),
                    );
                  else preview.mutate({ item: moving, parentId });
                }}
              />
            </LazyBoundary>
          )}
          {sharing ? (
            <LazyBoundary size="dialog" onDismiss={() => setSharing(null)}>
              <ShareDialog
                databaseId={sharing.id}
                databaseName={sharing.name}
                resourceKind="folder"
                canManage={sharing.role === 'owner'}
                onClose={() => setSharing(null)}
              />
            </LazyBoundary>
          ) : null}
          {undoing && (
            <LazyBoundary size="dialog" onDismiss={() => setUndoing(null)}>
              <ConfirmDialog
                isOpen
                onOpenChange={(open) => {
                  if (!open) setUndoing(null);
                }}
                title={t({ id: 'home.folders.confirmMove', message: 'Confirm move' })}
                message={t({
                  id: 'home.folders.adminLosses',
                  message: `These people will lose access or have a lower role: ${[...new Set(undoing?.losses.map((person) => person.name))].join(', ')}`,
                })}
                confirmLabel={t({ id: 'home.folders.confirmMove', message: 'Confirm move' })}
                onConfirm={async () => {
                  if (!undoing) return;
                  await api(`/api/home/undo/${undoing.id}`, {
                    method: 'POST',
                    body: {
                      id: newId('command'),
                      confirmedLosses: undoing.losses.map((person) => person.id),
                    },
                  });
                  setUndoing(null);
                  await refresh();
                }}
              />
            </LazyBoundary>
          )}
          {trashing && (
            <LazyBoundary size="dialog" onDismiss={() => setTrashing(null)}>
              <ConfirmDialog
                isOpen
                onOpenChange={(open) => {
                  if (!open) setTrashing(null);
                }}
                title={t({ id: 'home.folders.trashTitle', message: 'Move folder to Trash?' })}
                message={t({
                  id: 'home.folders.trashBody',
                  message:
                    'This folder and its contents will move to Trash together.  Restoring the folder brings them back together.',
                })}
                confirmLabel={t({ id: 'home.folders.trash', message: 'Move to Trash' })}
                tone="danger"
                onConfirm={async () => {
                  if (trashing) await change.mutateAsync({ kind: 'folder.trash', folderId: trashing.id });
                }}
              />
            </LazyBoundary>
          )}
        </div>
      </HomeArrangement>
    </HomeTagsContext.Provider>
  );
}
