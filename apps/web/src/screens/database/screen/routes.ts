import { idKind } from '@riosoma/contracts';
import type { SchemaState } from '../../../data/types';

export interface DatabasePath {
  databaseId: string;
  tableId?: string;
  viewId?: string;
  recordId?: string;
  recordSuffix?: string;
  /** Set on `/<databaseId>/dashboards/<dashboardId>`, which shows a dashboard instead of a table */
  dashboardId?: string;
  automationId?: string;
  namedFunctions?: boolean;
  functionId?: string;
  /** Set on `/<databaseId>/routines/<routineId>`, which shows one of the person's routines */
  routineId?: string;
  /** Set on `/<databaseId>/interfaces/<interfaceId>`, which shows an interface instead of a table */
  interfaceId?: string;
  /** The interface's page, `/<databaseId>/interfaces/<interfaceId>/<pageId>` */
  pageId?: string;
}

export function resolveDatabasePath(schema: SchemaState, path: DatabasePath) {
  const requestedTable =
    path.tableId && idKind(path.tableId) === 'table' ? schema.tableById.get(path.tableId) : undefined;
  const table = requestedTable ?? schema.tables[0];
  const requestedView =
    path.viewId && idKind(path.viewId) === 'view' ? schema.viewById.get(path.viewId) : undefined;
  const view =
    requestedView?.tableId === table?.id
      ? requestedView
      : table
        ? schema.views.get(table.id)?.[0]
        : undefined;
  const stale = Boolean(
    (path.tableId && !requestedTable) ||
    (path.viewId && (!requestedView || requestedView.tableId !== table?.id)) ||
    (path.recordId && idKind(path.recordId) !== 'record'),
  );
  return {
    table,
    view,
    stale: stale || Boolean(path.recordSuffix && path.recordSuffix !== 'page'),
    recordPage: !stale && path.recordSuffix === 'page',
    recordId: !stale && path.recordId && idKind(path.recordId) === 'record' ? path.recordId : undefined,
  };
}

export function automationHref(databaseId: string, automationId: string): string {
  return `/${encodeURIComponent(databaseId)}/automations/${encodeURIComponent(automationId)}`;
}

export function databaseHref(
  databaseId: string,
  tableId?: string,
  viewId?: string,
  recordId?: string,
): string {
  return `/${[databaseId, tableId, viewId, recordId]
    .filter(Boolean)
    .map((id) => encodeURIComponent(id!))
    .join('/')}`;
}

export function dashboardHref(databaseId: string, dashboardId: string): string {
  return `/${encodeURIComponent(databaseId)}/dashboards/${encodeURIComponent(dashboardId)}`;
}

/**
 * An interface, or one of its pages, with the record picked in one of the page's records blocks:
 * `/<databaseId>/interfaces/<interfaceId>/<pageId>?block=<blockId>&record=<recordId>`.
 */
export function interfaceHref(
  databaseId: string,
  interfaceId: string,
  pageId?: string,
  selected?: { blockId: string; recordId: string },
): string {
  const path = [databaseId, 'interfaces', interfaceId, ...(pageId ? [pageId] : [])]
    .map((part) => encodeURIComponent(part))
    .join('/');
  const search = selected
    ? `?${new URLSearchParams({ block: selected.blockId, record: selected.recordId }).toString()}`
    : '';
  return `/${path}${search}`;
}

/** The page keeps the same database, table, view, and record address as an expanded record. */
export function recordPageHref(
  databaseId: string,
  tableId: string,
  viewId: string,
  recordId: string,
): string {
  return `${databaseHref(databaseId, tableId, viewId, recordId)}/page`;
}

export function namedFunctionsHref(databaseId: string, functionId?: string): string {
  return `/${encodeURIComponent(databaseId)}/named-functions${functionId ? `/${encodeURIComponent(functionId)}` : ''}`;
}
