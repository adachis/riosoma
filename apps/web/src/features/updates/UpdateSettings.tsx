import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FeedStatus, UpdateStatus } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Heading,
  ProgressBar,
  Spinner,
  Text,
  type BannerProps,
} from '@riosoma/ui';
import { ApiError } from '../../api';
import { useRelativeTime } from '../../relative-time';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import {
  applyUpdate,
  checkForUpdates,
  ownsServer,
  runActive,
  runsServer,
  UPDATES_KEY,
  updatesQuery,
} from './api';
import { FEED_STATUS, INSTALL_NAMES, RUN_STATE, UPDATER_PROBLEM } from './messages';
import { ReleaseNotes } from './ReleaseNotes';
import { UpdateSteps } from './UpdateSteps';
import './updates.css';

const settingsPage = defineSettingsPage({
  area: 'admin',
  section: 'server',
  page: 'updates',
  label: msg({ id: 'updates.title', message: 'Updates' }),
  roles: ['server'],
  keywords: msg({ id: 'settings.search.keywords.updates', message: 'updates versions backups releases' }),
});

/** How often the page asks how an update is going while one runs */
const FOLLOW_EVERY_MS = 2_000;

const FEED_TONE: Record<FeedStatus, BannerProps['tone'] | null> = {
  ok: null,
  off: 'info',
  noKeys: 'info',
  unchecked: 'info',
  unreachable: 'warning',
  invalid: 'danger',
  unsigned: 'danger',
  unknownKey: 'warning',
  badSignature: 'danger',
  stale: 'warning',
  older: 'info',
};

export function UpdateSettings() {
  return (
    <Setting page={settingsPage} id="overview" label={msg({ id: 'updates.title', message: 'Updates' })}>
      {runsServer(useSession()) ? <Updates /> : <ErrorBanner error={{ key: 'errors.adminOnly' }} />}
    </Setting>
  );
}

/** While Riosoma restarts during an update, its own address stops answering for a while. */
function restarting(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 502);
}

function Updates() {
  const { t, i18n } = useLingui();
  const client = useQueryClient();
  const owner = ownsServer(useSession());
  const [confirming, setConfirming] = useState(false);
  const apply = useMutation({
    mutationFn: applyUpdate,
    onSuccess: (status) => client.setQueryData(UPDATES_KEY, status),
  });
  // After starting an update here, the page follows it, through the restart when Riosoma stops
  // answering for a while, until the run ends.
  const following = apply.isSuccess;
  const query = useQuery({
    ...updatesQuery,
    refetchInterval: (current) =>
      runActive(current.state.data) || (following && current.state.error) ? FOLLOW_EVERY_MS : false,
    // Through a restart for up to 20 minutes, which covers a slow backup and long migrations.
    retry: (count, error) => following && restarting(error) && count < 600,
    retryDelay: FOLLOW_EVERY_MS,
  });
  const check = useMutation({
    mutationFn: checkForUpdates,
    onSuccess: (status) => client.setQueryData(UPDATES_KEY, status),
  });
  const status = query.data;
  const active = runActive(status);
  if (query.isPending) return <Spinner />;
  if (!status) return <ErrorBanner error={errorInfo(query.error)} />;
  const target = status.target;
  const latest = status.available[0];
  const install = i18n._(INSTALL_NAMES[status.install]);
  const tone = FEED_TONE[status.feed.status];
  return (
    <div className="rio-updates">
      <Text>
        <Trans id="updates.current">
          This server runs Riosoma {status.version}, installed with {install}.
        </Trans>
      </Text>
      {tone ? <Banner tone={tone}>{i18n._(FEED_STATUS[status.feed.status])}</Banner> : null}
      <div className="rio-updates__check">
        {status.feed.checkedAt ? <Checked at={status.feed.checkedAt} /> : null}
        <Button
          isDisabled={!status.checks || status.feed.status === 'noKeys' || active}
          isPending={check.isPending}
          onPress={() => check.mutate()}
        >
          <Trans id="updates.checkNow">Check now</Trans>
        </Button>
      </div>
      <ErrorBanner error={errorInfo(check.error ?? apply.error)} />
      {following && restarting(query.failureReason) ? (
        <Banner tone="info">
          {t({
            id: 'updates.restarting',
            message: 'Riosoma is restarting.  This page picks up again when it’s back.',
          })}
        </Banner>
      ) : null}
      {status.run && active ? (
        <div className="rio-updates__progress">
          <ProgressBar
            isIndeterminate
            label={t({ id: 'updates.progress', message: `Updating to ${status.run.toVersion}` })}
          />
          <Text role="status">{i18n._(RUN_STATE[status.run.state])}</Text>
        </div>
      ) : status.run ? (
        <LastRun status={status} />
      ) : null}
      {latest ? (
        <>
          <Heading level={2}>
            <Trans id="updates.available">Newer releases</Trans>
          </Heading>
          {target && target.version !== latest.version ? (
            <Text>
              <Trans id="updates.stepwise">
                This server has to update to {target.version} first, and to {latest.version} after that.
              </Trans>
            </Text>
          ) : null}
          {!target ? (
            <Banner tone="warning">
              {t({
                id: 'updates.noTarget',
                message:
                  'This version is too old to update straight to any of these.  Follow the release notes to update by hand.',
              })}
            </Banner>
          ) : null}
          {status.available.map((release) => (
            <ReleaseNotes key={release.version} release={release} />
          ))}
        </>
      ) : status.feed.status === 'ok' ? (
        <Text>
          <Trans id="updates.upToDate">This server runs the newest release.</Trans>
        </Text>
      ) : null}
      {target && !active ? (
        <div className="rio-updates__action">
          <Heading level={2}>
            <Trans id="updates.how">How to update</Trans>
          </Heading>
          {status.canUpdate ? (
            <>
              <Text>
                {t({
                  id: 'updates.oneClick',
                  message: `The updater stops Riosoma, backs up the database, and starts ${target.version}.  If ${target.version} doesn’t start, it restores the backup and starts ${status.version} again.`,
                })}
              </Text>
              <Button variant="primary" onPress={() => setConfirming(true)} isPending={apply.isPending}>
                <Trans id="updates.apply">Update to {target.version}</Trans>
              </Button>
            </>
          ) : (
            <>
              {status.updater.configured && !status.updater.ready && status.updater.problem ? (
                <Banner tone="warning">{i18n._(UPDATER_PROBLEM[status.updater.problem])}</Banner>
              ) : null}
              {status.updater.ready && !owner ? (
                <Text>
                  <Trans id="updates.ownerUpdates">The owner can update from here in one click.</Trans>
                </Text>
              ) : null}
              {status.install === 'compose' && !status.updater.configured ? (
                <Text>
                  {t({
                    id: 'updates.turnOnUpdater',
                    message:
                      'Turn on the updater profile to update from here in one click.  Help explains how.',
                  })}
                </Text>
              ) : null}
              <UpdateSteps status={status} release={target} />
            </>
          )}
        </div>
      ) : null}
      <ConfirmDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title={t({ id: 'updates.confirm.title', message: `Update to Riosoma ${target?.version ?? ''}?` })}
        message={t({
          id: 'updates.confirm.message',
          message:
            'Riosoma stops while the database is backed up and the new version starts, usually for a few minutes.  Everyone signed in sees it restart.',
        })}
        confirmLabel={t({ id: 'updates.confirm.update', message: 'Update now' })}
        onConfirm={async () => {
          if (target) await apply.mutateAsync(target.version);
        }}
      />
    </div>
  );
}

function Checked({ at }: { at: string }) {
  const when = useRelativeTime(at);
  return (
    <Text variant="small">
      <Trans id="updates.checkedAt">Last checked {when}</Trans>
    </Text>
  );
}

function LastRun({ status }: { status: UpdateStatus }) {
  const { t, i18n } = useLingui();
  const run = status.run!;
  const from = run.fromVersion;
  const to = run.toVersion;
  const backup = run.backup;
  const problem = run.problem ? i18n._(UPDATER_PROBLEM[run.problem]) : '';
  if (run.state === 'succeeded')
    return (
      <Banner tone="success">
        {t({ id: 'updates.run.done', message: `Updated from ${from} to ${to}.` })}
      </Banner>
    );
  if (run.state === 'rolled_back')
    return (
      <Banner tone="warning">
        {t({
          id: 'updates.run.back',
          message: `The update to ${to} was rolled back, and ${from} is running again with the database as it was.`,
        })}
        {problem ? `  ${problem}` : null}
        {backup
          ? `  ${t({ id: 'updates.run.backup', message: `The backup taken before it is ${backup}.` })}`
          : null}
      </Banner>
    );
  return (
    <Banner tone="danger">
      {t({ id: 'updates.run.failedTo', message: `The update to ${to} didn’t finish.` })}
      {problem ? `  ${problem}` : null}
    </Banner>
  );
}
