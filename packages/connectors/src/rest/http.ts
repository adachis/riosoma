import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * The manners an API source keeps: an even pace of requests to each API, patience with a 429 or
 * 503 that says when to come back, and one OAuth token per client for as long as it lasts.
 */

/** How long a wait for the next request slot, or for a Retry-After, may be cut short. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return ms <= 0 ? Promise.resolve() : wait(ms, undefined, { signal });
}

/** The next free moment for each API, by the key the connector gives it. */
const pacers = new Map<string, number>();

const requestSlots = new Map<string, { active: number; waiting: Set<(release: () => void) => void> }>();

/** Hold a shared slot until the response body is consumed, including slow reads. */
export function requestSlot(key: string, maximum: number, signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  const state = requestSlots.get(key) ?? { active: 0, waiting: new Set() };
  requestSlots.set(key, state);
  const release = () => {
    const next = state.waiting.values().next().value;
    if (next) {
      state.waiting.delete(next);
      next(release);
    } else if (--state.active === 0) requestSlots.delete(key);
  };
  if (state.active < maximum) {
    state.active++;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const ready = (release: () => void) => {
      signal.removeEventListener('abort', abort);
      resolve(release);
    };
    const abort = () => {
      state.waiting.delete(ready);
      reject(signal.reason);
    };
    state.waiting.add(ready);
    signal.addEventListener('abort', abort, { once: true });
  });
}

const requestWindows = new Map<string, { times: number[]; windowMs: number }>();

/** Reserve every attempt against a rolling budget shared by this account's connector instances. */
export function reserveRequest(
  key: string,
  limit: { count: number; windowMs: number },
  now: number,
): boolean {
  const cutoff = now - limit.windowMs;
  for (const [name, window] of requestWindows)
    if (window.times.at(-1)! <= now - window.windowMs) requestWindows.delete(name);
  const times = (requestWindows.get(key)?.times ?? []).filter((time) => time > cutoff);
  if (times.length >= limit.count) return false;
  times.push(now);
  requestWindows.set(key, { times, windowMs: limit.windowMs });
  return true;
}

/**
 * Waits for this API's next request slot.  Requests are spaced evenly, so `perSecond` of them
 * reach the API in any second, and every call sharing a key shares the pace.
 */
export async function pace(
  key: string,
  perSecond: number,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<void> {
  const moment = now();
  // Paces that have been idle a while hold no one back, so they needn't be kept.
  for (const [name, next] of pacers) if (next < moment - 60_000) pacers.delete(name);
  const at = Math.max(moment, pacers.get(key) ?? 0);
  pacers.set(key, at + 1_000 / perSecond);
  await sleep(at - moment, signal);
}

/** What a Retry-After header asks for, in milliseconds, or null when it asks for nothing readable. */
export function retryAfterMs(header: string | undefined, now: number): number | null {
  const text = header?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1_000;
  const date = Date.parse(text);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * The address a `Link` header gives for `rel="next"`, or null.  A relation can list several names,
 * and each link's address is between angle brackets, so commas inside one never split it.
 */
export function nextLink(header: string | undefined): string | null {
  if (!header) return null;
  for (const match of header.matchAll(/<([^>]*)>([^<]*)/g)) {
    const rel = /(?:^|;)\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2] ?? '');
    const names = (rel?.[1] ?? rel?.[2] ?? '').toLowerCase().split(/\s+/);
    if (names.includes('next')) return match[1]!.trim();
  }
  return null;
}

interface Token {
  value: string;
  expiresAt: number;
}

/** OAuth tokens by client, kept only in memory and never written anywhere. */
const tokens = new Map<string, Token>();
/** A token is renewed this long before it says it expires, so none runs out mid-read. */
const EARLY_MS = 30_000;
/** How long a token that doesn't say when it expires is used before asking again. */
export const UNDATED_TOKEN_MS = 60 * 60_000;

/**
 * The cache key for one client: everything that decides which token the token address gives, the
 * secret included, so a changed secret asks for a token of its own.  Only a hash is kept.
 */
export function tokenKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function cachedToken(key: string, now: number): string | undefined {
  const token = tokens.get(key);
  if (token && token.expiresAt - EARLY_MS > now) return token.value;
  tokens.delete(key);
  return undefined;
}

export function keepToken(key: string, value: string, expiresAt: number, now: number): void {
  for (const [name, token] of tokens) if (token.expiresAt <= now) tokens.delete(name);
  tokens.set(key, { value, expiresAt });
}

export function forgetToken(key: string): void {
  tokens.delete(key);
}
