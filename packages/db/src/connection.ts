import { isIP } from 'node:net';
import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import pg from 'pg';
import type { DatabaseProfile } from '@riosoma/contracts';
import { passwordSource, type PasswordSource } from './tokens.js';
import { configureDeadlines, DeadlineClient, queryDeadlines, type QueryDeadlines } from './deadlines.js';
import { openTunnel } from './tunnel.js';
import { negotiateTls, openSocket } from './transport.js';

/**
 * Builds connection pools from a profile.  Transaction poolers (PgBouncer, RDS Proxy, Supavisor)
 * can't hold session state, so nothing here relies on it: statement settings are applied per
 * transaction by callers, and LISTEN/NOTIFY uses a separate direct client.
 */
export interface Endpoint {
  host: string;
  port: number;
}

export function tlsOptions(profile: DatabaseProfile, endpoint: Endpoint): false | ConnectionOptions {
  const tls = profile.tls;
  const servername = tls.serverName ?? profile.host;
  const base: ConnectionOptions = {
    ...(isIP(servername) ? {} : { servername }),
    ...(tls.caPem ? { ca: tls.caPem } : {}),
    ...(tls.clientCertPem ? { cert: tls.clientCertPem } : {}),
    ...(tls.clientKeyPem ? { key: tls.clientKeyPem } : {}),
  };
  switch (tls.mode) {
    case 'disable':
      return false;
    case 'prefer':
    case 'require':
      // Encrypt without verifying the server certificate: PostgreSQL's own meaning of require.
      // The verify-ca and verify-full modes below check the chain.
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      return { ...base, rejectUnauthorized: false };
    case 'verify-ca':
      // Verify the chain, but not that the certificate names this host.
      return { ...base, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full': {
      // Through a tunnel the socket goes to 127.0.0.1, so verify the certificate against the real
      // server name instead of the local endpoint.
      const viaTunnel = endpoint.host !== profile.host;
      return {
        ...base,
        rejectUnauthorized: true,
        ...(viaTunnel || tls.serverName || isIP(servername)
          ? { checkServerIdentity: (_host: string, cert) => checkServerIdentity(servername, cert) }
          : {}),
      };
    }
  }
}

export interface PoolOptions extends Partial<QueryDeadlines> {
  /** A resolved credential or callback shared with a diagnostic connection. */
  password?: PasswordSource;
  /** Where to connect when a tunnel or connector sits in front of the server */
  endpoint?: Endpoint;
  /** Overrides the profile's pool size (for workers and tests) */
  max?: number;
  /** How long to wait for a new connection, including sign-in; 15 seconds by default */
  connectTimeoutMs?: number;
  /** A stream factory that replaces the TCP socket */
  stream?: pg.ClientConfig['stream'];
  /**
   * Called when an idle connection dies (a restart, a failover, an admin ending sessions).  The
   * pool replaces it on the next checkout; without a listener the error would crash the process.
   */
  onIdleError?: (error: Error) => void;
}

export function createPool(profile: DatabaseProfile, options: PoolOptions = {}): pg.Pool {
  const deadlines = queryDeadlines(options);
  const endpoint = options.endpoint ?? { host: profile.host, port: profile.port };
  const password = options.password ?? passwordSource(profile);
  const config: pg.PoolConfig = {
    Client: DeadlineClient,
    query_timeout: deadlines.queryTimeoutMs,
    // Startup settings are only safe on connections that retain their session.
    ...(profile.pooler === 'transaction'
      ? {}
      : { statement_timeout: deadlines.statementTimeoutMs, lock_timeout: deadlines.lockTimeoutMs }),
    host: endpoint.host,
    port: endpoint.port,
    database: profile.database,
    user: profile.user,
    ssl: tlsOptions(profile, endpoint),
    max: options.max ?? profile.pool.max,
    idleTimeoutMillis: profile.pool.idleTimeoutMs,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 15_000,
    application_name: profile.applicationName,
    keepAlive: true,
    ...(password === undefined ? {} : { password }),
    ...(options.stream ? { stream: options.stream } : {}),
  };
  const pool = new pg.Pool(config);
  configureDeadlines(pool, deadlines);
  pool.on('error', options.onIdleError ?? (() => undefined));
  return pool;
}

/** A client for LISTEN/NOTIFY, which needs a direct connection even behind a transaction pooler. */
export function createListenClient(profile: DatabaseProfile, options: PoolOptions = {}): pg.Client {
  const deadlines = queryDeadlines(options);
  const endpoint =
    options.endpoint ??
    (profile.listenHost
      ? { host: profile.listenHost, port: profile.listenPort ?? profile.port }
      : { host: profile.host, port: profile.port });
  const password = options.password ?? passwordSource(profile);
  return new DeadlineClient({
    connectionTimeoutMillis: options.connectTimeoutMs ?? 15_000,
    query_timeout: deadlines.queryTimeoutMs,
    statement_timeout: deadlines.statementTimeoutMs,
    lock_timeout: deadlines.lockTimeoutMs,
    host: endpoint.host,
    port: endpoint.port,
    database: profile.database,
    user: profile.user,
    ssl: tlsOptions(profile, endpoint),
    application_name: `${profile.applicationName}-listen`,
    keepAlive: true,
    ...(password === undefined ? {} : { password }),
  });
}

/** Owns the pool and its optional SSH transport as one lifetime. */
export async function connectDatabase(
  profile: DatabaseProfile,
  options: PoolOptions = {},
): Promise<{
  pool: pg.Pool;
  close(): Promise<void>;
}> {
  const tunnel = profile.ssh
    ? await openTunnel(profile.ssh, { host: profile.host, port: profile.port })
    : undefined;
  const endpoint = tunnel ?? options.endpoint ?? { host: profile.host, port: profile.port };
  try {
    let effective = profile;
    if (profile.tls.mode === 'prefer') {
      const encrypted = await negotiateTls(profile, endpoint, await openSocket(endpoint));
      if (!encrypted) effective = { ...profile, tls: { ...profile.tls, mode: 'disable' } };
    }
    const pool = createPool(effective, { ...options, endpoint });
    const borrowed = new Set<pg.PoolClient>();
    pool.on('acquire', (client) => borrowed.add(client));
    pool.on('release', (_error, client) => borrowed.delete(client));
    let closing: Promise<void> | undefined;
    return {
      pool,
      close() {
        if (!closing) {
          // Shutdown has its own budget, even when a migration or configured query limit is long.
          const timer = setTimeout(() => {
            for (const client of borrowed) {
              client.release(true);
              // Callers still run their finally blocks after forced disposal.
              client.release = () => undefined;
            }
          }, 5_000);
          timer.unref();
          closing = pool.end().finally(async () => {
            clearTimeout(timer);
            await tunnel?.close();
          });
        }
        return closing;
      },
    };
  } catch (error) {
    await tunnel?.close();
    throw error;
  }
}
