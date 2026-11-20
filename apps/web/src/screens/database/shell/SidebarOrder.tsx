import type { SidebarNavigationChange } from '@riosoma/contracts';
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useId,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useLingui } from '@lingui/react/macro';
import { newId, SidebarNavigation, type SidebarSection } from '@riosoma/contracts';
import {
  Button,
  ConfirmDialog,
  SortableDropZone,
  SortableItem,
  SortableList,
  SortableTree,
  type SortableLocation,
  type SortableNode,
} from '@riosoma/ui';
import { faFolderPlus } from '@fortawesome/free-solid-svg-icons';
import { FolderRow } from './FolderRow';
import type { CommandInput, DatabaseSession, SchemaState } from '../../../data/types';
import { reportError } from '../../../grid/view/actions';

const Navigation = createContext<{ session: DatabaseSession; schema: SchemaState } | null>(null);

export function SidebarNavigationProvider({
  session,
  schema,
  children,
}: {
  session: DatabaseSession;
  schema: SchemaState;
  children: ReactNode;
}) {
  return <Navigation.Provider value={{ session, schema }}>{children}</Navigation.Provider>;
}

type Item = { id: string; name: string; position?: number };
const empty: SidebarNavigation = { folders: [], parents: {} };

export function SidebarOrder({
  items,
  section,
  headingId,
  actions,
  disabledReason,
  onMove,
  children,
}: {
  items: readonly Item[];
  section: SidebarSection;
  headingId?: string;
  actions?: ReactNode;
  disabledReason?: string;
  onMove(from: number, to: number): void;
  children: ReactElement<{ children?: ReactNode; hidden?: boolean }>;
}) {
  const { t } = useLingui();
  const context = useContext(Navigation);
  const generatedHeadingId = useId();
  const title =
    section === 'table'
      ? t({ id: 'database.sidebar.label', message: 'Tables' })
      : section === 'dashboard'
        ? t({ id: 'dashboards.section', message: 'Dashboards' })
        : section === 'automation'
          ? t({ id: 'automations.section', message: 'Automations' })
          : section === 'interface'
            ? t({ id: 'interfaces.section', message: 'Interfaces' })
            : t({ id: 'scripts.section', message: 'Scripts' });
  const heading = (
    <h2 id={headingId ?? generatedHeadingId} className="rio-sidebar-order__title">
      {title}
    </h2>
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<string | null>(null);
  if (!context)
    return (
      <SortableList items={items} disabledReason={disabledReason} onMove={onMove}>
        <div className="rio-sidebar-order__header">
          {heading}
          {actions}
        </div>
        {cloneElement(children, { hidden: !items.length })}
      </SortableList>
    );
  const navigation = context.schema.database.navigation ?? empty;
  const folders = navigation.folders.filter((folder) => folder.section === section);
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const elements = new Map(
    Children.toArray(children.props.children).flatMap((child) =>
      isValidElement<{ id: string }>(child) ? [[child.props.id, child] as const] : [],
    ),
  );
  const position = (id: string) =>
    folderById.get(id)?.position ?? items.find((item) => item.id === id)?.position ?? 0;
  const nodes = (parentId: string | null): SortableNode<{ name: string }>[] =>
    [
      ...folders
        .filter((folder) => folder.parentId === parentId)
        .map((folder) => ({ id: folder.id, data: { name: folder.name }, children: nodes(folder.id) })),
      ...items
        .filter(
          (item) =>
            (folderById.has(navigation.parents[item.id] ?? '') ? navigation.parents[item.id] : null) ===
            parentId,
        )
        .map((item) => ({ id: item.id, data: { name: item.name } })),
    ].sort((a, b) => position(a.id) - position(b.id) || a.id.localeCompare(b.id));
  const tree = nodes(null);
  const save = (change: SidebarNavigationChange, move?: CommandInput, preserveDraft = false) => {
    try {
      return context.session.run([...(move ? [move] : []), { kind: 'database.navigation', change }]);
    } catch (error) {
      reportError(error);
      if (preserveDraft) throw error;
    }
  };
  const move = (id: string, target: SortableLocation) => {
    const siblings = nodes(target.parentId).filter((node) => node.id !== id);
    const before = siblings[target.index - 1];
    const after = siblings[target.index];
    const nextPosition = before
      ? after
        ? (position(before.id) + position(after.id)) / 2
        : position(before.id) + 1
      : (after ? position(after.id) : 0) - 1;
    if (folderById.has(id)) {
      save({ kind: 'folder.move', id, parentId: target.parentId, position: nextPosition });
      return;
    }
    const command: CommandInput =
      section === 'table'
        ? { kind: 'table.move', tableId: id, position: nextPosition }
        : section === 'dashboard'
          ? { kind: 'dashboard.move', dashboardId: id, position: nextPosition }
          : section === 'automation'
            ? { kind: 'automation.move', automationId: id, position: nextPosition }
            : section === 'interface'
              ? { kind: 'interface.move', interfaceId: id, position: nextPosition }
              : { kind: 'script.move', scriptId: id, position: nextPosition };
    save({ kind: 'item.move', id, parentId: target.parentId }, command);
  };
  const createFolder = (parentId: string | null) => {
    const number = folders.length + 1;
    save({
      kind: 'folder.create',
      folder: {
        id: newId('folder'),
        name: t({ id: 'database.sidebar.newFolderName', message: `Folder ${number}` }),
        section,
        parentId,
        position: Math.max(-1, ...nodes(parentId).map((node) => position(node.id))) + 1,
      },
    });
    if (parentId) setCollapsed((previous) => new Set([...previous].filter((id) => id !== parentId)));
  };
  const render = (entries: readonly SortableNode<{ name: string }>[]): ReactNode =>
    entries.map((node) =>
      node.children ? (
        <li key={node.id} className="rio-sidebar-folder">
          <SortableItem id={node.id} className="rio-sidebar-sortable" altMoveScope="row">
            <FolderRow
              name={node.data.name}
              expanded={!collapsed.has(node.id)}
              onToggle={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (!next.delete(node.id)) next.add(node.id);
                  return next;
                })
              }
              onRename={
                disabledReason
                  ? undefined
                  : async (name) => {
                      if (name === node.data.name) return;
                      const result = await save({ kind: 'folder.rename', id: node.id, name }, undefined, true)
                        ?.done;
                      // The command bus reports server refusals, and the editor keeps its draft.
                      if (result?.rejected) throw new Error('Folder rename was rejected');
                    }
              }
              onNewInside={disabledReason ? undefined : () => createFolder(node.id)}
              onDelete={
                disabledReason
                  ? undefined
                  : () => {
                      if (node.children?.length) setDeleting(node.id);
                      else save({ kind: 'folder.delete', id: node.id });
                    }
              }
            />
          </SortableItem>
          <ul hidden={collapsed.has(node.id)}>{render(node.children)}</ul>
          <SortableDropZone parentId={node.id} />
        </li>
      ) : (
        elements.get(node.id)
      ),
    );
  return (
    <SortableTree
      items={tree}
      maxDepth={11}
      disabledReason={disabledReason}
      onMove={move}
      dropReason={(id, target) =>
        folderById.has(id) &&
        !SidebarNavigation.safeParse({
          ...navigation,
          folders: navigation.folders.map((folder) =>
            folder.id === id ? { ...folder, parentId: target.parentId } : folder,
          ),
        }).success
          ? t({
              id: 'database.sidebar.folderDepth',
              message: 'Folders can nest up to 10 levels and cannot contain themselves.',
            })
          : undefined
      }
    >
      <div className="rio-sidebar-order__header">
        {heading}
        {actions}
        {!disabledReason ? (
          <Button
            variant="quiet"
            size="sm"
            icon={faFolderPlus}
            aria-label={t({ id: 'database.sidebar.addFolder', message: 'Add folder' })}
            onPress={() => createFolder(null)}
          />
        ) : null}
      </div>
      {cloneElement(children, { hidden: !tree.length }, render(tree))}
      <SortableDropZone />
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t({ id: 'database.sidebar.deleteFolderTitle', message: 'Delete folder?' })}
        message={t({
          id: 'database.sidebar.deleteFolderBody',
          message:
            'The items and folders inside move to this folder’s parent.  Nothing inside is deleted.  You can undo this as one change.',
        })}
        confirmLabel={t({ id: 'database.sidebar.deleteFolder', message: 'Delete folder' })}
        tone="danger"
        onConfirm={() => {
          if (deleting) save({ kind: 'folder.delete', id: deleting });
        }}
      />
    </SortableTree>
  );
}
