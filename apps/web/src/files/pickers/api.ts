import {
  AttachmentMeta,
  ErrorBody,
  ImportEvent,
  statusFor,
  type BrowsedProvider,
  type CloudProvider,
  type ConnectedProvider,
  type IntegrationProvider,
  type DriveExportFormat,
  type DriveListing,
  type GooglePickerConfig,
} from '@riosoma/contracts';
import { api, ApiError, currentCsrfToken } from '../../api';

import { connectionStore } from './connection-store';
export { connectionStore, keepConnectionsToPerson } from './connection-store';

export async function disconnect(provider: ConnectedProvider, confirmed = false): Promise<void> {
  await api(`/api/connections/${provider}${confirmed ? '?confirm=true' : ''}`, { method: 'DELETE' });
  await connectionStore.load(true);
}

/** Where connecting starts.  The server sends the browser on to the provider and back to `next`. */
export function connectUrl(provider: IntegrationProvider, next: string): string {
  return `/api/oauth/start/${provider}?next=${encodeURIComponent(next)}`;
}

/** Tabs and windows of the app tell each other when an account was connected. */
export const CONNECTIONS_CHANNEL = 'rio-connections';

export interface ConnectedMessage {
  provider: string;
  ok: boolean;
  /** A server message key, when connecting failed */
  error?: string;
}

/** A message as it travels, with an ID, since it can arrive by more than one way. */
interface Envelope extends ConnectedMessage {
  id: string;
}

function envelopeOf(data: unknown): Envelope | null {
  if (typeof data !== 'object' || data === null) return null;
  const { id, provider, ok, error } = data as Record<string, unknown>;
  if (typeof id !== 'string' || typeof provider !== 'string' || typeof ok !== 'boolean') return null;
  return { id, provider, ok, ...(typeof error === 'string' ? { error } : {}) };
}

/**
 * Opens the provider in a small window of its own, so the attachment panel keeps its place.  The
 * window lands on `/connected/<provider>`, which says how it went and closes itself.
 */
export function openConnectWindow(provider: ConnectedProvider): Window | null {
  return window.open(
    connectUrl(provider, `/connected/${provider}`),
    `rio-connect-${provider}`,
    'popup,width=560,height=720',
  );
}

/**
 * Hears how connecting went in another window of the app.  The page's opener policy cuts the
 * connecting window off from this one as soon as it reaches the provider, so it can't be watched,
 * and its `closed` reads true while it's still open.  It says how it went on a channel every window
 * of this origin hears, and through local storage for a browser without one.
 */
export function onConnected(listener: (message: ConnectedMessage) => void): () => void {
  const heard = new Set<string>();
  const hear = (data: unknown) => {
    const envelope = envelopeOf(data);
    if (!envelope || heard.has(envelope.id)) return;
    heard.add(envelope.id);
    listener({
      provider: envelope.provider,
      ok: envelope.ok,
      ...(envelope.error ? { error: envelope.error } : {}),
    });
  };
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CONNECTIONS_CHANNEL);
  if (channel) channel.onmessage = (event: MessageEvent) => hear(event.data);
  const stored = (event: StorageEvent) => {
    if (event.key !== CONNECTIONS_CHANNEL || !event.newValue) return;
    try {
      hear(JSON.parse(event.newValue));
    } catch {
      // Not a message of ours.
    }
  };
  window.addEventListener('storage', stored);
  return () => {
    channel?.close();
    window.removeEventListener('storage', stored);
  };
}

/** Tells the app's other windows how connecting went, both ways, and each hears it once. */
export function announceConnected(message: ConnectedMessage): void {
  const envelope: Envelope = { ...message, id: crypto.randomUUID() };
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(CONNECTIONS_CHANNEL);
    channel.postMessage(envelope);
    channel.close();
  }
  // Other windows hear each change to local storage, so the entry is written and taken away again.
  try {
    localStorage.setItem(CONNECTIONS_CHANNEL, JSON.stringify(envelope));
    localStorage.removeItem(CONNECTIONS_CHANNEL);
  } catch {
    // Storage is turned off, so the channel is the only way.
  }
}

export function listDrive(
  provider: BrowsedProvider,
  request: { folder: string; query: string; cursor: string },
  signal?: AbortSignal,
): Promise<DriveListing> {
  const params = new URLSearchParams();
  if (request.folder) params.set('folder', request.folder);
  if (request.query) params.set('query', request.query);
  if (request.cursor) params.set('cursor', request.cursor);
  return api<DriveListing>(`/api/connections/${provider}/files?${params}`, signal ? { signal } : {});
}

export function thumbnailUrl(provider: BrowsedProvider, fileId: string): string {
  return `/api/connections/${provider}/thumbnails/${encodeURIComponent(fileId)}`;
}

export function googlePickerConfig(): Promise<GooglePickerConfig> {
  return api<GooglePickerConfig>('/api/connections/google/picker');
}

/** A file picked in a drive, waiting to be copied into an attachment field. */
export interface RemotePick {
  provider: CloudProvider;
  fileId: string;
  name: string;
  size: number | null;
  exportAs?: DriveExportFormat;
}

const OFFLINE = { code: 'unavailable', messageKey: 'errors.offline', userFault: false } as const;
const UNREADABLE = { code: 'internal', messageKey: 'errors.internal', userFault: false } as const;

/**
 * Asks the server to copy a picked file into a record's attachment field, reading its progress as
 * it goes.  `progress` gets a fraction, or null while the size isn't known.  Aborting stops the
 * copy, and the server keeps nothing of it.
 */
export async function importPick(
  target: { tableId: string; fieldId: string; recordId: string },
  pick: RemotePick,
  progress: (fraction: number | null) => void,
  signal: AbortSignal,
): Promise<AttachmentMeta> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/x-ndjson',
  };
  const csrf = currentCsrfToken();
  if (csrf) headers['x-csrf-token'] = csrf;
  let response: Response;
  try {
    response = await fetch(
      `/api/tables/${target.tableId}/fields/${target.fieldId}/records/${target.recordId}/imports`,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: JSON.stringify({
          provider: pick.provider,
          fileId: pick.fileId,
          ...(pick.exportAs ? { exportAs: pick.exportAs } : {}),
        }),
        signal,
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError(0, OFFLINE);
  }
  if (!response.ok || !response.body) {
    const body = ErrorBody.safeParse(await response.json().catch(() => null));
    throw new ApiError(response.status, body.success ? body.data.error : UNREADABLE);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<string>;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ApiError(0, OFFLINE);
    }
    if (chunk.done) break;
    buffered += chunk.value;
    let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      let parsed: ReturnType<typeof ImportEvent.safeParse>;
      try {
        parsed = ImportEvent.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const event = parsed.data;
      if (event.kind === 'progress') progress(event.total ? Math.min(1, event.bytes / event.total) : null);
      else if (event.kind === 'done') return AttachmentMeta.parse(event.file);
      else throw new ApiError(statusFor(event.error.code), event.error);
    }
  }
  throw new ApiError(0, OFFLINE);
}
