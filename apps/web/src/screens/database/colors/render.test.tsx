import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ColorConfig,
  encodeWhere,
  FieldMeta,
  GridConfig,
  type ColorRule,
  type FieldRange,
  type RowData,
  type ViewMeta,
} from '@riosoma/contracts';
import type { GridApi } from '../../../../../../packages/grid-core/src/types';
import { openDatabase } from '../../../data';
import { FakeServer } from '../../../data/testing';
import type { DatabaseSession } from '../../../data/types';
import { createCellRenderer } from '../../../grid/cells/renderers';
import { createGridController } from '../../../grid/view/controller';
import { i18n as appI18n } from '../../../i18n';
import { RecordCard } from '../record/RecordCard';
import { CardValue } from '../views/CardValue';
import { GalleryCard } from '../views/gallery/GalleryCard';
import { createViewColors, type ViewColors } from './paint';
import { useViewColors } from './useViewColors';

const dispose: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const close of dispose.splice(0)) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const field = (id: string, name: string, type: string, options: object = {}): FieldMeta =>
  FieldMeta.parse({
    id,
    tableId: 'tbl00000000000001',
    name,
    description: '',
    position: 0,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    type,
    options,
  });

const done = 'cho00000000000001';
const title = field('fld00000000000001', 'Title', 'text');
const status = field('fld00000000000002', 'Status', 'singleSelect', {
  choices: [{ id: done, name: 'Done', color: 'green' }],
});
const amount = field('fld00000000000003', 'Amount', 'number');
const fields = [title, status, amount];
const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };

const row = (values: RowData['values']): RowData => ({
  id: 'rec00000000000001',
  values,
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: null,
  updatedBy: null,
});

const config = ColorConfig.parse({
  colorRules: [
    {
      id: 'finished',
      name: 'Finished',
      target: 'record',
      condition: { id: 'c1', fieldId: status.id, operator: 'is', value: done },
      color: 'green',
    },
    {
      id: 'large',
      name: 'Large',
      target: 'cell',
      condition: { id: 'c2', fieldId: amount.id, operator: 'gt', value: 100 },
      color: 'red',
    },
  ],
  dataBars: [{ fieldId: amount.id, color: 'teal', showValue: false }],
});

function viewColors(ranges: FieldRange[] = [{ fieldId: amount.id, min: 0, max: 400 }]): ViewColors {
  return createViewColors({
    config,
    fields,
    context: { timeZone: 'UTC' },
    ranges: new Map(ranges.map((range) => [range.fieldId, range])),
    label: (rule: ColorRule) => rule.name,
  });
}

function mount(ui: ReactElement) {
  const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
  return render(<I18nProvider i18n={i18n}>{ui}</I18nProvider>);
}

describe('grid cells', () => {
  function cell(colors: ViewColors) {
    const render = createCellRenderer({
      fieldsById: new Map(fields.map((each) => [each.id, each])),
      format,
      rowHeight: 'short',
      colors,
    });
    const node = document.createElement('div');
    node.setAttribute('role', 'gridcell');
    const content = document.createElement('div');
    node.append(content);
    const draw = (data: RowData, drawn = amount) =>
      render(content, {
        row: data,
        rowIndex: 0,
        column: { id: drawn.id, width: 180, edit: 'inline' },
        colIndex: 0,
        selected: false,
        active: false,
      });
    return { node, content, draw };
  }

  it('names icons for screen readers, keeps numeric text, and clears recycled cells', () => {
    const colors = createViewColors({
      config: ColorConfig.parse({
        iconSets: [{ fieldId: amount.id, thresholds: [0, 10], labels: ['Low', 'Middle', 'Excellent'] }],
      }),
      fields,
      context: { timeZone: 'UTC' },
      ranges: new Map(),
      label: () => '',
    });
    const { node, content, draw } = cell(colors);
    draw(row({ [amount.id]: 10 }));
    expect(node.getAttribute('aria-description')).toBe('Excellent');
    expect(node.title).toBe('Excellent');
    expect(content.textContent).toBe('10');
    expect(node.querySelector('.rio-color-icon')?.textContent).toBe('↑');
    expect(node.querySelector('.rio-color-icon')?.getAttribute('aria-hidden')).toBe('true');
    draw(row({ [amount.id]: -1 }));
    expect(node.getAttribute('aria-description')).toBe('Low');
    expect(node.querySelectorAll('.rio-color-icon')).toHaveLength(1);
    draw(row({ [amount.id]: null }));
    expect(node.querySelector('.rio-color-icon')).toBeNull();
    expect(node.hasAttribute('aria-description')).toBe(false);
  });

  it('fill a matching cell, draw its bar, and name the rules for screen readers', () => {
    const { node, draw } = cell(viewColors());
    draw(row({ [amount.id]: 200, [status.id]: done }));
    expect([...node.classList]).toEqual(
      expect.arrayContaining(['rio-color-fill', 'rio-color-bar', 'rio-color-bar--bare']),
    );
    expect(node.style.getPropertyValue('--rio-color-fill')).toBe('var(--rio-aa-choice-red-soft)');
    expect(node.style.getPropertyValue('--rio-color-bar-size')).toBe('50%');
    expect(node.style.getPropertyValue('--rio-color-bar-fill')).toBe('var(--rio-aa-choice-teal-soft)');
    expect(node.style.getPropertyValue('--rio-color-bar-line')).toBe('var(--rio-aa-choice-teal)');
    expect(node.getAttribute('aria-description')).toBe('Finished, Large');
  });

  it('clear everything an earlier value drew when the cell is reused', () => {
    const { node, draw } = cell(viewColors());
    draw(row({ [amount.id]: 200 }));
    draw(row({ [amount.id]: null }));
    expect(node.className).toBe('');
    expect(node.getAttribute('style') ?? '').not.toContain('--rio-color');
    expect(node.hasAttribute('aria-description')).toBe(false);
  });

  it('show a bar with its number while the fill waits for its rule', () => {
    const { node, draw } = cell(
      createViewColors({
        config: ColorConfig.parse({ dataBars: [{ fieldId: amount.id }] }),
        fields,
        context: { timeZone: 'UTC' },
        ranges: new Map([[amount.id, { fieldId: amount.id, min: 0, max: 400 }]]),
        label: () => '',
      }),
    );
    draw(row({ [amount.id]: 100 }));
    expect(node.classList.contains('rio-color-bar')).toBe(true);
    expect(node.classList.contains('rio-color-bar--bare')).toBe(false);
    expect(node.classList.contains('rio-color-fill')).toBe(false);
    expect(node.style.getPropertyValue('--rio-color-bar-size')).toBe('25%');
  });
});

describe('grid rows', () => {
  it('tint a record’s row, mark its row header, and announce the rules with each cell', async () => {
    appI18n.load('en-US', {});
    appI18n.activate('en-US');
    const server = new FakeServer();
    const fixture = server.createDatabase(3);
    const session = await openDatabase(fixture.databaseId, server.deps());
    dispose.push(() => session.close());
    const rows = session.openView(fixture.viewId);
    rows.ensureRows(0, 3);
    await waitFor(() => expect(rows.getRow(2)).toBeDefined());
    const schema = session.getSchema();
    const tableFields = schema.fields.get(fixture.tableId)!;
    const number = tableFields.find((each) => each.id === fixture.numberFieldId)!;
    const colors = createViewColors({
      config: ColorConfig.parse({
        colorRules: [
          {
            id: 'many',
            name: 'Many',
            target: 'record',
            condition: { id: 'c', fieldId: number.id, operator: 'gte', value: 1 },
            color: 'purple',
          },
        ],
      }),
      fields: tableFields,
      context: { timeZone: 'UTC' },
      ranges: new Map(),
      label: (rule) => rule.name,
    });
    const abort = new AbortController();
    const controller = createGridController(
      {
        session,
        rows,
        fields: tableFields,
        format,
        table: schema.tableById.get(fixture.tableId)!,
        view: schema.viewById.get(fixture.viewId)!,
        peers: [],
        colors,
        onConfig: vi.fn(),
        onExpand: vi.fn(),
        onField: vi.fn(),
        onMenu: vi.fn(),
        onPreview: vi.fn(),
      },
      abort.signal,
    );
    dispose.push(() => {
      abort.abort();
      controller.destroy();
    });
    controller.attach({
      getSelection: () => ({ active: null, range: null, rows: { kind: 'none' } }),
      setDecorations: vi.fn(),
      rowsChanged: vi.fn(),
    } as unknown as GridApi<RowData>);
    const first = rows.getRow(0)!;
    const second = rows.getRow(1)!;
    expect(controller.host.rowClass?.(first, 0)).toBeNull();
    expect(controller.host.rowClass?.(second, 1)).toBe('rio-color-row rio-color-row--purple');
    const header = document.createElement('div');
    controller.host.renderRowHeader(header, 1, second, false);
    expect(header.getAttribute('aria-description')).toBe('Many');
    controller.host.renderRowHeader(header, 0, first, false);
    expect(header.hasAttribute('aria-description')).toBe(false);
    expect(controller.host.describeCell?.({ row: 1, col: 1 })).toBe('Number, row 2: 1, Many');
  });
});

describe('cards and the record card', () => {
  it('keeps the color marker and its description beside an icon in the record card', () => {
    const colors = createViewColors({
      config: ColorConfig.parse({
        ...config,
        iconSets: [{ fieldId: amount.id, thresholds: [0, 100], labels: ['', '', 'High'] }],
      }),
      fields,
      context: { timeZone: 'UTC' },
      ranges: new Map(),
      label: (rule) => rule.name,
    });
    mount(
      <RecordCard
        fields={fields}
        primaryFieldId={title.id}
        row={row({ [title.id]: 'Launch', [status.id]: done, [amount.id]: 150 })}
        format={format}
        colors={colors}
        readOnly
        canEditOptions={false}
        position={null}
        onChange={vi.fn()}
        onAddOption={() => ''}
        onClose={vi.fn()}
      />,
    );
    const icon = screen.getByRole('img', { name: 'High' });
    expect(icon.classList.contains('rio-color-icon')).toBe(true);
    const marker = screen.getByRole('img', { name: 'Large, High' });
    expect(marker.classList.contains('rio-color-mark')).toBe(true);
    expect(marker.style.getPropertyValue('--rio-color-mark')).toBe('var(--rio-aa-choice-red)');
    expect(marker.closest('.rio-record-card__label')).toBe(icon.closest('.rio-record-card__label'));
    expect(screen.getByRole('img', { name: 'Finished' }).classList.contains('rio-color-mark')).toBe(true);
  });

  it('put a colored value on its tint, with its bar', () => {
    const colors = viewColors();
    const { container } = mount(
      <CardValue
        field={amount}
        value={300}
        format={format}
        paint={colors.cell(row({ [amount.id]: 300 }), amount)}
      />,
    );
    const value = container.querySelector<HTMLElement>('.rio-color-value')!;
    expect([...value.classList]).toEqual(
      expect.arrayContaining(['rio-color-fill', 'rio-color-bar', 'rio-color-bar--bare']),
    );
    expect(value.style.getPropertyValue('--rio-color-fill')).toBe('var(--rio-aa-choice-red-soft)');
    expect(value.style.getPropertyValue('--rio-color-bar-size')).toBe('75%');
    expect(value.textContent).toBe('300');
  });

  it('edge a gallery card for its record and name every rule on it', () => {
    const data = row({ [title.id]: 'Launch', [status.id]: done, [amount.id]: 150 });
    mount(
      <GalleryCard
        row={data}
        primary={title}
        fields={[status, amount]}
        settings={GridConfig.parse({}).gallery}
        format={format}
        colors={viewColors()}
        index={0}
        count={1}
        columns={1}
        active
        onFocus={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    const card = screen.getByRole('gridcell', { name: /^Launch(?: |$)/ });
    expect(card.classList.contains('rio-color-edge')).toBe(true);
    expect(card.style.getPropertyValue('--rio-color-edge')).toBe('var(--rio-aa-choice-green)');
    expect(card.getAttribute('aria-description')).toBe('Finished, Large');
    expect(card.querySelector('.rio-color-fill')?.textContent).toBe('150');
  });

  it('mark the record card’s title and colored fields with the rules’ names', () => {
    mount(
      <RecordCard
        fields={fields}
        primaryFieldId={title.id}
        row={row({ [title.id]: 'Launch', [status.id]: done, [amount.id]: 150 })}
        format={format}
        colors={viewColors()}
        readOnly
        canEditOptions={false}
        position={null}
        onChange={vi.fn()}
        onAddOption={() => ''}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('img', { name: 'Finished' }).classList.contains('rio-color-mark')).toBe(true);
    const large = screen.getByRole('img', { name: 'Large' });
    expect(large.closest('.rio-record-card__label')?.textContent).toBe('Amount');
    expect(large.style.getPropertyValue('--rio-color-mark')).toBe('var(--rio-aa-choice-red)');
  });
});

describe('view ranges', () => {
  it('uses and refreshes the drilled range when where changes or clears', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(3);
    const session = await openDatabase(fixture.databaseId, server.deps());
    dispose.push(() => session.close());
    const schema = session.getSchema();
    const tableFields = schema.fields.get(fixture.tableId)!;
    const base = schema.viewById.get(fixture.viewId)!;
    const view = {
      ...base,
      config: {
        ...base.config,
        ...ColorConfig.parse({ dataBars: [{ fieldId: fixture.numberFieldId, color: 'blue' }] }),
      },
    };
    const token = (value: number) =>
      encodeWhere({
        conjunction: 'and',
        conditions: [{ id: 'part', fieldId: fixture.numberFieldId, operator: 'lt', value }],
      });
    const first = token(10);
    const second = token(20);
    const requests: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        const where = new URL(path, 'http://localhost').searchParams.get('where');
        requests.push(where);
        const max = where === first ? 10 : where === second ? 20 : 100;
        return new Response(JSON.stringify({ ranges: [{ fieldId: fixture.numberFieldId, min: 0, max }] }));
      }),
    );
    let colors: ViewColors | undefined;
    function Probe({ where }: { where?: string }) {
      colors = useViewColors(session, view, tableFields, format, true, where);
      return null;
    }
    const number = tableFields.find((each) => each.id === fixture.numberFieldId)!;
    const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
    const probe = (where?: string) => (
      <I18nProvider i18n={i18n}>
        <Probe where={where} />
      </I18nProvider>
    );
    const rendered = render(probe(first));
    await waitFor(() => expect(colors?.cell(row({ [number.id]: 5 }), number)?.bar?.size).toBe(50));
    rendered.rerender(probe(second));
    await waitFor(() => expect(colors?.cell(row({ [number.id]: 5 }), number)?.bar?.size).toBe(25));
    rendered.rerender(probe());
    await waitFor(() => expect(colors?.cell(row({ [number.id]: 5 }), number)?.bar?.size).toBe(5));
    expect(requests).toEqual([first, second, null]);
  });

  it('load the range scales and bars need, and reload it after the records change', async () => {
    const server = new FakeServer();
    const fixture = server.createDatabase(3);
    const session: DatabaseSession = await openDatabase(fixture.databaseId, server.deps());
    dispose.push(() => session.close());
    const schema = session.getSchema();
    const tableFields = schema.fields.get(fixture.tableId)!;
    const base = schema.viewById.get(fixture.viewId)!;
    const view: ViewMeta = {
      ...base,
      config: {
        ...base.config,
        ...ColorConfig.parse({ dataBars: [{ fieldId: fixture.numberFieldId, color: 'blue' }] }),
      },
    };
    const requests: string[] = [];
    let max = 10;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        requests.push(path);
        return new Response(JSON.stringify({ ranges: [{ fieldId: fixture.numberFieldId, min: 0, max }] }), {
          status: 200,
        });
      }),
    );
    let colors: ViewColors | undefined;
    function Probe() {
      colors = useViewColors(session, view, tableFields, format);
      return null;
    }
    mount(<Probe />);
    const number = tableFields.find((each) => each.id === fixture.numberFieldId)!;
    await waitFor(() => expect(colors?.cell(row({ [number.id]: 5 }), number)?.bar?.size).toBe(50));
    expect(requests).toEqual([
      `/api/views/${fixture.viewId}/ranges?${new URLSearchParams({ fields: number.id, tz: 'UTC' })}`,
    ]);
    max = 20;
    act(() => {
      session.run([
        {
          kind: 'record.update',
          tableId: fixture.tableId,
          records: [{ id: fixture.recordId(0), values: { [number.id]: 20 } }],
        },
      ]);
    });
    await waitFor(() => expect(colors?.cell(row({ [number.id]: 5 }), number)?.bar?.size).toBe(25));
    expect(requests.length).toBeGreaterThan(1);
  });
});
