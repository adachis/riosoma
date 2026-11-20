import {
  AppError,
  FileScannerSettings,
  FileSafetySettings,
  FileSettings,
  type FileSettingsView,
  type FileScannerInfo,
  type FileScannerStatus,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { RuntimeConfig } from '../../config.js';
import { digest, scope, type AdminContext } from '../organization-admin/store.js';
import { DEFAULT_SCANNER_ADDRESSES, detectScanners, scannerStatus } from './clamd.js';

export function approvedScannerAddresses(config: RuntimeConfig): string[] {
  return [
    ...new Set([
      ...(config.clamavUrl ? [config.clamavUrl] : []),
      ...(config.clamavApprovedUrls ?? DEFAULT_SCANNER_ADDRESSES),
    ]),
  ];
}

export function requireApprovedScanner(address: string, config: RuntimeConfig): void {
  if (!approvedScannerAddresses(config).includes(address))
    throw new AppError('forbidden', 'files.scanner.addressNotApproved');
}

async function approvedScannerStatus(
  address: string | null,
  config: RuntimeConfig,
  test = false,
): Promise<FileScannerStatus> {
  if (address && !approvedScannerAddresses(config).includes(address)) {
    return {
      address,
      reachable: false,
      tested: false,
      signatureDate: null,
      lastError: 'files.scanner.addressNotApproved',
    };
  }
  return scannerStatus(address, test);
}

export async function scannerInfo(c: AdminContext, config: RuntimeConfig): Promise<FileScannerInfo> {
  await scope(c).requireOrganizationAdmin('security');
  const settings = await scannerSettings(c.db, c.schemas.app, c.actor.orgId, config);
  const status = await approvedScannerStatus(settings.address, config);
  const previous = await query<{ status: FileScannerStatus | null }>(
    c.db,
    sql`SELECT settings->'fileScannerStatus' AS status FROM ${ident(c.schemas.app, 'orgs')} WHERE id = ${c.actor.orgId}`,
  );
  const stored = previous.rows[0]?.status;
  if (!status.lastError && stored?.address === status.address) status.lastError = stored.lastError;
  return { settings, status };
}

export async function probeScanner(
  c: AdminContext,
  config: RuntimeConfig,
  action: 'detect' | 'test',
  requested?: string | null,
): Promise<FileScannerStatus> {
  await scope(c).requireOrganizationAdmin('security');
  const settings = await scannerSettings(c.db, c.schemas.app, c.actor.orgId, config);
  const address =
    requested === undefined ? (settings.address ?? config.clamavUrl) : (requested ?? config.clamavUrl);
  if (address) requireApprovedScanner(address, config);
  const status =
    action === 'detect'
      ? await detectScanners([...(address ? [address] : []), ...approvedScannerAddresses(config)])
      : await approvedScannerStatus(address ?? null, config, true);
  await recordScannerStatus(c.db, c.schemas.app, c.actor.orgId, status, true);
  return status;
}

export async function changeScannerSettings(
  c: AdminContext,
  config: RuntimeConfig,
  settings: FileScannerSettings,
): Promise<{ before: FileScannerSettings; info: FileScannerInfo; error?: string }> {
  await scope(c).requireOrganizationAdmin('security');
  const before = await scannerSettings(c.db, c.schemas.app, c.actor.orgId, config);
  if (settings.enabled && !settings.address)
    throw new AppError('bad_request', 'files.scanner.addressRequired');
  const validate = settings.enabled && (!before.enabled || before.address !== settings.address);
  if (settings.address && (validate || before.address !== settings.address))
    requireApprovedScanner(settings.address, config);
  const status = await approvedScannerStatus(settings.address, config, validate);
  await recordScannerStatus(c.db, c.schemas.app, c.actor.orgId, status, validate);
  if (validate && !status.tested)
    return {
      before,
      info: { settings: before, status },
      error: status.lastError ?? 'files.scanner.testFailed',
    };
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'orgs')}
    SET settings = jsonb_set(settings, '{fileScanner}', ${JSON.stringify(settings)}::jsonb)
    WHERE id = ${c.actor.orgId}`,
  );
  if (before.address !== settings.address && settings.enabled) {
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'files')}
      SET scan_state = 'quarantined', scan_next_at = now(), scan_attempts = 0
      WHERE org_id = ${c.actor.orgId} AND scan_state IN ('too_large', 'too_large_allowed', 'unavailable', 'quarantined')
        AND scan_next_at <> 'infinity'::timestamptz`,
    );
  } else {
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, 'files')}
      SET scan_state = ${settings.oversizedPolicy === 'allow' ? 'too_large_allowed' : 'too_large'}
      WHERE org_id = ${c.actor.orgId} AND scan_state IN ('too_large', 'too_large_allowed')`,
    );
  }
  return { before, info: { settings, status } };
}

/** Internal upload callers authorize their target through AccessScope before reading this policy. */
export async function fileSettings(db: Queryable, schema: string, orgId: string): Promise<FileSettings> {
  const result = await query<{ files: unknown }>(
    db,
    sql`SELECT settings->'files' AS files FROM ${ident(schema, 'orgs')} WHERE id = ${orgId}`,
  );
  return FileSettings.parse(result.rows[0]?.files ?? {});
}

export async function uploadLimit(db: Queryable, schema: string, orgId: string): Promise<number> {
  return (await fileSettings(db, schema, orgId)).maxUploadBytes ?? Infinity;
}

export async function fileSafetySettings(
  db: Queryable,
  schema: string,
  orgId: string,
): Promise<FileSafetySettings> {
  const result = await query<{ safety: unknown }>(
    db,
    sql`SELECT settings->'fileSafety' AS safety FROM ${ident(schema, 'orgs')} WHERE id = ${orgId}`,
  );
  return FileSafetySettings.parse(result.rows[0]?.safety ?? {});
}

export async function fileSafetySettingsView(c: AdminContext): Promise<FileSafetySettings> {
  await scope(c).requireOrganizationAdmin('security');
  return fileSafetySettings(c.db, c.schemas.app, c.actor.orgId);
}

export async function fileSettingsView(c: AdminContext): Promise<FileSettingsView> {
  await scope(c).requireOrganizationAdmin('security');
  const settings = await fileSettings(c.db, c.schemas.app, c.actor.orgId);
  return { ...settings, revision: digest(settings) };
}

export async function scannerSettings(
  db: Queryable,
  schema: string,
  orgId: string,
  config: RuntimeConfig,
): Promise<FileScannerSettings> {
  const result = await query<{ scanner: unknown }>(
    db,
    sql`SELECT settings->'fileScanner' AS scanner FROM ${ident(schema, 'orgs')} WHERE id = ${orgId}`,
  );
  return FileScannerSettings.parse(
    result.rows[0]?.scanner ?? {
      enabled: Boolean(config.clamavUrl),
      address: config.clamavUrl ?? null,
      oversizedPolicy: 'quarantine',
    },
  );
}

export async function recordScannerStatus(
  db: Queryable,
  schema: string,
  orgId: string,
  status: FileScannerStatus,
  selfTest = false,
): Promise<void> {
  await query(
    db,
    sql`UPDATE ${ident(schema, 'orgs')}
    SET settings = jsonb_set(settings, '{fileScannerStatus}', ${JSON.stringify(status)}::jsonb)
    WHERE id = ${orgId}`,
  );
  if (selfTest)
    await query(
      db,
      sql`UPDATE ${ident(schema, 'orgs')}
    SET settings = jsonb_set(settings, '{fileScannerSelfTest}', ${JSON.stringify(status)}::jsonb)
    WHERE id = ${orgId}`,
    );
}
