import type { GridGroupBoundary } from '@riosoma/contracts';
import {
  AttachmentMeta,
  cellValue,
  FILE_LIMITS,
  idsOf,
  LIMITS,
  type FieldMeta,
  type RecordNames,
  type RowData,
  type RowsPage,
} from '@riosoma/contracts';
import { api } from '../../../api';

/**
 * Reading every record of a view for a printout, a page at a time, in the order the view shows.
 * The first page's snapshot holds the order, so records someone adds or moves while the pages
 * arrive never show up twice or go missing.
 */

/** Records per request: the most one page of the rows API returns. */
export const PRINT_PAGE = LIMITS.pageSize;

/** Above this many records a printout asks before it goes on. */
export const LARGE_PRINT = 5_000;

/** A snapshot the server let go of mid-read starts the read over, but not forever. */
const MAX_RESTARTS = 2;

export interface LoadedRecords {
  groups?: GridGroupBoundary[];
  rows: RowData[];
  /** Linked records' names, from every page */
  linked: Map<string, string>;
  /** Attachment details, from every page */
  attachments: Map<string, AttachmentMeta>;
}

export interface LoadOptions {
  viewId: string;
  /** The reader's zone, for filters on dates that follow each viewer */
  timeZone: string;
  /** Stops the read, and drops the records read so far. */
  signal: AbortSignal;
  /** Called after every page with the positions read so far and the view's total. */
  onProgress(read: number, total: number): void;
  /** Asked once, after the first page, when the view holds more than `LARGE_PRINT` records. */
  confirmLarge(total: number): Promise<boolean>;
  /** How a page is fetched, which is the rows API unless a test says otherwise. */
  fetchPage?: (path: string, signal: AbortSignal) => Promise<RowsPage>;
}

/** Thrown when the server keeps rebuilding the view's order faster than it can be read. */
export class OrderChangedError extends Error {
  constructor() {
    super('The view’s order kept changing while it was read.');
    this.name = 'OrderChangedError';
  }
}

export function rowsPath(viewId: string, offset: number, timeZone: string, snapshot?: string): string {
  const query = new URLSearchParams({ offset: String(offset), limit: String(PRINT_PAGE), tz: timeZone });
  if (snapshot) query.set('snapshot', snapshot);
  return `/api/views/${encodeURIComponent(viewId)}/rows?${query.toString()}`;
}

const byApi = (path: string, signal: AbortSignal) => api<RowsPage>(path, { signal });

/** What one pass over the pages ended with. */
type Pass = LoadedRecords | 'stopped' | 'rebuilt';

/**
 * Every record of the view, or null when the read was stopped or the person chose not to go on
 * with a large view.  A request that fails for any other reason rejects with its error.
 */
export async function loadViewRecords(options: LoadOptions): Promise<LoadedRecords | null> {
  const { signal } = options;
  const ask = { asked: false };
  try {
    for (let restarts = 0; ; restarts++) {
      const pass = await readPages(options, ask);
      if (pass === 'stopped') return null;
      if (pass !== 'rebuilt') return pass;
      if (restarts >= MAX_RESTARTS) throw new OrderChangedError();
    }
  } catch (error) {
    if (signal.aborted) return null;
    throw error;
  }
}

async function readPages(options: LoadOptions, ask: { asked: boolean }): Promise<Pass> {
  const { viewId, timeZone, signal, onProgress, confirmLarge } = options;
  const fetchPage = options.fetchPage ?? byApi;
  const result: LoadedRecords = { rows: [], linked: new Map(), attachments: new Map() };
  let snapshot: string | undefined;
  let offset = 0;
  for (;;) {
    if (signal.aborted) return 'stopped';
    const page = await fetchPage(rowsPath(viewId, offset, timeZone, snapshot), signal);
    if (signal.aborted) return 'stopped';
    // The server let the order go, so the pages read so far may not line up with the next ones.
    if (snapshot !== undefined && (page.rebuilt || page.snapshot !== snapshot)) return 'rebuilt';
    snapshot = page.snapshot;
    if (page.groups) result.groups = page.groups;
    // Deleted slots would shift every later group header, so take a fresh grouped snapshot.
    if (result.groups?.length && page.rows.some((row) => row === null)) return 'rebuilt';
    // A record deleted since the order was taken leaves a gap, not a blank record.
    for (const row of page.rows) if (row) result.rows.push(row);
    for (const [id, name] of Object.entries(page.linked ?? {})) result.linked.set(id, name);
    for (const [id, file] of Object.entries(page.attachments ?? {})) result.attachments.set(id, file);
    offset = page.offset + page.rows.length;
    onProgress(Math.min(offset, page.total), page.total);
    if (!ask.asked && page.total > LARGE_PRINT) {
      ask.asked = true;
      if (!(await confirmLarge(page.total)) || signal.aborted) return 'stopped';
    }
    // A short page, or one that reaches the total, is the last one.
    if (page.rows.length < PRINT_PAGE || offset >= page.total) return result;
  }
}

/** The most names one request asks for, as the names API allows. */
const NAMES_PER_REQUEST = 500;

export interface RecordNamesResult {
  linked: Map<string, string>;
  attachments: Map<string, AttachmentMeta>;
}

/**
 * The names a record's links and files print with that the page hasn't read yet.  The session
 * usually has them already, and any it lacks are asked for once.  A name that can't be read, such
 * as a record the reader can't see, prints as its ID, the way the grid shows it.
 */
export async function recordNames(
  row: RowData,
  fields: readonly FieldMeta[],
  known: { linked?: ReadonlyMap<string, string>; attachments?: ReadonlyMap<string, AttachmentMeta> },
  signal: AbortSignal,
): Promise<RecordNamesResult> {
  const result: RecordNamesResult = { linked: new Map(), attachments: new Map() };
  const links = new Map<string, Set<string>>();
  const files = new Set<string>();
  for (const field of fields) {
    if (field.type === 'link') {
      const wanted = links.get(field.options.linkedTableId) ?? new Set<string>();
      for (const id of idsOf(cellValue(row, field))) if (!known.linked?.has(id)) wanted.add(id);
      if (wanted.size) links.set(field.options.linkedTableId, wanted);
    } else if (field.type === 'attachment') {
      for (const id of idsOf(cellValue(row, field))) if (!known.attachments?.has(id)) files.add(id);
    }
  }
  const requests: Promise<void>[] = [];
  for (const [tableId, wanted] of links) {
    const ids = [...wanted];
    for (let start = 0; start < ids.length; start += NAMES_PER_REQUEST)
      requests.push(
        api<RecordNames>(`/api/tables/${encodeURIComponent(tableId)}/records/names`, {
          method: 'POST',
          body: { ids: ids.slice(start, start + NAMES_PER_REQUEST) },
          signal,
        }).then((names) => {
          for (const [id, name] of Object.entries(names)) result.linked.set(id, name);
        }),
      );
  }
  const ids = [...files];
  for (let start = 0; start < ids.length; start += FILE_LIMITS.detailsPerRequest) {
    const batch = ids.slice(start, start + FILE_LIMITS.detailsPerRequest);
    requests.push(
      api<unknown>(`/api/files?ids=${batch.map(encodeURIComponent).join(',')}`, { signal }).then((body) => {
        const entries = typeof body === 'object' && body !== null ? Object.values(body) : [];
        for (const entry of entries) {
          const parsed = AttachmentMeta.safeParse(entry);
          if (parsed.success) result.attachments.set(parsed.data.id, parsed.data);
        }
      }),
    );
  }
  // A name that fails to load prints as its ID rather than holding up the printout.
  await Promise.allSettled(requests);
  return result;
}
