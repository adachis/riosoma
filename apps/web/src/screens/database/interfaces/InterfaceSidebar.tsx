import { SidebarOrder } from '../shell/SidebarOrder';
import { useId } from 'react';
import { faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { useNavigate } from '@tanstack/react-router';
import { newId, roleAllows } from '@riosoma/contracts';
import { Button, SortableItem } from '@riosoma/ui';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError, undoToast } from '../../../grid/view/actions';
import { databaseHref, interfaceHref } from '../screen/routes';
import { NamedLink } from '../shell/NamedLink';
import { INTERFACE_ICON, newPageId } from './model';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { useTrashPhrase } from '../../../features/retention/window';
import { anchor } from '../../../demos/anchors';
import './sidebar.css';

export interface InterfaceSidebarProps {
  session: DatabaseSession;
  schema: SchemaState;
  activeInterfaceId: string | null;
  /** The table a deleted interface's screen leaves for */
  tableId: string;
}

/**
 * The database's interfaces in the sidebar, with the tables' own renaming, deleting, and
 * reordering by dragging or with Alt and the arrow keys.  People who can't change the schema see
 * the list without the controls, and nothing at all when there are no interfaces.
 */
export function InterfaceSidebar({ session, schema, activeInterfaceId, tableId }: InterfaceSidebarProps) {
  const { t } = useLingui();
  const trash = useTrashPhrase();
  const navigate = useNavigate();
  const headingId = useId();
  const canEdit = roleAllows(session.role(), 'editSchema');
  const { offers } = useLevel();
  const interfaces = schema.interfaces;
  const execute = (action: () => void) => {
    try {
      action();
    } catch (error) {
      reportError(error);
    }
  };
  const move = (interfaceId: string, toIndex: number) =>
    execute(() => {
      const ordered = interfaces.filter((item) => item.id !== interfaceId);
      const before = ordered[toIndex - 1]?.position;
      const after = ordered[toIndex]?.position;
      const position =
        before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
      session.run([{ kind: 'interface.move', interfaceId, position }]);
    });
  const create = () =>
    execute(() => {
      const interfaceId = newId('interface');
      const position = Math.max(-1, ...interfaces.map((item) => item.position)) + 1;
      session.run([
        {
          kind: 'interface.create',
          interface: {
            id: interfaceId,
            name: t({ id: 'interfaces.untitled', message: 'Untitled interface' }),
            pages: [
              {
                id: newPageId(),
                name: t({ id: 'interfaces.page.first', message: 'Page 1' }),
                blocks: [],
              },
            ],
          },
          position,
        },
      ]);
      void navigate({ to: interfaceHref(session.databaseId, interfaceId) });
    });
  const remove = (interfaceId: string) => {
    const name = schema.interfaceById.get(interfaceId)?.name ?? '';
    const trash = () =>
      execute(() => {
        session.run([{ kind: 'interface.trash', interfaceId }]);
        undoToast(session, t({ id: 'interfaces.deleted', message: `Deleted ${name}` }));
      });
    // Leave the interface's screen first, so its link never points at nothing.
    if (interfaceId === activeInterfaceId)
      void navigate({ to: databaseHref(session.databaseId, tableId) }).then(trash);
    else trash();
  };
  // Interfaces are Standard.  A database that has some keeps the way to add another at every
  // level, and the palette always offers it.
  const adding = canEdit && offers('databaseSidebar', 'interfaces', { interfaces: interfaces.length });
  useFeatureCommands(
    'database.interfaces',
    canEdit ? [{ place: 'databaseSidebar:interfaces', run: create }] : [],
  );
  if (!adding && !interfaces.length) return null;
  return (
    <section className="rio-interface-sidebar" aria-labelledby={headingId} {...anchor('interfaces.section')}>
      {
        <SidebarOrder
          actions={
            adding ? (
              <Button
                variant="quiet"
                icon={faPlus}
                onPress={create}
                {...anchor('interfaces.add')}
                aria-label={t({ id: 'interfaces.add', message: 'Add an interface' })}
              />
            ) : null
          }
          headingId={headingId}
          items={interfaces}
          section="interface"
          disabledReason={
            !canEdit
              ? t({
                  id: 'database.sidebar.readOnly',
                  message: 'You need permission to arrange this database.',
                })
              : undefined
          }
          onMove={(from, to) => move(interfaces[from]!.id, to)}
        >
          <ul className="rio-interface-sidebar__list">
            {interfaces.map(({ id, name }) => (
              <SortableItem key={id} id={id} as="li" className="rio-sidebar-sortable" altMoveScope="row">
                <>
                  <NamedLink
                    name={name}
                    href={interfaceHref(session.databaseId, id)}
                    active={id === activeInterfaceId}
                    icon={INTERFACE_ICON}
                    canEdit={canEdit}
                    canDelete
                    onNavigate={() => {
                      void navigate({ to: interfaceHref(session.databaseId, id) });
                    }}
                    onRename={(value) =>
                      execute(() => {
                        session.run([{ kind: 'interface.update', interfaceId: id, name: value }]);
                      })
                    }
                    onDelete={() => remove(id)}
                    linkProps={{
                      'aria-keyshortcuts': canEdit ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
                      'aria-description': canEdit
                        ? t({ id: 'database.sidebar.move', message: `Move ${name}` })
                        : undefined,
                    }}
                    copy={{
                      menu: t({ id: 'database.sidebar.menu', message: `More for ${name}` }),
                      rename: t({ id: 'database.sidebar.rename', message: 'Rename' }),
                      delete: t({ id: 'interfaces.delete', message: 'Delete interface' }),
                      deleteTitle: t({ id: 'interfaces.delete.title', message: `Delete ${name}?` }),
                      deleteBody: t({
                        id: 'interfaces.delete.body',
                        message: `It’s deleted for everyone.  You can restore it from the trash ${trash}.`,
                      }),
                      deleteConfirm: t({ id: 'interfaces.delete', message: 'Delete interface' }),
                    }}
                  />
                </>
              </SortableItem>
            ))}
          </ul>
        </SidebarOrder>
      }
    </section>
  );
}
