import { describe, expect, it } from 'vitest';
import {
  jsonOf,
  mailFailureFields,
  MailTransportError,
  retryAfterMs,
  sendWithRetries,
  serviceCode,
} from './http.js';
import type { MailAnswer } from './http.js';

/**
 * The HTTP every transport shares: how long a busy service is waited out for, which short code an
 * error is reported by, and which answers are tried again.
 */

function answer(status: number, body: unknown = '', headers: Record<string, string> = {}): MailAnswer {
  return {
    status,
    headers: new Headers(headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

describe('how long a service asks to be waited out for', () => {
  it('reads a count of seconds', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '7' }))).toBe(7_000);
    expect(retryAfterMs(new Headers({ 'retry-after': ' 12 ' }))).toBe(12_000);
  });

  it('reads a date, against the moment it’s asked', () => {
    const asked = new Date(Date.now() + 30_000).toUTCString();
    const wait = retryAfterMs(new Headers({ 'retry-after': asked }));
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(Date.now() - 60_000).toUTCString() }))).toBe(0);
  });

  it('waits a minute at most, and not at all for an answer it can’t read', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '600' }))).toBe(60_000);
    expect(retryAfterMs(new Headers({ 'retry-after': 'soon' }))).toBeNull();
    expect(retryAfterMs(new Headers({}))).toBeNull();
  });
});

describe('the short code an error is reported by', () => {
  it('reads the headers AWS and Azure set', () => {
    expect(serviceCode(answer(400, '', { 'x-amzn-errortype': 'com.amazonaws.ses#MessageRejected' }))).toBe(
      'MessageRejected',
    );
    expect(serviceCode(answer(403, '', { 'x-ms-error-code': 'Unauthorized' }))).toBe('Unauthorized');
  });

  it('reads an error’s code from JSON, and Google’s short name', () => {
    expect(serviceCode(answer(403, { error: { code: 'ErrorAccessDenied', message: 'no' } }))).toBe(
      'ErrorAccessDenied',
    );
    expect(serviceCode(answer(403, { error: { code: 403, status: 'PERMISSION_DENIED' } }))).toBe(
      'PERMISSION_DENIED',
    );
    expect(serviceCode(answer(400, { error: 'invalid_grant' }))).toBe('invalid_grant');
    expect(serviceCode(answer(400, { __type: 'MessageRejected' }))).toBe('MessageRejected');
  });

  it('reads no message text, since one can quote an address or the message sent', () => {
    const found = serviceCode(answer(400, { error: { message: 'recipient@example.test is not verified' } }));
    expect(found).toBeNull();
    expect(serviceCode(answer(500, 'not json at all'))).toBeNull();
  });

  it('parses an answer’s JSON only when it is JSON', () => {
    expect(jsonOf(answer(200, { status: 'Succeeded' }))).toEqual({ status: 'Succeeded' });
    expect(jsonOf(answer(200, ''))).toBeNull();
    expect(jsonOf(answer(200, '[]'))).toBeNull();
  });
});

describe('sending with retries', () => {
  const request = { method: 'POST' as const, url: 'https://service.example.test/send', headers: {} };

  /** A client that answers from a script and keeps every call it got. */
  function client(statuses: number[]) {
    const calls: string[] = [];
    const fetchStub = (async (url: string | URL | Request) => {
      calls.push(String(url));
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
      return new Response(status === 200 ? '{"ok":true}' : '', { status });
    }) as unknown as typeof fetch;
    return { fetchStub, calls };
  }

  it('tries a busy answer three more times and then reports it', async () => {
    const { fetchStub, calls } = client([503]);
    const waits: number[] = [];
    await expect(
      sendWithRetries(async () => request, [200], 'ses', {
        fetch: fetchStub,
        wait: async (ms) => void waits.push(ms),
      }),
    ).rejects.toThrow(MailTransportError);
    expect(calls).toHaveLength(4);
    expect(waits).toEqual([500, 1_000, 2_000]);
  });

  it.each([501, 505, 507, 599])('tries any server error again, such as %s', async (status) => {
    const { fetchStub, calls } = client([status, 200]);
    const sent = await sendWithRetries(async () => request, [200], 'relay', {
      fetch: fetchStub,
      wait: async () => undefined,
    });
    expect(sent.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('stops at once for an answer no retry helps', async () => {
    const { fetchStub, calls } = client([400]);
    await expect(
      sendWithRetries(async () => request, [200], 'graph', { fetch: fetchStub, wait: async () => undefined }),
    ).rejects.toThrow('Microsoft Graph could not send the message: the service answered HTTP 400');
    expect(calls).toHaveLength(1);
  });

  it('takes the first wanted status it gets', async () => {
    const { fetchStub, calls } = client([429, 200]);
    const sent = await sendWithRetries(async () => request, [200], 'relay', {
      fetch: fetchStub,
      wait: async () => undefined,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
  });

  it('builds the request again for each attempt, since a signature carries its time', async () => {
    const { fetchStub } = client([500, 200]);
    let builds = 0;
    await sendWithRetries(
      async () => ({ ...request, headers: { 'x-attempt': String(++builds) } }),
      [200],
      'ses',
      { fetch: fetchStub, wait: async () => undefined },
    );
    expect(builds).toBe(2);
  });

  it('never retries a request that timed out', async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      const timedOut = new Error('The operation was aborted due to timeout');
      timedOut.name = 'TimeoutError';
      throw timedOut;
    }) as unknown as typeof fetch;
    await expect(
      sendWithRetries(async () => request, [200], 'gmail', { fetch: fetchStub, wait: async () => undefined }),
    ).rejects.toThrow('Gmail could not send the message: the service did not answer in time');
    expect(calls).toBe(1);
  });
});

describe('what a log line may say about a failed send', () => {
  it('carries the transport, the status, and the reason of a transport’s own error', () => {
    const error = new MailTransportError(
      'ses',
      'send the message',
      'the service answered HTTP 400 MessageRejected',
      {
        status: 400,
      },
    );
    expect(mailFailureFields(error)).toEqual({
      transport: 'ses',
      status: 400,
      reason: 'Amazon SES could not send the message: the service answered HTTP 400 MessageRejected',
    });
    expect(
      mailFailureFields(
        new MailTransportError('relay', 'send the message', 'the service did not answer in time'),
      ),
    ).toEqual({
      transport: 'relay',
      reason: 'The mail relay could not send the message: the service did not answer in time',
    });
  });

  it('says nothing of any other error, which can quote the message', () => {
    expect(mailFailureFields(new Error('550 rejected: the whole message follows'))).toEqual({});
    expect(mailFailureFields('delivery failed')).toEqual({});
  });
});
