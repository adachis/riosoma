import { useSettingsDraft } from './SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from './Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FileSettings as FileSettingsContract,
  type FileSettingsView,
  type OrganizationCommandResult,
} from '@riosoma/contracts';
import { Form, Spinner, Text, TextField } from '@riosoma/ui';
import { useState } from 'react';
import { api } from '../../api';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../setup/useSetup';
import { FileScannerControls } from '../../features/files/FileScannerControls';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'files',
  label: msg({ id: 'files.settings.title', message: 'File uploads' }),
  roles: ['security'],
  keywords: msg({ id: 'settings.search.keywords.files', message: 'files uploads size limit bytes' }),
});

const settingsQuery = {
  queryKey: ['organization', 'files'],
  queryFn: () => api<FileSettingsView>('/api/org/files'),
};

export function FileSettings() {
  const settings = useQuery(settingsQuery);
  if (settings.isPending) return <Spinner />;
  if (settings.isError) return <ErrorBanner error={errorInfo(settings.error)} />;
  return (
    <div className="rio-admin-panel">
      <Setting
        page={settingsPage}
        id="overview"
        label={msg({ id: 'files.settings.title', message: 'File uploads' })}
        help={msg({
          id: 'files.settings.description',
          message:
            'Leave the limit blank to allow files of any size. A limit applies to new uploads and uploads being resumed in every storage location.',
        })}
      >
        <FileSettingsForm initial={settings.data} />
      </Setting>
      <FileScannerControls />
    </div>
  );
}

function FileSettingsForm({ initial }: { initial: FileSettingsView }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const [invalid, setInvalid] = useState(false);
  const [savedLimit, setSavedLimit] = useState<number | null | undefined>(undefined);
  const save = useMutation({
    mutationFn: (settings: FileSettingsView) =>
      api<OrganizationCommandResult>('/api/org/admin-commands', {
        body: { kind: 'organization.files', ...settings },
      }),
    onSuccess: async (result, submitted) => {
      client.setQueryData(settingsQuery.queryKey, result.fileSettings);
      await client.invalidateQueries({ queryKey: settingsQuery.queryKey });
      setSavedLimit(submitted.maxUploadBytes);
    },
  });
  const pageDraft = useSettingsDraft(
    initial.maxUploadBytes?.toString() ?? '',
    async (value, version) => {
      setSavedLimit(undefined);
      return save.mutateAsync({
        maxUploadBytes: value.trim() === '' ? null : Number(value),
        revision: version as string,
      });
    },
    {
      version: initial.revision,
      savedVersion: (result) => (result as OrganizationCommandResult).fileSettings?.revision,
      reconcile: (current, submitted, result) =>
        current === submitted
          ? ((result as OrganizationCommandResult).fileSettings?.maxUploadBytes?.toString() ?? '')
          : current,
      validate: (value) => {
        const valid = FileSettingsContract.safeParse({
          maxUploadBytes: value.trim() === '' ? null : Number(value),
        }).success;
        setInvalid(!valid);
        return valid
          ? null
          : t({
              id: 'files.settings.invalid',
              message: 'Enter a positive whole number of bytes, or leave this blank.',
            });
      },
    },
  );
  const value = pageDraft.value;
  const maxUploadBytes = value.trim() === '' ? null : Number(value);
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = FileSettingsContract.safeParse({ maxUploadBytes });
        setInvalid(!parsed.success);
        setSavedLimit(undefined);
        void pageDraft.save?.();
      }}
    >
      <Text>
        <Trans id="files.settings.description">
          Leave the limit blank to allow files of any size. A limit applies to new uploads and uploads being
          resumed in every storage location.
        </Trans>
      </Text>
      <Setting
        page={settingsPage}
        id="max-upload-bytes"
        label={msg({ id: 'files.settings.maxUploadBytes', message: 'Maximum upload size (bytes)' })}
        help={msg({ id: 'files.settings.noCap', message: 'Blank means no cap.' })}
      >
        <TextField
          label={t({ id: 'files.settings.maxUploadBytes', message: 'Maximum upload size (bytes)' })}
          description={t({ id: 'files.settings.noCap', message: 'Blank means no cap.' })}
          inputMode="numeric"
          value={value}
          onChange={(next) => {
            pageDraft.setValue(next);
            setInvalid(false);
            setSavedLimit(undefined);
          }}
          isInvalid={invalid && pageDraft.dirty}
          errorMessage={t({
            id: 'files.settings.invalid',
            message: 'Enter a positive whole number of bytes, or leave this blank.',
          })}
        />
      </Setting>
      <ErrorBanner error={errorInfo(save.error)} />
      <div role="status">
        {!save.isPending && savedLimit !== undefined && savedLimit === maxUploadBytes ? (
          <Trans id="files.settings.saved">Upload limit saved.</Trans>
        ) : null}
      </div>
    </Form>
  );
}
