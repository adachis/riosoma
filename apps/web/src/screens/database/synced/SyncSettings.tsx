import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import {
  removesMissing,
  supportsLive,
  type Freshness,
  type SourceKind,
  type TableSourceSettings,
  type TableMeta,
} from '@riosoma/contracts';
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogTitle,
  ListBoxItem,
  Modal,
  NumberField,
  Radio,
  RadioGroup,
  Select,
} from '@riosoma/ui';
import type { DatabaseSession } from '../../../data';
import { reportError } from '../../../grid/view/actions';
import './synced.css';

type Settings = Pick<
  TableSourceSettings,
  'everyMinutes' | 'allowOverrides' | 'holdAboveDeleteShare' | 'freshness' | 'removeMissing'
>;

/** Offers live reads only where the source answers a filtered, sorted page itself. */
export function FreshnessChoice({
  value,
  kind,
  onChange,
}: {
  value: Freshness;
  kind: SourceKind | undefined;
  onChange(value: Freshness): void;
}) {
  const { t } = useLingui();
  const live = kind !== undefined && supportsLive(kind);
  return (
    <RadioGroup
      label={t({ id: 'synced.freshness', message: 'Freshness' })}
      value={value}
      onChange={(next) => onChange(next === 'live' ? 'live' : 'copy')}
      description={
        live
          ? undefined
          : t({
              id: 'synced.freshness.liveKinds',
              message:
                'This source syncs on a schedule.  A live read needs a source that answers a filtered, sorted page: a SQL database, a document service, or a search engine.',
            })
      }
    >
      <Radio
        value="copy"
        description={t({
          id: 'synced.freshness.copyHelp',
          message:
            'Keeps a copy here that syncs on a schedule.  Everything works, even when the source is down.',
        })}
      >
        <Trans id="synced.freshness.copy">Copy</Trans>
      </Radio>
      <Radio
        value="live"
        isDisabled={!live}
        description={t({
          id: 'synced.freshness.liveHelp',
          message:
            'Reads the source whenever someone opens the table, for tables too big or too busy to copy.  Links, lookups, rollups, and formulas aren’t available.',
        })}
      >
        <Trans id="synced.freshness.live">Live</Trans>
      </Radio>
    </RadioGroup>
  );
}

/** A feed's items stay when they scroll out of it, unless someone asks for them to go. */
export function RemoveMissing({ value, onChange }: { value: boolean; onChange(value: boolean): void }) {
  const { t } = useLingui();
  return (
    <Checkbox isSelected={value} onChange={onChange}>
      {t({ id: 'synced.feed.removeMissing', message: 'Remove items that leave the feed' })}
    </Checkbox>
  );
}

export function Schedule({
  value,
  kind,
  onChange,
}: {
  value: Settings;
  kind?: SourceKind | undefined;
  onChange(value: Settings): void;
}) {
  const { t } = useLingui();
  return (
    <>
      {kind === 'webhook' && (
        <p className="rio-synced-note">
          {t({
            id: 'synced.webhook.schedule',
            message:
              'Posts are written as they arrive, as the person who makes this table, so it has no schedule.',
          })}
        </p>
      )}
      {/*
        Plain text options give each one a text value, so the closed select shows just the chosen
        label rather than the option's whole row, which is taller than the field and gets cut off.
        A live table has nothing to sync, so it has no schedule, and neither does a webhook's.
      */}
      {value.freshness !== 'live' && kind !== 'webhook' && (
        <Select
          label={t({ id: 'synced.wizard.every', message: 'Sync' })}
          selectedKey={String(value.everyMinutes)}
          onSelectionChange={(key) =>
            onChange({ ...value, everyMinutes: key === 'null' ? null : Number(key) })
          }
        >
          <ListBoxItem id="15">{t({ id: 'synced.every.15', message: 'Every 15 minutes' })}</ListBoxItem>
          <ListBoxItem id="60">{t({ id: 'synced.every.60', message: 'Every hour' })}</ListBoxItem>
          <ListBoxItem id="360">{t({ id: 'synced.every.360', message: 'Every 6 hours' })}</ListBoxItem>
          <ListBoxItem id="1440">{t({ id: 'synced.every.1440', message: 'Every day' })}</ListBoxItem>
          <ListBoxItem id="null">{t({ id: 'synced.every.manual', message: 'Only when asked' })}</ListBoxItem>
        </Select>
      )}
      <Checkbox
        isSelected={value.allowOverrides}
        onChange={(allowOverrides) => onChange({ ...value, allowOverrides })}
      >
        <Trans id="synced.wizard.overrides">Let people change source values here</Trans>
      </Checkbox>
    </>
  );
}
export function SyncSettings({
  table,
  session,
  onClose,
}: {
  table: TableMeta;
  session: DatabaseSession;
  onClose(): void;
}) {
  const { t, i18n } = useLingui();
  const [settings, setSettings] = useState<Settings>(table.source!);
  const [pending, setPending] = useState(false);
  const kind = table.source!.sourceKind;
  const percent = new Intl.NumberFormat(i18n.locale, { style: 'percent' }).format(
    settings.holdAboveDeleteShare,
  );
  async function save() {
    setPending(true);
    try {
      const result = await session.run([{ kind: 'table.updateSource', tableId: table.id, settings }]).done;
      if (!result.rejected) onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog>
        <DialogTitle>
          <Trans id="synced.settings">Sync settings</Trans>
        </DialogTitle>
        <DialogBody className="rio-synced-body">
          <div className="rio-synced-form">
            {kind !== 'webhook' && (
              <FreshnessChoice
                value={settings.freshness}
                kind={kind}
                onChange={(freshness) => setSettings({ ...settings, freshness })}
              />
            )}
            {table.source!.status.switchingToCopy && settings.freshness === 'copy' && (
              <p className="rio-synced-note">
                {t({
                  id: 'synced.freshness.switching',
                  message:
                    'Switching to Copy.  The table reads its source live until its first sync finishes.',
                })}
              </p>
            )}
            <Schedule value={settings} kind={kind} onChange={setSettings} />
            {kind === 'feed' && (
              <RemoveMissing
                value={removesMissing(settings, kind)}
                onChange={(removeMissing) => setSettings({ ...settings, removeMissing })}
              />
            )}
            {settings.freshness !== 'live' && removesMissing(settings, kind) && kind !== 'webhook' && (
              <NumberField
                label={t({
                  id: 'synced.settings.hold',
                  message: 'Wait for a person before removing more than',
                })}
                minValue={0}
                maxValue={100}
                value={settings.holdAboveDeleteShare * 100}
                onChange={(value) => {
                  if (Number.isFinite(value)) setSettings({ ...settings, holdAboveDeleteShare: value / 100 });
                }}
                description={t({ id: 'synced.settings.holdShare', message: `${percent} of the records` })}
              />
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="primary"
            isPending={pending}
            onPress={() => {
              void save();
            }}
          >
            <Trans id="field.dialog.save">Save</Trans>
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
