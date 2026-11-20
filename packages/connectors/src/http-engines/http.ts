import type { HttpEngineKind, SourceConnection } from '@riosoma/contracts';
import { payloadHash, signAwsRequest } from '../files/s3.js';
import { parseJson } from '../rest/records.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { secretOf } from '../warehouses/errors.js';
import { agentFetch, sessionAgent, type HostGuard, type HttpFetch } from '../warehouses/http.js';

export type Settings = Extract<SourceConnection, { kind: HttpEngineKind }>;
export type Row = Record<string, unknown>;
export const record = (value: unknown): Row => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ConnectorError('sources.engines.response');
  return value as Row;
};
export const records = (value: unknown): Row[] => {
  if (!Array.isArray(value)) throw new ConnectorError('sources.engines.response');
  return value.map(record);
};
export const nameOf = (value: unknown): string => {
  if (typeof value !== 'string' || !value.length) throw new ConnectorError('sources.engines.response');
  return value;
};

export interface EngineOptions {
  hostGuard?: HostGuard;
  fetch?: HttpFetch;
}

export class EngineHttp {
  readonly settings: Settings;
  private readonly stop = new AbortController();
  private readonly agent;
  private readonly fetcher: HttpFetch;

  constructor(
    readonly ctx: ConnectorContext,
    options: EngineOptions,
  ) {
    this.settings = ctx.connection as Settings;
    this.agent = sessionAgent({
      secure: new URL(this.settings.endpoint).protocol === 'https:',
      ca: this.settings.caPem,
      guard: options.hostGuard,
    });
    this.fetcher = options.fetch ?? agentFetch(this.agent, options.hostGuard);
  }

  async close(): Promise<void> {
    this.stop.abort();
    this.agent.destroy();
  }

  async text(
    path: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
    cleanup = false,
  ): Promise<string> {
    const url = new URL(`${this.settings.endpoint.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
    const text = body === undefined ? undefined : JSON.stringify(body);
    let headers: Record<string, string> = {
      accept: path.startsWith('/api/v2/query') ? 'application/csv' : 'application/json',
      'content-type': 'application/json',
    };
    const { settings, ctx } = this;
    if (settings.auth === 'basic')
      headers.authorization = `Basic ${Buffer.from(`${settings.user}:${secretOf(ctx.secrets, 'password')}`).toString('base64')}`;
    if (settings.auth === 'token')
      headers.authorization = `${settings.kind === 'influxdb' && settings.version === '2' ? 'Token' : 'Bearer'} ${secretOf(ctx.secrets, 'token')}`;
    if (settings.auth === 'api-key') {
      const key = secretOf(ctx.secrets, 'apiKey');
      if (settings.kind === 'typesense') headers['x-typesense-api-key'] = key;
      else headers.authorization = `${settings.kind === 'meilisearch' ? 'Bearer' : 'ApiKey'} ${key}`;
    }
    if (settings.kind === 'opensearch' && settings.auth === 'aws-sigv4')
      headers = signAwsRequest({
        method,
        url,
        headers,
        region: settings.region,
        service: settings.service,
        hash: payloadHash(text ?? ''),
        payloadHeader: true,
        credentials: {
          accessKeyId: secretOf(ctx.secrets, 'accessKeyId'),
          secretAccessKey: secretOf(ctx.secrets, 'secretAccessKey'),
          sessionToken: ctx.secrets.sessionToken,
        },
      });
    const deadline = AbortSignal.timeout(ctx.statementTimeoutMs ?? ctx.timeoutMs ?? 30_000);
    const signal = cleanup
      ? AbortSignal.timeout(2_000)
      : AbortSignal.any([this.stop.signal, deadline, ...(ctx.signal ? [ctx.signal] : [])]);
    let response: Response;
    try {
      response = await this.fetcher(url.href, { method, headers, body: text, signal, redirect: 'error' });
    } catch (error) {
      if (!cleanup && deadline.aborted && !ctx.signal?.aborted)
        throw new ConnectorError('sources.test.timeout');
      throw error;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ConnectorError(
        response.status === 401 || response.status === 403
          ? 'sources.test.authenticate'
          : 'sources.engines.request',
        undefined,
        { status: response.status },
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    let bytes = 0;
    let result = '';
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 32 * 1024 * 1024) throw new ConnectorError('sources.engines.tooLarge');
        result += decoder.decode(next.value, { stream: true });
      }
      return result + decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async json(path: string, body?: unknown, method?: string, cleanup = false): Promise<unknown> {
    return parseJson(await this.text(path, body, method, cleanup));
  }
}
