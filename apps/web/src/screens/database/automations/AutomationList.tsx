import { SidebarOrder } from '../shell/SidebarOrder';
import { faCircle as faCircleOff } from '@fortawesome/free-regular-svg-icons';
import { faCircle, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { newId, roleAllows, type AutomationMeta } from '@riosoma/contracts';
import { Button, SortableItem } from '@riosoma/ui';
import { useNavigate } from '@tanstack/react-router';
import { useId } from 'react';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError, undoToast } from '../../../grid/view/actions';
import { automationHref, databaseHref } from '../screen/routes';
import { NamedLink } from '../shell/NamedLink';
import { defaultConfig } from './model';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { useTrashPhrase } from '../../../features/retention/window';
import { anchor } from '../../../demos/anchors';
import './automations.css';

export interface AutomationListProps {
  automations: readonly AutomationMeta[];
  activeAutomationId: string | null;
  hrefFor(automationId: string): string;
  onNavigate(automationId: string): void;
  canEdit: boolean;
  /** Whether the section offers a new automation, which a level can tidy away.  Defaults to `canEdit`. */
  canAdd?: boolean;
  onCreate(): void;
  onRename(automationId: string, name: string): void;
  onDelete(automationId: string): void;
  onMove(automationId: string, toIndex: number): void;
}

/**
 * The sidebar's list of automations, each with a dot that's filled while it's on.  People who
 * can't change the schema see the list without the controls.
 */
export function AutomationList({
  automations,
  activeAutomationId,
  hrefFor,
  onNavigate,
  canEdit,
  canAdd = canEdit,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: AutomationListProps) {
  const { t } = useLingui();
  const trash = useTrashPhrase();
  const id = useId();
  const on = t({ id: 'automations.on', message: 'On' });
  const off = t({ id: 'automations.off', message: 'Off' });
  // With nothing to list and nothing to add, the section would be a heading alone.
  if (!automations.length && !canAdd) return null;
  return (
    <section
      className="rio-automation-list"
      aria-labelledby={`${id}-heading`}
      {...anchor('automations.section')}
    >
      {
        <SidebarOrder
          actions={
            canAdd ? (
              <Button
                className="rio-automation-list__add"
                variant="quiet"
                icon={faPlus}
                onPress={onCreate}
                {...anchor('automations.add')}
                aria-label={t({ id: 'automations.add', message: 'Add an automation' })}
              />
            ) : null
          }
          headingId={`${id}-heading`}
          items={automations}
          section="automation"
          disabledReason={
            !canEdit
              ? t({
                  id: 'database.sidebar.readOnly',
                  message: 'You need permission to arrange this database.',
                })
              : undefined
          }
          onMove={(from, to) => onMove(automations[from]!.id, to)}
        >
          <ul className="rio-automation-list__items">
            {automations.map(({ id: automationId, name, enabled }) => (
              <SortableItem
                key={automationId}
                id={automationId}
                as="li"
                className="rio-sidebar-sortable rio-automation-list__item"
                altMoveScope="row"
                renderWrapper={(props, children) => (
                  <li {...props} data-enabled={enabled || undefined}>
                    {children}
                  </li>
                )}
              >
                <>
                  <span id={`${id}-${automationId}`} hidden>
                    {enabled ? on : off}
                  </span>
                  <NamedLink
                    name={name}
                    href={hrefFor(automationId)}
                    active={automationId === activeAutomationId}
                    icon={enabled ? faCircle : faCircleOff}
                    canEdit={canEdit}
                    canDelete
                    onNavigate={() => onNavigate(automationId)}
                    onRename={(value) => onRename(automationId, value)}
                    onDelete={() => onDelete(automationId)}
                    linkProps={{
                      'aria-describedby': `${id}-${automationId}`,
                      'aria-keyshortcuts': canEdit ? 'Alt+ArrowUp Alt+ArrowDown' : undefined,
                    }}
                    copy={{
                      menu: t({ id: 'automations.menu', message: `More for ${name}` }),
                      rename: t({ id: 'automations.rename', message: 'Rename' }),
                      delete: t({ id: 'automations.delete', message: 'Delete automation' }),
                      deleteTitle: t({ id: 'automations.delete.title', message: `Delete ${name}?` }),
                      deleteBody: t({
                        id: 'automations.delete.body',
                        message: `It stops running and is deleted for everyone.  You can restore it from the trash ${trash}.`,
                      }),
                      deleteConfirm: t({ id: 'automations.delete', message: 'Delete automation' }),
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

export interface AutomationSidebarProps {
  session: DatabaseSession;
  schema: SchemaState;
  activeAutomationId: string | null;
  /** The table a new automation starts from, and where the screen goes when the open one is deleted */
  tableId: string;
}

/** The sidebar section, wired to the session and the router. */
export function AutomationSidebar({ session, schema, activeAutomationId, tableId }: AutomationSidebarProps) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const canEdit = roleAllows(session.role(), 'editSchema');
  const { offers } = useLevel();
  const hrefFor = (automationId: string) => automationHref(session.databaseId, automationId);
  const execute = (action: () => void) => {
    try {
      action();
    } catch (error) {
      reportError(error);
    }
  };
  const create = () =>
    execute(() => {
      const automationId = newId('automation');
      const last = schema.automations.at(-1)?.position ?? -1;
      session.run([
        {
          kind: 'automation.create',
          automation: {
            id: automationId,
            name: t({ id: 'automations.untitled', message: 'Untitled automation' }),
            config: defaultConfig(tableId),
          },
          position: last + 1,
        },
      ]);
      void navigate({ to: hrefFor(automationId) });
    });
  // Automations are Standard.  The palette offers a new one at every level.
  useFeatureCommands(
    'database.automations',
    canEdit ? [{ place: 'databaseSidebar:automations', run: create }] : [],
  );
  return (
    <AutomationList
      automations={schema.automations}
      activeAutomationId={activeAutomationId}
      hrefFor={hrefFor}
      onNavigate={(automationId) => {
        void navigate({ to: hrefFor(automationId) });
      }}
      canEdit={canEdit}
      canAdd={canEdit && offers('databaseSidebar', 'automations', { automations: schema.automations.length })}
      onCreate={create}
      onRename={(automationId, name) =>
        execute(() => {
          session.run([{ kind: 'automation.update', automationId, name }]);
        })
      }
      onDelete={(automationId) => {
        const name = schema.automationById.get(automationId)?.name ?? '';
        const trash = () =>
          execute(() => {
            session.run([{ kind: 'automation.trash', automationId }]);
            undoToast(session, t({ id: 'automations.deleted', message: `Deleted ${name}` }));
          });
        // Leave the automation's screen first, so its link never points at nothing.
        if (automationId === activeAutomationId)
          void navigate({ to: databaseHref(session.databaseId, tableId) }).then(trash);
        else trash();
      }}
      onMove={(automationId, toIndex) =>
        execute(() => {
          const ordered = schema.automations.filter((item) => item.id !== automationId);
          const before = ordered[toIndex - 1]?.position;
          const after = ordered[toIndex]?.position;
          const position =
            before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
          session.run([{ kind: 'automation.move', automationId, position }]);
        })
      }
    />
  );
}
