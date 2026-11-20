import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setupToken, storeSetupToken } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('api', () => {
  it('rejects a successful response it cannot read instead of returning null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>proxy page</html>', { status: 200 })),
    );
    await expect(api('/api/auth/session')).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"user":', { status: 200 })),
    );
    await expect(api('/api/auth/session')).rejects.toMatchObject({ info: { messageKey: 'errors.internal' } });
  });

  it('keeps the setup token in memory when storage is off, and sends it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage off');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage off');
    });
    storeSetupToken('abcdefghijklmnop-token');
    expect(setupToken()).toBe('abcdefghijklmnop-token');
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await api('/api/setup/unlock', { method: 'POST' });
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers['x-setup-token']).toBe('abcdefghijklmnop-token');
    storeSetupToken(null);
    expect(setupToken()).toBeNull();
  });
});
