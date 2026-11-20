import { isIP } from 'node:net';
import { AppError, SPREADSHEET_LIMITS, type SourceConnection } from '@riosoma/contracts';
import {
  ConnectorError,
  createFileConnectors,
  createDuckDbFileConnector,
  FileNetworkError,
  registerConnector,
  remoteFileAddress,
  type FileConnectorOptions,
  type FileNetwork,
  type SpreadsheetReader,
} from '@riosoma/connectors';
import type { FastifyInstance } from 'fastify';
import { isPublicAddress, systemResolve, type Resolve } from '../automations/outbound.js';
import type { RuntimeConfig } from '../config.js';
import { checkedAddress, download, DownloadError } from '../data/imports/download.js';
import { readSpreadsheet } from '../data/imports/spreadsheet.js';
import { allowsPrivate, bare, isLocalhost } from '../webhooks/url.js';
import { hostGuard, privateHostAllowed, refusedHost } from './hosts.js';

/**
 * File sources on this server: the connectors, given the same guarded client imports and webhooks
 * use and the same workbook reader uploads use.  Addresses are https, except plain http to
 * `localhost` while private hosts are allowed, which is the rule webhooks follow too.  A file
 * server's host meets the same rule.  Plain FTP is limited to localhost while private hosts are
 * allowed, since it sends its password unencrypted.
 */

type Config = Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts' | 'sourceFileMaxBytes'>;

export interface FileNetworkOptions {
  resolve: Resolve;
  /** Whether a request to this address may reach a private network */
  allowPrivate(url: URL): boolean;
}

function problemOf(error: unknown, signal?: AbortSignal): FileNetworkError {
  if (error instanceof FileNetworkError) return error;
  if (signal?.aborted) return new FileNetworkError('failed', 'the download was stopped or ran out of time');
  if (error instanceof DownloadError) {
    if (error.problem === 'blocked') return new FileNetworkError('blocked', error.detail);
    if (error.problem === 'tooLarge') return new FileNetworkError('tooLarge');
    if (error.detail === 'resolve') return new FileNetworkError('resolve', 'the host name did not resolve');
    return new FileNetworkError('failed', error.detail);
  }
  return new FileNetworkError('failed', error instanceof Error ? error.message : undefined);
}

/** The guarded network a file source reaches the world through. */
export function fileNetwork(options: FileNetworkOptions): FileNetwork {
  const allowsAddress = (url: URL) =>
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && isLocalhost(url.hostname) && options.allowPrivate(url));
  return {
    allowsAddress,
    async check(url, signal) {
      if (!allowsAddress(url))
        throw new FileNetworkError('https', `${url.protocol} addresses aren't allowed`);
      try {
        signal.throwIfAborted();
        return await checkedAddress(url, options);
      } catch (error) {
        throw problemOf(error, signal);
      }
    },
    async request(request) {
      try {
        const answer = await download(request.url.href, {
          resolve: options.resolve,
          allowPrivate: options.allowPrivate,
          allowUrl: allowsAddress,
          method: request.method,
          headers: request.headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          maxBytes: request.maxBytes,
          signal: request.signal,
          timeoutMs: request.idleMs,
          anyStatus: true,
        });
        const body = answer.body;
        return {
          status: answer.status,
          headers: Object.fromEntries(
            Object.entries(answer.headers).map(([name, value]) => [
              name.toLowerCase(),
              Array.isArray(value) ? value.join(', ') : value,
            ]),
          ),
          url: answer.url,
          body: (async function* () {
            try {
              for await (const chunk of body) yield chunk as Buffer;
            } catch (error) {
              throw problemOf(error, request.signal);
            }
          })(),
          close: () => body.destroy(),
        };
      } catch (error) {
        throw problemOf(error, request.signal);
      }
    },
  };
}

/** Workbooks are read the way uploads are, with no cap on rows, since a sync can't leave any out. */
export const spreadsheetReader: SpreadsheetReader = (bytes, { signal }) =>
  readSpreadsheet(bytes, { signal, rowsPerSheet: Number.MAX_SAFE_INTEGER });

export function fileConnectorOptions(config: Config, resolve: Resolve = systemResolve): FileConnectorOptions {
  return {
    network: fileNetwork({ resolve, allowPrivate: (url) => allowsPrivate(url.href, config) }),
    allowPlainFtp: (host) => isLocalhost(host) && privateHostAllowed(host, config),
    spreadsheet: spreadsheetReader,
    spreadsheetMaxBytes: SPREADSHEET_LIMITS.uploadBytes,
    ...(config.sourceFileMaxBytes === undefined ? {} : { maxBytes: config.sourceFileMaxBytes }),
  };
}

/** Registers both file connectors with this server's network and limits. */
export function installFileSources(app: FastifyInstance): void {
  registerConnector(
    createDuckDbFileConnector({
      ...fileConnectorOptions(app.ctx.config),
      allowedRoots: app.ctx.config.sourceDuckDbRoots ?? [],
    }),
  );
  for (const connector of createFileConnectors(fileConnectorOptions(app.ctx.config)))
    registerConnector(connector);
}

export function refuse(field: string, key: string): never {
  throw new AppError('validation_failed', key, { fields: { [field]: key } });
}

/**
 * What keeps an address from being reached under the private-network rule, if anything: it must
 * be https, or plain http to `localhost` while private hosts are allowed, and a literal private
 * address needs private hosts allowed too.  Names that resolve somewhere private are caught again
 * when they're asked for.
 */
export function addressProblem(
  address: string,
  config: Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>,
): 'https' | 'blocked' | null {
  const url = new URL(address);
  const local = isLocalhost(url.hostname);
  const privateAllowed = allowsPrivate(url.href, config);
  if (url.protocol !== 'https:' && !(local && privateAllowed)) return 'https';
  const host = bare(url.hostname);
  if (!privateAllowed && (local || (isIP(host) && !isPublicAddress(host)))) return 'blocked';
  return null;
}

/** A file source that names a host and a port rather than an address: SFTP, FTP, and FTPS. */
type FileServerConnection = Extract<SourceConnection, { kind: 'sftp' | 'ftp' | 'ftps' }>;

function fileServerOf(connection: SourceConnection): FileServerConnection | null {
  return connection.kind === 'sftp' || connection.kind === 'ftp' || connection.kind === 'ftps'
    ? connection
    : null;
}

/**
 * Refuses a file source whose address can't be reached under the private-network rule before it's
 * saved or tested, the way a webhook's address is refused.  Names that resolve somewhere private
 * are caught again when they're fetched, and a file server's name is resolved before it's saved
 * too, by `checkFileHost`.
 */
export function checkFileAddress(
  connection: SourceConnection,
  config: Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>,
): void {
  const server = fileServerOf(connection);
  if (server) {
    let host: string;
    try {
      host = bare(remoteFileAddress(server).hostname);
    } catch (error) {
      if (error instanceof ConnectorError && error.messageKey === 'sources.remote.host')
        refuse('host', error.messageKey);
      throw error;
    }
    // Plain FTP follows the plain-HTTP rule because both send credentials without encryption.
    if (server.kind === 'ftp' && !(isLocalhost(host) && privateHostAllowed(host, config)))
      refuse('kind', 'sources.file.ftp');
    if (refusedHost(host, config)) refuse('host', 'sources.file.blocked');
    return;
  }
  const place =
    connection.kind === 'file-url' ||
    connection.kind === 'webdav' ||
    (connection.kind === 'duckdb-file' && connection.storage === 'url')
      ? { field: 'url', address: connection.url! }
      : connection.kind === 'bucket' && connection.endpoint
        ? { field: 'endpoint', address: connection.endpoint }
        : null;
  if (!place) return;
  const problem = addressProblem(place.address, config);
  if (problem === 'https') refuse(place.field, 'sources.file.https');
  if (problem === 'blocked') refuse(place.field, 'sources.file.blocked');
}

/**
 * Refuses a file server whose host name resolves somewhere the private-network rule forbids,
 * before the source is saved or tested, so a name that points at the server's own network is
 * caught here rather than at the first sync.  Every address a name resolves to has to pass, the
 * way the connection's own lookup holds it.  A literal address is `checkFileAddress`'s to refuse,
 * and a name that doesn't resolve is left to the connection, whose test reports resolution as a
 * step of its own, so a save doesn't fail on a lookup that could work a moment later.
 */
export async function checkFileHost(
  connection: SourceConnection,
  config: Pick<RuntimeConfig, 'production' | 'automationsAllowPrivateHosts'>,
  resolve: Resolve = systemResolve,
): Promise<void> {
  const server = fileServerOf(connection);
  if (!server) return;
  const host = bare(remoteFileAddress(server).hostname);
  if (isIP(host) !== 0 || privateHostAllowed(host, config)) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      hostGuard(config, resolve).lookup(host),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new FileNetworkError('resolve')), 5_000);
      }),
    ]);
  } catch (error) {
    if (error instanceof FileNetworkError && error.problem === 'blocked')
      refuse('host', 'sources.file.blocked');
  } finally {
    clearTimeout(timer);
  }
}
