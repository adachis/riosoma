import { createHash } from 'node:crypto';
import { remoteTransport, type FileTransport } from './remote.js';
import { createWriteStream } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP, createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { connect as tlsConnect } from 'node:tls';
import {
  parseRequestHeaders,
  type CellValue,
  type FileFormat,
  type FileSourceKind,
  type SourceConnection,
  type RemoteFileConnection,
  type SourceObject,
  type SourceObjectRef,
  type SourceSelect,
  type SourceTestResult,
  type TestStep,
} from '@riosoma/contracts';
import { Budget } from '../common.js';
import { sourceKey } from '../registry.js';
import { positive } from '../sql.js';
import {
  NotModified,
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourceRow,
  type ReadOptions,
} from '../types.js';
import { scrubDetail } from '../warehouses/errors.js';
import { RowBatcher } from '../warehouses/values.js';
import {
  FileEngine,
  KEYS as ENGINE_KEYS,
  type FileColumn,
  type LocalFile,
  type SpreadsheetReader,
} from './engine.js';
import {
  fileNameOf,
  formatOfContentType,
  formatOfName,
  localName,
  looksLike,
  parseUnionName,
  unionName,
} from './formats.js';
import {
  FileNetworkError,
  NO_NETWORK,
  type CheckedAddress,
  type FileNetwork,
  type FileResponse,
} from './network.js';
import {
  bucketHostUrl,
  bucketTarget,
  listUrl,
  objectUrl,
  parseError,
  parseListing,
  sign,
  type BucketTarget,
} from './s3.js';

/**
 * One connector for files, whether one sits at a web address or many sit in an S3-compatible
 * bucket.  Every call makes a private temporary directory, downloads what it reads through the
 * server's guarded network into it, reads the files with DuckDB locked into that directory, and
 * removes the directory before it returns.  Nothing is kept between calls, so a changed file or a
 * changed secret takes effect at once.
 *
 * DuckDB's own HTTP reader is never used: it resolves names and follows redirects itself, where the
 * private-network rule can't reach, so every byte arrives through the guarded client instead.
 */

type FileUrlSettings = Extract<SourceConnection, { kind: 'file-url' }>;
type BucketSettings = Extract<SourceConnection, { kind: 'bucket' }>;

export const FILE_KEYS = {
  https: 'sources.file.https',
  blocked: 'sources.file.blocked',
  tls: 'sources.file.tls',
  denied: 'sources.file.denied',
  keys: 'sources.file.keys',
  noBucket: 'sources.file.noBucket',
  region: 'sources.file.region',
  notFound: 'sources.file.notFound',
  status: 'sources.file.status',
  noFiles: 'sources.file.noFiles',
  empty: 'sources.file.empty',
  formatUnknown: 'sources.file.formatUnknown',
  unreadable: ENGINE_KEYS.unreadable,
  tooLarge: ENGINE_KEYS.tooLarge,
  tooManyFiles: 'sources.file.tooManyFiles',
  noQueries: 'sources.file.noQueries',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  columnMissing: 'sources.sync.columnMissing',
  timeout: 'sources.test.timeout',
} as const;

/** How a connection test's TCP and TLS steps reach the address the network checked. */
export interface Sockets {
  connect(address: CheckedAddress, port: number, signal: AbortSignal): Promise<void>;
  handshake(address: CheckedAddress, port: number, servername: string, signal: AbortSignal): Promise<void>;
}

function settle(
  socket: { once(event: string, listener: (error?: Error) => void): unknown; destroy(): void },
  ready: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      socket.destroy();
      signal.removeEventListener('abort', stop);
      if (error) reject(error);
      else resolve();
    };
    const stop = () => finish(new Error('the check was stopped'));
    signal.addEventListener('abort', stop, { once: true });
    socket.once(ready, () => finish());
    socket.once('error', (error) => finish(error ?? new Error('the connection failed')));
  });
}

export const nodeSockets: Sockets = {
  connect: (address, port, signal) =>
    settle(createConnection({ host: address.address, port, family: address.family }), 'connect', signal),
  handshake: (address, port, servername, signal) =>
    settle(
      tlsConnect({
        host: address.address,
        port,
        ...(isIP(servername) ? {} : { servername }),
      }),
      'secureConnect',
      signal,
    ),
};

export interface FileConnectorOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  transport?: FileTransport;
  /** Explicit permission for an unencrypted FTP connection to the normalized host. */
  allowPlainFtp?: (host: string) => boolean;
  /** Reads workbooks the way uploads are read.  Without one, `.xlsx` files can't be read. */
  spreadsheet?: SpreadsheetReader;
  /** The most one call downloads, across every file it reads: 2 GB unless set */
  maxBytes?: number;
  /** The largest workbook, which is read whole into memory: 50 MB unless set */
  spreadsheetMaxBytes?: number;
  /** How long downloading a call's files may take in all: 20 minutes unless set */
  deadlineMs?: number;
  /** Where each call's private directory goes: the system's temporary directory unless set */
  tempRoot?: string;
  /** The clock requests are signed with */
  now?: () => Date;
  sockets?: Sockets;
}

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SPREADSHEET_BYTES = 50 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
/** Readable files a bucket listing offers, and the most one object can read together. */
const MAX_FILES = 1_000;
/** Pages of a bucket's listing read before giving up on finding more. */
const MAX_PAGES = 10;
/** The first bytes a connection test reads. */
const HEAD_BYTES = 64 * 1024;
/** Files a connection test parses whole when their format can't be read from the first bytes. */
const TEST_WHOLE_BYTES = 16 * 1024 * 1024;
/** How much of an error answer is read for its code. */
const ERROR_BYTES = 16 * 1024;

/** One file to read: where it is, what to call it, and its format when that's already known. */
interface Remote {
  name: string;
  url: URL;
  format: FileFormat | null;
  bytes: number | null;
  modified?: string | null;
}

/** A call's downloaded files, read into an engine, and how to let them all go. */
interface Workspace {
  dir: string;
  engine: FileEngine;
  files: LocalFile[];
  dispose(): Promise<void>;
}

function megabytes(bytes: number): number {
  return Math.floor(bytes / 1024 / 1024);
}

async function readSome(body: AsyncIterable<Buffer>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

function isPrefixedKey(key: string, prefix: string): boolean {
  return (
    key.startsWith(prefix) &&
    !key.split('/').some((part) => part === '.' || part === '..') &&
    // eslint-disable-next-line no-control-regex
    !/[\0-\x1f\x7f]/.test(key)
  );
}

export function createFileConnector(kind: FileSourceKind, options: FileConnectorOptions = {}): Connector {
  const network = options.network ?? NO_NETWORK;
  const transport = options.transport;
  const sockets = options.sockets ?? nodeSockets;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const spreadsheetMaxBytes = options.spreadsheetMaxBytes ?? DEFAULT_SPREADSHEET_BYTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = options.now ?? (() => new Date());

  function settingsOf(ctx: ConnectorContext): FileUrlSettings | BucketSettings | RemoteFileConnection {
    if (ctx.connection.kind !== kind)
      throw new ConnectorError(
        FILE_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not ${kind}`,
      );
    return ctx.connection as FileUrlSettings | BucketSettings | RemoteFileConnection;
  }

  /** Header values and keys, which a scrubbed message must never hold, even in pieces. */
  function secretValues(ctx: ConnectorContext): string[] {
    const values: string[] = [];
    const headers = ctx.secrets.headers ? parseRequestHeaders(ctx.secrets.headers) : null;
    if (headers) values.push(...Object.values(headers));
    for (const name of ['accessKeyId', 'secretAccessKey'] as const)
      if (ctx.secrets[name]) values.push(ctx.secrets[name]);
    return values.filter((value) => value.length >= 4).sort((a, b) => b.length - a.length);
  }

  function scrubbed(
    error: unknown,
    ctx: ConnectorContext,
    files: readonly LocalFile[] = [],
    dir?: string,
  ): string | undefined {
    let text = scrubDetail(error, ctx);
    if (text === undefined) return undefined;
    for (const value of secretValues(ctx)) text = text.split(value).join('[redacted]');
    // DuckDB names the files by where they sit on disk, which means nothing to anyone else, and
    // quotes the query it ran, which was Riosoma's own and says nothing about the file.
    text = text.replace(/\s*LINE \d+:[\s\S]*$/, '');
    for (const file of files) text = text.split(file.path).join(file.name);
    if (dir) text = text.split(dir).join('[temporary directory]');
    return text.replace(/[^\s'"]*riosoma-source-[^\s'"]*/g, '[temporary directory]');
  }

  /** The error a call leaves with: a key people can act on, and the scrubbed words behind it. */
  function failure(
    error: unknown,
    ctx: ConnectorContext,
    select?: SourceSelect,
    space?: { dir?: string; files?: readonly LocalFile[] },
  ): ConnectorError {
    const files = space?.files ?? [];
    if (error instanceof NotModified) throw error;
    if (error instanceof Error && error.message === 'sources.remote.hostKey')
      return new ConnectorError('sources.remote.hostKey');
    if (error instanceof ConnectorError) {
      const timedOut = error.messageKey === FILE_KEYS.timeout;
      const detail =
        error.detail !== undefined
          ? scrubbed(error.detail, ctx, files, space?.dir)
          : timedOut
            ? `the source took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
            : ctx.signal?.aborted
              ? 'the call was stopped before it finished'
              : undefined;
      return new ConnectorError(timedOut ? FILE_KEYS.read : error.messageKey, detail, error.params);
    }
    if (error instanceof FileNetworkError) {
      const detail = scrubbed(error.detail ?? error.problem, ctx);
      switch (error.problem) {
        case 'https':
          return new ConnectorError(FILE_KEYS.https, detail);
        case 'blocked':
          return new ConnectorError(FILE_KEYS.blocked, detail);
        case 'tooLarge':
          return new ConnectorError(FILE_KEYS.tooLarge, detail, { megabytes: megabytes(maxBytes) });
        default:
          return new ConnectorError(FILE_KEYS.read, detail);
      }
    }
    if (ctx.signal?.aborted || (error instanceof Error && error.name === 'AbortError'))
      return new ConnectorError(FILE_KEYS.read, 'the call was stopped before it finished');
    // What's left is DuckDB, which says what it couldn't read about the file.
    return new ConnectorError(FILE_KEYS.unreadable, scrubbed(error, ctx, files, space?.dir), {
      object: select?.kind === 'object' ? select.object.name : '',
    });
  }

  function requestHeaders(
    ctx: ConnectorContext,
    method: 'GET' | 'HEAD',
    url: URL,
    extra: Record<string, string> = {},
  ) {
    const settings = settingsOf(ctx);
    if (settings.kind === 'file-url') {
      const headers = ctx.secrets.headers ? parseRequestHeaders(ctx.secrets.headers) : {};
      if (headers === null)
        throw new ConnectorError('sources.file.headers', 'the request headers are not one per line');
      return { 'user-agent': 'Riosoma-Sources', ...headers, ...extra };
    }
    if (settings.kind !== 'bucket') throw new ConnectorError(FILE_KEYS.read);
    const target = bucketTarget(settings);
    const accessKeyId = ctx.secrets.accessKeyId;
    const secretAccessKey = ctx.secrets.secretAccessKey;
    if (!accessKeyId || !secretAccessKey)
      throw new ConnectorError('sources.secretsMissing', 'the bucket keys aren’t stored');
    return {
      'user-agent': 'Riosoma-Sources',
      ...sign(method, url, target.region, { accessKeyId, secretAccessKey }, extra, now()),
    };
  }

  /** The error an answer outside 2xx stands for, read from its status and, for a bucket, its code. */
  async function refusal(response: FileResponse, name: string): Promise<ConnectorError> {
    let text = '';
    try {
      text = (await readSome(response.body, ERROR_BYTES)).toString('utf8');
    } catch {
      // The status alone still says enough.
    } finally {
      response.close();
    }
    const status = response.status;
    const found = kind === 'bucket' ? parseError(text) : null;
    const detail = `HTTP ${status}${found ? ` ${found.code}${found.message ? `: ${found.message}` : ''}` : ''}`;
    switch (found?.code) {
      case 'NoSuchKey':
        return new ConnectorError(FILE_KEYS.objectMissing, detail, { object: name });
      case 'NoSuchBucket':
        return new ConnectorError(FILE_KEYS.noBucket, detail);
      case 'PermanentRedirect':
      case 'AuthorizationHeaderMalformed':
      case 'IllegalLocationConstraintException':
        return new ConnectorError(FILE_KEYS.region, detail);
      case 'InvalidAccessKeyId':
      case 'SignatureDoesNotMatch':
      case 'AccessDenied':
      case 'InvalidToken':
      case 'ExpiredToken':
        return new ConnectorError(FILE_KEYS.keys, detail);
      default:
        break;
    }
    if (status === 401 || status === 403)
      return new ConnectorError(kind === 'bucket' ? FILE_KEYS.keys : FILE_KEYS.denied, detail);
    if (status === 404 || status === 410)
      return new ConnectorError(FILE_KEYS.objectMissing, detail, { object: name });
    return new ConnectorError(FILE_KEYS.status, detail, { status });
  }

  async function fetch(
    ctx: ConnectorContext,
    url: URL,
    method: 'GET' | 'HEAD',
    signal: AbortSignal,
    limit: number,
    extra: Record<string, string> = {},
  ): Promise<FileResponse> {
    if (transport) return transport.request(ctx, url, method, signal, limit);
    if (!network.allowsAddress(url))
      throw new FileNetworkError('https', `${url.protocol} addresses aren't allowed`);
    return network.request({
      url,
      method,
      headers: requestHeaders(ctx, method, url, extra),
      maxBytes: limit,
      signal,
      idleMs: positive(ctx.timeoutMs, 30000),
    });
  }

  /** A bucket's readable files under a prefix, a page at a time, stopping once there are enough. */
  async function listFiles(
    ctx: ConnectorContext,
    target: BucketTarget,
    prefix: string,
    format: FileFormat | undefined,
    signal: AbortSignal,
    enough = MAX_FILES,
  ): Promise<{ files: Remote[]; more: boolean }> {
    const files: Remote[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetch(
        ctx,
        listUrl(target, prefix, 1_000, token),
        'GET',
        signal,
        16 * 1024 * 1024,
      );
      if (response.status < 200 || response.status >= 300) {
        const refused = await refusal(response, prefix);
        // Keys that may read one file but not list the bucket still reach a prefix that names it.
        const single = format ?? formatOfName(prefix);
        if (page > 0 || refused.messageKey !== FILE_KEYS.keys || !single || prefix.endsWith('/'))
          throw refused;
        const head = await fetch(ctx, objectUrl(target, prefix), 'HEAD', signal, ERROR_BYTES);
        head.close();
        if (head.status < 200 || head.status >= 300) throw refused;
        const length = Number(head.headers['content-length']);
        return {
          files: [
            {
              name: prefix,
              url: objectUrl(target, prefix),
              format: single,
              bytes: Number.isSafeInteger(length) ? length : null,
            },
          ],
          more: false,
        };
      }
      let bodyText: string;
      try {
        bodyText = (await readSome(response.body, 16 * 1024 * 1024)).toString('utf8');
      } finally {
        response.close();
      }
      const listing = parseListing(bodyText);
      for (const object of listing.objects) {
        // Folder markers end in a slash and hold nothing.
        if (object.key.endsWith('/') || !isPrefixedKey(object.key, prefix)) continue;
        const found = format ?? formatOfName(object.key);
        if (!found) continue;
        if (files.length >= enough) return { files, more: true };
        files.push({
          name: object.key,
          url: objectUrl(target, object.key),
          format: found,
          bytes: object.bytes,
        });
      }
      if (!listing.next) return { files, more: false };
      token = listing.next;
    }
    return { files, more: true };
  }

  /** The files a select reads: the one at the address, or a bucket's file or files. */
  async function remotesOf(
    ctx: ConnectorContext,
    select: SourceSelect,
    signal: AbortSignal,
  ): Promise<Remote[]> {
    if (select.kind !== 'object')
      throw new ConnectorError(FILE_KEYS.noQueries, 'file sources read whole files');
    const settings = settingsOf(ctx);
    if (settings.kind === 'file-url') {
      const url = new URL(settings.url);
      return [
        { name: fileNameOf(url), url, format: settings.format ?? formatOfName(url.pathname), bytes: null },
      ];
    }
    if (transport) {
      const files = await transport.list(ctx, signal);
      const union = parseUnionName(select.object.name);
      const selected = union
        ? files.filter(
            (file) =>
              file.format === union.format && union.prefix === ('path' in settings ? settings.path : ''),
          )
        : files.filter((file) => file.name === select.object.name);
      if (!selected.length)
        throw new ConnectorError(FILE_KEYS.objectMissing, undefined, { object: select.object.name });
      return selected;
    }
    if (settings.kind !== 'bucket') throw new ConnectorError(FILE_KEYS.read);
    const target = bucketTarget(settings);
    const { name } = select.object;
    const union = parseUnionName(name);
    const missing = () =>
      new ConnectorError(FILE_KEYS.objectMissing, `the bucket has nothing named ${name} under the prefix`, {
        object: name,
      });
    if (union) {
      if (
        !isPrefixedKey(union.prefix, settings.prefix) ||
        (settings.format && settings.format !== union.format)
      )
        throw missing();
      const { files, more } = await listFiles(ctx, target, union.prefix, settings.format, signal, MAX_FILES);
      const matching = files.filter((file) => file.format === union.format);
      if (more)
        throw new ConnectorError(
          FILE_KEYS.tooManyFiles,
          `more than ${MAX_FILES} files are under ${union.prefix}`,
          {
            files: MAX_FILES,
          },
        );
      if (!matching.length) throw missing();
      return matching;
    }
    if (!isPrefixedKey(name, settings.prefix) || name.endsWith('/')) throw missing();
    return [
      { name, url: objectUrl(target, name), format: settings.format ?? formatOfName(name), bytes: null },
    ];
  }

  /** Downloads one file into the directory, refusing it once the call's bytes run out. */
  async function download(
    ctx: ConnectorContext,
    remote: Remote,
    dir: string,
    index: number,
    signal: AbortSignal,
    room: number,
  ): Promise<{ file: LocalFile; bytes: number }> {
    const response = await fetch(ctx, remote.url, 'GET', signal, room);
    if (response.status < 200 || response.status >= 300) throw await refusal(response, remote.name);
    try {
      const format = remote.format ?? formatOfContentType(response.headers['content-type']);
      if (!format)
        throw new ConnectorError(
          FILE_KEYS.formatUnknown,
          `neither ${remote.name} nor its content type names a format`,
        );
      const path = join(dir, localName(index, format));
      let bytes = 0;
      const counted = async function* (): AsyncGenerator<Buffer> {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > room) throw new FileNetworkError('tooLarge', `${remote.name} is larger than the limit`);
          yield chunk;
        }
      };
      await pipeline(Readable.from(counted()), createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal,
      });
      return { file: { name: remote.name, path, format }, bytes };
    } finally {
      response.close();
    }
  }

  /** A private directory for one call, removed with everything in it when the call is done. */
  async function workspace(): Promise<string> {
    return realpath(await mkdtemp(join(options.tempRoot ?? tmpdir(), 'riosoma-source-')));
  }

  /**
   * Everything a call reads, downloaded and loaded.  Downloads answer to the call's own signal and
   * to one deadline for all of them, and each quiet stretch while reading may last the call's
   * timeout, so a large file can take its time while a stalled one can't.
   */
  async function prepare(
    ctx: ConnectorContext,
    select: SourceSelect,
    readOptions?: ReadOptions,
  ): Promise<Workspace> {
    if (ctx.signal?.aborted) throw new ConnectorError(FILE_KEYS.read);
    const signal = AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(deadlineMs)]);
    const dir = await workspace();
    const files: LocalFile[] = [];
    let engine: FileEngine | undefined;
    const dispose = async () => {
      engine?.close();
      await rm(dir, { recursive: true, force: true });
    };
    try {
      const remotes = await remotesOf(ctx, select, signal);
      if (transport && remotes.every((file) => file.modified != null && file.bytes != null)) {
        const etag = createHash('sha256')
          .update(JSON.stringify(remotes.map((file) => [file.name, file.bytes, file.modified])))
          .digest('hex');
        readOptions?.onValidators?.({ etag });
        if (readOptions?.since?.etag === etag) throw new NotModified();
      }
      let used = 0;
      for (const [index, remote] of remotes.entries()) {
        const { file, bytes } = await download(ctx, remote, dir, index, signal, maxBytes - used);
        used += bytes;
        files.push(file);
      }
      const formats = new Set(files.map((file) => file.format));
      if (formats.size > 1)
        throw new ConnectorError(FILE_KEYS.unreadable, 'files read together must share a format');
      engine = await FileEngine.open(dir);
      const opened = engine;
      // Loading is local work that grows with the files, so it shares the downloads' deadline.
      const stop = () => opened.interrupt();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await opened.load(files, {
          sheet: settingsOf(ctx).sheet,
          spreadsheet: options.spreadsheet,
          spreadsheetMaxBytes,
          signal,
        });
      } finally {
        signal.removeEventListener('abort', stop);
      }
      signal.throwIfAborted();
      return { dir, engine, files, dispose };
    } catch (error) {
      const thrown = failure(error, ctx, select, { dir, files });
      await dispose();
      throw thrown;
    }
  }

  /** Runs one question against a call's files, then lets them go. */
  async function call<T>(
    ctx: ConnectorContext,
    select: SourceSelect,
    action: (space: Workspace, budget: Budget) => Promise<T>,
  ): Promise<T> {
    const space = await prepare(ctx, select);
    try {
      const budget = new Budget(ctx);
      return await budget.run(
        () => action(space, budget),
        () => space.engine.interrupt(),
      );
    } catch (error) {
      throw failure(error, ctx, select, space);
    } finally {
      await space.dispose();
    }
  }

  async function listObjects(ctx: ConnectorContext): Promise<SourceObject[]> {
    const signal = AbortSignal.any([
      ...(ctx.signal ? [ctx.signal] : []),
      AbortSignal.timeout(positive(ctx.timeoutMs, 30000)),
    ]);
    try {
      const settings = settingsOf(ctx);
      if (settings.kind === 'file-url') {
        const url = new URL(settings.url);
        let bytes: number | null = null;
        const response = await fetch(ctx, url, 'HEAD', signal, ERROR_BYTES);
        // A server that won't answer HEAD still gets its chance when the file is read.
        if ([401, 403, 404, 410].includes(response.status)) throw await refusal(response, fileNameOf(url));
        response.close();
        const length = Number(response.headers['content-length']);
        if (response.status >= 200 && response.status < 300 && Number.isSafeInteger(length)) bytes = length;
        return [{ schema: null, name: fileNameOf(url), type: 'file', rowEstimate: null, bytes }];
      }
      if (!transport && settings.kind !== 'bucket') throw new ConnectorError(FILE_KEYS.read);
      const { files } = transport
        ? { files: await transport.list(ctx, signal) }
        : await listFiles(
            ctx,
            bucketTarget(settings as BucketSettings),
            (settings as BucketSettings).prefix,
            settings.format,
            signal,
          );
      const unions: SourceObject[] = [];
      const byFormat = new Map<FileFormat, Remote[]>();
      for (const file of files) byFormat.set(file.format!, [...(byFormat.get(file.format!) ?? []), file]);
      for (const [format, group] of byFormat)
        if (group.length > 1)
          unions.push({
            schema: null,
            name: unionName('path' in settings ? settings.path : (settings as BucketSettings).prefix, format),
            type: 'files',
            rowEstimate: null,
            bytes: group.every((file) => file.bytes !== null)
              ? group.reduce((sum, file) => sum + file.bytes!, 0)
              : null,
            files: group.length,
          });
      return [
        ...unions,
        ...files.map((file): SourceObject => ({
          schema: null,
          name: file.name,
          type: 'file',
          rowEstimate: null,
          bytes: file.bytes,
        })),
      ];
    } catch (error) {
      throw failure(error, ctx);
    }
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    let serverVersion: string | undefined;
    let dir: string | undefined;
    let engine: FileEngine | undefined;
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    const begin = (step: TestStep) => {
      current = step;
      start = Date.now();
    };
    try {
      const budget = new Budget(ctx);
      /** One step's work, stopped when the budget runs out or the caller gives up. */
      const within = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        try {
          return await budget.run(
            () => action(AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])])),
            () => controller.abort(),
          );
        } finally {
          controller.abort();
        }
      };
      const settings = settingsOf(ctx);
      if (transport) {
        const address = transport.address(ctx);
        const checked = await within((signal) => network.check(address, signal));
        passed('resolve');
        begin('connect');
        await within((signal) =>
          sockets.connect(checked, Number(address.port || (address.protocol === 'http:' ? 80 : 443)), signal),
        );
        passed('connect');
        begin('authenticate');
        const files = await within((signal) => transport.list(ctx, signal));
        passed('authenticate');
        if (settings.kind !== 'ftp') steps.push({ step: 'tls', status: 'ok', ms: null });
        begin('read');
        const file = files[0];
        if (!file) throw new ConnectorError(FILE_KEYS.noFiles);
        const first = await within(async (signal) => {
          const response = await fetch(ctx, file.url, 'GET', signal, maxBytes);
          try {
            return await readSome(response.body, HEAD_BYTES);
          } finally {
            response.close();
          }
        });
        if (!first.length) throw new ConnectorError(FILE_KEYS.empty);
        passed('read');
        begin('parse');
        await call(ctx, { kind: 'object', object: { schema: null, name: file.name } }, async (space) =>
          space.engine.describe(),
        );
        passed('parse');
        return { ok: true, steps };
      }
      if (settings.kind !== 'bucket' && settings.kind !== 'file-url')
        throw new ConnectorError(FILE_KEYS.read);
      const target = settings.kind === 'bucket' ? bucketTarget(settings) : null;
      const address = settings.kind === 'bucket' ? bucketHostUrl(target!) : new URL(settings.url);
      const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));

      if (!network.allowsAddress(address))
        throw new FileNetworkError('https', `${address.protocol} addresses aren't allowed`);
      const checked = await within((signal) => network.check(address, signal));
      passed('resolve');
      begin('connect');
      await within((signal) => sockets.connect(checked, port, signal));
      passed('connect');
      begin('tls');
      if (address.protocol === 'https:') {
        await within((signal) => sockets.handshake(checked, port, address.hostname, signal));
        passed('tls');
      } else steps.push({ step: 'tls', status: 'skipped', ms: null });

      begin('authenticate');
      let remote: Remote;
      if (target) {
        const listing = await within((signal) =>
          listFiles(ctx, target, (settings as BucketSettings).prefix, settings.format, signal, 1),
        );
        passed('authenticate');
        begin('read');
        if (!listing.files[0])
          throw new ConnectorError(
            FILE_KEYS.noFiles,
            `no file under ${(settings as BucketSettings).prefix || 'the bucket'} has a format Riosoma reads`,
          );
        remote = listing.files[0];
      } else {
        const url = new URL((settings as FileUrlSettings).url);
        remote = {
          name: fileNameOf(url),
          url,
          format: settings.format ?? formatOfName(url.pathname),
          bytes: null,
        };
        const response = await within((signal) => fetch(ctx, url, 'HEAD', signal, ERROR_BYTES));
        serverVersion = response.headers.server?.slice(0, 100);
        // Servers that don't answer HEAD are asked for the first bytes instead.
        if (response.status >= 400 && response.status !== 405 && response.status !== 501)
          throw await refusal(response, remote.name);
        response.close();
        const length = Number(response.headers['content-length']);
        if (response.status < 300 && Number.isSafeInteger(length)) remote.bytes = length;
        passed('authenticate');
        begin('read');
      }

      const first = await within(async (signal) => {
        const response = await fetch(ctx, remote.url, 'GET', signal, maxBytes, {
          range: `bytes=0-${HEAD_BYTES - 1}`,
        });
        if (response.status < 200 || response.status >= 300) throw await refusal(response, remote.name);
        try {
          serverVersion ??= response.headers.server?.slice(0, 100);
          const whole = /\/(\d+)$/.exec(response.headers['content-range'] ?? '')?.[1];
          const length = Number(response.headers['content-length']);
          const total =
            whole !== undefined
              ? Number(whole)
              : response.status === 200 && Number.isSafeInteger(length)
                ? length
                : remote.bytes;
          return {
            head: await readSome(response.body, HEAD_BYTES),
            format: remote.format ?? formatOfContentType(response.headers['content-type']),
            total,
          };
        } finally {
          response.close();
        }
      });
      if (first.head.length === 0) throw new ConnectorError(FILE_KEYS.empty, `${remote.name} is empty`);
      if (!first.format)
        throw new ConnectorError(
          FILE_KEYS.formatUnknown,
          `neither ${remote.name} nor its content type names a format`,
        );
      passed('read');

      begin('parse');
      const format = first.format;
      if (!looksLike(format, first.head))
        throw new ConnectorError(
          FILE_KEYS.unreadable,
          `the start of ${remote.name} doesn't look like ${format}`,
        );
      const complete = first.total !== null && first.total !== undefined && first.head.length >= first.total;
      const lines = format === 'csv' || format === 'tsv' || format === 'ndjson';
      if (!complete && !lines && (first.total ?? Infinity) > TEST_WHOLE_BYTES) {
        // Parquet, JSON arrays, and workbooks are only readable whole, and this one is large.
        steps.push({ step: 'parse', status: 'skipped', ms: null });
        return { ok: true, steps, ...(serverVersion ? { serverVersion } : {}) };
      }
      dir = await workspace();
      let file: LocalFile;
      if (complete || lines) {
        // Line formats read from their first whole lines, and the rest waits for the first sync.
        const end = complete ? first.head.length : first.head.lastIndexOf(0x0a) + 1;
        if (end <= 0)
          throw new ConnectorError(
            FILE_KEYS.unreadable,
            `the first line of ${remote.name} is too long to test`,
          );
        file = { name: remote.name, path: join(dir, localName(0, format)), format };
        await writeFile(file.path, first.head.subarray(0, end), { mode: 0o600 });
      } else {
        const into = dir;
        file = (
          await within((signal) => download(ctx, { ...remote, format }, into, 0, signal, TEST_WHOLE_BYTES))
        ).file;
      }
      engine = await FileEngine.open(dir);
      const opened = engine;
      await within(() =>
        opened.load([file], { sheet: settings.sheet, spreadsheet: options.spreadsheet, spreadsheetMaxBytes }),
      );
      await within(() => opened.describe());
      passed('parse');
      return { ok: true, steps, ...(serverVersion ? { serverVersion } : {}) };
    } catch (error) {
      const detail = scrubbed(error instanceof ConnectorError ? (error.detail ?? '') : error, ctx, [], dir);
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey: testKey(error, current),
        ...(detail ? { detail } : {}),
      });
      return { ok: false, steps };
    } finally {
      engine?.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  /** The advice a failed step carries.  Keys that need a value filled in give way to the step's own. */
  function testKey(error: unknown, step: TestStep): string {
    if (error instanceof Error && error.message === 'sources.remote.hostKey') return 'sources.remote.hostKey';
    if (error instanceof ConnectorError) {
      if (error.messageKey === FILE_KEYS.timeout) return FILE_KEYS.timeout;
      if (
        [
          FILE_KEYS.https,
          'sources.file.ftp',
          'sources.remote.host',
          FILE_KEYS.blocked,
          FILE_KEYS.denied,
          FILE_KEYS.keys,
          FILE_KEYS.noBucket,
          FILE_KEYS.region,
          FILE_KEYS.status,
          FILE_KEYS.noFiles,
          FILE_KEYS.empty,
          FILE_KEYS.formatUnknown,
          'sources.secretsMissing',
          'sources.file.headers',
        ].includes(error.messageKey as never)
      )
        return error.messageKey;
      if (error.messageKey === FILE_KEYS.objectMissing) return FILE_KEYS.notFound;
      return `sources.test.${step}`;
    }
    if (error instanceof FileNetworkError) {
      if (error.problem === 'https') return FILE_KEYS.https;
      if (error.problem === 'blocked') return FILE_KEYS.blocked;
      if (error.problem === 'resolve') return 'sources.test.resolve';
    }
    const text =
      error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : '';
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) return FILE_KEYS.timeout;
    if (step === 'tls') return FILE_KEYS.tls;
    return `sources.test.${step}`;
  }

  return {
    kind,
    test,
    listObjects,
    describe: (ctx, select) =>
      call(ctx, select, async (space) => (await space.engine.describe()).map((entry) => entry.column)),
    async preview(ctx, select, limit) {
      try {
        positive(limit, 50);
      } catch (error) {
        throw failure(error, ctx, select);
      }
      return call(ctx, select, async (space) => {
        const columns = await space.engine.describe();
        const rows: CellValue[][] = [];
        for await (const chunk of space.engine.rows(
          columns.map((entry) => entry.column.name),
          limit,
        ))
          for (const row of chunk)
            rows.push(
              columns.map((entry, index) =>
                entry.column.suggested ? entry.value(row[index], entry.column.suggested.type) : null,
              ),
            );
        return {
          columns: columns.map((entry) => entry.column),
          rows,
          rowEstimate: await space.engine.count(),
        };
      });
    },
    keyCandidates: (ctx, object: SourceObjectRef) =>
      call(ctx, { kind: 'object', object }, async (space) =>
        space.engine.keyCandidates(await space.engine.describe()),
      ),
    async *read(ctx, select, readOptions) {
      let space: Workspace | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        space = await prepare(ctx, select, readOptions);
        const { engine } = space;
        const budget = new Budget(ctx);
        const cancel = () => engine.interrupt();
        const columns = await budget.run(() => engine.describe(), cancel);
        const byName = new Map(columns.map((entry) => [entry.column.name, entry]));
        // Key columns are read even when they aren't among the values, as the other connectors do.
        const names = [...new Set([...readOptions.columns, ...readOptions.keyColumns])];
        const requested: FileColumn[] = names.map((name) => {
          const entry = byName.get(name);
          if (!entry) throw new ConnectorError(FILE_KEYS.columnMissing, undefined, { column: name });
          return entry;
        });
        const at = new Map(names.map((name, index) => [name, index]));
        const toRow = (row: unknown[]): SourceRow => ({
          key: sourceKey(
            readOptions.keyColumns.map((name) => requested[at.get(name)!]!.key(row[at.get(name)!])),
          ),
          values: Object.fromEntries(
            readOptions.columns.map((name) => {
              const entry = requested[at.get(name)!]!;
              return [
                name,
                entry.value(
                  row[at.get(name)!],
                  readOptions.types[name] ?? entry.column.suggested?.type ?? 'text',
                ),
              ];
            }),
          ),
        });
        const iterator = engine.rows(names)[Symbol.asyncIterator]();
        const batcher = new RowBatcher<SourceRow>(size);
        const stopIfAborted = () => {
          if (ctx.signal?.aborted) throw new ConnectorError(FILE_KEYS.read);
        };
        try {
          for (;;) {
            const next = await budget.run(() => iterator.next(), cancel);
            if (next.done) break;
            for (const batch of batcher.add(next.value.map(toRow))) {
              stopIfAborted();
              yield batch;
              budget.renew();
            }
          }
          const rest = batcher.flush();
          stopIfAborted();
          if (rest) yield rest;
        } finally {
          await iterator.return?.(undefined)?.catch(() => undefined);
        }
      } catch (error) {
        throw failure(error, ctx, select, space);
      } finally {
        await space?.dispose();
      }
    },
  };
}

/** Both file connectors, sharing one set of options. */
export function createFileConnectors(options: FileConnectorOptions = {}): Connector[] {
  return [
    createFileConnector('file-url', options),
    createFileConnector('bucket', options),
    ...(['sftp', 'ftp', 'ftps', 'webdav'] as const).map((kind) =>
      createFileConnector(kind, {
        ...options,
        transport: remoteTransport(options.network, options.allowPlainFtp),
      }),
    ),
  ];
}
