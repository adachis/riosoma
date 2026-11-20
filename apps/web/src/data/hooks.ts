import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { PresencePeer } from '@riosoma/contracts';
import { useSession } from '../session';
import { openDatabase } from './session';
import type { DatabaseSession, SaveState, SchemaState, SessionEvent, ViewRows } from './types';

interface SessionSnapshot {
  session: DatabaseSession | null;
  error?: unknown;
}
class SessionResource {
  private value: SessionSnapshot = { session: null };
  private listeners = new Set<() => void>();
  private opening: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly databaseId: string,
    private readonly userId: string,
    private readonly release: () => void,
  ) {}
  get = (): SessionSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    clearTimeout(this.timer);
    this.listeners.add(listener);
    if (!this.opening && !this.value.session && !this.value.error) {
      this.opening = openDatabase(this.databaseId, { userId: this.userId })
        .then((session) => {
          this.value = { session };
          this.emit();
        })
        .catch((error: unknown) => {
          this.value = { session: null, error };
          this.emit();
        })
        .finally(() => {
          this.opening = undefined;
        });
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size)
        this.timer = setTimeout(() => {
          if (this.listeners.size) return;
          this.release();
          if (this.opening) void this.opening.then(() => this.value.session?.close());
          else this.value.session?.close();
        }, 0);
    };
  };
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
const sessions = new Map<string, SessionResource>();
const emptySession: SessionSnapshot = { session: null };
const nothing = () => () => undefined;
const noSession = () => emptySession;

/** Returns null while the schema loads; failures reach the screen's error boundary. */
export function useDatabaseSession(databaseId: string | null): DatabaseSession | null {
  const auth = useSession();
  const userId = auth?.user.id;
  const resource = useMemo(() => {
    if (!databaseId || !userId) return null;
    const key = JSON.stringify([userId, databaseId]);
    let entry = sessions.get(key);
    if (!entry) {
      entry = new SessionResource(databaseId, userId, () => sessions.delete(key));
      sessions.set(key, entry);
    }
    return entry;
  }, [databaseId, userId]);
  const snapshot = useSyncExternalStore(
    resource?.subscribe ?? nothing,
    resource?.get ?? noSession,
    noSession,
  );
  if (snapshot.error) throw snapshot.error;
  return snapshot.session;
}

export function useSchema(session: DatabaseSession | null): SchemaState | null {
  return useSyncExternalStore(
    useCallback((listener) => session?.subscribe(listener) ?? (() => undefined), [session]),
    useCallback(() => session?.getSchema() ?? null, [session]),
    () => null,
  );
}
const idle: SaveState = { status: 'idle', pending: 0 };
export function useSaveState(session: DatabaseSession | null): SaveState {
  return useSyncExternalStore(
    useCallback((listener) => session?.subscribeSaveState(listener) ?? (() => undefined), [session]),
    useCallback(() => session?.saveState() ?? idle, [session]),
    () => idle,
  );
}
const noPeers: readonly PresencePeer[] = [];
export function usePeers(session: DatabaseSession | null): readonly PresencePeer[] {
  return useSyncExternalStore(
    useCallback((listener) => session?.subscribePeers(listener) ?? (() => undefined), [session]),
    useCallback(() => session?.peers() ?? noPeers, [session]),
    () => noPeers,
  );
}

class ViewResource {
  private snapshot: { rows: ViewRows | null; revision: number } = { rows: null, revision: 0 };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  constructor(
    private readonly session: DatabaseSession | null,
    private readonly viewId: string | null,
    private readonly where: string | undefined,
    private readonly updates: 'all' | 'structure',
  ) {}
  get = () => this.snapshot;
  private publish = () => {
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.snapshot.rows && this.session && this.viewId) {
      const rows = this.session.openView(this.viewId, this.where ? { where: this.where } : undefined);
      this.snapshot = { rows, revision: this.snapshot.revision + 1 };
      this.unsubscribe = rows.subscribe((change) => {
        // The grid draws changed cells through its own subscription.  Its surrounding controls
        // need structural updates, while React-rendered views also need row-data updates.
        if (this.updates === 'all' || change.rows === 'all' || change.count || change.prompts || change.live)
          this.publish();
      });
      this.publish();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unsubscribe?.();
        this.snapshot.rows?.close();
        this.snapshot = { rows: null, revision: this.snapshot.revision + 1 };
      }
    };
  };
}
/** A view's rows, narrowed by a `where` token when one is given (see `RowsScope`). */
export function useViewRows(
  session: DatabaseSession | null,
  viewId: string | null,
  where?: string,
  updates: 'all' | 'structure' = 'all',
): ViewRows | null {
  const store = useMemo(
    () => new ViewResource(session, viewId, where, updates),
    [session, viewId, where, updates],
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get).rows;
}

export function useSessionEvents(
  session: DatabaseSession | null,
  handler: (event: SessionEvent) => void,
): void {
  useEffect(() => session?.subscribeEvents(handler), [session, handler]);
}
