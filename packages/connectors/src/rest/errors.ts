import { FileNetworkError } from '../files/network.js';

type Diagnostic = { errorClass: string; errorCode?: string };
// Safe diagnostics stay outside serialized errors and never retain external messages.
const diagnostics = new WeakMap<Error, Diagnostic>();

export function withErrorDiagnostic<T extends Error>(failure: T, cause: unknown): T {
  diagnostics.set(failure, errorDiagnostic(cause));
  return failure;
}

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const DIAGNOSTIC_CODES = new Set([
  'EIO',
  'EINVAL',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
  'ERR_INTERNAL_ASSERTION',
  'ERR_ASSERTION',
  'ERR_OUT_OF_RANGE',
]);
const RESOLUTION_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
]);
const TRANSIENT_TLS_CODES = new Set([
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_UNEXPECTED_EOF_WHILE_READING',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
]);

/** Only recognized transport codes can reach diagnostics, regardless of external error properties. */
export function transportCode(error: unknown, depth = 0): string | undefined {
  if (!(error instanceof Error) || depth >= 4) return undefined;
  const code = 'code' in error ? error.code : error instanceof FileNetworkError ? error.detail : undefined;
  if (
    typeof code === 'string' &&
    (CONNECTION_CODES.has(code) ||
      RESOLUTION_CODES.has(code) ||
      TLS_CODES.has(code) ||
      DIAGNOSTIC_CODES.has(code))
  )
    return code;
  return error.cause instanceof Error && error.cause !== error
    ? transportCode(error.cause, depth + 1)
    : undefined;
}

export function transportFailure(
  error: unknown,
): { kind: 'connect' | 'resolve' | 'tls'; transient: boolean } | undefined {
  const code = transportCode(error);
  if (code && TLS_CODES.has(code)) return { kind: 'tls', transient: TRANSIENT_TLS_CODES.has(code) };
  if (code && RESOLUTION_CODES.has(code)) return { kind: 'resolve', transient: code === 'EAI_AGAIN' };
  if (code && CONNECTION_CODES.has(code)) return { kind: 'connect', transient: true };
  if (error instanceof FileNetworkError) {
    if (error.problem === 'resolve') return { kind: 'resolve', transient: true };
    if (error.problem === 'failed') return { kind: 'connect', transient: true };
  }
  return undefined;
}

/** Diagnostics include standard classes and known codes, never external messages or arbitrary names. */
export function errorDiagnostic(error: unknown): Diagnostic {
  const saved = error instanceof Error ? diagnostics.get(error) : undefined;
  if (saved) return saved;
  const classes = [
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
    AggregateError,
    FileNetworkError,
  ];
  const errorClass =
    classes.find((type) => error instanceof Error && error.constructor === type)?.name ?? 'Error';
  const errorCode = transportCode(error);
  return { errorClass, ...(errorCode ? { errorCode } : {}) };
}
