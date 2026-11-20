import { refuseDemo } from '../demo/boundary.js';
import type { AppContext } from '../app.js';
import { appConnectionContext } from './app-connections.js';
import {
  AppError,
  APP_CATALOG,
  SourceSecrets,
  parseRequestHeaders,
  requiredSecrets,
  type SourceConnection,
  type SourceMeta,
  type SourceSelect,
  type TableSource,
  type TableSourceSettings,
  type SyncStatus,
} from '@riosoma/contracts';
import { APP_INSPECTION_TIMEOUT_MS, ConnectorError, type ConnectorContext } from '@riosoma/connectors';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { Actor } from '../http/policy.js';
import type { DataSchemas } from '../data/context.js';
import { AccessScope } from '../data/access.js';
import { unsealCredential } from '../credentials/service.js';
import { administersSource } from '../org-units/store.js';

export interface SourceRow {
  import_paused?: boolean;
  import_note?: string | null;
  id: string;
  org_id: string;
  name: string;
  description: string;
  kind: SourceConnection['kind'];
  connection: SourceConnection;
  sealed_secrets: string;
  access: 'admins' | 'creators';
  last_test: SourceMeta['lastTest'];
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export const sourceAdmin = (actor: Actor): boolean =>
  actor.kind === 'owner' || actor.adminRoles.includes('data_sources');

export async function loadSource(
  db: Queryable,
  schemas: DataSchemas,
  id: string,
  orgId: string,
): Promise<SourceRow> {
  const result = await query<SourceRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'sources')}
    WHERE id = ${id} AND org_id = ${orgId}`,
  );
  if (!result.rows[0]) throw new AppError('not_found', 'errors.notFound');
  return result.rows[0];
}

export async function requireSourceAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  source: SourceRow,
  select?: SourceSelect,
): Promise<void> {
  await new AccessScope(db, schemas, actor).requireSource(source, select);
}

export async function secretsFor(source: SourceRow, key: Buffer, db?: Queryable): Promise<SourceSecrets> {
  return SourceSecrets.parse(
    JSON.parse(await unsealCredential(key, source.sealed_secrets, `source:${source.id}`, source.org_id, db)),
  );
}

export function checkSecrets(connection: SourceConnection, secrets: SourceSecrets): void {
  if (
    connection.kind === 'app' &&
    APP_CATALOG.find((app) => app.id === connection.app)?.connect &&
    Object.keys(secrets).length
  )
    throw new AppError('validation_failed', 'sources.app.connectionSecrets');
  const missing = requiredSecrets(connection).find((name) => !secrets[name]);
  const field =
    connection.kind === 'app'
      ? APP_CATALOG.find((app) => app.id === connection.app)?.additionalSecrets?.find(
          (secret) => secret.name === missing,
        )
      : undefined;
  if (missing)
    throw new AppError(
      'validation_failed',
      connection.kind === 'app' ? 'sources.app.secretMissing' : 'sources.secretsMissing',
      field
        ? {
            params: { fieldMessageId: field.labelMessageId },
            fields: { [field.name]: 'sources.app.secretMissing' },
          }
        : {},
    );
  if (secrets.headers !== undefined && parseRequestHeaders(secrets.headers) === null)
    throw new AppError('validation_failed', 'sources.file.headers', {
      fields: { headers: 'sources.file.headers' },
    });
}

const SHOWN_PARAMS =
  /^sources\.(?:app|file|rest|google|airtable|microsoft|sharepoint|excel|dataverse|feed|webhook)\./;

/**
 * The values a connector's message may fill in.  A file source's are file and sheet names and
 * numbers, an API source's are endpoint names, statuses, and limits, a Google Sheets source's are
 * sheet names and row numbers, and a Microsoft 365 source's are statuses and limits.  Sync
 * failures expose only the missing object or column name, or a duplicate key, never connection
 * details from the driver.
 */
export function messageParams(error: ConnectorError): Record<string, string | number | boolean> | undefined {
  const name =
    error.messageKey === 'sources.sync.columnMissing'
      ? 'column'
      : error.messageKey === 'sources.sync.objectMissing'
        ? 'object'
        : error.messageKey === 'sources.sync.keyDuplicate'
          ? 'key'
          : undefined;
  if ((!name && !SHOWN_PARAMS.test(error.messageKey)) || !error.params) return undefined;
  const shown = Object.entries(error.params).filter(
    (entry): entry is [string, string | number | boolean] =>
      (!name || entry[0] === name) && ['string', 'number', 'boolean'].includes(typeof entry[1]),
  );
  return shown.length ? Object.fromEntries(shown) : undefined;
}

/**
 * The one way to a stored source's secrets for reaching it, which every connector path takes:
 * live reads, syncs, tests, previews, object lists, new synced tables, and the Airtable bases.  A
 * source an import paused has nothing unsealed and reaches nothing until the organization's owner
 * turns it on from the import review, whatever its sign-in method, even one needing no secret.
 */
export async function usableSecrets(source: SourceRow, key: Buffer, db?: Queryable): Promise<SourceSecrets> {
  refuseDemo();
  if (source.import_paused) throw new AppError('conflict', 'organizationArchive.sourcePaused');
  const secrets = await secretsFor(source, key, db);
  checkSecrets(source.connection, secrets);
  return secrets;
}

/** App discovery and permission probes need many paced requests, each with its own 30-second timeout. */
export function sourceSignal(connection: SourceConnection): AbortSignal {
  return AbortSignal.timeout(connection.kind === 'app' ? APP_INSPECTION_TIMEOUT_MS : 30_000);
}

export async function connectorContext(
  source: SourceRow,
  key: Buffer,
  signal = sourceSignal(source.connection),
  db?: Queryable,
  appContext?: AppContext,
): Promise<ConnectorContext> {
  const secrets = await usableSecrets(source, key, db);
  return connectorCall(() =>
    appConnectionContext(appContext, source.org_id, {
      connection: source.connection,
      secrets,
      signal,
      timeoutMs: 30_000,
      sourceId: source.id,
    }),
  );
}

/** Omit a driver's diagnostic when it contains any stored credential or a JSON credential member. */
export function safeDetail(detail: string | undefined, secrets: SourceSecrets): string | undefined {
  if (!detail) return undefined;
  const sensitive = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) sensitive.add(value);
    else if (value && typeof value === 'object') for (const part of Object.values(value)) collect(part);
  };
  for (const value of Object.values(secrets)) {
    collect(value);
    try {
      collect(JSON.parse(value));
    } catch {
      /* Most credentials are plain text. */
    }
  }
  return [...sensitive].some((value) => detail.includes(value) || detail.includes(encodeURIComponent(value)))
    ? undefined
    : detail;
}

/**
 * Remote exceptions cannot reach the request logger with driver-supplied credentials.  The
 * server's own refusals, such as a paused source's, carry no driver text and pass as they are.
 */
export async function connectorCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (!(error instanceof ConnectorError)) throw new AppError('validation_failed', 'sources.sync.timeout');
    const params = messageParams(error);
    throw new AppError('validation_failed', error.messageKey, params ? { params } : {});
  }
}

export async function sourceMeta(
  db: Queryable,
  schemas: DataSchemas,
  row: SourceRow,
  actor: Actor,
  key: Buffer,
): Promise<SourceMeta> {
  const count = await query<{ count: string }>(
    db,
    sql`SELECT count(*) FROM ${ident(schemas.app, 'table_sources')} WHERE source_id = ${row.id}`,
  );
  const admin = await administersSource(db, `"${schemas.app}"`, actor, row.id);
  const hook =
    row.kind === 'webhook' && admin
      ? (
          await query<{ token_created_at: Date; last_post_at: Date | null; bodies_until: Date | null }>(
            db,
            sql`SELECT token_created_at, last_post_at, bodies_until FROM ${ident(schemas.app, 'source_hooks')}
            WHERE source_id = ${row.id}`,
          )
        ).rows[0]
      : undefined;
  let secrets: SourceMeta['secrets'] = [];
  let credentialError: SourceMeta['credentialError'];
  try {
    secrets = Object.keys(await secretsFor(row, key, db)) as SourceMeta['secrets'];
  } catch (error) {
    if (!(error instanceof AppError) || error.messageKey !== 'credentials.unavailable') throw error;
    credentialError = 'credentials.unavailable';
  }
  return {
    id: row.id,
    ...(row.import_note ? { importNote: row.import_note } : {}),
    name: row.name,
    description: row.description,
    kind: row.kind,
    connection: admin ? row.connection : null,
    secrets,
    ...(credentialError ? { credentialError } : {}),
    access: row.access,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastTest: row.last_test,
    tables: Number(count.rows[0]!.count),
    ...(hook
      ? {
          webhook: {
            addressAt: hook.token_created_at.toISOString(),
            lastPostAt: hook.last_post_at?.toISOString() ?? null,
            // The log stops keeping bodies on its own once the hour is up.
            bodiesUntil:
              hook.bodies_until && hook.bodies_until.getTime() > Date.now()
                ? hook.bodies_until.toISOString()
                : null,
          },
        }
      : {}),
  };
}

export const queuedStatus = (): SyncStatus => ({
  state: 'queued',
  lastSyncAt: null,
  lastSuccessAt: null,
  nextSyncAt: new Date().toISOString(),
  error: null,
  stats: null,
  held: null,
});

/**
 * A new synced table's status: its first sync queued, or nothing to wait for when it reads live or
 * when a webhook's posts fill it as they arrive.
 */
export function initialStatus(
  settings: Pick<TableSourceSettings, 'freshness'>,
  kind: SourceConnection['kind'],
): SyncStatus {
  return settings.freshness === 'live' || kind === 'webhook'
    ? { ...queuedStatus(), state: 'idle', nextSyncAt: null }
    : queuedStatus();
}

export async function loadTableSources(
  db: Queryable,
  schemas: DataSchemas,
  ids: readonly string[],
): Promise<Map<string, TableSource>> {
  if (!ids.length) return new Map();
  const result = await query<{
    table_id: string;
    settings: TableSource;
    status: SyncStatus;
    name: string;
    kind: SourceConnection['kind'];
  }>(
    db,
    sql`SELECT ts.table_id, ts.settings, ts.status, s.name, s.kind FROM ${ident(schemas.app, 'table_sources')} ts
    JOIN ${ident(schemas.app, 'sources')} s ON s.id = ts.source_id WHERE ts.table_id = ANY(${ids}::text[])`,
  );
  return new Map(
    result.rows.map((row) => [
      row.table_id,
      { ...row.settings, sourceName: row.name, sourceKind: row.kind, status: row.status },
    ]),
  );
}
