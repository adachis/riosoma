import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, OrganizationManifest } from '@riosoma/contracts';
import { clock, processStarts, running, STARTED, START_TOLERANCE_MS } from '../../shared/processes.js';

const MAGIC = Buffer.from('RIOSOMA-ORG-1\n');
const HEADER_BYTES = 44;
const NAME =
  /^(?:organization\.jsonl|secrets\.jsonl|manifest\.jsonl|manifest\.hmac|databases\/db[0-9A-Za-z]{14}\.jsonl|files\/att[0-9A-Za-z]{14}|templates\/tpl[0-9A-Za-z]{14}\.json)$/;
/**
 * The entries after the manifest, which it can't list: the manifest's HMAC, and the secrets whose
 * associated data holds that HMAC.  They come only with a passphrase, in this order.
 */
export const AFTER_MANIFEST = ['manifest.hmac', 'secrets.jsonl'] as const;
/** The most one line, or one template, may hold */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/**
 * The most one catalog line may hold.  Catalog rows are kept whole for the preview, so they're held
 * to less than records and templates, which pass through one at a time.
 */
export const CATALOG_LINE_BYTES = 16 * 1024 * 1024;
/** How deeply a line's arrays and objects may nest */
export const MAX_DEPTH = 128;
/** How long a working folder no live process can be shown to own may stay */
export const FOLDER_LIFETIME_MS = 24 * 3_600_000;
const FOLDER_PREFIX = 'rio-organization-';
/** A working folder's name: its process ID, that process's start, and when it was made */
const FOLDER_NAME = /^rio-organization-(\d+)-(\d+)-(\d+)-/;
/** A working folder's name from before names recorded a process's start: its process ID only */
const EARLIER_NAME = /^rio-organization-(\d+)-/;

export const invalidArchive = () => new AppError('validation_failed', 'organizationArchive.invalid');
export const tooLarge = (bytes = MAX_LINE_BYTES) =>
  new AppError('validation_failed', 'organizationArchive.tooLarge', {
    params: { megabytes: bytes / 1024 / 1024 },
  });
/** A passphrase given for an archive with no HMAC, which it can't check */
export const unsigned = () => new AppError('validation_failed', 'organizationArchive.unsigned');

export interface Entry {
  name: string;
  size: number;
  sha256: string;
  path: string;
}

/** Working folders this process is using, which a cleanup must leave alone */
const active = new Set<string>();

/** Where working folders go when the settings name no folder */
export const workDirOf = (config: { archiveWorkDir?: string }): string =>
  config.archiveWorkDir ?? join(tmpdir(), 'riosoma-archives');

/**
 * The folder working folders go in, which only this account may enter.  A folder someone else
 * made first, or a link in its place, is refused rather than written through.
 */
export async function workingParent(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== null && info.uid !== uid))
    throw new AppError('internal', 'organizationArchive.failed');
  if ((info.mode & 0o077) !== 0) await chmod(parent, 0o700);
  return parent;
}

/** The start of a working folder's name, for a process started then and a folder made now */
export const folderPrefix = (pid: number, startedAt: number, madeAt: number): string =>
  `${FOLDER_PREFIX}${pid}-${Math.round(startedAt)}-${Math.round(madeAt)}-`;

interface Folder {
  path: string;
  /** The process that made it, when its name says */
  pid: number | null;
  /** When that process started, when its name says */
  started: number | null;
  /** When it was made, from its name or, for an earlier name, its own times */
  made: number | null;
}

/**
 * Removes working folders that hold unencrypted organization data no live process owns.  A folder
 * names the process that made it, when that process started, and when it was made, so a process
 * ID plus its start says who owns it, even in a folder other servers share.  A folder whose owner
 * is still running is never removed, and this process's own stay while it uses them.  Any other
 * goes as soon as its owner is shown to be gone: its process has stopped, or its process ID now
 * belongs to a process that started at another time.  A folder no live process can be shown to
 * own, because its name doesn't say or the system can't say when a process started, goes once
 * it's a day old.  A name from before folders recorded their process's start says only its
 * process ID, so the folder's own times stand in for when it was made: it goes when that process
 * stops, when it was made before that process started, or once it's a day old.
 */
export async function removeStaleFolders(parent: string): Promise<number> {
  await workingParent(parent);
  const now = clock();
  const found: Folder[] = [];
  for (const name of await readdir(parent)) {
    if (!name.startsWith(FOLDER_PREFIX)) continue;
    const path = join(parent, name);
    if (active.has(path)) continue;
    const match = FOLDER_NAME.exec(name);
    if (match) {
      const [pid, started, made] = [match[1], match[2], match[3]].map(Number) as [number, number, number];
      if ([pid, started, made].every((value) => Number.isSafeInteger(value))) {
        found.push({ path, pid, started, made });
        continue;
      }
    }
    const pid = Number(EARLIER_NAME.exec(name)?.[1] ?? NaN);
    // A system that keeps no creation time reports none, and a change is never before the creation.
    const made = await lstat(path).then(
      (info) => Math.min(info.birthtimeMs > 0 ? info.birthtimeMs : Infinity, info.mtimeMs),
      () => null,
    );
    found.push({ path, pid: Number.isSafeInteger(pid) ? pid : null, started: null, made });
  }
  const alive = new Set<number>();
  for (const { pid } of found) if (pid !== null && pid !== process.pid && running(pid)) alive.add(pid);
  const starts = await processStarts([...alive]);
  let removed = 0;
  for (const folder of found) {
    const { pid, started, made } = folder;
    const start = pid === null ? undefined : starts.get(pid);
    const gone =
      pid !== null &&
      // This process's own folders it isn't using, or ones an earlier process with its ID left.
      (pid === process.pid ||
        !alive.has(pid) ||
        (start !== undefined &&
          (started === null
            ? made !== null && made < start - START_TOLERANCE_MS
            : Math.abs(start - started) > START_TOLERANCE_MS)));
    const owned = pid !== null && alive.has(pid) && started !== null && start !== undefined && !gone;
    const expired = !owned && made !== null && now - made > FOLDER_LIFETIME_MS;
    if (!gone && !expired) continue;
    await rm(folder.path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Entry names never become file paths.  Stored entries cannot expand into compression bombs. */
export class ArchiveDirectory {
  readonly entries = new Map<string, Entry>();
  private nextPath = 0;
  private constructor(readonly path: string) {}

  /** A new working folder in `parent`, the folder the settings name for them */
  static async create(parent: string): Promise<ArchiveDirectory> {
    const path = await mkdtemp(
      join(await workingParent(parent), folderPrefix(process.pid, STARTED, clock())),
    );
    await chmod(path, 0o700);
    active.add(path);
    return new ArchiveDirectory(path);
  }

  /** Stores an entry, or with `discard` only measures and hashes it, for a check that needs a few. */
  async add(name: string, source: AsyncIterable<Buffer | string>, discard = false): Promise<Entry> {
    if (!NAME.test(name) || this.entries.has(name)) throw invalidArchive();
    const path = discard ? '' : join(this.path, String(this.nextPath++));
    const hash = createHash('sha256');
    let size = 0;
    const measured = (async function* () {
      for await (const part of source) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        size += bytes.length;
        if (!Number.isSafeInteger(size)) throw invalidArchive();
        hash.update(bytes);
        yield bytes;
      }
    })();
    if (discard) for await (const _ of measured) void _;
    else await pipeline(Readable.from(measured), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    const entry = { name, path, size, sha256: hash.digest('hex') };
    this.entries.set(name, entry);
    return entry;
  }

  read(name: string): Readable {
    const entry = this.entries.get(name);
    if (!entry?.path) throw invalidArchive();
    return createReadStream(entry.path);
  }

  /** A whole entry, for the small ones read at once, refused past the line limit */
  async bytes(name: string): Promise<Buffer> {
    const entry = this.entries.get(name);
    if (!entry) throw invalidArchive();
    if (entry.size > MAX_LINE_BYTES) throw tooLarge();
    const parts: Buffer[] = [];
    for await (const part of this.read(name)) parts.push(part as Buffer);
    return Buffer.concat(parts);
  }

  async close(): Promise<void> {
    active.delete(this.path);
    await rm(this.path, { recursive: true, force: true });
  }

  /** Lists every entry so far, which is every entry but the HMAC and the secrets that follow it. */
  async manifest(summary: OrganizationManifest): Promise<void> {
    const entries = [...this.entries.values()];
    await this.add(
      'manifest.jsonl',
      (async function* () {
        yield line(summary);
        for (const { name, size, sha256 } of entries) yield line({ name, size, sha256 });
      })(),
    );
  }

  async *stream(): AsyncGenerator<Buffer> {
    yield MAGIC;
    for (const entry of this.entries.values()) {
      const name = Buffer.from(entry.name);
      const header = Buffer.alloc(HEADER_BYTES);
      header.writeUInt32BE(name.length);
      header.writeBigUInt64BE(BigInt(entry.size), 4);
      Buffer.from(entry.sha256, 'hex').copy(header, 12);
      yield header;
      yield name;
      yield* this.read(entry.name) as AsyncIterable<Buffer>;
    }
    yield Buffer.alloc(HEADER_BYTES);
  }
}

class Reader {
  private pending: Buffer = Buffer.alloc(0);
  private readonly iterator: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  async *take(size: number): AsyncGenerator<Buffer> {
    while (size) {
      if (!this.pending.length) {
        const next = await this.iterator.next();
        if (next.done) throw invalidArchive();
        this.pending = next.value;
      }
      const count = Math.min(size, this.pending.length);
      yield this.pending.subarray(0, count);
      this.pending = this.pending.subarray(count);
      size -= count;
    }
  }

  async bytes(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of this.take(size)) parts.push(part);
    return Buffer.concat(parts);
  }

  async end(): Promise<void> {
    if (this.pending.length) throw invalidArchive();
    for (;;) {
      const next = await this.iterator.next();
      if (next.done) return;
      if (next.value.length) throw invalidArchive();
    }
  }
}

/**
 * Reads and checks a whole archive.  With `only`, every entry is still measured and hashed against
 * the manifest, but only the entries named are kept.
 */
export async function unpack(
  source: AsyncIterable<Buffer>,
  schemaVersion: number,
  parent: string,
  only?: ReadonlySet<string>,
): Promise<{
  directory: ArchiveDirectory;
  summary: OrganizationManifest;
}> {
  const directory = await ArchiveDirectory.create(parent);
  try {
    const reader = new Reader(source);
    if (!(await reader.bytes(MAGIC.length)).equals(MAGIC)) throw invalidArchive();
    const order: string[] = [];
    for (;;) {
      const header = await reader.bytes(HEADER_BYTES);
      const length = header.readUInt32BE();
      if (!length) {
        if (!header.equals(Buffer.alloc(HEADER_BYTES))) throw invalidArchive();
        break;
      }
      if (length > 200) throw invalidArchive();
      const size = header.readBigUInt64BE(4);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidArchive();
      const name = (await reader.bytes(length)).toString('utf8');
      // Only the HMAC and the secrets bound to it may follow the manifest, and only in that order.
      const after = order.indexOf('manifest.jsonl');
      if (after >= 0 && name !== AFTER_MANIFEST[order.length - after - 1]) throw invalidArchive();
      const keep = !only || only.has(name) || name === 'manifest.jsonl';
      const entry = await directory.add(name, reader.take(Number(size)), !keep);
      if (entry.sha256 !== header.subarray(12).toString('hex')) throw invalidArchive();
      order.push(name);
    }
    await reader.end();
    let summary: OrganizationManifest | undefined;
    const seen = new Set<string>();
    for await (const value of jsonLines(directory.read('manifest.jsonl'))) {
      if (!summary) {
        const parsed = OrganizationManifest.safeParse(value);
        if (!parsed.success) throw invalidArchive();
        summary = parsed.data;
        if (summary.schemaVersion > schemaVersion)
          throw new AppError('validation_failed', 'organizationArchive.newerSchema', {
            params: { archiveVersion: summary.schemaVersion, serverVersion: schemaVersion },
          });
        continue;
      }
      const row = value as Partial<Entry>;
      const entry = typeof row.name === 'string' ? directory.entries.get(row.name) : undefined;
      if (
        !entry ||
        entry.name === 'manifest.jsonl' ||
        (AFTER_MANIFEST as readonly string[]).includes(entry.name) ||
        seen.has(entry.name) ||
        entry.sha256 !== row.sha256 ||
        entry.size !== row.size
      )
        throw invalidArchive();
      seen.add(entry.name);
    }
    const listed = order.slice(0, order.indexOf('manifest.jsonl'));
    const trailing = order.slice(order.indexOf('manifest.jsonl') + 1);
    if (
      !summary ||
      !order.includes('manifest.jsonl') ||
      seen.size !== listed.length ||
      listed.some((name) => !seen.has(name)) ||
      !seen.has('organization.jsonl') ||
      trailing.length !== (summary.encryption ? AFTER_MANIFEST.length : 0) ||
      (summary.encryption && directory.entries.get('manifest.hmac')!.size !== 64)
    )
      throw invalidArchive();
    const expected = summary.databases.map((database) => `databases/${database.id}.jsonl`);
    if (
      new Set(expected).size !== expected.length ||
      expected.some((name) => !seen.has(name)) ||
      [...seen].filter((name) => name.startsWith('databases/')).length !== expected.length
    )
      throw invalidArchive();
    return { directory, summary };
  } catch (error) {
    await directory.close();
    throw error instanceof AppError ? error : invalidArchive();
  }
}

export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

/**
 * Follows how deeply JSON nests, a byte at a time and outside strings, so text nested past the
 * limit is refused as it arrives, before anything parses or recurses through it.  No byte of a
 * multibyte UTF-8 character is a bracket, a brace, a quote, or a backslash, so bytes split anywhere.
 */
class Nesting {
  private depth = 0;
  private quoted = false;
  private escaped = false;

  feed(bytes: Uint8Array, start = 0, end = bytes.length): void {
    for (let at = start; at < end; at++) {
      const byte = bytes[at]!;
      if (this.quoted) {
        if (this.escaped) this.escaped = false;
        else if (byte === 0x5c) this.escaped = true;
        else if (byte === 0x22) this.quoted = false;
      } else if (byte === 0x22) this.quoted = true;
      else if (byte === 0x5b || byte === 0x7b) {
        if (++this.depth > MAX_DEPTH) throw invalidArchive();
      } else if (byte === 0x5d || byte === 0x7d) this.depth--;
    }
  }

  reset(): void {
    this.depth = 0;
    this.quoted = false;
    this.escaped = false;
  }
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalidArchive();
  }
}

/** Parses one template, refusing bytes that aren't JSON or nest too deeply. */
export function parseJson(bytes: Buffer): unknown {
  new Nesting().feed(bytes);
  return parsed(bytes.toString('utf8'));
}

/** How long a line may be: at most `bytes`, and less for lines of the kinds named */
export interface LineLimits {
  bytes?: number;
  kinds?: Readonly<Record<string, number>>;
}

/** An entry that holds catalog lines among others, such as a database's records */
export const ENTRY_LINES: LineLimits = { kinds: { catalog: CATALOG_LINE_BYTES } };
/** An entry that holds only catalog lines */
export const CATALOG_LINES: LineLimits = { bytes: CATALOG_LINE_BYTES };

/**
 * Only one logical row is buffered, even when the archive has millions of records.  Each chunk is
 * searched once, from where the last search stopped, and its nesting followed as it comes, so a
 * long line costs time in proportion to its length.  A line past its limit is refused before it's
 * held, or, when only its kind says its limit, before it's used.
 */
export async function* jsonLines(
  source: AsyncIterable<Buffer | string>,
  limits: LineLimits = {},
): AsyncGenerator<unknown> {
  const most = limits.bytes ?? MAX_LINE_BYTES;
  const nesting = new Nesting();
  let parts: Buffer[] = [];
  let pending = 0;
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    // A newline byte never appears inside a multibyte UTF-8 character, so bytes split safely.
    for (let end = bytes.indexOf(0x0a, start); end >= 0; end = bytes.indexOf(0x0a, start)) {
      const size = pending + end - start;
      if (size > most) throw tooLarge(most);
      nesting.feed(bytes, start, end);
      parts.push(bytes.subarray(start, end));
      const text = Buffer.concat(parts).toString('utf8');
      parts = [];
      pending = 0;
      nesting.reset();
      start = end + 1;
      if (!text) throw invalidArchive();
      const value = parsed(text);
      const kind = value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
      const limit =
        typeof kind === 'string' && limits.kinds && Object.hasOwn(limits.kinds, kind)
          ? limits.kinds[kind]
          : undefined;
      if (limit !== undefined && size > limit) throw tooLarge(limit);
      yield value;
    }
    if (start < bytes.length) {
      pending += bytes.length - start;
      if (pending > most) throw tooLarge(most);
      nesting.feed(bytes, start);
      parts.push(bytes.subarray(start));
    }
  }
  if (pending) throw invalidArchive();
}
