import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileSafetySettings } from '@riosoma/contracts';
import { Checkbox, Heading, ListBoxItem, Select, Text } from '@riosoma/ui';
import { useState } from 'react';
import { api } from '../../api';
import { errorInfo } from '../../screens/setup/useSetup';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { useSettingsSection } from '../../screens/settings/SettingsDraft';
import { SettingsLoading } from '../../screens/settings/SettingsLoading';
import { ErrorBanner } from '../../shell/ErrorBanner';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'files',
  label: msg({ id: 'files.settings.title', message: 'File uploads' }),
  roles: ['security'],
});
const policyHelp = msg({
  id: 'files.checks.outsideHelp',
  message:
    'Requiring a scanner accepts outside files only when it is enabled and its last self-test passed.  Built-in checks alone cannot detect known viruses or other malware.  This policy is reserved for future outside-file intake.',
});
const queryKey = ['organization', 'file-safety'];
const description = msg({
  id: 'files.checks.description',
  message:
    'Built-in file checks detect mismatched types, executable content, password protection, and archive expansion risks without a scanner.  Active content in a PDF or a web page is noted.  Files with a held result stay closed.',
});
const macrosHelp = msg({
  id: 'files.checks.macrosHelp',
  message:
    'Outside Office files with macros are held by default.  Allowing them does not execute macros or bypass other file checks.',
});

export function FileSafetyControls() {
  const { t } = useLingui();
  const client = useQueryClient();
  const query = useQuery({ queryKey, queryFn: () => api<FileSafetySettings>('/api/org/files/safety') });
  const [draft, setDraft] = useState<FileSafetySettings | null>(null);
  const settings = draft ?? query.data;
  const save = useMutation({
    mutationFn: (settings: FileSafetySettings) =>
      api<FileSafetySettings>('/api/org/files/safety', { method: 'PUT', body: settings }),
    onSuccess: (settings) => client.setQueryData(queryKey, settings),
  });
  useSettingsSection({
    dirty: Boolean(draft && JSON.stringify(draft) !== JSON.stringify(query.data)),
    stored: query.data,
    discard: () => setDraft(null),
    save: async () => {
      if (!settings) return;
      await save.mutateAsync(settings);
      setDraft((current) => (current === draft ? null : current));
    },
  });
  return (
    <div className="rio-file-scanner" id="file-checks">
      <Heading level={2}>
        <Trans id="files.checks.title">File checks</Trans>
      </Heading>
      <Text>{t(description)}</Text>
      <ErrorBanner error={errorInfo(query.error ?? save.error)} />
      <SettingsLoading isPending={query.isPending}>
        <Setting
          page={settingsPage}
          id="outside-files"
          label={msg({ id: 'files.checks.outside', message: 'Files from outside the organization' })}
          help={policyHelp}
        >
          <Select
            label={t({ id: 'files.checks.outside', message: 'Files from outside the organization' })}
            selectedKey={settings?.outsideFiles ?? 'requireScanner'}
            isDisabled={!settings || save.isPending}
            onSelectionChange={(key) => {
              if (settings && (key === 'requireScanner' || key === 'builtInChecksOnly'))
                setDraft({ ...settings, outsideFiles: key });
            }}
          >
            <ListBoxItem id="requireScanner">
              <Trans id="files.checks.requireScanner">Require a scanner</Trans>
            </ListBoxItem>
            <ListBoxItem id="builtInChecksOnly">
              <Trans id="files.checks.builtInOnly">Built-in checks only</Trans>
            </ListBoxItem>
          </Select>
          <Text variant="small">{t(policyHelp)}</Text>
        </Setting>
        <Setting
          page={settingsPage}
          id="outside-macros"
          label={msg({ id: 'files.checks.allowMacros', message: 'Allow macros in outside Office files' })}
          help={macrosHelp}
        >
          <Checkbox
            isSelected={settings?.allowOutsideMacros ?? false}
            isDisabled={!settings || save.isPending}
            onChange={(allowOutsideMacros) => {
              if (settings) setDraft({ ...settings, allowOutsideMacros });
            }}
          >
            <Trans id="files.checks.allowMacros">Allow macros in outside Office files</Trans>
          </Checkbox>
          <Text variant="small">{t(macrosHelp)}</Text>
        </Setting>
      </SettingsLoading>
    </div>
  );
}
