import { RemoteSchemaValidator, remoteOutputValidator } from './schema.js';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { AppError, type RemoteServerConfig, type RemoteTool } from '@riosoma/contracts';
import {
  guardedFetch,
  RemoteTransportError,
  closedNetworkPolicy,
  type RemoteNetworkPolicy,
} from './fetch.js';

/**
 * How long one token request may take.  It stays below the time another call waits for that
 * request, so a waiter normally sees the refreshed tokens instead of giving up first.
 */
export const REMOTE_TOKEN_TIMEOUT_MS = 8000;

/**
 * An OAuth provider that can take over refresh-token grants, so it can spend each token once.
 * `signal` stops only the wait for another refresh.  `send` runs on its own deadline, since a
 * refresh token the server has already spent must never be lost to a stopped turn.
 */
export type RemoteAuthProvider = OAuthClientProvider & {
  refreshGrant?(refreshToken: string, send: () => Promise<Response>, signal: AbortSignal): Promise<Response>;
};

/** The refresh token in an OAuth token request.  MCP messages are strings, so they never match. */
function refreshTokenOf(init: RequestInit | undefined): string | null {
  if (!(init?.body instanceof URLSearchParams) || init.method?.toUpperCase() !== 'POST') return null;
  if (!new Headers(init.headers).get('content-type')?.includes('application/x-www-form-urlencoded'))
    return null;
  return init.body.get('grant_type') === 'refresh_token' ? init.body.get('refresh_token') : null;
}

export const remoteName = (id: string, server: string, tool: string) =>
  `${server.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}__${tool.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 20)}_${createHash('sha256').update(`${id}:${tool}`).digest('hex').slice(0, 16)}`;

export class RemoteClients {
  private readonly failures = new Map<string, { count: number; until: number }>();
  constructor(
    private readonly timeoutMs = 15000,
    private readonly cooldownMs = 30000,
    private readonly policy: RemoteNetworkPolicy = closedNetworkPolicy,
  ) {}

  async withClient<T>(
    id: string,
    config: RemoteServerConfig,
    secret: string | undefined,
    provider: RemoteAuthProvider | undefined,
    work: (client: Client) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const failure = this.failures.get(id);
    if (failure && failure.until > Date.now()) throw new AppError('unavailable', 'remote.unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const network = guardedFetch(config.allowPrivate, abort, undefined, this.policy, config.auth !== 'none');
    const fetch: typeof network = async (input, init) => {
      const refreshToken = provider?.refreshGrant ? refreshTokenOf(init) : null;
      if (!refreshToken) return network(input, init);
      const send = () =>
        guardedFetch(
          config.allowPrivate,
          AbortSignal.timeout(REMOTE_TOKEN_TIMEOUT_MS),
          undefined,
          this.policy,
          true,
        )(input, init);
      return provider!.refreshGrant!(refreshToken, send, abort);
    };
    const options = {
      fetch,
      authProvider: provider,
      requestInit: { headers: config.auth === 'header' && secret ? { [config.header]: secret } : {} },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1,
      },
    };
    let client = new Client(
      { name: 'Riosoma', version: '1.0.0' },
      { jsonSchemaValidator: remoteOutputValidator },
    );
    let transport: StreamableHTTPClientTransport | SSEClientTransport = new StreamableHTTPClientTransport(
      new URL(config.address),
      options,
    );
    try {
      try {
        await client.connect(transport, { timeout: this.timeoutMs, signal: abort });
      } catch (error) {
        if (!(error instanceof StreamableHTTPError) || ![404, 405].includes(error.code ?? 0)) throw error;
        await client.close();
        client = new Client(
          { name: 'Riosoma', version: '1.0.0' },
          { jsonSchemaValidator: remoteOutputValidator },
        );
        transport = new SSEClientTransport(new URL(config.address), options);
        await client.connect(transport, { timeout: this.timeoutMs, signal: abort });
      }
      abort.throwIfAborted();
      const result = await Promise.race([
        work(client),
        new Promise<never>((_, reject) =>
          abort.addEventListener('abort', () => reject(new AppError('unavailable', 'remote.unavailable')), {
            once: true,
          }),
        ),
      ]);
      this.failures.delete(id);
      return result;
    } catch (error) {
      const transportFailure =
        controller.signal.aborted ||
        error instanceof RemoteTransportError ||
        (error instanceof StreamableHTTPError && (error.code ?? 0) >= 500) ||
        (error instanceof Error &&
          'code' in error &&
          ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', -32001].includes(
            error.code as string,
          ));
      if (!signal?.aborted && transportFailure) {
        const count = (this.failures.get(id)?.count ?? 0) + 1;
        this.failures.set(id, { count, until: count >= 3 ? Date.now() + this.cooldownMs : 0 });
      }
      if (error instanceof AppError) throw error;
      if (
        config.auth === 'header' &&
        (error instanceof UnauthorizedError ||
          ((error instanceof StreamableHTTPError || error instanceof SseError) &&
            [401, 403].includes(error.code ?? 0)))
      )
        throw new AppError('forbidden', 'remote.credentialRejected');
      throw new AppError('unavailable', 'remote.unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
      await client.close().catch(() => {});
    }
  }

  async discover(
    id: string,
    config: RemoteServerConfig,
    secret?: string,
    provider?: RemoteAuthProvider,
    skipped?: (tool: { name: string; reason: string }) => void,
  ): Promise<RemoteTool[]> {
    return this.withClient(id, config, secret, provider, async (client) => {
      const tools: RemoteTool[] = [];
      let pages = 0;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        for (const tool of page.tools) {
          if (tools.length >= 100) {
            skipped?.({ name: tool.name, reason: 'remote.catalogLimited' });
            return tools;
          }
          if (
            tools.some((entry) => entry.name === tool.name) ||
            tool.name.length > 200 ||
            JSON.stringify(tool.inputSchema).length > 16000
          ) {
            skipped?.({ name: tool.name, reason: 'remote.schemaBlocked' });
            continue;
          }
          try {
            new RemoteSchemaValidator().getValidator(tool.inputSchema);
          } catch {
            skipped?.({ name: tool.name, reason: 'remote.schemaBlocked' });
            continue;
          }
          tools.push({
            name: tool.name,
            description: (tool.description ?? '').slice(0, 1000),
            inputSchema: tool.inputSchema,
            readOnly: tool.annotations?.readOnlyHint === true,
          });
        }
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) break;
        if (cursor) cursors.add(cursor);
      } while (cursor && ++pages < 100);
      return tools;
    });
  }
}
