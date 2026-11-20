import { useSettingsDraft } from '../../screens/settings/SettingsDraft';
import { msg } from '@lingui/core/macro';
import { Setting, defineSettingsPage } from '../../screens/settings/Setting';

import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { MyReports, ReportPolicy, ReportSchedule } from '@riosoma/contracts';
import { Button, Spinner, Switch, toast } from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { useSession } from '../../session';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { databaseHref } from '../../screens/database/screen/routes';
import { navigateOnPlainClick } from '../../screens/database/shell/navigation';
import { canManageSso } from '../../screens/settings/sso/SsoSettings';
import {
  leaveReport,
  listMyReports,
  myReportsKey,
  readReportPolicy,
  reportPolicyKey,
  saveReportPolicy,
} from './api';
import { useReportWords } from './words';
import './reports.css';

const settingsPage = defineSettingsPage({
  area: 'personal',
  section: 'account',
  page: 'reports',
  label: msg({ id: 'reports.title', message: 'Scheduled reports' }),
  roles: ['personal'],
  keywords: msg({ id: 'settings.search.keywords.reports', message: 'scheduled reports email recipients' }),
});

/** The report's view, where it's changed. */
function Place({ report }: { report: ReportSchedule }) {
  const navigate = useNavigate();
  const view = report.viewName;
  const table = report.tableName;
  const database = report.databaseName;
  const href = databaseHref(report.databaseId, report.tableId, report.viewId);
  return (
    <a
      href={href}
      className="rio-report-schedules__place"
      onClick={(event) => navigateOnPlainClick(event, () => void navigate({ to: href }))}
    >
      <Trans id="reports.settings.place">
        {view} in {table}, {database}
      </Trans>
    </a>
  );
}

function Row({ report, action }: { report: ReportSchedule; action?: ReactNode }) {
  const { t } = useLingui();
  const words = useReportWords();
  const message = useServerMessage();
  const zone = report.timeZone;
  return (
    <li className="rio-report-schedules__item" data-enabled={report.enabled}>
      <div className="rio-report-schedules__head">
        <strong>{report.name}</strong>
        {action}
      </div>
      <Place report={report} />
      <p className="rio-report-schedules__status">
        {words.frequency(report.frequency)} <span className="rio-report-schedules__zone">({zone})</span>
        {' · '}
        {words.formats[report.format]}
      </p>
      {!report.enabled ? (
        <p className="rio-report-schedules__status" data-tone={report.stoppedBecause ? 'warning' : undefined}>
          {report.stoppedBecause
            ? `${t({ id: 'reports.status.stopped', message: 'Turned itself off.' })} ${message(report.stoppedBecause)}`
            : t({ id: 'reports.status.off', message: 'Off' })}
        </p>
      ) : null}
    </li>
  );
}

/** Whether reports may go outside the organization, for owners and security admins. */
function OutsidePolicy() {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const policy = useQuery({ queryKey: reportPolicyKey, queryFn: ({ signal }) => readReportPolicy(signal) });
  const save = useMutation({
    mutationFn: (outsideRecipients: boolean) => saveReportPolicy({ outsideRecipients }),
    onSuccess: (saved) => {
      queryClient.setQueryData<ReportPolicy>(reportPolicyKey, saved);
      toast.show({
        tone: 'success',
        title: t({ id: 'reports.policy.saved', message: 'Saved who reports can go to' }),
      });
    },
  });
  const draft = useSettingsDraft(policy.data?.outsideRecipients ?? false, (value) => save.mutateAsync(value));
  return (
    <section className="rio-report-schedules__section" aria-labelledby="reports-policy">
      <h2 id="reports-policy" className="rio-report-schedules__heading">
        <Trans id="reports.policy.title">For the organization</Trans>
      </h2>
      <ErrorBanner error={errorInfo(policy.error ?? save.error)} />
      {policy.data ? (
        <Setting
          page={settingsPage}
          id="detail"
          label={msg({
            id: 'reports.policy.outside.detail',
            message:
              'An outside address gets what the person who set up the report sees.  Never for a database with restricted fields.',
          })}
          help={msg({
            id: 'reports.policy.outside.detail',
            message:
              'An outside address gets what the person who set up the report sees.  Never for a database with restricted fields.',
          })}
          roles={['security']}
        >
          <Switch
            isSelected={draft.value}
            isDisabled={save.isPending}
            onChange={(value) => draft.setValue(value)}
            description={t({
              id: 'reports.policy.outside.detail',
              message:
                'An outside address gets what the person who set up the report sees.  Never for a database with restricted fields.',
            })}
          >
            {t({
              id: 'reports.policy.outside',
              message: 'Let scheduled reports go to addresses outside the organization',
            })}
          </Switch>
        </Setting>
      ) : policy.isPending ? (
        <Spinner />
      ) : null}
    </section>
  );
}

/**
 * Settings › Scheduled reports: every report the person set up, each linking to its view where
 * it's changed, and every one they receive, each of which they can stop.
 */
export function ReportSettings() {
  const { t } = useLingui();
  const session = useSession();
  const queryClient = useQueryClient();
  const mine = useQuery({ queryKey: myReportsKey, queryFn: ({ signal }) => listMyReports(signal) });
  const leave = useMutation({
    mutationFn: (report: ReportSchedule) => leaveReport(report.id),
    onSuccess: (_answer, report) => {
      queryClient.setQueryData<MyReports>(myReportsKey, (current) =>
        current
          ? { ...current, receiving: current.receiving.filter((item) => item.id !== report.id) }
          : current,
      );
      const name = report.name;
      toast.show({
        tone: 'success',
        title: t({ id: 'reports.left', message: `You won’t get ${name} anymore` }),
      });
    },
  });
  return (
    <Setting
      page={settingsPage}
      id="overview"
      label={msg({ id: 'reports.title', message: 'Scheduled reports' })}
    >
      {
        <div className="rio-report-schedules rio-report-schedules--settings">
          <p className="rio-report-schedules__intro">
            <Trans id="reports.settings.intro">
              {
                'Reports email a view’s records on a schedule.  Set one up from a view’s menu, and change it there too.'
              }
            </Trans>
          </p>
          <ErrorBanner error={errorInfo(mine.error ?? leave.error)} />
          {mine.isPending ? (
            <Spinner label={t({ id: 'reports.loading', message: 'Loading reports' })} />
          ) : mine.data ? (
            <>
              <section className="rio-report-schedules__section" aria-labelledby="reports-owned">
                <h2 id="reports-owned" className="rio-report-schedules__heading">
                  <Trans id="reports.settings.owned">Reports you set up</Trans>
                </h2>
                {mine.data.owned.length ? (
                  <ul className="rio-report-schedules__list">
                    {mine.data.owned.map((report) => (
                      <Row key={report.id} report={report} />
                    ))}
                  </ul>
                ) : (
                  <p>
                    <Trans id="reports.settings.ownedEmpty">You haven’t set up any reports.</Trans>
                  </p>
                )}
              </section>
              <section className="rio-report-schedules__section" aria-labelledby="reports-receiving">
                <h2 id="reports-receiving" className="rio-report-schedules__heading">
                  <Trans id="reports.settings.receiving">Reports you receive</Trans>
                </h2>
                {mine.data.receiving.length ? (
                  <ul className="rio-report-schedules__list">
                    {mine.data.receiving.map((report) => {
                      const name = report.name;
                      return (
                        <Row
                          key={report.id}
                          report={report}
                          action={
                            <Button
                              size="sm"
                              isPending={leave.isPending && leave.variables?.id === report.id}
                              aria-label={t({ id: 'reports.leave.named', message: `Stop receiving ${name}` })}
                              onPress={() => {
                                leave.reset();
                                leave.mutate(report);
                              }}
                            >
                              <Trans id="reports.leave">Stop receiving</Trans>
                            </Button>
                          }
                        />
                      );
                    })}
                  </ul>
                ) : (
                  <p>
                    <Trans id="reports.settings.receivingEmpty">Nobody else sends you a report.</Trans>
                  </p>
                )}
              </section>
            </>
          ) : null}
          {canManageSso(session) ? <OutsidePolicy /> : null}
        </div>
      }
    </Setting>
  );
}
