import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { AppError, type DriveListing, type DriveExportFormat } from '@riosoma/contracts';
import type { DriveAccess } from './connections.js';
import { limited } from './providers.js';

/**
 * What Riosoma asks of a cloud drive once a person has connected it: a folder's entries, a search,
 * a small picture of a file, and the file itself.  Every call carries the person's own token, so a
 * drive shows only what that person can see there.
 */

export interface ListRequest {
  /** The folder's ID, or empty for the top of the drive */
  folder: string;
  /** Words to search the whole drive for, in place of listing the folder */
  query: string;
  /** Where the previous page ended */
  cursor: string;
  signal: AbortSignal;
}

export interface Thumbnail {
  type: string;
  body: Readable;
}

export interface OpenedFile {
  name: string;
  /** Bytes, when the drive says ahead of time */
  size: number | null;
  body: Readable;
}

/** The drives with Riosoma's own picker: Dropbox and Box. */
export interface BrowsableDrive {
  list(access: DriveAccess, request: ListRequest): Promise<DriveListing>;
  thumbnail(access: DriveAccess, fileId: string, signal: AbortSignal): Promise<Thumbnail | null>;
}

export interface ImportableDrive {
  /** Opens a file to copy, exported to `exportAs` when it's a Google file */
  open(
    access: DriveAccess,
    fileId: string,
    exportAs: DriveExportFormat | undefined,
    signal: AbortSignal,
  ): Promise<OpenedFile>;
}

export const fileMissing = () => new AppError('not_found', 'drives.fileMissing');
export const providerFailed = (cause?: unknown) =>
  new AppError('unavailable', 'drives.providerFailed', cause === undefined ? {} : { cause });

export interface DriveRequest extends RequestInit {
  signal: AbortSignal;
  /** Statuses that mean the file isn't there, 404 unless a drive says otherwise */
  missing?: number[];
  /** Reads a refusal the drive explains in its body, before the general handling */
  explain?: (response: Response) => Promise<AppError | null>;
}

/**
 * A request to a drive with the person's token.  A refused token marks the connection for
 * reconnecting, a missing file is not found, and anything else the drive gets wrong is its fault.
 */

export async function driveFetch(access: DriveAccess, url: string, init: DriveRequest): Promise<Response> {
  const { missing = [404], explain, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(url, {
      ...rest,
      headers: { authorization: `Bearer ${access.accessToken}`, ...(rest.headers as Record<string, string>) },
    });
  } catch (error) {
    if (init.signal.aborted) throw error;
    throw providerFailed(error);
  }
  if (response.ok || response.status === 202 || response.status === 302) return response;
  const explained = explain ? await explain(response) : null;
  if (explained) throw explained;
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 401) return access.refused();
  if (missing.includes(response.status)) throw fileMissing();
  throw providerFailed();
}

/** A drive's JSON answer, with a time limit of its own. */
export async function driveJson<T>(access: DriveAccess, url: string, init: DriveRequest): Promise<T> {
  const response = await driveFetch(access, url, { ...init, signal: limited(init.signal) });
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw providerFailed(error);
  }
}

/** Entries one listing gathers before it answers, so nearly every folder arrives whole at once. */
export const LISTING_ENTRIES = 2_000;
/** How long one listing keeps asking for more before it answers with what it has. */
export const LISTING_MS = 3_000;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Reads pages until the listing is whole, holds `LISTING_ENTRIES`, or has taken `LISTING_MS`.
 * A drive may answer a page with a few entries, or none, while more remain, so one page is not a
 * listing.  A folder's entries come back folders first, then by name.  Search results keep the
 * drive's own order, which is its ranking.
 */
export async function gatherListing(
  first: () => Promise<DriveListing>,
  next: (cursor: string) => Promise<DriveListing>,
  { sort, now = Date.now }: { sort: boolean; now?: () => number },
): Promise<DriveListing> {
  const started = now();
  let page = await first();
  const entries = [...page.entries];
  while (page.cursor && entries.length < LISTING_ENTRIES && now() - started < LISTING_MS) {
    page = await next(page.cursor);
    entries.push(...page.entries);
  }
  if (sort)
    entries.sort(
      (a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || byName.compare(a.name, b.name),
    );
  return { entries, cursor: page.cursor };
}

/** A drive's answer body as a Node stream, which stops the download when its reader stops. */
export function bodyStream(response: Response): Readable {
  if (!response.body) return Readable.from([]);
  return Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
}

/** Extensions of the pictures drives make thumbnails of. */
export const PICTURE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'heic',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
