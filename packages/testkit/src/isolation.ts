import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';

export function neutralizeCloudEnvironment(directory: string, env = process.env): void {
  env.AWS_CONFIG_FILE = join(directory, 'missing-config');
  env.AWS_SHARED_CREDENTIALS_FILE = join(directory, 'missing-credentials');
  env.AWS_EC2_METADATA_DISABLED = 'true';
  env.CLOUDSDK_CONFIG = directory;
  for (const name of [
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'AZURE_CLIENT_ID',
    'AZURE_TENANT_ID',
    'AZURE_CLIENT_SECRET',
    'AZURE_FEDERATED_TOKEN_FILE',
  ])
    delete env[name];
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

/**
 * The test servers this process started and stopped, by the port each held.  A connection to one of
 * them means a client outlived the server it was made for, and by then the port may belong to
 * another test's server, which receives bytes it makes nothing of and answers nothing, so the
 * client hangs and both tests fail far from the cause.  The registry sits on the global object
 * because a worker loads this module twice: as source through the setup file, and as built output
 * through the kit's own imports.
 */
const stoppedTestServers: Map<number, string> = ((globalThis as Record<symbol, unknown>)[
  Symbol.for('riosoma.stoppedTestServers')
] ??= new Map()) as Map<number, string>;

/** Records a test server's port as stopped, so a later connection to it fails where it starts. */
export function noteStoppedTestServer(port: number, what: string): void {
  if (Number.isInteger(port) && port > 0) stoppedTestServers.set(port, what);
}

/**
 * Clears that record for a port a running test server holds again, which happens when a new server
 * is given the port an earlier one stopped on.
 */
export function noteRunningTestServer(port: number): void {
  stoppedTestServers.delete(port);
}

/** What stopped on this port, when a test server this process started stopped on it. */
function stoppedTestServer(port: unknown): string | undefined {
  const number = Number(port);
  return Number.isInteger(number) && number > 0 ? stoppedTestServers.get(number) : undefined;
}

function normalizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

/** Whether a live suite asked for the network.  The database URL and retry setting exist in ordinary runs. */
function liveTesting(env: NodeJS.ProcessEnv): boolean {
  if (
    ['RIOSOMA_INGEST_BUILD_EVAL_LIVE', 'RIOSOMA_INGEST_STUDY_EVAL_LIVE', 'RIOSOMA_RIO_EVAL_LIVE'].some(
      (name) => env[name] === '1',
    )
  )
    return true;
  return Object.entries(env).some(
    ([name, value]) =>
      name.startsWith('RIOSOMA_TEST_') &&
      name !== 'RIOSOMA_TEST_DATABASE_URL' &&
      name !== 'RIOSOMA_TEST_RETRY' &&
      Boolean(value),
  );
}

type LookupCallback = (error: Error | null, address?: unknown, family?: number) => void;
type Lookup = (hostname: string, options: unknown, callback: LookupCallback) => void;

/**
 * Checks a connection before it opens, and returns the arguments to open it with.  A connection
 * that brings its own name lookup, as Riosoma's guarded clients do, is checked on the addresses
 * that lookup gives rather than on its name, so the lookup's own refusals still happen first.
 */
export function guardTestConnection(args: unknown[], env = process.env): unknown[] {
  if (liveTesting(env)) return args;
  // Node passes a normalized argument array internally, including for TLS and HTTP clients.
  const values = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const first = values[0] as { lookup?: unknown; port?: number | string; path?: string } | undefined;
  if (typeof first !== 'object' || first === null || typeof first.lookup !== 'function' || first.path) {
    assertTestConnection(args, env);
    return args;
  }
  const lookup = first.lookup as Lookup;
  const checked: Lookup = (hostname, options, callback) =>
    lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error, address, family);
      const found = Array.isArray(address)
        ? (address as Array<{ address: string }>).map((entry) => entry.address)
        : [String(address)];
      try {
        for (const host of found) assertTestConnection([{ host, port: first.port }], env);
      } catch (refused) {
        return callback(refused as Error);
      }
      callback(null, address, family);
    });
  // The array is this call's own, and Node marks a normalized one, so it's changed in place.
  values[0] = { ...first, lookup: checked };
  return args;
}

export function assertTestConnection(args: unknown[], env = process.env): void {
  // Node passes a normalized argument array internally, including for TLS and HTTP clients.
  const values = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  const first = values[0];
  const options =
    typeof first === 'object' && first !== null
      ? (first as { host?: string; port?: number | string; path?: string })
      : { port: first, host: typeof values[1] === 'string' ? values[1] : undefined };
  if ('path' in options && options.path) return;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return;
  const host = normalizeHost(options.host || 'localhost');

  // A server that stopped keeps its port number in whatever client was never ended, and that
  // client's next attempt belongs to no test any more.
  const stopped = stoppedTestServer(options.port);
  if (stopped)
    throw new Error(
      `A test connection outlived its server: ${host}:${options.port ?? ''} was ${stopped}.  ` +
        'End every pool and client before the server they connect to stops.',
    );

  if (liveTesting(env)) return;
  const family = isIP(host);
  if (host === 'localhost' || (family && loopback.check(host, family === 4 ? 'ipv4' : 'ipv6'))) return;

  // A service container may have a nonloopback address, but only its database port is allowed.
  if (env.RIOSOMA_TEST_DATABASE_URL) {
    const database = new URL(env.RIOSOMA_TEST_DATABASE_URL);
    if (host === normalizeHost(database.hostname) && Number(options.port) === Number(database.port || 5432))
      return;
  }
  throw Object.assign(
    new Error(
      `Test network isolation blocked outbound connection to ${host}.  Stub the connection or explicitly configure a RIOSOMA_TEST_* live service variable.`,
    ),
    { code: 'TEST_NETWORK_ISOLATED' },
  );
}
