import { useSettingsSection } from '../../screens/settings/SettingsDraft';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { msg } from '@lingui/core/macro';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { FeedbackGithubSettings, FeedbackGithubUpdate } from '@riosoma/contracts';
import { Button, PasswordField, Switch, TextField, toast } from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { feedbackGithubKey, saveGithubSettings } from './api';
const embeddedPage = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'feedback',
  label: msg({ id: 'settings.nav.feedback', message: 'Feedback' }),
  roles: ['feedback'],
});

/**
 * Whether admins can turn a broken thing into a GitHub issue, and where it goes.  It starts off.
 * Owners and integrations admins change it, and everyone else who reads the inbox sees how it's
 * set.  The token is only ever typed in: once saved, it never comes back.
 */
export function GithubSettings({ settings }: { settings: FeedbackGithubSettings }) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [repository, setRepository] = useState(settings.repository ?? '');
  const [token, setToken] = useState('');
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: FeedbackGithubUpdate) => saveGithubSettings(body),
    onSuccess: (saved) => {
      queryClient.setQueryData<FeedbackGithubSettings>(feedbackGithubKey, saved);
      setToken('');
      setEnabled(saved.enabled);
      setRepository(saved.repository ?? '');
      toast.show({ tone: 'success', title: t({ id: 'feedback.github.saved', message: 'Saved' }) });
    },
  });
  const failure = errorInfo(save.error);
  const fieldError = (field: string) => {
    const key = invalid[field] ?? failure?.fields?.[field];
    if (!key) return undefined;
    return key === 'feedback.github.repositoryRequired'
      ? t({ id: 'feedback.github.repositoryRequired', message: 'Name the repository as owner/name.' })
      : key === 'feedback.github.tokenRequired'
        ? t({ id: 'feedback.github.tokenRequired', message: 'Add a token that can open issues there.' })
        : t({ id: 'feedback.github.fieldInvalid', message: 'Check this.' });
  };

  const pageDraft = useSettingsSection({
    dirty:
      settings.canChange &&
      (enabled !== settings.enabled || repository !== (settings.repository ?? '') || Boolean(token)),
    stored: { enabled: settings.enabled, repository: settings.repository, hasToken: settings.hasToken },
    discard: () => {
      setEnabled(settings.enabled);
      setRepository(settings.repository ?? '');
      setToken('');
      setInvalid({});
    },
    validate: () => {
      const fields: Record<string, string> = {};
      if (enabled && !/^[^/\s]+\/[^/\s]+$/.test(repository.trim()))
        fields.repository = 'feedback.github.repositoryRequired';
      if (enabled && !settings.hasToken && !token.trim()) fields.token = 'feedback.github.tokenRequired';
      setInvalid(fields);
      return Object.keys(fields).length
        ? t({
            id: 'feedback.github.incomplete',
            message: 'Name a repository and add a token before turning this on.',
          })
        : null;
    },
    save: () =>
      save.mutateAsync({
        enabled,
        repository: repository.trim() || null,
        ...(token.trim() ? { token: token.trim() } : {}),
      }),
  });

  if (!settings.canChange) {
    const repo = settings.repository ?? '';
    return (
      <p className="rio-feedback-inbox__intro">
        {settings.enabled && repo
          ? t({
              id: 'feedback.github.onFor',
              message: `Broken things can be sent to ${repo} as issues.  Owners and integrations admins change this.`,
            })
          : t({
              id: 'feedback.github.offForYou',
              message:
                'Sending bug reports to GitHub is off.  Owners and integrations admins can turn it on.',
            })}
      </p>
    );
  }

  const submit = (body: FeedbackGithubUpdate) => {
    save.reset();
    save.mutate(body);
  };
  const trimmed = repository.trim();
  return (
    <form
      className="rio-feedback-github"
      onSubmit={(event) => {
        event.preventDefault();
        void pageDraft.save?.();
      }}
    >
      <p className="rio-feedback-inbox__intro">
        {t({
          id: 'feedback.github.intro',
          message:
            'When this is on, an admin can turn something broken into a GitHub issue with one button, after seeing exactly what goes.  Nothing is sent on its own.',
        })}
      </p>
      <ErrorBanner error={failure && !failure.fields ? failure : null} />
      <Setting
        page={embeddedPage}
        id="issues-enabled"
        label={msg({ id: 'feedback.github.enabled', message: 'Let admins send bug reports to GitHub' })}
      >
        <Switch isSelected={enabled} onChange={setEnabled} isDisabled={save.isPending}>
          {t({ id: 'feedback.github.enabled', message: 'Let admins send bug reports to GitHub' })}
        </Switch>
      </Setting>
      <Setting
        page={embeddedPage}
        id="issues-repository"
        label={msg({ id: 'feedback.github.repository', message: 'Repository' })}
      >
        <TextField
          label={t({ id: 'feedback.github.repository', message: 'Repository' })}
          description={t({
            id: 'feedback.github.repository.detail',
            message: 'As owner/name, such as acme/app',
          })}
          value={repository}
          onChange={setRepository}
          isDisabled={save.isPending}
          isInvalid={Boolean(fieldError('repository'))}
          errorMessage={fieldError('repository')}
        />
      </Setting>
      <Setting
        page={embeddedPage}
        id="issues-token"
        label={msg({ id: 'feedback.github.token', message: 'Token' })}
      >
        <PasswordField
          label={t({ id: 'feedback.github.token', message: 'Token' })}
          description={
            settings.hasToken
              ? t({
                  id: 'feedback.github.token.saved',
                  message: 'A token is saved.  Type a new one to replace it.',
                })
              : t({
                  id: 'feedback.github.token.detail',
                  message:
                    'A fine-grained token for this repository with Issues set to read and write.  Sending screenshots also needs Contents set to read and write.',
                })
          }
          value={token}
          onChange={setToken}
          isDisabled={save.isPending}
          isInvalid={Boolean(fieldError('token'))}
          errorMessage={fieldError('token')}
        />
      </Setting>
      <div className="rio-feedback-inbox__actions">
        {settings.hasToken ? (
          <Button
            isDisabled={save.isPending}
            onPress={() => submit({ enabled: false, repository: trimmed || null, token: null })}
          >
            <Trans id="feedback.github.removeToken">Remove the token and turn this off</Trans>
          </Button>
        ) : null}
      </div>
    </form>
  );
}
