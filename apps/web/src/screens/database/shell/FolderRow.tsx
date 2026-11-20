import { useLingui } from '@lingui/react/macro';
import {
  faChevronDown,
  faChevronRight,
  faEllipsis,
  faFolder,
  faFolderPlus,
  faPen,
  faTrashCan,
} from '@fortawesome/free-solid-svg-icons';
import { Icon } from '@riosoma/icons';
import { Button } from '@riosoma/ui';
import { Menu, MenuItem, MenuTrigger } from '../../../shell/menu';
import { lazyFeature, LazyBoundary } from '../../../shell/lazy';
import { Children, useEffect, useRef, useState, type ReactNode } from 'react';
import './folder-row.css';
const InlineName = lazyFeature(() =>
  import('./InlineName').then((module) => ({ default: module.InlineName })),
);

/** Folder names stay readable until a person chooses to edit them. */
export function FolderRow({
  name,
  expanded,
  onToggle,
  href,
  onNavigate,
  onRename,
  onNewInside,
  onDelete,
  children,
}: {
  name: string;
  expanded?: boolean;
  onToggle?(): void;
  href?: string;
  onNavigate?(): void;
  onRename?(name: string): void | Promise<unknown>;
  onNewInside?(): void;
  onDelete?(): void;
  children?: ReactNode;
}) {
  const { t } = useLingui();
  const hasActions = Boolean(onRename || onNewInside || onDelete || Children.toArray(children).length);
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const cancelPending = (event: PointerEvent) => {
      if (!row.current?.contains(event.target as Node)) clearTimeout(opening.current);
    };
    document.addEventListener('pointerdown', cancelPending, true);
    return () => {
      clearTimeout(opening.current);
      document.removeEventListener('pointerdown', cancelPending, true);
    };
  }, []);
  const open = () => {
    if (!onNavigate) return;
    clearTimeout(opening.current);
    opening.current = setTimeout(() => onNavigate(), onRename ? 500 : 0);
  };
  const label = t({ id: 'database.sidebar.folderName', message: 'Folder name' });
  const menu = t({ id: 'database.sidebar.folderMenu', message: `More for ${name}` });
  const finish = (restoreFocus = true) => {
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => row.current?.focus());
  };
  return (
    <div
      ref={row}
      className="rio-folder-row"
      tabIndex={0}
      role="group"
      aria-label={name}
      onDoubleClick={(event) => {
        const target = event.target as Element;
        if (!onRename || target.closest('input') || target.closest('button:not(.rio-folder-row__name)'))
          return;
        event.preventDefault();
        clearTimeout(opening.current);
        setEditing(true);
      }}
      onContextMenu={(event) => {
        if (!hasActions) return;
        event.preventDefault();
        clearTimeout(opening.current);
        setMenuOpen(true);
      }}
      onKeyDown={(event) => {
        if ((event.target as Element).closest('input')) return;
        if (event.key === 'F2' && onRename) {
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(opening.current);
          setEditing(true);
        } else if (hasActions && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault();
          clearTimeout(opening.current);
          setMenuOpen(true);
        } else if (event.key === 'Enter' && event.target === event.currentTarget && onNavigate) {
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(opening.current);
          onNavigate();
        }
      }}
    >
      {onToggle || onNavigate ? (
        <Button
          variant="quiet"
          size="sm"
          icon={expanded ? faChevronDown : faChevronRight}
          className="rio-folder-row__disclosure"
          aria-expanded={onToggle ? expanded : undefined}
          aria-label={
            !onToggle
              ? t({ id: 'database.sidebar.openFolder', message: `Open ${name}` })
              : expanded
                ? t({ id: 'database.sidebar.collapseFolder', message: `Collapse ${name}` })
                : t({ id: 'database.sidebar.expandFolder', message: `Expand ${name}` })
          }
          onPress={() => {
            clearTimeout(opening.current);
            (onToggle ?? onNavigate)?.();
          }}
        />
      ) : null}
      <Icon icon={faFolder} />
      {editing && onRename ? (
        <LazyBoundary size="controls">
          <InlineName
            name={name}
            label={label}
            pending={saving}
            preserveOnBlur={saveFailed}
            onCancel={finish}
            onSave={(value) => {
              setSaving(true);
              setSaveFailed(false);
              void Promise.resolve()
                .then(() => onRename(value))
                .then(() => finish())
                .catch(() => {
                  // The command reports its error while the draft stays available to retry.
                  setSaveFailed(true);
                })
                .finally(() => setSaving(false));
            }}
          />
        </LazyBoundary>
      ) : onNavigate && !href ? (
        <Button variant="quiet" className="rio-folder-row__name" data-sortable-surface onPress={open}>
          <span title={name}>{name}</span>
        </Button>
      ) : href ? (
        <a
          href={href}
          className="rio-folder-row__name"
          title={name}
          onClick={(event) => {
            if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.button === 0 && onNavigate) {
              event.preventDefault();
              open();
            }
          }}
        >
          {name}
        </a>
      ) : (
        <span className="rio-folder-row__name" title={name}>
          {name}
        </span>
      )}
      {hasActions ? (
        <MenuTrigger isOpen={menuOpen} onOpenChange={setMenuOpen}>
          <Button
            className="rio-folder-row__menu"
            variant="quiet"
            size="sm"
            icon={faEllipsis}
            aria-label={menu}
          />
          <Menu aria-label={menu} includeSortableActions={menuOpen}>
            {onRename ? (
              <MenuItem
                id="rename"
                icon={faPen}
                onAction={() => {
                  clearTimeout(opening.current);
                  setEditing(true);
                }}
              >
                {t({ id: 'database.sidebar.rename', message: 'Rename' })}
              </MenuItem>
            ) : null}
            {onNewInside ? (
              <MenuItem id="new-folder" icon={faFolderPlus} onAction={onNewInside}>
                {t({ id: 'database.sidebar.newFolderInside', message: 'New folder inside' })}
              </MenuItem>
            ) : null}
            {children}
            {onDelete ? (
              <MenuItem id="delete" icon={faTrashCan} tone="danger" onAction={onDelete}>
                {t({ id: 'database.sidebar.deleteFolder', message: 'Delete folder' })}
              </MenuItem>
            ) : null}
          </Menu>
        </MenuTrigger>
      ) : null}
    </div>
  );
}
