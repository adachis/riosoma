import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import {
  LIMITS,
  ARCHIVE_LIMITS,
  type Collaborator,
  type DatabaseCopy,
  type SnapshotMeta,
} from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Spinner,
  TextField,
  toast,
} from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { saveFile } from '../../screens/database/view/download';
import {
  deleteSnapshot,
  downloadSnapshot,
  listSnapshots,
  restoreSnapshot,
  snapshotsKey,
  takeSnapshot,
} from './api';
import { CopyProgress } from './CopyProgress';
import { anchor } from '../../demos/anchors';
import './archives.css';

type Step =
  { kind: 'list' } | { kind: 'restore'; snapshot: SnapshotMeta } | { kind: 'copy'; copy: DatabaseCopy };

/** A stored size in the reader's own units, like 12 KB or 3.4 MB. */
export function useSize(): (bytes: number) => string {
  const { i18n } = useLingui();
  return (bytes) => {
    const units = [
      ['byte', 1],
      ['kilobyte', 1024],
      ['megabyte', 1024 ** 2],
      ['gigabyte', 1024 ** 3],
    ] as const;
    const [unit, size] = [...units].reverse().find(([, step]) => bytes >= step) ?? units[0];
    return new Intl.NumberFormat(i18n.locale || 'en-US', {
      style: 'unit',
      unit,
      unitDisplay: 'short',
      maximumFractionDigits: unit === 'byte' ? 0 : 1,
    }).format(bytes / size);
  };
}

/**
 * A database's snapshots: taking one with a name, and downloading, restoring as a new database, or
 * deleting the ones already taken.  Automatic snapshots show beside the ones people took.
 */
export function SnapshotsDialog({
  databaseId,
  databaseName,
  people,
  onClose,
}: {
  databaseId: string;
  databaseName: string;
  /** The organization's people by ID, for who took each snapshot */
  people: ReadonlyMap<string, Pick<Collaborator, 'name'>>;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const message = useServerMessage();
  const size = useSize();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ kind: 'list' });
  const [name, setName] = useState('');
  const [restoreName, setRestoreName] = useState('');
  const [deleting, setDeleting] = useState<SnapshotMeta | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [finishedId, setFinishedId] = useState<string | null>(null);
  const snapshots = useQuery({
    queryKey: snapshotsKey(databaseId),
    queryFn: ({ signal }) => listSnapshots(databaseId, signal),
  });
  const refresh = () => client.invalidateQueries({ queryKey: snapshotsKey(databaseId) });
  const take = useMutation({
    mutationFn: () => takeSnapshot(databaseId, name.trim()),
    onSuccess: async (snapshot) => {
      setName('');
      toast.show({
        title: t({ id: 'archives.snapshot.taken', message: `Took the snapshot ${snapshot.name}` }),
        tone: 'success',
      });
      await refresh();
    },
  });
  const restore = useMutation({
    mutationFn: (snapshot: SnapshotMeta) => restoreSnapshot(snapshot.id, restoreName.trim()),
    onSuccess: (copy) => setStep({ kind: 'copy', copy }),
  });
  const errorText = (error: unknown) =>
    message(
      error instanceof ApiError ? error.info.messageKey : 'errors.internal',
      error instanceof ApiError ? error.info.params : undefined,
    );
  const label = (snapshot: SnapshotMeta) =>
    snapshot.kind === 'automatic'
      ? t({
          id: 'archives.snapshot.automatic',
          message: `Automatic snapshot, ${i18n.date(new Date(snapshot.createdAt), { dateStyle: 'medium' })}`,
        })
      : snapshot.name;
  const download = async (snapshot: SnapshotMeta) => {
    if (downloading) return;
    setDownloading(snapshot.id);
    try {
      const file = await downloadSnapshot(snapshot.id);
      saveFile(file.blob, file.filename ?? `${snapshot.id}.riosoma.json`);
    } catch (error) {
      toast.show({ tone: 'danger', title: errorText(error) });
    } finally {
      setDownloading(null);
    }
  };
  const startRestore = (snapshot: SnapshotMeta) => {
    restore.reset();
    const suffix = t({ id: 'archives.restore.suffix', message: '(restored)' });
    setRestoreName(`${databaseName.slice(0, LIMITS.nameLength - suffix.length - 1)} ${suffix}`);
    setStep({ kind: 'restore', snapshot });
  };
  const submitTake = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || take.isPending) return;
    take.mutate();
  };

  let body;
  if (step.kind === 'copy') {
    body = (
      <>
        <DialogBody className="rio-archives">
          <CopyProgress
            copy={step.copy}
            onChange={(copy) => {
              if (copy.state === 'finished' && copy.databaseId) {
                setFinishedId(copy.databaseId);
                void client.invalidateQueries({ queryKey: ['databases'] });
              }
            }}
          />
        </DialogBody>
        <DialogFooter>
          <Button onPress={() => setStep({ kind: 'list' })}>
            <Trans id="archives.snapshots.back">Back to snapshots</Trans>
          </Button>
          <Button
            variant="primary"
            isDisabled={!finishedId}
            onPress={() => {
              if (!finishedId) return;
              onClose();
              void navigate({ to: `/${finishedId}` });
            }}
          >
            <Trans id="archives.copy.open">Open the new database</Trans>
          </Button>
        </DialogFooter>
      </>
    );
  } else if (step.kind === 'restore') {
    const snapshot = step.snapshot;
    body = (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!restoreName.trim() || restore.isPending) return;
          restore.mutate(snapshot);
        }}
      >
        <DialogBody className="rio-archives">
          <p>
            {t({
              id: 'archives.restore.explain',
              message: `Restoring ${label(snapshot)} makes a new database from it.  This database stays as it is.`,
            })}
          </p>
          <TextField
            label={t({ id: 'archives.restore.name', message: 'New database name' })}
            value={restoreName}
            onChange={setRestoreName}
            maxLength={LIMITS.nameLength}
            isRequired
            isDisabled={restore.isPending}
          />
          {restore.error ? <Banner tone="danger">{errorText(restore.error)}</Banner> : null}
        </DialogBody>
        <DialogFooter>
          <Button onPress={() => setStep({ kind: 'list' })} isDisabled={restore.isPending}>
            <Trans id="home.dialog.cancel">Cancel</Trans>
          </Button>
          <Button
            type="submit"
            variant="primary"
            isPending={restore.isPending}
            isDisabled={!restoreName.trim()}
          >
            <Trans id="archives.restore.start">Restore as a new database</Trans>
          </Button>
        </DialogFooter>
      </form>
    );
  } else {
    const list = snapshots.data?.snapshots ?? [];
    body = (
      <DialogBody className="rio-archives">
        <p className="rio-archives__note">
          {t({
            id: 'archives.snapshots.intro',
            message:
              'A snapshot keeps the whole database as it is now: its tables, records, files, views, and everything else.  Restoring one makes a new database, so nothing here changes.',
          })}
        </p>
        <form className="rio-archives__take" onSubmit={submitTake}>
          <TextField
            label={t({ id: 'archives.snapshot.name', message: 'Snapshot name' })}
            {...anchor('archives.snapshot.name')}
            value={name}
            onChange={setName}
            maxLength={ARCHIVE_LIMITS.snapshotName}
            isDisabled={take.isPending}
          />
          <Button
            type="submit"
            variant="primary"
            isPending={take.isPending}
            isDisabled={!name.trim()}
            {...anchor('archives.snapshot.take')}
          >
            <Trans id="archives.snapshot.take">Take a snapshot</Trans>
          </Button>
        </form>
        {take.error ? <Banner tone="danger">{errorText(take.error)}</Banner> : null}
        {snapshots.error ? <Banner tone="danger">{errorText(snapshots.error)}</Banner> : null}
        {snapshots.isPending ? (
          <Spinner label={t({ id: 'archives.snapshots.loading', message: 'Loading snapshots' })} size="sm" />
        ) : list.length === 0 ? (
          <p>
            <Trans id="archives.snapshots.empty">No snapshots yet.</Trans>
          </p>
        ) : (
          <ul
            className="rio-archives__list"
            aria-label={t({ id: 'archives.snapshots.title', message: 'Snapshots' })}
          >
            {list.map((snapshot) => {
              const person = snapshot.createdBy ? people.get(snapshot.createdBy)?.name : undefined;
              const when = i18n.date(new Date(snapshot.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              });
              const records = snapshot.records;
              const menu = t({ id: 'archives.snapshot.menu', message: `More for ${label(snapshot)}` });
              return (
                <li key={snapshot.id} className="rio-archives__item">
                  <div className="rio-archives__text">
                    <strong>{label(snapshot)}</strong>
                    <span className="rio-archives__meta">
                      <span>
                        {person ? t({ id: 'archives.snapshot.by', message: `${when} by ${person}` }) : when}
                      </span>
                      <span>
                        {t({
                          id: 'archives.snapshot.records',
                          message: plural(records, { one: '# record', other: '# records' }),
                        })}
                      </span>
                      <span>{size(snapshot.size)}</span>
                    </span>
                  </div>
                  <MenuTrigger>
                    <Button
                      variant="quiet"
                      size="sm"
                      icon={faEllipsis}
                      aria-label={menu}
                      isPending={downloading === snapshot.id}
                    />
                    <Menu aria-label={menu}>
                      <MenuItem onAction={() => void download(snapshot)}>
                        {t({ id: 'archives.snapshot.download', message: 'Download' })}
                      </MenuItem>
                      <MenuItem onAction={() => startRestore(snapshot)}>
                        {t({ id: 'archives.snapshot.restore', message: 'Restore as a new database' })}
                      </MenuItem>
                      <MenuItem tone="danger" onAction={() => setDeleting(snapshot)}>
                        {t({ id: 'archives.snapshot.delete', message: 'Delete snapshot' })}
                      </MenuItem>
                    </Menu>
                  </MenuTrigger>
                </li>
              );
            })}
          </ul>
        )}
      </DialogBody>
    );
  }

  return (
    <>
      <Modal
        isOpen
        isDismissable
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Dialog>
          <DialogTitle>
            <Trans id="archives.snapshots.title">Snapshots</Trans>
          </DialogTitle>
          {body}
        </Dialog>
      </Modal>
      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t({ id: 'archives.delete.title', message: `Delete ${deleting ? label(deleting) : ''}?` })}
        message={t({
          id: 'archives.delete.body',
          message: 'A deleted snapshot is gone for good.  The database itself doesn’t change.',
        })}
        confirmLabel={t({ id: 'archives.snapshot.delete', message: 'Delete snapshot' })}
        tone="danger"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await deleteSnapshot(deleting.id);
            await refresh();
          } catch (error) {
            toast.show({ title: errorText(error), tone: 'danger' });
            throw error;
          }
        }}
      />
    </>
  );
}
