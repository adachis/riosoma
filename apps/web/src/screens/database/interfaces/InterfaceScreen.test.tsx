import { i18n } from '@lingui/core';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../data/types';
import { closeAll, DONE, everyBlock, OPEN, PAGE_ID, type FixtureIds } from './test-support';
import { block, names, openInterface, pageBlocks, pick, select } from './testing';

const charts = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock('../dashboards/echarts', () => ({
  mountChart: () => ({
    update: (option: Record<string, unknown>) => charts.options.push(option),
    resize: () => undefined,
    dispose: () => undefined,
  }),
}));

const sessions: DatabaseSession[] = [];
const open = (options?: Parameters<typeof openInterface>[1], path?: Parameters<typeof openInterface>[2]) =>
  openInterface(sessions, options, path);
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
  charts.options = [];
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
});

describe('an interface page', () => {
  it.each(['longText', 'json'] as const)('sends the observed %s base from its record block', async (type) => {
    const setup = await open({ blocks: everyBlock });
    const queue = await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await userEvent.click(await within(queue).findByRole('option', { name: /Record 2/ }));
    const recordId = setup.fixture.recordId(1);
    const fieldId = setup.ids.name;
    const base = type === 'json' ? '{"a":1,"b":2}' : 'red green blue';
    await act(async () => {
      await setup.session.run([
        { kind: 'field.convert', fieldId, to: { type, options: {} } },
        {
          kind: 'record.update',
          tableId: setup.ids.tableId,
          records: [{ id: recordId, values: { [fieldId]: base } }],
        },
      ]).done;
    });
    const input = await within(block('Details')).findByRole('textbox', { name: 'Name' });
    await userEvent.clear(input);
    const next = type === 'json' ? '{"a":1,"b":4}' : 'red green BLUE';
    await userEvent.type(input, next.replaceAll('{', '{{'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() =>
      expect(setup.commands()).toContainEqual(
        expect.objectContaining({
          kind: 'record.update',
          records: [{ id: recordId, values: { [fieldId]: next }, baseValues: { [fieldId]: base } }],
        }),
      ),
    );
  });
  it('shows each kind of block with what it reads', async () => {
    const setup = await open({ blocks: everyBlock });
    const queue = await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await waitFor(() => expect(names(queue)).toEqual(['Record 1', 'Record 2', 'Record 3', 'Record 4']));
    expect(within(queue).getByRole('option', { name: /Record 2/ }).textContent).toContain(
      'Number: 1 · Status: Done',
    );
    expect(within(block('Queue')).getByText('4 records')).toBeDefined();
    expect(within(block('Details')).getByText('Pick a record in Queue to see it here.')).toBeDefined();
    await waitFor(() => expect(within(block('Open requests')).getByText('2')).toBeDefined());
    expect(within(block('Open requests')).getByText('2 records')).toBeDefined();
    await waitFor(() => expect(charts.options.length).toBeGreaterThan(0));
    expect(charts.options.at(-1)!.xAxis).toMatchObject({ data: ['Open', 'Done'] });
    expect(screen.getByRole('heading', { level: 3, name: 'Welcome to the desk' })).toBeDefined();
    expect(screen.getByText('anything').tagName).toBe('STRONG');
    expect(select('Status').textContent).toContain('All');
    expect(screen.getByRole('searchbox', { name: 'Find a request' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'New request' })).toBeDefined();
    const help = screen.getByRole('link', { name: /Help/ });
    expect(help.getAttribute('href')).toBe('https://example.com/help');
    expect(help.getAttribute('target')).toBe('_blank');
    // The records block reads through its own route, and the numbers and charts in one request, which
    // records arriving for the list don't repeat.
    expect(setup.recordRequests()[0]).toMatchObject({
      pageId: PAGE_ID,
      blockId: 'blkRecords01',
      offset: 0,
      filters: {},
    });
    const data = setup.server.requests.filter((request) => request.path.endsWith('/data'));
    expect(data).toHaveLength(1);
    expect(data[0]!.options.body).toMatchObject({
      pageId: PAGE_ID,
      blockIds: ['blkCount0001', 'blkChart0001'],
    });
  });

  it('shows the record picked in a records block, where people who can edit change it', async () => {
    const setup = await open({ blocks: everyBlock });
    const queue = await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await userEvent.click(await within(queue).findByRole('option', { name: /Record 2/ }));
    const details = block('Details');
    const name = await within(details).findByRole('textbox', { name: 'Name' });
    expect((name as HTMLInputElement).value).toBe('Record 2');
    expect(setup.router.state.location.search).toEqual({
      block: 'blkRecords01',
      record: setup.fixture.recordId(1),
    });
    expect(
      within(queue)
        .getByRole('option', { name: /Record 2/ })
        .getAttribute('aria-selected'),
    ).toBe('true');
    const amount = within(details).getByRole('textbox', { name: 'Number' });
    await userEvent.clear(amount);
    await userEvent.type(amount, '42');
    await userEvent.tab();
    await waitFor(() =>
      expect(setup.commands()).toContainEqual(
        expect.objectContaining({
          kind: 'record.update',
          tableId: setup.ids.tableId,
          records: [{ id: setup.fixture.recordId(1), values: { [setup.ids.number]: 42 } }],
        }),
      ),
    );
    await waitFor(() =>
      expect(within(queue).getByRole('option', { name: /Record 2/ }).textContent).toContain('Number: 42'),
    );
  });

  it('narrows its records blocks with the page’s filter blocks', async () => {
    const setup = await open({ blocks: everyBlock });
    const queue = await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await waitFor(() => expect(names(queue)).toHaveLength(4));
    await pick('Status', 'Done');
    await waitFor(() =>
      expect(names(within(block('Queue')).getByRole('listbox'))).toEqual(['Record 2', 'Record 4']),
    );
    expect(setup.recordRequests().at(-1)).toMatchObject({ filters: { blkStatus001: DONE } });
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a request' }), '4');
    await waitFor(() => expect(names(within(block('Queue')).getByRole('listbox'))).toEqual(['Record 4']));
    expect(setup.recordRequests().at(-1)).toMatchObject({
      filters: { blkStatus001: DONE, blkSearch001: '4' },
    });
    await pick('Status', 'Open');
    await waitFor(() => expect(within(block('Queue')).getByText('No records to show.')).toBeDefined());
    await pick('Status', 'All');
    await waitFor(() => expect(names(within(block('Queue')).getByRole('listbox'))).toEqual(['Record 4']));
    expect(setup.recordRequests().at(-1)!.filters).toEqual({ blkSearch001: '4' });
    expect(OPEN).not.toBe(DONE);
  });

  it('shows readers the page without ways to change it', async () => {
    await open({ blocks: everyBlock, role: 'reader' });
    expect(screen.queryByRole('button', { name: 'Edit interface' })).toBeNull();
    const queue = await within(block('Queue')).findByRole('listbox', { name: 'Queue' });
    await userEvent.click(await within(queue).findByRole('option', { name: /Record 3/ }));
    const details = block('Details');
    expect(await within(details).findByText('Record 3')).toBeDefined();
    expect(within(details).queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'New request' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('You can’t add records to this table.')).toBeDefined();
    expect(screen.queryByRole('button', { name: /Move or resize/ })).toBeNull();
  });

  it('opens the table’s form from a button and adds the record', async () => {
    const setup = await open({ blocks: everyBlock });
    await userEvent.click(screen.getByRole('button', { name: 'New request' }));
    const dialog = await screen.findByRole('dialog', { name: 'New request' });
    await userEvent.type(await within(dialog).findByRole('textbox', { name: 'Name' }), 'Printer ink');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(setup.commands()).toContainEqual(
        expect.objectContaining({
          kind: 'record.create',
          tableId: setup.ids.tableId,
          formViewId: setup.ids.formViewId,
        }),
      ),
    );
    await waitFor(() => expect(names(within(block('Queue')).getByRole('listbox'))).toContain('Printer ink'));
  });

  it('moves and resizes blocks with the keyboard while editing, saving the layout once', async () => {
    const setup = await open({ blocks: everyBlock });
    await userEvent.click(screen.getByRole('button', { name: 'Edit interface' }));
    const handle = screen.getByRole('button', { name: 'Move or resize Help' });
    act(() => handle.focus());
    await userEvent.keyboard('{ArrowDown}');
    expect(await screen.findByText('Column 10, row 12, 3 wide and 1 tall')).toBeDefined();
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(await screen.findByText('Column 10, row 12, 3 wide and 2 tall')).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move or resize Help' }));
    await userEvent.keyboard('{ArrowUp}');
    expect(await screen.findByText('Column 10, row 11, 3 wide and 2 tall')).toBeDefined();
    // Running into a neighbor trades places with it, so the arrows carry a block past anything.
    await userEvent.keyboard('{ArrowLeft}');
    expect(await screen.findByText('Column 7, row 11, 3 wide and 2 tall')).toBeDefined();
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    const blocks = pageBlocks(setup);
    expect(blocks.find((item) => item.id === 'blkHelp00001')?.place).toEqual({ x: 6, y: 10, w: 3, h: 2 });
    expect(blocks.find((item) => item.id === 'blkForm00001')?.place).toEqual({ x: 9, y: 10, w: 3, h: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('button', { name: /Move or resize/ })).toBeNull();
  });
});

describe('building a page', () => {
  async function add(kind: string, fill: () => Promise<void> = async () => undefined) {
    const buttons = screen.getAllByRole('button', { name: 'Add a block' });
    await userEvent.click(buttons[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add a block' });
    await pick('Type', kind);
    await fill();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save block' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  it('adds a block of each kind from the editor, and each one saves with the page', async () => {
    const setup = await open();
    expect(screen.getByText(/^This page is empty\./)).toBeDefined();
    await add('Records');
    expect(await within(block('Table')).findByRole('listbox', { name: 'Table' })).toBeDefined();
    await add('Record details', async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
      await userEvent.click(screen.getByRole('menuitem', { name: /^Number(?: |$)/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Add a field' }));
      await userEvent.click(screen.getByRole('menuitem', { name: /^Name(?: |$)/ }));
      await userEvent.click(screen.getByRole('button', { name: 'Move Name up' }));
    });
    await add('Number');
    await add('Chart');
    await add('Text', async () => {
      await userEvent.click(screen.getByRole('radio', { name: 'Heading' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Text' }), 'Today');
    });
    await add('Filter', async () => {
      await pick('Field', 'Status');
    });
    await add('Button', async () => {
      await userEvent.type(screen.getByRole('textbox', { name: 'Label' }), 'Ask');
    });
    await waitFor(() => expect(pageBlocks(setup)).toHaveLength(7));
    const blocks = pageBlocks(setup);
    expect(blocks.map((item) => item.kind)).toEqual([
      'records',
      'record',
      'number',
      'chart',
      'text',
      'filter',
      'button',
    ]);
    const ids: FixtureIds = setup.ids;
    expect(blocks[0]).toMatchObject({
      source: { tableId: ids.tableId, viewId: ids.viewId },
      display: 'list',
    });
    expect(blocks[1]).toMatchObject({ recordsBlockId: blocks[0]!.id, fieldIds: [ids.name, ids.number] });
    expect(blocks[3]).toMatchObject({ groupBy: { fieldId: ids.status } });
    expect(blocks[4]).toMatchObject({ style: 'heading', text: 'Today' });
    expect(blocks[5]).toMatchObject({
      control: 'choice',
      tableId: ids.tableId,
      fieldId: ids.status,
      blockIds: [],
    });
    expect(blocks[6]).toMatchObject({
      label: 'Ask',
      action: { kind: 'form', tableId: ids.tableId, viewId: ids.formViewId },
    });
    // No two blocks share a cell.
    const cells = new Set<string>();
    for (const item of blocks)
      for (let x = item.place.x; x < item.place.x + item.place.w; x++)
        for (let y = item.place.y; y < item.place.y + item.place.h; y++) {
          expect(cells.has(`${x}:${y}`)).toBe(false);
          cells.add(`${x}:${y}`);
        }
    expect(await screen.findByRole('heading', { level: 3, name: 'Today' })).toBeDefined();
  });
});
