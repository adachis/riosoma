import type { ChartBlock, TileData } from '@riosoma/contracts';
import { escapeHtml } from '../reports/messages.js';

type ChartData = Extract<TileData, { kind: 'chart' }>;
const number = (value: number) => Number(value.toFixed(3));
const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const short = (label: string) => escapeHtml([...label].slice(0, 16).join(''));

/** SVG contains geometry and escaped labels alone.  The adjacent table supplies accessible data. */
export function chartSvg(block: ChartBlock, data: ChartData): string {
  if (!['bar', 'column', 'line', 'donut'].includes(block.chart)) return '';
  const categories = data.categories;
  const count = Math.max(1, categories.length);
  const series = data.series;
  const parts: string[] = [];
  const height = block.chart === 'bar' ? Math.max(320, count * 32 + 70) : 360;
  const wrap = () =>
    `<svg class="site-chart" viewBox="0 0 640 ${height}" aria-hidden="true" focusable="false">${parts.join('')}</svg>`;
  const color = (index: number) => `site-series-${index % 8}`;
  if (block.chart === 'donut') {
    const values = categories
      .map((_, index) => Math.max(0, series[0]?.values[index] ?? 0))
      .map((value) => (finite(value) ? value : 0));
    const maximum = Math.max(1, ...values);
    const total = values.reduce((sum, value) => sum + value / maximum, 0);
    parts.push('<circle class="site-chart-empty" cx="320" cy="170" r="110" fill="none" stroke-width="54"/>');
    let offset = 0;
    values.forEach((value, index) => {
      if (!value || !total) return;
      const share = (value / maximum / total) * 100;
      parts.push(
        `<circle class="site-chart-slice ${color(index)}" cx="320" cy="170" r="110" fill="none" stroke-width="54" pathLength="100" stroke-dasharray="${number(share)} ${number(100 - share)}" stroke-dashoffset="${number(-offset)}" transform="rotate(-90 320 170)"><title>${escapeHtml(categories[index]!.label)}: ${escapeHtml(String(value))}</title></circle>`,
      );
      offset += share;
    });
    return wrap();
  }
  // Normalize before summing or scaling so even very large finite values keep finite geometry.
  const magnitude = Math.max(1, ...series.flatMap((item) => item.values.filter(finite).map(Math.abs)));
  const values = series.map((item) =>
    categories.map((_, index) => (finite(item.values[index]) ? item.values[index]! / magnitude : null)),
  );
  const stacked = block.stacked && block.chart !== 'line';
  const totals = categories.flatMap((_, index) =>
    stacked
      ? [
          values.reduce((sum, item) => sum + Math.max(0, item[index] ?? 0), 0),
          values.reduce((sum, item) => sum + Math.min(0, item[index] ?? 0), 0),
        ]
      : values.flatMap((item) => item[index] ?? []),
  );
  const low = Math.min(0, ...totals);
  const high = Math.max(0, ...totals);
  const span = high - low || 1;
  const horizontal = block.chart === 'bar';
  const scale = (value: number) =>
    horizontal ? 130 + ((value - low) / span) * 470 : 280 - ((value - low) / span) * 250;
  const zero = scale(0);
  parts.push(
    horizontal
      ? `<path class="site-chart-axis" d="M${number(zero)} 20V${height - 45}"/>`
      : `<path class="site-chart-axis" d="M60 ${number(zero)}H610"/>`,
  );
  [low, high].forEach((value, index) => {
    const label = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
      value * magnitude,
    );
    parts.push(
      `<text class="site-chart-label" x="${horizontal ? (index ? 600 : 130) : 54}" y="${horizontal ? height - 18 : index ? 34 : 284}" text-anchor="${horizontal ? (index ? 'end' : 'start') : 'end'}">${escapeHtml(label)}</text>`,
    );
  });
  const positive = categories.map(() => 0);
  const negative = categories.map(() => 0);
  values.forEach((items, seriesIndex) => {
    let line = '';
    let drawing = false;
    items.forEach((value, index) => {
      if (value === null) {
        drawing = false;
        return;
      }
      const band = (horizontal ? height - 70 : 540) / count;
      const center = (horizontal ? 25 : 65) + (index + 0.5) * band;
      if (block.chart === 'line') {
        line += `${drawing ? 'L' : 'M'}${number(center)} ${number(scale(value))}`;
        drawing = true;
        parts.push(
          `<circle class="${color(seriesIndex)}" cx="${number(center)}" cy="${number(scale(value))}" r="4"><title>${escapeHtml(categories[index]!.label)}: ${escapeHtml(String(series[seriesIndex]!.values[index]))}</title></circle>`,
        );
        return;
      }
      const thickness = Math.max(1, (band * 0.72) / (stacked ? 1 : Math.max(1, series.length)));
      const start = stacked ? (value >= 0 ? positive[index]! : negative[index]!) : 0;
      const end = start + value;
      if (value >= 0) positive[index] = end;
      else negative[index] = end;
      const side = center - band * 0.36 + (stacked ? 0 : seriesIndex * thickness);
      const position = Math.min(scale(start), scale(end));
      const length = Math.abs(scale(end) - scale(start));
      parts.push(
        `<rect class="${color(seriesIndex)}" x="${number(horizontal ? position : side)}" y="${number(horizontal ? side : position)}" width="${number(horizontal ? length : thickness)}" height="${number(horizontal ? thickness : length)}"><title>${escapeHtml(categories[index]!.label)}: ${escapeHtml(String(series[seriesIndex]!.values[index]))}</title></rect>`,
      );
    });
    if (line) parts.push(`<path class="site-chart-line ${color(seriesIndex)}" d="${line}"/>`);
  });
  categories.forEach((category, index) => {
    const center = (horizontal ? 25 : 65) + ((index + 0.5) * (horizontal ? height - 70 : 540)) / count;
    parts.push(
      `<text class="site-chart-label" x="${horizontal ? 120 : number(center)}" y="${horizontal ? number(center + 4) : 310}" text-anchor="${horizontal ? 'end' : 'middle'}"><title>${escapeHtml(category.label)}</title>${short(category.label)}</text>`,
    );
  });
  return wrap();
}
