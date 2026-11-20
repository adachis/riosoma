import { payloadHash, signAwsRequest, type Credentials } from '../files/s3.js';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { scrubDetail, secretOf } from './errors.js';

export interface AwsOptions {
  fetch?: typeof fetch;
  /** Tests route signed requests to their own HTTP server. */
  endpoint?: (service: string, region: string) => URL;
}

export function awsCredentials(ctx: ConnectorContext): Credentials {
  return {
    accessKeyId: secretOf(ctx.secrets, 'accessKeyId'),
    secretAccessKey: secretOf(ctx.secrets, 'secretAccessKey'),
    ...(ctx.secrets.sessionToken ? { sessionToken: ctx.secrets.sessionToken } : {}),
  };
}

export function awsEndpoint(service: string, region: string): URL {
  return new URL(`https://${service}.${region}.amazonaws.com${region.startsWith('cn-') ? '.cn' : ''}/`);
}

export class AwsClient {
  constructor(
    private readonly ctx: ConnectorContext,
    private readonly region: string,
    private readonly options: AwsOptions = {},
  ) {}

  async request(
    service: string,
    body: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = (this.options.endpoint ?? awsEndpoint)(service, this.region);
    const deadline = AbortSignal.timeout(this.ctx.timeoutMs ?? 30_000);
    const combined = AbortSignal.any([
      deadline,
      ...(signal ? [signal] : []),
      ...(this.ctx.signal ? [this.ctx.signal] : []),
    ]);
    try {
      const response = await (this.options.fetch ?? fetch)(url, {
        method: 'POST',
        body,
        redirect: 'error',
        signal: combined,
        headers: signAwsRequest({
          method: 'POST',
          url,
          region: this.region,
          service,
          credentials: awsCredentials(this.ctx),
          headers,
          hash: payloadHash(body),
        }),
      });
      if (!response.body) throw new ConnectorError('sources.sync.read');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 16 * 1024 * 1024) throw new ConnectorError('sources.sync.read');
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (!response.ok)
        throw new ConnectorError('sources.sync.read', `HTTP ${response.status}: ${text.slice(0, 1_000)}`);
      return text;
    } catch (error) {
      throw new ConnectorError(
        combined.aborted ? 'sources.test.timeout' : 'sources.sync.read',
        scrubDetail(error, this.ctx),
      );
    }
  }

  async json<T>(service: string, target: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return JSON.parse(
      await this.request(
        service,
        JSON.stringify(body),
        {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': target,
        },
        signal,
      ),
    ) as T;
  }
}
