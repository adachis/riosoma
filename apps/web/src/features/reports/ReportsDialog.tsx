import { faEllipsis } from '@fortawesome/free-solid-svg-icons';
import { Trans, useLingui } from '@lingui/react/macro';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReportSchedule, ViewReports } from '@riosoma/contracts';
import {
  Banner,
  Button,
  ConfirmDialog,
  Dialog,
  DialogBody,
  DialogTitle,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  Spinner,
  Switch,
  toast,
} from '@riosoma/ui';
import { useServerMessage } from '../../messages/useServerMessage';
import { ErrorBanner } from '../../shell/ErrorBanner';
import { errorInfo } from '../../screens/setup/useSetup';
import { saveFile } from '../../screens/database/view/download';
import {
  deleteReport,
  downloadReport,
  inputOf,
  listViewReports,
  myReportsKey,
  sendReport,
  updateReport,
  viewReportsKey,
} from './api';
import { ReportForm } from './ReportForm';
import { ReportRuns } from './ReportRuns';
import { useReportWords } from './words';
import { anchor } from '../../demos/anchors';
import './reports.css';

type Screen =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; report: ReportSchedule }
  | { kind: 'runs'; report: ReportSchedule };

function ReportItem({
  report,
  toggling,
  downloading,
  onDownload,
  onToggle,
  onEdit,
  onSend,
  onRuns,
  onDelete,
  canSeeRuns,
}: {
  report: ReportSchedule;
  toggling: boolean;
  downloading: boolean;
  onDownload(): void;
  canSeeRuns: boolean;
  onToggle(enabled: boolean): void;
  onEdit(): void;
  onSend(): void;
  onRuns(): void;
  onDelete(): void;
}) {
  const { t } = useLingui();
  const words = useReportWords();
  const message = useServerMessage();
  const name = report.name;
  const owner = report.owner.name;
  const menu = t({ id: 'reports.actions', message: `More for ${name}` });
  const next = report.nextRunAt ? words.moment(report.nextRunAt, report.timeZone) : null;
  const zone = report.timeZone;
  const people = report.recipients.length;
  const hasMenu = report.format === 'pdf' || report.canEdit || report.canDelete || canSeeRuns;
  return (
    <li className="rio-report-schedules__item" data-enabled={report.enabled}>
      <div className="rio-report-schedules__head">
        {report.canEdit ? (
          <Switch isSelected={report.enabled} isDisabled={toggling} onChange={onToggle}>
            {name}
          </Switch>
        ) : (
          <strong>{name}</strong>
        )}
        {hasMenu ? (
          <MenuTrigger>
            <Button variant="quiet" size="sm" icon={faEllipsis} aria-label={menu} isPending={downloading} />
            <Menu aria-label={menu}>
              {report.format === 'pdf' ? (
                <MenuItem id="download" onAction={onDownload} isDisabled={downloading}>
                  {t({ id: 'reports.download', message: 'Download PDF' })}
                </MenuItem>
              ) : null}
              {report.canEdit ? (
                <MenuItem id="edit" onAction={onEdit}>
                  {t({ id: 'reports.edit', message: 'Edit' })}
                </MenuItem>
              ) : null}
              {report.canEdit ? (
                <MenuItem id="send" onAction={onSend}>
                  {t({ id: 'reports.send', message: 'Send now' })}
                </MenuItem>
              ) : null}
              {canSeeRuns ? (
                <MenuItem id="runs" onAction={onRuns}>
                  {t({ id: 'reports.runs.title', message: 'History' })}
                </MenuItem>
              ) : null}
              {report.canDelete ? (
                <MenuItem id="delete" tone="danger" onAction={onDelete}>
                  {t({ id: 'reports.delete', message: 'Delete' })}
                </MenuItem>
              ) : null}
            </Menu>
          </MenuTrigger>
        ) : null}
      </div>
      <dl className="rio-report-schedules__facts">
        <div>
          <dt>
            <Trans id="reports.facts.when">When</Trans>
          </dt>
          <dd>
            {words.frequency(report.frequency)} <span className="rio-report-schedules__zone">({zone})</span>
          </dd>
        </div>
        <div>
          <dt>
            <Trans id="reports.facts.file">File</Trans>
          </dt>
          <dd>{words.formats[report.format]}</dd>
        </div>
        {people > 0 ? (
          <div>
            <dt>
              <Trans id="reports.facts.recipients">Send to</Trans>
            </dt>
            <dd>
              {new Intl.ListFormat(words.locale, { type: 'conjunction' }).format(
                report.recipients.map((recipient) =>
                  recipient.kind === 'member' ? recipient.name : recipient.address,
                ),
              )}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>
            <Trans id="reports.facts.owner">Set up by</Trans>
          </dt>
          <dd>{owner}</dd>
        </div>
      </dl>
      {!report.enabled && report.stoppedBecause ? (
        <p className="rio-report-schedules__status" data-tone="warning">
          {t({ id: 'reports.status.stopped', message: 'Turned itself off.' })}{' '}
          {message(report.stoppedBecause)}
        </p>
      ) : next ? (
        <p className="rio-report-schedules__status">
          {t({ id: 'reports.status.next', message: `Next goes ${next}` })}
        </p>
      ) : null}
    </li>
  );
}

export interface ReportsDialogProps {
  viewId: string;
  viewName: string;
  onClose(): void;
}

/**
 * A view's scheduled reports: the ones this person set up or receives, or every one for people
 * who can change the view, and setting one up, changing it, sending it now, and its history.
 */
export function ReportsDialog({ viewId, viewName, onClose }: ReportsDialogProps) {
  const { t } = useLingui();
  const queryClient = useQueryClient();
  const key = viewReportsKey(viewId);
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [deleting, setDeleting] = useState<ReportSchedule | null>(null);
  const reports = useQuery({ queryKey: key, queryFn: ({ signal }) => listViewReports(viewId, signal) });
  const store = (report: ReportSchedule) => {
    queryClient.setQueryData<ViewReports>(key, (current) =>
      current
        ? {
            ...current,
            reports: current.reports.some((item) => item.id === report.id)
              ? current.reports.map((item) => (item.id === report.id ? report : item))
              : [...current.reports, report],
          }
        : current,
    );
    void queryClient.invalidateQueries({ queryKey: myReportsKey });
  };
  const toggle = useMutation({
    mutationFn: ({ report, enabled }: { report: ReportSchedule; enabled: boolean }) =>
      updateReport(report.id, { ...inputOf(report), enabled }),
    onSuccess: store,
  });
  const download = useMutation({
    mutationFn: (report: ReportSchedule) => downloadReport(report.id),
    onSuccess: (file, report) =>
      saveFile(file.blob, file.filename ?? `${report.tableName} - ${report.viewName}.pdf`),
  });
  const send = useMutation({
    mutationFn: (report: ReportSchedule) => sendReport(report.id),
    onSuccess: (run, report) => {
      const name = report.name;
      toast.show(
        run.state === 'sent'
          ? { tone: 'success', title: t({ id: 'reports.sent', message: `Sent ${name}` }) }
          : {
              tone: 'warning',
              title: t({ id: 'reports.sentWithProblems', message: `${name} didn’t reach everyone` }),
              description: t({
                id: 'reports.sentWithProblems.detail',
                message: 'Its history says who didn’t get it, and why.',
              }),
            },
      );
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const remove = useMutation({
    mutationFn: (reportId: string) => deleteReport(reportId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: myReportsKey });
    },
  });
  const data = reports.data;
  const listed = data?.reports ?? [];
  const back = () => setScreen({ kind: 'list' });
  const titles: Record<Screen['kind'], string> = {
    list: t({ id: 'reports.title', message: 'Scheduled reports' }),
    add: t({ id: 'reports.add.title', message: 'Set up a report' }),
    edit: t({ id: 'reports.edit.title', message: 'Edit report' }),
    runs: t({ id: 'reports.runs.title', message: 'History' }),
  };
  const add = (
    <Button variant="primary" onPress={() => setScreen({ kind: 'add' })} {...anchor('reports.add')}>
      <Trans id="reports.add">Set up a report</Trans>
    </Button>
  );
  const deletingName = deleting?.name ?? '';

  return (
    <>
      <Modal
        isOpen
        isDismissable
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        size="lg"
      >
        <Dialog>
          <DialogTitle>{titles[screen.kind]}</DialogTitle>
          {(screen.kind === 'add' || screen.kind === 'edit') && data ? (
            <ReportForm
              key={screen.kind === 'edit' ? screen.report.id : 'new'}
              viewId={viewId}
              viewName={viewName}
              {...(screen.kind === 'edit' ? { report: screen.report } : {})}
              members={data.members}
              canAddMembers={data.canAddMembers}
              outsideAllowed={data.outsideAllowed}
              onCancel={back}
              onSaved={(report) => {
                store(report);
                back();
              }}
            />
          ) : screen.kind === 'runs' ? (
            <ReportRuns report={screen.report} onBack={back} />
          ) : (
            <DialogBody className="rio-report-schedules">
              <p className="rio-report-schedules__intro">
                <Trans id="reports.intro">
                  {
                    'Email this view’s records on a schedule, as a file and a short summary.  Everyone in the organization gets only the records and fields they can see themselves.'
                  }
                </Trans>
              </p>
              {data && !data.emailAvailable ? (
                <Banner tone="info">
                  {t({
                    id: 'reports.noEmail',
                    message: 'This server isn’t set up to send email yet, so reports wait until it is.',
                  })}
                </Banner>
              ) : null}
              <ErrorBanner error={errorInfo(reports.error ?? toggle.error ?? send.error ?? download.error)} />
              {reports.isPending ? (
                <Spinner label={t({ id: 'reports.loading', message: 'Loading reports' })} />
              ) : listed.length === 0 ? (
                <div className="rio-report-schedules__empty">
                  <p>
                    <Trans id="reports.empty">No scheduled reports for this view yet.</Trans>
                  </p>
                  {reports.isError ? null : add}
                </div>
              ) : (
                <>
                  <div className="rio-report-schedules__actions">{add}</div>
                  <ul className="rio-report-schedules__list">
                    {listed.map((report) => (
                      <ReportItem
                        key={report.id}
                        report={report}
                        downloading={download.isPending && download.variables.id === report.id}
                        onDownload={() => {
                          if (download.isPending) return;
                          download.reset();
                          download.mutate(report);
                        }}
                        canSeeRuns={report.canEdit || Boolean(data?.canAddMembers)}
                        toggling={toggle.isPending && toggle.variables?.report.id === report.id}
                        onToggle={(enabled) => {
                          toggle.reset();
                          toggle.mutate({ report, enabled });
                        }}
                        onEdit={() => setScreen({ kind: 'edit', report })}
                        onSend={() => {
                          send.reset();
                          send.mutate(report);
                        }}
                        onRuns={() => setScreen({ kind: 'runs', report })}
                        onDelete={() => {
                          remove.reset();
                          setDeleting(report);
                        }}
                      />
                    ))}
                  </ul>
                </>
              )}
            </DialogBody>
          )}
        </Dialog>
      </Modal>
      {deleting ? (
        <ConfirmDialog
          isOpen
          tone="danger"
          title={t({ id: 'reports.delete.title', message: 'Delete this report?' })}
          message={
            <>
              <Trans id="reports.delete.body">{deletingName} stops going to everyone at once.</Trans>
              <ErrorBanner error={errorInfo(remove.error)} />
            </>
          }
          confirmLabel={t({ id: 'reports.delete', message: 'Delete' })}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          onConfirm={() => remove.mutateAsync(deleting.id)}
        />
      ) : null}
    </>
  );
}
