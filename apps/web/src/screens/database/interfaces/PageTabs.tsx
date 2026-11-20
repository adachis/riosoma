import { useRef } from 'react';
import { faFileLines, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import type { InterfacePage } from '@riosoma/contracts';
import { Button, SortableItem, SortableList } from '@riosoma/ui';
import { NamedLink } from '../shell/NamedLink';

export interface PageTabsProps {
  pages: readonly InterfacePage[];
  activePageId: string | null;
  hrefFor(pageId: string): string;
  onNavigate(pageId: string): void;
  /** Editing: pages rename, duplicate, delete, and move, and new ones can be added */
  editing: boolean;
  canAdd: boolean;
  onAdd(): void;
  onRename(pageId: string, name: string): void;
  onDuplicate(pageId: string): void;
  onDelete(pageId: string): void;
  onMove(pageId: string, toIndex: number): void;
}

/**
 * An interface's pages as links, one per tab.  While editing, each has a menu, and Alt with the
 * arrow keys moves it along the row.  Outside editing a lone page needs no tab at all.
 */
export function PageTabs({
  pages,
  activePageId,
  hrefFor,
  onNavigate,
  editing,
  canAdd,
  onAdd,
  onRename,
  onDuplicate,
  onDelete,
  onMove,
}: PageTabsProps) {
  const { t } = useLingui();
  const list = useRef<HTMLUListElement>(null);
  if (!editing && pages.length < 2) return null;
  return (
    <nav
      className="rio-db-views rio-interface-pages"
      aria-label={t({ id: 'interfaces.pages', message: 'Pages' })}
    >
      <SortableList
        items={pages.map((page) => ({ id: page.id, name: page.name }))}
        orientation="horizontal"
        disabledReason={
          !editing
            ? t({ id: 'interfaces.pages.readOnly', message: 'Edit the interface to arrange its pages.' })
            : undefined
        }
        onMove={(from, to) => onMove(pages[from]!.id, to)}
      >
        <ul ref={list} className="rio-db-view-list">
          {pages.map(({ id, name }) => (
            <SortableItem id={id} key={id} as="li" className="rio-sidebar-sortable" altMoveScope="row">
              <>
                <NamedLink
                  name={name}
                  href={hrefFor(id)}
                  active={id === activePageId}
                  icon={faFileLines}
                  canEdit={editing}
                  canDelete={pages.length > 1}
                  onNavigate={() => onNavigate(id)}
                  onRename={(value) => onRename(id, value)}
                  onDuplicate={canAdd ? () => onDuplicate(id) : undefined}
                  onDelete={() => onDelete(id)}
                  linkProps={{
                    'aria-keyshortcuts': editing ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined,
                    'aria-description': editing
                      ? t({ id: 'database.sidebar.move', message: `Move ${name}` })
                      : undefined,
                  }}
                  copy={{
                    menu: t({ id: 'database.sidebar.menu', message: `More for ${name}` }),
                    rename: t({ id: 'database.sidebar.rename', message: 'Rename' }),
                    duplicate: t({ id: 'interfaces.page.duplicate', message: 'Duplicate page' }),
                    delete: t({ id: 'interfaces.page.delete', message: 'Delete page' }),
                    deleteTitle: t({ id: 'interfaces.page.delete.title', message: `Delete ${name}?` }),
                    deleteBody: t({
                      id: 'interfaces.page.delete.body',
                      message: 'Its blocks are deleted with it for everyone.  Undo brings them back.',
                    }),
                    deleteConfirm: t({ id: 'interfaces.page.delete', message: 'Delete page' }),
                  }}
                />
              </>
            </SortableItem>
          ))}
        </ul>
      </SortableList>
      {editing ? (
        <Button
          variant="quiet"
          size="sm"
          icon={faPlus}
          isDisabled={!canAdd}
          onPress={onAdd}
          aria-label={t({ id: 'interfaces.page.add', message: 'Add a page' })}
        />
      ) : null}
    </nav>
  );
}
