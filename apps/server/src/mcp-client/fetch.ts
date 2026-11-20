import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { AppError } from '@riosoma/contracts';
import { checkRequest, isPublicAddress, systemResolve, type Resolve } from '../automations/outbound.js';

import { allowsPrivate, checkedUrl } from '../webhooks/url.js';
import type { RuntimeConfig } from '../config.js';
export type RemoteNetworkPolicy = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>;
export const closedNetworkPolicy: RemoteNetworkPolicy = {
  production: true,
  automationsAllowPrivateHosts: false,
};

const blocked = () => new AppError('forbidden', 'remote.blockedAddress');

/** Pin every connection to a checked address, including discovery and stream endpoints. */
export function guardedFetch(
  allowPrivate: boolean,
  signal: AbortSignal,
  resolve: Resolve = systemResolve,
  policy: RemoteNetworkPolicy = closedNetworkPolicy,
  credentials = false,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    try {
      checkedUrl(url.href, policy);
    } catch {
      throw blocked();
    }
    if (
      url.protocol !== 'https:' &&
      (credentials ||
        request.headers.has('authorization') ||
        request.headers.has('proxy-authorization') ||
        request.headers.has('cookie') ||
        request.headers.get('content-type')?.includes('application/x-www-form-urlencoded'))
    )
      throw blocked();
    const privateAllowed = allowPrivate && allowsPrivate(url.href, policy);
    const body = request.body ? await request.text() : null;
    const headers = Object.fromEntries(request.headers.entries());
    try {
      checkRequest(
        { url: url.href, method: 'POST', headers, body },
        { allowPrivate: privateAllowed, requestLimit: 65536 },
      );
    } catch {
      throw blocked();
    }
    const abort = AbortSignal.any([signal, request.signal, AbortSignal.timeout(15000)]);
    abort.throwIfAborted();
    const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const literal = isIP(hostname);
    let stop: (() => void) | undefined;
    const addresses = await Promise.race([
      literal
        ? Promise.resolve([{ address: hostname, family: literal === 6 ? (6 as const) : (4 as const) }])
        : resolve(hostname),
      new Promise<never>((_, reject) => {
        stop = () => reject(abort.reason);
        abort.addEventListener('abort', stop, { once: true });
      }),
    ]).finally(() => {
      if (stop) abort.removeEventListener('abort', stop);
    });
    if (!addresses.length || (!privateAllowed && addresses.some((entry) => !isPublicAddress(entry.address))))
      throw blocked();
    const target = addresses[0]!;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [target]);
      else callback(null, target.address, target.family);
    };
    return new Promise<Response>((accept, reject) => {
      const outgoing = (url.protocol === 'https:' ? https : http).request(
        url,
        { method: request.method, headers, lookup, signal: abort, agent: false },
        (incoming) => {
          try {
            const status = incoming.statusCode ?? 500;
            if (status >= 500) throw new RemoteTransportError();
            if (status < 200 || status > 599) throw new AppError('unavailable', 'remote.unavailable');
            if (status >= 300 && status < 400) throw blocked();
            const responseHeaders = new Headers();
            for (const [key, value] of Object.entries(incoming.headers))
              if (value !== undefined)
                responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
            const empty = [204, 205, 304].includes(status) || request.method === 'HEAD';
            let stream: ReadableStream<Uint8Array> | null = null;
            if (empty) incoming.resume();
            else {
              const iterator = incoming[Symbol.asyncIterator]();
              let size = 0;
              let canceled = false;
              stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  try {
                    const item = await iterator.next();
                    if (canceled) return;
                    if (item.done) {
                      controller.close();
                      return;
                    }
                    const chunk = Buffer.from(item.value as Buffer);
                    size += chunk.length;
                    if (size > 1024 * 1024) throw new AppError('payload_too_large', 'remote.resultTooLarge');
                    controller.enqueue(chunk);
                  } catch (error) {
                    if (!canceled) controller.error(error);
                    incoming.destroy();
                  }
                },
                cancel() {
                  canceled = true;
                  incoming.destroy();
                },
              });
            }
            accept(new Response(stream, { status, headers: responseHeaders }));
          } catch (error) {
            incoming.destroy();
            reject(error);
          }
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  };
}

export class RemoteTransportError extends Error {}
