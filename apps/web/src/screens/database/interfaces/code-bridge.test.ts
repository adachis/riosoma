import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../data/types';
import { applyCodeChange, codeRequest, isCodeCall } from './code-bridge';
import type { BlockContext } from './context';
import { closeAll, everyBlock, interfaceFixture } from './test-support';

const sessions: DatabaseSession[] = [];
afterEach(() => {
  closeAll(sessions);
  vi.restoreAllMocks();
});
async function fixture(role: 'owner' | 'reader' | 'editor' = 'owner') {
  const setup = await interfaceFixture({ blocks: everyBlock, role });
  sessions.push(setup.session);
  const context: BlockContext = {
    session: setup.session,
    schema: setup.session.getSchema(),
    interfaceId: setup.value.id,
    page: setup.value.pages[0]!,
    canEditRecords: role !== 'reader',
    format: { locale: 'en-US', timeZone: 'UTC', collaborators: setup.session.getSchema().collaborators },
    filters: { blkSearch001: 'Record 1' },
    selected: { blkRecords01: setup.fixture.recordId(0) },
    onFilter: vi.fn(),
    onSelect: vi.fn(),
    onMissing: vi.fn(),
    summaries: new Map(),
    onRetry: vi.fn(),
  };
  const change = {
    method: 'change' as const,
    blockId: 'blkRecords01',
    recordId: setup.fixture.recordId(0),
    values: { [setup.ids.number]: 7 },
  };
  return { ...setup, context, change };
}

describe('custom code bridge', () => {
  it('reads through the reader session with page filters and opens a readable record', async () => {
    const setup = await fixture('reader');
    const propose = vi.fn();
    const rows = await codeRequest(setup.context, { method: 'records', blockId: 'blkRecords01' }, propose);
    expect(rows).toMatchObject({ tableId: setup.ids.tableId, total: 1 });
    expect(setup.recordRequests()).toEqual([
      expect.objectContaining({
        filters: setup.context.filters,
        pageId: setup.context.page.id,
        blockId: 'blkRecords01',
        limit: 100,
      }),
    ]);
    expect(
      await codeRequest(setup.context, { method: 'selected', blockId: 'blkRecords01' }, propose),
    ).toMatchObject({ id: setup.change.recordId });
    await codeRequest(setup.context, { ...setup.change, method: 'open' }, propose);
    expect(setup.context.onSelect).toHaveBeenCalledWith('blkRecords01', setup.change.recordId, {
      open: true,
    });
    expect(propose).not.toHaveBeenCalled();
  });

  it('refuses arbitrary commands, blocks outside the page, readers, and preview mutations', async () => {
    const setup = await fixture('reader');
    const propose = vi.fn();
    for (const request of [
      setup.change,
      { ...setup.change, blockId: 'missing01' },
      { method: 'interface.update' },
      { method: 'records', blockId: 'blkRecords01', offset: -1 },
    ]) {
      await expect(codeRequest(setup.context, request, propose)).rejects.toBeDefined();
    }
    await expect(
      codeRequest(setup.context, { ...setup.change, method: 'open' }, propose, true),
    ).rejects.toMatchObject({ messageKey: 'errors.forbidden' });
    expect(propose).not.toHaveBeenCalled();
    expect(setup.commands()).toEqual([]);
  });

  it('proposes first, applies one ordinary command after approval, and undoes it', async () => {
    const setup = await fixture('editor');
    const propose = vi.fn(async () => null);
    await codeRequest(setup.context, setup.change, propose);
    expect(propose).toHaveBeenCalledWith(setup.change);
    expect(setup.commands()).toEqual([]);
    await applyCodeChange(setup.context, setup.change);
    expect(setup.commands()).toEqual([
      expect.objectContaining({
        kind: 'record.update',
        tableId: setup.ids.tableId,
        records: [{ id: setup.change.recordId, values: setup.change.values }],
      }),
    ]);
    expect(
      (await setup.session.getRecord(setup.ids.tableId, setup.change.recordId))?.values[setup.ids.number],
    ).toBe(7);
    await setup.session.undo();
    expect(
      (await setup.session.getRecord(setup.ids.tableId, setup.change.recordId))?.values[setup.ids.number],
    ).toBe(0);
  });

  it('rechecks the current role and reports command bus rejection', async () => {
    const setup = await fixture();
    vi.spyOn(setup.session, 'role').mockReturnValue('reader');
    await expect(applyCodeChange(setup.context, setup.change)).rejects.toMatchObject({
      messageKey: 'errors.forbidden',
    });
    expect(setup.commands()).toEqual([]);
    vi.spyOn(setup.session, 'role').mockReturnValue('editor');
    vi.spyOn(setup.session, 'run').mockReturnValue({
      groupId: '',
      done: Promise.resolve({ applied: 0, rejected: 1 }),
    });
    await expect(applyCodeChange(setup.context, setup.change)).rejects.toMatchObject({
      messageKey: 'errors.forbidden',
    });
  });

  it('requires the opaque origin, exact frame, channel, and valid request ID', () => {
    const source = window;
    const channel = crypto.randomUUID();
    const data = { type: 'interface-code-call', channel, id: 1 };
    const event = (patch: MessageEventInit = {}) =>
      new MessageEvent('message', { source, origin: 'null', data, ...patch });
    expect(isCodeCall(event(), source, channel)).toBe(true);
    expect(isCodeCall(event({ source: null }), source, channel)).toBe(false);
    expect(isCodeCall(event({ origin: location.origin }), source, channel)).toBe(false);
    expect(isCodeCall(event(), source, crypto.randomUUID())).toBe(false);
    expect(isCodeCall(event({ data: { ...data, id: 1.5 } }), source, channel)).toBe(false);
  });
});
