import dns from 'node:dns';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Loaded into the test server before it starts, this points the outside services it calls at a
 * stand-in on this machine, the way a hosts file and a forwarded port would.  A name listed in
 * `RIOSOMA_E2E_STAND_IN_HOSTS` resolves to this machine, and a secure connection to it on the
 * usual port goes to `RIOSOMA_E2E_STAND_IN_PORT` instead.  The stand-in's certificate is trusted
 * through `NODE_EXTRA_CA_CERTS`, so the server still checks it as it would the real service's.
 * Everything else about the call, from the address check to the request itself, is the server's
 * own.
 */

const hosts = new Set((process.env.RIOSOMA_E2E_STAND_IN_HOSTS ?? '').split(',').filter(Boolean));
const port = Number(process.env.RIOSOMA_E2E_STAND_IN_PORT);

if (hosts.size && port) {
  const here = { address: '127.0.0.1', family: 4 };
  const lookup = dns.promises.lookup;
  dns.promises.lookup = ((hostname: string, options?: dns.LookupOptions) =>
    hosts.has(hostname)
      ? Promise.resolve(options?.all ? [here] : here)
      : lookup(hostname, options ?? {})) as typeof dns.promises.lookup;

  const bySecureConnection = (options: unknown): options is https.RequestOptions =>
    typeof options === 'object' &&
    options !== null &&
    !(options instanceof URL) &&
    hosts.has(String((options as https.RequestOptions).hostname)) &&
    Number((options as https.RequestOptions).port ?? 443) === 443;
  const request = https.request.bind(https) as (...args: unknown[]) => ReturnType<typeof https.request>;
  https.request = ((...args: unknown[]) => {
    const [options] = args;
    if (bySecureConnection(options)) args[0] = { ...options, port };
    return request(...args);
  }) as typeof https.request;

  // Code that imported these by name sees the stand-ins too.
  syncBuiltinESMExports();
}
