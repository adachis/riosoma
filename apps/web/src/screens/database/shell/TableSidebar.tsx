import { SidebarOrder } from './SidebarOrder';
import { faPlus, faTable, faTrashCan } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { type TableMeta } from '@riosoma/contracts';
import { Button, Menu, MenuItem, MenuTrigger, SortableItem } from '@riosoma/ui';
import { type ReactNode } from 'react';
import { DashboardSection, type DashboardSectionProps } from './DashboardSection';
import { NamedLink } from './NamedLink';
import { useLevel } from '../../../levels/context';
import { useTrashPhrase } from '../../../features/retention/window';
import { anchor } from '../../../demos/anchors';
import './shell.css';

export interface TableSidebarProps {
  tables: readonly TableMeta[];
  activeTableId: string | null;
  hrefFor(tableId: string): string;
  onNavigate(tableId: string): void;
  canEdit: boolean;
  onCreate(): void;
  onRename(tableId: string, name: string): void;
  onDuplicate?(tableId: string): void;
  onDelete(tableId: string): void;
  onMove(tableId: string, toIndex: number): void;
  /** Offers importing a CSV or Excel file as a new table */
  onImport?(): void;
  /** Offers importing a file into a table that exists, when the table can take one */
  onImportInto?(tableId: string): void;
  onSync?(): void;
  onTrash?(): void;
  /** Lists the database's dashboards below the tables */
  dashboards?: DashboardSectionProps;
  /** Sections listed after the tables, such as the database's automations */
  children?: ReactNode;
  /** Offers suggested links involving a table */
  onFindLinks?(tableId: string): void;
  /** Offers finding and merging a table's duplicate records */
  onFindDuplicates?(tableId: string): void;
  /** Offers choosing which records each person sees, for people who can change the schema */
  onRecordAccess?(tableId: string): void;
  /** Tables that already have record rules, which keep Record access in the menus at every level */
  ruledTables?: ReadonlySet<string>;
  /** Offers the table's booking pages, for people who can change the schema */
  onBookingPages?(tableId: string): void;
}

export function TableSidebar({
  tables: allTables,
  activeTableId,
  hrefFor,
  onNavigate,
  canEdit,
  onCreate,
  onRename,
  onDelete,
  onDuplicate,
  onMove,
  onImport,
  onSync,
  onTrash,
  dashboards,
  children,
  onFindLinks,
  onFindDuplicates,
  onImportInto,
  onRecordAccess,
  ruledTables,
  onBookingPages,
}: TableSidebarProps) {
  const tables = allTables.filter((table) => !table.lineItems);
  const { t } = useLingui();
  const { offers } = useLevel();
  const trash = useTrashPhrase();
  // Importing and data sources are Standard, and record access is Advanced.  A database that
  // already has synced tables, or records that follow rules, keeps its way to them at every level.
  const held = {
    syncedTables: tables.filter((table) => table.source).length,
    ruledTables: ruledTables?.size ?? 0,
  };
  const importing = offers('addTable', 'import', held) ? onImport : undefined;
  const syncing = offers('addTable', 'sync', held) ? onSync : undefined;
  const importingInto = offers('tableMenu', 'importInto', held) ? onImportInto : undefined;
  const ruling = offers('tableMenu', 'recordAccess', held) ? onRecordAccess : undefined;
  const recordAccess = t({ id: 'permissions.records.menu', message: 'Record access' });
  const findLinks = t({ id: 'joins.find', message: 'Find links' });
  const findDuplicates = t({ id: 'dedupe.find', message: 'Find duplicates' });
  const importInto = t({ id: 'import.into.menu', message: 'Import into this table' });
  const bookingPages = t({ id: 'bookings.menu', message: 'Booking pages' });
  return (
    <nav className="rio-db-sidebar" aria-label={t({ id: 'database.sidebar.label', message: 'Tables' })}>
      <SidebarOrder
        actions={
          canEdit && !importing && !syncing ? (
            // With a blank table the only way to add one, the button makes it straight away.
            <Button
              variant="quiet"
              icon={faPlus}
              onPress={onCreate}
              {...anchor('database.tables.add')}
              aria-label={t({ id: 'synced.add.menu', message: 'Add a table' })}
            />
          ) : canEdit ? (
            <MenuTrigger>
              <Button
                variant="quiet"
                icon={faPlus}
                {...anchor('database.tables.add')}
                aria-label={t({ id: 'synced.add.menu', message: 'Add a table' })}
              />
              <Menu aria-label={t({ id: 'synced.add.menu', message: 'Add a table' })}>
                <MenuItem id="blank" onAction={onCreate}>
                  <Trans id="synced.add.blank">Blank table</Trans>
                </MenuItem>
                {importing && (
                  <MenuItem id="import" onAction={importing}>
                    <Trans id="import.add.menu">Import a CSV or Excel file</Trans>
                  </MenuItem>
                )}
                {syncing && (
                  <MenuItem id="sync" onAction={syncing}>
                    <Trans id="synced.add.sync">Sync from a data source</Trans>
                  </MenuItem>
                )}
              </Menu>
            </MenuTrigger>
          ) : null
        }
        items={tables}
        section="table"
        disabledReason={
          !canEdit
            ? t({ id: 'database.sidebar.readOnly', message: 'You need permission to arrange this database.' })
            : undefined
        }
        onMove={(from, to) => onMove(tables[from]!.id, to)}
      >
        <ul className="rio-db-table-list" {...anchor('database.tables')}>
          {tables.map(({ id, name, source }) => (
            <SortableItem key={id} id={id} as="li" className="rio-sidebar-sortable" altMoveScope="row">
              <>
                <NamedLink
                  name={name}
                  href={hrefFor(id)}
                  active={id === activeTableId}
                  icon={faTable}
                  canEdit={canEdit}
                  canDelete={tables.length > 1}
                  onNavigate={() => onNavigate(id)}
                  onRename={(value) => onRename(id, value)}
                  onDelete={() => onDelete(id)}
                  menuAnchor={id === activeTableId ? anchor('database.table.menu') : undefined}
                  itemAnchors={
                    id === activeTableId
                      ? {
                          recordAccess: anchor('database.table.recordAccess'),
                          findDuplicates: anchor('database.table.dedupe'),
                          importInto: anchor('database.table.importInto'),
                        }
                      : undefined
                  }
                  actions={[
                    ...(onDuplicate
                      ? [
                          {
                            id: 'duplicate',
                            label: t({ id: 'duplicate.table.title', message: 'Duplicate table' }),
                            onAction: () => onDuplicate(id),
                          },
                        ]
                      : []),
                    ...(onFindLinks
                      ? [{ id: 'findLinks', label: findLinks, onAction: () => onFindLinks(id) }]
                      : []),
                    ...(onFindDuplicates
                      ? [
                          {
                            id: 'findDuplicates',
                            label: findDuplicates,
                            onAction: () => onFindDuplicates(id),
                          },
                        ]
                      : []),
                    // A synced table's records come from its source, so a file can't add to them.
                    ...(importingInto && !source
                      ? [
                          {
                            id: 'importInto',
                            label: importInto,
                            canUse: true,
                            onAction: () => importingInto(id),
                          },
                        ]
                      : []),
                    ...(ruling
                      ? [{ id: 'recordAccess', label: recordAccess, onAction: () => ruling(id) }]
                      : []),
                    // A synced table's records come from its source, so nobody can book into it.
                    ...(onBookingPages && !source
                      ? [{ id: 'bookingPages', label: bookingPages, onAction: () => onBookingPages(id) }]
                      : []),
                  ]}
                  linkProps={{
                    'aria-keyshortcuts': canEdit ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
                    'aria-description': canEdit
                      ? t({ id: 'database.sidebar.move', message: `Move ${name}` })
                      : undefined,
                  }}
                  copy={{
                    menu: t({ id: 'database.sidebar.menu', message: `More for ${name}` }),
                    rename: t({ id: 'database.sidebar.rename', message: 'Rename' }),
                    delete: t({ id: 'database.sidebar.delete', message: 'Delete table' }),
                    deleteTitle: t({ id: 'database.sidebar.deleteTitle', message: `Delete ${name}?` }),
                    deleteBody: t({
                      id: 'database.sidebar.deleteBody',
                      message: `The table and its views are deleted for everyone.  You can restore them from the trash ${trash}.`,
                    }),
                    deleteConfirm: t({ id: 'database.sidebar.deleteConfirm', message: 'Delete table' }),
                  }}
                />
              </>
            </SortableItem>
          ))}
        </ul>
      </SidebarOrder>
      {dashboards ? <DashboardSection {...dashboards} canEdit={canEdit} /> : null}
      {children}
      {onTrash && (
        <Button
          className="rio-db-trash"
          variant="quiet"
          icon={faTrashCan}
          onPress={onTrash}
          {...anchor('database.trash')}
        >
          <Trans id="trash.open">Trash</Trans>
        </Button>
      )}
    </nav>
  );
}
