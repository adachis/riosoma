import { i18n } from '@lingui/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSchema } from '../../../data/hooks';
import type { DatabaseSession } from '../../../data/types';
import { renderSharing } from '../share/testing';
import { clearRecent, rememberPlace } from '../../../palette/recent';
import { DashboardScreen } from './DashboardScreen';
import { closeAll, dashboardFixture, everyKind } from './test-support';

vi.mock('./echarts', () => ({
  mountChart: () => ({ update: () => undefined, resize: () => undefined, dispose: () => undefined }),
}));

const sessions: DatabaseSession[] = [];
beforeEach(() => {
  i18n.load('en-US', {});
  i18n.activate('en-US');
});
afterEach(() => {
  cleanup();
  closeAll(sessions);
  clearRecent();
});

function Screen({ session, dashboardId }: { session: DatabaseSession; dashboardId: string }) {
  const schema = useSchema(session);
  const dashboard = schema?.dashboardById.get(dashboardId);
  return schema && dashboard ? (
    <DashboardScreen session={session} schema={schema} dashboard={dashboard} />
  ) : null;
}

async function editor(options: Parameters<typeof dashboardFixture>[0] = {}) {
  const setup = await dashboardFixture(options);
  sessions.push(setup.session);
  renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
  await userEvent.click(screen.getAllByRole('button', { name: 'Add a tile' })[0]!);
  return { ...setup, dialog: screen.getByRole('dialog', { name: 'Add a tile' }) };
}

const select = (label: string) =>
  screen.getByRole('button', { name: (name) => name === label || name.endsWith(` ${label}`) });
async function pick(label: string, option: string) {
  await userEvent.click(select(label));
  await userEvent.click(
    screen.getByRole('option', {
      name: (accessibleName) => accessibleName === option || accessibleName.startsWith(`${option} `),
    }),
  );
}
/** The options a select offers, by their labels */
async function offered(label: string): Promise<string[]> {
  await userEvent.click(select(label));
  const names = screen
    .getAllByRole('option')
    .map((option) => option.querySelector('.rio-listbox-item__label')?.textContent ?? option.textContent);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
  return names;
}

describe('the tile editor', () => {
  it('adds a number, offering only the values that fit the chosen field', async () => {
    const setup = await editor();
    expect(within(setup.dialog).getByRole('radio', { name: 'Number' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(await offered('Field')).toEqual(['Just count records', 'Name', 'Number', 'Status', 'Due']);
    expect(await offered('Value')).toEqual(['Count of records']);
    await pick('Field', 'Number');
    expect(await offered('Value')).toEqual([
      'Count of unique values',
      'Sum',
      'Average',
      'Smallest',
      'Largest',
    ]);
    expect(select('Value').textContent).toContain('Sum');
    await pick('Field', 'Name');
    expect(await offered('Value')).toEqual(['Count of unique values']);
    await pick('Field', 'Number');
    await pick('Value', 'Average');
    await userEvent.type(within(setup.dialog).getByRole('textbox', { name: 'Title' }), 'Mean');
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Save tile' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles).toEqual([
      expect.objectContaining({
        kind: 'number',
        title: 'Mean',
        source: { tableId: setup.ids.tableId, viewId: null, filter: null },
        value: { fn: 'average', fieldId: setup.ids.number },
        place: { x: 0, y: 0, w: 3, h: 2 },
      }),
    ]);
    expect(await within(screen.getByRole('article', { name: 'Mean' })).findByText('1.5')).toBeDefined();
  });

  it('adds a chart grouped by date periods and split into stacked series', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Chart' }));
    expect(select('Group by').textContent).toContain('Status');
    expect(screen.queryByRole('button', { name: /Group dates by$/ })).toBeNull();
    await pick('Group by', 'Due');
    expect(await offered('Group dates by')).toEqual(['Day', 'Week', 'Month', 'Quarter', 'Year']);
    expect(select('Group dates by').textContent).toContain('Month');
    expect(await offered('Split by')).toEqual(['Don’t split', 'Name', 'Number', 'Status']);
    expect(screen.queryByRole('switch', { name: 'Stack the series' })).toBeNull();
    await pick('Split by', 'Status');
    await userEvent.click(screen.getByRole('switch', { name: 'Stack the series' }));
    expect(await offered('Chart type')).toEqual(['Bar', 'Column', 'Line', 'Area', 'Pie', 'Donut', 'Scatter']);
    await pick('Chart type', 'Pie');
    expect(screen.queryByRole('button', { name: /Split by$/ })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    await pick('Chart type', 'Area');
    expect(await offered('Sort')).toEqual(['By category', 'Largest first', 'Smallest first']);
    await pick('Sort', 'Largest first');
    const limit = within(setup.dialog).getByRole('textbox', { name: 'Show at most' });
    await userEvent.clear(limit);
    await userEvent.type(limit, '8');
    await userEvent.tab();
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles[0]).toMatchObject({
      kind: 'chart',
      title: '',
      chart: 'area',
      groupBy: { fieldId: setup.ids.due, dateBucket: 'month' },
      value: { fn: 'count', fieldId: null },
      seriesBy: setup.ids.status,
      sort: 'valueDescending',
      limit: 8,
      stacked: true,
      place: { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(screen.getByRole('article', { name: 'Chart' })).toBeDefined();
  });

  it('adds a records tile from a view with its own filter and chosen fields', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Records' }));
    expect(await offered('View')).toEqual(['All records', 'Grid']);
    await pick('View', 'Grid');
    const filter = within(setup.dialog).getByRole('group', { name: 'Filter' });
    await userEvent.click(within(filter).getByRole('button', { name: 'Add condition' }));
    expect(within(filter).getAllByRole('group', { name: 'Condition' })).toHaveLength(1);
    const fields = within(setup.dialog).getByRole('group', { name: 'Fields to show' });
    expect(
      within(fields)
        .getAllByRole('checkbox')
        .map((box) => box.closest('label')?.textContent),
    ).toEqual(['Number', 'Status', 'Due']);
    await userEvent.click(within(fields).getByRole('checkbox', { name: 'Status' }));
    const limit = within(setup.dialog).getByRole('textbox', { name: 'Show at most' });
    await userEvent.clear(limit);
    await userEvent.type(limit, '5');
    await userEvent.tab();
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    const saved = setup.updates()[0]!.config!.tiles[0]!;
    expect(saved).toMatchObject({
      kind: 'records',
      source: { tableId: setup.ids.tableId, viewId: setup.fixture.viewId },
      fieldIds: [setup.ids.status],
      limit: 5,
      place: { x: 0, y: 0, w: 4, h: 4 },
    });
    expect(saved.kind === 'records' && saved.source.filter?.conditions).toHaveLength(1);
  });

  it('configures pivot rows, columns, summaries, date buckets, and totals', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Pivot' }));
    expect(select('Row field 1').textContent).toContain('Status');
    await pick('Columns', 'Due');
    expect(select('Dates by').textContent).toContain('Month');
    await pick('Dates by', 'Quarter');
    await pick('Value 1', 'Average');
    expect(select('Field for value 1').textContent).toContain('Number');
    await userEvent.click(screen.getByRole('switch', { name: 'Total for each row' }));
    await pick('View', 'Grid');
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles[0]).toMatchObject({
      kind: 'pivot',
      source: { tableId: setup.ids.tableId, viewId: setup.fixture.viewId, filter: null },
      pivot: {
        rows: [{ fieldId: setup.ids.status, dateBucket: null }],
        column: { fieldId: setup.ids.due, dateBucket: 'quarter' },
        values: [{ fn: 'average', fieldId: setup.ids.number }],
        rowTotals: false,
        columnTotals: true,
      },
      place: { x: 0, y: 0, w: 6, h: 4 },
    });
    expect(await screen.findByRole('table', { name: 'Pivot' })).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'More for Pivot' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Edit(?: |$)/ }));
    expect(select('Dates by').textContent).toContain('Quarter');
    expect(select('Value 1').textContent).toContain('Average');
    await userEvent.click(screen.getByRole('button', { name: 'Add a row field' }));
    expect(select('Row field 2')).toBeDefined();
  });

  it('adds a note, and leaves everything as it was when canceled', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Note' }));
    expect(screen.queryByRole('button', { name: /Table$/ })).toBeNull();
    await userEvent.type(within(setup.dialog).getByRole('textbox', { name: 'Note' }), 'Hello **team**');
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(setup.updates()).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Add a tile' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a tile' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Note' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Note' }), 'Hello **team**');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles[0]).toMatchObject({
      kind: 'text',
      text: 'Hello **team**',
      place: { x: 0, y: 0, w: 4, h: 2 },
    });
    expect(screen.getByRole('article', { name: 'Note' }).querySelector('strong')?.textContent).toBe('team');
  });

  it('uses named icon actions to add and remove pivot rows and values', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Pivot' }));
    for (const name of ['Add a row field', 'Add a value', 'Remove Status', 'Remove value 1']) {
      const button = within(setup.dialog).getByRole('button', { name });
      expect(button.getAttribute('data-icon-only')).toBe('true');
      expect(button.getAttribute('data-tooltip')).toBe(name);
      expect(button.textContent).toBe('');
    }
    await userEvent.click(screen.getByRole('button', { name: 'Add a row field' }));
    expect(select('Row field 2')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Status' }));
    expect(screen.queryByRole('button', { name: /Row field 2$/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add a value' }));
    expect(select('Value 2')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Remove value 1' }));
    expect(screen.queryByRole('button', { name: /Value 2$/ })).toBeNull();
  });

  it('puts new tiles in the first free space and keeps an edited tile where it is', async () => {
    const setup = await editor({ tiles: everyKind });
    await userEvent.click(within(setup.dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(1));
    expect(setup.updates()[0]!.config!.tiles.at(-1)).toMatchObject({
      kind: 'number',
      place: { x: 0, y: 6, w: 3, h: 2 },
    });
    await userEvent.click(screen.getByRole('button', { name: 'More for By status' }));
    await userEvent.click(screen.getByRole('menuitem', { name: /^Edit(?: |$)/ }));
    const dialog = screen.getByRole('dialog', { name: 'Edit tile' });
    expect(within(dialog).getByRole('radio', { name: 'Chart' }).getAttribute('aria-checked')).toBe('true');
    expect(select('Group by').textContent).toContain('Status');
    await pick('Chart type', 'Donut');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save tile' }));
    await waitFor(() => expect(setup.updates()).toHaveLength(2));
    expect(setup.updates()[1]!.config!.tiles.find((tile) => tile.id === 'tileChart01')).toMatchObject({
      chart: 'donut',
      place: { x: 6, y: 0, w: 6, h: 4 },
    });
  });

  it('defaults grouping to a sensible field, never the primary', async () => {
    const setup = await editor();
    await userEvent.click(within(setup.dialog).getByRole('radio', { name: 'Chart' }));
    // Status is a single select; the primary Name field names records and never groups.
    expect(select('Group by').textContent).toContain('Status');
    expect(select('Group by').textContent).not.toContain('Name');
  });

  it('starts a new tile on the view the person came from', async () => {
    const setup = await dashboardFixture();
    sessions.push(setup.session);
    rememberPlace({ id: setup.fixture.viewId, kind: 'views', label: 'Grid', path: '/came-from' });
    renderSharing(<Screen session={setup.session} dashboardId={setup.dashboard.id} />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Add a tile' })[0]!);
    expect(select('View').textContent).toContain('Grid');
  });

  it('carries over a chart view’s grouping and values, not only its filter', async () => {
    const setup = await editor({ chartView: true });
    await pick('View', 'Revenue chart');
    expect(within(setup.dialog).getByRole('radio', { name: 'Chart' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(select('Group by').textContent).toContain('Due');
    expect(select('Group dates by').textContent).toContain('Quarter');
    expect(select('Field').textContent).toContain('Number');
    expect(select('Value').textContent).toContain('Sum');
    expect(select('Split by').textContent).toContain('Status');
  });
});
