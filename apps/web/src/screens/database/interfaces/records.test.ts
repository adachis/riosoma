import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecordsBlock } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { BlockRecordsStore, chosenFor, PAGE_SIZE } from './records';
import { closeAll, DONE, interfaceFixture, PAGE_ID, type FixtureIds } from './test-support';

const sessions: DatabaseSession[] = [];
const stores: BlockRecordsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  closeAll(sessions);
});

const records = (ids: FixtureIds): RecordsBlock => ({
  id: 'blkRecords01',
  kind: 'records',
  title: '',
  place: { x: 0, y: 0, w: 6, h: 5 },
  source: { tableId: ids.tableId, viewId: ids.viewId, filter: null },
  fieldIds: [],
  display: 'list',
  showFieldNames: true,
});

async function setup(count = 4) {
  const fixture = await interfaceFixture({
    count,
    blocks: (ids) => [
      records(ids),
      {
        id: 'blkStatus001',
        kind: 'filter',
        title: '',
        place: { x: 6, y: 0, w: 3, h: 1 },
        control: 'choice',
        tableId: ids.tableId,
        fieldId: ids.status,
        blockIds: [],
      },
    ],
  });
  sessions.push(fixture.session);
  const store = new BlockRecordsStore(fixture.session, fixture.value.id, 10);
  stores.push(store);
  const block = fixture.value.pages[0]!.blocks[0] as RecordsBlock;
  const ids = () => {
    const state = store.getSnapshot();
    return state.status === 'ready' ? state.ids : [];
  };
  return { ...fixture, store, block, ids };
}

describe('a records block’s records', () => {
  it('read a page at a time in one order, and more when asked', async () => {
    const { store, block, ids, recordRequests } = await setup(PAGE_SIZE + 5);
    store.start();
    store.setQuery(PAGE_ID, block, {});
    await vi.waitFor(() => expect(ids()).toHaveLength(PAGE_SIZE));
    const first = store.getSnapshot();
    expect(first.status === 'ready' && first.total).toBe(PAGE_SIZE + 5);
    store.loadMore();
    await vi.waitFor(() => expect(ids()).toHaveLength(PAGE_SIZE + 5));
    expect(recordRequests().map((request) => request.offset)).toEqual([0, PAGE_SIZE]);
    expect(recordRequests()[1]!.snapshot).toEqual(expect.any(String));
  });

  it('redraw at once for edits and reload only once the server has them', async () => {
    const { store, block, ids, recordRequests, session, fixture, server } = await setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.start();
    store.setQuery(PAGE_ID, block, {});
    await vi.waitFor(() => expect(ids()).toHaveLength(4));
    // Asking again with the same choices reads nothing.
    store.setQuery(PAGE_ID, { ...block }, {});
    expect(recordRequests()).toHaveLength(1);
    const edit = session.run([
      {
        kind: 'record.update',
        tableId: fixture.tableId,
        records: [{ id: fixture.recordId(0), values: { [fixture.textFieldId]: 'Renamed' } }],
      },
    ]);
    expect(store.row(fixture.recordId(0))?.values[fixture.textFieldId]).toBe('Renamed');
    expect(listener).toHaveBeenCalled();
    await edit.done;
    await vi.waitFor(() => expect(recordRequests()).toHaveLength(2));
    expect(recordRequests()[1]).toMatchObject({ offset: 0, refresh: true });
    server.remote(fixture.databaseId, [
      { kind: 'record.trash', tableId: fixture.tableId, recordIds: [fixture.recordId(3)] },
    ]);
    await vi.waitFor(() => expect(ids()).toHaveLength(3));
  });

  it('read afresh when the filters narrowing them change', async () => {
    const { store, block, ids, recordRequests, value, fixture } = await setup();
    store.start();
    store.setQuery(PAGE_ID, block, {});
    await vi.waitFor(() => expect(ids()).toHaveLength(4));
    const page = value.pages[0]!;
    const chosen = chosenFor(page, block, { blkStatus001: DONE, blkOther001: 'ignored' });
    expect(chosen).toEqual({ blkStatus001: DONE });
    store.setQuery(PAGE_ID, block, chosen);
    expect(store.getSnapshot().status).toBe('loading');
    await vi.waitFor(() => expect(ids()).toEqual([fixture.recordId(1), fixture.recordId(3)]));
    expect(recordRequests().at(-1)).toMatchObject({ filters: { blkStatus001: DONE }, offset: 0 });
    expect(recordRequests().at(-1)!.snapshot).toBeUndefined();
  });
});
