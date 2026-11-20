import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CalendarFeedPolicy } from '@riosoma/contracts';
import { ConfirmDialog, Spinner, Switch, toast } from '@riosoma/ui';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { calendarFeedPolicyKey, readCalendarFeedPolicy, saveCalendarFeedPolicy } from './api';
import './calendar-feeds.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'security',
  page: 'calendar-feeds',
  label: msg({ id: 'calendarFeeds.settings.title', message: 'Calendar feeds' }),
  roles: ['security'],
  keywords: msg({
    id: 'settings.search.keywords.calendar-feeds',
    message: 'calendar feeds subscriptions events',
  }),
});

/**
 * Settings › Calendar feeds, for owners and security admins: whether people may subscribe to
 * views in calendar apps.  Turning feeds off stops every one at once, so it asks first.
 */
export function CalendarFeedSettings() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const policy = useQuery({
    queryKey: calendarFeedPolicyKey,
    queryFn: ({ signal }) => readCalendarFeedPolicy(signal),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => saveCalendarFeedPolicy({ enabled }),
    onSuccess: (saved) => {
      queryClient.setQueryData<CalendarFeedPolicy>(calendarFeedPolicyKey, saved);
      toast.show({
        tone: 'success',
        title: saved.enabled
          ? t({ id: 'calendarFeeds.policy.savedOn', message: 'People can subscribe in calendar apps' })
          : t({ id: 'calendarFeeds.policy.savedOff', message: 'Turned calendar feeds off' }),
      });
    },
  });
  const draft = useSettingsDraft(policy.data?.enabled ?? true, (enabled) => save.mutateAsync(enabled));
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'calendarFeeds.settings.title', message: 'Calendar feeds' })}
    >
      {
        <div className="rio-calendar-feed rio-calendar-feed--settings">
          <p className="rio-calendar-feed__help">
            <Trans id="calendarFeeds.policy.intro">
              {
                'People subscribe to a calendar, timeline, or Gantt view from its menu, and get a private address that Apple Calendar, Google Calendar, and Outlook read.  Each address shows only what its person can see.'
              }
            </Trans>
          </p>
          <ErrorBanner error={errorInfo(policy.error ?? save.error)} />
          {policy.data ? (
            <Setting
              page={settingsPage}
              id="detail"
              label={msg({
                id: 'calendarFeeds.policy.detail',
                message:
                  'Turning this off stops every feed in the organization at once.  Turning it back on doesn’t bring them back, so people make new addresses.',
              })}
              help={msg({
                id: 'calendarFeeds.policy.detail',
                message:
                  'Turning this off stops every feed in the organization at once.  Turning it back on doesn’t bring them back, so people make new addresses.',
              })}
            >
              <Switch
                isSelected={draft.value}
                isDisabled={save.isPending}
                onChange={(enabled) => {
                  save.reset();
                  if (enabled) draft.setValue(true);
                  else setConfirming(true);
                }}
                description={t({
                  id: 'calendarFeeds.policy.detail',
                  message:
                    'Turning this off stops every feed in the organization at once.  Turning it back on doesn’t bring them back, so people make new addresses.',
                })}
              >
                {t({
                  id: 'calendarFeeds.policy.enabled',
                  message: 'Let people subscribe to views in calendar apps',
                })}
              </Switch>
            </Setting>
          ) : policy.isPending ? (
            <Spinner />
          ) : null}
          <ConfirmDialog
            isOpen={confirming}
            onOpenChange={setConfirming}
            title={t({ id: 'calendarFeeds.policy.offTitle', message: 'Turn calendar feeds off?' })}
            message={t({
              id: 'calendarFeeds.policy.offBody',
              message:
                'Every calendar feed in the organization stops working at once, and nobody can make a new one until feeds are turned back on.',
            })}
            confirmLabel={t({ id: 'calendarFeeds.policy.off', message: 'Turn feeds off' })}
            tone="danger"
            onConfirm={() => {
              draft.setValue(false);
            }}
          />
        </div>
      }
    </Setting>
  );
}
