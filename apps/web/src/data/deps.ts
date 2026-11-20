import { isId, newId } from '@riosoma/contracts';
import type { ApiOptions } from '../api';
import type { OutboxStore } from './outbox';

export type Http = <T>(path: string, options?: ApiOptions) => Promise<T>;
export interface Clock {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const browserClock: Clock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, delay) => globalThis.setTimeout(() => callback(), delay),
  clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'close' | 'error' | 'message',
    listener: (event: { data?: unknown }) => void,
  ): void;
}
export type WebSocketFactory = (url: string) => RealtimeSocket;
export const browserWebSocket: WebSocketFactory = (url) => new WebSocket(url);

export interface SessionDeps {
  http?: Http;
  webSocketFactory?: WebSocketFactory;
  outbox?: OutboxStore;
  clock?: Clock;
  clientId?: string;
  /** Outbox entries are isolated by the signed-in person, even on a shared browser. */
  userId?: string;
  csrfToken?: () => string | null;
  onlineTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

let tabId: string | undefined;
export function clientId(): string {
  if (tabId) return tabId;
  try {
    const stored = sessionStorage.getItem('rio.data.client');
    if (isId(stored, 'client')) return (tabId = stored);
  } catch {
    // A tab still has a stable identity when browser storage is disabled.
  }
  tabId = newId('client');
  try {
    sessionStorage.setItem('rio.data.client', tabId);
  } catch {
    // The in-memory ID lasts until this tab reloads.
  }
  return tabId;
}

export function retryDelay(attempt: number, clock: Clock): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.8 + clock.random() * 0.2);
}
