import { SERVICE_DEFAULT_PORT } from '@riosoma/connectors';
import { fileToken, fixedToken, type TokenSource } from './token.js';

/**
 * The connector service's settings, from its environment.  None is required in a container: the
 * image listens on every address of its own network, and reads the token the server writes into
 * the storage both share.  Run by the server from a source checkout, it's handed a port of its
 * own and the token outright.
 */
export interface ServiceConfig {
  host: string;
  port: number;
  logLevel: string;
  version: string;
  token: TokenSource;
}

export class ServiceConfigError extends Error {
  constructor(readonly setting: string) {
    super(`${setting} is not usable`);
    this.name = 'ServiceConfigError';
  }
}

const LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const value = (name: string) => {
    const text = env[name]?.trim();
    return text ? text : undefined;
  };
  const port = Number(value('RIOSOMA_CONNECTOR_SERVICE_PORT') ?? SERVICE_DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ServiceConfigError('RIOSOMA_CONNECTOR_SERVICE_PORT');
  const logLevel = value('RIOSOMA_LOG_LEVEL') ?? 'info';
  if (!LEVELS.includes(logLevel)) throw new ServiceConfigError('RIOSOMA_LOG_LEVEL');
  const token = value('RIOSOMA_CONNECTOR_SERVICE_TOKEN');
  const tokenFile = value('RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE');
  let source: TokenSource;
  if (token) {
    try {
      source = fixedToken(token);
    } catch {
      throw new ServiceConfigError('RIOSOMA_CONNECTOR_SERVICE_TOKEN');
    }
  } else if (tokenFile) source = fileToken(tokenFile);
  else throw new ServiceConfigError('RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE');
  return {
    host: value('RIOSOMA_CONNECTOR_SERVICE_HOST') ?? '127.0.0.1',
    port,
    logLevel,
    version: value('RIOSOMA_VERSION') ?? '0.95.0',
    token: source,
  };
}
