import type { HttpEngineKind } from '@riosoma/contracts';
import type { SecretName, SourceConnection, SourceSecrets, SourceSelect } from '@riosoma/contracts';
import { scrub } from '../common.js';
import { FileNetworkError } from '../files/network.js';
import { positive } from '../sql.js';
import { ConnectorError, type ConnectorContext } from '../types.js';

/**
 * How a warehouse connector fails.  Every key here has text people can read, and every word a
 * driver says passes through the scrubber on its way out, since drivers echo connection strings,
 * tokens, and keys into their errors.
 */
export const KEYS = {
  /** A call failed, or a read broke partway, and the detail carries the driver's words */
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  columnMissing: 'sources.sync.columnMissing',
  /** A secret this connection needs isn't stored */
  secretsMissing: 'sources.secretsMissing',
  /** The budget ran out, which a connection test reports as its own step */
  timeout: 'sources.test.timeout',
  /** An analytics engine's host is on a private network, which the server's rule forbids */
  blocked: 'sources.analytics.blocked',
  /** A connection test passed, and the source has nothing to sync yet */
  noDatasources: 'sources.test.noDatasources',
} as const;

export type WarehouseKind =
  | HttpEngineKind
  | 'athena'
  | 'duckdb-file'
  | 'snowflake'
  | 'bigquery'
  | 'databricks'
  | 'motherduck'
  | 'clickhouse'
  | 'trino'
  | 'druid';

/** What a driver's error says the source doesn't have. */
export type Missing = { kind: 'object' } | { kind: 'column'; column: string };

/** Long enough to say what went wrong, short enough not to fill a status row with a driver's essay. */
const DETAIL_LIMIT = 1_000;
const REDACTED = '[redacted]';

/** Shapes that carry a credential inside text a driver hands back, beyond what `scrub` knows. */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // A private key quoted back, whole or cut short.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(authorization)\s*[:=]\s*[^\r\n,;]+/gi, `$1: ${REDACTED}`],
  // Members of a JSON credential, like a service account key's.
  [
    /("(?:private_key|private_key_id|client_secret|refresh_token|access_token|id_token|token)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    `$1"${REDACTED}"`,
  ],
  // Settings that carry a credential in a connection string or a query string.
  [
    /\b(\w*token|\w*secret|\w*password|passphrase|api[_-]?key|private[_-]?key\w*)=[^\s&;,)'"]+/gi,
    `$1=${REDACTED}`,
  ],
];

/**
 * Every part of every stored secret, longest first.  A service account key is JSON, and a driver
 * quotes its parts, like the key's ID or the account's address, rather than the whole document.
 */
function secretParts(secrets: SourceSecrets): string[] {
  const parts = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.length >= 4) parts.add(value);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) collect(item);
    }
  };
  for (const value of Object.values(secrets)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    parts.add(value);
    try {
      collect(JSON.parse(value));
    } catch {
      // Most secrets are plain text.
    }
  }
  return [...parts].sort((left, right) => right.length - left.length);
}

/** An error's own words, with its code and the errors it wraps. */
export function wordsOf(error: unknown): string {
  if (error instanceof ConnectorError) return error.detail ?? '';
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    let text = error.message;
    if ((typeof code === 'string' || typeof code === 'number') && !text.includes(String(code)))
      text += ` (${code})`;
    if (error.cause !== undefined && error.cause !== null) text += `: ${wordsOf(error.cause)}`;
    return text;
  }
  return typeof error === 'string' ? error : error === null || error === undefined ? '' : String(error);
}

/** A driver's words, safe to show: no secret, no part of one, and no shape that carries one. */
export function scrubDetail(error: unknown, ctx: ConnectorContext): string | undefined {
  let text = wordsOf(error).trim();
  if (text.length === 0) return undefined;
  for (const part of secretParts(ctx.secrets))
    text = text.split(part).join(REDACTED).split(encodeURIComponent(part)).join(REDACTED);
  text = scrub(text, ctx);
  for (const [shape, replacement] of SHAPES) text = text.replace(shape, replacement);
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/**
 * The error a call leaves with: its own when it has one, a missing table or column when the
 * driver says so, and otherwise a failed read with the driver's scrubbed words.
 */
export function failure(
  error: unknown,
  ctx: ConnectorContext,
  select: SourceSelect | undefined,
  missing: (detail: string, error: unknown) => Missing | null,
): ConnectorError {
  if (error instanceof ConnectorError) {
    // Outside a connection test, running out of time is a read that didn't finish.
    const timedOut = error.messageKey === KEYS.timeout;
    const detail =
      error.detail !== undefined
        ? scrubDetail(error.detail, ctx)
        : timedOut
          ? `the source took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
          : ctx.signal?.aborted
            ? 'the call was stopped before it finished'
            : undefined;
    return new ConnectorError(
      timedOut ? KEYS.read : error.messageKey,
      detail,
      timedOut ? { ...error.params, reason: 'timeout' } : error.params,
    );
  }
  const detail = scrubDetail(error, ctx);
  if (blockedByRule(error)) return new ConnectorError(KEYS.blocked, detail);
  const found = missing(detail ?? '', error);
  if (found?.kind === 'object')
    return new ConnectorError(KEYS.objectMissing, detail, {
      object: select?.kind === 'object' ? select.object.name : '',
    });
  if (found?.kind === 'column')
    return new ConnectorError(KEYS.columnMissing, detail, { column: found.column });
  return new ConnectorError(KEYS.read, detail);
}

/** Whether an error, or one it wraps, is the server's rule refusing a host on a private network. */
export function blockedByRule(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof FileNetworkError && current.problem === 'blocked') return true;
    if (current instanceof ConnectorError && current.messageKey === KEYS.blocked) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/** A table or view the source doesn't have, named the way the SQL connectors name one. */
export function objectMissing(name: string, detail?: string): ConnectorError {
  return new ConnectorError(KEYS.objectMissing, detail ?? `the source has no table or view named ${name}`, {
    object: name,
  });
}

/** A secret this connection needs, or a failure that says which one is missing. */
export function secretOf(secrets: SourceSecrets, name: SecretName): string {
  const value = secrets[name];
  if (typeof value !== 'string' || value.length === 0)
    throw new ConnectorError(KEYS.secretsMissing, `the ${name} secret isn't stored`, { secret: name });
  return value;
}

/** The connection settings for this connector, or a failure that says whose they are. */
export function connectionOf<K extends WarehouseKind>(
  ctx: ConnectorContext,
  kind: K,
): Extract<SourceConnection, { kind: K }> {
  const connection = ctx.connection;
  if (connection.kind !== kind)
    throw new ConnectorError(KEYS.read, `the connection settings are for ${connection.kind}, not ${kind}`);
  return connection as Extract<SourceConnection, { kind: K }>;
}
