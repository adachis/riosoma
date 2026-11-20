import { AIRTABLE_IMPORT_LIMITS, AirtableReport, type AirtableImport } from '@riosoma/contracts';
import type { Queryable } from '@riosoma/db';
import type { DataSchemas } from '../../context.js';
import * as core from '../core/store.js';
import { EMPTY_PROGRESS, type ImportRow, type ImportTable } from '../core/store.js';

/**
 * Airtable imports as rows, in a table of their own.  The sealed token never leaves the store
 * except to the importer.
 */

export { EMPTY_PROGRESS, type ImportRow } from '../core/store.js';

export const AIRTABLE_TABLE: ImportTable = {
  name: 'airtable_imports',
  interrupted: 'import.airtable.interrupted',
  recent: AIRTABLE_IMPORT_LIMITS.recent,
};

/** What people see of an import: never the token. */
export function importOf(row: ImportRow): AirtableImport {
  const report = row.report ? AirtableReport.safeParse(row.report) : null;
  return {
    id: row.id,
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

export function loadImport(db: Queryable, schemas: DataSchemas, id: string): Promise<ImportRow | null> {
  return core.loadImport(db, schemas, AIRTABLE_TABLE, id);
}

export function recentImports(db: Queryable, schemas: DataSchemas, userId: string, orgId: string) {
  return core.recentImports(db, schemas, AIRTABLE_TABLE, userId, orgId);
}

export function databaseImports(db: Queryable, schemas: DataSchemas, databaseId: string) {
  return core.databaseImports(db, schemas, AIRTABLE_TABLE, databaseId);
}
