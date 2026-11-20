import { unavailable } from './envelope.js';

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  return value as Json;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw unavailable();
  return value;
}

export async function request(url: string | URL, init: RequestInit = {}): Promise<Json> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    if (response.status === 204) return {};
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw unavailable();
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return size ? object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : {};
  } catch {
    throw unavailable();
  }
}

export function json(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export function urlAt(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function tokenCache(login: () => Promise<{ token: string; seconds: number }>): () => Promise<string> {
  let current: { token: string; until: number } | undefined;
  let pending: Promise<string> | undefined;
  return async () => {
    if (current && current.until > Date.now()) return current.token;
    pending ??= login()
      .then(({ token, seconds }) => {
        if (!token || !Number.isFinite(seconds) || seconds <= 0) throw unavailable();
        current = { token, until: Date.now() + Math.max(0, seconds * 1000 - 30000) };
        return token;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
