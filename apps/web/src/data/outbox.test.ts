import { Command, newId } from '@riosoma/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSpill,
  forgetSpill,
  IndexedDbOutboxStore,
  mergeEntries,
  readSpill,
  rememberSpill,
  type OutboxEntry,
} from './outbox';

/** Where a page writes what it couldn't store, so a test can put junk there. */
const SPILL = 'rio.data.outbox';

function entry(order: number, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    userId: 'usrOne',
    databaseId: 'dbOne',
    order,
    command: Command.parse({ id: newId('command'), groupId: newId('action'), kind: 'database.trash' }),
    ...overrides,
  };
}

afterEach(() => {
  clearSpill();
  vi.unstubAllGlobals();
});

/** Storage reads complete before their transaction, as they do in the browser. */
function storedEntries(entries: unknown[]) {
  const database = {
    transaction() {
      const transaction = {
        oncomplete: null as null | (() => void),
        objectStore: () => ({
          index: () => ({
            getAll: () => {
              const request = { result: entries, onsuccess: null as null | (() => void) };
              queueMicrotask(() => {
                request.onsuccess?.();
                transaction.oncomplete?.();
              });
              return request;
            },
          }),
        }),
      };
      return transaction;
    },
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = { result: database, onsuccess: null as null | (() => void) };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
}

for (const source of ['spill', 'indexedDB'] as const) {
  it(`validates complete commands and replay options from ${source}`, async () => {
    const valid = entry(1, { options: { placeAt: { viewId: 'viewOne', index: 0 }, handlesRefusal: true } });
    const entries = [
      valid,
      { ...entry(2), command: { id: newId('command') } },
      { ...entry(3), order: '3' },
      { ...entry(4), options: { placeAt: { viewId: 7, index: 'first' } } },
      { ...entry(5), options: { handlesRefusal: 'yes' } },
    ];
    if (source === 'spill') {
      localStorage.setItem(SPILL, JSON.stringify(entries));
      expect(readSpill()).toEqual([valid]);
    } else {
      storedEntries(entries);
      expect(await new IndexedDbOutboxStore().load(valid.userId, valid.databaseId)).toEqual([valid]);
    }
  });
}

it.each([false, true])('restores page-close entries when promotion fails: %s', async (fails) => {
  const first = entry(1);
  const second = entry(2);
  const anotherDatabase = entry(3, { databaseId: 'dbTwo' });
  storedEntries([second, first]);
  rememberSpill([first, anotherDatabase]);
  const store = new IndexedDbOutboxStore();
  const put = vi.spyOn(store, 'put');
  if (fails) put.mockRejectedValue(new Error('Storage is unavailable'));
  else put.mockResolvedValue();

  expect(await store.load(first.userId, first.databaseId)).toEqual([first, second]);
  expect(put).toHaveBeenCalledWith([first]);
  expect(readSpill()).toEqual(fails ? [first, anotherDatabase] : [anotherDatabase]);
});

describe('what a page leaves behind as it goes away', () => {
  it('keeps one copy of each command', () => {
    const first = entry(1);
    const second = entry(2);
    rememberSpill([first, second]);
    rememberSpill([first]);
    expect(readSpill().map((kept) => kept.command.id)).toEqual([first.command.id, second.command.id]);
  });

  it('reads back nothing that isn’t an entry it kept', () => {
    localStorage.setItem(SPILL, '{"not":"a list"}');
    expect(readSpill()).toEqual([]);
    localStorage.setItem(SPILL, `[${JSON.stringify(entry(1))},null,7,{"userId":"usrOne"}]`);
    expect(readSpill().map((kept) => kept.order)).toEqual([1]);
    localStorage.setItem(SPILL, 'not json');
    expect(readSpill()).toEqual([]);
  });

  it('forgets only the commands it is told about', () => {
    const kept = [entry(1), entry(2), entry(3, { databaseId: 'dbTwo' })];
    rememberSpill(kept);
    forgetSpill('usrOne', 'dbOne', [kept[0]!.command.id]);
    expect(readSpill().map((left) => left.order)).toEqual([2, 3]);
    forgetSpill('usrOne', 'dbTwo', [kept[2]!.command.id]);
    expect(readSpill().map((left) => left.order)).toEqual([2]);
    forgetSpill('usrOne', 'dbOne', [kept[1]!.command.id]);
    expect(readSpill()).toEqual([]);
    expect(localStorage.getItem(SPILL)).toBeNull();
  });

  it('puts what a page stored and what the store holds in one ordered list', () => {
    const stored = [entry(2), entry(4)];
    const kept = [entry(3), stored[1]!, entry(1)];
    expect(mergeEntries(stored, kept).map((one) => one.order)).toEqual([1, 2, 3, 4]);
    expect(mergeEntries([], [])).toEqual([]);
  });
});
