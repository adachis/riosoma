import { afterEach, expect, it } from 'vitest';
import type { AppContext } from '../../app.js';
import type { Actor } from '../../http/policy.js';
import { DOCUMENT_TIMING, withDocumentSlot } from './document-queue.js';

const timing = { ...DOCUMENT_TIMING };
afterEach(() => Object.assign(DOCUMENT_TIMING, timing));

function person(userId: string, orgId = 'org-a') {
  return { kind: 'member', userId, orgId } as unknown as Actor;
}
/** Work that holds its slot until the test lets it go. */
function held() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  let started = false;
  return {
    work: async () => {
      started = true;
      await done;
      return 'done';
    },
    release,
    get started() {
      return started;
    },
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

it('lets one organization with two people run two readings at once', async () => {
  const ctx = {} as AppContext;
  const first = held();
  const colleague = held();
  const running = [
    withDocumentSlot(ctx, person('a1'), undefined, first.work),
    withDocumentSlot(ctx, person('a2'), undefined, colleague.work),
  ];
  await tick();
  expect([first.started, colleague.started]).toEqual([true, true]);
  first.release();
  colleague.release();
  await expect(Promise.all(running)).resolves.toEqual(['done', 'done']);
});

it('gives the next free slot to a waiting organization ahead of one already reading', async () => {
  const ctx = {} as AppContext;
  const first = held();
  const colleague = held();
  const later = held();
  const neighbor = held();
  const running = [
    withDocumentSlot(ctx, person('a1'), undefined, first.work),
    withDocumentSlot(ctx, person('a2'), undefined, colleague.work),
  ];
  await tick();
  // The first organization's third person joins the line before the other organization does.
  running.push(withDocumentSlot(ctx, person('a3'), undefined, later.work));
  await tick();
  running.push(withDocumentSlot(ctx, person('b1', 'org-b'), undefined, neighbor.work));
  await tick();
  expect([later.started, neighbor.started]).toEqual([false, false]);
  first.release();
  await tick();
  expect([later.started, neighbor.started]).toEqual([false, true]);
  colleague.release();
  await tick();
  expect(later.started).toBe(true);
  later.release();
  neighbor.release();
  await expect(Promise.all(running)).resolves.toHaveLength(4);
});

it('keeps each person to one reading at a time', async () => {
  const ctx = {} as AppContext;
  const first = held();
  const second = held();
  const running = [
    withDocumentSlot(ctx, person('a1'), undefined, first.work),
    withDocumentSlot(ctx, person('a1'), undefined, second.work),
  ];
  await tick();
  expect([first.started, second.started]).toEqual([true, false]);
  first.release();
  await tick();
  expect(second.started).toBe(true);
  second.release();
  await expect(Promise.all(running)).resolves.toEqual(['done', 'done']);
});

it('answers busy when the wait for a slot runs out, and the next request still gets one', async () => {
  const ctx = {} as AppContext;
  DOCUMENT_TIMING.queueMs = 50;
  const first = held();
  const running = withDocumentSlot(ctx, person('a1'), undefined, first.work);
  const waiting = held();
  await expect(withDocumentSlot(ctx, person('a1'), undefined, waiting.work)).rejects.toMatchObject({
    messageKey: 'import.document.busy',
    userFault: true,
  });
  expect(waiting.started).toBe(false);
  first.release();
  await running;
  await expect(withDocumentSlot(ctx, person('a1'), undefined, async () => 'next')).resolves.toBe('next');
});

it('turns a canceled wait into a quiet error and frees its place in line', async () => {
  const ctx = {} as AppContext;
  const first = held();
  const running = withDocumentSlot(ctx, person('a1'), undefined, first.work);
  const controller = new AbortController();
  const waiting = held();
  const canceled = withDocumentSlot(ctx, person('a1'), controller.signal, waiting.work);
  await tick();
  controller.abort();
  await expect(canceled).rejects.toMatchObject({ messageKey: 'import.document.canceled', userFault: true });
  first.release();
  await running;
  expect(waiting.started).toBe(false);
});

it('limits how many waiting requests one organization may queue', async () => {
  const ctx = {} as AppContext;
  const first = held();
  const colleague = held();
  const running = [
    withDocumentSlot(ctx, person('a0'), undefined, first.work),
    withDocumentSlot(ctx, person('a1'), undefined, colleague.work),
  ];
  const queued = Array.from({ length: 4 }, (_, index) =>
    withDocumentSlot(ctx, person(`a${index + 2}`), undefined, async () => 'later'),
  );
  await expect(withDocumentSlot(ctx, person('a9'), undefined, async () => 'excess')).rejects.toMatchObject({
    messageKey: 'import.document.busy',
  });
  const neighbor = withDocumentSlot(ctx, person('b1', 'org-b'), undefined, async () => 'served');
  first.release();
  await expect(neighbor).resolves.toBe('served');
  colleague.release();
  await expect(Promise.all([...running, ...queued])).resolves.toHaveLength(6);
});

it('admits a third organization to a full line and gives it the next free slot', async () => {
  const ctx = {} as AppContext;
  const order: string[] = [];
  const reading = (id: string, hold?: ReturnType<typeof held>) => async () => {
    order.push(id);
    return hold ? hold.work() : id;
  };
  const first = held();
  const neighbor = held();
  const third = held();
  const running = [
    withDocumentSlot(ctx, person('a0'), undefined, reading('a0', first)),
    withDocumentSlot(ctx, person('b0', 'org-b'), undefined, reading('b0', neighbor)),
  ];
  await tick();
  // The first two organizations fill the ordinary line.
  const queued = [
    ...['a1', 'a2', 'a3', 'a4'].map((id) => withDocumentSlot(ctx, person(id), undefined, reading(id))),
    ...['b1', 'b2', 'b3', 'b4'].map((id) =>
      withDocumentSlot(ctx, person(id, 'org-b'), undefined, reading(id)),
    ),
  ];
  const late = withDocumentSlot(ctx, person('c1', 'org-c'), undefined, reading('c1', third));
  await expect(withDocumentSlot(ctx, person('c2', 'org-c'), undefined, reading('c2'))).rejects.toMatchObject({
    messageKey: 'import.document.busy',
  });
  first.release();
  await tick();
  expect(order).toEqual(['a0', 'b0', 'c1']);
  third.release();
  neighbor.release();
  await expect(Promise.all([...running, ...queued, late])).resolves.toHaveLength(11);
  expect(order).toHaveLength(11);
});
