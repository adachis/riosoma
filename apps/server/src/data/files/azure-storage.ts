import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { azureServiceToken } from '@riosoma/db';
import type { FileStorage, SignedUrlOptions } from './storage.js';
import {
  answerText,
  checkedKey,
  lazyDownload,
  MissingFile,
  PART_BYTES,
  partsOf,
  REQUEST_TIMEOUT_MS,
  StorageServiceError,
  withRetries,
  type RemoteOptions,
} from './remote.js';

/**
 * Attachments in an Azure Blob Storage container.  Requests are signed with the account key
 * (Shared Key), or carry a token for the server's managed identity when there's no key, from the
 * same identity code the database signs in with.  Small
 * files go up in one request, and larger ones as blocks, holding one block in memory at a time.
 * A blob exists only once its block list is committed, so an upload that fails partway leaves
 * nothing anyone can read, and the blocks it sent are discarded.
 */

export interface AzureSettings {
  account: string;
  container: string;
  /** Put before every blob name, such as `riosoma/`, or empty */
  prefix: string;
  /** The blob service's address with no container, such as `https://<account>.blob.core.windows.net` */
  endpoint: string;
  /** The storage account key, base64-encoded, or absent to sign in with the managed identity */
  accountKey?: string;
  /** A user-assigned managed identity's client ID, or absent for the system-assigned one */
  clientId?: string;
}

/** The service version every request asks for.  Each Azure region and Azurite accept it. */
export const AZURE_VERSION = '2021-08-06';

const STANDARD_HEADERS = [
  'content-encoding',
  'content-language',
  'content-length',
  'content-md5',
  'content-type',
  'date',
  'if-modified-since',
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'range',
];

/** The `Authorization` header for Shared Key, from the request's method, address, and headers. */
export function sharedKey(
  method: string,
  url: URL,
  headers: Record<string, string>,
  account: string,
  key: string,
): string {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const standard = STANDARD_HEADERS.map((name) =>
    name === 'content-length' && lower[name] === '0' ? '' : (lower[name] ?? ''),
  );
  const custom = Object.keys(lower)
    .filter((name) => name.startsWith('x-ms-'))
    .sort()
    .map((name) => `${name}:${lower[name]!.replace(/\s+/g, ' ')}\n`)
    .join('');
  const query = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    const lowered = name.toLowerCase();
    query.set(lowered, [...(query.get(lowered) ?? []), value]);
  }
  const resource =
    `/${account}${url.pathname}` +
    [...query.keys()]
      .sort()
      .map((name) => `\n${name}:${query.get(name)!.sort().join(',')}`)
      .join('');
  const text = `${[method, ...standard].join('\n')}\n${custom}${resource}`;
  const signature = createHmac('sha256', Buffer.from(key, 'base64')).update(text, 'utf8').digest('base64');
  return `SharedKey ${account}:${signature}`;
}

/**
 * A read-only service SAS for one blob, which Azure accepts until `expiry`.  The browser gets the
 * content type and disposition Riosoma would have sent itself.
 */
export function blobSas(
  settings: Pick<AzureSettings, 'account' | 'container' | 'accountKey'>,
  blob: string,
  expiry: Date,
  https: boolean,
  overrides: { type: string; disposition: string },
): string {
  const se = expiry.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const spr = https ? 'https' : 'https,http';
  const resource = `/blob/${settings.account}/${settings.container}/${blob}`;
  // Permissions, start, expiry, resource, identifier, addresses, protocols, version, resource type,
  // snapshot time, encryption scope, then the cache control, disposition, encoding, language, and
  // type the answer carries.
  const text = [
    'r',
    '',
    se,
    resource,
    '',
    '',
    spr,
    AZURE_VERSION,
    'b',
    '',
    '',
    '',
    overrides.disposition,
    '',
    '',
    overrides.type,
  ].join('\n');
  const sig = createHmac('sha256', Buffer.from(settings.accountKey!, 'base64'))
    .update(text, 'utf8')
    .digest('base64');
  return new URLSearchParams({
    sv: AZURE_VERSION,
    se,
    sr: 'b',
    sp: 'r',
    spr,
    rscd: overrides.disposition,
    rsct: overrides.type,
    sig,
  })
    .toString()
    .replace(/\+/g, '%20');
}

interface Call {
  headers?: Record<string, string>;
  body?: Buffer;
  ok?: readonly number[];
}

function blockId(index: number): string {
  // Every block ID in a blob has the same length.
  return Buffer.from(`block-${String(index).padStart(6, '0')}`).toString('base64');
}

export function azureStorage(settings: AzureSettings, options: RemoteOptions = {}): FileStorage {
  const send = options.fetch ?? fetch;
  const partBytes = options.partBytes ?? PART_BYTES;
  const token = settings.accountKey
    ? null
    : (options.token ?? azureServiceToken('https://storage.azure.com/.default', settings.clientId));
  const base = settings.endpoint.replace(/\/+$/, '');
  const blobName = (key: string) => `${settings.prefix}${checkedKey(key)}`;
  const urlOf = (key: string, query = '') =>
    new URL(
      `${base}/${settings.container}/${blobName(key).split('/').map(encodeURIComponent).join('/')}${query}`,
    );

  async function call(method: string, url: URL, { headers = {}, body, ok = [200] }: Call): Promise<Response> {
    const response = await withRetries(async () => {
      const sent: Record<string, string> = {
        ...headers,
        'x-ms-date': new Date().toUTCString(),
        'x-ms-version': AZURE_VERSION,
      };
      if (body) sent['content-length'] = String(body.length);
      sent.authorization = token
        ? `Bearer ${await token()}`
        : sharedKey(method, url, sent, settings.account, settings.accountKey!);
      const signal =
        options.timeoutMs !== undefined
          ? AbortSignal.timeout(options.timeoutMs)
          : body
            ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            : undefined;
      delete sent['content-length'];
      return send(url, {
        method,
        headers: sent,
        ...(body ? { body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) } : {}),
        ...(signal ? { signal } : {}),
      });
    });
    if (ok.includes(response.status)) return response;
    const text = await answerText(response);
    const code = response.headers.get('x-ms-error-code') ?? /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? null;
    if (response.status === 404 && code !== 'ContainerNotFound') throw new MissingFile();
    throw new StorageServiceError(response.status, code);
  }

  async function done(response: Promise<Response>): Promise<void> {
    await (await response).body?.cancel();
  }

  /** Removes a blob, and with it any blocks an upload sent but never committed. */
  async function discard(key: string): Promise<void> {
    // Writing a blob discards its uncommitted blocks, and deleting it then leaves nothing at all.
    await done(
      call('PUT', urlOf(key), {
        headers: { 'x-ms-blob-type': 'BlockBlob' },
        body: Buffer.alloc(0),
        ok: [201],
      }),
    );
    await done(call('DELETE', urlOf(key), { ok: [202, 404] }));
  }

  return {
    async write(key, source) {
      const parts = partsOf(source, partBytes)[Symbol.asyncIterator]();
      const first = await parts.next();
      const second = first.done ? first : await parts.next();
      if (second.done) {
        await done(
          call('PUT', urlOf(key), {
            headers: { 'x-ms-blob-type': 'BlockBlob' },
            body: first.done ? Buffer.alloc(0) : first.value,
            ok: [201],
          }),
        );
        return;
      }
      const ids: string[] = [];
      try {
        const upload = async (part: Buffer) => {
          const id = blockId(ids.length);
          await done(
            call('PUT', urlOf(key, `?comp=block&blockid=${encodeURIComponent(id)}`), {
              body: part,
              ok: [201],
            }),
          );
          ids.push(id);
        };
        await upload(first.value!);
        await upload(second.value);
        for (let part = await parts.next(); !part.done; part = await parts.next()) await upload(part.value);
        const list = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
        await done(
          call('PUT', urlOf(key, '?comp=blocklist'), { body: Buffer.from(list, 'utf8'), ok: [201] }),
        );
      } catch (error) {
        await parts.return(undefined);
        await discard(key).catch(() => undefined);
        throw error;
      }
    },
    read(key, range) {
      const url = urlOf(key);
      return lazyDownload(() =>
        call('GET', url, {
          headers: range ? { 'x-ms-range': `bytes=${range.start}-${range.end}` } : {},
          ok: [200, 206],
        }),
      );
    },
    async delete(key) {
      await done(call('DELETE', urlOf(key), { ok: [202, 404] }));
    },
    async copy(from, to) {
      const response = await call('PUT', urlOf(to), {
        headers: { 'x-ms-copy-source': urlOf(from).href },
        ok: [202],
      });
      await response.body?.cancel();
      let status = response.headers.get('x-ms-copy-status');
      // A copy inside one account almost always finishes at once, but the service may report it pending.
      for (let tries = 0; status === 'pending' && tries < 600; tries++) {
        await delay(500);
        const properties = await call('HEAD', urlOf(to), {});
        await properties.body?.cancel();
        status = properties.headers.get('x-ms-copy-status');
      }
      if (status !== 'success') throw new StorageServiceError(202, `Copy${status ?? 'Unknown'}`);
    },
    signedUrl(key, { seconds, type, disposition }: SignedUrlOptions) {
      if (!settings.accountKey) return Promise.resolve(null);
      const url = urlOf(key);
      const sas = blobSas(
        settings,
        blobName(key),
        new Date(Date.now() + seconds * 1000),
        url.protocol === 'https:',
        {
          type,
          disposition,
        },
      );
      return Promise.resolve(`${url.href}?${sas}`);
    },
  };
}
