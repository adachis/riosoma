import { setupI18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ColorConfig, FieldMeta, GridConfig, sparklineShape, type RowData } from '@riosoma/contracts';
import { createCellRenderer } from '../../../grid/cells/renderers';
import { CardValue } from '../views/CardValue';
import { viewDocument } from '../print/document';
import { createViewColors } from './paint';
import { drawSparkline, sparklineSvg, type SparklinePaint } from './sparklines';

function parsedMarkup(paint: SparklinePaint): string {
  const root = document.createElement('span');
  root.innerHTML = sparklineSvg(paint);
  return root.innerHTML;
}

const i18n = setupI18n({ locale: 'en-US', messages: { 'en-US': {} } });
const field = FieldMeta.parse({
  id: 'fld00000000000001',
  tableId: 'tbl00000000000001',
  type: 'json',
  name: 'History',
  description: '',
  position: 0,
  createdAt: '',
  updatedAt: '',
});
const format = { locale: 'en-US', timeZone: 'UTC', collaborators: new Map() };
const row = (values: string): RowData => ({
  id: 'rec00000000000001',
  values: { [field.id]: values },
  createdAt: '',
  updatedAt: '',
  createdBy: null,
  updatedBy: null,
});
const config = GridConfig.parse({
  sparklines: [{ fieldId: field.id, first: true, min: true, max: true, sharedAxis: true }],
});
const colors = () =>
  createViewColors({
    config: ColorConfig.parse(config),
    fields: [field],
    i18n,
    ranges: new Map([[field.id, { fieldId: field.id, min: -10, max: 10 }]]),
    context: { timeZone: 'UTC' },
    label: () => '',
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('shares geometry by value and fixed view box without reusing stale labels, axes, highlights, or colors', () => {
  const paint = colors();
  const first = paint.cell(row('[8,-2,5]'), field)!.sparkline!;
  const replacement = paint.cell(row('[8,-2,5]'), field)!.sparkline!;
  expect(replacement.shape).toBe(first.shape);
  expect(replacement.label).toBe(first.label);
  const changed = paint.cell(row('[8,-2,6]'), field)!.sparkline!;
  expect(changed.shape).not.toBe(first.shape);
  expect(changed.label).toContain('last 6');
  expect(paint.cell(row('[-0,0]'), field)!.sparkline!.label).not.toBe(
    paint.cell(row('[0,0]'), field)!.sparkline!.label,
  );
  for (const type of ['line', 'column', 'winLoss'] as const) {
    for (const color of ['accent', 'gray', 'red'] as const) {
      const settings = GridConfig.parse({
        sparklines: [
          { fieldId: field.id, type, color, sharedAxis: true, first: true, last: true, min: true, max: true },
        ],
      });
      const charts = createViewColors({
        config: settings,
        fields: [field],
        i18n,
        ranges: new Map([[field.id, { fieldId: field.id, min: -20, max: 20 }]]),
        context: { timeZone: 'UTC' },
        label: () => '',
      });
      const chart = charts.cell(row('[8,-2,5]'), field)!.sparkline!;
      expect(chart.shape).toEqual(sparklineShape([8, -2, 5], settings.sparklines[0]!, { min: -20, max: 20 }));
      const root = document.createElement('span');
      drawSparkline(root, chart);
      expect(root.innerHTML).toBe(parsedMarkup(chart));
      expect(root.title).toBe(chart.label);
      const svg = root.firstChild;
      drawSparkline(root, { ...chart });
      expect(root.firstChild).toBe(svg);
      const paper = { series: '#2f6b4f', highlight: '#7c7c7c', negative: '#b3261e' };
      expect(sparklineSvg(chart, paper)).toContain(paper.highlight);
      expect(sparklineSvg(chart)).toContain('var(--rio-aa-');
    }
  }
});

it('prepares overscan charts at idle, replaces queued recycled values, and draws newly visible cells immediately', () => {
  const callbacks: IdleRequestCallback[] = [];
  vi.stubGlobal('requestIdleCallback', (callback: IdleRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const paint = colors();
  const first = paint.cell(row('[8,-2,5]'), field)!.sparkline!;
  const second = paint.cell(row('[1,3,2]'), field)!.sparkline!;
  const root = document.createElement('span');
  document.body.append(root);
  try {
    drawSparkline(root, first, false);
    expect(root.querySelector('svg')).toBeNull();
    drawSparkline(root, second, false);
    expect(callbacks).toHaveLength(1);
    callbacks.shift()!({ didTimeout: false, timeRemaining: () => 10 });
    expect(root.innerHTML).toBe(parsedMarkup(second));
    drawSparkline(root, first, false);
    expect(root.querySelector('svg')).toBeNull();
    drawSparkline(root, second, true);
    const svg = root.firstChild;
    callbacks.shift()!({ didTimeout: false, timeRemaining: () => 10 });
    expect(root.innerHTML).toBe(parsedMarkup(second));
    expect(root.firstChild).toBe(svg);
    drawSparkline(root, first, false);
    root.remove();
    callbacks.shift()!({ didTimeout: false, timeRemaining: () => 10 });
    expect(root.querySelector('svg')).toBeNull();
  } finally {
    root.remove();
  }
});

it('renders the same accessible chart in cards and recycled grid cells, caches geometry, and clears blanks', () => {
  const paint = colors();
  const data = row('[8,-2,5]');
  const chart = paint.cell(data, field)!.sparkline!;
  expect(paint.cell(data, field)!.sparkline).toBe(chart);
  expect(paint.cell(row('[1.00001,1.00004,1.00003]'), field)!.sparkline!.label).toBe(
    'Minimum 1.00001, maximum 1.00004, last 1.00003; trend rising',
  );
  render(
    <I18nProvider i18n={i18n}>
      <CardValue
        field={field}
        value={data.values[field.id]!}
        format={format}
        paint={paint.cell(data, field)}
      />
    </I18nProvider>,
  );
  const card = screen.getByRole('img', { name: 'Minimum -2, maximum 8, last 5; trend falling' });
  expect(card.querySelector('path')?.getAttribute('stroke')).toBe('var(--rio-aa-accent-text)');
  expect(card.querySelector('circle')?.getAttribute('fill')).toBe('var(--rio-aa-choice-gray)');
  const host = document.createElement('div'),
    content = document.createElement('div');
  host.setAttribute('role', 'gridcell');
  host.append(content);
  const renderer = createCellRenderer({
    fieldsById: new Map([[field.id, field]]),
    format,
    rowHeight: 'short',
    colors: paint,
  });
  const draw = (data: RowData) =>
    renderer(content, {
      row: data,
      rowIndex: 0,
      colIndex: 0,
      column: { id: field.id, width: 180, edit: 'inline' },
      active: false,
      selected: false,
    });
  draw(data);
  const svg = content.querySelector('svg');
  expect(host.getAttribute('aria-description')).toBe(chart.label);
  expect(svg?.querySelector('path')?.getAttribute('d')).toBe(card.querySelector('path')?.getAttribute('d'));
  draw(data);
  expect(content.querySelector('svg')).toBe(svg);
  draw(row('[]'));
  expect(content.querySelector('svg')).toBeNull();
  expect(host.hasAttribute('aria-description')).toBe(false);
  draw(row('[1,2]'));
  expect(content.querySelector('svg')).not.toBeNull();
});

it('prints all chart types with text alternatives and one axis across printed rows', () => {
  vi.spyOn(globalThis, 'getComputedStyle').mockReturnValue({
    color: 'rgb(255,255,255)',
    fontFamily: 'system-ui',
  } as CSSStyleDeclaration);
  for (const type of ['line', 'column', 'winLoss']) {
    const source = {
      type: 'grid' as const,
      config: GridConfig.parse({ sparklines: [{ fieldId: field.id, type, sharedAxis: true }] }),
      primaryFieldId: field.id,
      tableFields: [field],
    };
    const definition = viewDocument(
      [row('[0,10]'), row('[0,20]')],
      { title: '', pageSize: 'LETTER', orientation: 'portrait', fields: [field] },
      source,
      {
        i18n,
        format,
        databaseName: 'Database',
        sourceName: 'History',
        printedAt: new Date('2026-10-01T00:00:00Z'),
      },
    );
    const serialized = JSON.stringify(definition.content);
    expect(serialized).toContain('Minimum 0, maximum 10, last 10; trend rising');
    expect(serialized).toContain('Minimum 0, maximum 20, last 20; trend rising');
    expect(serialized).toContain('<svg');
    expect(serialized).not.toContain('var(--rio-');
    expect(serialized).toContain('#2f6b4f');
    expect(serialized).toContain('#7c7c7c');
    expect(serialized).not.toContain('#ffffff');
    if (type === 'line') expect(serialized).toContain('L98.00,12.00');
  }
});
