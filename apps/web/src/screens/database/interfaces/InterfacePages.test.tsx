import { i18n } from '@lingui/core';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InterfacePages, LIMITS, type Block, type InterfacePage } from '@riosoma/contracts';
import type { DatabaseSession } from '../../../data/types';
import { closeAll, everyBlock, PAGE_ID, type FixtureIds } from './test-support';
import { block, openInterface, pageBlocks } from './testing';

vi.mock('../dashboards/echarts', () => ({
  mountChart: () => ({ update: () => undefined, resize: () => undefined, dispose: () => undefined }),
}));

const sessions: DatabaseSession[] = [];
const open = (options?: Parameters<typeof openInterface>[1], path?: Parameters<typeof openInterface>[2]) =>
  openInterface(sessions, options, path);
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
});

const later = (): InterfacePage[] => [{ id: 'pageLater01', name: 'Later', blocks: [] }];
const tableBlock = (ids: FixtureIds) => [
  {
    id: 'blkRecords01',
    kind: 'records' as const,
    title: 'Queue',
    place: { x: 0, y: 0, w: 8, h: 6 },
    source: { tableId: ids.tableId, viewId: ids.viewId, filter: null },
    fieldIds: [ids.number],
    display: 'table' as const,
    showFieldNames: true,
  },
  {
    id: 'blkRecord001',
    kind: 'record' as const,
    title: 'Details',
    place: { x: 8, y: 0, w: 4, h: 6 },
    recordsBlockId: 'blkRecords01',
    fieldIds: [],
  },
];

describe('interface pages', () => {
  it.each(['界'.repeat(LIMITS.nameLength), `${'界'.repeat(LIMITS.nameLength - 2)}🚢`])(
    'duplicates a maximum-length page name within the saved name limit: %s',
    async (name) => {
      const setup = await open({ pages: () => [{ id: 'pageLong01', name, blocks: [] }] });
      await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
      await userEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate page' }));
      await waitFor(() => expect(setup.updates()).toHaveLength(1));
      const pages = setup.updates()[0]!.pages!;
      expect(InterfacePages.safeParse(pages).success).toBe(true);
      expect(pages[2]!.id).not.toBe('pageLong01');
      expect(pages[2]!.name).toContain('界');
      expect(pages[2]!.name).toMatch(/ copy$/);
      expect(pages[2]!.name).not.toMatch(/\p{Surrogate}/u);
    },
  );

  it('are added, renamed, moved, and deleted while editing, and each change saves the pages', async () => {
    const setup = await open({ blocks: everyBlock, pages: later });
    const tabs = () => screen.getByRole('navigation', { name: 'Pages' });
    const titles = () =>
      within(tabs())
        .getAllByRole('link')
        .map((link) => link.textContent);
    expect(titles()).toEqual(['Requests', 'Later']);
    expect(within(tabs()).queryByRole('button', { name: 'More for Later' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    await userEvent.click(within(tabs()).getByRole('button', { name: 'Add a page' }));
    await waitFor(() => expect(titles()).toEqual(['Requests', 'Later', 'Page 3']));
    expect(await screen.findByText(/^This page is empty\./)).toBeDefined();
    const added = setup.session.getSchema().interfaceById.get(setup.value.id)!.pages[2]!;
    expect(setup.router.state.location.pathname).toBe(
      `/${setup.fixture.databaseId}/interfaces/${setup.value.id}/${added.id}`,
    );
    await userEvent.click(within(tabs()).getByRole('button', { name: 'More for Page 3' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = await screen.findByRole('textbox', { name: 'Rename' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Archive{Enter}');
    await waitFor(() => expect(titles()).toEqual(['Requests', 'Later', 'Archive']));
    within(tabs()).getByRole('link', { name: 'Archive' }).focus();
    await userEvent.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    await waitFor(() => expect(titles()).toEqual(['Requests', 'Archive', 'Later']));
    await userEvent.click(within(tabs()).getByRole('button', { name: 'More for Later' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete page' }));
    await waitFor(() => expect(titles()).toEqual(['Requests', 'Archive']));
    await waitFor(() =>
      expect(
        setup
          .updates()
          .at(-1)
          ?.pages?.map((page) => page.name),
      ).toEqual(['Requests', 'Archive']),
    );
    await act(async () => {
      await setup.session.undo();
    });
    await waitFor(() => expect(titles()).toEqual(['Requests', 'Archive', 'Later']));
  });

  it('duplicate with their blocks still following each other', async () => {
    const setup = await open({ blocks: everyBlock });
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    await userEvent.click(screen.getByRole('button', { name: 'More for Requests' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Duplicate page' }));
    await waitFor(() => expect(setup.updates().at(-1)?.pages).toHaveLength(2));
    const [original, copy] = setup.updates().at(-1)!.pages!;
    expect(copy!.name).toBe('Requests copy');
    expect(copy!.id).not.toBe(original!.id);
    const records = copy!.blocks.find((item) => item.kind === 'records')!;
    const record = copy!.blocks.find((item) => item.kind === 'record');
    expect(records.id).not.toBe('blkRecords01');
    expect(record).toMatchObject({ recordsBlockId: records.id });
    expect(await screen.findByRole('article', { name: 'Queue' })).toBeDefined();
  });
});

const notes = (): Block[] => [
  {
    id: 'blkAlpha001',
    kind: 'text',
    title: 'Alpha',
    place: { x: 0, y: 0, w: 3, h: 2 },
    style: 'paragraph',
    text: 'First',
  },
  {
    id: 'blkBeta0001',
    kind: 'text',
    title: 'Beta',
    place: { x: 3, y: 0, w: 3, h: 2 },
    style: 'paragraph',
    text: 'Second',
  },
];

const place = (name: string) => {
  const style = screen.getByRole('article', { name }).getAttribute('style') ?? '';
  const read = (key: string) => Number(new RegExp(`--rio-interface-${key}: (\\d+)`).exec(style)?.[1]);
  return { x: read('x') - 1, y: read('y') - 1, w: read('w'), h: read('h') };
};

describe('laying out a page', () => {
  it('drags a block to move it, saves once on release, and cancels a resize with Escape', async () => {
    const setup = await open({ blocks: notes });
    fireEvent.pointerDown(screen.getByRole('article', { name: 'Alpha' }), { button: 0, pointerId: 1 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 400, clientY: 400 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(place('Alpha')).toEqual({ x: 0, y: 0, w: 3, h: 2 });
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    const alpha = screen.getByRole('article', { name: 'Alpha' });
    vi.spyOn(alpha.parentElement!, 'clientWidth', 'get').mockReturnValue(1200);
    fireEvent.pointerDown(alpha.querySelector('.rio-interface-block__shield')!, {
      button: 0,
      pointerId: 7,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 110, clientY: 90 });
    expect(place('Beta')).toEqual({ x: 3, y: 0, w: 3, h: 2 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 610, clientY: 170 });
    expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 3, h: 2 });
    expect(setup.updates()).toHaveLength(0);
    fireEvent.pointerUp(window, { pointerId: 7 });
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(pageBlocks(setup).find((item) => item.id === 'blkAlpha001')?.place).toEqual({
      x: 6,
      y: 2,
      w: 3,
      h: 2,
    });
    fireEvent.pointerDown(
      screen.getByRole('article', { name: 'Alpha' }).querySelector('.rio-interface-block__resize')!,
      {
        button: 0,
        pointerId: 8,
        clientX: 0,
        clientY: 0,
      },
    );
    fireEvent.pointerMove(window, { pointerId: 8, clientX: 200, clientY: 80 });
    expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 5, h: 3 });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(place('Alpha')).toEqual({ x: 6, y: 2, w: 3, h: 2 });
    fireEvent.pointerUp(window, { pointerId: 8 });
    expect(setup.updates()).toHaveLength(1);
  });
});

describe('records blocks', () => {
  it('show a table that reads more as the person asks, and pick a record with a row', async () => {
    const setup = await open({ blocks: tableBlock, count: 60 });
    const grid = await within(block('Queue')).findByRole('grid', { name: 'Queue' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(51));
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Name', 'Number']);
    expect(within(block('Queue')).getByText('60 records')).toBeDefined();
    await userEvent.click(within(block('Queue')).getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(61));
    expect(within(block('Queue')).queryByRole('button', { name: 'Show more' })).toBeNull();
    const [first, second] = setup.recordRequests();
    expect(first).toMatchObject({ offset: 0, limit: 50 });
    expect(second).toMatchObject({ offset: 50, limit: 50, snapshot: expect.any(String) });
    await userEvent.click(within(grid).getByRole('rowheader', { name: 'Record 3' }));
    const details = block('Details');
    expect(((await within(details).findByRole('textbox', { name: 'Name' })) as HTMLInputElement).value).toBe(
      'Record 3',
    );
    // With no fields chosen, the record shows every field in the table's order.
    expect(within(details).getByText('Status')).toBeDefined();
  });

  it('say when their view is gone, and leave the blocks that followed a deleted one waiting', async () => {
    const setup = await open({ blocks: tableBlock });
    await within(block('Queue')).findByRole('grid', { name: 'Queue' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    await userEvent.click(screen.getByRole('button', { name: 'More for Queue' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Queue' })).toBeNull());
    expect(
      within(block('Details')).getByText(/^This block shows the record picked in a records block\./),
    ).toBeDefined();
    await waitFor(() => expect(pageBlocks(setup)).toHaveLength(1));
    expect(pageBlocks(setup)[0]).toMatchObject({ kind: 'record', recordsBlockId: null, fieldIds: [] });
    await act(async () => {
      await setup.session.undo();
    });
    expect(await screen.findByRole('article', { name: 'Queue' })).toBeDefined();
    setup.server.remote(setup.fixture.databaseId, [{ kind: 'view.trash', viewId: setup.ids.viewId }]);
    expect(
      await within(block('Queue')).findByText('This block’s data isn’t available to you, or it was deleted.'),
    ).toBeDefined();
  });

  it('change how they show records from the block editor', async () => {
    const setup = await open({ blocks: everyBlock });
    await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    await userEvent.click(screen.getByRole('button', { name: 'More for Queue' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit block' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Table' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove Status' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save block' }));
    await waitFor(() =>
      expect(pageBlocks(setup).find((item) => item.id === 'blkRecords01')).toMatchObject({
        display: 'table',
      }),
    );
    const saved = pageBlocks(setup).find((item) => item.id === 'blkRecords01');
    expect(saved).toMatchObject({ fieldIds: [setup.ids.number], place: { x: 0, y: 0, w: 6, h: 5 } });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(await within(block('Queue')).findByRole('grid', { name: 'Queue' })).toBeDefined();
    expect(PAGE_ID).toBe('pageMain01');
  });
});
