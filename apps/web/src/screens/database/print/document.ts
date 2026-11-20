import { createViewColors, type ViewColors } from '../colors/paint';
import { sparklineSvg, type SparklinePaint } from '../colors/sparklines';
import { FALLBACK_THEME } from '../dashboards/chart-theme';
import { sparklineValues, sparklineSummary, type FieldRange } from '@riosoma/contracts';
import { HEADER_COLOR_RGB } from '@riosoma/contracts';
import type { GridGroupBoundary } from '@riosoma/contracts';
import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import {
  cellValue,
  EMPTY_STACK,
  idsOf,
  isComputedType,
  isSignaturePath,
  isSignatureSize,
  isSignatureValue,
  prettyJson,
  type FieldMeta,
  type GridConfig,
  type RowData,
  type SignatureDrawing,
  type SignatureValue,
} from '@riosoma/contracts';
import type {
  Alignment,
  Column,
  Content,
  CustomTableLayout,
  StyleDictionary,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import { resultType } from '../../../data/formulas';
import { buttonTarget } from '../../../fields/buttons';
import { summaryValueText } from '../../../grid/summary/text';
import { groupValueText } from '../../../grid/grouping/text';
import { formatCell, signatureText, type FormatContext } from '../../../grid/format';
import { isStackField, orderStacks, rowStack, type Stack } from '../views/kanban/model';
import { CARD_WIDTH, cardHeight, chartLayout, visibleChart } from '../views/org-chart/layout';
import { columnWidth, type Orientation, type PageSize, type PrintableViewType } from './options';

/**
 * What a printout is made of, as a PDF document definition: a pure function of the records, the
 * choices in the print dialog, and who is printing, so the same records always make the same
 * pages.  Values read the way the grid shows them, in the reader's language and time zone.  Grids
 * become tables, galleries and kanbans become cards, and one record becomes its fields as labels
 * and values.
 */

export interface PrintSettings {
  title: string;
  pageSize: PageSize;
  orientation: Orientation;
  /** The fields to print, in order, with the primary field first */
  fields: readonly FieldMeta[];
}

export interface PrintContext {
  i18n: I18n;
  colors?: ViewColors;
  format: FormatContext;
  databaseName: string;
  /** Where the records come from: the view's name, or the table's for one record */
  sourceName: string;
  printedAt: Date;
}

/** The view a printout comes from. */
export interface ViewSource {
  groups?: readonly GridGroupBoundary[];
  type: PrintableViewType;
  config: GridConfig;
  primaryFieldId: string;
  /** Every field of the table, which a kanban finds its stack field in */
  tableFields: readonly FieldMeta[];
}

const labels = {
  header: (i18n: I18n, database: string, source: string) =>
    i18n._(msg({ id: 'print.header', message: `${database} – ${source}` })),
  page: (i18n: I18n, page: number, count: number) =>
    i18n._(msg({ id: 'print.page', message: `Page ${page} of ${count}` })),
  count: (i18n: I18n, count: number) =>
    i18n._(msg({ id: 'print.count', message: plural(count, { one: '# record', other: '# records' }) })),
  empty: (i18n: I18n) => i18n._(msg({ id: 'print.empty', message: 'No records' })),
  untitled: (i18n: I18n) => i18n._(msg({ id: 'record.untitled', message: 'Untitled record' })),
  error: (i18n: I18n) => i18n._(msg({ id: 'grid.formula.error', message: '#ERROR' })),
  emptyStack: (i18n: I18n, field: string) => i18n._(msg({ id: 'kanban.empty', message: `No ${field}` })),
};

/** Paper in points, portrait. */
const PAPER: Record<PageSize, [number, number]> = { LETTER: [612, 792], A4: [595.28, 841.89] };

/** Left, top, right, and bottom, in points.  The header and footer sit in the top and bottom. */
export const PAGE_MARGINS: [number, number, number, number] = [40, 56, 40, 48];

/** Text that reads as secondary on white, with contrast to spare once printed. */
const MUTED = '#555555';
const LINE = '#c4c4c4';
const HEADER_FILL = '#f0f0f0';
const INK = '#1a1a1a';

/** Line height as a multiple of the font size, for the whole document. */
const LINE_HEIGHT = 1.15;

/** The narrowest a table column gets, however many fields share the page. */
const MIN_COLUMN = 24;

/** Cell padding on each side of a table cell. */
const CELL_PADDING = 4;

const CARD_PADDING = 6;
const CARD_GAP = 10;

/** About how tall a kanban stack's name and count are, with the space around them. */
const STACK_HEADING = 48;

/** Long text on a card stops after this many characters, the way a card on screen cuts it off. */
const CARD_TEXT = 280;

/**
 * Cards and stack headings stay together on a page when they fit comfortably.  A block taller than
 * a page can't be kept together, and the PDF library drops one rather than splitting it, so only
 * blocks estimated well under a page are kept together.
 */
const KEEP_TOGETHER = 0.7;

/** Types whose values line up at the end, the way the grid lines up numbers. */
const END_ALIGNED = new Set<FieldMeta['type']>(['number', 'currency', 'percent', 'duration', 'autoNumber']);

const styles: StyleDictionary = {
  title: { fontSize: 18, bold: true, color: INK },
  subtitle: { fontSize: 10, color: MUTED },
  pageHeader: { fontSize: 8, color: MUTED },
  columnHeader: { bold: true, color: INK },
  label: { fontSize: 7.5, color: MUTED },
  recordLabel: { fontSize: 9, color: MUTED },
  cardTitle: { fontSize: 10, bold: true, color: INK },
  stack: { fontSize: 12, bold: true, color: INK },
};

/** The part of the page that holds content, in points. */
export function contentBox(size: PageSize, orientation: Orientation): { width: number; height: number } {
  const [short, long] = PAPER[size];
  const [width, height] = orientation === 'portrait' ? [short, long] : [long, short];
  return {
    width: width - PAGE_MARGINS[0] - PAGE_MARGINS[2],
    height: height - PAGE_MARGINS[1] - PAGE_MARGINS[3],
  };
}

function printedAtText(context: PrintContext): string {
  const { locale, timeZone } = context.format;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short', timeZone }).format(
      context.printedAt,
    );
  } catch {
    return context.printedAt.toISOString();
  }
}

/** The frame every page shares: where the records come from and when, and the page number. */
function frame(
  settings: PrintSettings,
  context: PrintContext,
): Pick<
  TDocumentDefinitions,
  'info' | 'pageSize' | 'pageOrientation' | 'pageMargins' | 'defaultStyle' | 'styles' | 'header' | 'footer'
> {
  const { i18n } = context;
  const names = [context.databaseName, context.sourceName].filter((name) => name.trim() !== '');
  const source = names.length === 2 ? labels.header(i18n, names[0]!, names[1]!) : (names[0] ?? '');
  const date = printedAtText(context);
  const [left, , right] = PAGE_MARGINS;
  return {
    info: { title: titleOf(settings, context), subject: source, creator: 'Riosoma' },
    pageSize: settings.pageSize,
    pageOrientation: settings.orientation,
    pageMargins: PAGE_MARGINS,
    defaultStyle: { fontSize: 9, lineHeight: LINE_HEIGHT, color: INK },
    styles,
    header: () => ({
      columns: [
        { text: source, width: '*' },
        { text: date, width: 'auto', alignment: 'right' },
      ],
      columnGap: 12,
      style: 'pageHeader',
      margin: [left, 24, right, 0],
    }),
    footer: (page: number, count: number) => ({
      text: labels.page(i18n, page, count),
      alignment: 'center',
      style: 'pageHeader',
      margin: [left, 16, right, 0],
    }),
  };
}

function titleOf(settings: PrintSettings, context: PrintContext): string {
  return settings.title.trim() || context.sourceName;
}

function heading(settings: PrintSettings, context: PrintContext, count: number | null): Content[] {
  const title: Content = { text: titleOf(settings, context), style: 'title', margin: [0, 0, 0, 2] };
  if (count === null) return [{ ...title, margin: [0, 0, 0, 12] }];
  return [title, { text: labels.count(context.i18n, count), style: 'subtitle', margin: [0, 0, 0, 12] }];
}

// ------------------------------------------------------------------------------------ values

type Mode = 'table' | 'card' | 'record';

/** The drawing as an SVG, or null when it isn't one the signature pad could have drawn. */
export function signatureSvg(drawing: SignatureDrawing): string | null {
  const { path, width, height } = drawing;
  // Only moves, lines, and numbers pass, so nothing else can reach the markup.
  if (!isSignaturePath(path) || !isSignatureSize(width) || !isSignatureSize(height)) return null;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${path}" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
  );
}

/** How big a signature is drawn, in points. */
const SIGNATURE_BOX: Record<Mode, [number, number]> = {
  table: [90, 24],
  card: [120, 30],
  record: [220, 80],
};

function signatureContent(value: SignatureValue, context: PrintContext, mode: Mode): Content {
  const text: Content = {
    text: signatureText(value, context.format),
    style: mode === 'record' ? undefined : 'label',
  };
  const svg = value.drawing ? signatureSvg(value.drawing) : null;
  if (svg) return { stack: [{ svg, fit: SIGNATURE_BOX[mode], margin: [0, 0, 0, 2] }, text] };
  // Nothing was drawn, so the typed name is the signature.
  return value.name
    ? { stack: [{ text: value.name, italics: true, fontSize: mode === 'record' ? 14 : 10 }, text] }
    : text;
}

function printedSparkline(paint: SparklinePaint): string {
  // Paper uses the base token palette so dark schemes cannot leave pale marks on a white page.
  const theme = FALLBACK_THEME;
  const indices = { accent: 0, blue: 1, green: 3, red: 5, purple: 4, gray: 10 };
  return sparklineSvg(paint, {
    series: theme.palette[indices[paint.setting.color]]!,
    highlight: theme.palette[paint.setting.color === 'gray' ? 0 : 10]!,
    negative: theme.palette[5]!,
  });
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** One field's value for one record, as the grid words it. */
export function valueContent(field: FieldMeta, row: RowData, context: PrintContext, mode: Mode): Content {
  if (row.errors?.[field.id]) return { text: labels.error(context.i18n) };
  const chart = context.colors?.cell(row, field)?.sparkline;
  if (chart)
    return {
      stack: [
        { svg: printedSparkline(chart), fit: [100, 24] },
        { text: chart.label, style: 'label' },
      ],
    };
  const value = cellValue(row, field);
  const { format } = context;
  switch (field.type) {
    case 'signature':
      return isSignatureValue(value) ? signatureContent(value, context, mode) : { text: '' };
    case 'button': {
      // A printed page has no buttons, so a button reads as the link it opens, as a download does.
      const target = buttonTarget(field, row, format);
      return target.ok ? { text: target.url, link: target.url, decoration: 'underline' } : { text: '' };
    }
    case 'attachment':
    case 'link': {
      if (mode !== 'record') break;
      // A record lists its files and linked records one to a line.
      const names = idsOf(value).map((id) =>
        field.type === 'attachment'
          ? (format.attachments?.get(id)?.name ?? id)
          : (format.linked?.get(id) ?? id),
      );
      return names.length > 1 ? { ul: names, margin: [0, 0, 0, 0] } : { text: names[0] ?? '' };
    }
    case 'json':
      if (mode === 'record' && typeof value === 'string')
        return { text: prettyJson(value), preserveLeadingSpaces: true, fontSize: 8.5 };
      break;
    default:
      break;
  }
  const text = formatCell(field, value, format);
  return { text: mode === 'card' ? clip(text, CARD_TEXT) : text };
}

/** Numbers line up at the end of a column, the same columns the grid lines up. */
function alignmentOf(field: FieldMeta): Alignment | undefined {
  return END_ALIGNED.has(field.type) || (isComputedType(field.type) && resultType(field) === 'number')
    ? 'right'
    : undefined;
}

// ------------------------------------------------------------------------------------ tables

const TABLE_LAYOUT: CustomTableLayout = {
  hLineWidth: (index) => (index === 1 ? 0.75 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  fillColor: (index) => (index === 0 ? HEADER_FILL : null),
  paddingLeft: () => CELL_PADDING,
  paddingRight: () => CELL_PADDING,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

/**
 * Column widths in points: the view's own widths, scaled together so the table fills the page.
 * Very many fields still get a readable minimum, even if that runs past the edge.
 */
export function tableWidths(
  fields: readonly FieldMeta[],
  source: Pick<ViewSource, 'config' | 'primaryFieldId'>,
  pageWidth: number,
): number[] {
  const pixels = fields.map((field) => columnWidth(source.config, field.id, source.primaryFieldId));
  const total = pixels.reduce((sum, width) => sum + width, 0) || 1;
  const room = pageWidth - fields.length * CELL_PADDING * 2;
  return pixels.map((width) => Math.max(MIN_COLUMN, Math.floor((width / total) * room * 100) / 100));
}

function tableContent(
  rows: readonly RowData[],
  settings: PrintSettings,
  source: ViewSource,
  context: PrintContext,
): Content {
  const { fields } = settings;
  const box = contentBox(settings.pageSize, settings.orientation);
  const aligned = fields.map(alignmentOf);
  const header: TableCell[] = fields.map((field, index) => ({
    text: field.name,
    style: 'columnHeader',
    ...(source.config.headerColors[field.id]
      ? { fillColor: `#${HEADER_COLOR_RGB[source.config.headerColors[field.id]!]}` }
      : {}),
    ...(aligned[index] ? { alignment: aligned[index] } : {}),
  }));
  const bands: TableCell[][] = source.config.columnGroups.length
    ? [
        fields.map((field, index) => {
          const group = source.config.columnGroups.find((item) => item.fieldIds.includes(field.id));
          if (group && index > 0 && group.fieldIds.includes(fields[index - 1]!.id)) return {};
          let end = index + 1;
          while (group && end < fields.length && group.fieldIds.includes(fields[end]!.id)) end++;
          return {
            text: group?.name ?? '',
            ...(group ? { colSpan: end - index } : {}),
            bold: true,
            ...(group?.color ? { fillColor: `#${HEADER_COLOR_RGB[group.color]}` } : {}),
          };
        }),
      ]
    : [];
  const boundaries = new Map<number, NonNullable<ViewSource['groups']>[number][]>();
  for (const group of source.groups ?? []) {
    const at = boundaries.get(group.start) ?? [];
    at.push(group);
    boundaries.set(group.start, at);
  }
  const body: TableCell[][] = rows.flatMap((row, rowIndex) => {
    const headers: TableCell[][] = (boundaries.get(rowIndex) ?? []).map((group) =>
      fields.map((field, index) => {
        const summary = group.summaries[field.id];
        if (index !== 0) {
          return { text: summary ? summaryValueText(field, summary, context.format) : '', bold: true };
        }
        const fieldId = Object.keys(group.values).at(-1)!;
        const grouped = source.tableFields.find((item) => item.id === fieldId);
        const value = group.values[fieldId];
        const name = groupValueText(grouped, value, context.format, context.i18n._.bind(context.i18n));
        const count = labels.count(context.i18n, group.count);
        return {
          stack: [
            { text: context.i18n._(msg({ id: 'grid.group.description', message: `${name}, ${count}` })) },
            ...(summary ? [{ text: summaryValueText(field, summary, context.format) }] : []),
          ],
          bold: true,
          margin: [(group.level - 1) * 10, 2, 0, 2],
        };
      }),
    );
    return [
      ...headers,
      fields.map((field, index) => {
        const cell = valueContent(field, row, context, 'table');
        return aligned[index] ? { stack: [cell], alignment: aligned[index] } : cell;
      }),
    ];
  });
  return {
    table: {
      headerRows: 1 + bands.length,
      widths: tableWidths(fields, source, box.width),
      body: [...bands, header, ...body],
    },
    layout: TABLE_LAYOUT,
    // Many columns share the page, so each gets smaller type rather than fewer words to a line.
    fontSize: fields.length > 10 ? 7.5 : 8.5,
  };
}

// ------------------------------------------------------------------------------------- cards

const CARD_LAYOUT: CustomTableLayout = {
  hLineWidth: () => 0.75,
  vLineWidth: () => 0.75,
  hLineColor: () => LINE,
  vLineColor: () => LINE,
  paddingLeft: () => CARD_PADDING,
  paddingRight: () => CARD_PADDING,
  paddingTop: () => CARD_PADDING,
  paddingBottom: () => CARD_PADDING,
};

/** Cards to a row: the gallery's card size decides, and landscape fits one more. */
export function cardsPerRow(source: ViewSource, orientation: Orientation): number {
  const wide = orientation === 'landscape' ? 1 : 0;
  if (source.type === 'gallery') {
    const size = source.config.gallery.cardSize;
    return (size === 'small' ? 3 : size === 'medium' ? 2 : 1) + wide;
  }
  return 2 + wide;
}

/** Wider than the font's average, so an estimate errs on the tall side. */
const EM_PER_CHARACTER = 0.62;
/** Ideographs and other full-width characters take a whole em. */
const EM_PER_WIDE = 1.05;
/** A line's height, as a multiple of the font size, with room to spare. */
const ESTIMATED_LEADING = 1.45;

/** About how many lines text takes at a width, rounded up everywhere. */
export function estimateLines(text: string, fontSize: number, width: number): number {
  let lines = 0;
  for (const line of text.split('\n')) {
    let ems = 0;
    for (const character of line)
      ems += (character.codePointAt(0) ?? 0) >= 0x2e80 ? EM_PER_WIDE : EM_PER_CHARACTER;
    // Words wrap whole, which leaves up to a word's room at the end of every line.
    lines += Math.max(1, Math.ceil((ems * fontSize * 1.2) / Math.max(1, width)));
  }
  return lines;
}

function textHeight(text: string, fontSize: number, width: number): number {
  return estimateLines(text, fontSize, width) * fontSize * ESTIMATED_LEADING;
}

/** One card: the record's title, then each other field's name and value.  Height is an estimate. */
function card(
  row: RowData,
  settings: PrintSettings,
  primaryFieldId: string,
  context: PrintContext,
  width: number,
): { content: Content; height: number } {
  const primary = settings.fields.find((field) => field.id === primaryFieldId);
  const others = settings.fields.filter((field) => field.id !== primaryFieldId);
  const inner = width - CARD_PADDING * 2;
  const title =
    (primary ? formatCell(primary, cellValue(row, primary), context.format).trim() : '') ||
    labels.untitled(context.i18n);
  let height = CARD_PADDING * 2 + 2 + textHeight(title, 10, inner) + 4;
  const stack: Content[] = [{ text: clip(title, CARD_TEXT), style: 'cardTitle', margin: [0, 0, 0, 4] }];
  for (const field of others) {
    const value = valueContent(field, row, context, 'card');
    stack.push({ stack: [{ text: field.name, style: 'label' }, value], margin: [0, 0, 0, 3] });
    const text = formatCell(field, cellValue(row, field), context.format);
    height +=
      textHeight(field.name, 7.5, inner) +
      textHeight(clip(text, CARD_TEXT), 9, inner) +
      (field.type === 'signature' ? SIGNATURE_BOX.card[1] + 2 : 0) +
      3;
  }
  return { content: { table: { widths: ['*'], body: [[{ stack }]] }, layout: CARD_LAYOUT }, height };
}

/** Cards in rows across the page.  A row stays on one page when it fits well within one. */
function cardRows(
  rows: readonly RowData[],
  settings: PrintSettings,
  source: ViewSource,
  context: PrintContext,
): Array<{ content: Content; height: number }> {
  const box = contentBox(settings.pageSize, settings.orientation);
  const perRow = cardsPerRow(source, settings.orientation);
  const width = (box.width - CARD_GAP * (perRow - 1)) / perRow;
  const result: Array<{ content: Content; height: number }> = [];
  for (let start = 0; start < rows.length; start += perRow) {
    const cards = rows
      .slice(start, start + perRow)
      .map((row) => card(row, settings, source.primaryFieldId, context, width));
    const height = Math.max(...cards.map((item) => item.height)) + CARD_GAP;
    const columns: Column[] = cards.map((item) => ({ width: '*', stack: [item.content] }));
    // An unfinished last row keeps its cards the width of every other row's.
    while (columns.length < perRow) columns.push({ width: '*', text: '' });
    result.push({
      content: {
        columns,
        columnGap: CARD_GAP,
        margin: [0, 0, 0, CARD_GAP],
        ...(height <= box.height * KEEP_TOGETHER ? { unbreakable: true } : {}),
      },
      height,
    });
  }
  return result;
}

/** A kanban's stacks in the board's order, each with its records in the view's order. */
export function kanbanStacks(
  rows: readonly RowData[],
  source: ViewSource,
  context: PrintContext,
): Array<{ stack: Stack; rows: RowData[] }> | null {
  const settings = source.config.kanban;
  const field = source.tableFields.find((item) => item.id === settings.stackFieldId && isStackField(item));
  if (!field) return null;
  const base: Stack[] =
    field.type === 'singleSelect'
      ? field.options.choices.map((choice) => ({ id: choice.id, name: choice.name }))
      : [...context.format.collaborators].map(([id, person]) => ({ id, name: person.name, person: true }));
  base.push({ id: EMPTY_STACK, name: labels.emptyStack(context.i18n, field.name) });
  const known = new Set(base.map((stack) => stack.id));
  const grouped = new Map<string, RowData[]>();
  for (const row of rows) {
    // A choice or person that is gone leaves its records with the ones that have none.
    const id = rowStack(row, field);
    const stack = known.has(id) ? id : EMPTY_STACK;
    const records = grouped.get(stack);
    if (records) records.push(row);
    else grouped.set(stack, [row]);
  }
  return orderStacks(base, settings.stackOrder)
    .filter((stack) => !settings.hiddenStacks.includes(stack.id))
    .map((stack) => ({ stack, rows: grouped.get(stack.id) ?? [] }))
    .filter((entry) => !settings.hideEmptyStacks || entry.rows.length > 0);
}

function cardsContent(
  rows: readonly RowData[],
  settings: PrintSettings,
  source: ViewSource,
  context: PrintContext,
): Content[] {
  const stacks = source.type === 'kanban' ? kanbanStacks(rows, source, context) : null;
  if (!stacks) return cardRows(rows, settings, source, context).map((row) => row.content);
  const box = contentBox(settings.pageSize, settings.orientation);
  return stacks.flatMap(({ stack, rows: records }) => {
    const title: Content = {
      stack: [
        { text: stack.name, style: 'stack' },
        { text: labels.count(context.i18n, records.length), style: 'subtitle' },
      ],
      margin: [0, 6, 0, 6],
    };
    const [first, ...rest] = cardRows(records, settings, source, context);
    if (!first) return [title];
    // A stack's name never sits alone at the foot of a page.
    const opening: Content =
      first.height + STACK_HEADING <= box.height * KEEP_TOGETHER
        ? { stack: [title, first.content], unbreakable: true }
        : { stack: [title, first.content] };
    return [opening, ...rest.map((row) => row.content)];
  });
}

// --------------------------------------------------------------------------------- documents

/** A view's records as a printout: a table for a grid, cards for a gallery or a kanban. */
/** Print large trees in readable tiles, including connectors that cross page boundaries. */
function orgChartContent(
  rows: readonly RowData[],
  settings: PrintSettings,
  source: ViewSource,
  context: PrintContext,
): Content[] {
  const parent = source.tableFields.find((field) => field.id === source.config.orgChart.parentFieldId);
  if (!parent) return cardsContent(rows, settings, source, context);
  const fields = settings.fields.filter((field) => field.id !== source.primaryFieldId);
  const primary = source.tableFields.find((field) => field.id === source.primaryFieldId);
  const height = cardHeight(fields.length);
  const layout = chartLayout(rows, parent, new Set(), height);
  const box = contentBox(settings.pageSize, settings.orientation);
  const scale = Math.min(0.7, (box.height - 100) / height);
  const width = box.width / scale;
  const pageHeight = (box.height - 100) / scale;
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!,
    );
  const pages: Content[] = [];
  for (let top = 0; top < layout.height; top += pageHeight) {
    for (let left = 0; left < layout.width; left += width) {
      const drawn = visibleChart(layout, { x: -left, y: -top, zoom: 1 }, { width, height: pageHeight });
      if (!drawn.nodes.length && !drawn.edges.length) continue;
      const edges = drawn.edges
        .map((edge) => `<path d="${edge.path}" fill="none" stroke="${LINE}" stroke-width="2"/>`)
        .join('');
      const cards = drawn.nodes
        .map((node) => {
          const row = node.row!;
          const name =
            (primary ? formatCell(primary, cellValue(row, primary), context.format) : '') ||
            labels.untitled(context.i18n);
          const lines = [
            name,
            ...fields.map(
              (field) => `${field.name}: ${formatCell(field, cellValue(row, field), context.format)}`,
            ),
          ];
          const text = lines
            .map(
              (line, index) =>
                `<text x="${node.x + 12}" y="${node.y + 28 + index * 24}" font-size="13" fill="${INK}">${escape(line.slice(0, 28))}</text>`,
            )
            .join('');
          return `<rect x="${node.x}" y="${node.y}" width="${CARD_WIDTH}" height="${height}" rx="8" fill="${HEADER_FILL}" stroke="${LINE}"/>${text}`;
        })
        .join('');
      pages.push({
        svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height - 100}" viewBox="${left} ${top} ${width} ${pageHeight}">${edges}${cards}</svg>`,
        width: box.width,
        height: box.height - 100,
        ...(pages.length ? { pageBreak: 'before' as const } : {}),
      });
    }
  }
  return pages;
}

export function viewDocument(
  rows: readonly RowData[],
  settings: PrintSettings,
  source: ViewSource,
  context: PrintContext,
): TDocumentDefinitions {
  const ranges = new Map<string, FieldRange>();
  for (const setting of source.config.sparklines) {
    const field = source.tableFields.find((field) => field.id === setting.fieldId);
    if (!field || !setting.sharedAxis) continue;
    let min = Infinity,
      max = -Infinity;
    for (const row of rows) {
      const summary = sparklineSummary(sparklineValues(row, field, setting));
      if (summary) {
        min = Math.min(min, summary.min);
        max = Math.max(max, summary.max);
      }
    }
    if (Number.isFinite(min)) ranges.set(field.id, { fieldId: field.id, min, max });
  }
  context = {
    ...context,
    colors: createViewColors({
      config: source.config,
      fields: source.tableFields,
      ranges,
      context: { timeZone: context.format.timeZone },
      i18n: context.i18n,
      label: (rule) => rule.name,
    }),
  };
  const body: Content[] = !rows.length
    ? [{ text: labels.empty(context.i18n), style: 'subtitle' }]
    : source.type === 'orgChart'
      ? orgChartContent(rows, settings, source, context)
      : source.type === 'grid'
        ? [tableContent(rows, settings, source, context)]
        : cardsContent(rows, settings, source, context);
  return { ...frame(settings, context), content: [...heading(settings, context, rows.length), ...body] };
}

const RECORD_LAYOUT: CustomTableLayout = {
  hLineWidth: (index, node) => (index === 0 || index === node.table.body.length ? 0 : 0.5),
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  paddingLeft: (index) => (index === 0 ? 0 : 8),
  paddingRight: (index) => (index === 0 ? 8 : 0),
  paddingTop: () => 5,
  paddingBottom: () => 5,
};

/** One record as a printout: each chosen field's name and value, one to a row. */
export function recordDocument(
  row: RowData,
  settings: PrintSettings,
  context: PrintContext,
): TDocumentDefinitions {
  const box = contentBox(settings.pageSize, settings.orientation);
  const body: TableCell[][] = settings.fields.map((field) => [
    { text: field.name, style: 'recordLabel' },
    valueContent(field, row, context, 'record'),
  ]);
  return {
    ...frame(settings, context),
    defaultStyle: { fontSize: 10, lineHeight: LINE_HEIGHT, color: INK },
    content: [
      ...heading(settings, context, null),
      body.length
        ? {
            table: { widths: [Math.round(box.width * 0.3), '*'], body },
            layout: RECORD_LAYOUT,
          }
        : { text: '' },
    ],
  };
}
