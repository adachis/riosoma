import { ProviderError, type ProviderConfig } from '../types.js';

/**
 * One key per way a provider call can fail, so the app says the same thing about a refused key or
 * a rate limit whichever provider it came from, and the person is told what to do about it.
 */
export const PROVIDER_MESSAGE_KEYS = {
  unauthorized: 'ai.provider.unauthorized',
  rateLimited: 'ai.provider.rateLimited',
  unavailable: 'ai.provider.unavailable',
  badRequest: 'ai.provider.badRequest',
  timeout: 'ai.provider.timeout',
  filtered: 'ai.provider.filtered',
} as const;

export type ProviderMessageKey = (typeof PROVIDER_MESSAGE_KEYS)[keyof typeof PROVIDER_MESSAGE_KEYS];

/** A provider's words travel with an error into a detail field, so only their start is worth keeping. */
const DETAIL_LIMIT = 400;
/** A snippet of a payload in an error, enough to recognize it and short enough to log. */
const SNIPPET_LIMIT = 160;
/** Never wait longer than a minute for a rate limit, whatever the provider asked for. */
const RETRY_AFTER_LIMIT_MS = 60_000;

/**
 * A failure worth another attempt that also carries the wait the provider asked for.  `ProviderError`
 * has no room for it, and callers only ever need it when deciding how long to sleep.
 */
export class RetryableProviderError extends ProviderError {
  readonly retryAfterMs: number | undefined;

  constructor(
    messageKey: string,
    status: number | undefined,
    detail: string | undefined,
    retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(messageKey, status, detail, true, undefined, options);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Values that must never reach a detail, a log line, or a person's screen. */
export function secretsOf(config: ProviderConfig): string[] {
  const secrets = config.apiKey ? [config.apiKey] : [];
  if (config.aws)
    secrets.push(config.aws.accessKeyId, config.aws.secretAccessKey, config.aws.sessionToken ?? '');
  for (const [name, value] of Object.entries(config.headers ?? {})) {
    // A workspace or account header identifies the account; anything that authorizes it is a secret.
    if (value && (config.auth || /auth|key|token|secret/i.test(name))) secrets.push(value);
  }
  return secrets;
}

/** Replaces known secrets, and anything shaped like one, so an error is safe to show and to log. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (secret.length >= 4) scrubbed = scrubbed.split(secret).join('[redacted]');
  }
  // An error page from a proxy in between can echo a credential the provider never saw.
  return scrubbed
    .replace(/\b(?:sk|pk|rk|gsk|xai|key)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/(bearer\s+)[^\s"',;]+/gi, '$1[redacted]');
}

/** A short, scrubbed piece of a payload, for an error about the payload itself. */
export function snippet(text: string, secrets: readonly string[] = []): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.length > SNIPPET_LIMIT ? `${flat.slice(0, SNIPPET_LIMIT)}…` : flat;
  return scrubSecrets(cut, secrets);
}

/** Reads a JSON payload, or fails as the provider's fault rather than a crash. */
export function parseJson<T>(text: string, secrets: readonly string[], where: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw unexpectedResponse(`${where} was not JSON: ${snippet(text, secrets)}`);
  }
}

/** A provider that answered with something unusable: not the caller's fault, and not worth a retry. */
export function unexpectedResponse(detail: string): ProviderError {
  return new ProviderError(PROVIDER_MESSAGE_KEYS.unavailable, undefined, detail);
}

/** The provider, or a policy in front of it, refused the content. */
export function filteredResponse(detail?: string): ProviderError {
  return new ProviderError(PROVIDER_MESSAGE_KEYS.filtered, undefined, detail);
}

/** A socket-level failure: the provider may simply have had a bad moment. */
export function networkFailure(cause: unknown, secrets: readonly string[]): ProviderError {
  const detail =
    cause instanceof Error && cause.message ? cause.message : 'The provider could not be reached';
  return new RetryableProviderError(
    PROVIDER_MESSAGE_KEYS.unavailable,
    undefined,
    scrubSecrets(detail, secrets),
    undefined,
    { cause },
  );
}

const FAILURE_MESSAGE_KEYS = [
  ...Object.values(PROVIDER_MESSAGE_KEYS),
  'ai.gateway.unreachable',
  'ai.gateway.tls',
  'ai.gateway.rejectedKey',
  'ai.gateway.wrongPath',
  'ai.gateway.modelNotFound',
  'ai.gateway.requestBufferTooSmall',
  'ai.gateway.modelRestricted',
  'ai.gateway.requestTooLarge',
  'ai.gateway.requestFailed',
  'ai.gateway.invalidResponse',
] as const;
type FailureMessageKey = (typeof FAILURE_MESSAGE_KEYS)[number];

export interface ProviderFailure {
  messageKey: FailureMessageKey;
  status?: number;
  cause: string;
}

const CAUSE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'TEST_NETWORK_ISOLATED',
]);
const CAUSE_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'AggregateError',
  'AbortError',
  'TimeoutError',
  'ProviderError',
]);

/** Wrappers retain only known identifiers, since nested errors can echo credentials and model input. */
export function sanitizedProviderCause(error: unknown): { code: string } | { name: string } {
  let name = 'Error';
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const part = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof part.code === 'string' && CAUSE_CODES.has(part.code)) {
      return { code: part.code };
    }
    if (typeof part.name === 'string' && CAUSE_NAMES.has(part.name)) name = part.name;
    current = part.cause;
  }
  return { name };
}

/** Only known identifiers survive, since error messages and custom names can contain private data. */
export function providerFailure(error: unknown): ProviderFailure {
  const cause = sanitizedProviderCause(error);
  return {
    messageKey:
      error instanceof ProviderError && FAILURE_MESSAGE_KEYS.includes(error.messageKey as FailureMessageKey)
        ? (error.messageKey as FailureMessageKey)
        : PROVIDER_MESSAGE_KEYS.unavailable,
    ...(error instanceof ProviderError && Number.isInteger(error.status) ? { status: error.status } : {}),
    cause: 'code' in cause ? cause.code : cause.name,
  };
}

/** How long a rate-limited caller was told to wait, in milliseconds. */
export function retryAfterMs(headers: Headers | undefined): number | undefined {
  const value = headers?.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clampWait(seconds * 1_000);
  // `retry-after` may instead be a date; a past date means now.
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : clampWait(at - Date.now());
}

function clampWait(ms: number): number {
  return Math.max(0, Math.min(RETRY_AFTER_LIMIT_MS, Math.round(ms)));
}

/** Complete messages keep credential redaction ahead of display limits. */
export function messageFromBody(body: string): string | undefined {
  const text = body.trim();
  if (!text) return undefined;
  let detail: string | undefined;
  try {
    detail = findMessage(JSON.parse(text) as unknown);
  } catch {
    detail = undefined;
  }
  // A proxy's HTML error page holds nothing a person can act on, so it is dropped rather than shown.
  const words = (detail ?? (text.startsWith('<') ? '' : text)).trim();
  if (!words) return undefined;
  return words;
}

/** The provider's own words out of an error body, however deeply it wrapped them. */
export function detailFromBody(body: string, secrets: readonly string[]): string | undefined {
  const words = messageFromBody(body);
  if (!words) return undefined;
  return scrubSecrets(words.length > DETAIL_LIMIT ? `${words.slice(0, DETAIL_LIMIT)}…` : words, secrets);
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessage(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error_message', 'detail', 'reason', 'error']) {
    if (key in record) {
      const found = findMessage(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** Refusals are named differently by every provider, but they all say some variation of this. */
const FILTERED =
  /content[_ -]?(?:filter|policy|management)|responsible[_ -]?ai|refus|prohibited[_ -]?content|block[_ -]?reason|moderation|safety/i;

/** Turns an HTTP status into the one error shape the rest of Riosoma reasons about. */
export function errorFromStatus(
  status: number,
  body: string,
  secrets: readonly string[],
  headers?: Headers,
): ProviderError {
  const detail = detailFromBody(body, secrets);
  if (status === 401 || status === 403) {
    return new ProviderError(PROVIDER_MESSAGE_KEYS.unauthorized, status, detail);
  }
  if (status === 429) {
    return new RetryableProviderError(
      PROVIDER_MESSAGE_KEYS.rateLimited,
      status,
      detail,
      retryAfterMs(headers),
    );
  }
  if (status >= 500) {
    return new RetryableProviderError(PROVIDER_MESSAGE_KEYS.unavailable, status, detail);
  }
  if (FILTERED.test(body)) {
    return new ProviderError(PROVIDER_MESSAGE_KEYS.filtered, status, detail);
  }
  return new ProviderError(PROVIDER_MESSAGE_KEYS.badRequest, status, detail);
}

/** Turns an error a provider sent inside an otherwise healthy stream into the same shape. */
export function errorFromWire(
  failure: { message?: string; type?: string; code?: string | number | null; status?: number },
  secrets: readonly string[],
): ProviderError {
  const detail = scrubSecrets(failure.message ?? failure.type ?? 'The provider reported an error', secrets);
  const status = typeof failure.status === 'number' ? failure.status : undefined;
  // Each provider names its failures its own way; the families below are the ones that matter.
  const kind = (failure.type ?? '').toLowerCase();
  const code = String(failure.code ?? '').toLowerCase();
  if (kind === 'rate_limit_error' || kind === 'resource_exhausted' || code === 'rate_limit_exceeded') {
    return new RetryableProviderError(PROVIDER_MESSAGE_KEYS.rateLimited, status ?? 429, detail);
  }
  if (
    kind === 'authentication_error' ||
    kind === 'permission_error' ||
    kind === 'unauthenticated' ||
    kind === 'permission_denied'
  ) {
    return new ProviderError(PROVIDER_MESSAGE_KEYS.unauthorized, status ?? 401, detail);
  }
  if (
    kind === 'overloaded_error' ||
    kind === 'api_error' ||
    kind === 'internal_error' ||
    kind === 'internal' ||
    kind === 'unavailable' ||
    kind === 'deadline_exceeded'
  ) {
    return new RetryableProviderError(PROVIDER_MESSAGE_KEYS.unavailable, status, detail);
  }
  if (FILTERED.test(`${failure.type ?? ''} ${failure.code ?? ''} ${failure.message ?? ''}`)) {
    return new ProviderError(PROVIDER_MESSAGE_KEYS.filtered, status, detail);
  }
  if (
    kind === 'invalid_request_error' ||
    kind === 'invalid_argument' ||
    kind === 'failed_precondition' ||
    kind === 'not_found'
  ) {
    return new ProviderError(PROVIDER_MESSAGE_KEYS.badRequest, status ?? 400, detail);
  }
  return new RetryableProviderError(PROVIDER_MESSAGE_KEYS.unavailable, status, detail);
}
