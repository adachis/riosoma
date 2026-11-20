import {
  TELEMETRY_FEATURES,
  TELEMETRY_SIZES,
  TELEMETRY_USES,
  type InstallMethod,
  type TelemetryFeature,
  type TelemetryPayload,
  type TelemetrySize,
  type TelemetryUse,
  type TelemetryUseRange,
} from '@riosoma/contracts';
import type pg from 'pg';
import type { RuntimeConfig } from '../config.js';

const DAY_MS = 24 * 60 * 60_000;

/** The Monday, at midnight UTC, that starts the week `now` is in */
function weekStart(now: Date): Date {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}

/** The last whole week before `now`: from its Monday up to the Monday after */
export function lastWeek(now: Date): { from: Date; to: Date; label: string } {
  const to = weekStart(now);
  const from = new Date(to.getTime() - 7 * DAY_MS);
  return { from, to, label: from.toISOString().slice(0, 10) };
}

/**
 * The version as a release names it, or `custom`.  An operator can set any version string, and one
 * that isn't a release's could name the organization, so only release versions are sent.
 */
export function reportedVersion(version: string): string {
  return /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:alpha|beta|rc|dev)(?:\.\d{1,9})?)?$/.test(version)
    ? version
    : 'custom';
}

export function sizeOf(records: number): TelemetrySize {
  if (records < 1) return '0';
  if (records < 100) return '1-99';
  if (records < 1_000) return '100-999';
  if (records < 10_000) return '1000-9999';
  if (records < 100_000) return '10000-99999';
  if (records < 1_000_000) return '100000-999999';
  return '1000000+';
}

/**
 * How often something was used, as a range.  Exact numbers from a small install would describe
 * what one person did in their week, so only the order of magnitude goes.
 */
export function useRange(count: number): TelemetryUseRange {
  if (count < 1) return '0';
  if (count < 10) return '1-9';
  if (count < 100) return '10-99';
  if (count < 1_000) return '100-999';
  return '1000+';
}

function sizes(counts: Iterable<number>): Record<TelemetrySize, number> {
  const result = Object.fromEntries(TELEMETRY_SIZES.map((size) => [size, 0])) as Record<
    TelemetrySize,
    number
  >;
  for (const records of counts) result[sizeOf(records)] += 1;
  return result;
}

/** Whether each feature is in use: one row that says so is enough. */
function featureSql(app: string): string {
  const any = (table: string, where = 'TRUE') => `EXISTS (SELECT 1 FROM ${app}.${table} WHERE ${where})`;
  return `SELECT
    ${any('ai_keys')} AS "aiProviders",
    ${any('automations', 'enabled AND trashed_at IS NULL')} AS automations,
    ${any('booking_pages', 'enabled')} AS "bookingPages",
    ${any('calendar_feeds')} AS "calendarFeeds",
    ${any('custom_domains', 'verified_at IS NOT NULL AND removed_at IS NULL')} AS "customDomains",
    ${any('dashboards', 'trashed_at IS NULL')} AS dashboards,
    ${any('sources')} AS "dataSources",
    ${any('interfaces', 'trashed_at IS NULL')} AS interfaces,
    ${any('oauth_clients')} AS "oauthApps",
    ${any('org_units')} AS "orgUnits",
    ${any('stripe_connections', 'enabled')} AS payments,
    ${any('public_forms', 'stopped_at IS NULL')} AS "publicForms",
    ${any('published_sites', 'published')} AS "publishedSites",
    ${any('report_schedules', 'enabled')} AS "scheduledReports",
    ${any('scim_settings')} AS scim,
    ${any('scripts', 'trashed_at IS NULL')} AS scripts,
    ${any('shared_views', 'stopped_at IS NULL')} AS "sharedViews",
    ${any('signature_requests')} AS signatures,
    ${any('sso_providers', 'enabled')} AS "singleSignOn",
    ${any('sql_logins', 'enabled')} AS "sqlAccess",
    ${any('webhooks', 'enabled')} AS webhooks`;
}

/** How many times each thing happened in the week, counted from what Riosoma already records */
function useSql(app: string, audit: string): string {
  const count = (table: string, column: string, where = 'TRUE') =>
    `(SELECT count(*) FROM ${table} WHERE ${column} >= $1 AND ${column} < $2 AND ${where})::bigint`;
  return `SELECT
    ${count(`${app}.ai_field_runs`, 'created_at')} AS "aiFieldRuns",
    ${count(`${app}.automation_runs`, 'queued_at')} AS "automationRuns",
    ${count(`${app}.bookings`, 'created_at')} AS bookings,
    ${count(`${app}.changes`, 'at')} AS changes,
    ${count(`${app}.comments`, 'created_at')} AS comments,
    ${count(`${app}.files`, 'created_at')} AS "fileUploads",
    ${count(`${app}.report_runs`, 'due_at')} AS "reportRuns",
    ${count(`${app}.rio_messages`, 'created_at', "role = 'person'")} AS "rioMessages",
    ${count(`${audit}.events`, 'at', `action = 'auth.sign_in' AND org_id IN (SELECT id FROM ${app}.orgs)`)} AS "signIns",
    ${count(`${app}.signature_requests`, 'created_at')} AS "signatureRequests",
    ${count(`${app}.sql_history`, 'created_at')} AS "sqlQueries",
    ${count(`${app}.webhook_deliveries`, 'created_at')} AS "webhookDeliveries"`;
}

/**
 * One week's usage counts, built only from counts, ranges, and on or off flags.  Names, record values,
 * email addresses, and network addresses never come into it: each query returns a number or a
 * yes or no, and nothing else is read.  The same call builds the preview the owner sees and the
 * payload that's sent, so they can't differ.
 */
export async function collectPayload(
  db: pg.Pool,
  schemas: { app: string; data: string; audit: string },
  config: RuntimeConfig,
  version: string,
  installId: string,
  now: Date,
): Promise<TelemetryPayload> {
  const week = lastWeek(now);
  const { app, audit } = schemas;
  // Each table's records, from PostgreSQL's own estimates, so no table is read.
  const tables = await db.query<{ database_id: string; records: number }>(
    `SELECT t.database_id, GREATEST(COALESCE(s.n_live_tup, 0), COALESCE(c.reltuples, 0), 0)::float8 AS records
     FROM ${app}.tables t
     JOIN ${app}.databases d ON d.id = t.database_id AND d.trashed_at IS NULL
     LEFT JOIN pg_catalog.pg_class c
       ON c.relname = t.id AND c.relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $1)
     LEFT JOIN pg_catalog.pg_stat_user_tables s ON s.relid = c.oid
     WHERE t.trashed_at IS NULL`,
    [schemas.data],
  );
  const databases = await db.query<{ id: string }>(
    `SELECT id FROM ${app}.databases WHERE trashed_at IS NULL`,
  );
  const byDatabase = new Map(databases.rows.map((row) => [row.id, 0]));
  const tableSizes: number[] = [];
  for (const row of tables.rows) {
    const records = Math.round(Number(row.records));
    tableSizes.push(records);
    byDatabase.set(row.database_id, (byDatabase.get(row.database_id) ?? 0) + records);
  }
  const features = (await db.query<Record<string, boolean>>(featureSql(app))).rows[0]!;
  const uses = (await db.query<Record<string, string>>(useSql(app, audit), [week.from, week.to])).rows[0]!;
  const install: InstallMethod = config.installMethod ?? 'source';
  // The rest come from the server's settings: whether each is set, never what it's set to.
  const flags = {
    ...features,
    aiProviders: Boolean(features.aiProviders) || Object.values(config.providerApiKeys ?? {}).some(Boolean),
    email: Boolean(config.mail) || Boolean(config.smtpUrl && config.mailFrom),
    maps: config.mapStyleUrl !== null,
    objectStorage: config.filesStorage === 's3' || config.filesStorage === 'azure-blob',
    updater: Boolean(config.updater),
    virusScanning: Boolean(config.clamavUrl),
  } as Record<TelemetryFeature, boolean>;
  return {
    schema: 1,
    installId,
    week: week.label,
    version: reportedVersion(version),
    install,
    databases: sizes(byDatabase.values()),
    tables: sizes(tableSizes),
    // Only the keys the contract names, in its order, whatever the queries returned.
    features: Object.fromEntries(TELEMETRY_FEATURES.map((key) => [key, Boolean(flags[key])])) as Record<
      TelemetryFeature,
      boolean
    >,
    uses: Object.fromEntries(TELEMETRY_USES.map((key) => [key, useRange(Number(uses[key] ?? 0))])) as Record<
      TelemetryUse,
      TelemetryUseRange
    >,
  };
}
