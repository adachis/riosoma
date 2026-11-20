import { uploadLimit } from '../data/files/settings.js';
import { AppError, ATTACHMENT_ADDRESS_LIMITS, newId } from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { systemResolve, type Resolve } from '../automations/outbound.js';
import { dataStore } from '../data/context.js';
import type { FileRow } from '../data/files/metadata.js';
import { fileStorage } from '../data/files/storage.js';
import { safeFileName, storeFile } from '../data/imports/core/files.js';
import { checkedAddress, download, DownloadError } from '../data/imports/download.js';
import type { StoredField } from '../data/types.js';
import { cellError } from '../data/value-errors.js';
import { allowsPrivate, isLocalhost } from '../webhooks/url.js';

/**
 * Attachments a REST API write names by address, the way Airtable's API takes them: `{ url,
 * filename }` items beside the IDs of files already stored.  Each address is downloaded through the
 * guarded client imports use, so it must be https, and every address it or a redirect leads to
 * must pass the private-network rule.  A file past the upload limit is refused as soon as it says
 * so or grows past it, and the downloads share a deadline.  Each file is stored the way an upload
 * is, in the configured storage, and the cell gets its ID.
 *
 * Every download finishes before any record changes.  One that fails refuses the whole write, with
 * a message key saying why and params naming the item, and the files already stored for it are
 * removed again, so nothing is half written.
 */

/** How one server downloads addresses.  Tests narrow the private-network rule and shorten the waits. */
export interface AddressSettings {
  resolve: Resolve;
  /** Whether an address may reach a private network */
  allowPrivate(url: URL): boolean;
  maxBytes: number;
  /** How long connecting, and each quiet stretch while reading, may take */
  idleMs: number;
  /** How long all of one write's downloads may take together */
  deadlineMs: number;
  /** How many downloads run at once */
  concurrency: number;
}

const settingsByServer = new WeakMap<AppContext, AddressSettings>();

export function addressSettings(ctx: AppContext): AddressSettings {
  let settings = settingsByServer.get(ctx);
  if (!settings) {
    settings = {
      resolve: systemResolve,
      allowPrivate: (url) => allowsPrivate(url.href, ctx.config),
      maxBytes: Infinity,
      idleMs: 30_000,
      deadlineMs: 120_000,
      concurrency: 4,
    };
    settingsByServer.set(ctx, settings);
  }
  return settings;
}

interface Address {
  /** The stand-in ID the cell holds until the file is stored */
  placeholder: string;
  url: URL;
  filename: string;
  field: StoredField;
  recordId: string;
  /** The record's place in the request, counted from 0 */
  record: number;
  /** The item's place in the cell, counted from 0 */
  item: number;
  source?: { url: string; imageUrl: string; license?: string };
}

/** The address as it can be shown back: no credentials, query, or fragment. */
function shown(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** The last part of the address's path, as a file name, or nothing when there isn't one. */
function lastSegment(url: URL): string {
  const segment = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** One write's attachments by address, from reading the cells to storing the files. */
export class AttachmentAddresses {
  private maxBytes = Infinity;
  private readonly items: Address[] = [];
  private readonly perRecord = new Map<number, number>();
  /** Stored file IDs, by the stand-ins they replace */
  private readonly stored = new Map<string, string>();

  constructor(
    private readonly app: FastifyInstance,
    private readonly owner: { orgId: string; userId: string },
    private readonly source?: Address['source'],
  ) {}

  get size(): number {
    return this.items.length;
  }

  private get settings(): AddressSettings {
    return addressSettings(this.app.ctx);
  }

  /** Https, or plain http to this machine while private hosts are allowed, as file sources take. */
  private allowsAddress(url: URL): boolean {
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && isLocalhost(url.hostname) && this.settings.allowPrivate(url))
    );
  }

  private refuse(
    key: string,
    address: Pick<Address, 'field' | 'recordId' | 'record' | 'item'> & { url?: URL },
    params: Record<string, string | number> = {},
  ): AppError {
    return cellError(
      new AppError('validation_failed', key, {
        params: {
          field: address.field.name,
          record: address.record,
          item: address.item,
          ...(address.url ? { address: shown(address.url) } : {}),
          ...params,
        },
      }),
      address.field,
      address.recordId,
      address.record,
    );
  }

  /**
   * A cell's items as file IDs, with a stand-in for each address.  An item is a file's ID, an
   * object with its `id`, or an object with a `url` and, if wanted, a `filename`.
   */
  cell(field: StoredField, recordId: string, record: number, value: readonly unknown[]): string[] {
    return value.map((entry: unknown, item) => {
      if (typeof entry === 'string') return entry;
      const unknown = () =>
        new AppError('validation_failed', 'data.file.unknown', { params: { field: field.name } });
      if (!entry || typeof entry !== 'object') throw unknown();
      // An attachment as a read returns it keeps its file, whatever address it shows.
      if ('id' in entry) {
        if (typeof entry.id !== 'string') throw unknown();
        return entry.id;
      }
      if (!('url' in entry)) throw unknown();
      const { url, filename } = entry as { url: unknown; filename?: unknown };
      if (
        typeof url !== 'string' ||
        (filename !== undefined && filename !== null && typeof filename !== 'string')
      )
        throw new AppError('validation_failed', 'api.file.address', {
          params: { field: field.name, record, item },
        });
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AppError('validation_failed', 'api.file.address', {
          params: { field: field.name, record, item },
        });
      }
      const here = { field, recordId, record, item, url: parsed };
      if (!this.allowsAddress(parsed) || parsed.username || parsed.password)
        throw this.refuse('api.file.blocked', here);
      const count = (this.perRecord.get(record) ?? 0) + 1;
      if (count > ATTACHMENT_ADDRESS_LIMITS.perRecord)
        throw new AppError('validation_failed', 'api.file.perRecord', {
          params: { record, limit: ATTACHMENT_ADDRESS_LIMITS.perRecord },
        });
      if (this.items.length >= ATTACHMENT_ADDRESS_LIMITS.perRequest)
        throw new AppError('validation_failed', 'api.file.perRequest', {
          params: { limit: ATTACHMENT_ADDRESS_LIMITS.perRequest },
        });
      this.perRecord.set(record, count);
      const placeholder = newId('attachment');
      this.items.push({
        ...here,
        ...(this.source ? { source: this.source } : {}),
        placeholder,
        filename: safeFileName(
          typeof filename === 'string' && filename.trim() ? filename : lastSegment(parsed),
        ),
      });
      return placeholder;
    });
  }

  /** The fields whose cells name addresses */
  fields(): StoredField[] {
    return [...new Map(this.items.map((address) => [address.field.id, address.field])).values()];
  }

  /** What went wrong with one address, as the refusal the write answers with. */
  private refusal(address: Address, error: unknown, late: boolean): unknown {
    if (late) return this.refuse('api.file.timedOut', address);
    if (error instanceof AppError) return cellError(error, address.field, address.recordId, address.record);
    if (!(error instanceof DownloadError)) return error;
    if (error.problem === 'blocked') return this.refuse('api.file.blocked', address);
    if (error.problem === 'tooLarge')
      return this.refuse('api.file.tooLarge', address, {
        megabytes: Math.floor(this.maxBytes / 1024 / 1024),
      });
    if (error.detail === 'timeout') return this.refuse('api.file.timedOut', address);
    const status = /^HTTP (\d{3})$/.exec(error.detail ?? '')?.[1];
    if (error.detail === 'resolve' || status === '404' || status === '410')
      return this.refuse('api.file.notFound', address);
    return this.refuse('api.file.failed', address, status ? { status: Number(status) } : {});
  }

  /**
   * Downloads and stores every address, for the table the write is in.  The first address that
   * fails refuses the write, and the files stored before it are removed.
   */
  async fetch(tableId: string): Promise<void> {
    if (!this.items.length) return;
    const { pool, schemas } = dataStore(this.app.ctx);
    const settings = {
      ...this.settings,
      maxBytes: Math.min(this.settings.maxBytes, await uploadLimit(pool, schemas.app, this.owner.orgId)),
    };
    this.maxBytes = settings.maxBytes;
    // Every address passes the private-network rule before any download starts.
    const checks = await Promise.allSettled(
      this.items.map((address) => checkedAddress(address.url, settings)),
    );
    for (const [n, check] of checks.entries())
      if (check.status === 'rejected') throw this.refusal(this.items[n]!, check.reason, false);
    const stop = new AbortController();
    let late = false;
    const deadline = setTimeout(() => {
      late = true;
      stop.abort();
    }, settings.deadlineMs);
    let failure: unknown;
    let next = 0;
    const work = async () => {
      while (failure === undefined && next < this.items.length) {
        const address = this.items[next++]!;
        try {
          const got = await download(address.url.href, {
            resolve: settings.resolve,
            allowPrivate: (url) => settings.allowPrivate(url),
            allowUrl: (url) => this.allowsAddress(url),
            maxBytes: settings.maxBytes,
            signal: stop.signal,
            timeoutMs: settings.idleMs,
          });
          if (
            address.source &&
            got.headers['content-type'] &&
            !/^image\/(png|jpeg|webp|gif|bmp|tiff|avif|heic)(?:;|$)/i.test(got.headers['content-type'])
          ) {
            got.body.destroy();
            throw new AppError('validation_failed', 'files.search.notImage');
          }
          const file = await storeFile(
            this.app,
            this.owner,
            { tableId, fieldId: address.field.id },
            address.filename,
            got.body,
            address.source,
          );
          this.stored.set(address.placeholder, file.id);
        } catch (error) {
          // The first failure is the one to report.  The downloads it stops fail after it.
          failure ??= this.refusal(address, error, late);
          stop.abort();
        }
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(settings.concurrency, this.items.length) }, () => work()),
      );
    } finally {
      clearTimeout(deadline);
    }
    if (failure !== undefined) {
      await this.discard();
      throw failure;
    }
  }

  /** A cell's value with each stand-in replaced by its stored file's ID. */
  resolve(value: unknown): unknown {
    return Array.isArray(value) ? value.map((id: unknown) => this.stored.get(String(id)) ?? id) : value;
  }

  /**
   * Removes the files this write stored that no record holds, after the write failed.  Anything
   * left behind is removed a day later by the cleanup of files that were never attached.
   */
  async discard(): Promise<void> {
    const ids = [...this.stored.values()];
    this.stored.clear();
    if (!ids.length) return;
    const { pool, schemas } = dataStore(this.app.ctx);
    try {
      await withTransaction(pool, async (db) => {
        const files = await query<FileRow>(
          db,
          sql`SELECT * FROM ${ident(schemas.app, 'files')}
          WHERE id = ANY(${ids}::text[]) AND attached_at IS NULL ORDER BY id FOR UPDATE`,
        );
        for (const file of files.rows) {
          const storage = fileStorage(file.storage, db, schemas.app, this.app.ctx.config);
          for (const key of [file.storage_key, `${file.storage_key}_small`, `${file.storage_key}_large`])
            await storage.delete(key).catch(() => undefined);
          await query(db, sql`DELETE FROM ${ident(schemas.app, 'files')} WHERE id = ${file.id}`);
        }
      });
    } catch (error) {
      this.app.log.warn({ err: error }, 'failed removal of downloaded attachments');
    }
  }
}
