import { faChevronDown, faChevronRight } from '@fortawesome/free-solid-svg-icons';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { roleAllows, type DatabaseTrash, type TrashedRecordsPage } from '@riosoma/contracts';
import { Banner, Button, Dialog, DialogBody, DialogTitle, Modal, Spinner, toast } from '@riosoma/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import { useSchema } from '../../data/hooks';
import type { CommandInput, DatabaseSession } from '../../data/types';
import { useServerMessage } from '../../messages/useServerMessage';
import { TrashEntry } from './TrashEntry';
import { anchor } from '../../demos/anchors';

export function TrashDialog({ session, onClose }: { session: DatabaseSession; onClose(): void }) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const schema = useSchema(session);
  const key = ['trash', session.databaseId];
  const trash = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api<DatabaseTrash>(`/api/databases/${session.databaseId}/trash`, { signal }),
  });
  useEffect(() => {
    void client.invalidateQueries({ queryKey: ['trash', session.databaseId] });
  }, [client, session.databaseId, schema?.seq]);
  const restore = useMutation({
    mutationFn: async ({ command }: { command: CommandInput; name: string }) => {
      const result = await session.run([command]).done;
      if (result.rejected) throw new Error('Restore rejected');
    },
    onSuccess: async (_, { name }) => {
      toast.show({ title: t({ id: 'trash.restored', message: `Restored ${name}` }), tone: 'success' });
      await client.invalidateQueries({ queryKey: key });
    },
  });
  const error = trash.error ?? restore.error;
  const kinds = {
    table: t({ id: 'trash.kind.table', message: 'Table' }),
    field: t({ id: 'trash.kind.field', message: 'Field' }),
    view: t({ id: 'trash.kind.view', message: 'View' }),
    dashboard: t({ id: 'trash.kind.dashboard', message: 'Dashboard' }),
    automation: t({ id: 'trash.kind.automation', message: 'Automation' }),
    interface: t({ id: 'interfaces.kind', message: 'Interface' }),
    script: t({ id: 'trash.kind.script', message: 'Script' }),
  };
  const run = (command: CommandInput, name: string) => restore.mutate({ command, name });
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
          <Trans id="trash.title">Trash</Trans>
        </DialogTitle>
        <DialogBody>
          {error && (
            <Banner tone="danger">
              {message(error instanceof ApiError ? error.info.messageKey : 'errors.internal')}
            </Banner>
          )}
          {trash.isPending && <Spinner label={t({ id: 'trash.title', message: 'Trash' })} />}
          {trash.data && !trash.data.items.length && !trash.data.records.length && (
            <p>
              <Trans id="trash.empty">Nothing has been deleted.</Trans>
            </p>
          )}
          <ul className="rio-trash-list" {...anchor('trash.list')}>
            {trash.data?.items.map((item) => (
              <TrashEntry
                key={item.id}
                {...item}
                retention={trash.data?.retention}
                deletedBy={item.trashedBy ? schema?.collaborators.get(item.trashedBy)?.name : undefined}
                kind={
                  <span>
                    {kinds[item.kind]}
                    {item.tableName ? ` · ${item.tableName}` : ''}
                  </span>
                }
                pending={restore.isPending && restore.variables.name === item.name}
                disabled={restore.isPending || !roleAllows(session.role(), 'editSchema')}
                onRestore={() =>
                  run(
                    item.kind === 'table'
                      ? { kind: 'table.restore', tableId: item.id }
                      : item.kind === 'field'
                        ? { kind: 'field.restore', fieldId: item.id }
                        : item.kind === 'dashboard'
                          ? { kind: 'dashboard.restore', dashboardId: item.id }
                          : item.kind === 'automation'
                            ? { kind: 'automation.restore', automationId: item.id }
                            : item.kind === 'interface'
                              ? { kind: 'interface.restore', interfaceId: item.id }
                              : item.kind === 'script'
                                ? { kind: 'script.restore', scriptId: item.id }
                                : { kind: 'view.restore', viewId: item.id },
                    item.name,
                  )
                }
              />
            ))}
          </ul>
          {trash.data?.records.map((table) => (
            <RecordTrash
              key={table.tableId}
              {...table}
              retention={trash.data?.retention}
              session={session}
              run={run}
              pending={restore.isPending}
            />
          ))}
        </DialogBody>
      </Dialog>
    </Modal>
  );
}

function RecordTrash({
  tableId,
  tableName: table,
  count,
  retention,
  session,
  run,
  pending,
}: DatabaseTrash['records'][number] & {
  retention?: DatabaseTrash['retention'];
  session: DatabaseSession;
  run(command: CommandInput, name: string): void;
  pending: boolean;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [expanded, setExpanded] = useState(false);
  const schema = useSchema(session);
  const untitled = t({ id: 'record.untitled', message: 'Untitled record' });
  const pages = useInfiniteQuery({
    queryKey: ['trash', session.databaseId, tableId],
    enabled: expanded,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api<TrashedRecordsPage>(
        `/api/tables/${tableId}/trash/records${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    getNextPageParam: (page) => page.next,
  });
  return (
    <section className="rio-trash-records">
      <Button
        variant="quiet"
        icon={expanded ? faChevronDown : faChevronRight}
        aria-expanded={expanded}
        onPress={() => setExpanded(!expanded)}
      >
        {t({
          id: 'trash.records',
          message: plural(count, {
            one: `# deleted record in ${table}`,
            other: `# deleted records in ${table}`,
          }),
        })}
      </Button>
      {expanded && (
        <>
          {pages.error && (
            <Banner tone="danger">
              {message(pages.error instanceof ApiError ? pages.error.info.messageKey : 'errors.internal')}
            </Banner>
          )}
          {pages.isPending && <Spinner label={t({ id: 'trash.title', message: 'Trash' })} />}
          <ul className="rio-trash-list">
            {pages.data?.pages
              .flatMap((page) => page.records)
              .map(({ name, ...record }) => ({ ...record, name: name || untitled }))
              .map((record) => (
                <TrashEntry
                  key={record.id}
                  {...record}
                  retention={retention}
                  deletedBy={record.trashedBy ? schema?.collaborators.get(record.trashedBy)?.name : undefined}
                  pending={pending}
                  disabled={pending || !roleAllows(session.role(), 'editRecords')}
                  onRestore={() =>
                    run({ kind: 'record.restore', tableId, recordIds: [record.id] }, record.name)
                  }
                />
              ))}
          </ul>
          {pages.hasNextPage && (
            <Button
              isPending={pages.isFetchingNextPage}
              onPress={() => {
                void pages.fetchNextPage();
              }}
            >
              <Trans id="trash.more">Show more</Trans>
            </Button>
          )}
        </>
      )}
    </section>
  );
}
