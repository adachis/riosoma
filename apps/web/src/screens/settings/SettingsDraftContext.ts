import { createContext, useContext } from 'react';

export interface Section {
  dirty: boolean;
  stored?: unknown;
  conflict?: boolean;
  priority?: number;
  prepareSave?(): () => void;
  save(): Promise<unknown>;
  discard(): void;
  validate?(): string | null;
}

export interface DraftContext {
  active: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string | null;
  explain(message: string): void;
  register(id: string, section: Section): void;
  unregister(id: string): void;
  setPage(page: string | null): void;
  save(): Promise<boolean>;
  discard(): void;
  reload(): Promise<void>;
  requestLeave(): Promise<boolean>;
}

export const Context = createContext<DraftContext | null>(null);

export function useSettingsLeaveGuard() {
  return useContext(Context)?.requestLeave ?? (() => Promise.resolve(true));
}
