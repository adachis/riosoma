/**
 * Logs are structured JSON with metadata only: never credentials, session identifiers, query
 * strings, or anything from people's data.  Known-sensitive keys are redacted defensively.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-csrf-token"]',
  'req.headers["x-setup-token"]',
  'req.headers["x-tls-ask-token"]',
  'req.headers["x-public-view-pass"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passphrase',
  '*.token',
  '*.secret',
  '*.clientSecret',
  '*.privateKeyPem',
  '*.clientKeyPem',
  '*.apiKey',
  '*.secretKey',
  '*.webhookSecret',
];

export function loggerOptions(level: string, production: boolean) {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    hooks: {
      // Redact after serialization so child bindings and formatted messages are covered too.
      streamWrite(line: string) {
        return `${JSON.stringify(redactLogValue(JSON.parse(line)))}\n`;
      },
    },
    // Request URLs can carry tokens in query strings; log only the path.
    serializers: {
      err: serializeError,
      req(req: { method: string; url: string; id: string }) {
        return {
          method: req.method,
          path: redactPathSecrets(redactUrlUserinfo(req.url.split('?')[0] ?? '')),
          id: req.id,
        };
      },
    },
    ...(production ? {} : { transport: { target: 'pino-pretty', options: { singleLine: true } } }),
  };
}

/** Match authority userinfo even when a URL's port is invalid and URL parsing would fail. */
export function redactUrlUserinfo(value: string): string {
  return value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@');
}

/** An automation's webhook address carries its secret in the path. */
export function redactHookSecrets(value: string): string {
  return value.replace(/(\/api\/hooks\/[^/\s?#]+\/)[^/\s?#]+/g, '$1[redacted]');
}

/** A calendar feed's address is its token, so all of it after `/feeds/` goes. */
export function redactFeedTokens(value: string): string {
  return value.replace(/(\/feeds\/)[^/\s?#]+/g, '$1[redacted]');
}

/** A webhook source's address is its token, so all of it after `/api/inbound/` goes. */
export function redactInboundTokens(value: string): string {
  return value.replace(/(\/api\/inbound\/)[^/\s?#]+/g, '$1[redacted]');
}

/** Every secret a path can carry. */
export function redactPathSecrets(value: string): string {
  return redactInboundTokens(redactFeedTokens(redactHookSecrets(value)));
}

function serializeError(error: Error & { code?: string }) {
  return {
    type: redactUrlUserinfo(error.name ?? 'Error'),
    message: redactUrlUserinfo(error.message ?? ''),
    stack: redactUrlUserinfo(error.stack ?? ''),
    code: typeof error.code === 'string' ? redactUrlUserinfo(error.code) : undefined,
  };
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPathSecrets(redactUrlUserinfo(value));
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((child) => redactLogValue(child));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactLogValue(child)]));
}
