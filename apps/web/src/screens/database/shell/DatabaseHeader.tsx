import { useLingui } from '@lingui/react/macro';
import type { DatabaseMeta } from '@riosoma/contracts';
import { Button, Heading } from '@riosoma/ui';
import { useId, useRef, useState, type ReactNode } from 'react';
import { DatabaseIcon } from '../../home/DatabaseIcon';
import { InlineName } from './InlineName';
import './shell.css';

export interface DatabaseHeaderProps {
  database: Pick<DatabaseMeta, 'name' | 'icon' | 'color'>;
  canManage: boolean;
  onRename(name: string): void;
  saveIndicator?: ReactNode;
  presenceBar?: ReactNode;
  actions?: ReactNode;
}

export function DatabaseHeader({
  database,
  canManage,
  onRename,
  saveIndicator,
  presenceBar,
  actions,
}: DatabaseHeaderProps) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const renameHint = useId();
  const nameContainer = useRef<HTMLDivElement>(null);
  const finish = (restoreFocus = true) => {
    setEditing(false);
    if (restoreFocus) requestAnimationFrame(() => nameContainer.current?.querySelector('button')?.focus());
  };
  return (
    <header className="rio-db-header">
      <DatabaseIcon database={database} />
      <div className="rio-db-header__name" ref={nameContainer}>
        {editing && canManage ? (
          <InlineName
            name={database.name}
            label={t({ id: 'database.name', message: 'Database name' })}
            onCancel={finish}
            onSave={(name) => {
              onRename(name);
              finish();
            }}
          />
        ) : (
          <Heading level={1}>
            {canManage ? (
              <Button variant="quiet" onPress={() => setEditing(true)} aria-describedby={renameHint}>
                {database.name}
              </Button>
            ) : (
              database.name
            )}
          </Heading>
        )}
        {canManage && !editing && (
          <span id={renameHint} className="rio-visually-hidden">
            {t({ id: 'database.sidebar.rename', message: 'Rename' })}
          </span>
        )}
      </div>
      {saveIndicator}
      {presenceBar}
      {actions}
    </header>
  );
}
