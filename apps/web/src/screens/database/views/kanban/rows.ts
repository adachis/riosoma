import { useMemo, useSyncExternalStore } from 'react';
import type { DatabaseSession, ViewRows } from '../../../../data/types';

class StackRows {
  private snapshot: {
    rows: ViewRows | null;
    revision: number;
    read: { count: number; row(index: number): ReturnType<ViewRows['getRow']>; index(id: string): number };
  } = { rows: null, revision: 0, read: { count: 0, row: () => undefined, index: () => -1 } };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  constructor(
    private session: DatabaseSession,
    private viewId: string,
    private stack: string,
  ) {}
  get = () => this.snapshot;
  private publish = () => {
    const rows = this.snapshot.rows;
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      read: {
        count: rows?.rowCount() ?? 0,
        row: (index) => rows?.getRow(index),
        index: (id) => rows?.indexOf(id) ?? -1,
      },
    };
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.snapshot.rows) {
      const rows = this.session.openView(this.viewId, { stack: this.stack });
      this.snapshot = { ...this.snapshot, rows, revision: this.snapshot.revision + 1 };
      this.unsubscribe = rows.subscribe(this.publish);
      rows.ensureRows(0, 20);
      this.publish();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unsubscribe?.();
        this.snapshot.rows?.close();
        this.snapshot = { ...this.snapshot, rows: null, revision: this.snapshot.revision + 1 };
      }
    };
  };
}

export function useStackRows(session: DatabaseSession, viewId: string, stack: string) {
  const resource = useMemo(() => new StackRows(session, viewId, stack), [session, viewId, stack]);
  return useSyncExternalStore(resource.subscribe, resource.get, resource.get);
}
