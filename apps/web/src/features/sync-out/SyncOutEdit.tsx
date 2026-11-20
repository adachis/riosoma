import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import {
  LIMITS,
  SYNC_OUT_INTERVALS,
  type OutboundSync,
  type OutboundSyncUpdate,
  type SyncOutInterval,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  DialogBody,
  DialogFooter,
  Form,
  ListBoxItem,
  Select,
  TextField,
} from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../messages/errorInfo';
import { useSyncOutWords } from './words';

/** Settings a sync's creator can change: its name, schedule, and whether leaving rows are removed. */
export function SyncOutEdit({
  sync,
  save,
  onPending,
  onCancel,
  onSaved,
}: {
  sync: OutboundSync;
  save(syncId: string, update: OutboundSyncUpdate): Promise<OutboundSync>;
  onPending(pending: boolean): void;
  onCancel(): void;
  onSaved(sync: OutboundSync): void;
}) {
  const { t } = useLingui();
  const words = useSyncOutWords();
  const [name, setName] = useState(sync.name);
  const [everyMinutes, setEveryMinutes] = useState<SyncOutInterval | null>(sync.settings.everyMinutes);
  const [removeMissing, setRemoveMissing] = useState(sync.settings.removeMissing);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const where =
    sync.destination.kind === 'airtable'
      ? t({
          id: 'syncOut.where.airtable',
          message: `${sync.destination.table.name} in ${sync.destination.baseName}, Airtable`,
        })
      : t({ id: 'syncOut.where.smartsheet', message: `${sync.destination.table.name}, Smartsheet` });

  function diff(): OutboundSyncUpdate {
    const update: OutboundSyncUpdate = {};
    if (name.trim() !== sync.name) update.name = name.trim();
    if (everyMinutes !== sync.settings.everyMinutes) update.everyMinutes = everyMinutes;
    if (removeMissing !== sync.settings.removeMissing) update.removeMissing = removeMissing;
    return update;
  }

  async function onSubmit() {
    if (name.trim().length === 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError(null);
    onPending(true);
    try {
      const saved = await save(sync.id, diff());
      onSaved(saved);
    } catch (thrown) {
      setError(thrown);
    } finally {
      setSaving(false);
      onPending(false);
    }
  }

  return (
    <Form
      className="rio-sync-out__form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      <DialogBody className="rio-sync-out" aria-busy={saving}>
        <ErrorBanner error={errorInfo(error)} />
        <div className="rio-sync-out__fixed">
          <p className="rio-sync-out__field-label">
            {t({ id: 'syncOut.edit.destination', message: 'Goes to' })}
          </p>
          <p>{where}</p>
          <p className="rio-sync-out__note">
            {t({
              id: 'syncOut.edit.fixed',
              message: 'To send to another place or use another token, delete this sync and set it up again.',
            })}
          </p>
        </div>
        <TextField
          label={t({ id: 'syncOut.form.name', message: 'Name' })}
          description={t({ id: 'syncOut.form.name.help', message: 'Shown in this list and in history.' })}
          value={name}
          maxLength={LIMITS.nameLength}
          isDisabled={saving}
          isInvalid={showErrors && name.trim().length === 0}
          errorMessage={
            showErrors && name.trim().length === 0
              ? t({ id: 'syncOut.setup.error.name', message: 'Give this sync a name.' })
              : undefined
          }
          onChange={setName}
        />
        <Select
          label={t({ id: 'syncOut.form.schedule', message: 'Schedule' })}
          description={t({
            id: 'syncOut.form.schedule.help',
            message: 'Riosoma also syncs whenever someone chooses Sync now.',
          })}
          selectedKey={everyMinutes === null ? 'manual' : String(everyMinutes)}
          isDisabled={saving}
          onSelectionChange={(key) =>
            setEveryMinutes(key === 'manual' ? null : (Number(key) as SyncOutInterval))
          }
        >
          <ListBoxItem id="manual">{words.interval(null)}</ListBoxItem>
          {SYNC_OUT_INTERVALS.map((value) => (
            <ListBoxItem key={value} id={String(value)}>
              {words.interval(value)}
            </ListBoxItem>
          ))}
        </Select>
        <Checkbox
          isSelected={removeMissing}
          isDisabled={saving}
          onChange={setRemoveMissing}
          description={t({
            id: 'syncOut.form.removeMissing.help',
            message:
              'When a record is deleted or stops matching the view’s filters, its row is removed there too.',
          })}
        >
          {t({ id: 'syncOut.form.removeMissing', message: 'Remove rows that leave the view' })}
        </Checkbox>
      </DialogBody>
      <DialogFooter>
        <Button isDisabled={saving} onPress={onCancel}>
          {t({ id: 'syncOut.setup.back', message: 'Back' })}
        </Button>
        <Button type="submit" variant="primary" isPending={saving}>
          {t({ id: 'syncOut.edit.save', message: 'Save' })}
        </Button>
      </DialogFooter>
    </Form>
  );
}
