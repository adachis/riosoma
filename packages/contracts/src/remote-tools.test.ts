import { expect, it } from 'vitest';
import { RemoteServerConfig } from './remote-tools.js';

it('validates incomplete address drafts without throwing during editing', () => {
  for (const address of ['', 'h', 'https:', '/', 'data:text/plain,value']) {
    expect(
      RemoteServerConfig.safeParse({ name: 'Outside', address, auth: 'none', audience: {} }).success,
    ).toBe(false);
  }
});
