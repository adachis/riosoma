import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  newId,
  type OutboundSync,
  type OutboundSyncUpdate,
  type SyncOutAction,
  type ViewSyncOut,
} from '@riosoma/contracts';
import { ConfirmDialog, Dialog, DialogTitle, Modal } from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../messages/errorInfo';
import { listViewSyncOut, sendSyncOutCommand, viewSyncOutKey } from './api';
import { SyncOutList } from './SyncOutList';
import { SyncOutSetup } from './SyncOutSetup';
import { SyncOutEdit } from './SyncOutEdit';
import { SyncOutRuns } from './SyncOutRuns';
import { syncOutLabel } from './words';
import './sync-out.css';

type Screen =
  | { kind: 'list' }
  | { kind: 'setup' }
  | { kind: 'edit'; sync: OutboundSync }
  | { kind: 'runs'; sync: OutboundSync };

export interface SyncOutDialogProps {
  viewId: string;
  viewName: string;
  databaseId: string;
  onClose(): void;
}

/**
 * A view's outbound syncs: the list of where it goes, setting one up, changing it, syncing now,
 * turning it off and on, deleting it, and its run history.
 */
export function SyncOutDialog({ viewId, viewName, databaseId, onClose }: SyncOutDialogProps) {
  const { t, i18n } = useLingui();
  const queryClient = useQueryClient();
  const key = viewSyncOutKey(viewId);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [deleting, setDeleting] = useState<OutboundSync | null>(null);
  const [pending, setPending] = useState(false);

  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => listViewSyncOut(viewId, signal),
    refetchInterval: (q) =>
      q.state.data?.syncs.some((sync) => sync.status.state === 'queued' || sync.status.state === 'running')
        ? 1500
        : 15_000,
  });
  const data = query.data;

  const store = (sync: OutboundSync) =>
    queryClient.setQueryData<ViewSyncOut>(key, (current) =>
      current
        ? {
            ...current,
            syncs: current.syncs.some((item) => item.id === sync.id)
              ? current.syncs.map((item) => (item.id === sync.id ? sync : item))
              : [...current.syncs, sync],
          }
        : current,
    );
  const drop = (syncId: string) =>
    queryClient.setQueryData<ViewSyncOut>(key, (current) =>
      current ? { ...current, syncs: current.syncs.filter((item) => item.id !== syncId) } : current,
    );

  const command = (action: SyncOutAction) => sendSyncOutCommand(databaseId, { id: newId('command'), action });

  const toggle = useMutation({
    mutationFn: ({ sync, enabled }: { sync: OutboundSync; enabled: boolean }) =>
      command({ kind: 'update', syncId: sync.id, input: { enabled } }),
    onSuccess: (result) => {
      if (result.sync) store(result.sync);
    },
  });
  const run = useMutation({
    mutationFn: (sync: OutboundSync) => command({ kind: 'run', syncId: sync.id }),
    onSuccess: (result) => {
      if (result.sync) store(result.sync);
    },
  });
  const remove = useMutation({
    mutationFn: (syncId: string) => command({ kind: 'delete', syncId }),
    onSuccess: (_result, syncId) => drop(syncId),
  });

  const save = async (syncId: string, update: OutboundSyncUpdate) => {
    const result = await command({ kind: 'update', syncId, input: update });
    if (result.sync) store(result.sync);
    return result.sync!;
  };

  const busyId = toggle.isPending ? toggle.variables.sync.id : run.isPending ? run.variables.id : null;

  const back = () => setScreen({ kind: 'list' });
  const titles: Record<Screen['kind'], string> = {
    list: i18n._(syncOutLabel),
    setup: t({ id: 'syncOut.setup.title', message: 'Set up Sync out' }),
    edit: t({ id: 'syncOut.edit.title', message: 'Sync out settings' }),
    runs: t({ id: 'syncOut.runs.title', message: 'Sync history' }),
  };
  const deletingName = deleting?.destination.table.name ?? '';

  return (
    <>
      <Modal
        isOpen
        size="lg"
        isDismissable={screen.kind === 'list' || screen.kind === 'runs'}
        onOpenChange={(open) => {
          if (!open && !pending) onClose();
        }}
      >
        <Dialog>
          <DialogTitle>{titles[screen.kind]}</DialogTitle>
          {screen.kind === 'setup' && data ? (
            <SyncOutSetup
              viewId={viewId}
              viewName={viewName}
              databaseId={databaseId}
              kinds={data.kinds}
              onPending={setPending}
              onCancel={() => {
                setPending(false);
                back();
              }}
              onCreated={(sync) => {
                store(sync);
                setPending(false);
                back();
              }}
            />
          ) : screen.kind === 'edit' ? (
            <SyncOutEdit
              sync={screen.sync}
              save={save}
              onPending={setPending}
              onCancel={() => {
                setPending(false);
                back();
              }}
              onSaved={() => {
                setPending(false);
                back();
              }}
            />
          ) : screen.kind === 'runs' ? (
            <SyncOutRuns sync={screen.sync} onBack={back} />
          ) : (
            <SyncOutList
              data={data}
              loading={query.isPending}
              queryError={query.isError ? query.error : null}
              commandError={toggle.error ?? run.error}
              busyId={busyId}
              onRetry={() => void query.refetch()}
              onSetup={() => setScreen({ kind: 'setup' })}
              onToggle={(sync, enabled) => {
                toggle.reset();
                toggle.mutate({ sync, enabled });
              }}
              onRun={(sync) => {
                run.reset();
                run.mutate(sync);
              }}
              onEdit={(sync) => setScreen({ kind: 'edit', sync })}
              onRuns={(sync) => setScreen({ kind: 'runs', sync })}
              onDelete={(sync) => {
                remove.reset();
                setDeleting(sync);
              }}
            />
          )}
        </Dialog>
      </Modal>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'syncOut.delete.title', message: 'Delete this sync?' })}
          message={
            <>
              <Trans id="syncOut.delete.message">
                Riosoma stops updating {deletingName}. The rows already there stay as they are.
              </Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'syncOut.delete.confirm', message: 'Delete sync' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={async () => {
            await remove.mutateAsync(deleting.id);
            setDeleting(null);
          }}
        />
      ) : null}
    </>
  );
}
