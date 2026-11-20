import { Trans, useLingui } from '@lingui/react/macro';
import { LIMITS, type DatabaseCopy } from '@riosoma/contracts';
import {
  Banner,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  Modal,
  TextField,
} from '@riosoma/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { duplicateDatabase } from './api';
import { CopyProgress } from './CopyProgress';
import './archives.css';

/**
 * Duplicates a database as a new one, with its records or with only its tables, fields, views,
 * and the rest.  The copy runs in the background, so the dialog can close while it works.
 */
export function DuplicateDialog({
  databaseId,
  databaseName,
  onClose,
}: {
  databaseId: string;
  databaseName: string;
  onClose(): void;
}) {
  const { t } = useLingui();
  const message = useServerMessage();
  const client = useQueryClient();
  const navigate = useNavigate();
  const suffix = t({ id: 'archives.duplicate.suffix', message: 'copy' });
  const [name, setName] = useState(
    `${databaseName.slice(0, LIMITS.nameLength - suffix.length - 1)} ${suffix}`,
  );
  const [withRecords, setWithRecords] = useState(true);
  const [copy, setCopy] = useState<DatabaseCopy | null>(null);
  const [finishedId, setFinishedId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => duplicateDatabase(databaseId, name.trim(), withRecords),
    onSuccess: setCopy,
  });
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
          {t({ id: 'archives.duplicate.title', message: `Duplicate ${databaseName}` })}
        </DialogTitle>
        {copy ? (
          <>
            <DialogBody className="rio-archives">
              <CopyProgress
                copy={copy}
                onChange={(next) => {
                  if (next.state === 'finished' && next.databaseId) {
                    setFinishedId(next.databaseId);
                    void client.invalidateQueries({ queryKey: ['databases'] });
                  }
                }}
              />
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose}>
                <Trans id="archives.close">Close</Trans>
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
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!name.trim() || start.isPending) return;
              start.mutate();
            }}
          >
            <DialogBody className="rio-archives">
              <TextField
                label={t({ id: 'archives.restore.name', message: 'New database name' })}
                value={name}
                onChange={setName}
                maxLength={LIMITS.nameLength}
                isRequired
                isDisabled={start.isPending}
              />
              <Checkbox isSelected={withRecords} onChange={setWithRecords} isDisabled={start.isPending}>
                {t({ id: 'archives.duplicate.records', message: 'Include records, files, and comments' })}
              </Checkbox>
              <p className="rio-archives__note">
                {t({
                  id: 'archives.duplicate.note',
                  message:
                    'The copy is yours alone at first.  Its automations start turned off, and its views have no shared links.',
                })}
              </p>
              {start.error ? (
                <Banner tone="danger">
                  {message(
                    start.error instanceof ApiError ? start.error.info.messageKey : 'errors.internal',
                    start.error instanceof ApiError ? start.error.info.params : undefined,
                  )}
                </Banner>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button onPress={onClose} isDisabled={start.isPending}>
                <Trans id="home.dialog.cancel">Cancel</Trans>
              </Button>
              <Button type="submit" variant="primary" isPending={start.isPending} isDisabled={!name.trim()}>
                <Trans id="archives.duplicate.start">Duplicate</Trans>
              </Button>
            </DialogFooter>
          </form>
        )}
      </Dialog>
    </Modal>
  );
}
