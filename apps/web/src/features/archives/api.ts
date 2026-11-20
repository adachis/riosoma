import type {
  DatabaseCopy,
  OrgTemplateCreate,
  SnapshotList,
  SnapshotMeta,
  SnapshotSettings,
  TemplateSummary,
} from '@riosoma/contracts';
import { api, apiFile, type FileBody } from '../../api';

/**
 * The server's routes for snapshots, copies, and the organization's templates.  A snapshot's file
 * comes compressed over the wire and lands as plain JSON, since the browser undoes the compression.
 */

export const snapshotsKey = (databaseId: string) => ['snapshots', databaseId] as const;

export function listSnapshots(databaseId: string, signal?: AbortSignal): Promise<SnapshotList> {
  return api<SnapshotList>(`/api/databases/${databaseId}/snapshots`, signal ? { signal } : {});
}

export function takeSnapshot(databaseId: string, name: string): Promise<SnapshotMeta> {
  return api<SnapshotMeta>(`/api/databases/${databaseId}/snapshots`, { method: 'POST', body: { name } });
}

export function deleteSnapshot(snapshotId: string): Promise<unknown> {
  return api(`/api/snapshots/${snapshotId}`, { method: 'DELETE' });
}

export function downloadSnapshot(snapshotId: string): Promise<FileBody> {
  return apiFile(`/api/snapshots/${snapshotId}/download`);
}

export function restoreSnapshot(snapshotId: string, name: string): Promise<DatabaseCopy> {
  return api<DatabaseCopy>(`/api/snapshots/${snapshotId}/restore`, { method: 'POST', body: { name } });
}

export function duplicateDatabase(
  databaseId: string,
  name: string,
  withRecords: boolean,
): Promise<DatabaseCopy> {
  return api<DatabaseCopy>(`/api/databases/${databaseId}/duplicate`, {
    method: 'POST',
    body: { name, withRecords },
  });
}

/** The copy once it has moved past `since`, or as it is after a while without news. */
export function watchCopy(id: string, since: number, signal?: AbortSignal): Promise<DatabaseCopy> {
  return api<DatabaseCopy>(`/api/database-copies/${id}?since=${since}`, signal ? { signal } : {});
}

export function saveAsTemplate(databaseId: string, input: OrgTemplateCreate): Promise<TemplateSummary> {
  return api<TemplateSummary>(`/api/databases/${databaseId}/save-as-template`, {
    method: 'POST',
    body: input,
  });
}

export function removeTemplate(templateId: string): Promise<unknown> {
  return api(`/api/templates/${templateId}`, { method: 'DELETE' });
}

export const snapshotSettingsKey = ['settings', 'snapshots'] as const;

export function loadSnapshotSettings(signal?: AbortSignal): Promise<SnapshotSettings> {
  return api<SnapshotSettings>('/api/settings/snapshots', signal ? { signal } : {});
}

export function saveSnapshotSettings(settings: SnapshotSettings): Promise<SnapshotSettings> {
  return api<SnapshotSettings>('/api/settings/snapshots', { method: 'PUT', body: settings });
}

export { isOrgAdmin } from './access';
