import { lookup } from 'node:dns/promises';
import { isIP, type Socket } from 'node:net';
import type pg from 'pg';
import type { DatabaseProfile, DiagnosticReport, DiagnosticStep, DiagnosticStepId } from '@riosoma/contracts';
import { createPool, type PoolOptions } from './connection.js';
import { poolDeadlines } from './deadlines.js';
import { passwordSource } from './tokens.js';
import { openTunnel, TunnelError, type Tunnel } from './tunnel.js';
import { negotiateTls, openSocket, TransportError } from './transport.js';

export function isSupportedVersion(version: number): boolean {
  return Number.isFinite(version) && version >= 140000;
}

function classify(error: unknown): { step: DiagnosticStepId; messageKey: string; fixKey?: string } {
  const e = error as { code?: string; message?: string };
  const message = e.message ?? '';
  switch (e.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { step: 'dns', messageKey: 'setup.diagnose.dns.notFound', fixKey: 'setup.fix.checkHost' };
    case 'ECONNREFUSED':
      return {
        step: 'tcp',
        messageKey: 'setup.diagnose.tcp.refused',
        fixKey: 'setup.fix.checkPortAndFirewall',
      };
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { step: 'tcp', messageKey: 'setup.diagnose.tcp.unreachable', fixKey: 'setup.fix.checkNetwork' };
    case '28P01':
    case '28000':
      return {
        step: 'auth',
        messageKey: 'setup.diagnose.auth.rejected',
        fixKey: 'setup.fix.checkCredentials',
      };
    case '3D000':
      return {
        step: 'database',
        messageKey: 'setup.diagnose.database.missing',
        fixKey: 'setup.fix.createDatabase',
      };
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return { step: 'tls', messageKey: 'setup.diagnose.tls.untrusted', fixKey: 'setup.fix.addCa' };
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return { step: 'tls', messageKey: 'setup.diagnose.tls.nameMismatch', fixKey: 'setup.fix.useCertName' };
    case 'CERT_HAS_EXPIRED':
      return { step: 'tls', messageKey: 'setup.diagnose.tls.expired', fixKey: 'setup.fix.renewCert' };
  }
  if (/does not support SSL/i.test(message)) {
    return { step: 'tls', messageKey: 'setup.diagnose.tls.unsupported', fixKey: 'setup.fix.lowerTlsMode' };
  }
  if (/timeout/i.test(message)) {
    return { step: 'tcp', messageKey: 'setup.diagnose.tcp.unreachable', fixKey: 'setup.fix.checkNetwork' };
  }
  return { step: 'tcp', messageKey: 'setup.diagnose.unknown', fixKey: 'setup.fix.checkLogs' };
}

type Result = Omit<DiagnosticStep, 'step' | 'elapsedMs'>;
const stopped = Symbol('stopped');

export async function probeDatabase(
  profile: DatabaseProfile,
  options: PoolOptions = {},
): Promise<DiagnosticReport> {
  const steps: DiagnosticStep[] = [];
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  let tunnel: Tunnel | undefined;
  let socket: Socket | undefined;
  let serverVersion: string | undefined;
  let started = performance.now();
  let current: DiagnosticStepId | undefined;
  const run = async (step: DiagnosticStepId, action: () => Promise<Result>) => {
    current = step;
    started = performance.now();
    const result = await action();
    steps.push({ step, ...result, elapsedMs: Math.round(performance.now() - started) });
    if (result.status === 'fail') throw stopped;
  };
  try {
    let endpoint = options.endpoint ?? { host: profile.host, port: profile.port };
    // Private database names are resolved by the bastion, not the machine running setup.
    const host = profile.ssh?.host ?? endpoint.host;
    await run('dns', async () => {
      if (isIP(host)) return { status: 'skipped', messageKey: 'setup.diagnose.dns.skipped' };
      try {
        await lookup(host);
        return { status: 'ok', messageKey: 'setup.diagnose.dns.ok' };
      } catch {
        return { status: 'fail', messageKey: 'setup.diagnose.dns.notFound', fixKey: 'setup.fix.checkHost' };
      }
    });
    if (profile.ssh) {
      await run('tunnel', async () => {
        try {
          tunnel = await openTunnel(profile.ssh!, { host: profile.host, port: profile.port });
          endpoint = tunnel;
          return { status: 'ok', messageKey: 'setup.diagnose.tunnel.ok' };
        } catch (error) {
          if (!(error instanceof TunnelError)) throw error;
          switch (error.reason) {
            case 'hostKeyMismatch':
              return {
                status: 'fail',
                messageKey: 'setup.diagnose.tunnel.hostKeyMismatch',
                fixKey: 'setup.fix.checkHostKey',
              };
            case 'authRejected':
              return {
                status: 'fail',
                messageKey: 'setup.diagnose.tunnel.authRejected',
                fixKey: 'setup.fix.checkCredentials',
              };
            case 'unreachable':
              return {
                status: 'fail',
                messageKey: 'setup.diagnose.tunnel.unreachable',
                fixKey: 'setup.fix.checkNetwork',
              };
          }
        }
      });
    }
    await run('tcp', async () => {
      try {
        socket = await openSocket(endpoint);
        return { status: 'ok', messageKey: 'setup.diagnose.tcp.ok' };
      } catch (error) {
        if (
          (error instanceof TransportError && error.reason === 'timedOut') ||
          (error as { code?: string }).code === 'ETIMEDOUT'
        ) {
          return {
            status: 'fail',
            messageKey: 'setup.diagnose.tcp.timedOut',
            fixKey: 'setup.fix.checkNetwork',
          };
        }
        throw error;
      }
    });
    let effective = profile;
    await run('tls', async () => {
      if (profile.tls.mode === 'disable') {
        socket!.destroy();
        return { status: 'skipped', messageKey: 'setup.diagnose.tls.disabled' };
      }
      try {
        const encrypted = await negotiateTls(profile, endpoint, socket!);
        if (!encrypted) {
          effective = { ...profile, tls: { ...profile.tls, mode: 'disable' } };
          return { status: 'warn', messageKey: 'setup.diagnose.tls.plaintext' };
        }
        return { status: 'ok', messageKey: 'setup.diagnose.tls.ok' };
      } catch (error) {
        if (error instanceof TransportError && error.reason === 'timedOut') {
          return {
            status: 'fail',
            messageKey: 'setup.diagnose.tls.timedOut',
            fixKey: 'setup.fix.checkNetwork',
          };
        }
        if (error instanceof TransportError && error.reason === 'protocol') {
          return { status: 'fail', messageKey: 'setup.diagnose.tls.protocol', fixKey: 'setup.fix.checkLogs' };
        }
        if (error instanceof TransportError && error.reason === 'unsupported') {
          return {
            status: 'fail',
            messageKey: 'setup.diagnose.tls.unsupported',
            fixKey: 'setup.fix.lowerTlsMode',
          };
        }
        throw error;
      }
    });
    let databaseMissing = false;
    await run('auth', async () => {
      let password = options.password ?? passwordSource(profile);
      if (typeof password === 'function') {
        try {
          password = await password();
        } catch {
          return {
            status: 'fail',
            messageKey: 'setup.diagnose.auth.tokenFailed',
            params: { provider: profile.auth.method },
            fixKey: 'setup.fix.checkCredentials',
          };
        }
      }
      pool = createPool(effective, { ...options, endpoint, password, max: 1 });
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const deadlines = poolDeadlines(pool);
        await client.query(`SET LOCAL statement_timeout = ${deadlines.statementTimeoutMs}`);
        await client.query(`SET LOCAL lock_timeout = ${deadlines.lockTimeoutMs}`);
      } catch (error) {
        // PostgreSQL authenticates before selecting the database; this error proves login worked.
        if ((error as { code?: string }).code !== '3D000') throw error;
        databaseMissing = true;
      }
      return { status: 'ok', messageKey: 'setup.diagnose.auth.ok' };
    });
    await run('database', async () =>
      databaseMissing
        ? {
            status: 'fail',
            messageKey: 'setup.diagnose.database.missing',
            fixKey: 'setup.fix.createDatabase',
          }
        : { status: 'ok', messageKey: 'setup.diagnose.database.ok' },
    );
    await run('privileges', async () => {
      const database = await client!.query<{ can_create: boolean }>(
        "SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS can_create",
      );
      const schemas = Object.values(profile.schemas);
      const existing = await client!.query<{ name: string; can_create: boolean }>(
        `SELECT nspname AS name, has_schema_privilege(current_user, nspname, 'CREATE') AS can_create
           FROM pg_namespace WHERE nspname = ANY($1)`,
        [schemas],
      );
      const usable = new Map(existing.rows.map((row) => [row.name, row.can_create]));
      const missing = schemas.filter((name) => !usable.has(name));
      const blocked = schemas.filter((name) => usable.get(name) === false);
      if (blocked.length || (missing.length && !database.rows[0]?.can_create)) {
        return {
          status: 'fail',
          messageKey: 'setup.diagnose.privileges.cannotCreate',
          params: { schemas: [...blocked, ...missing].join(', ') },
          fixKey: 'setup.fix.grantCreate',
        };
      }
      return { status: 'ok', messageKey: 'setup.diagnose.privileges.ok' };
    });
    await run('extensions', async () => {
      try {
        const extensions = await client!.query<{ name: string; installed: boolean }>(
          `SELECT name, installed_version IS NOT NULL AS installed FROM pg_available_extensions
             WHERE name = ANY($1)`,
          [['pg_trgm', 'vector']],
        );
        const installed = extensions.rows.filter((row) => row.installed).map((row) => row.name);
        const available = extensions.rows.filter((row) => !row.installed).map((row) => row.name);
        const missing = ['pg_trgm', 'vector'].filter(
          (name) => !extensions.rows.some((row) => row.name === name),
        );
        return {
          status: installed.length === 2 ? 'ok' : 'warn',
          messageKey: 'setup.diagnose.extensions.available',
          params: {
            installed: installed.join(', '),
            available: available.join(', '),
            missing: missing.join(', '),
          },
        };
      } catch {
        return { status: 'warn', messageKey: 'setup.diagnose.extensions.unknown' };
      }
    });
    await run('version', async () => {
      const info = await client!.query<{ version_num: string; version: string }>(
        "SELECT current_setting('server_version_num') AS version_num, current_setting('server_version') AS version",
      );
      serverVersion = info.rows[0]?.version ?? '';
      return isSupportedVersion(Number(info.rows[0]?.version_num))
        ? { status: 'ok', messageKey: 'setup.diagnose.version.ok', params: { version: serverVersion } }
        : {
            status: 'fail',
            messageKey: 'setup.diagnose.version.tooOld',
            params: { version: serverVersion },
            fixKey: 'setup.fix.upgradePostgres',
          };
    });
    await run('latency', async () => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await client!.query('SELECT 1');
        samples.push(performance.now() - start);
      }
      const ms = samples.sort((a, b) => a - b)[2]!;
      return {
        status: ms > 50 ? 'warn' : 'ok',
        messageKey: ms > 50 ? 'setup.diagnose.latency.high' : 'setup.diagnose.latency.ok',
        params: { ms: Math.round(ms) },
      };
    });
    return { ok: true, steps, serverVersion };
  } catch (error) {
    if (error !== stopped) {
      let found = classify(error);
      // The network and TLS already answered, so a timeout here is the server taking too long to
      // accept the sign-in, as new cloud databases and users do for a minute or so.
      if (current === 'auth' && found.messageKey === 'setup.diagnose.tcp.unreachable') {
        found = { step: 'auth', messageKey: 'setup.diagnose.auth.timedOut', fixKey: 'setup.fix.retrySoon' };
      }
      steps.push({ ...found, status: 'fail', elapsedMs: Math.round(performance.now() - started) });
    }
    return { ok: false, steps, serverVersion };
  } finally {
    socket?.destroy();
    if (client) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
    }
    try {
      await pool?.end();
    } finally {
      await tunnel?.close();
    }
  }
}

export const DIAGNOSTIC_MESSAGE_KEYS = [
  'setup.diagnose.auth.ok',
  'setup.diagnose.auth.rejected',
  'setup.diagnose.auth.tokenFailed',
  'setup.diagnose.auth.timedOut',
  'setup.diagnose.database.missing',
  'setup.diagnose.database.ok',
  'setup.diagnose.dns.notFound',
  'setup.diagnose.dns.ok',
  'setup.diagnose.dns.skipped',
  'setup.diagnose.extensions.available',
  'setup.diagnose.extensions.unknown',
  'setup.diagnose.latency.high',
  'setup.diagnose.latency.ok',
  'setup.diagnose.privileges.cannotCreate',
  'setup.diagnose.privileges.ok',
  'setup.diagnose.tcp.ok',
  'setup.diagnose.tcp.refused',
  'setup.diagnose.tcp.timedOut',
  'setup.diagnose.tcp.unreachable',
  'setup.diagnose.tls.disabled',
  'setup.diagnose.tls.expired',
  'setup.diagnose.tls.nameMismatch',
  'setup.diagnose.tls.ok',
  'setup.diagnose.tls.plaintext',
  'setup.diagnose.tls.protocol',
  'setup.diagnose.tls.timedOut',
  'setup.diagnose.tls.unsupported',
  'setup.diagnose.tls.untrusted',
  'setup.diagnose.tunnel.authRejected',
  'setup.diagnose.tunnel.hostKeyMismatch',
  'setup.diagnose.tunnel.ok',
  'setup.diagnose.tunnel.unreachable',
  'setup.diagnose.unknown',
  'setup.diagnose.version.ok',
  'setup.diagnose.version.tooOld',
  'setup.fix.addCa',
  'setup.fix.checkCredentials',
  'setup.fix.checkHost',
  'setup.fix.checkHostKey',
  'setup.fix.checkLogs',
  'setup.fix.checkNetwork',
  'setup.fix.checkPortAndFirewall',
  'setup.fix.createDatabase',
  'setup.fix.grantCreate',
  'setup.fix.lowerTlsMode',
  'setup.fix.renewCert',
  'setup.fix.retrySoon',
  'setup.fix.upgradePostgres',
  'setup.fix.useCertName',
] as const;
