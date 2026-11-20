import { SidebarOrder } from './SidebarOrder';
import { useId } from 'react';
import { faChartColumn, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { type DashboardMeta } from '@riosoma/contracts';
import { Button, SortableItem } from '@riosoma/ui';
import { NamedLink } from './NamedLink';
import { useLevel } from '../../../levels/context';
import { useTrashPhrase } from '../../../features/retention/window';
import { anchor } from '../../../demos/anchors';

export interface DashboardSectionProps {
  dashboards: readonly DashboardMeta[];
  activeDashboardId: string | null;
  hrefFor(dashboardId: string): string;
  onNavigate(dashboardId: string): void;
  onCreate(): void;
  onRename(dashboardId: string, name: string): void;
  onDelete(dashboardId: string): void;
  onMove(dashboardId: string, toIndex: number): void;
}

/**
 * The database's dashboards under the tables, with the tables' own renaming, deleting, and
 * reordering by dragging or with Alt and the arrow keys.  People who can't change the schema see
 * the list without the controls, and nothing at all when there are no dashboards.
 */
export function DashboardSection({
  dashboards,
  activeDashboardId,
  hrefFor,
  onNavigate,
  onCreate,
  onRename,
  onDelete,
  onMove,
  canEdit,
}: DashboardSectionProps & { canEdit: boolean }) {
  const { t } = useLingui();
  const trash = useTrashPhrase();
  const headingId = useId();
  // Dashboards are Standard.  Below it the section lists the ones there are, and a database that
  // has some keeps the way to add another, as every level does for what's already in use.
  const { offers } = useLevel();
  const adding = canEdit && offers('databaseSidebar', 'dashboards', { dashboards: dashboards.length });
  if (!adding && !dashboards.length) return null;
  return (
    <section className="rio-dashboard-sidebar" aria-labelledby={headingId} {...anchor('dashboards.section')}>
      {
        <SidebarOrder
          actions={
            adding ? (
              <Button
                variant="quiet"
                icon={faPlus}
                onPress={onCreate}
                {...anchor('dashboards.add')}
                aria-label={t({ id: 'dashboards.add', message: 'Add a dashboard' })}
              />
            ) : null
          }
          headingId={headingId}
          items={dashboards}
          section="dashboard"
          disabledReason={
            !canEdit
              ? t({
                  id: 'database.sidebar.readOnly',
                  message: 'You need permission to arrange this database.',
                })
              : undefined
          }
          onMove={(from, to) => onMove(dashboards[from]!.id, to)}
        >
          <ul className="rio-dashboard-sidebar__list">
            {dashboards.map(({ id, name }) => (
              <SortableItem key={id} id={id} as="li" className="rio-sidebar-sortable" altMoveScope="row">
                <>
                  <NamedLink
                    name={name}
                    href={hrefFor(id)}
                    active={id === activeDashboardId}
                    icon={faChartColumn}
                    canEdit={canEdit}
                    canDelete
                    onNavigate={() => onNavigate(id)}
                    onRename={(value) => onRename(id, value)}
                    onDelete={() => onDelete(id)}
                    linkProps={{
                      'aria-keyshortcuts': canEdit ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
                      'aria-description': canEdit
                        ? t({ id: 'database.sidebar.move', message: `Move ${name}` })
                        : undefined,
                    }}
                    copy={{
                      menu: t({ id: 'database.sidebar.menu', message: `More for ${name}` }),
                      rename: t({ id: 'database.sidebar.rename', message: 'Rename' }),
                      delete: t({ id: 'dashboards.delete', message: 'Delete dashboard' }),
                      deleteTitle: t({ id: 'dashboards.delete.title', message: `Delete ${name}?` }),
                      deleteBody: t({
                        id: 'dashboards.delete.body',
                        message: `It’s deleted for everyone.  You can restore it from the trash ${trash}.`,
                      }),
                      deleteConfirm: t({ id: 'dashboards.delete', message: 'Delete dashboard' }),
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
