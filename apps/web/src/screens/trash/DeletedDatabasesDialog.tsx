import { Trans, useLingui } from '@lingui/react/macro';
import type { TrashedDatabases } from '@riosoma/contracts';
import { Banner, Dialog, DialogBody, DialogTitle, Modal, Spinner, toast } from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { runDatabaseCommand } from './database-commands';
import { TrashEntry } from './TrashEntry';

export function DeletedDatabasesDialog({ onClose }: { onClose(): void }) {
  return (
    <Modal
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="trash.databases">Deleted databases</Trans>
        </DialogTitle>
        <DialogBody>
          <DeletedDatabasesList />
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

export function DeletedDatabasesList({ showEmpty = true }: { showEmpty?: boolean } = {}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const trash = useQuery({
    queryKey: ['trash', 'databases'],
    queryFn: ({ signal }) => api<TrashedDatabases>('/api/trash', { signal }),
  });
  const restore = useMutation({
    mutationFn: (database: TrashedDatabases['databases'][number]) =>
      runDatabaseCommand(database.id, 'database.restore'),
    onSuccess: async (_, { name }) => {
      toast.show({ title: t({ id: 'trash.restored', message: `Restored ${name}` }), tone: 'success' });
      await Promise.all([
        client.invalidateQueries({ queryKey: ['trash', 'databases'] }),
        client.invalidateQueries({ queryKey: ['databases'] }),
        client.invalidateQueries({ queryKey: ['home'] }),
      ]);
    },
  });
  const error = trash.error ?? restore.error;
  return (
    <>
      {error && (
        <Banner tone="danger">
          {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
        </Banner>
      )}
      {trash.isPending && <Spinner label={t({ id: 'trash.title', message: 'Trash' })} />}
      {showEmpty && trash.data?.databases.length === 0 && (
        <p>
          <Trans id="trash.empty">Nothing has been deleted.</Trans>
        </p>
      )}
      <ul className="rio-trash-list">
        {trash.data?.databases.map((database) => (
          <TrashEntry
            key={database.id}
            {...database}
            pending={restore.isPending && restore.variables.id === database.id}
            disabled={restore.isPending}
            onRestore={() => restore.mutate(database)}
          />
        ))}
      </ul>
    </>
  );
}
