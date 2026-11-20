import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScript } from './script.js';
import { scriptFetch } from './script-fetch.js';

const resolve = async () => [{ address: '93.184.215.14', family: 4 as const }];
const host = {
  call: async (_method: string, args: unknown[], remaining: number) => scriptFetch(args, resolve, remaining),
};
afterEach(() => vi.restoreAllMocks());

/**
 * The requests that went to any of `hosts`.  Only these count: other code in the same test process,
 * such as a cloud credential refresh, may make requests of its own.
 */
function targets(request: { mock: { calls: unknown[][] } }, hosts: string[]): string[] {
  return request.mock.calls
    .map(([target]) => {
      if (typeof target === 'string') return [new URL(target).hostname];
      if (target instanceof URL) return [target.hostname];
      const options = (target ?? {}) as {
        hostname?: string | null;
        host?: string | null;
        servername?: string;
      };
      return [options.hostname, options.host, options.servername].filter((name): name is string =>
        Boolean(name),
      );
    })
    .filter((names) => names.some((name) => hosts.includes(name)))
    .map((names) => names[0]!);
}

describe('script requests', () => {
  it('blocks private addresses and insecure protocols before opening a connection', async () => {
    const request = vi.spyOn(https, 'request');
    for (const url of ['https://127.0.0.1/', 'https://10.0.0.1/', 'https://[::1]/', 'http://example.test/']) {
      await expect(runScript(`await fetch(${JSON.stringify(url)})`, {}, host, [])).rejects.toBeDefined();
    }
    expect(targets(request, ['127.0.0.1', '10.0.0.1', '::1', '[::1]', 'example.test'])).toEqual([]);
    await expect(
      scriptFetch(['https://example.test/', {}], async () => [{ address: '192.168.1.1', family: 4 }], 100),
    ).rejects.toMatchObject({ messageKey: 'automations.webhook.blocked' });
  });

  it('refuses redirects into a private network without making a second request', async () => {
    const request = vi.spyOn(https, 'request').mockImplementation(() => {
      const outgoing = new EventEmitter() as ReturnType<typeof https.request>;
      outgoing.end = (() => {
        queueMicrotask(() => {
          const incoming = new EventEmitter() as IncomingMessage;
          incoming.statusCode = 302;
          incoming.headers = { location: 'https://127.0.0.1/private' };
          outgoing.emit('response', incoming);
          incoming.emit('end');
        });
        return outgoing;
      }) as typeof outgoing.end;
      return outgoing;
    });
    await expect(runScript('await fetch("https://example.test/")', {}, host, [])).rejects.toMatchObject({
      messageKey: 'automations.script.fetchBlocked',
    });
    // The first address is asked for, and the redirect's private address never is.
    expect(targets(request, ['example.test', '93.184.215.14', '127.0.0.1'])).toHaveLength(1);
  });
});
