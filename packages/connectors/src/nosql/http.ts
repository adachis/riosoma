import { parseJson } from '../rest/records.js';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { NoSqlConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { agentFetch, sessionAgent, type HostGuard, type HttpFetch } from '../warehouses/http.js';
import { blockedByRule, scrubDetail, wordsOf } from '../warehouses/errors.js';

export interface NoSqlOptions {
  fetch?: HttpFetch;
  hostGuard?: HostGuard;
  now?: () => Date;
}
export function endpoint(connection: NoSqlConnection): string {
  if (connection.endpoint) return connection.endpoint.replace(/\/$/, '');
  if (connection.kind === 'dynamodb') return `https://dynamodb.${connection.region}.amazonaws.com`;
  if (connection.kind === 'firestore') return 'https://firestore.googleapis.com';
  throw new ConnectorError('sources.nosql.addressInvalid');
}
export function secret(ctx: ConnectorContext, name: keyof ConnectorContext['secrets']): string {
  const value = ctx.secrets[name];
  if (!value) throw new ConnectorError('sources.secretsMissing');
  return value;
}
export function client(ctx: ConnectorContext, options: NoSqlOptions) {
  return async <T>(url: string, init: RequestInit = {}): Promise<{ data: T; headers: Headers }> => {
    const signal = AbortSignal.any([
      AbortSignal.timeout(ctx.statementTimeoutMs ?? ctx.timeoutMs ?? 30_000),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    const address = new URL(url);
    const agent = options.hostGuard
      ? sessionAgent({ secure: address.protocol === 'https:', guard: options.hostGuard })
      : undefined;
    try {
      const fetcher = options.fetch ?? (agent ? agentFetch(agent, options.hostGuard) : fetch);
      const answer = await fetcher(url, { ...init, redirect: 'error', signal });
      if (!answer.ok) {
        await answer.body?.cancel();
        throw new ConnectorError(
          answer.status === 401 || answer.status === 403
            ? 'sources.nosql.denied'
            : answer.status === 404
              ? 'sources.sync.objectMissing'
              : 'sources.sync.read',
        );
      }
      const reader = answer.body?.getReader();
      if (!reader) throw new ConnectorError('sources.sync.read');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 32 * 1024 * 1024) throw new ConnectorError('sources.nosql.responseLimit');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return { data: parseJson(Buffer.concat(chunks).toString('utf8')) as T, headers: answer.headers };
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const detail = wordsOf(error);
      const key = blockedByRule(error)
        ? 'sources.analytics.blocked'
        : /ENOTFOUND|EAI_AGAIN/.test(detail)
          ? 'sources.test.resolve'
          : /CERT_|certificate|TLS|SSL/i.test(detail)
            ? 'sources.test.tls'
            : /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(detail)
              ? 'sources.test.connect'
              : 'sources.sync.read';
      throw new ConnectorError(signal.aborted ? 'sources.test.timeout' : key, scrubDetail(error, ctx));
    } finally {
      agent?.destroy();
    }
  };
}
export async function resolveEndpoint(url: string, options: NoSqlOptions): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (options.hostGuard) {
    if (isIP(host)) {
      if (!options.hostGuard.allowsAddress(host)) throw new ConnectorError('sources.analytics.blocked');
    } else await options.hostGuard.lookup(host);
  } else if (!options.fetch) await lookup(host);
}
export function nextCursor(seen: Set<string>, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const token = typeof value === 'string' ? value : JSON.stringify(value);
  if (seen.has(token)) throw new ConnectorError('sources.nosql.paging');
  seen.add(token);
  return token;
}
