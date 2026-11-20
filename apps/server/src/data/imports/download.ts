import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { isPublicAddress, type Resolve, type ResolvedAddress } from '../../automations/outbound.js';

/**
 * Downloads a file from an address someone else chose, such as an attachment in an imported base
 * or a file a data source syncs, with the same guard outbound calls from automations and webhooks
 * use.  Every address the host resolves to must be on the public internet unless the operator
 * allows private hosts, and the connection goes to the address that was checked, so a second
 * lookup can't send it elsewhere.  Redirects are followed at most three times, each checked the
 * same way, and the caller's own headers go along only while a redirect stays on the same origin.
 * An answer is refused as soon as it passes its size limit, and one that goes quiet for too long is
 * dropped.  A POST, which only a token request sends, for an API source's OAuth client or a Google
 * Sheets source's service account, never follows a redirect, so its body and credentials reach
 * only the address that was asked for.
 */

export type DownloadProblem = 'blocked' | 'tooLarge' | 'failed';

export class DownloadError extends Error {
  constructor(
    readonly problem: DownloadProblem,
    /** What failed, in a word or an error code, for people who know the network */
    readonly detail?: string,
  ) {
    super(problem);
    this.name = 'DownloadError';
  }
}

export interface DownloadOptions {
  resolve: Resolve;
  /** Whether a call to this address may reach a private network */
  allowPrivate(url: URL): boolean;
  maxBytes: number;
  signal?: AbortSignal;
  /** How long connecting, and each quiet stretch while reading, may take */
  timeoutMs?: number;
  /** Whether an address may be asked for at all, checked on every hop.  One refused is `blocked`. */
  allowUrl?(url: URL): boolean;
  method?: 'GET' | 'HEAD' | 'POST' | 'PROPFIND' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent with the request, and after a redirect only while it stays on the same origin */
  headers?: Record<string, string>;
  /** A request body, for the methods that carry one.  Redirects are followed only for GET and HEAD. */
  body?: string;
  /** Hands back answers outside 2xx instead of refusing them, for callers that read the status */
  anyStatus?: boolean;
}

export interface Download {
  body: Readable;
  /** What the answer said its size was, when it said */
  declaredBytes: number | null;
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Where the answer came from, after any redirects */
  url: URL;
}

const REDIRECTS = 3;
const TIMEOUT_MS = 60_000;

function target(address: string, base?: URL): URL {
  let url: URL;
  try {
    url = new URL(address, base);
  } catch {
    throw new DownloadError('failed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new DownloadError('blocked');
  // Credentials in an address are never sent anywhere on someone else's say.
  if (url.username || url.password) throw new DownloadError('blocked');
  return url;
}

/**
 * The address a request to this URL connects to, once every address its host resolves to has
 * passed the private-network rule.
 */
export async function checkedAddress(
  url: URL,
  options: Pick<DownloadOptions, 'resolve' | 'allowPrivate'>,
): Promise<ResolvedAddress> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literal = isIP(hostname);
  let found: ResolvedAddress[];
  if (literal) found = [{ address: hostname, family: literal === 6 ? 6 : 4 }];
  else {
    try {
      found = await options.resolve(hostname);
    } catch {
      throw new DownloadError('failed', 'resolve');
    }
  }
  if (!found.length) throw new DownloadError('failed', 'resolve');
  if (!options.allowPrivate(url) && found.some((entry) => !isPublicAddress(entry.address)))
    throw new DownloadError('blocked');
  return found[0]!;
}

function request(
  url: URL,
  pinnedTo: ResolvedAddress,
  options: DownloadOptions,
  headers: Record<string, string>,
): Promise<http.IncomingMessage> {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: pinnedTo.address, family: pinnedTo.family }]);
    else callback(null, pinnedTo.address, pinnedTo.family);
  };
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const outgoing = client.request({
      protocol: url.protocol,
      hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: {
        'user-agent': 'Riosoma-Import',
        accept: '*/*',
        ...headers,
        ...(options.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(options.body)) }),
      },
      lookup: pinned,
      agent: false,
      signal: options.signal,
      timeout: options.timeoutMs ?? TIMEOUT_MS,
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
    });
    outgoing.on('timeout', () => outgoing.destroy(new DownloadError('failed', 'timeout')));
    outgoing.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        options.signal?.aborted
          ? options.signal.reason
          : error instanceof DownloadError
            ? error
            : new DownloadError('failed', error.code ?? 'network'),
      );
    });
    outgoing.on('response', resolve);
    outgoing.end(options.body);
  });
}

async function* limited(incoming: http.IncomingMessage, maxBytes: number): AsyncGenerator<Buffer> {
  let size = 0;
  try {
    for await (const chunk of incoming) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      if (size > maxBytes) throw new DownloadError('tooLarge');
      yield bytes;
    }
  } catch (error) {
    throw error instanceof DownloadError
      ? error
      : new DownloadError('failed', (error as NodeJS.ErrnoException).code ?? 'network');
  } finally {
    incoming.destroy();
  }
}

/** Starts a download.  The body is read by the caller, and fails partway past the size limit. */
export async function download(address: string, options: DownloadOptions): Promise<Download> {
  let url = target(address);
  let headers = options.headers ?? {};
  for (let hop = 0; ; hop++) {
    options.signal?.throwIfAborted();
    if (options.allowUrl && !options.allowUrl(url)) throw new DownloadError('blocked', url.protocol);
    const incoming = await request(url, await checkedAddress(url, options), options, headers);
    const status = incoming.statusCode ?? 0;
    if (
      status >= 300 &&
      status < 400 &&
      incoming.headers.location &&
      (options.method === undefined || options.method === 'GET' || options.method === 'HEAD')
    ) {
      incoming.destroy();
      if (hop >= REDIRECTS) throw new DownloadError('failed', 'redirects');
      const next = target(incoming.headers.location, url);
      // Credentials the caller chose for one server never go to another one on its say.
      if (next.origin !== url.origin) headers = {};
      url = next;
      continue;
    }
    if ((status < 200 || status >= 300) && !options.anyStatus) {
      incoming.destroy();
      throw new DownloadError('failed', `HTTP ${status}`);
    }
    const declared = Number(incoming.headers['content-length']);
    const declaredBytes = Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
    // A HEAD answer names the file's size without sending it, and an error's size isn't the file's.
    const sends = options.method !== 'HEAD' && status >= 200 && status < 300;
    if (sends && declaredBytes !== null && declaredBytes > options.maxBytes) {
      incoming.destroy();
      throw new DownloadError('tooLarge');
    }
    incoming.setTimeout(options.timeoutMs ?? TIMEOUT_MS, () =>
      incoming.destroy(new DownloadError('failed', 'timeout')),
    );
    return {
      body: Readable.from(limited(incoming, options.maxBytes), { objectMode: false }),
      declaredBytes,
      status,
      headers: incoming.headers,
      url,
    };
  }
}
