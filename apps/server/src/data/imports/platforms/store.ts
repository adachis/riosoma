import {
  ImportPlatform,
  PLATFORM_IMPORT_LIMITS,
  PlatformReport,
  type PlatformImport,
} from '@riosoma/contracts';
import { EMPTY_PROGRESS, type ImportRow, type ImportTable } from '../core/store.js';

/** Imports from every tool share one table, which says which tool and where. */
export const PLATFORM_TABLE: ImportTable = {
  name: 'platform_imports',
  interrupted: 'import.platform.interrupted',
  recent: PLATFORM_IMPORT_LIMITS.recent,
};

/** What people see of an import: never the token. */
export function importOf(row: ImportRow): PlatformImport {
  const report = row.report ? PlatformReport.safeParse(row.report) : null;
  return {
    id: row.id,
    platform: ImportPlatform.parse(row.platform),
    address: row.address ?? '',
    baseId: row.base_id,
    name: row.name,
    databaseId: row.database_id,
    state: row.state,
    progress: { ...EMPTY_PROGRESS, ...row.progress },
    version: row.version,
    error: row.error ? { messageKey: row.error.messageKey, params: row.error.params ?? {} } : null,
    report: report?.success ? report.data : null,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}
