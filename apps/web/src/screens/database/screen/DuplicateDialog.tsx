import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { LIMITS, newId, type CommandResult } from '@riosoma/contracts';
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
import type { DatabaseSession } from '../../../data';
import { api } from '../../../api';
import { useServerMessage } from '../../../messages/useServerMessage';
import { undoToast } from '../../../grid/view/actions';

export interface DuplicateDialogProps {
  kind: 'field' | 'table';
  id: string;
  name: string;
  existingNames: readonly string[];
  session: DatabaseSession;
  onClose(): void;
}

export function DuplicateDialog({
  kind,
  id,
  name: original,
  existingNames,
  session,
  onClose,
}: DuplicateDialogProps) {
  const { t } = useLingui();
  const message = useServerMessage();
  const [name, setName] = useState(() =>
    t({ id: 'duplicate.name.default', message: `${original} copy` }).slice(0, LIMITS.nameLength),
  );
  const [include, setInclude] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [jobId, setJobId] = useState<string>();
  const [progress, setProgress] = useState<{ copied: number; total: number }>();
  const taken = existingNames.some((existing) => existing.toLowerCase() === name.trim().toLowerCase());
  const title =
    kind === 'field'
      ? t({ id: 'duplicate.field.title', message: 'Duplicate field' })
      : t({ id: 'duplicate.table.title', message: 'Duplicate table' });
  async function submit() {
    if (pending || !name.trim() || taken) return;
    setPending(true);
    setError(undefined);
    setProgress(undefined);
    try {
      const action = session.run(
        [
          kind === 'field'
            ? {
                kind: 'field.duplicate',
                fieldId: id,
                newFieldId: newId('field'),
                name: name.trim(),
                withValues: include,
              }
            : {
                kind: 'table.duplicate',
                tableId: id,
                newTableId: newId('table'),
                name: name.trim(),
                withRecords: include,
              },
        ],
        { reportResults: true, handlesRefusal: true },
      );
      const result = await action.done;
      const answer = result.results?.[0];
      if (result.rejected) {
        setError(message(answer?.error?.messageKey ?? 'errors.internal', answer?.error?.params));
        return;
      }
      const job = answer?.output?.jobId;
      if (typeof job === 'string') {
        setJobId(job);
        for (;;) {
          const status = await api<{
            state: string;
            copied: number;
            total: number;
            result: CommandResult | null;
          }>(`/api/duplicate-jobs/${job}`);
          setProgress(status);
          if (status.state === 'finished') break;
          if (status.state !== 'running') {
            setError(
              message(
                status.result?.error?.messageKey ??
                  (status.state === 'canceled' ? 'duplicate.table.canceled' : 'errors.internal'),
              ),
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        session.adoptAction?.(action.groupId, { kind: 'table.duplicate', count: 1, name: original });
      }
      undoToast(
        session,
        kind === 'field'
          ? t({ id: 'duplicate.field.done', message: `Duplicated ${name}` })
          : t({ id: 'duplicate.table.done', message: `Duplicated ${name}` }),
        action.groupId,
      );
      onClose();
    } catch {
      setError(message('errors.internal'));
    } finally {
      setPending(false);
      setJobId(undefined);
    }
  }
  return (
    <Modal
      isOpen
      isDismissable={!pending}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>{title}</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <TextField
              autoFocus
              label={t({ id: 'duplicate.name', message: 'Name' })}
              value={name}
              onChange={setName}
              maxLength={LIMITS.nameLength}
              isDisabled={pending}
              errorMessage={
                taken ? t({ id: 'duplicate.name.taken', message: 'This name is already used.' }) : undefined
              }
              isInvalid={taken}
            />
            <Checkbox isSelected={include} onChange={setInclude} isDisabled={pending}>
              {kind === 'field'
                ? t({ id: 'duplicate.field.values', message: 'Copy field values' })
                : t({ id: 'duplicate.table.records', message: 'Include records' })}
            </Checkbox>
            {progress && (
              <p role="status" aria-live="polite">
                {t({
                  id: 'duplicate.table.progress',
                  message: `Copied ${progress.copied} of ${progress.total} records`,
                })}
              </p>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              isDisabled={pending && !jobId}
              onPress={() => {
                if (jobId)
                  void api(`/api/duplicate-jobs/${jobId}/cancel`, { method: 'POST' }).catch(() =>
                    setError(message('errors.internal')),
                  );
                else onClose();
              }}
            >
              {pending
                ? t({ id: 'duplicate.table.cancel', message: 'Cancel copy' })
                : t({ id: 'duplicate.cancel', message: 'Cancel' })}
            </Button>
            <Button
              type="submit"
              variant="primary"
              isPending={pending}
              isDisabled={pending || !name.trim() || taken}
            >
              {title}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>
    </Modal>
  );
}
