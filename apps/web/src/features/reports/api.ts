import type {
  MyReports,
  ReportPolicy,
  ReportRun,
  ReportRunsPage,
  ReportSchedule,
  ReportScheduleInput,
  ReportUnsubscribePreview,
  ViewReports,
} from '@riosoma/contracts';
import { api, apiFile } from '../../api';

/** Scheduled reports: a view's schedules, the person's own, their runs, and the footer link. */

const report = (reportId: string) => `/api/reports/${encodeURIComponent(reportId)}`;

export const viewReportsKey = (viewId: string) => ['views', viewId, 'reports'] as const;
export const myReportsKey = ['reports', 'mine'] as const;
export const reportRunsKey = (reportId: string) => ['reports', reportId, 'runs'] as const;
export const reportPolicyKey = ['admin', 'reports', 'policy'] as const;

export const listViewReports = (viewId: string, signal?: AbortSignal) =>
  api<ViewReports>(`/api/views/${encodeURIComponent(viewId)}/reports`, signal ? { signal } : {});

export const createReport = (viewId: string, body: ReportScheduleInput) =>
  api<ReportSchedule>(`/api/views/${encodeURIComponent(viewId)}/reports`, { body });

export const updateReport = (reportId: string, body: ReportScheduleInput) =>
  api<ReportSchedule>(report(reportId), { method: 'PUT', body });

export const deleteReport = (reportId: string) => api<void>(report(reportId), { method: 'DELETE' });

export const sendReport = (reportId: string) =>
  api<ReportRun>(`${report(reportId)}/send`, { method: 'POST' });

export const downloadReport = (reportId: string) => apiFile(`${report(reportId)}/download`);

export const leaveReport = (reportId: string) => api<void>(`${report(reportId)}/leave`, { method: 'POST' });

export const listReportRuns = (reportId: string, cursor?: string, signal?: AbortSignal) =>
  api<ReportRunsPage>(
    `${report(reportId)}/runs${cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''}`,
    signal ? { signal } : {},
  );

export const listMyReports = (signal?: AbortSignal) =>
  api<MyReports>('/api/reports', signal ? { signal } : {});

const unsubscribe = (token: string) =>
  `/api/reports/unsubscribe?${new URLSearchParams({ token }).toString()}`;

export const previewUnsubscribe = (token: string, signal?: AbortSignal) =>
  api<ReportUnsubscribePreview>(unsubscribe(token), signal ? { signal } : {});

export const confirmUnsubscribe = (token: string) => api<void>(unsubscribe(token), { method: 'POST' });

export const readReportPolicy = (signal?: AbortSignal) =>
  api<ReportPolicy>('/api/admin/reports/policy', signal ? { signal } : {});

export const saveReportPolicy = (body: ReportPolicy) =>
  api<ReportPolicy>('/api/admin/reports/policy', { method: 'PUT', body });

/** The input a schedule was saved from, for changing one thing and saving the rest as it was. */
export function inputOf(schedule: ReportSchedule): ReportScheduleInput {
  return {
    name: schedule.name,
    format: schedule.format,
    frequency: schedule.frequency,
    timeZone: schedule.timeZone,
    enabled: schedule.enabled,
    recipients: schedule.recipients.map((recipient) =>
      recipient.kind === 'member'
        ? { kind: 'member', userId: recipient.userId }
        : { kind: 'address', address: recipient.address },
    ),
  };
}
