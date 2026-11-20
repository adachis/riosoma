import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { driverDefinition, type DriverId } from './catalog.js';
import { useInstalledDriver } from './storage.js';

export interface DriverColumn {
  name: string;
  type: string;
  nullable: boolean;
  length?: number;
  scale?: number;
}

/**
 * The only parts of the server's environment a driver's process sees: where programs are, and the
 * language and time zone it formats in.  Windows also needs its system folder to open sockets.
 */
const SHARED_ENVIRONMENT = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'SystemRoot'] as const;
/** An administrator can point IBM's client at its own configuration files with these */
const IBM_ENVIRONMENT = ['DB2CLIINIPATH', 'DB2DSDRIVER_CFG_PATH'] as const;

/**
 * Where the system looks for the libraries a native add-on needs, on each platform.  IBM's add-on for
 * macOS names its client library by the path it was built at, so the loader finds the installed one
 * through this, which the process has to start with.
 */
const LIBRARY_PATH: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'DYLD_LIBRARY_PATH',
  linux: 'LD_LIBRARY_PATH',
};

/**
 * The environment a driver's process starts with.  It's built from an allowlist rather than
 * copied, so the server's secret key, its database address, and every other setting stay out of
 * reach of the driver's code, and its temporary files and home folder are a private folder that
 * goes when the process does.  A driver with a vendor client is told where the installed client is,
 * and never uses one from anywhere else.
 */
export function driverEnvironment(
  id: DriverId,
  temporary: string,
  from: NodeJS.ProcessEnv = process.env,
  folder?: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [...SHARED_ENVIRONMENT, ...(id === 'ibm_db' ? IBM_ENVIRONMENT : [])]) {
    const value = from[name];
    if (value) env[name] = value;
  }
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'HOME']) env[name] = temporary;
  const client = driverDefinition(id)?.client;
  if (client && folder) {
    const home = join(folder, client);
    env.IBM_DB_HOME = home;
    const libraries = LIBRARY_PATH[platform];
    if (libraries) env[libraries] = [join(home, 'lib'), join(home, 'lib', 'icc')].join(delimiter);
  }
  return env;
}

/**
 * Removes every secret from a driver's words, in the forms native diagnostics render them: as
 * written, with ODBC's or JSON's escaping, and encoded for an address.
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  const forms = secrets
    .filter((secret): secret is string => Boolean(secret))
    .flatMap((secret) => [
      secret,
      secret.replaceAll('}', '}}'),
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const form of forms) text = text.split(form).join('[redacted]');
  return text;
}

/** Native calls may block their event loop.  A separate process gives every call a firm deadline. */
export async function driverProcess(ctx: ConnectorContext) {
  const id: DriverId = ctx.connection.kind === 'teradata' ? 'teradatasql' : 'ibm_db';
  // The revision stays in place while this connection is open, even after an update replaces it.
  const { url, folder, release } = await useInstalledDriver(id, ctx.driversDir);
  // The driver's process runs with the server's file access, so the source's secrets and the
  // server's are taken out of anything it says before that reaches the person testing the source.
  const secrets = [...Object.values(ctx.secrets), ...(ctx.serverSecrets ?? [])];
  const temporary = await mkdtemp(join(tmpdir(), 'drivers-')).catch((error: unknown) => {
    release();
    throw error;
  });
  let caFile: string | undefined;
  try {
    if (id === 'ibm_db' && 'caPem' in ctx.connection && ctx.connection.caPem) {
      caFile = join(temporary, 'root.pem');
      await writeFile(caFile, ctx.connection.caPem, { mode: 0o600 });
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    release();
    throw error;
  }
  const compiled = new URL('./worker.js', import.meta.url);
  const child = fork(existsSync(compiled) ? compiled : new URL('./worker.ts', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    execArgv: [],
    env: driverEnvironment(id, temporary, process.env, folder),
    serialization: 'advanced',
  });
  let sequence = 0;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const close = async () => {
    if (closed) return;
    closed = true;
    child.kill('SIGKILL');
    release();
    for (const request of pending.values()) request.reject(new ConnectorError('sources.sync.read'));
    pending.clear();
    await rm(temporary, { recursive: true, force: true });
  };
  child.on('error', () => {
    void close();
  });
  child.on('exit', () => {
    void close();
  });
  child.on('message', (answer: { id: number; value?: unknown; error?: string }) => {
    const request = pending.get(answer.id);
    pending.delete(answer.id);
    if (answer.error) request?.reject(new Error(redactSecrets(String(answer.error), secrets)));
    else request?.resolve(answer.value);
  });
  async function call<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
    if (closed) throw new ConnectorError('sources.sync.read');
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      child.send({ id, action, ...data }, (error) => {
        if (error) void close();
      });
    });
  }
  const abort = () => {
    void close();
  };
  const timer = setTimeout(abort, ctx.timeoutMs ?? 30000);
  ctx.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (ctx.signal?.aborted) throw new ConnectorError('sources.sync.read');
    await call('open', {
      url,
      caFile,
      connection: ctx.connection,
      secrets: ctx.secrets,
      timeoutMs: ctx.timeoutMs ?? 30000,
    });
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', abort);
  }
  return { call, close };
}
