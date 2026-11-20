import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SourceConnection } from '@riosoma/contracts';
import { checkFileHost } from './files.js';

// A lookup's clock must not count idle connection timers from a running server fixture.
describe('the guarded network for file sources', () => {
  it('bounds a save-time lookup that never answers', async () => {
    vi.useFakeTimers();
    try {
      const connection = SourceConnection.parse({
        kind: 'ftps',
        host: `${randomBytes(8).toString('hex')}.invalid`,
        user: 'reader',
        path: '*.csv',
      });
      let settled = false;
      const pending = checkFileHost(
        connection,
        { production: true, automationsAllowPrivateHosts: false },
        () => new Promise(() => {}),
      ).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(true);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
