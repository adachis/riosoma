import { useSettingsSection } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useLingui } from '@lingui/react/macro';
import { ARCHIVE_LIMITS, type SnapshotSettings as Settings } from '@riosoma/contracts';
import { Banner, NumberField, Spinner, Switch, toast } from '@riosoma/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError } from '../../api';
import { useServerMessage } from '../../messages/useServerMessage';
import { loadSnapshotSettings, saveSnapshotSettings, snapshotSettingsKey } from './api';
import './archives.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'snapshots',
  label: msg({ id: 'settings.nav.snapshots', message: 'Snapshots' }),
  roles: ['admin'],
  keywords: msg({
    id: 'settings.search.keywords.snapshots',
    message: 'snapshots backups retention days weeks',
  }),
});

/** The organization's automatic snapshots: whether they're taken, and how many are kept. */
export function SnapshotSettings() {
  const { t } = useLingui();
  const settings = useQuery({
    queryKey: snapshotSettingsKey,
    queryFn: ({ signal }) => loadSnapshotSettings(signal),
  });
  if (settings.isPending)
    return (
      <Spinner
        label={t({ id: 'archives.settings.loading', message: 'Loading snapshot settings' })}
        size="sm"
      />
    );
  if (!settings.data) return <SettingsError error={settings.error} />;
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'settings.nav.snapshots', message: 'Snapshots' })}
    >
      {<SettingsForm initial={settings.data} />}
    </Setting>
  );
}

function SettingsError({ error }: { error: unknown }) {
  const message = useServerMessage();
  return (
    <Banner tone="danger">
      {message(
        error instanceof ApiError ? error.info.messageKey : 'errors.internal',
        error instanceof ApiError ? error.info.params : undefined,
      )}
    </Banner>
  );
}

function SettingsForm({ initial }: { initial: Settings }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const [automatic, setAutomatic] = useState(initial.automatic);
  const [keepDaily, setKeepDaily] = useState(initial.keepDaily);
  const [keepWeekly, setKeepWeekly] = useState(initial.keepWeekly);
  const save = useMutation({
    mutationFn: () =>
      saveSnapshotSettings({
        automatic,
        keepDaily: Number.isFinite(keepDaily) ? keepDaily : initial.keepDaily,
        keepWeekly: Number.isFinite(keepWeekly) ? keepWeekly : initial.keepWeekly,
      }),
    onSuccess: async (saved) => {
      client.setQueryData(snapshotSettingsKey, saved);
      toast.show({
        title: t({ id: 'archives.settings.saved', message: 'Snapshot settings saved' }),
        tone: 'success',
      });
    },
  });
  const pageDraft = useSettingsSection({
    dirty:
      JSON.stringify([automatic, keepDaily, keepWeekly]) !==
      JSON.stringify([initial.automatic, initial.keepDaily, initial.keepWeekly]),
    stored: initial,
    discard: () => {
      setAutomatic(initial.automatic);
      setKeepDaily(initial.keepDaily);
      setKeepWeekly(initial.keepWeekly);
    },
    save: () => save.mutateAsync(),
  });
  return (
    <form
      className="rio-archives rio-archives__settings"
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <p className="rio-archives__note">
        {t({
          id: 'archives.settings.intro',
          message:
            'Every day, each database that changed the day before gets an automatic snapshot.  People who can change a database’s tables and fields find its snapshots in the database’s settings menu, where they can take their own too.  Snapshots people take themselves stay until someone deletes them.',
        })}
      </p>
      <Setting
        page={settingsPage}
        id="automatic"
        label={msg({ id: 'archives.settings.automatic', message: 'Take automatic snapshots' })}
        help={msg({
          id: 'archives.settings.intro',
          message:
            'Every day, each database that changed the day before gets an automatic snapshot.  People who can change a database’s tables and fields find its snapshots in the database’s settings menu, where they can take their own too.  Snapshots people take themselves stay until someone deletes them.',
        })}
      >
        <Switch isSelected={automatic} onChange={setAutomatic}>
          {t({ id: 'archives.settings.automatic', message: 'Take automatic snapshots' })}
        </Switch>
      </Setting>
      <Setting
        page={settingsPage}
        id="daily"
        label={msg({ id: 'archives.settings.daily', message: 'Days to keep' })}
        help={msg({
          id: 'archives.settings.dailyHelp',
          message: 'The newest automatic snapshot of each of this many days stays.',
        })}
      >
        <NumberField
          label={t({ id: 'archives.settings.daily', message: 'Days to keep' })}
          description={t({
            id: 'archives.settings.dailyHelp',
            message: 'The newest automatic snapshot of each of this many days stays.',
          })}
          value={keepDaily}
          onChange={setKeepDaily}
          minValue={1}
          maxValue={ARCHIVE_LIMITS.keepDaily}
          step={1}
          isDisabled={!automatic}
        />
      </Setting>
      <Setting
        page={settingsPage}
        id="weekly"
        label={msg({ id: 'archives.settings.weekly', message: 'Weeks to keep' })}
        help={msg({
          id: 'archives.settings.weeklyHelp',
          message: 'Also the newest automatic snapshot of each of this many weeks, including this one.',
        })}
      >
        <NumberField
          label={t({ id: 'archives.settings.weekly', message: 'Weeks to keep' })}
          description={t({
            id: 'archives.settings.weeklyHelp',
            message: 'Also the newest automatic snapshot of each of this many weeks, including this one.',
          })}
          value={keepWeekly}
          onChange={setKeepWeekly}
          minValue={0}
          maxValue={ARCHIVE_LIMITS.keepWeekly}
          step={1}
          isDisabled={!automatic}
        />
      </Setting>
      {save.error ? <SettingsError error={save.error} /> : null}
      <div></div>
    </form>
  );
}
