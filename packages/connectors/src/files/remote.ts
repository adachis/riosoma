import { isIP } from 'node:net';
import { posix } from 'node:path';
import { openSftp } from '@riosoma/db';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { FileFormat, RemoteFileConnection } from '@riosoma/contracts';
import { ConnectorError, type ConnectorContext } from '../types.js';
import { readBody } from '../rest/connector.js';
import { formatOfName } from './formats.js';
import { openFtp } from './ftp.js';
import { NO_NETWORK, type FileNetwork, type FileResponse } from './network.js';

export interface RemoteFile {
  name: string;
  url: URL;
  format: FileFormat | null;
  bytes: number | null;
  modified?: string | null;
}

export interface FileTransport {
  list(ctx: ConnectorContext, signal: AbortSignal): Promise<RemoteFile[]>;
  request(
    ctx: ConnectorContext,
    url: URL,
    method: 'GET' | 'HEAD',
    signal: AbortSignal,
    limit: number,
  ): Promise<FileResponse>;
  address(ctx: ConnectorContext): URL;
}

function settings(ctx: ConnectorContext): RemoteFileConnection {
  const connection = ctx.connection;
  if (!['sftp', 'ftp', 'ftps', 'webdav'].includes(connection.kind))
    throw new ConnectorError('sources.kindUnavailable');
  return connection as RemoteFileConnection;
}

/** Segment states avoid regex backtracking on a remote filename */
export function pathMatcher(pattern: string) {
  const segments = posix.normalize(pattern).split('/');
  const matchSegment = (pattern: string, name: string): boolean => {
    let states = new Set([0]);
    const expand = () => {
      for (const at of states) if (pattern[at] === '*') states.add(at + 1);
    };
    expand();
    for (const char of name) {
      const next = new Set<number>();
      for (const at of states) {
        if (pattern[at] === '*') next.add(at);
        else if (pattern[at] === '?' || pattern[at] === char) next.add(at + 1);
      }
      states = next;
      expand();
    }
    return states.has(pattern.length);
  };
  const positions = (path: string) => {
    let states = new Set([0]);
    const expand = () => {
      for (const at of states) if (segments[at] === '**') states.add(at + 1);
    };
    expand();
    for (const name of posix.normalize(path).split('/')) {
      const next = new Set<number>();
      for (const at of states) {
        if (segments[at] === '**') next.add(at);
        else if (segments[at] !== undefined && matchSegment(segments[at]!, name)) next.add(at + 1);
      }
      states = next;
      expand();
    }
    return states;
  };
  return {
    test: (path: string) => positions(path).has(segments.length),
    descend: (path: string) => [...positions(path)].some((at) => at < segments.length),
  };
}

function rootOf(path: string): string {
  const wildcard = path.search(/[*?]/);
  return posix.dirname(wildcard < 0 ? path : path.slice(0, wildcard) + '_');
}

function hasControl(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

function safeName(name: string): boolean {
  return name !== '.' && name !== '..' && !hasControl(name) && !/[/\\]/u.test(name);
}

export function parseDavListing(
  xml: string,
  base: URL,
): Array<{ url: URL; bytes: number | null; modified: string | null; directory: boolean }> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    throw new ConnectorError('sources.remote.listing');
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false }).parse(
    xml,
  );
  const raw = parsed?.multistatus?.response;
  if (!raw) throw new ConnectorError('sources.remote.listing');
  const array = <T>(value: T | T[] | undefined): T[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const found = [];
  for (const entry of array<Record<string, unknown>>(raw)) {
    if (typeof entry.href !== 'string') throw new ConnectorError('sources.remote.listing');
    const url = new URL(entry.href, base);
    const decoded = decodeURIComponent(url.pathname);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      hasControl(decoded) ||
      decoded.includes('\\') ||
      decoded.split('/').some((part) => part === '..' || part === '.')
    )
      throw new ConnectorError('sources.remote.path');
    for (const propstat of array(
      entry.propstat as Array<{ status?: string; prop?: Record<string, unknown> }>,
    )) {
      if (!/HTTP\/\S+ 200(?: |$)/.test(propstat.status ?? '')) continue;
      const prop = propstat.prop ?? {};
      const resource = prop.resourcetype;
      const bytes = Number(prop.getcontentlength);
      found.push({
        url,
        bytes:
          prop.getcontentlength !== undefined && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null,
        modified: typeof prop.getlastmodified === 'string' ? prop.getlastmodified : null,
        directory: typeof resource === 'object' && resource !== null && 'collection' in resource,
      });
      break;
    }
  }
  return found;
}

/** Save-time policy and transport checks must resolve the same normalized hostname. */
export function remoteFileAddress(config: RemoteFileConnection): URL {
  if (config.kind === 'webdav') return new URL(config.url);
  const host = config.host.replace(/^\[(.*)\]$/, '$1');
  if (!host || /[\s/@?#\\]/.test(host) || (host.includes(':') && isIP(host) !== 6))
    throw new ConnectorError('sources.remote.host');
  try {
    // Construction rejects invalid hosts, while the hostname setter silently ignores them.
    const url = new URL(`https://${isIP(host) === 6 ? `[${host}]` : host}`);
    url.port = String(config.port);
    return url;
  } catch {
    throw new ConnectorError('sources.remote.host');
  }
}

/** All protocols share a bounded walk and the same local readers */
export function remoteTransport(
  network: FileNetwork = NO_NETWORK,
  allowPlainFtp: (host: string) => boolean = () => false,
): FileTransport {
  const address = (ctx: ConnectorContext) => {
    const config = settings(ctx);
    const url = remoteFileAddress(config);
    if (config.kind === 'ftp' && !allowPlainFtp(url.hostname)) throw new ConnectorError('sources.file.ftp');
    return url;
  };
  const headers = (ctx: ConnectorContext): Record<string, string> => {
    const config = settings(ctx);
    if (config.kind !== 'webdav') return {};
    const secret = config.auth === 'bearer' ? ctx.secrets.token : ctx.secrets.password;
    if (!secret) throw new ConnectorError('sources.secretsMissing');
    return {
      authorization:
        config.auth === 'bearer'
          ? `Bearer ${secret}`
          : `Basic ${Buffer.from(`${config.user}:${secret}`).toString('base64')}`,
    };
  };
  const connect = async (ctx: ConnectorContext, signal: AbortSignal) => {
    const config = settings(ctx);
    const checked = await network.check(address(ctx), signal);
    if (config.kind === 'webdav') throw new ConnectorError('sources.kindUnavailable');
    if (config.kind === 'sftp')
      return {
        kind: 'sftp' as const,
        client: await openSftp({
          address: checked.address,
          port: config.port,
          user: config.user,
          hostKey: config.hostKey,
          ...(config.auth === 'key'
            ? { privateKey: ctx.secrets.sshPrivateKeyPem, passphrase: ctx.secrets.sshPassphrase }
            : { password: ctx.secrets.password }),
          signal,
          timeoutMs: ctx.timeoutMs ?? 30_000,
        }),
      };
    if (!ctx.secrets.password) throw new ConnectorError('sources.secretsMissing');
    return {
      kind: 'ftp' as const,
      client: await openFtp({
        address: checked.address,
        host: config.host,
        port: config.port,
        user: config.user,
        password: ctx.secrets.password,
        secure: config.kind === 'ftps',
        signal,
        timeoutMs: ctx.timeoutMs ?? 30_000,
      }),
    };
  };
  return {
    address,
    async list(ctx, signal) {
      const config = settings(ctx);
      const root = rootOf(config.path);
      const matcher = pathMatcher(config.path);
      const files: RemoteFile[] = [];
      const pending = [root];
      const visited = new Set<string>();
      const connection = config.kind === 'webdav' ? null : await connect(ctx, signal);
      const base = address(ctx);
      if (config.kind === 'webdav') base.pathname = base.pathname.replace(/\/?$/, '/');
      const asUrl = (path: string) => {
        const url = new URL(base);
        const encoded = path.split('/').map(encodeURIComponent).join('/');
        if (config.kind !== 'webdav') url.hash = encodeURIComponent(path);
        url.pathname =
          config.kind === 'webdav' ? `${base.pathname}${encoded.replace(/^\.?\//, '')}` : encoded;
        return url;
      };
      const add = (path: string, bytes: number | null, modified: string | null, directory: boolean) => {
        if (directory) {
          if (matcher.descend(path)) pending.push(path);
          return;
        }
        const format = config.format ?? formatOfName(path);
        if (matcher.test(path) && format)
          files.push({ name: path, url: asUrl(path), bytes, modified, format });
        if (files.length > 1_000) throw new ConnectorError('sources.file.tooManyFiles');
      };
      try {
        if (connection?.kind === 'sftp' && !/[*?]/.test(config.path)) {
          const stat = await connection.client.stat(config.path);
          if (stat.isFile()) {
            add(config.path, stat.size, String(stat.mtime), false);
            return files;
          }
        }
        while (pending.length) {
          signal.throwIfAborted();
          const path = pending.shift()!;
          if (visited.has(path)) continue;
          visited.add(path);
          if (visited.size > 100) throw new ConnectorError('sources.file.tooManyFiles');
          if (connection?.kind === 'sftp') {
            for (const entry of await connection.client.list(path)) {
              if (!safeName(entry.filename) || entry.attrs.isSymbolicLink()) continue;
              add(
                posix.join(path, entry.filename),
                entry.attrs.size,
                String(entry.attrs.mtime),
                entry.attrs.isDirectory(),
              );
            }
          } else if (connection?.kind === 'ftp') {
            for (const entry of await connection.client.list(path)) {
              if (!safeName(entry.name)) continue;
              add(posix.join(path, entry.name), entry.bytes, entry.modified, entry.directory);
            }
          } else {
            const url = asUrl(path === '.' ? '' : path);
            url.pathname = url.pathname.replace(/\/?$/, '/');
            const response = await network.request({
              url,
              method: 'PROPFIND',
              headers: { ...headers(ctx), depth: '1', 'content-type': 'application/xml' },
              body: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/></prop></propfind>',
              signal,
              idleMs: ctx.timeoutMs ?? 30_000,
              maxBytes: 4 * 1024 * 1024,
            });
            if (response.status !== 207) {
              response.close();
              throw new ConnectorError('sources.file.denied');
            }
            const xml = (await readBody(response, 4 * 1024 * 1024, true)).toString('utf8');
            for (const entry of parseDavListing(xml, url)) {
              if (entry.url.pathname.replace(/\/$/, '') === url.pathname.replace(/\/$/, '')) continue;
              if (!entry.url.pathname.startsWith(url.pathname))
                throw new ConnectorError('sources.remote.path');
              const child = decodeURIComponent(
                entry.url.pathname.slice(url.pathname.length).replace(/\/$/, ''),
              );
              if (!safeName(child)) throw new ConnectorError('sources.remote.path');
              add(posix.join(path, child), entry.bytes, entry.modified, entry.directory);
            }
          }
        }
        return files.sort((a, b) => a.name.localeCompare(b.name));
      } finally {
        connection?.client.close();
      }
    },
    async request(ctx, url, method, signal, limit) {
      const config = settings(ctx);
      if (config.kind === 'webdav')
        return network.request({
          url,
          method,
          headers: headers(ctx),
          signal,
          maxBytes: limit,
          idleMs: ctx.timeoutMs ?? 30_000,
        });
      const connection = await connect(ctx, signal);
      try {
        const body =
          method === 'HEAD'
            ? (async function* () {})()
            : await connection.client.read(decodeURIComponent(url.hash.slice(1)));
        return { status: 200, headers: {}, url, body, close: () => connection.client.close() };
      } catch (error) {
        connection.client.close();
        throw error;
      }
    },
  };
}
