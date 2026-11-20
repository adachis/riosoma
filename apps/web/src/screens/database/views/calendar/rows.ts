import { useMemo, useSyncExternalStore } from 'react';
import type { RowData } from '@riosoma/contracts';
import type { DatabaseSession, ViewRows } from '../../../../data/types';

class CalendarRows {
  private rows: ViewRows | undefined;
  private snapshot: { records: readonly RowData[]; loading: boolean } = { records: [], loading: true };
  private listeners = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  constructor(
    private session: DatabaseSession,
    private viewId: string,
    private from: string,
    private to: string,
  ) {}
  get = () => this.snapshot;
  private publish = () => {
    if (!this.rows) return;
    const count = this.rows.rowCount();
    const loaded: RowData[] = [];
    for (let index = 0; index < count; index++) {
      const row = this.rows.getRow(index);
      if (row) loaded.push(row);
    }
    this.snapshot = { records: loaded, loading: this.rows.loading() };
    this.rows.ensureRows(0, count);
    for (const listener of this.listeners) listener();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.rows) {
      this.rows = this.session.openView(this.viewId, { from: this.from, to: this.to });
      this.unsubscribe = this.rows.subscribe(this.publish);
      this.publish();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unsubscribe?.();
        this.rows?.close();
        this.rows = undefined;
      }
    };
  };
}

export function useCalendarRows(session: DatabaseSession, viewId: string, from: string, to: string) {
  const store = useMemo(() => new CalendarRows(session, viewId, from, to), [session, viewId, from, to]);
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
