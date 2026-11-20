import {
  FINISHED_RUN_STATES,
  type SessionInfo,
  type TelemetryStatus,
  type UpdateStatus,
} from '@riosoma/contracts';
import { api } from '../../api';

export { UPDATES_KEY, runsServer, updatesQuery } from './query';
export const TELEMETRY_KEY = ['admin', 'telemetry'];

/** The help topics for updates and usage counts */
export const UPDATES_HELP = 'updates';
export const TELEMETRY_HELP = 'telemetry';

/** Only the owner decides on usage counts */
export function ownsServer(session: SessionInfo | null): boolean {
  return session?.membership.kind === 'owner';
}

export function runActive(status: UpdateStatus | undefined): boolean {
  const run = status?.run;
  return Boolean(run && !FINISHED_RUN_STATES.includes(run.state));
}

export const telemetryQuery = {
  queryKey: TELEMETRY_KEY,
  queryFn: ({ signal }: { signal?: AbortSignal }) =>
    api<TelemetryStatus>('/api/admin/telemetry', signal ? { signal } : {}),
};

export function checkForUpdates(): Promise<UpdateStatus> {
  return api<UpdateStatus>('/api/admin/updates/check', { method: 'POST' });
}

export function applyUpdate(version: string): Promise<UpdateStatus> {
  return api<UpdateStatus>('/api/admin/updates/apply', { method: 'POST', body: { version } });
}

export function chooseTelemetry(enabled: boolean): Promise<TelemetryStatus> {
  return api<TelemetryStatus>('/api/admin/telemetry', { method: 'PUT', body: { enabled } });
}

export function resetInstallId(): Promise<TelemetryStatus> {
  return api<TelemetryStatus>('/api/admin/telemetry/install-id', { method: 'POST' });
}
