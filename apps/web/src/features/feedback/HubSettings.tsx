import { msg } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { useQueryClient } from '@tanstack/react-query';
import type { FeedbackHubSettings } from '@riosoma/contracts';
import { Switch } from '@riosoma/ui';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';
import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { feedbackHubKey, saveHubSettings } from './api';

const page = defineSettingsPage({
  area: 'admin',
  section: 'organization',
  page: 'feedback',
  label: msg({ id: 'settings.nav.feedback', message: 'Feedback' }),
  roles: ['feedback'],
});

export function HubSettings({ settings }: { settings: FeedbackHubSettings }) {
  const { t } = useLingui();
  const client = useQueryClient();
  const draft = useSettingsDraft(settings.enabled, async (enabled) => {
    const saved = await saveHubSettings(enabled);
    client.setQueryData(feedbackHubKey, saved);
  });
  return (
    <form
      className="rio-feedback-github"
      onSubmit={(event) => {
        event.preventDefault();
        void draft.save?.();
      }}
    >
      <p>
        <Trans id="feedback.hub.detail">
          Let admins send definite software bugs to the Riosoma hub after reviewing each report. The hub
          publishes them in adachis/riosoma on GitHub and combines duplicates. Screenshots and sender details
          stay here.
        </Trans>
      </p>
      <p>
        <Trans id="feedback.hub.previewDetail">
          This example shows every field sent. Each report replaces the example text, version, platform, and
          fingerprint with its redacted preview. Review that preview for personal information before sending.
        </Trans>
      </p>
      <pre className="rio-feedback-issue__body" tabIndex={0}>
        {JSON.stringify(settings.preview, null, 2)}
      </pre>
      {settings.url ? (
        <p>{settings.url}</p>
      ) : (
        <p>
          <Trans id="feedback.hub.off">The server operator has turned upstream bug reports off.</Trans>
        </p>
      )}
      <Setting
        page={page}
        id="hub-enabled"
        label={msg({ id: 'feedback.hub.enabled', message: 'Let admins send software bugs upstream' })}
      >
        <Switch
          isSelected={draft.value}
          onChange={draft.setValue}
          isDisabled={!settings.canChange || !settings.url || draft.saving}
        >
          {t({ id: 'feedback.hub.enabled', message: 'Let admins send software bugs upstream' })}
        </Switch>
      </Setting>
    </form>
  );
}
