import { MigrationError, NewerDatabaseError } from '@riosoma/db';
import { startupMessage } from './startup-messages.js';

/** Configuration failures carry only static descriptions, never parser input or causes. */
const DESCRIPTIONS = {
  invalid: 'is invalid',
  demoAccount: 'demo.account.invalid',
  url: 'is not a valid URL',
  protocol: 'must start with postgres:// or postgresql://',
  tlsMode: 'sslmode must be one of: disable, prefer, require, verify-ca, verify-full',
  setupToken: 'must contain at least 16 characters using only A-Z, a-z, 0-9, - and _',
  secretKey: 'must be 32 bytes, base64-encoded',
  sealed: 'was sealed with a different secret key',
  requiredLocal: 'is required when RIOSOMA_FILES_STORAGE is local',
  requiredS3: 'is required for S3-compatible file storage',
  requiredS3Place: 'or RIOSOMA_FILES_S3_ENDPOINT is required for S3-compatible file storage',
  kmsKey: 'needs RIOSOMA_FILES_S3_SSE set to aws:kms',
  requiredAzure: 'is required for Azure Blob file storage',
  requiredMail: 'is required by the mail transport RIOSOMA_MAIL_TRANSPORT names',
  storageCheck: 'failed its start check: the server could not write, read, and delete a test file',
} as const;

export class ConfigurationError extends Error {
  readonly messageKey: string;
  /**
   * What went wrong, for reasons that need it, from a closed vocabulary: an HTTP status, a storage
   * service's error code, or a system error code.  Never a value from the settings.
   */
  readonly detail: string | undefined;
  constructor(
    readonly setting: string,
    readonly reason: keyof typeof DESCRIPTIONS = 'invalid',
    detail?: string,
  ) {
    super(
      `${setting} ${reason === 'demoAccount' ? startupMessage('demo.account.invalid') : DESCRIPTIONS[reason]}${safeDetail(detail) ? ` (${safeDetail(detail)})` : ''}`,
    );
    this.name = 'ConfigurationError';
    this.messageKey = reason === 'demoAccount' ? 'demo.account.invalid' : 'config.invalid';
    this.detail = safeDetail(detail);
  }
}

function safeDetail(detail: string | undefined): string | undefined {
  return detail && /^[A-Za-z0-9 ._:-]{1,120}$/.test(detail) ? detail : undefined;
}

/** Never serialize the original error: driver errors can include credentials and query values. */
export function startupFailure(error: unknown) {
  if (error instanceof MigrationError) {
    return {
      code: error instanceof NewerDatabaseError ? 'database_newer' : 'startup_failed',
      messageKey: error.messageKey,
      message: startupMessage(error.messageKey),
      ...(error.migrationId ? { migrationId: error.migrationId } : {}),
      ...sqlstateMetadata(error.cause),
    };
  }
  if (error instanceof ConfigurationError) {
    return {
      code: 'configuration_invalid',
      messageKey: error.messageKey,
      setting: error.setting,
      message: `${error.setting} ${error.reason === 'demoAccount' ? startupMessage('demo.account.invalid') : DESCRIPTIONS[error.reason]}`,
      ...(error.detail ? { detail: error.detail } : {}),
    };
  }
  // A database error's SQLSTATE names the kind of failure (a lock wait, a timeout, a missing
  // privilege) without carrying any values, so it's safe to log where the error itself isn't.
  return {
    code: 'startup_failed',
    messageKey: 'server.startup.failed',
    ...sqlstateMetadata(error),
  };
}

function sqlstateMetadata(error: unknown) {
  const sqlstate = (error as { code?: unknown } | null)?.code;
  return typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate) ? { sqlstate } : {};
}
