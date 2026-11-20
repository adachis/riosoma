import { onPublicDomain } from './public-domain';
import type { ErrorBody } from '@riosoma/contracts';
import { SANDBOX_REFUSED, sandboxRefuses } from './data/sandbox';
import { parseError } from './response-error';

/**
 * The one way the app talks to the server.  Failures always arrive as an ApiError carrying a
 * translatable message key, never raw server text.
 */
export type ApiErrorInfo = ErrorBody['error'];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly info: ApiErrorInfo,
  ) {
    super(info.messageKey);
    if (info.messageKey === 'demo.readOnly') demoRefused?.();
    this.name = 'ApiError';
  }
}

let demoRefused: (() => void) | undefined;

/** Workers share this client, while only the page installs its calm refusal notice. */
export function observeDemoRefusal(listener: () => void): void {
  demoRefused = listener;
}

let csrfToken: string | null = null;
let authenticationLost: (() => void) | undefined;

/** The page's session cache also hears requests made outside the query and mutation caches. */
export function observeAuthenticationLoss(listener: () => void): void {
  authenticationLost = listener;
}
const publicViewPasses = new Map<string, string>();

export function setPublicViewPass(linkId: string, pass: string): void {
  publicViewPasses.set(linkId, pass);
}

/** Set from the session; echoed on every state-changing request. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** The session's CSRF token, which the realtime connection also presents. */
export function currentCsrfToken(): string | null {
  return csrfToken;
}

const SETUP_TOKEN_KEY = 'rio.setupToken';
// With storage turned off the token lives in memory, for as long as this page does.
let setupTokenInMemory: string | null = null;

export function setupToken(): string | null {
  try {
    return sessionStorage.getItem(SETUP_TOKEN_KEY) ?? setupTokenInMemory;
  } catch {
    return setupTokenInMemory;
  }
}

export function storeSetupToken(token: string | null): void {
  setupTokenInMemory = token;
  try {
    if (token) sessionStorage.setItem(SETUP_TOKEN_KEY, token);
    else sessionStorage.removeItem(SETUP_TOKEN_KEY);
  } catch {
    // Storage off: the in-memory copy above is enough for this page.
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** A file the server sent, with the name it chose for it. */
export interface FileBody {
  blob: Blob;
  /** Null when the response carried no name, which only a broken proxy does. */
  filename: string | null;
}

const OFFLINE: ApiErrorInfo = { code: 'unavailable', messageKey: 'errors.offline', userFault: false };
const UNREADABLE: ApiErrorInfo = { code: 'internal', messageKey: 'errors.internal', userFault: false };

/**
 * While a demo runs, only reads leave the browser.  Anything that would change something stops
 * here, before it's sent.  Every request goes through it, including the few that call `fetch`
 * themselves to stream a body.
 */
export function guardRequest(method: string | undefined, path: string): void {
  if (sandboxRefuses(method, path))
    throw new ApiError(409, { code: 'conflict', messageKey: SANDBOX_REFUSED, userFault: true });
}

async function send(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  guardRequest(init.method, path);
  try {
    if (onPublicDomain()) {
      if (path === '/api/config') path = '/api/public/config';
      const headers = new Headers(init.headers);
      headers.delete('x-csrf-token');
      headers.delete('x-setup-token');
      const linkId = /^\/api\/public\/views\/([^/?]+)/.exec(path)?.[1];
      const pass = linkId && publicViewPasses.get(linkId);
      if (pass) headers.set('x-public-view-pass', pass);
      return await fetch(path, { ...init, headers, credentials: 'omit', ...(signal ? { signal } : {}) });
    }
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      ...(signal ? { signal } : {}),
    });
    if (response.status === 401) {
      setCsrfToken(null);
      authenticationLost?.();
    }
    return response;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, OFFLINE);
  }
}

async function bodyOf(res: Response): Promise<{ data: unknown; readable: boolean }> {
  const text = await res.text().catch(() => null);
  if (!text) return { data: null, readable: false };
  try {
    return { data: JSON.parse(text), readable: true };
  } catch {
    // A truncated body, or a proxy's HTML page: not something the app can use.
    return { data: null, readable: false };
  }
}

function errorOf(data: unknown): ApiErrorInfo {
  return parseError(data) ?? UNREADABLE;
}

/**
 * The name in a `Content-Disposition` header.  The extended form wins: it is the one that carries
 * a name in any script, while the plain one is only an ASCII fallback for old clients.
 */
export function contentFilename(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[2]!.trim());
    } catch {
      // A name that isn't valid percent-encoding falls through to the plain one.
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  const name = plain?.[1]?.trim();
  return name ? name : null;
}

/** Reads a file the server streams, keeping the errors the JSON API returns. */
export async function apiFile(path: string, options: ApiOptions = {}): Promise<FileBody> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: '*/*' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await send(
    path,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    options.signal,
  );
  if (!res.ok) throw new ApiError(res.status, errorOf((await bodyOf(res)).data));
  return { blob: await res.blob(), filename: contentFilename(res.headers.get('content-disposition')) };
}

/**
 * Sends a file's bytes as they are, for a route that reads them as they arrive rather than as JSON,
 * keeping the errors the JSON API returns.
 */
export async function apiUpload(
  path: string,
  file: Blob,
  options: { method?: 'POST' | 'PUT'; signal?: AbortSignal } = {},
): Promise<void> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/octet-stream',
  };
  if (csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await send(path, { method: options.method ?? 'PUT', headers, body: file }, options.signal);
  if (!res.ok) throw new ApiError(res.status, errorOf((await bodyOf(res)).data));
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  if (path.startsWith('/api/setup/')) {
    const token = setupToken();
    if (token) headers['x-setup-token'] = token;
  }
  const res = await send(
    path,
    {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    options.signal,
  );
  if (res.status === 204 || res.status === 202) return undefined as T;
  const { data, readable } = await bodyOf(res);
  if (!res.ok) throw new ApiError(res.status, errorOf(data));
  if (!readable) throw new ApiError(res.status, UNREADABLE);
  return data as T;
}
