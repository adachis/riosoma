import { refuseDemo } from '../demo/boundary.js';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from '@riosoma/connectors';

/**
 * Webhook calls from automations.  The host is resolved once, every address it resolves to must
 * be on the public internet (unless the operator allows private hosts), and the connection goes
 * to the address that was checked, so a second lookup can't send it somewhere else.  Redirects
 * are never followed, a call gives up after 10 seconds, and only the first 64 KB of the answer
 * is kept unless the caller asks for more.  Single sign-on reads identity provider metadata
 * through it too, and feedback sends its bug reports to GitHub through it.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolve = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolve: Resolve = async (hostname) => {
  refuseDemo();
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
};

export { isPublicAddress };

export class OutboundError extends Error {
  constructor(
    readonly messageKey: string,
    readonly detail?: string,
  ) {
    super(messageKey);
  }
}

export interface OutboundRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  headers: Record<string, string>;
  body: string | null;
}

export interface OutboundResponse {
  headers?: Record<string, string>;
  status: number;
  body: string;
  truncated: boolean;
}

export const OUTBOUND_TIMEOUT_MS = 10_000;
export const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_LIMIT = 1024 * 1024;

export interface OutboundOptions {
  signal?: AbortSignal;
  resolve: Resolve;
  allowPrivate: boolean;
  timeoutMs?: number;
  /** How much of the answer to keep, `RESPONSE_LIMIT` unless set */
  responseLimit?: number;
  /** The most a request may send, 1 MB unless set */
  requestLimit?: number;
}

/**
 * The checks a request passes before anything is looked up or sent: an http or https address,
 * a body within the limit, and headers without line breaks.  A simulation stops here, and so
 * refuses an address on a private network only when it's written as one, since finding out what
 * a name resolves to would reach outside.
 */
export function checkRequest(
  request: OutboundRequest,
  options: Pick<OutboundOptions, 'requestLimit'> & { allowPrivate?: boolean } = {},
): { url: URL; body: Buffer | null } {
  let url: URL;
  try {
    url = new URL(request.url.trim());
  } catch {
    throw new OutboundError('automations.step.failed', 'url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new OutboundError('automations.step.failed', 'url');
  const body = request.body === null ? null : Buffer.from(request.body, 'utf8');
  if (body && body.length > (options.requestLimit ?? REQUEST_LIMIT))
    throw new OutboundError('automations.step.failed', 'tooLarge');
  for (const [name, value] of Object.entries(request.headers))
    if (/[\r\n\0]/.test(value) || /[\r\n\0]/.test(name) || value.length > 8_000)
      throw new OutboundError('automations.step.failed', 'header');
  if (options.allowPrivate === false) {
    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    if (isIP(hostname) && !isPublicAddress(hostname)) throw new OutboundError('automations.webhook.blocked');
  }
  return { url, body };
}

export async function callOut(request: OutboundRequest, options: OutboundOptions): Promise<OutboundResponse> {
  refuseDemo();
  options.signal?.throwIfAborted();
  const { url, body } = checkRequest(request, { requestLimit: options.requestLimit });

  const timeoutMs = options.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const responseLimit = options.responseLimit ?? RESPONSE_LIMIT;
  const deadline = Date.now() + timeoutMs;
  const timedOut = () => new OutboundError('automations.webhook.timeout');
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = isIP(hostname);
  let addresses: ResolvedAddress[];
  if (literal) addresses = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  else {
    let timer: NodeJS.Timeout | undefined;
    try {
      addresses = await Promise.race([
        options.resolve(hostname),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(timedOut()), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof OutboundError) throw error;
      throw new OutboundError('automations.step.failed', 'resolve');
    } finally {
      clearTimeout(timer);
    }
  }
  if (!addresses.length) throw new OutboundError('automations.step.failed', 'resolve');
  if (!options.allowPrivate && addresses.some((entry) => !isPublicAddress(entry.address)))
    throw new OutboundError('automations.webhook.blocked');
  const target = addresses[0]!;
  // The connection goes to the address just checked, never to a fresh lookup of the name.
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: target.address, family: target.family }]);
    else callback(null, target.address, target.family);
  };

  const headers: Record<string, string> = { 'user-agent': 'Riosoma-Automations', accept: '*/*' };
  if (body) headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(request.headers)) headers[name.toLowerCase()] = value;
  if (body) headers['content-length'] = String(body.length);

  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: OutboundError | null, response?: OutboundResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const client = url.protocol === 'https:' ? https : http;
    const outgoing = client.request({
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: request.method,
      headers,
      lookup: pinned,
      agent: false,
      signal: options.signal,
      ...(url.protocol === 'https:' && !literal ? { servername: hostname } : {}),
    });
    const timer = setTimeout(
      () => {
        outgoing.destroy();
        finish(timedOut());
      },
      Math.max(0, deadline - Date.now()),
    );
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      finish(new OutboundError('automations.step.failed', error.code ?? 'network'));
    });
    outgoing.on('response', (incoming) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const done = () =>
        finish(null, {
          status: incoming.statusCode ?? 0,
          headers: Object.fromEntries(
            Object.entries(incoming.headers).map(([key, value]) => [
              key,
              Array.isArray(value) ? value.join(', ') : (value ?? ''),
            ]),
          ),
          body: Buffer.concat(chunks).toString('utf8'),
          truncated,
        });
      incoming.on('data', (chunk: Buffer) => {
        if (settled) return;
        const room = responseLimit - size;
        if (chunk.length > room) {
          if (room > 0) chunks.push(chunk.subarray(0, room));
          size = responseLimit;
          truncated = true;
          incoming.destroy();
          done();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      incoming.on('end', done);
      incoming.on('error', () => {
        if (truncated) return;
        finish(new OutboundError('automations.step.failed', 'network'));
      });
    });
    if (body) outgoing.end(body);
    else outgoing.end();
  });
}
