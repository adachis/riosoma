import type { ErrorCode, ErrorBody } from '@riosoma/contracts';
import type { ResponseParts } from './types.js';

/** What a failed call says about itself. */
export interface ApiErrorInfo {
  /** The API's own code, such as `not_found` or `rate_limited` */
  code: ErrorCode;
  /**
   * The message key a Riosoma interface translates, or empty when the answer came from the
   * Airtable-compatible routes, which carry plain English only.
   */
  messageKey: string;
  /** Plain English, safe to show someone who reads the API's answers directly */
  message: string;
  params?: Record<string, unknown>;
  /** A problem with one field, keyed the way the request keyed fields */
  fields?: Record<string, string>;
  /** A problem with one cell of a write, which says the record and field it found */
  issues?: ErrorBody['error']['issues'];
  /** The compatible API's own error type, such as `UNKNOWN_FIELD_NAME`, when the answer came from it */
  type?: string;
}

/**
 * A call the server answered with a failure.  `status` is what it answered with, `code` says which
 * kind of failure it was, and `message` is English text a caller may show.  Nothing here carries a
 * credential: the transport takes secrets out of an answer before it becomes an error.
 */
export class RioApiError extends Error {
  constructor(
    readonly status: number,
    readonly info: ApiErrorInfo,
    readonly details: { undoGroupId?: string | null; retryAfterSeconds?: number | null } = {},
  ) {
    super(info.message || info.messageKey || `the API answered ${status}`);
    this.name = 'RioApiError';
  }

  get code(): ErrorCode {
    return this.info.code;
  }

  get messageKey(): string {
    return this.info.messageKey;
  }

  get params(): Record<string, unknown> | undefined {
    return this.info.params;
  }

  get fields(): Record<string, string> | undefined {
    return this.info.fields;
  }

  get issues(): ErrorBody['error']['issues'] {
    return this.info.issues;
  }

  /** How long the server asked a caller to wait, which only a rate limit answers with */
  get retryAfterSeconds(): number | null {
    return this.details.retryAfterSeconds ?? null;
  }

  /** The undo group of a write that failed partway, so a caller can take back what did land */
  get undoGroupId(): string | null {
    return this.details.undoGroupId ?? null;
  }

  /** Whether trying the same call again could succeed, which a rate limit or a system fault allows */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * A call that never reached the server, or an answer nothing can read: the options were wrong, no
 * credential was given, the address could not be reached, or the body was not the JSON the API
 * sends.  A caller that catches failures can tell this apart from `RioApiError` by its class.
 */
export class RioClientError extends Error {
  constructor(
    message: string,
    readonly details: { code?: ClientErrorCode; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'RioClientError';
  }

  get code(): ClientErrorCode {
    return this.details.code ?? 'client_error';
  }
}

export const CLIENT_ERROR_CODES = [
  'client_error',
  /** The options a client was built with can't work together */
  'invalid_options',
  /** No credential was given, or the one given has the wrong shape */
  'invalid_credentials',
  /** The server could not be reached, or the answer never arrived */
  'unreachable',
  /** An answer arrived that isn't what the API sends */
  'unreadable',
  /** A caller gave up before the answer arrived */
  'aborted',
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

/** Whether a failure is a caller giving up, which is never worth turning into something else. */
export function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** The code an HTTP status stands for, for an answer that carried no error body of its own. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'gone';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'internal';
  return 'bad_request';
}

/** The compatible API's own error types, in the API's terms. */
const COMPATIBLE_CODES: Record<string, ErrorCode> = {
  AUTHENTICATION_REQUIRED: 'unauthenticated',
  INVALID_PERMISSIONS: 'forbidden',
  INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND: 'not_found',
  NOT_FOUND: 'not_found',
  RATE_LIMIT_REACHED: 'rate_limited',
  SERVICE_UNAVAILABLE: 'unavailable',
};

/**
 * The error an answer carries.  Both of the API's shapes are read: the REST API's own, with a code
 * and a message key an interface can translate, and the Airtable-compatible one, which names an
 * error type and writes its message in English.
 */
export function apiError(
  status: number,
  text: string,
  headers: ResponseParts,
  details: { undoGroupId?: string | null; retryAfterSeconds?: number | null } = {},
): RioApiError {
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // An answer that isn't JSON has no error body to read, and its text says the rest.
  }
  const found = isRecord((body as { error?: unknown } | null)?.error)
    ? (body as { error: Record<string, unknown> }).error
    : null;
  if (found && typeof found.type === 'string')
    return new RioApiError(
      status,
      {
        code: COMPATIBLE_CODES[found.type] ?? codeForStatus(status),
        messageKey: '',
        message: typeof found.message === 'string' ? found.message : found.type,
        type: found.type,
        ...(isRecord(found.params) ? { params: found.params } : {}),
        ...(isStringRecord(found.fields) ? { fields: found.fields } : {}),
      },
      details,
    );
  if (found && typeof found.messageKey === 'string')
    return new RioApiError(
      status,
      {
        code: typeof found.code === 'string' ? (found.code as ErrorCode) : codeForStatus(status),
        messageKey: found.messageKey,
        message: typeof found.message === 'string' ? found.message : found.messageKey,
        ...(isRecord(found.params) ? { params: found.params } : {}),
        ...(isStringRecord(found.fields) ? { fields: found.fields } : {}),
        ...(Array.isArray(found.issues) ? { issues: found.issues as ApiErrorInfo['issues'] } : {}),
      },
      details,
    );
  return new RioApiError(
    status,
    {
      code: codeForStatus(status),
      messageKey: '',
      message: text ? truncate(text) : `The API answered ${status}.`,
    },
    details,
  );
}

/** How long an answer's `Retry-After` asks a caller to wait, in whole seconds. */
export function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d{1,7}$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.round((date - Date.now()) / 1_000));
}

export function truncate(text: string, length = 200): string {
  const plain = text.trim();
  return plain.length > length ? `${plain.slice(0, length)}…` : plain;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}
