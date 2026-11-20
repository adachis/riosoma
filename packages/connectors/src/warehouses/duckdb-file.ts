import { constants } from 'node:fs';
import { mkdtemp, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import {
  parseRequestHeaders,
  type DuckDbFileConnection,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import { Budget, resource } from '../common.js';
import { NO_NETWORK, type FileNetwork } from '../files/network.js';
import { bucketTarget, listUrl, objectUrl, parseListing, sign } from '../files/s3.js';
import { registerConnector } from '../registry.js';
import { ConnectorError, type Connector, type ConnectorContext } from '../types.js';
import { awsCredentials } from './aws.js';
import { connectionOf } from './errors.js';
import { makeWarehouseConnector, type WarehouseSession } from './frame.js';
import { DuckSession, duckMissing } from './motherduck.js';
import { literal } from './sql.js';

export interface DuckDbFileOptions {
  allowedRoots?: readonly string[];
  network?: FileNetwork;
  maxBytes?: number;
}

/** Resolving both sides prevents a sibling directory or symlink from widening the allowlist. */
export async function allowedDuckPath(path: string, roots: readonly string[]): Promise<string> {
  if (!isAbsolute(path)) throw new ConnectorError('sources.duckdb.pathBlocked');
  const resolved = await realpath(path);
  for (const root of roots) {
    if (!isAbsolute(root)) continue;
    const base = await realpath(root);
    const part = relative(base, resolved);
    if (part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))) return resolved;
  }
  throw new ConnectorError('sources.duckdb.pathBlocked');
}

async function stage(
  ctx: ConnectorContext,
  settings: DuckDbFileConnection,
  dir: string,
  options: DuckDbFileOptions,
): Promise<string[]> {
  const maximum = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  let remaining = maximum;
  const paths: string[] = [];
  const append = async (body: AsyncIterable<Uint8Array>, name: string) => {
    if (paths.length >= 1_000) throw new ConnectorError('sources.file.tooManyFiles');
    if (settings.format === 'duckdb' && paths.length) throw new ConnectorError('sources.duckdb.oneDatabase');
    // DuckDB derives its catalog from the filename, which stored views may qualify explicitly.
    const path = join(
      dir,
      settings.format === 'duckdb'
        ? basename(name) || 'source.duckdb'
        : `part-${paths.length}.${settings.format}`,
    );
    const handle = await open(path, 'wx', 0o600);
    try {
      for await (const chunk of body) {
        ctx.signal?.throwIfAborted();
        remaining -= chunk.byteLength;
        if (remaining < 0)
          throw new ConnectorError('sources.file.tooLarge', undefined, {
            megabytes: Math.floor(maximum / 1024 / 1024),
          });
        await handle.writeFile(chunk);
      }
      paths.push(path);
    } finally {
      await handle.close();
    }
  };
  if (settings.storage === 'local') {
    const roots = options.allowedRoots ?? [];
    const path = await allowedDuckPath(settings.path!, roots);
    const info = await stat(path);
    const files = info.isDirectory()
      ? (await readdir(path))
          .filter((name) => name.toLowerCase().endsWith(`.${settings.format}`))
          .sort()
          .map((name) => join(path, name))
      : [path];
    for (const file of files) {
      if (!file.toLowerCase().endsWith(`.${settings.format}`))
        throw new ConnectorError('sources.file.formatUnknown');
      const resolved = await allowedDuckPath(file, roots);
      if (
        settings.format === 'duckdb' &&
        (await stat(`${resolved}.wal`).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        ))
      )
        throw new ConnectorError('sources.duckdb.activeFile');
      const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await handle.stat()).isFile()) throw new ConnectorError('sources.file.unreadable');
        await append(handle.createReadStream({ autoClose: false }), resolved);
      } finally {
        await handle.close();
      }
    }
  } else {
    const network = options.network ?? NO_NETWORK;
    const signal = AbortSignal.any([
      AbortSignal.timeout(ctx.timeoutMs ?? 30_000),
      ...(ctx.signal ? [ctx.signal] : []),
    ]);
    const target =
      settings.storage === 'bucket'
        ? bucketTarget({ bucket: settings.bucket!, region: settings.region, pathStyle: false })
        : undefined;
    const request = async (url: URL, maxBytes: number) => {
      if (!network.allowsAddress(url)) throw new ConnectorError('sources.file.https');
      const headers = target
        ? sign('GET', url, target.region, awsCredentials(ctx))
        : parseRequestHeaders(ctx.secrets.headers ?? '');
      if (!headers) throw new ConnectorError('sources.file.denied');
      const response = await network.request({
        url,
        method: 'GET',
        headers,
        maxBytes,
        signal,
        idleMs: ctx.timeoutMs ?? 30_000,
      });
      if (response.status < 200 || response.status >= 300) {
        response.close();
        throw new ConnectorError('sources.file.status', undefined, { status: response.status });
      }
      return response;
    };
    const urls: URL[] = [];
    if (target) {
      let next: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await request(listUrl(target, settings.prefix, 1_000, next), 16 * 1024 * 1024);
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > 16 * 1024 * 1024) throw new ConnectorError('sources.file.tooManyFiles');
            chunks.push(chunk);
          }
        } finally {
          response.close();
        }
        const listing = parseListing(Buffer.concat(chunks).toString('utf8'));
        for (const object of listing.objects) {
          const within =
            object.key === settings.prefix ||
            object.key.startsWith(settings.prefix.endsWith('/') ? settings.prefix : `${settings.prefix}/`) ||
            settings.prefix === '';
          if (within && object.key.toLowerCase().endsWith(`.${settings.format}`))
            urls.push(objectUrl(target, object.key));
        }
        if (urls.length > 1_000) throw new ConnectorError('sources.file.tooManyFiles');
        next = listing.next ?? undefined;
        if (next && (seen.has(next) || seen.size >= 100))
          throw new ConnectorError('sources.file.tooManyFiles');
        if (next) seen.add(next);
      } while (next);
    } else urls.push(new URL(settings.url!));
    for (const url of urls) {
      const response = await request(url, remaining);
      try {
        await append(response.body, decodeURIComponent(url.pathname));
      } finally {
        response.close();
      }
    }
  }
  if (!paths.length) throw new ConnectorError('sources.file.noFiles');
  if (settings.format === 'duckdb' && paths.length !== 1)
    throw new ConnectorError('sources.duckdb.oneDatabase');
  return paths;
}

export function createDuckDbFileConnector(options: DuckDbFileOptions = {}): Connector {
  async function openSession(
    ctx: ConnectorContext,
    onRead: () => void = () => {},
  ): Promise<WarehouseSession> {
    const settings = connectionOf(ctx, 'duckdb-file');
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'warehouse-files-')));
    let instance: DuckDBInstance | undefined;
    let connection: DuckDBConnection | undefined;
    try {
      const files = await stage(ctx, settings, dir, options);
      onRead();
      instance = await DuckDBInstance.create(settings.format === 'duckdb' ? files[0]! : ':memory:', {
        ...(settings.format === 'duckdb' ? { access_mode: 'READ_ONLY' } : {}),
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
        threads: '2',
        memory_limit: '1GB',
      });
      connection = await instance.connect();
      await connection.run(`SET allowed_paths = [${files.map(literal).join(', ')}]`);
      await connection.run('SET enable_external_access = false');
      await connection.run('SET lock_configuration = true');
      if (settings.format !== 'duckdb') {
        const reader = settings.format === 'parquet' ? 'read_parquet' : 'read_csv';
        await connection.run(
          `CREATE TABLE data AS SELECT * FROM ${reader}([${files.map(literal).join(', ')}], union_by_name = true)`,
        );
      }
      await connection.run('BEGIN TRANSACTION READ ONLY');
      const catalog = await connection.runAndReadAll('SELECT current_database() AS name');
      const session = new DuckSession(instance, connection, String(catalog.getRowObjectsJS()[0]!.name));
      const originalClose = session.close.bind(session);
      session.close = async () => {
        try {
          await originalClose();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      };
      return session;
    } catch (error) {
      try {
        connection?.disconnectSync();
        instance?.closeSync();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      // A local engine error may include paths, which are never useful outside source administration.
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError('sources.file.unreadable');
    }
  }
  const connector = makeWarehouseConnector({
    kind: 'duckdb-file',
    endpoint: () => null,
    missing: duckMissing,
    open: openSession,
  });
  return {
    ...connector,
    async test(ctx): Promise<SourceTestResult> {
      const steps: SourceTestResult['steps'] = [];
      let current: TestStep = 'read';
      let finished = false;
      let start = Date.now();
      let session: WarehouseSession | undefined;
      const passed = () => {
        if (finished) return;
        steps.push({ step: current, status: 'ok', ms: Date.now() - start });
        start = Date.now();
      };
      try {
        const budget = new Budget(ctx);
        session = await resource(budget, () =>
          openSession(ctx, () => {
            passed();
            current = 'parse';
          }),
        );
        passed();
        current = 'query';
        const opened = session;
        const serverVersion = await budget.run(
          () => opened.version(),
          () => {
            void opened.close().catch(() => undefined);
          },
        );
        passed();
        return { ok: true, steps, serverVersion };
      } catch (error) {
        steps.push({
          step: current,
          status: 'failed',
          ms: Date.now() - start,
          messageKey: error instanceof ConnectorError ? error.messageKey : 'sources.file.unreadable',
        });
        return { ok: false, steps };
      } finally {
        finished = true;
        await session?.close();
      }
    },
  };
}

registerConnector(createDuckDbFileConnector());
