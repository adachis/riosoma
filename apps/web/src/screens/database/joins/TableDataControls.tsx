import { faCodeBranch, faPlus, faSliders, faClockRotateLeft } from '@fortawesome/free-solid-svg-icons';
import { JoinedMappingSettings } from './JoinedMappingSettings';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { roleAllows, type TableMeta } from '@riosoma/contracts';
import { Button, Checkbox, Dialog, DialogBody, DialogFooter, Modal, NumberField } from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { reportError } from '../../../grid/view/actions';
import { databaseHref } from '../screen/routes';
import { SyncHistory } from '../synced/SyncHistory';
import { JoinedSetup } from './JoinedSetup';
import './joins.css';
import { HelpDialogTitle } from '../../../docs/HelpDialogTitle';

export function TableDataControls({ session, table }: { session: DatabaseSession; table: TableMeta }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { dataPanel?: string; syncCursor?: string };
  const panel = search.dataPanel;
  const open = (dataPanel?: string, syncCursor?: string) => {
    void navigate({ to: '.', search: (previous) => ({ ...previous, dataPanel, syncCursor }) });
  };
  const title =
    panel === 'mapping'
      ? t({ id: 'joined.mapping.title', message: 'Map corresponding columns' })
      : panel === 'join'
        ? t({ id: 'joined.create', message: 'Create joined table' })
        : panel === 'sync-history'
          ? t({ id: 'syncHistory.title', message: 'Sync history' })
          : t({ id: 'overrides.settings', message: 'Overrides and history' });
  const help =
    panel === 'join' || panel === 'mapping'
      ? ({ anchorId: 'joined.setup', section: 'joining-tables' } as const)
      : panel === 'sync-history'
        ? ({ anchorId: 'sync.history', section: 'read-sync-history' } as const)
        : ({ anchorId: 'overrides.settings', section: 'pin-computed-values' } as const);
  const canCreate = roleAllows(session.role(), 'editSchema');
  const owner = session.role() === 'owner';
  const visible =
    ((panel === 'join' || panel === 'mapping') && canCreate) ||
    (panel === 'overrides' && owner) ||
    panel === 'sync-history';
  return (
    <>
      <div className="rio-joined-controls">
        {table.joined && (
          <span>
            {t({
              id: 'joined.readOnlyNote',
              message: 'Joined table—values can be pinned, and rows follow their source tables.',
            })}
          </span>
        )}
        {canCreate && (
          <Button
            size="sm"
            variant="quiet"
            icon={faPlus}
            aria-label={t({ id: 'joined.create', message: 'Create joined table' })}
            onPress={() => open('join')}
          />
        )}
        {table.joined && canCreate && (
          <Button
            size="sm"
            variant="quiet"
            icon={faCodeBranch}
            aria-label={t({ id: 'joined.mapping.title', message: 'Map corresponding columns' })}
            onPress={() => open('mapping')}
          />
        )}
        {owner && (
          <Button
            size="sm"
            variant="quiet"
            icon={faSliders}
            aria-label={t({ id: 'overrides.settings', message: 'Overrides and history' })}
            onPress={() => open('overrides')}
          />
        )}
        {(table.source || table.joined) && (
          <Button
            size="sm"
            variant="quiet"
            icon={faClockRotateLeft}
            aria-label={t({ id: 'syncHistory.title', message: 'Sync history' })}
            onPress={() => open('sync-history')}
          />
        )}
      </div>
      {visible && (
        <Modal
          isOpen
          isDismissable
          onOpenChange={(shown) => {
            if (!shown) open();
          }}
        >
          <Dialog>
            <HelpDialogTitle moduleId="joined-tables" anchorId={help.anchorId} section={help.section}>
              {title}
            </HelpDialogTitle>
            {panel === 'join' ? (
              <JoinedSetup
                session={session}
                tableId={table.id}
                onCreated={(id) => {
                  void navigate({ to: databaseHref(session.databaseId, id) });
                }}
              />
            ) : panel === 'mapping' && table.joined ? (
              <JoinedMappingSettings session={session} table={table} onClose={() => open()} />
            ) : panel === 'sync-history' ? (
              <DialogBody>
                <SyncHistory
                  tableId={table.id}
                  cursor={search.syncCursor}
                  onPage={(cursor) => open('sync-history', cursor)}
                />
              </DialogBody>
            ) : (
              <OverrideSettings session={session} table={table} onClose={() => open()} />
            )}
          </Dialog>
        </Modal>
      )}
    </>
  );
}

export function OverrideSettings({
  session,
  table,
  onClose,
}: {
  session: DatabaseSession;
  table: TableMeta;
  onClose(): void;
}) {
  const { t } = useLingui();
  const [enabled, setEnabled] = useState(table.allowComputedOverrides ?? false);
  const [days, setDays] = useState(table.historyRetentionDays ?? 90);
  const [pending, setPending] = useState(false);
  async function save() {
    setPending(true);
    try {
      const result = await session.run([
        {
          kind: 'table.update',
          tableId: table.id,
          allowComputedOverrides: enabled,
          historyRetentionDays: days,
        },
      ]).done;
      if (!result.rejected) onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <DialogBody className="rio-joined-form">
        {!table.joined && (
          <Checkbox isSelected={enabled} onChange={setEnabled}>
            {t({ id: 'overrides.enableComputed', message: 'Allow pins on formulas, lookups, and rollups' })}
          </Checkbox>
        )}
        <p>
          {t({
            id: 'overrides.help',
            message:
              'Open a record to pin a computed value.  A pin clears when the computed value agrees with it.',
          })}
        </p>
        <NumberField
          label={t({ id: 'syncHistory.retention', message: 'Keep sync history for this many days' })}
          minValue={1}
          maxValue={3650}
          value={days}
          onChange={setDays}
        />
      </DialogBody>
      <DialogFooter>
        <Button
          variant="primary"
          isPending={pending}
          isDisabled={!Number.isInteger(days) || days < 1 || days > 3650}
          onPress={() => {
            void save();
          }}
        >
          {t({ id: 'field.dialog.save', message: 'Save' })}
        </Button>
      </DialogFooter>
    </>
  );
}
