import { shortcutDrop, SHORTCUT_DRAG_TYPE } from './shortcuts';
import { revealHomeItem, useHomeItemPosition } from './HomeList';
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { newId, roleAllows, type HomeAction, type HomeListing } from '@riosoma/contracts';
import {
  Checkbox,
  SortableItem,
  SortableTarget,
  SortableTree,
  type SortableLocation,
  type SortableNode,
} from '@riosoma/ui';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/shellMessage';

export const HOME_TRASH = '$trash';
const HOME_ROOT = '$root';
const Arrangement = createContext<{
  ids: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  select(id: string, checked: boolean): void;
  change(actions: HomeAction[]): void;
} | null>(null);

export function useHomeDropPreview() {
  const [, update] = useState(0);
  const store = useRef<{
    revision: unknown;
    entries: Map<string, { pending: boolean; reason?: string }>;
    pending: number;
    timer?: ReturnType<typeof setTimeout>;
  }>({ revision: undefined, entries: new Map(), pending: 0 });
  useEffect(
    () => () => {
      clearTimeout(store.current.timer);
      store.current = { revision: undefined, entries: new Map(), pending: 0 };
    },
    [],
  );
  return (
    revision: unknown,
    key: string,
    request: () => Promise<unknown>,
    describe: (error: unknown) => string,
  ) => {
    if (store.current.revision !== revision) {
      clearTimeout(store.current.timer);
      store.current = { revision, entries: new Map(), pending: 0 };
    }
    const batch = store.current;
    const known = batch.entries.get(key);
    if (known) return known;
    batch.entries.set(key, { pending: true });
    batch.pending++;
    const finish = (reason?: string) => {
      if (store.current !== batch) return;
      batch.entries.set(key, { pending: false, reason });
      batch.pending--;
      // A menu preflights every destination.  Publish results together instead of rerendering
      // all mounted controls once per response, while keeping pointer feedback responsive.
      const publish = () => {
        batch.timer = undefined;
        update((previous) => previous + 1);
      };
      if (!batch.pending) {
        clearTimeout(batch.timer);
        publish();
      } else batch.timer ??= setTimeout(publish, 100);
    };
    void request().then(
      () => finish(),
      (error: unknown) => finish(describe(error)),
    );
    return batch.entries.get(key)!;
  };
}

export function HomeArrangement({
  listing,
  favorites,
  rootIsContainer = true,
  visibleIds,
  parentId = null,
  pending,
  change,
  children,
}: {
  listing: HomeListing;
  favorites: boolean;
  rootIsContainer?: boolean;
  visibleIds?: readonly string[];
  parentId?: string | null;
  pending: boolean;
  change(actions: HomeAction[]): void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const check = useHomeDropPreview();
  const dropped = useRef<{ element: Element; parentId: string | null } | null>(null);
  useEffect(() => {
    const previous = dropped.current;
    if (!previous || previous.element.isConnected) return;
    dropped.current = null;
    // A moved card can leave the page, so keep keyboard focus on its destination.
    if (document.activeElement === document.body)
      queueMicrotask(() => {
        if (document.activeElement !== document.body) return;
        revealHomeItem(previous.parentId ?? HOME_ROOT);
        document
          .querySelector<HTMLElement>(
            `.rio-sortable-target[data-sortable-parent="${CSS.escape(previous.parentId ?? HOME_ROOT)}"] :is(a, button)`,
          )
          ?.focus();
      });
  }, [listing]);
  const readOnly = t({ id: 'home.arrange.ownerRequired', message: 'Only an owner can move this item.' });
  const folders = listing.folders.filter((folder) => !folder.trashed);
  const databases = listing.databases;
  const shortcuts = (listing.shortcuts ?? []).filter((shortcut) => !shortcut.trashed);
  const visible = new Set(
    visibleIds ??
      [
        ...(!favorites ? [...folders, ...shortcuts] : []),
        ...databases.filter((database) => !favorites || database.favorite),
      ].map((item) => item.id),
  );
  const folderNode = (folder: (typeof folders)[number]) => ({
    id: folder.id,
    data: { name: folder.name, disabledReason: folder.role === 'owner' ? undefined : readOnly },
    children: [],
  });
  const rendered: SortableNode<{ name: string; disabledReason?: string }>[] = [
    ...folders.filter((folder) => visible.has(folder.id)).map(folderNode),
    ...databases
      .filter((database) => visible.has(database.id))
      .map((database) => ({
        id: database.id,
        data: {
          name: database.name,
          disabledReason: favorites || database.role === 'owner' ? undefined : readOnly,
        },
      })),
    ...shortcuts
      .filter((shortcut) => visible.has(shortcut.id))
      .map((shortcut) => ({
        id: shortcut.id,
        data: {
          name: shortcut.name ?? t({ id: 'home.shortcuts.unavailable', message: 'Unavailable shortcut' }),
          disabledReason: shortcut.owned ? undefined : readOnly,
        },
      })),
  ];
  const order = new Map([...visible].map((id, index) => [id, index]));
  rendered.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const ancestors: typeof folders = [];
  for (let id = parentId; id;) {
    const folder = folders.find((folder) => folder.id === id);
    if (!folder || ancestors.some((ancestor) => ancestor.id === id)) break;
    ancestors.push(folder);
    id = folder.parentId;
  }
  const tree = ancestors.reduce<SortableNode<{ name: string; disabledReason?: string }>[]>(
    (children, folder) => [{ ...folderNode(folder), children }],
    rendered,
  );
  const targets = [
    ...folders
      .filter((folder) => !visible.has(folder.id) && !ancestors.some((ancestor) => ancestor.id === folder.id))
      .map(folderNode),
    { id: HOME_ROOT, data: { name: t({ id: 'home.section.mine', message: 'My files' }) }, children: [] },
    { id: HOME_TRASH, data: { name: t({ id: 'trash.open', message: 'Trash' }) }, children: [] },
  ];
  const moving = (id: string) => {
    const chosen = selected.has(id)
      ? [...visible].filter((item) => selected.has(item))
      : [id].filter((item) => visible.has(item));
    return chosen.filter((item) => {
      const folder = folders.find((folder) => folder.id === item);
      if (folder?.path.some((ancestor) => chosen.includes(ancestor))) return false;
      let parentId =
        databases.find((database) => database.id === item)?.parentId ??
        shortcuts.find((shortcut) => shortcut.id === item)?.parentId;
      while (parentId) {
        if (chosen.includes(parentId)) return false;
        parentId = folders.find((folder) => folder.id === parentId)?.parentId;
      }
      return true;
    });
  };
  const actions = (id: string, target: SortableLocation): HomeAction[] => {
    const chosen = moving(id);
    if (favorites && target.parentId === null && databases.find((database) => database.id === id)?.favorite) {
      const remaining = tree.filter((node) => !chosen.includes(node.id));
      const after = remaining
        .slice(target.index)
        .find((node) => databases.some((database) => database.id === node.id && database.favorite));
      return chosen.map((databaseId) => ({
        kind: 'favorite.move',
        databaseId,
        position: 0,
        beforeId: after?.id ?? null,
      }));
    }

    const destinationId = target.parentId === HOME_ROOT ? null : target.parentId;
    return chosen.flatMap((item): HomeAction[] => {
      const trash = target.parentId === HOME_TRASH;
      if (folders.some((folder) => folder.id === item))
        return [
          trash
            ? { kind: 'folder.trash', folderId: item }
            : { kind: 'folder.move', folderId: item, parentId: destinationId, confirmedLosses: [] },
        ];
      if (databases.some((database) => database.id === item))
        return [
          trash
            ? { kind: 'database.trash', databaseId: item }
            : { kind: 'database.move', databaseId: item, parentId: destinationId, confirmedLosses: [] },
        ];
      return shortcuts.some((shortcut) => shortcut.id === item)
        ? [
            trash
              ? { kind: 'shortcut.trash', shortcutId: item }
              : { kind: 'shortcut.move', shortcutId: item, parentId: destinationId },
          ]
        : [];
    });
  };
  const dropReason = (id: string, target: SortableLocation): string | undefined => {
    if (id === HOME_TRASH) return readOnly;
    if (!rootIsContainer && !favorites && target.parentId === null)
      return t({
        id: 'home.arrange.filteredList',
        message: 'This list does not store an order.  Drop on a folder, My files, or Trash to move items.',
      });
    const destination = folders.find((folder) => folder.id === target.parentId);
    if (destination && !roleAllows(destination.role, 'editRecords'))
      return t({ id: 'home.arrange.destinationDenied', message: 'You cannot add items to this folder.' });
    const chosen = moving(id);
    if (destination && chosen.some((item) => item === destination.id || destination.path.includes(item)))
      return t({ id: 'home.arrange.cycle', message: 'A folder cannot move inside itself.' });
    if (chosen.length > 100)
      return t({ id: 'home.arrange.selectionLimit', message: 'Move up to 100 items at a time.' });
    const ordering = favorites && target.parentId === null;
    const blocked = chosen.flatMap((item) => {
      const resource =
        folders.find((folder) => folder.id === item) ?? databases.find((database) => database.id === item);
      if (resource && !ordering && resource.role !== 'owner') return [resource.name];
      const shortcut = shortcuts.find((shortcut) => shortcut.id === item);
      return shortcut && !shortcut.owned
        ? [shortcut.name ?? t({ id: 'home.shortcuts.unavailable', message: 'Unavailable shortcut' })]
        : [];
    });
    if (blocked.length) {
      const names = blocked.join(', ');
      return t({ id: 'home.arrange.blockedItems', message: `You do not have permission to move: ${names}.` });
    }
    if (
      !ordering &&
      chosen.every(
        (item) =>
          [...folders, ...databases, ...shortcuts].find((resource) => resource.id === item)?.parentId ===
          (target.parentId === HOME_ROOT ? null : target.parentId),
      )
    )
      return t({
        id: 'home.arrange.sameFolder',
        message: 'These items are already in this folder.  Drop on another folder or Trash.',
      });
    const proposal = actions(id, target);
    if (!proposal.length) return readOnly;
    const key = JSON.stringify(proposal);
    const cached = check(
      listing,
      key,
      () =>
        api('/api/home/drop-preview', {
          method: 'POST',
          body: { id: newId('command'), action: proposal[0], actions: proposal },
        }),
      (error) =>
        error instanceof ApiError && error.info.messageKey === 'home.folders.confirmLoss'
          ? t({
              id: 'home.arrange.accessChanges',
              message: 'This move changes who has access.  Use Move to to review the change.',
            })
          : error instanceof ApiError
            ? message(error.info.messageKey, error.info.params)
            : message('errors.offline'),
    );
    return cached.pending ? undefined : cached.reason;
  };
  return (
    <Arrangement.Provider
      value={{
        ids: visible,
        selected,
        change,
        select(id, checked) {
          setSelected((previous) => {
            const next = new Set(previous);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
          });
        },
      }}
    >
      <SortableTree
        onRevealItem={revealHomeItem}
        anchorDisabledItems={false}
        items={tree}
        targets={targets}
        maxDepth={11}
        disabledReason={
          pending
            ? t({ id: 'home.arrange.saving', message: 'Wait for the current change to finish.' })
            : undefined
        }
        dropReason={dropReason}
        onMove={(id, target) => {
          const element = document.querySelector(
            `[data-sortable-id="${CSS.escape(id)}"] .rio-sortable-handle`,
          );
          dropped.current = element ? { element, parentId: target.parentId } : null;
          change(actions(id, target));
          setSelected(new Set());
        }}
      >
        {children}
      </SortableTree>
    </Arrangement.Provider>
  );
}

export function HomeDragItem({
  id,
  name,
  className,
  children,
  as = 'div',
}: {
  id: string;
  name: string;
  className?: string;
  children: ReactNode;
  as?: 'div' | 'li';
}) {
  const { t } = useLingui();
  const arrangement = useContext(Arrangement);
  const position = useHomeItemPosition();
  if (!arrangement?.ids.has(id))
    return as === 'li' ? (
      <li className={className} {...position}>
        {children}
      </li>
    ) : (
      <div className={className}>{children}</div>
    );
  return (
    <SortableItem
      id={id}
      as={as}
      className={className}
      renderWrapper={
        as === 'li'
          ? (props, contents) => createElement('li', { ...props, ...position }, contents)
          : undefined
      }
    >
      <>
        <div className="rio-home-arrange-controls">
          <Checkbox
            aria-label={t({ id: 'home.arrange.select', message: `Select ${name}` })}
            isSelected={arrangement.selected.has(id)}
            onChange={(checked) => arrangement.select(id, checked)}
          />
        </div>
        {children}
      </>
    </SortableItem>
  );
}

export function HomeDropTarget({
  parentId,
  children,
  enabled = true,
}: {
  parentId: string | null;
  children: ReactNode;
  enabled?: boolean;
}) {
  const arrangement = useContext(Arrangement);
  if (!arrangement) return children;
  const refuseShortcut = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(SHORTCUT_DRAG_TYPE)) return false;
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'none';
    return true;
  };
  if (!enabled)
    return (
      <div onDragOver={refuseShortcut} onDrop={refuseShortcut}>
        {children}
      </div>
    );
  return (
    <SortableTarget
      parentId={parentId ?? HOME_ROOT}
      onDragOver={(event) => {
        if (parentId === HOME_TRASH) {
          refuseShortcut(event);
        } else if (event.dataTransfer.types.includes(SHORTCUT_DRAG_TYPE)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={async (event) => {
        if (parentId === HOME_TRASH) {
          refuseShortcut(event);
          return;
        }
        const action = await shortcutDrop(event, parentId);
        if (action) arrangement.change([action]);
      }}
    >
      {children}
    </SortableTarget>
  );
}
