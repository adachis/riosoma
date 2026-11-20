import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { FileNetworkError, type CheckedAddress } from '../files/network.js';
import { ConnectorError } from '../types.js';
import { blockedByRule, KEYS } from './errors.js';

/**
 * How ClickHouse, Trino, and Druid reach their servers over HTTP.  The server supplies a guard
 * that holds every host to the private-network rule its other HTTP sources follow: a name's
 * addresses must all pass the rule, and the connection goes to an address that was checked, so a
 * second lookup can't send it elsewhere.  An address written outright never goes through a lookup,
 * so it's checked as it is.
 *
 * Trino and Druid speak through a function shaped like `fetch`.  Its connections come from a
 * session's own agent, which is how a custom authority and the checked lookup reach them, since
 * the platform's `fetch` takes neither without another dependency.
 */

/** Where host names resolve under the private-network rule, which the server supplies. */
export interface HostGuard {
  /**
   * Every address a host name resolves to, once each has passed the rule.  One the rule refuses
   * throws `FileNetworkError('blocked')`, and a name that doesn't resolve `FileNetworkError('resolve')`.
   */
  lookup(hostname: string): Promise<CheckedAddress[]>;
  /** Whether an address written outright, like `10.0.0.5`, may be reached */
  allowsAddress(address: string): boolean;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** How much of an error's body a message may carry. */
const EXCERPT_LIMIT = 200;

/**
 * The start of an error's body as plain text: control characters and runs of space become one
 * space, a page of markup is left out entirely since its words are only noise, and anything past
 * 200 characters is cut.
 */
export function bodyExcerpt(text: string): string {
  const plain = text
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^</.test(plain)) return '';
  return plain.length > EXCERPT_LIMIT ? `${plain.slice(0, EXCERPT_LIMIT - 1)}…` : plain;
}

function bare(host: string): string {
  return host.replace(/^\[(.*)\]$/, '$1');
}

export function blockedHost(host: string): ConnectorError {
  return new ConnectorError(KEYS.blocked, `${bare(host)} is on a private network`);
}

/**
 * Refuses a host the rule forbids before anything connects to it: an address written outright is
 * checked as it is, and a name by looking it up through the guard.
 */
export async function checkHost(host: string, guard: HostGuard): Promise<void> {
  const name = bare(host);
  if (isIP(name)) {
    if (!guard.allowsAddress(name)) throw blockedHost(name);
    return;
  }
  try {
    await guard.lookup(name);
  } catch (error) {
    if (blockedByRule(error)) throw blockedHost(name);
    throw error;
  }
}

/** A lookup that goes through the guard, for sockets that connect by name. */
export function guardedLookup(guard: HostGuard): LookupFunction {
  return (hostname, options, callback) => {
    const family =
      options.family === 4 || options.family === 'IPv4'
        ? 4
        : options.family === 6 || options.family === 'IPv6'
          ? 6
          : 0;
    guard.lookup(hostname).then(
      (found) => {
        const usable = family ? found.filter((entry) => entry.family === family) : found;
        if (!usable[0])
          callback(Object.assign(new Error(`no address for ${hostname}`), { code: 'ENOTFOUND' }), '', 4);
        else if (options.all)
          callback(
            null,
            usable.map(({ address, family }) => ({ address, family })),
          );
        else callback(null, usable[0].address, usable[0].family);
      },
      (error: unknown) => {
        const refused = blockedByRule(error);
        const failed = refused
          ? Object.assign(new FileNetworkError('blocked', `${hostname} is on a private network`), {
              code: 'EACCES',
            })
          : Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
        callback(failed, '', 4);
      },
    );
  };
}

export interface AgentOptions {
  secure: boolean;
  /** Authorities a secure connection trusts instead of the platform's own */
  ca?: string;
  guard?: HostGuard;
}

/** A session's own connections: kept open between requests, and through the guard when there is one. */
export function sessionAgent(options: AgentOptions): http.Agent {
  const shared = {
    keepAlive: true,
    maxSockets: 8,
    ...(options.guard ? { lookup: guardedLookup(options.guard) } : {}),
  };
  return options.secure
    ? new https.Agent({ ...shared, ...(options.ca ? { ca: options.ca } : {}) })
    : new http.Agent(shared);
}

/** Statuses whose answers carry no body. */
const NO_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` through an agent.  It never follows a redirect: with `redirect: 'error'` one fails the
 * request, and otherwise it comes back as the answer.  Only text bodies are sent.
 */
export function agentFetch(agent: http.Agent, guard?: HostGuard): HttpFetch {
  return (address, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(address);
      const secure = url.protocol === 'https:';
      if (!secure && url.protocol !== 'http:') {
        reject(new TypeError(`${url.protocol} addresses aren't supported`));
        return;
      }
      const host = bare(url.hostname);
      // An address written outright never goes through the agent's lookup.
      if (guard && isIP(host) && !guard.allowsAddress(host)) {
        reject(blockedHost(host));
        return;
      }
      const signal = init.signal ?? undefined;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
        reject(new TypeError('only text bodies are sent'));
        return;
      }
      const body = init.body ?? undefined;
      const headers = Object.fromEntries(new Headers(init.headers ?? {}).entries());
      if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
      const method = init.method ?? 'GET';
      const request = (secure ? https : http).request(url, {
        method,
        headers,
        agent,
        ...(signal ? { signal } : {}),
      });
      // A request can fail more than once, like an abort after a reset, and only the first counts.
      request.on('error', reject);
      request.once('response', (answer) => {
        // The body's reader sees a failure partway through, so nothing else needs to.
        answer.on('error', () => undefined);
        const status = answer.statusCode ?? 0;
        if (status >= 300 && status < 400 && init.redirect === 'error') {
          answer.destroy();
          reject(new TypeError(`the server answered with a redirect (${status})`));
          return;
        }
        if (status < 200 || status > 599) {
          answer.destroy();
          reject(new TypeError(`the server answered with status ${status}`));
          return;
        }
        const names = new Headers();
        for (const [name, value] of Object.entries(answer.headers)) {
          if (value === undefined) continue;
          for (const item of Array.isArray(value) ? value : [value]) names.append(name, item);
        }
        const empty = method === 'HEAD' || NO_BODY.has(status);
        if (empty) answer.resume();
        resolve(
          new Response(empty ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), {
            status,
            statusText: answer.statusMessage ?? '',
            headers: names,
          }),
        );
      });
      request.end(body);
    });
}
