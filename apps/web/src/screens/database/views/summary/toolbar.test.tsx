import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DatabaseSession } from '../../../../data/types';
import { ViewToolbar } from '../../view/ViewToolbar';
import { ToolbarSettings } from '../../view/ToolbarSettings';
import { ChartSettings } from '../chart/ChartSettings';
import { PivotSettings } from '../pivot/PivotSettings';
import { KanbanSettings } from '../kanban/KanbanSettings';
import { TimelineSettings } from '../timeline/TimelineSettings';
import { GanttSettings } from '../gantt/GanttSettings';
import type { ViewComponentProps } from '../types';
import { closeAll, Harness, mount, summaryFixture } from './test-support';

const sessions: DatabaseSession[] = [];
let resize = (_width: number) => {};

beforeEach(() => {
  let available = 2000;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains('rio-responsive-toolbar')
      ? available
      : this.dataset.fit === 'full'
        ? 160
        : this.dataset.fit === 'short'
          ? 80
          : 40;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) };
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) {
        if (element.classList.contains('rio-responsive-toolbar'))
          resize = (width) => {
            available = width;
            act(() =>
              this.callback(
                [{ contentRect: { width } } as ResizeObserverEntry],
                this as unknown as ResizeObserver,
              ),
            );
          };
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  cleanup();
  closeAll(sessions);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Toolbar(props: ViewComponentProps) {
  return (
    <ViewToolbar
      usesToolbar={false}
      config={props.view.config}
      fields={props.fields}
      primaryFieldId={props.table.primaryFieldId}
      onConfigChange={vi.fn()}
    />
  );
}

async function open(
  type: 'chart' | 'pivot',
  options: Parameters<typeof summaryFixture>[1] = {},
  Settings = type === 'chart' ? ChartSettings : PivotSettings,
) {
  const setup = await summaryFixture(type, options);
  sessions.push(setup.session);
  mount(
    <ToolbarSettings>
      <Harness session={setup.session} viewId={setup.ids.viewId} View={Toolbar} Settings={Settings} />
    </ToolbarSettings>,
  );
  return setup;
}

const toolbar = () => screen.getByRole('toolbar');
const buttons = () => within(toolbar()).getAllByRole('button');
const labels = () => buttons().map((button) => button.textContent);

it.each(['chart', 'pivot'] as const)('distinguishes every %s setting by its icon', async (type) => {
  await open(type, {
    config: (ids) => ({
      chart: { groupBy: { fieldId: ids.due }, value: { fn: 'sum', fieldId: ids.number } },
      pivot: { rows: [{ fieldId: ids.status }], column: { fieldId: ids.due } },
    }),
  });
  const icons = buttons().map((button) => button.querySelector('svg')?.innerHTML);
  expect(icons.every(Boolean)).toBe(true);
  expect(new Set(icons).size).toBe(icons.length);
});

it.each([
  ['kanban', KanbanSettings],
  ['timeline', TimelineSettings],
  ['gantt', GanttSettings],
] as const)(
  'distinguishes the %s field controls and actions from its settings panel',
  async (_type, Settings) => {
    await open(
      'chart',
      {
        config: (ids) => ({
          timeline: { startFieldId: ids.due },
          gantt: { startFieldId: ids.due },
          kanban: { stackFieldId: ids.status },
        }),
      },
      Settings,
    );
    const icons = buttons().map((button) => button.querySelector('svg')?.innerHTML);
    expect(new Set(icons).size).toBe(icons.length);
  },
);

it('places a newly needed chart field beside Value and before Chart options', async () => {
  await open('chart');
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Value: Count of records' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Value' })).getByRole('button', { name: /Value/ }),
  );
  await userEvent.click(screen.getByRole('option', { name: /^Sum(?: |$)/ }));
  await userEvent.keyboard('{Escape}');
  expect(labels().slice(-3)).toEqual(['Value: Sum', 'Of: Number', 'Chart options']);
});

it('places a newly needed pivot date picker beside Columns and before Values', async () => {
  await open('pivot');
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Columns' }));
  await userEvent.click(
    within(screen.getByRole('dialog', { name: 'Columns' })).getByRole('button', { name: /Columns/ }),
  );
  await userEvent.click(screen.getByRole('option', { name: /^Due(?: |$)/ }));
  await userEvent.keyboard('{Escape}');
  expect(labels().slice(2, 5)).toEqual(['Columns: Due', 'Dates by: Month', 'Values']);
});

it.each(['chart', 'pivot'] as const)(
  'keeps the active %s filter count when its label shortens',
  async (type) => {
    await open(type, {
      config: (ids) => ({
        filter: {
          conjunction: 'and',
          conditions: [{ id: 'one', fieldId: ids.name, operator: 'contains', value: 'Record' }],
        },
      }),
    });
    resize(buttons().length * 40 + 50);
    const filter = within(toolbar()).getByRole('button', { name: '1 filter' });
    expect(filter.getAttribute('data-fit')).toBe('short');
    await userEvent.tab();
    expect(document.activeElement).toBe(filter);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Filtered by Name');
  },
);

it('names chart options separately from toolbar overflow', async () => {
  await open('chart');
  resize(160);
  expect(within(toolbar()).getAllByRole('button', { name: 'More' })).toHaveLength(1);
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'More' }));
  expect(screen.getByRole('menuitem', { name: /^Chart options(?: |$)/ })).toBeDefined();
});

it('names the pivot table download separately from the records download', async () => {
  await open('pivot');
  expect(within(toolbar()).getByRole('button', { name: 'Download table as CSV' })).toBeDefined();
});
