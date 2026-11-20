import { describe, expect, it } from 'vitest';
import { requestSlot } from './http.js';

describe('shared API request slots', () => {
  it('limits simultaneous reads across connector instances and wakes the next request on release', async () => {
    const signal = new AbortController().signal;
    const first = await requestSlot('shared-company', 2, signal);
    const second = await requestSlot('shared-company', 2, signal);
    let started = false;
    const waiting = requestSlot('shared-company', 2, signal).then((release) => {
      started = true;
      return release;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    first();
    const third = await waiting;
    expect(started).toBe(true);
    second();
    third();
  });
  it('removes canceled waiters without consuming a slot or blocking another company', async () => {
    const controller = new AbortController();
    const first = await requestSlot('cancel-company', 1, controller.signal);
    const pending = requestSlot('cancel-company', 1, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const other = await requestSlot('other-company', 1, new AbortController().signal);
    other();
    first();
    const next = await requestSlot('cancel-company', 1, new AbortController().signal);
    next();
  });
});
