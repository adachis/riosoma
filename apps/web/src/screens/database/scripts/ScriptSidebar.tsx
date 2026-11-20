import { SidebarOrder } from '../shell/SidebarOrder';
import { faCode, faEllipsis, faPlus } from '@fortawesome/free-solid-svg-icons';
import { useLingui } from '@lingui/react/macro';
import { Icon } from '@riosoma/icons';
import { newId, roleAllows, type ScriptMeta } from '@riosoma/contracts';
import { Button, ConfirmDialog, Menu, MenuItem, MenuTrigger, SortableItem } from '@riosoma/ui';
import { useId, useRef, useState } from 'react';
import type { DatabaseSession, SchemaState } from '../../../data/types';
import { reportError, undoToast } from '../../../grid/view/actions';
import { InlineName } from '../shell/InlineName';
import { useLevel } from '../../../levels/context';
import { useFeatureCommands } from '../../../levels/palette';
import { useTrashPhrase } from '../../../features/retention/window';
import './scripts.css';

export interface ScriptSidebarProps {
  session: DatabaseSession;
  schema: SchemaState;
  /** The script open in the panel, if any */
  openScriptId: string | null;
  onOpen(scriptId: string): void;
}

/**
 * The sidebar's list of saved scripts, for everyone who can run them.  Choosing one opens it in
 * the script panel.  People who can change the schema also add, rename, reorder, and delete them,
 * each an ordinary command that undoes like other schema changes.
 */
export function ScriptSidebar({ session, schema, openScriptId, onOpen }: ScriptSidebarProps) {
  const { t } = useLingui();
  const id = useId();
  const canChange = roleAllows(session.role(), 'editSchema');
  const canRun = roleAllows(session.role(), 'editRecords');
  const { offers } = useLevel();
  // Scripts are Advanced.  Below it the section lists the scripts there are, which open and run as
  // ever, and a database with scripts keeps the way to add another.  The palette always offers one.
  const adding = canChange && offers('databaseSidebar', 'scripts', { scripts: schema.scripts.length });
  const scripts = schema.scripts;
  const execute = (action: () => void) => {
    try {
      action();
    } catch (error) {
      reportError(error);
    }
  };
  const create = () =>
    execute(() => {
      const scriptId = newId('script');
      const last = scripts.at(-1)?.position ?? -1;
      session.run([
        {
          kind: 'script.create',
          script: {
            id: scriptId,
            name: t({ id: 'scripts.untitled', message: 'Untitled script' }),
          },
          position: last + 1,
        },
      ]);
      onOpen(scriptId);
    });
  useFeatureCommands(
    'database.scripts',
    canChange && canRun ? [{ place: 'databaseSidebar:scripts', run: create }] : [],
  );
  // With nothing to run and nothing to add, the section would be a heading alone.
  if (!canRun || (!scripts.length && !adding)) return null;
  const move = (scriptId: string, toIndex: number) =>
    execute(() => {
      const ordered = scripts.filter((item) => item.id !== scriptId);
      const before = ordered[toIndex - 1]?.position;
      const after = ordered[toIndex]?.position;
      const position =
        before === undefined ? (after ?? 0) - 1 : after === undefined ? before + 1 : (before + after) / 2;
      session.run([{ kind: 'script.move', scriptId, position }]);
    });
  return (
    <section className="rio-script-list" aria-labelledby={`${id}-heading`}>
      {
        <SidebarOrder
          actions={
            adding ? (
              <Button
                className="rio-script-list__add"
                variant="quiet"
                icon={faPlus}
                onPress={create}
                aria-label={t({ id: 'scripts.add', message: 'Add a script' })}
              />
            ) : null
          }
          headingId={`${id}-heading`}
          items={scripts}
          section="script"
          disabledReason={
            !canChange
              ? t({
                  id: 'database.sidebar.readOnly',
                  message: 'You need permission to arrange this database.',
                })
              : undefined
          }
          onMove={(from, to) => move(scripts[from]!.id, to)}
        >
          <ul className="rio-script-list__items">
            {scripts.map((script, index) => (
              <SortableItem
                key={script.id}
                id={script.id}
                as="li"
                className="rio-sidebar-sortable"
                altMoveScope="row"
              >
                <>
                  <ScriptItem
                    script={script}
                    open={script.id === openScriptId}
                    canChange={canChange}
                    onOpen={() => onOpen(script.id)}
                    onMove={(offset) => {
                      const next = index + offset;
                      if (next >= 0 && next < scripts.length) move(script.id, next);
                    }}
                    onRename={(name) =>
                      execute(() => {
                        session.run([{ kind: 'script.update', scriptId: script.id, name }]);
                      })
                    }
                    onDelete={() =>
                      execute(() => {
                        session.run([{ kind: 'script.trash', scriptId: script.id }]);
                        const name = script.name;
                        undoToast(session, t({ id: 'scripts.deleted', message: `Deleted ${name}` }));
                      })
                    }
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

function ScriptItem({
  script,
  open,
  canChange,
  onOpen,
  onMove,
  onRename,
  onDelete,
}: {
  script: ScriptMeta;
  open: boolean;
  canChange: boolean;
  onOpen(): void;
  onMove(offset: number): void;
  onRename(name: string): void;
  onDelete(): void;
}) {
  const { t } = useLingui();
  const trash = useTrashPhrase();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const name = script.name;
  const finish = (restoreFocus = true) => {
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => button.current?.focus());
  };
  return (
    <>
      <div className="rio-script-list__item" data-active={open || undefined}>
        {editing && canChange ? (
          <InlineName
            name={name}
            label={t({ id: 'scripts.rename', message: 'Rename' })}
            onCancel={finish}
            onSave={(value) => {
              onRename(value);
              finish();
            }}
          />
        ) : (
          <button
            ref={button}
            type="button"
            className="rio-script-list__open"
            data-sortable-surface
            aria-pressed={open}
            aria-keyshortcuts={canChange ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
            onClick={onOpen}
            onKeyDown={(event) => {
              if (!canChange || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              onMove(event.key === 'ArrowUp' ? -1 : 1);
            }}
          >
            <Icon icon={faCode} />
            <span>{name}</span>
          </button>
        )}
        {canChange ? (
          <MenuTrigger>
            <Button
              className="rio-db-item-menu"
              variant="quiet"
              size="sm"
              icon={faEllipsis}
              aria-label={t({ id: 'scripts.menu', message: `More for ${name}` })}
            />
            <Menu aria-label={t({ id: 'scripts.menu', message: `More for ${name}` })}>
              <MenuItem onAction={() => setEditing(true)}>
                {t({ id: 'scripts.rename', message: 'Rename' })}
              </MenuItem>
              <MenuItem tone="danger" onAction={() => setDeleting(true)}>
                {t({ id: 'scripts.delete', message: 'Delete script' })}
              </MenuItem>
            </Menu>
          </MenuTrigger>
        ) : null}
      </div>
      <ConfirmDialog
        isOpen={deleting && canChange}
        onOpenChange={setDeleting}
        title={t({ id: 'scripts.delete.title', message: `Delete ${name}?` })}
        message={t({
          id: 'scripts.delete.body',
          message: `It’s deleted for everyone.  You can restore it from the trash ${trash}.`,
        })}
        confirmLabel={t({ id: 'scripts.delete', message: 'Delete script' })}
        tone="danger"
        onConfirm={onDelete}
      />
    </>
  );
}
