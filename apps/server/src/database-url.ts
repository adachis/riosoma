import { DatabaseProfile, TLS_MODES } from '@riosoma/contracts';
import { ConfigurationError } from './configuration-error.js';

/**
 * Turns a familiar `postgres://user:pass@host:port/db?sslmode=...` URL into a full profile, so a
 * single-server install can be configured with one environment variable.
 */
export function profileFromUrl(url: string): DatabaseProfile {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigurationError('RIOSOMA_DATABASE_URL', 'url');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new ConfigurationError('RIOSOMA_DATABASE_URL', 'protocol');
  }
  const sslmode = u.searchParams.get('sslmode') ?? 'prefer';
  if (!(TLS_MODES as readonly string[]).includes(sslmode))
    throw new ConfigurationError('RIOSOMA_DATABASE_URL', 'tlsMode');
  try {
    return DatabaseProfile.parse({
      host: decodeURIComponent(u.hostname),
      port: u.port ? Number(u.port) : 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres',
      user: decodeURIComponent(u.username),
      auth: { method: 'password', password: decodeURIComponent(u.password) },
      tls: { mode: sslmode },
      ...(u.searchParams.get('pooler') ? { pooler: u.searchParams.get('pooler') } : {}),
    });
  } catch {
    throw new ConfigurationError('RIOSOMA_DATABASE_URL');
  }
}
