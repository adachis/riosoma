import { ErrorBody, type RioAsk, type RioEvent } from '@riosoma/contracts';
import { ApiError, currentCsrfToken, guardRequest } from '../../api';

function unreadable(): ApiError {
  return new ApiError(0, { code: 'internal', messageKey: 'errors.internal', userFault: false });
}

/** A POST stream shares the session and CSRF protection of ordinary requests. */
export async function streamReply(
  conversationId: string,
  ask: RioAsk,
  signal: AbortSignal,
  receive: (event: RioEvent) => void,
): Promise<void> {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
  };
  const csrf = currentCsrfToken();
  if (csrf) headers['x-csrf-token'] = csrf;
  const path = `/api/rio/conversations/${encodeURIComponent(conversationId)}/messages`;
  guardRequest('POST', path);
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers,
    body: JSON.stringify({
      ...ask,
      context:
        !ask.context.databaseId && /^\/settings(?:\/|$)/.test(window.location.pathname)
          ? { ...ask.context, page: 'settings' }
          : ask.context,
    }),
    signal,
  });
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(await response.json().catch(() => null));
    throw parsed.success ? new ApiError(response.status, parsed.data.error) : unreadable();
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
    throw unreadable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let terminal = false;
  const line = (value: string) => {
    if (value === '') {
      if (!data.length) return;
      const event = JSON.parse(data.join('\n')) as RioEvent;
      data = [];
      if (!signal.aborted) receive(event);
      terminal = event.type === 'done' || event.type === 'error';
    } else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  };
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!terminal && !signal.aborted) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary: number;
      while (!terminal && (boundary = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, boundary).replace(/\r$/, ''));
        buffer = buffer.slice(boundary + 1);
      }
      if (chunk.done) {
        if (buffer) line(buffer.replace(/\r$/, ''));
        if (!terminal) line('');
        if (!terminal && !signal.aborted) throw unreadable();
        break;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
