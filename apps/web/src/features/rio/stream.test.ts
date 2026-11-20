import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamReply } from './stream';
import type { RioAsk, RioEvent } from '@riosoma/contracts';
import { failure } from '../../screens/database/share/testing';

const ask: RioAsk = { text: 'Find the records', context: {}, tier: 'everyday', locale: 'en-US' };
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function response(parts: Uint8Array[]) {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  );
}

describe('reply stream', () => {
  it('sends settings context without changing the panel’s conversation state', async () => {
    window.history.replaceState(null, '', '/settings/ai');
    const fetcher = vi.fn(async () => response([new TextEncoder().encode('data: {"type":"done"}\n\n')]));
    vi.stubGlobal('fetch', fetcher);
    await streamReply('settings', ask, new AbortController().signal, vi.fn());
    expect(
      JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).context,
    ).toEqual({ page: 'settings' });
  });
  it('handles byte-sized chunks, split Unicode and CRLF, comments, named events, and multiline data', async () => {
    const body =
      ': keepalive\r\nevent: text\r\ndata: {"type":"text",\r\ndata: "blockIndex":0,"delta":"café 🌱"}\r\n\r\ndata: {"type":"done"}\r\n\r\n';
    const bytes = new TextEncoder().encode(body);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response([...bytes].map((byte) => new Uint8Array([byte])))),
    );
    const events: RioEvent[] = [];
    await streamReply('id with spaces', ask, new AbortController().signal, (event) => events.push(event));
    expect(events).toEqual([{ type: 'text', blockIndex: 0, delta: 'café 🌱' }, { type: 'done' }]);
    expect(fetch).toHaveBeenCalledWith(
      '/api/rio/conversations/id%20with%20spaces/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('reports a truncated stream instead of treating an incomplete reply as done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response([new TextEncoder().encode('data: {"type":"text","blockIndex":0,"delta":"partial"}\n\n')]),
      ),
    );
    await expect(streamReply('one', ask, new AbortController().signal, vi.fn())).rejects.toMatchObject({
      info: { messageKey: 'errors.internal' },
    });
  });

  it('preserves server error keys and rejects non-streaming responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => failure('errors.adminOnly', 403)),
    );
    await expect(streamReply('one', ask, new AbortController().signal, vi.fn())).rejects.toMatchObject({
      info: { messageKey: 'errors.adminOnly' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy</html>')),
    );
    await expect(streamReply('one', ask, new AbortController().signal, vi.fn())).rejects.toMatchObject({
      info: { messageKey: 'errors.internal' },
    });
  });

  it('cancels a pending read and ignores buffered events after abort', async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const abort = new AbortController();
    const receive = vi.fn();
    const pending = streamReply('one', ask, abort.signal, receive);
    await Promise.resolve();
    abort.abort();
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(receive).not.toHaveBeenCalled();
  });
});
