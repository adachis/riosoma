import { Command } from '@riosoma/contracts';
import type { RunOptions } from './types';

export interface OutboxEntry {
  userId: string;
  databaseId: string;
  command: Command;
  order: number;
  options?: RunOptions;
}
export interface OutboxStore {
  load(userId: string, databaseId: string): Promise<OutboxEntry[]>;
  put(entries: readonly OutboxEntry[]): Promise<void>;
  remove(userId: string, databaseId: string, commandIds: readonly string[]): Promise<void>;
  /**
   * Keeps entries at once, with no promise to wait for, for a page that is going away before its
   * stored write could land.  What it keeps reaches `load` on the next visit.
   */
  keepNow(entries: readonly OutboxEntry[]): void;
}
const key = (userId: string, databaseId: string, commandId: string) =>
  JSON.stringify([userId, databaseId, commandId]);

/**
 * The store a page can still write in its last moment.  An IndexedDB transaction that has not
 * committed when the page goes away is dropped with it, so a change made and then left is written
 * here synchronously and promoted into IndexedDB on the next load.
 */
const SPILL_KEY = 'rio.data.outbox';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunOptions(value: unknown): value is RunOptions {
  if (!isObject(value)) return false;
  const place = value.placeAt;
  return (
    (value.handlesRefusal === undefined || typeof value.handlesRefusal === 'boolean') &&
    (place === undefined ||
      (isObject(place) &&
        typeof place.viewId === 'string' &&
        typeof place.index === 'number' &&
        Number.isFinite(place.index)))
  );
}

function parseEntries(value: unknown): OutboxEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry: unknown) => {
    if (
      !isObject(entry) ||
      typeof entry.userId !== 'string' ||
      typeof entry.databaseId !== 'string' ||
      typeof entry.order !== 'number' ||
      !Number.isFinite(entry.order) ||
      (entry.options !== undefined && !isRunOptions(entry.options))
    )
      return [];
    const command = Command.safeParse(entry.command);
    if (!command.success) return [];
    return [
      {
        userId: entry.userId,
        databaseId: entry.databaseId,
        order: entry.order,
        command: command.data,
        ...(entry.options === undefined ? {} : { options: entry.options }),
      },
    ];
  });
}

/** Everything a page left behind, wherever it was going. */
export function readSpill(): OutboxEntry[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SPILL_KEY) ?? '[]');
    return parseEntries(stored);
  } catch {
    // Storage that is off, or full of something else, leaves nothing to carry over.
    return [];
  }
}

function writeSpill(entries: readonly OutboxEntry[]): void {
  try {
    localStorage.setItem(SPILL_KEY, JSON.stringify(entries));
  } catch {
    // A page with no storage keeps the change only as long as it lives.
  }
}

/** Adds entries to what a page left behind, keeping one copy of each command. */
export function rememberSpill(entries: readonly OutboxEntry[]): void {
  const kept = new Map(
    readSpill().map((entry) => [key(entry.userId, entry.databaseId, entry.command.id), entry]),
  );
  for (const entry of entries) kept.set(key(entry.userId, entry.databaseId, entry.command.id), entry);
  writeSpill([...kept.values()]);
}

/** Drops entries that have reached IndexedDB or been answered, so nothing is replayed twice. */
export function forgetSpill(userId: string, databaseId: string, commandIds: readonly string[]): void {
  const kept = readSpill();
  const ids = new Set(commandIds);
  const rest = kept.filter(
    (entry) => !(entry.userId === userId && entry.databaseId === databaseId && ids.has(entry.command.id)),
  );
  if (rest.length === kept.length) return;
  if (rest.length) writeSpill(rest);
  else clearSpill();
}

export function clearSpill(): void {
  try {
    localStorage.removeItem(SPILL_KEY);
  } catch {
    // Nothing to clear where nothing could be stored.
  }
}

/** One list of entries in the order they were made, with one copy of each command. */
export function mergeEntries(...lists: ReadonlyArray<readonly OutboxEntry[]>): OutboxEntry[] {
  const byCommand = new Map<string, OutboxEntry>();
  for (const entries of lists)
    for (const entry of entries) byCommand.set(key(entry.userId, entry.databaseId, entry.command.id), entry);
  return [...byCommand.values()].sort((a, b) => a.order - b.order);
}

export class MemoryOutboxStore implements OutboxStore {
  private entries = new Map<string, OutboxEntry>();
  async load(userId: string, databaseId: string): Promise<OutboxEntry[]> {
    return structuredClone(
      [...this.entries.values()]
        .filter((entry) => entry.userId === userId && entry.databaseId === databaseId)
        .sort((a, b) => a.order - b.order),
    );
  }
  async put(entries: readonly OutboxEntry[]): Promise<void> {
    for (const entry of entries)
      this.entries.set(key(entry.userId, entry.databaseId, entry.command.id), structuredClone(entry));
  }
  async remove(userId: string, databaseId: string, commandIds: readonly string[]): Promise<void> {
    for (const id of commandIds) this.entries.delete(key(userId, databaseId, id));
  }
  keepNow(entries: readonly OutboxEntry[]): void {
    for (const entry of entries)
      this.entries.set(key(entry.userId, entry.databaseId, entry.command.id), structuredClone(entry));
  }
}

export class IndexedDbOutboxStore implements OutboxStore {
  private database: Promise<IDBDatabase> | undefined;
  constructor(private readonly name = 'rio-data-outbox') {}
  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.name, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('commands', { keyPath: 'key' });
          store.createIndex('owner', ['userId', 'databaseId']);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.onversionchange = () => {
            request.result.close();
            this.database = undefined;
          };
          resolve(request.result);
        };
      }).catch((error: unknown) => {
        this.database = undefined;
        throw error;
      });
    }
    return this.database;
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore, result: (value: T) => void) => void,
  ): Promise<T> {
    const database = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = database.transaction('commands', mode);
      let value: T;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
      work(transaction.objectStore('commands'), (result) => {
        value = result;
      });
    });
  }
  async load(userId: string, databaseId: string): Promise<OutboxEntry[]> {
    const kept = readSpill().filter((entry) => entry.userId === userId && entry.databaseId === databaseId);
    const stored = await this.transaction<OutboxEntry[]>('readonly', (store, result) => {
      const request = store.index('owner').getAll([userId, databaseId]);
      request.onsuccess = () => result(parseEntries(request.result).sort((a, b) => a.order - b.order));
    });
    if (!kept.length) return stored;
    try {
      await this.put(kept);
      forgetSpill(
        userId,
        databaseId,
        kept.map((entry) => entry.command.id),
      );
    } catch {
      // What a page left behind stays where it is until the store can take it.
    }
    return mergeEntries(stored, kept);
  }
  put(entries: readonly OutboxEntry[]): Promise<void> {
    return this.transaction('readwrite', (store) => {
      for (const entry of entries)
        store.put({ ...entry, key: key(entry.userId, entry.databaseId, entry.command.id) });
    });
  }
  async remove(userId: string, databaseId: string, commandIds: readonly string[]): Promise<void> {
    await this.transaction('readwrite', (store) => {
      for (const id of commandIds) store.delete(key(userId, databaseId, id));
    });
    forgetSpill(userId, databaseId, commandIds);
  }
  keepNow(entries: readonly OutboxEntry[]): void {
    rememberSpill(entries);
  }
}
