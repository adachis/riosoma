import { useSettingsSection } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import './public-sharing.css';
import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { newId, PublicSharingPolicy } from '@riosoma/contracts';
import { Spinner, Switch, TextField } from '@riosoma/ui';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'public-sharing',
  label: msg({ id: 'publicSharing.title', message: 'Public sharing' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.public-sharing',
    message: 'public sharing embedding files links expiry',
  }),
});

export function PublicSharingSettings() {
  const { t } = useLingui();
  const client = useQueryClient();
  const key = ['public-sharing-policy'];
  const [draft, setDraft] = useState<PublicSharingPolicy | null>(null);
  const [saved, setSaved] = useState(false);
  const read = useQuery({
    queryKey: key,
    queryFn: () => api<PublicSharingPolicy>('/api/admin/public-sharing'),
  });
  const save = useMutation({
    mutationFn: (policy: PublicSharingPolicy) =>
      api('/api/public-sharing/commands', {
        body: { id: newId('command'), action: { kind: 'policy', policy } },
      }),
    onSuccess: () => {
      setSaved(true);
      setDraft(null);
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const policy = draft ?? read.data;
  const pageDraft = useSettingsSection({
    dirty: JSON.stringify(policy) !== JSON.stringify(read.data),
    stored: read.data,
    discard: () => {
      setDraft(null);
      setSaved(false);
    },
    validate: () =>
      PublicSharingPolicy.safeParse(policy).success
        ? null
        : t({
            id: 'publicSharing.invalidLifetime',
            message: 'Use a file link lifetime from 60 to 604800 seconds.',
          }),
    save: async () => {
      if (policy) await save.mutateAsync(policy);
    },
  });
  if (!policy)
    return (
      <>
        <ErrorBanner error={errorInfo(read.error)} />
        {read.isPending && <Spinner />}
      </>
    );
  const change = (patch: Partial<PublicSharingPolicy>) => {
    setSaved(false);
    setDraft({ ...policy, ...patch });
  };
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'publicSharing.title', message: 'Public sharing' })}
    >
      {
        <form
          className="rio-public-sharing"
          onSubmit={(event) => {
            event.preventDefault();
            void pageDraft.save?.();
          }}
        >
          <ErrorBanner error={errorInfo(save.error)} />
          <Setting
            page={settingsPage}
            id="allow-embedding"
            label={msg({ id: 'publicSharing.allowEmbedding', message: 'Allow embedding public pages' })}
          >
            <Switch
              isSelected={policy.embeddingEnabled}
              isDisabled={save.isPending}
              onChange={(embeddingEnabled) => change({ embeddingEnabled })}
            >
              {t({ id: 'publicSharing.allowEmbedding', message: 'Allow embedding public pages' })}
            </Switch>
          </Setting>
          <Setting
            page={settingsPage}
            id="allow-files"
            label={msg({ id: 'publicSharing.allowFiles', message: 'Allow signed public file links' })}
            help={msg({
              id: 'publicSharing.filesHelp',
              message:
                'Files stay private unless this is on.  Turning it off stops public file links immediately.',
            })}
          >
            <Switch
              isSelected={policy.publicFiles}
              isDisabled={save.isPending}
              onChange={(publicFiles) => change({ publicFiles })}
            >
              {t({ id: 'publicSharing.allowFiles', message: 'Allow signed public file links' })}
            </Switch>
          </Setting>
          <p>
            {t({
              id: 'publicSharing.filesHelp',
              message:
                'Files stay private unless this is on.  Turning it off stops public file links immediately.',
            })}
          </p>
          <Setting
            page={settingsPage}
            id="lifetime"
            label={msg({ id: 'publicSharing.lifetime', message: 'File link lifetime in seconds' })}
            help={msg({
              id: 'publicSharing.lifetimeHelp',
              message: 'Use 60 to 604800 seconds.  The default is one hour.',
            })}
          >
            <TextField
              label={t({ id: 'publicSharing.lifetime', message: 'File link lifetime in seconds' })}
              type="number"
              value={String(policy.fileLifetimeSeconds)}
              aria-invalid={
                !PublicSharingPolicy.shape.fileLifetimeSeconds.safeParse(policy.fileLifetimeSeconds).success
              }
              onChange={(value) => change({ fileLifetimeSeconds: Number(value) })}
            />
          </Setting>
          <p>
            {t({
              id: 'publicSharing.lifetimeHelp',
              message: 'Use 60 to 604800 seconds.  The default is one hour.',
            })}
          </p>
          <p role="status">
            {saved ? t({ id: 'publicSharing.saved', message: 'Saved public sharing settings' }) : ''}
          </p>
        </form>
      }
    </Setting>
  );
}
