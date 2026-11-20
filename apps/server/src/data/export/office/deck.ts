import pptxgen from 'pptxgenjs';
import type { DocumentImage } from './images.js';

// The package's types describe it as CommonJS, but Node loads its ES module, whose default export
// is the class itself.  Either way, this is the class.
type PptxClass = typeof pptxgen.default;
const PptxGenJS = ((pptxgen as { default?: PptxClass }).default ?? pptxgen) as PptxClass;
type Pptx = InstanceType<PptxClass>;
type Slide = ReturnType<Pptx['addSlide']>;

/**
 * PowerPoint decks.  A title slide says what the deck holds, then either a slide for each record,
 * with its primary field as the slide's title, a list of its fields, and a picture when it has
 * one, or a table of the view across as many slides as it takes.  Titles are drawn in the accent
 * color of the person's theme, darkened when it's too light to read on a white slide.
 */

/** A widescreen slide, in inches */
const SLIDE = { width: 13.333, height: 7.5 } as const;
const EDGE = 0.5;

const INK = '1A1A1A';
const MUTED = '555555';
const LINE = 'D0D0D0';
const FILL = 'F4F4F4';
const WHITE = 'FFFFFF';

/** Riosoma's own green, for a deck made where no theme is at hand, such as a scheduled report */
export const DEFAULT_ACCENT = '374836';

/** A value on a slide stops here, since a slide has no room to scroll */
const SLIDE_TEXT = 400;
const TABLE_TEXT = 120;

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex, 16);
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * An accent that reads as large text on a white slide, at 3 to 1 or better: the theme's own when it
 * does, and otherwise the same hue made darker a step at a time.
 */
export function readableAccent(hex: string | undefined): string {
  let color = (hex ?? DEFAULT_ACCENT).toUpperCase();
  for (let step = 0; step < 20 && contrast(color, WHITE) < 3; step += 1) {
    const value = Number.parseInt(color, 16);
    const darker = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((part) =>
      Math.floor(part * 0.85),
    );
    color = darker
      .map((part) => part.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  return color;
}

/** Text on the accent: white when it reads, and near-black otherwise. */
function onAccent(accent: string): string {
  return contrast(accent, WHITE) >= 4.5 ? WHITE : INK;
}

function cut(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
}

export interface DeckField {
  label: string;
  value: string;
}

export interface DeckRecord {
  title: string;
  fields: DeckField[];
  image: DocumentImage | null;
}

export interface DeckInput {
  title: string;
  /** Lines under the title: where it's from and when, how many records, and the filter */
  lines: string[];
  /** Why the deck stops short of the view, when it does */
  note: string | null;
  accent: string;
}

export interface RecordDeckInput extends DeckInput {
  records: DeckRecord[];
  /** What a deck with no records says on its only slide after the title */
  empty: string;
}

export interface TableDeckInput extends DeckInput {
  columns: string[];
  rows: string[][];
  rowsPerSlide: number;
  /** "Records 1 to 12 of 40", for the rows on one slide */
  range(first: number, last: number): string;
  empty: string;
}

function deck(input: DeckInput): Pptx {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = input.title;
  pptx.author = 'Riosoma';
  const slide = pptx.addSlide();
  const width = SLIDE.width - 2 * EDGE;
  slide.addText(input.title, {
    x: EDGE,
    y: 1.8,
    w: width,
    h: 1.4,
    fontSize: 40,
    bold: true,
    color: input.accent,
    fit: 'shrink',
    valign: 'bottom',
  });
  const lines = input.lines.map((text) => ({ text, options: { breakLine: true } }));
  slide.addText(lines, { x: EDGE, y: 3.4, w: width, h: 1.8, fontSize: 16, color: MUTED, valign: 'top' });
  if (input.note)
    slide.addText(input.note, {
      x: EDGE,
      y: 5.4,
      w: width,
      h: 1.2,
      fontSize: 14,
      italic: true,
      color: INK,
      fill: { color: FILL },
      margin: 8,
      valign: 'middle',
    });
  return pptx;
}

async function written(pptx: Pptx): Promise<Buffer> {
  const output = await pptx.write({ outputType: 'nodebuffer', compression: true });
  return Buffer.isBuffer(output) ? output : Buffer.from(output as ArrayBuffer);
}

function slideTitle(slide: Slide, text: string, accent: string, height = 0.9): void {
  slide.addText(text, {
    x: EDGE,
    y: 0.35,
    w: SLIDE.width - 2 * EDGE,
    h: height,
    fontSize: 28,
    bold: true,
    color: accent,
    fit: 'shrink',
    valign: 'middle',
  });
}

/** A slide for each record: its title, its fields as labels and values, and its picture. */
export function recordDeck(input: RecordDeckInput): Promise<Buffer> {
  const pptx = deck(input);
  const top = 1.45;
  const height = SLIDE.height - top - EDGE;
  for (const record of input.records) {
    const slide = pptx.addSlide();
    slideTitle(slide, record.title, input.accent);
    const listWidth = record.image ? 7.2 : SLIDE.width - 2 * EDGE;
    if (record.fields.length)
      slide.addTable(
        record.fields.map((field) => [
          { text: field.label, options: { bold: true, color: MUTED, fontSize: 12 } },
          { text: cut(field.value, SLIDE_TEXT), options: { color: INK, fontSize: 14 } },
        ]),
        {
          x: EDGE,
          y: top,
          w: listWidth,
          colW: [listWidth * 0.34, listWidth * 0.66],
          valign: 'top',
          margin: 0.06,
          border: { type: 'solid', pt: 0.5, color: LINE },
          autoPage: false,
        },
      );
    if (record.image) {
      const box = {
        x: EDGE + listWidth + 0.3,
        y: top,
        w: SLIDE.width - EDGE - (EDGE + listWidth + 0.3),
        h: height,
      };
      // Inches at the screen's 96 pixels to the inch, fitted to the box and never blown up past that.
      const natural = { w: record.image.width / 96, h: record.image.height / 96 };
      const scale = Math.min(1, box.w / natural.w, box.h / natural.h);
      const w = natural.w * scale;
      const h = natural.h * scale;
      slide.addImage({
        data: `image/${record.image.type === 'png' ? 'png' : 'jpeg'};base64,${record.image.data.toString('base64')}`,
        x: box.x + (box.w - w) / 2,
        y: box.y,
        w,
        h,
        altText: record.image.name,
      });
    }
  }
  if (!input.records.length) {
    const slide = pptx.addSlide();
    slideTitle(slide, input.empty, input.accent);
  }
  return written(pptx);
}

/** The view as a table, `rowsPerSlide` records to a slide, each slide with the header row. */
export function tableDeck(input: TableDeckInput): Promise<Buffer> {
  const pptx = deck(input);
  const width = SLIDE.width - 2 * EDGE;
  const header = input.columns.map((name) => ({
    text: name,
    options: { bold: true, color: onAccent(input.accent), fill: { color: input.accent }, fontSize: 12 },
  }));
  for (let first = 0; first < input.rows.length; first += input.rowsPerSlide) {
    const rows = input.rows.slice(first, first + input.rowsPerSlide);
    const slide = pptx.addSlide();
    slideTitle(slide, input.title, input.accent, 0.7);
    slide.addText(input.range(first + 1, first + rows.length), {
      x: EDGE,
      y: 1.05,
      w: width,
      h: 0.35,
      fontSize: 12,
      color: MUTED,
    });
    slide.addTable(
      [
        header,
        ...rows.map((cells) =>
          cells.map((text) => ({ text: cut(text, TABLE_TEXT), options: { color: INK, fontSize: 11 } })),
        ),
      ],
      {
        x: EDGE,
        y: 1.5,
        w: width,
        colW: input.columns.map(() => width / Math.max(1, input.columns.length)),
        valign: 'top',
        margin: 0.05,
        border: { type: 'solid', pt: 0.5, color: LINE },
        autoPage: false,
      },
    );
  }
  if (!input.rows.length) {
    const slide = pptx.addSlide();
    slideTitle(slide, input.empty, input.accent);
  }
  return written(pptx);
}
