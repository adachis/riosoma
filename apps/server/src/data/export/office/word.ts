import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type INumberingOptions,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import type { RichBlock, RichInline, RichListItem, RichTaskItem } from '@riosoma/contracts';
import { CHECK_MARK, type DocumentValue } from './cells.js';
import type { DocumentImage } from './images.js';

/**
 * Word documents.  The builders here take what a document says, already worded in the person's
 * language, and lay it out: a view as a title, a few lines about it, and a table per group whose
 * header row repeats on every page, and a record as its fields, one label and value after another,
 * with its images and, when asked for, its comments.  Every page is numbered at the bottom.
 */

export type Paper = 'letter' | 'a4';

/** Page sizes in twentieths of a point, portrait */
const PAPER: Record<Paper, { width: number; height: number }> = {
  letter: { width: 12_240, height: 15_840 },
  a4: { width: 11_906, height: 16_838 },
};

/** Three quarters of an inch on every side */
const MARGIN = 1_080;

/** Twentieths of a point in a pixel, as Word sizes an image */
const TWIPS_PER_PIXEL = 15;

/** Where US Letter is the usual paper, from the Unicode CLDR's paper size data */
const LETTER_REGIONS = new Set([
  'BZ',
  'CA',
  'CL',
  'CO',
  'CR',
  'GT',
  'MX',
  'NI',
  'PA',
  'PH',
  'PR',
  'SV',
  'US',
  'VE',
]);

const INK = '1A1A1A';
const MUTED = '555555';
const LINE = 'C4C4C4';
const HEADER_FILL = 'F0F0F0';
const CODE_FILL = 'F4F4F4';
const MONOSPACE = 'Courier New';

/** Sizes in half points */
const SIZE = { body: 20, small: 18, label: 16 } as const;

/** The paragraph style a table's values are set in */
const CELL_STYLE = 'RioCell';

/** Letter or A4 for someone reading in `locale`, by the region it names or implies. */
export function paperFor(locale: string): Paper {
  try {
    const tag = new Intl.Locale(locale);
    const region = tag.region ?? tag.maximize().region;
    return region !== undefined && LETTER_REGIONS.has(region) ? 'letter' : 'a4';
  } catch {
    return 'a4';
  }
}

function contentWidth(paper: Paper, landscape: boolean): number {
  const size = PAPER[paper];
  return (landscape ? size.height : size.width) - 2 * MARGIN;
}

function contentHeight(paper: Paper, landscape: boolean): number {
  const size = PAPER[paper];
  return (landscape ? size.width : size.height) - 2 * MARGIN;
}

/* ------------------------------------------------------------------------------------------------
 * Lists
 * --------------------------------------------------------------------------------------------- */

const BULLET = 'rio-bullet';
const BULLETS = ['•', '◦', '▪'];
const LEVELS = 9;
/** Indent per list level, in twentieths of a point */
const LIST_INDENT = 360;

/**
 * The numbering a document's lists use.  Numbered lists that start somewhere other than one each
 * get a definition of their own, and every numbered list is its own instance, so each counts from
 * its own start rather than carrying on from the last.
 */
class ListNumbering {
  private readonly starts = new Set<number>();
  private instances = 0;

  bullet(level: number) {
    return { reference: BULLET, level: Math.min(level, LEVELS - 1) };
  }

  /** A new numbered list, whose items share the returned instance. */
  ordered(start: number): (level: number) => { reference: string; level: number; instance: number } {
    this.starts.add(start);
    const instance = ++this.instances;
    return (level) => ({ reference: `rio-number-${start}`, level: Math.min(level, LEVELS - 1), instance });
  }

  options(): INumberingOptions {
    const indent = (level: number) => ({ left: LIST_INDENT * (level + 1), hanging: 260 });
    const bullets: ILevelsOptions[] = Array.from({ length: LEVELS }, (_, level) => ({
      level,
      format: LevelFormat.BULLET,
      text: BULLETS[level % BULLETS.length]!,
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: indent(level) } },
    }));
    const numbers = (start: number): ILevelsOptions[] =>
      Array.from({ length: LEVELS }, (_, level) => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.LEFT,
        start: level === 0 ? start : 1,
        style: { paragraph: { indent: indent(level) } },
      }));
    return {
      config: [
        { reference: BULLET, levels: bullets },
        ...[...this.starts].map((start) => ({ reference: `rio-number-${start}`, levels: numbers(start) })),
      ],
    };
  }
}

/* ------------------------------------------------------------------------------------------------
 * Rich text
 * --------------------------------------------------------------------------------------------- */

interface RichContext {
  size: number;
  lists: ListNumbering;
  /** Left indent for blocks inside a list item or a quote */
  indent: number;
}

function textRuns(text: string, run: IRunOptions): TextRun[] {
  return text
    .split('\n')
    .map((line, index) => new TextRun({ ...run, text: line, ...(index ? { break: 1 } : {}) }));
}

function inline(nodes: readonly RichInline[] | undefined, run: IRunOptions): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      out.push(new TextRun({ ...run, break: 1 }));
      continue;
    }
    let options: IRunOptions = { ...run, text: node.text };
    let href: string | null = null;
    for (const mark of node.marks ?? []) {
      if (mark.type === 'bold') options = { ...options, bold: true };
      else if (mark.type === 'italic') options = { ...options, italics: true };
      else if (mark.type === 'strike') options = { ...options, strike: true };
      else if (mark.type === 'code') options = { ...options, font: MONOSPACE };
      else href = mark.attrs.href;
    }
    if (href) {
      // The link style's own color and underline, rather than the text's color.
      const { color: _color, ...linked } = options;
      out.push(
        new ExternalHyperlink({ link: href, children: [new TextRun({ ...linked, style: 'Hyperlink' })] }),
      );
    } else out.push(new TextRun(options));
  }
  return out;
}

function listParagraphs(
  items: ReadonlyArray<RichListItem | RichTaskItem>,
  context: RichContext,
  level: number,
  marker: (item: number) => { numbering?: ReturnType<ListNumbering['bullet']>; prefix?: string },
): Paragraph[] {
  const out: Paragraph[] = [];
  items.forEach((item, index) => {
    const { numbering, prefix } = marker(index);
    item.content.forEach((block, position) => {
      if (position === 0 && (block.type === 'paragraph' || block.type === 'heading')) {
        const run = { size: context.size, color: INK };
        const children = [
          ...(prefix ? [new TextRun({ ...run, text: prefix })] : []),
          ...inline(block.content, run),
        ];
        out.push(
          new Paragraph({
            children,
            spacing: { after: 40 },
            ...(numbering
              ? { numbering }
              : { indent: { left: context.indent + LIST_INDENT * (level + 1), hanging: 260 } }),
          }),
        );
        return;
      }
      out.push(
        ...blocks([block], { ...context, indent: context.indent + LIST_INDENT * (level + 1) }, level + 1),
      );
    });
  });
  return out;
}

/** Rich text's blocks as paragraphs, with its lists nested `level` deep. */
function blocks(list: readonly RichBlock[], context: RichContext, level = 0): Paragraph[] {
  const out: Paragraph[] = [];
  const run: IRunOptions = { size: context.size, color: INK };
  const indent = context.indent ? { indent: { left: context.indent } } : {};
  for (const block of list) {
    switch (block.type) {
      case 'paragraph':
        out.push(new Paragraph({ children: inline(block.content, run), spacing: { after: 80 }, ...indent }));
        break;
      case 'heading':
        out.push(
          new Paragraph({
            children: inline(block.content, {
              ...run,
              bold: true,
              size: context.size + (7 - block.attrs.level) * 2,
            }),
            spacing: { before: 80, after: 60 },
            keepNext: true,
            ...indent,
          }),
        );
        break;
      case 'codeBlock':
        out.push(
          new Paragraph({
            children: textRuns((block.content ?? []).map((node) => node.text).join(''), {
              ...run,
              font: MONOSPACE,
            }),
            shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
            spacing: { after: 80 },
            ...indent,
          }),
        );
        break;
      case 'blockquote':
        for (const paragraph of blocks(block.content, { ...context, indent: context.indent + 240 }, level))
          out.push(paragraph);
        break;
      case 'bulletList':
        out.push(
          ...listParagraphs(block.content, context, level, () => ({
            numbering: context.lists.bullet(level),
          })),
        );
        break;
      case 'orderedList': {
        const numbered = context.lists.ordered(block.attrs.start);
        out.push(...listParagraphs(block.content, context, level, () => ({ numbering: numbered(level) })));
        break;
      }
      case 'taskList':
        out.push(
          ...listParagraphs(block.content, context, level, (index) => ({
            prefix: block.content[index]!.attrs.checked ? '☑ ' : '☐ ',
          })),
        );
        break;
    }
  }
  return out;
}

/**
 * A value as paragraphs: text keeps its line breaks, a checked box is a check mark.  In a table,
 * plain values take their size and color from the cell style rather than carrying their own,
 * since a document holds thousands of them.
 */
function valueParagraphs(value: DocumentValue, context: RichContext, inTable = false): Paragraph[] {
  const run: IRunOptions = inTable ? {} : { size: context.size, color: INK };
  const style = inTable ? { style: CELL_STYLE } : {};
  switch (value.kind) {
    case 'rich': {
      const paragraphs = blocks(value.doc.content, context);
      return paragraphs.length ? paragraphs : [new Paragraph({ ...style, children: [] })];
    }
    case 'check':
      return [
        new Paragraph({
          ...style,
          children: value.checked ? [new TextRun({ ...run, text: CHECK_MARK })] : [],
          ...(inTable ? { alignment: AlignmentType.CENTER } : {}),
        }),
      ];
    case 'text':
      return [
        new Paragraph({
          ...style,
          children: textRuns(value.text, run),
          ...(value.numeric && inTable ? { alignment: AlignmentType.RIGHT } : {}),
        }),
      ];
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pages
 * --------------------------------------------------------------------------------------------- */

/** Stand-ins for the page number fields while a page label is worded, from the private use area */
export const PAGE_SLOT = '\uE000';
export const PAGES_SLOT = '\uE001';

/** "Page 3 of 7" with Word's own fields in place, so it counts however the pages fall. */
function pageFooter(label: string): Footer {
  const run = { size: SIZE.label, color: MUTED };
  const children = label
    .split(/([\uE000\uE001])/)
    .filter(Boolean)
    .map((part) =>
      part === PAGE_SLOT
        ? new TextRun({ ...run, children: [PageNumber.CURRENT] })
        : part === PAGES_SLOT
          ? new TextRun({ ...run, children: [PageNumber.TOTAL_PAGES] })
          : new TextRun({ ...run, text: part }),
    );
  return new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children })] });
}

function heading(text: string): Paragraph {
  return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text, color: INK })] });
}

function lines(texts: readonly string[]): Paragraph[] {
  return texts.map(
    (text) =>
      new Paragraph({
        children: [new TextRun({ text, size: SIZE.body, color: MUTED })],
        spacing: { after: 60 },
      }),
  );
}

function note(text: string | null): Paragraph[] {
  return text
    ? [
        new Paragraph({
          children: [new TextRun({ text, size: SIZE.body, italics: true, color: INK })],
          border: { left: { style: BorderStyle.SINGLE, size: 18, color: LINE, space: 8 } },
          spacing: { before: 120, after: 120 },
        }),
      ]
    : [];
}

function pack(
  paper: Paper,
  landscape: boolean,
  meta: { title: string; pageLabel: string },
  lists: ListNumbering,
  children: Array<Paragraph | Table>,
): Promise<Buffer> {
  const size = PAPER[paper];
  const document = new Document({
    title: meta.title,
    creator: 'Riosoma',
    numbering: lists.options(),
    styles: {
      default: { document: { run: { font: 'Calibri', size: SIZE.body } } },
      paragraphStyles: [
        {
          id: CELL_STYLE,
          name: 'Table text',
          basedOn: 'Normal',
          run: { size: landscape ? SIZE.small : SIZE.body, color: INK },
          paragraph: { spacing: { after: 0 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: size.width,
              height: size.height,
              orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
          },
        },
        footers: { default: pageFooter(meta.pageLabel) },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}

/* ------------------------------------------------------------------------------------------------
 * A view
 * --------------------------------------------------------------------------------------------- */

export interface WordColumn {
  name: string;
  /** Wider for the primary field and for long text */
  weight: number;
}

export interface WordGroup {
  /** The group's heading with its count, or null for a view that doesn't group */
  heading: string | null;
  rows: DocumentValue[][];
}

export interface WordViewInput {
  title: string;
  /** Lines under the title: where it's from and when, how many records, and the filter */
  lines: string[];
  /** Why the file stops short of the view, when it does */
  note: string | null;
  columns: WordColumn[];
  groups: WordGroup[];
  /** What an empty group or view says */
  empty: string;
  paper: Paper;
  /** Sideways, for a table too wide for a portrait page */
  landscape: boolean;
  /** "Page 1 of 2", with `PAGE_SLOT` and `PAGES_SLOT` for the numbers */
  pageLabel: string;
}

function viewTable(input: WordViewInput, rows: readonly DocumentValue[][], lists: ListNumbering): Table {
  const width = contentWidth(input.paper, input.landscape);
  const total = input.columns.reduce((sum, column) => sum + column.weight, 0) || 1;
  const widths = input.columns.map((column) => Math.max(400, Math.floor((width * column.weight) / total)));
  const size = input.landscape ? SIZE.small : SIZE.body;
  const context: RichContext = { size, lists, indent: 0 };
  const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
  const header = new TableRow({
    tableHeader: true,
    cantSplit: true,
    children: input.columns.map(
      (column, index) =>
        new TableCell({
          width: { size: widths[index]!, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: HEADER_FILL, color: 'auto' },
          children: [
            new Paragraph({ style: CELL_STYLE, children: [new TextRun({ text: column.name, bold: true })] }),
          ],
        }),
    ),
  });
  // Widths and margins come from the table rather than from each cell, which keeps a document of
  // thousands of rows small enough to build.
  const body = rows.map(
    (cells) =>
      new TableRow({
        children: cells.map((value) => new TableCell({ children: valueParagraphs(value, context, true) })),
      }),
  );
  return new Table({
    rows: [header, ...body],
    width: { size: widths.reduce((sum, value) => sum + value, 0), type: WidthType.DXA },
    columnWidths: widths,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    layout: TableLayoutType.FIXED,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
  });
}

export function viewDocument(input: WordViewInput): Promise<Buffer> {
  const lists = new ListNumbering();
  const children: Array<Paragraph | Table> = [
    heading(input.title),
    ...lines(input.lines),
    ...note(input.note),
  ];
  const empty = () =>
    new Paragraph({ children: [new TextRun({ text: input.empty, size: SIZE.body, color: MUTED })] });
  for (const group of input.groups) {
    if (group.heading !== null)
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          keepNext: true,
          spacing: { before: 240 },
          children: [new TextRun({ text: group.heading, color: INK })],
        }),
      );
    else children.push(new Paragraph({ children: [], spacing: { after: 60 } }));
    children.push(group.rows.length ? viewTable(input, group.rows, lists) : empty());
  }
  if (!input.groups.length) children.push(empty());
  return pack(input.paper, input.landscape, input, lists, children);
}

/* ------------------------------------------------------------------------------------------------
 * A record
 * --------------------------------------------------------------------------------------------- */

export interface WordRecordField {
  label: string;
  value: DocumentValue;
  images: DocumentImage[];
}

export interface WordComment {
  author: string;
  /** When it was written, with a note when it was edited since */
  when: string;
  body: string;
}

export interface WordRecordInput {
  title: string;
  lines: string[];
  fields: WordRecordField[];
  /** Why some images were left out, when they were */
  note: string | null;
  comments: { heading: string; empty: string; items: WordComment[] } | null;
  paper: Paper;
  pageLabel: string;
}

/**
 * An image scaled down to the page's width, and never taller than most of a page.  One smaller
 * than that keeps its own size rather than being blown up past it.
 */
function picture(image: DocumentImage, paper: Paper): Paragraph {
  const maxWidth = contentWidth(paper, false) / TWIPS_PER_PIXEL;
  const maxHeight = (contentHeight(paper, false) * 0.8) / TWIPS_PER_PIXEL;
  const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  return new Paragraph({
    spacing: { before: 60, after: 120 },
    children: [
      new ImageRun({
        type: image.type,
        data: image.data,
        transformation: {
          width: Math.max(1, Math.round(image.width * scale)),
          height: Math.max(1, Math.round(image.height * scale)),
        },
        altText: { name: image.name, description: image.name, title: image.name },
      }),
    ],
  });
}

export function recordDocument(input: WordRecordInput): Promise<Buffer> {
  const lists = new ListNumbering();
  const context: RichContext = { size: SIZE.body, lists, indent: 0 };
  const children: Array<Paragraph | Table> = [
    heading(input.title),
    ...lines(input.lines),
    ...note(input.note),
  ];
  for (const field of input.fields) {
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 200, after: 40 },
        children: [new TextRun({ text: field.label, bold: true, size: SIZE.label, color: MUTED })],
      }),
      ...valueParagraphs(field.value, context),
      ...field.images.map((image) => picture(image, input.paper)),
    );
  }
  if (input.comments) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 360 },
        children: [new TextRun({ text: input.comments.heading, color: INK })],
      }),
    );
    if (!input.comments.items.length)
      children.push(
        new Paragraph({
          children: [new TextRun({ text: input.comments.empty, size: SIZE.body, color: MUTED })],
        }),
      );
    for (const comment of input.comments.items)
      children.push(
        new Paragraph({
          keepNext: true,
          spacing: { before: 160, after: 40 },
          children: [
            new TextRun({ text: comment.author, bold: true, size: SIZE.body, color: INK }),
            new TextRun({ text: `  ${comment.when}`, size: SIZE.label, color: MUTED }),
          ],
        }),
        new Paragraph({ children: textRuns(comment.body, { size: SIZE.body, color: INK }) }),
      );
  }
  return pack(input.paper, false, input, lists, children);
}

/** Patching preserves the uploaded template's styles and replaces split Word text runs. */
export async function patchTemplate(bytes: Buffer, values: Record<string, string>): Promise<Buffer> {
  const { patchDocument, PatchType } = await import('docx');
  return patchDocument({
    outputType: 'nodebuffer',
    data: bytes,
    keepOriginalStyles: true,
    patches: Object.fromEntries(
      Object.entries(values).map(([name, text]) => [
        name,
        {
          type: PatchType.PARAGRAPH,
          children: [new TextRun(text)],
        },
      ]),
    ),
  });
}
