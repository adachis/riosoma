import { recoverImport } from '../asset-recovery';
import { useLingui } from '@lingui/react/macro';
import {
  IMPORT_PLATFORMS,
  type DatabaseSchema,
  type DatabaseSummary,
  type ImportPlatform,
} from '@riosoma/contracts';
import { toast } from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { databasesQuery } from '../data/databases';
import { useServerMessage } from '../messages/shellMessage';
import { FolderHome } from './home/FolderHome';
import { databaseCreationFolder, fileCreatedDatabase } from './home/folders';
import { DatabaseList } from './home/DatabaseList';

import { showReportWhenOpened } from './import/airtable/pending';
import { LazyBoundary, lazyFeature } from '../shell/lazy';
import type { NewDatabaseValues } from './home/payload';
import { runDatabaseCommand } from './trash/database-commands';

import { isOrgAdmin } from '../features/archives/access';
import { useSession } from '../session';
import { useCelebrations } from '../features/celebrations/useCelebrations';
import { prefetchTrashWindow, useTrashPhrase, useTrashWindowFor } from '../features/retention/window';
import { useLevel } from '../levels/context';
import { LevelSuggestion } from '../levels/LevelSuggestion';
import './home/home.css';

const ConfirmDialog = lazyFeature(() =>
  import('../shell/ConfirmDialog').then((module) => ({ default: module.ConfirmDialog })),
);

const NewDatabaseDialog = lazyFeature(() =>
  import('./home/NewDatabaseDialog').then((module) => ({ default: module.NewDatabaseDialog })),
);

const DeletedDatabasesDialog = lazyFeature(() =>
  import('./trash/DeletedDatabasesDialog').then((module) => ({ default: module.DeletedDatabasesDialog })),
);

const DuplicateDialog = lazyFeature(() =>
  import('../features/archives/DuplicateDialog').then((module) => ({ default: module.DuplicateDialog })),
);

const AirtableImportDialog = lazyFeature(() =>
  import('./import/airtable/AirtableImportDialog').then((module) => ({
    default: module.AirtableImportDialog,
  })),
);

const PlatformImportDialog = lazyFeature(() =>
  import('./import/platforms/PlatformImportDialog').then((module) => ({
    default: module.PlatformImportDialog,
  })),
);

const NewDatabaseFromFile = lazyFeature(() =>
  import('./import/NewDatabaseFromFile').then((module) => ({ default: module.NewDatabaseFromFile })),
);

const listKey = databasesQuery.queryKey;

export function HomeScreen() {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // The palette sends its home-screen commands through the address.
  const { new: intent, trash: trashAsked } = useSearch({ strict: false });
  const [trashOpen, setTrashOpen] = useState(false);
  const [deleting, setDeleting] = useState<DatabaseSummary | null>(null);
  // A database can carry its own window, so the confirmation reads the one being deleted.
  const trash = useTrashPhrase(useTrashWindowFor(deleting?.id));
  const [duplicating, setDuplicating] = useState<DatabaseSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [documentImport, setDocumentImport] = useState(false);
  const [importing, setImporting] = useState(false);
  const [airtable, setAirtable] = useState(false);
  const [platform, setPlatform] = useState<ImportPlatform | null>(null);
  const databases = useQuery(databasesQuery);
  const session = useSession();
  const { offers } = useLevel();
  // Importing is a Standard feature, so Simple leaves its buttons out, and the palette still has it.
  const platforms = IMPORT_PLATFORMS.some((platform) => offers('home', `import.${platform}`));
  const { observe, retire } = useCelebrations();
  const favorite = useMutation({
    mutationFn: (database: DatabaseSummary) =>
      api(`/api/databases/${database.id}/favorite`, {
        method: 'PUT',
        body: { favorite: !database.favorite },
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: listKey }),
        queryClient.invalidateQueries({ queryKey: ['home'] }),
      ]),
  });
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey }),
      queryClient.invalidateQueries({ queryKey: ['trash', 'databases'] }),
      queryClient.invalidateQueries({ queryKey: ['home'] }),
    ]);
  const restore = useMutation({
    mutationFn: (database: DatabaseSummary) => runDatabaseCommand(database.id, 'database.restore'),
    onSuccess: (_, { name }) => {
      toast.show({ title: t({ id: 'trash.restored', message: `Restored ${name}` }), tone: 'success' });
      return refresh();
    },
  });
  const trashDatabase = async (database: DatabaseSummary) => {
    await runDatabaseCommand(database.id, 'database.trash');
    await refresh();
    const { name } = database;
    toast.show({
      title: t({ id: 'home.deleted', message: `Deleted ${name}` }),
      tone: 'success',
      action: {
        label: t({ id: 'home.deleted.undo', message: 'Undo' }),
        onPress: () => restore.mutate(database),
      },
    });
  };
  const create = useMutation({
    mutationFn: async ({ values }: { values: NewDatabaseValues; folderId: string | null }) => {
      const { newDatabasePayload } = await recoverImport(() => import('./home/payload'));
      return api<DatabaseSchema>('/api/databases', {
        method: 'POST',
        body: newDatabasePayload(values, (descriptor) => i18n._(descriptor)),
      });
    },
    onSuccess: async (schema, { folderId }) => {
      await fileCreatedDatabase(schema.database.id, folderId);
      void queryClient.invalidateQueries({ queryKey: ['home'] });
      if (schema.tables?.length) observe('firstTable', 'you', true);
      void queryClient.invalidateQueries({ queryKey: listKey });
      setCreating(false);
      void navigate({ to: `/${schema.database.id}` });
    },
  });
  // Someone with no databases yet has no tables either, so a first table they make themselves
  // celebrates as they make it.  A database that arrives any other way (an import from another
  // service, a restore, or a share) uses it up, unless the person is in the middle of making one.
  const count = databases.data?.length;
  const making = creating || importing || create.isPending;
  useEffect(() => {
    if (count === 0) observe('firstTable', 'you', false);
    else if (count !== undefined && !making) retire('firstTable', 'you');
  }, [count, making, observe, retire]);
  const errorText = (error: Error | null) =>
    error
      ? message(
          error instanceof ApiError ? error.info.messageKey : 'errors.internal',
          error instanceof ApiError ? error.info.params : undefined,
        )
      : undefined;
  // The palette asks through the address which dialog to open.  The ask is answered on the render
  // that carries it, so opening doesn't wait on an effect, and the address is cleaned right after,
  // so a reload or a shared link doesn't ask again.  Remembering the answer is what lets the same
  // command be asked twice in a row.
  const asked = `${intent ?? ''}|${trashAsked ?? ''}`;
  const [answered, setAnswered] = useState('');
  if (answered !== asked) {
    setAnswered(asked);
    if (intent === 'database') setCreating(true);
    if (intent === 'import' || intent === 'photo') {
      setDocumentImport(intent === 'photo');
      setImporting(true);
    }
    if (intent === 'airtable') setAirtable(true);
    if ((IMPORT_PLATFORMS as readonly string[]).includes(intent ?? '')) setPlatform(intent as ImportPlatform);
    if (trashAsked === '1') setTrashOpen(true);
  }
  useEffect(() => {
    if (intent === undefined && trashAsked === undefined) return;
    void navigate({
      to: '.',
      replace: true,
      search: (previous: Record<string, unknown>) => {
        const { new: _intent, trash: _trash, ...rest } = previous;
        return rest;
      },
    });
  }, [intent, trashAsked, navigate]);
  return (
    <div className="rio-home-databases">
      <LevelSuggestion />
      <FolderHome databases={databases.data ?? []}>
        {(items, onMove, canCreate, initialLoading) => (
          <DatabaseList
            demoEmpty={Boolean(session?.demo && ['/', '/home', '/home/my'].includes(location.pathname))}
            onOpenShared={() => {
              void navigate({ to: '/home/$section', params: { section: 'shared' } });
            }}
            grouped={false}
            actionsDisabled={initialLoading}
            onMove={onMove}
            onTrash={() => setTrashOpen(true)}
            onFavorite={(database) => {
              if (!favorite.isPending) favorite.mutate(database);
            }}
            favoritePending={favorite.isPending ? favorite.variables.id : undefined}
            onDelete={(database) => {
              // The confirmation names the window the administrator chose, so read it first.
              void prefetchTrashWindow(queryClient, database.id).then(() => setDeleting(database));
            }}
            onDuplicate={session?.membership?.kind === 'guest' ? undefined : setDuplicating}
            databases={items}
            hrefFor={(id) => `/${id}`}
            onOpen={(id) => {
              void navigate({ to: `/${id}` });
            }}
            onPreload={(action) =>
              ({
                create: NewDatabaseDialog,
                file: NewDatabaseFromFile,
                airtable: AirtableImportDialog,
                platform: PlatformImportDialog,
                trash: DeletedDatabasesDialog,
              })[action].preload()
            }
            onCreate={
              canCreate
                ? () => {
                    create.reset();
                    setCreating(true);
                  }
                : undefined
            }
            onImport={canCreate && offers('home', 'import') ? () => setImporting(true) : undefined}
            onImportAirtable={
              canCreate && offers('home', 'importAirtable') ? () => setAirtable(true) : undefined
            }
            onImportPlatform={canCreate && platforms ? setPlatform : undefined}
            loading={databases.isPending || initialLoading}
            error={errorText(databases.error ?? favorite.error ?? restore.error)}
          />
        )}
      </FolderHome>
      {deleting && (
        <LazyBoundary size="dialog" onDismiss={() => setDeleting(null)}>
          <ConfirmDialog
            isOpen
            onOpenChange={(open) => {
              if (!open) setDeleting(null);
            }}
            title={t({ id: 'home.delete.title', message: `Delete ${deleting?.name ?? ''}?` })}
            message={t({
              id: 'home.delete.body',
              message: `It's deleted for everyone it's shared with.  You can restore it from the trash ${trash}.`,
            })}
            confirmLabel={t({ id: 'home.card.delete', message: 'Delete database' })}
            tone="danger"
            onConfirm={async () => {
              if (!deleting) return;
              try {
                await trashDatabase(deleting);
              } catch (error) {
                // The dialog stays open on failure, so say why before the person tries again.
                toast.show({ title: errorText(error instanceof Error ? error : null), tone: 'danger' });
                throw error;
              }
            }}
          />
        </LazyBoundary>
      )}
      {trashOpen && (
        <LazyBoundary size="dialog" onDismiss={() => setTrashOpen(false)}>
          <DeletedDatabasesDialog onClose={() => setTrashOpen(false)} />
        </LazyBoundary>
      )}
      {duplicating ? (
        <LazyBoundary size="dialog" onDismiss={() => setDuplicating(null)}>
          <DuplicateDialog
            databaseId={duplicating.id}
            databaseName={duplicating.name}
            onClose={() => setDuplicating(null)}
          />
        </LazyBoundary>
      ) : null}
      {creating ? (
        <LazyBoundary size="dialog" onDismiss={() => setCreating(false)}>
          <NewDatabaseDialog
            onSubmit={(values) => create.mutate({ values, folderId: databaseCreationFolder() })}
            onClose={() => {
              setCreating(false);
              // Whatever the last try left behind is gone by the time the dialog opens again.
              create.reset();
            }}
            isCreating={create.isPending}
            error={errorText(create.error)}
            canRemoveTemplates={isOrgAdmin(session)}
          />
        </LazyBoundary>
      ) : null}
      {airtable ? (
        <LazyBoundary size="dialog" onDismiss={() => setAirtable(false)}>
          <AirtableImportDialog
            onClose={() => {
              setAirtable(false);
              void queryClient.invalidateQueries({ queryKey: listKey });
            }}
            onOpen={(id) => {
              setAirtable(false);
              void queryClient.invalidateQueries({ queryKey: listKey });
              // The new database opens with the import's report over it.
              showReportWhenOpened(id);
              void navigate({ to: `/${id}` });
            }}
          />
        </LazyBoundary>
      ) : null}
      {platform ? (
        <LazyBoundary size="dialog" onDismiss={() => setPlatform(null)}>
          <PlatformImportDialog
            key={platform}
            platform={platform}
            onClose={() => {
              setPlatform(null);
              void queryClient.invalidateQueries({ queryKey: listKey });
            }}
            onOpen={(id) => {
              setPlatform(null);
              void queryClient.invalidateQueries({ queryKey: listKey });
              // The new database opens with the import's report over it.
              showReportWhenOpened(id);
              void navigate({ to: `/${id}` });
            }}
          />
        </LazyBoundary>
      ) : null}
      {importing ? (
        <LazyBoundary size="dialog" onDismiss={() => setImporting(false)}>
          <NewDatabaseFromFile
            documentImport={documentImport}
            onClose={() => setImporting(false)}
            onDone={(id) => {
              setImporting(false);
              void queryClient.invalidateQueries({ queryKey: listKey });
              void navigate({ to: `/${id}` });
            }}
          />
        </LazyBoundary>
      ) : null}
    </div>
  );
}
