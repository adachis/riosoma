import {
  HEADER_COLOR_RGB,
  OFFICE_LIMITS,
  REPORT_SUMMARY_FIELDS,
  REPORT_SUMMARY_RECORDS,
  cellValue,
  colorRuleMatches,
  isScaleField,
  markdownToDoc,
  type ChartAggregate,
  type ColorScale,
  type FieldRange,
  type GridGroupBoundary,
  type SummaryResult,
} from '@riosoma/contracts';
import { withTransaction } from '@riosoma/db';
import sharp from 'sharp';
import { formatCellText, formatValue, relationContext, type FormatContext } from '../data/format.js';
import { exportPages, snapshotOrder, type ExportSource } from '../data/export/source.js';
import type { Snapshot } from '../data/snapshots.js';
import { groupLabelRows } from '../data/view-aggregates/grid-groups.js';
import { gridSummary } from '../data/view-aggregates/grid-summary.js';
import { chartAggregate } from '../data/view-aggregates/compute.js';
import { viewRecords } from '../data/view-aggregates/routes.js';
import { viewRanges } from '../data/view-ranges.js';
import { escapeHtml, formatMessage } from './messages.js';
import { REPORT_PDF_COPY } from '../data/export/office/copy.js';

export { REPORT_PDF_COPY } from '../data/export/office/copy.js';

export function reportWord(
  key: keyof typeof REPORT_PDF_COPY,
  locale: string,
  values: Record<string, string | number> = {},
): string {
  return formatMessage(REPORT_PDF_COPY[key].message, values, { locale, html: false });
}

export interface ReportCell {
  text: string;
  fill?: string;
}

interface TextNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: TextNode[];
}

/** PDF cells retain every paragraph without exposing stored formatting or link targets. */
function richTextWords(node: TextNode, locale: string): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const separator = ['paragraph', 'heading', 'codeBlock'].includes(node.type) ? '' : '\n';
  const text = (node.content ?? []).map((child) => richTextWords(child, locale)).join(separator);
  return node.type === 'taskItem'
    ? reportWord(node.attrs?.checked ? 'taskComplete' : 'taskIncomplete', locale, { text })
    : text;
}

export interface ReportLayoutRow {
  cells: ReportCell[];
  kind: 'record' | 'group' | 'total';
  level?: number;
}

export interface ReportLayout {
  title: string;
  subtitle: string;
  locale: string;
  count: number;
  columns: ReportCell[];
  rows: ReportLayoutRow[];
  charts: Array<{ image: string; text: string }>;
  landscape: boolean;
  caption?: string;
  /** Message keys only, so history never holds record values. */
  notes: string[];
}

/** Every section repeats the identifier column and gives text enough room on an A4 page. */
export function reportColumnSections(layout: Pick<ReportLayout, 'columns' | 'landscape'>): number[][] {
  const availableWidth = (layout.landscape ? 841.89 : 595.28) - 72;
  const columnsPerSection = Math.max(2, Math.floor(availableWidth / 80));
  if (layout.columns.length <= columnsPerSection) return [layout.columns.map((_, index) => index)];
  const sections: number[][] = [];
  for (let start = 1; start < layout.columns.length; start += columnsPerSection - 1) {
    sections.push([
      0,
      ...layout.columns.slice(start, start + columnsPerSection - 1).map((_, index) => start + index),
    ]);
  }
  return sections;
}

export function summaryReportLayout(layout: ReportLayout): ReportLayout {
  let records = 0;
  return {
    ...layout,
    columns: layout.columns.slice(0, REPORT_SUMMARY_FIELDS),
    rows: layout.rows
      .filter((row) => {
        if (row.kind === 'total') return true;
        if (records >= REPORT_SUMMARY_RECORDS) return false;
        if (row.kind === 'record') records++;
        return true;
      })
      .map((row) => ({ ...row, cells: row.cells.slice(0, REPORT_SUMMARY_FIELDS) })),
  };
}

function summaryText(
  value: SummaryResult | undefined,
  field: ExportSource['fields'][number],
  ctx: FormatContext,
) {
  if (!value) return '';
  if (value.currencies)
    return Object.entries(value.currencies)
      .map(([currency, amount]) =>
        new Intl.NumberFormat(ctx.locale, { style: 'currency', currency }).format(amount),
      )
      .join(', ');
  if (value.value === null) return '';
  if (value.kind === 'percentFilled')
    return new Intl.NumberFormat(ctx.locale, { style: 'percent' }).format(Number(value.value));
  if (['count', 'filled', 'empty', 'unique', 'checked', 'unchecked'].includes(value.kind))
    return new Intl.NumberFormat(ctx.locale).format(Number(value.value));
  return formatValue(field, value.value, ctx);
}

/** Portable fills keep numeric and date scales readable without a browser's theme engine. */
function scaleColor(
  scale: ColorScale,
  field: ExportSource['fields'][number],
  value: unknown,
  range: FieldRange | undefined,
): string | undefined {
  const point = (input: unknown): number | undefined => {
    if (field.type === 'date') {
      if (typeof input !== 'string') return undefined;
      const time = Date.parse(input.length === 10 ? `${input}T00:00:00Z` : input);
      return Number.isFinite(time) ? time : undefined;
    }
    return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
  };
  const number = point(value);
  const low = point(scale.stops[0]!.value ?? range?.min);
  const high = point(scale.stops.at(-1)!.value ?? range?.max);
  if (number === undefined || low === undefined || high === undefined) return undefined;
  const stops = scale.stops.map((stop, index) => ({
    color: HEADER_COLOR_RGB[stop.color],
    at: point(stop.value) ?? (index === 0 ? low : index === scale.stops.length - 1 ? high : (low + high) / 2),
  }));
  const fraction = (at: number, from: number, to: number) =>
    from === to ? 0.5 : Math.max(0, Math.min(1, (at - from) / (to - from)));
  const position = fraction(number, low, high);
  const middle = stops.length === 3 ? fraction(stops[1]!.at, low, high) : undefined;
  const left = stops[middle !== undefined && position > middle ? 1 : 0]!;
  const right = stops[middle !== undefined && position <= middle ? 1 : stops.length - 1]!;
  const amount = fraction(number, left.at, right.at);
  const channels = [0, 2, 4].map((index) => {
    const from = parseInt(left.color.slice(index, index + 2), 16);
    const to = parseInt(right.color.slice(index, index + 2), 16);
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${channels.join('').toUpperCase()}`;
}

/** Charts travel as embedded PNGs, so neither mail readers nor the renderer fetch their data. */
export async function reportChart(
  answer: ChartAggregate,
  locale: string,
  kind: string,
): Promise<ReportLayout['charts'][number]> {
  const colors = ['#374838', '#5979a2', '#ad7435', '#795c94', '#ac535b'];
  const values = answer.series
    .flatMap((series) => series.values)
    .filter((value): value is number => value !== null);
  const low = Math.min(0, ...values),
    high = Math.max(1, ...values);
  const y = (value: number) => 270 - ((value - low) / (high - low)) * 220;
  const step = 600 / Math.max(1, answer.categories.length);
  const parts: string[] = ['<rect width="680" height="340" fill="white"/>'];
  const descriptions: string[] = [];
  answer.series.forEach((series, seriesIndex) => {
    const color = colors[seriesIndex % colors.length]!;
    const points: string[] = [];
    series.values.forEach((value, index) => {
      if (value === null) return;
      const x = 50 + step * (index + 0.5);
      const label = answer.categories[index]?.label ?? '';
      const shown = new Intl.NumberFormat(locale).format(value);
      descriptions.push([series.label, label, shown].filter(Boolean).join(': '));
      if (kind === 'line' || kind === 'area') points.push(`${x},${y(value)}`);
      else {
        const width = Math.max(0.5, (step * 0.8) / answer.series.length);
        parts.push(
          `<rect x="${x - step * 0.4 + seriesIndex * width}" y="${Math.min(y(0), y(value))}" width="${width}" height="${Math.max(1, Math.abs(y(value) - y(0)))}" fill="${color}"/>`,
        );
      }
      parts.push(
        `<text x="${x}" y="${y(value) - 5}" text-anchor="middle" font-size="10">${escapeHtml(shown)}</text>`,
      );
    });
    if (points.length)
      parts.push(`<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`);
  });
  answer.categories.forEach((category, index) => {
    parts.push(
      `<text x="${50 + step * (index + 0.5)}" y="295" text-anchor="middle" font-size="10">${escapeHtml(category.label)}</text>`,
    );
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="340">${parts.join('')}</svg>`;
  const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
  return { image: `data:image/png;base64,${bytes.toString('base64')}`, text: descriptions.join('; ') };
}

/** Full PDF and abbreviated email share cells, group labels, totals, and embedded charts. */
export async function reportLayout(
  source: ExportSource,
  snapshot: Snapshot,
  title: string,
): Promise<ReportLayout> {
  const config = source.read.view.config;
  const limit = Math.min(
    OFFICE_LIMITS.documentRecords,
    Math.floor(OFFICE_LIMITS.documentValues / Math.max(1, source.fields.length)),
  );
  const held: Snapshot = { ...snapshot, rids: snapshot.rids.subarray(0, limit) };
  const layout: ReportLayout = {
    title,
    subtitle: `${source.read.table.name} – ${source.read.view.name}`,
    locale: source.locale,
    count: snapshot.rids.length,
    columns: source.fields.map((field) => ({
      text: field.name,
      ...(config.headerColors[field.id]
        ? { fill: `#${HEADER_COLOR_RGB[config.headerColors[field.id]!]}` }
        : {}),
    })),
    rows: [],
    charts: [],
    landscape:
      source.fields.length > OFFICE_LIMITS.portraitColumns ||
      source.fields.reduce((sum, field) => sum + (config.columnWidths[field.id] ?? 140), 0) > 900,
    notes: [],
  };
  if (snapshot.rids.length > limit) {
    layout.caption = reportWord('capped', source.locale, { shown: limit, total: snapshot.rids.length });
    layout.notes.push('reports.pdf.truncated');
  }
  const groups = snapshot.groups.filter(
    (group) =>
      group.start < held.rids.length &&
      config.groups
        .slice(0, group.level)
        .every((item) => source.read.fields.some((field) => field.id === item.fieldId)),
  );
  const labels = groupLabelRows(groups, source.read.fields);
  const relations = await relationContext({
    db: source.pool,
    schemas: source.schemas,
    scope: source.scope,
    table: source.read.table,
    fields: source.read.fields,
    rows: labels,
    names: true,
  });
  const groupContext: FormatContext = { ...relations, locale: source.locale, timeZone: source.timeZone };
  const groupRow = (group: GridGroupBoundary, index: number): ReportLayoutRow => ({
    kind: 'group',
    level: group.level,
    cells: source.fields.map((field, column) => {
      const summary = summaryText(
        field.id === source.read.table.primaryFieldId
          ? { kind: 'count', value: group.count }
          : group.summaries[field.id],
        field,
        groupContext,
      );
      const label =
        column === 0
          ? config.groups
              .slice(0, group.level)
              .map((item) => {
                const groupField = source.read.fields.find((candidate) => candidate.id === item.fieldId)!;
                return `${groupField.name}: ${formatCellText(groupField, labels[index]!, snapshot.fields, groupContext)}`;
              })
              .join(' / ')
          : '';
      return { text: [label, summary].filter(Boolean).join('\n') };
    }),
  });
  const scales = new Map(
    config.colorScales
      .filter((scale) => source.fields.some((field) => field.id === scale.fieldId && isScaleField(field)))
      .map((scale) => [scale.fieldId, scale]),
  );
  const ranges = new Map(
    (await viewRanges(source.pool, source.schemas, source.read, [...scales.keys()])).ranges.map((range) => [
      range.fieldId,
      range,
    ]),
  );
  let rowIndex = 0;
  // Hidden condition fields are read only if this recipient may see them.
  for await (const page of exportPages(
    { ...source, fields: source.read.fields },
    snapshotOrder(source, held),
  )) {
    for (const row of page.rows) {
      groups.forEach((group, index) => {
        if (group.start === rowIndex) layout.rows.push(groupRow(group, index));
      });
      const context = {
        timeZone: source.timeZone,
        now: source.read.context.now,
        linkedName: (id: string) => page.context.linked.get(id),
        fileName: (id: string) => page.context.files.get(id)?.name,
      };
      const recordRule = config.colorRules.find(
        (rule) => rule.target === 'record' && colorRuleMatches(rule, row, page.read, context),
      );
      layout.rows.push({
        kind: 'record',
        cells: source.fields.map((field) => {
          const rule = config.colorRules.find(
            (candidate) =>
              candidate.target === 'cell' &&
              candidate.condition.fieldId === field.id &&
              colorRuleMatches(candidate, row, page.read, context),
          );
          const scale = scales.get(field.id);
          const fill = rule
            ? `#${HEADER_COLOR_RGB[rule.color]}`
            : ((scale ? scaleColor(scale, field, cellValue(row, field), ranges.get(field.id)) : undefined) ??
              (recordRule ? `#${HEADER_COLOR_RGB[recordRule.color]}` : undefined));
          const value = cellValue(row, field);
          return {
            text:
              field.type === 'longText' && field.options.richText && typeof value === 'string'
                ? richTextWords(markdownToDoc(value), source.locale)
                : formatCellText(field, row, page.read, page.context),
            ...(fill ? { fill } : {}),
          };
        }),
      });
      rowIndex++;
    }
  }
  const records = viewRecords(
    source.read.table,
    source.read.view,
    source.read.fields,
    source.scope,
    source.schemas,
    source.read.context,
  );
  if (source.read.view.type === 'grid' && Object.values(config.summaries).some((kind) => kind !== 'none')) {
    const totals = await withTransaction(source.pool, (db) =>
      gridSummary(db, records, config, () => undefined),
    );
    layout.rows.push({
      kind: 'total',
      cells: source.fields.map((field, index) => {
        const summary = summaryText(
          field.id === source.read.table.primaryFieldId
            ? { kind: 'count', value: totals.records }
            : totals.values[field.id],
          field,
          groupContext,
        );
        return {
          text: [index === 0 ? reportWord('total', source.locale) : '', summary].filter(Boolean).join('\n'),
        };
      }),
    });
  }
  if (source.read.view.type === 'chart' && config.chart.groupBy) {
    const answer = await chartAggregate(source.pool, records, config.chart, () => undefined);
    if (answer.kind === 'chart') {
      layout.charts.push(await reportChart(answer, source.locale, config.chart.chart));
      layout.notes.push('reports.pdf.chartSimplified');
      if (answer.capped.categories || answer.capped.series) layout.notes.push('reports.pdf.chartCapped');
    } else layout.notes.push('reports.pdf.chartUnavailable');
  }
  if (config.dataBars.length || config.iconSets.length || config.sparklines.length)
    layout.notes.push('reports.pdf.visualSimplified');
  return layout;
}

export function reportLayoutHtml(layout: ReportLayout): string {
  const cell = (value: ReportCell, tag: 'th' | 'td') =>
    `<${tag} dir="auto"${value.fill ? ` style="background-color:${value.fill}"` : ''}>${escapeHtml(value.text).replaceAll('\n', '<br>')}</${tag}>`;
  const tables = reportColumnSections(layout)
    .map((columns) => {
      const rows = layout.rows
        .map(
          (row) =>
            `<tr class="report-${row.kind}">${columns.map((column) => cell(row.cells[column] ?? { text: '' }, 'td')).join('')}</tr>`,
        )
        .join('');
      return `<table class="report-table" border="1" cellpadding="6" cellspacing="0"><thead><tr>${columns.map((column) => cell(layout.columns[column]!, 'th')).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  return `<article><h1 dir="auto">${escapeHtml(layout.title)}</h1><p dir="auto">${escapeHtml(layout.subtitle)}</p><p>${escapeHtml(reportWord('count', layout.locale, { count: layout.count }))}</p>${layout.caption ? `<p>${escapeHtml(layout.caption)}</p>` : ''}${layout.charts.map((chart) => `<figure><img src="${chart.image}" alt="${escapeHtml(chart.text)}"><figcaption dir="auto">${escapeHtml(chart.text)}</figcaption></figure>`).join('')}${layout.columns.length ? tables : `<p>${escapeHtml(reportWord('empty', layout.locale))}</p>`}</article>`;
}
