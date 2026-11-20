import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConnectorServiceClient,
  createServiceConnectors,
  registerConnector,
  SERVICE_DEFAULT_PORT,
  type ServiceEndpoint,
  type ServiceHealth,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { childProcessEnvironment, type RuntimeConfig } from '../config.js';
import { isDemoRequest } from '../demo/boundary.js';

/**
 * The connector service, which runs the sources whose drivers the server doesn't carry (MySQL,
 * SQL Server, Oracle, Firebird, Snowflake, BigQuery, Databricks, ClickHouse, and MongoDB).  Each
 * of those kinds is registered here as a connector that calls the service, so the rest of the
 * server reaches them exactly as before.  The two share a token: the operator's, or one the
 * server generates on its first start and keeps where the service reads it.  A server run from a
 * source checkout starts the service itself, so one command still runs everything.
 */

/** How the server finds the service: where it is, the token, and how to stop it if the server started it. */
export interface ConnectorServiceLink {
  endpoint(): Promise<ServiceEndpoint>;
  close?(): Promise<void>;
}

type Config = Pick<
  RuntimeConfig,
  'connectorServiceUrl' | 'connectorServiceToken' | 'connectorServiceTokenFile' | 'configDir'
>;

/** The shortest token either side accepts. */
const TOKEN_LENGTH = 32;

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The shared token in its file, written there on first use when there isn't one, readable only by
 * this account and so by a service running as the same account.
 */
export function storedToken(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    if (text.length >= TOKEN_LENGTH) return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = newToken();
  try {
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Something else wrote it first, or what was there was too short to use: keep a usable one.
  const text = readFileSync(path, 'utf8').trim();
  if (text.length >= TOKEN_LENGTH) return text;
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

/** The service at a known address, as in Compose, Kubernetes, or a sidecar on this machine. */
export function fixedLink(config: Config): ConnectorServiceLink {
  const url = config.connectorServiceUrl ?? `http://127.0.0.1:${SERVICE_DEFAULT_PORT}`;
  let token = config.connectorServiceToken;
  return {
    async endpoint() {
      token ??= storedToken(
        config.connectorServiceTokenFile ?? `${config.configDir}/connector-service.token`,
      );
      return { url, token };
    },
  };
}

/** Where the service's code is in a source checkout, if it's there. */
function serviceEntry(): { file: string; cwd: string; execArgv: string[] } | null {
  const here = import.meta.url;
  const root = fileURLToPath(new URL('../../../connector-service/', here));
  // Developing, the server runs from its TypeScript, and so does the service it starts.
  if (here.endsWith('.ts')) {
    const file = `${root}src/main.ts`;
    return existsSync(file) ? { file, cwd: root, execArgv: ['--import', 'tsx'] } : null;
  }
  const file = `${root}dist/main.js`;
  return existsSync(file) ? { file, cwd: root, execArgv: [] } : null;
}

/** What the service started here sees: the process's general settings, nothing of Riosoma's own, and its token. */
function serviceEnvironment(token: string): NodeJS.ProcessEnv {
  return {
    ...childProcessEnvironment(),
    RIOSOMA_CONNECTOR_SERVICE_HOST: '127.0.0.1',
    RIOSOMA_CONNECTOR_SERVICE_PORT: '0',
    RIOSOMA_CONNECTOR_SERVICE_TOKEN: token,
  };
}

/**
 * The service as a process of this server's own, for a server run from a source checkout.  It
 * listens on a port of this machine the system picks, with a token made for this run, and ends
 * when the server does.  If it stops, the next call that needs it starts it again, at most once
 * every few seconds.  Null when the checkout doesn't have the service built.
 */
export function childLink(warn: (fields: object, message: string) => void): ConnectorServiceLink | null {
  const entry = serviceEntry();
  if (!entry) return null;
  const token = newToken();
  let child: ChildProcess | null = null;
  let running: Promise<ServiceEndpoint> | null = null;
  let lastStart = 0;
  let closing = false;
  const start = () =>
    new Promise<ServiceEndpoint>((resolve, reject) => {
      lastStart = Date.now();
      const spawned = fork(entry.file, [], {
        cwd: entry.cwd,
        execArgv: entry.execArgv,
        env: serviceEnvironment(token),
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      child = spawned;
      const timer = setTimeout(() => {
        spawned.kill('SIGTERM');
        reject(new Error('connector service did not start'));
      }, 60_000);
      spawned.on('message', (message: { listening?: number }) => {
        if (typeof message?.listening !== 'number') return;
        clearTimeout(timer);
        resolve({ url: `http://127.0.0.1:${message.listening}`, token });
      });
      spawned.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (child === spawned) {
          child = null;
          running = null;
        }
        if (!closing) warn({ code, signal }, 'connector service stopped');
        reject(new Error('connector service stopped'));
      });
    });
  return {
    endpoint() {
      if (closing) return Promise.reject(new Error('closing'));
      if (!running) {
        if (Date.now() - lastStart < 5000) return Promise.reject(new Error('connector service restarting'));
        running = start();
        running.catch(() => {
          running = null;
        });
      }
      return running;
    },
    async close() {
      closing = true;
      const current = child as ChildProcess | null;
      if (!current || current.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          current.kill('SIGKILL');
          resolve();
        }, 5000);
        current.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        current.kill('SIGTERM');
      });
    },
  };
}

/** How the connector service is doing, asked at most once every few seconds. */
export interface ConnectorServiceStatus {
  health(): Promise<ServiceHealth>;
}

/**
 * Registers a connector for each kind the service runs, and gives back how to ask after it.  The
 * private-network rule each call is under travels with it, so the service applies the same one.
 */
export function installConnectorService(
  app: FastifyInstance,
  link: ConnectorServiceLink,
): ConnectorServiceStatus {
  const config = app.ctx.config;
  const client = new ConnectorServiceClient({
    endpoint: () => link.endpoint(),
    network: () => ({
      production: config.production,
      allowPrivateHosts: config.automationsAllowPrivateHosts === true,
      demo: isDemoRequest(),
    }),
  });
  for (const connector of createServiceConnectors(client)) registerConnector(connector);
  app.addHook('onClose', async () => {
    client.close();
    await link.close?.();
  });
  let checked: { at: number; health: Promise<ServiceHealth> } | null = null;
  return {
    health() {
      if (!checked || Date.now() - checked.at > 5000) checked = { at: Date.now(), health: client.health() };
      return checked.health;
    },
  };
}
