import { AppError, type SignatureField, type SignatureSigner } from '@riosoma/contracts';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFonts,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from 'pdf-lib';
import sharp from 'sharp';
import { SIGNATURE_COPY } from '../reports/email.js';
import { escapeHtml, formatMessage } from '../reports/messages.js';
import { documentHash } from './token.js';

export const signatureText = (key: keyof typeof SIGNATURE_COPY, values: Record<string, string> = {}) =>
  formatMessage(SIGNATURE_COPY[key].message, values, { locale: 'en-US', html: false });

// Bidirectional controls can reorder what a reader sees, and a byte order mark is invisible.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Text as one plain line: control characters and every kind of whitespace collapse to single
 * spaces, and noncharacters, lone surrogates, and bidirectional controls are dropped.  Everything a
 * signer or requester supplies goes through this before it reaches a stamp or the certificate.
 */
export function plainText(value: string): string {
  let out = '';
  for (const character of value.replace(BIDI_CONTROLS, '')) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if ((code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe) continue;
    out += character;
  }
  return out.replace(/[\p{Cc}\p{Z}\s]+/gu, ' ').trim();
}

/** A signer's time zone if it's a real IANA zone, or null, which stamps in UTC. */
export function signingZone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** The calendar date a signer signed on, in their own zone, with the zone's abbreviation beside it. */
export function dateSigned(signedAt: string, zone: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone ?? 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(signedAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('timeZoneName')}`;
}

/** A moment as the certificate writes it, saying UTC in words. */
export function certificateTime(at: string): string {
  const iso = new Date(at).toISOString();
  return signatureText('utc', { time: `${iso.slice(0, 10)} ${iso.slice(11, 19)}` });
}

export async function readDocument(bytes: Buffer) {
  if (bytes.length > 20 * 1024 * 1024) throw new AppError('payload_too_large', 'signatures.pdfLimit');
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() < 1 || document.getPageCount() > 200) throw new Error('page count');
    return document;
  } catch {
    throw new AppError('validation_failed', 'signatures.invalidPdf');
  }
}

function dictAt(dict: PDFDict, key: string): PDFDict | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFDict ? value : undefined;
}

function numbersAt(dict: PDFDict, key: string): number[] | undefined {
  const value = dict.lookup(PDFName.of(key));
  if (!(value instanceof PDFArray)) return undefined;
  const numbers = value.asArray().map((entry) => dict.context.lookup(entry));
  return numbers.every((entry) => entry instanceof PDFNumber)
    ? numbers.map((entry) => (entry as PDFNumber).asNumber())
    : undefined;
}

/** Whether a PDF holds an XFA form, which can't be flattened, so it is refused for signing. */
export function hasXfa(document: PDFDocument): boolean {
  return Boolean(dictAt(document.catalog, 'AcroForm')?.has(PDFName.of('XFA')));
}

const SAFE_ACTIONS: readonly PDFName[] = [PDFName.of('URI'), PDFName.of('GoTo')];

/** Drops an item's automatic actions, and its click action unless it only opens a link or a page. */
function stripActions(dict: PDFDict) {
  dict.delete(PDFName.of('AA'));
  const action = dict.lookup(PDFName.of('A'));
  if (action === undefined) return;
  const kind = action instanceof PDFDict ? action.lookup(PDFName.of('S')) : undefined;
  if (
    !(action instanceof PDFDict) ||
    !(kind instanceof PDFName) ||
    !SAFE_ACTIONS.includes(kind) ||
    action.has(PDFName.of('Next'))
  )
    dict.delete(PDFName.of('A'));
}

/** A widget's normal appearance, for the state it's in. */
function appearanceOf(document: PDFDocument, widget: PDFDict): PDFRef | undefined {
  const appearances = dictAt(widget, 'AP');
  const normal = appearances?.get(PDFName.of('N'));
  if (!normal) return undefined;
  const resolved = document.context.lookup(normal);
  let chosen = resolved instanceof PDFDict ? undefined : normal;
  if (resolved instanceof PDFDict) {
    const state = widget.lookup(PDFName.of('AS'));
    chosen = state instanceof PDFName ? resolved.get(state) : undefined;
  }
  const stream = chosen ? document.context.lookup(chosen) : undefined;
  if (!(stream instanceof PDFStream)) return undefined;
  stream.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  stream.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
  return chosen instanceof PDFRef ? chosen : document.context.register(stream);
}

/** Draws a form field's widget into the page as it appears, mapping its box onto its rectangle. */
function flattenWidget(document: PDFDocument, page: PDFPage, widget: PDFDict) {
  const flags = widget.lookup(PDFName.of('F'));
  // Hidden and no-view widgets never appear, so they leave nothing behind.
  if (flags instanceof PDFNumber && (flags.asNumber() & 0b100010) !== 0) return;
  const ref = appearanceOf(document, widget);
  const rect = numbersAt(widget, 'Rect');
  if (!ref || rect?.length !== 4) return;
  const stream = document.context.lookup(ref) as PDFStream;
  const [bx0 = 0, by0 = 0, bx1 = 0, by1 = 0] = numbersAt(stream.dict, 'BBox') ?? [];
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = numbersAt(stream.dict, 'Matrix') ?? [];
  const corners = [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ].map(([x = 0, y = 0]) => ({ x: a * x + c * y + e, y: b * x + d * y + f }));
  const minX = Math.min(...corners.map((corner) => corner.x));
  const maxX = Math.max(...corners.map((corner) => corner.x));
  const minY = Math.min(...corners.map((corner) => corner.y));
  const maxY = Math.max(...corners.map((corner) => corner.y));
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = rect;
  const left = Math.min(x0, x1);
  const bottom = Math.min(y0, y1);
  if (maxX - minX <= 0 || maxY - minY <= 0) return;
  const sx = (Math.max(x0, x1) - left) / (maxX - minX);
  const sy = (Math.max(y0, y1) - bottom) / (maxY - minY);
  const name = page.node.newXObject('FlatWidget', ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(sx, 0, 0, sy, left - sx * minX, bottom - sy * minY),
    drawObject(name),
    popGraphicsState(),
  );
}

/**
 * Takes the live parts out of a document before anyone signs or receives it: the open action,
 * automatic actions, document scripts, scripted links, and embedded files.  Form fields are drawn
 * into their pages as they appear, then removed with the form, so nothing in the signed copy can
 * still be edited or sit above a stamp.
 */
export function removeActiveContent(document: PDFDocument) {
  const catalog = document.catalog;
  catalog.delete(PDFName.of('OpenAction'));
  catalog.delete(PDFName.of('AA'));
  catalog.delete(PDFName.of('AF'));
  dictAt(catalog, 'Names')?.delete(PDFName.of('JavaScript'));
  dictAt(catalog, 'Names')?.delete(PDFName.of('EmbeddedFiles'));
  if (catalog.has(PDFName.of('AcroForm'))) {
    try {
      // Fields saved without appearances get the standard ones, so their values still show.
      document.getForm().updateFieldAppearances();
    } catch {
      // A field whose appearance can't be made is drawn from what it already has, if anything.
    }
  }
  for (const page of document.getPages()) {
    page.node.delete(PDFName.of('AA'));
    page.node.delete(PDFName.of('AF'));
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) {
      page.node.delete(PDFName.of('Annots'));
      continue;
    }
    const kept = PDFArray.withContext(document.context);
    for (const entry of annotations.asArray()) {
      const annotation = document.context.lookup(entry);
      if (!(annotation instanceof PDFDict)) continue;
      annotation.delete(PDFName.of('AF'));
      const subtype = annotation.lookup(PDFName.of('Subtype'));
      if (subtype === PDFName.of('FileAttachment')) continue;
      if (subtype === PDFName.of('Widget')) {
        flattenWidget(document, page, annotation);
        continue;
      }
      stripActions(annotation);
      kept.push(entry);
    }
    page.node.set(PDFName.of('Annots'), kept);
  }
  catalog.delete(PDFName.of('AcroForm'));
  const seen = new Set<PDFDict>();
  const visit = (first: PDFDict | undefined) => {
    for (let item = first; item && !seen.has(item); item = dictAt(item, 'Next')) {
      seen.add(item);
      stripActions(item);
      visit(dictAt(item, 'First'));
    }
  };
  const outlines = dictAt(catalog, 'Outlines');
  if (outlines) visit(dictAt(outlines, 'First'));
  dropUnreachable(document);
}

/**
 * Removes objects nothing refers to any more, such as the scripts and fields taken out above, since
 * a saved PDF otherwise carries every object it ever held.
 */
function dropUnreachable(document: PDFDocument) {
  const { context } = document;
  const reachable = new Set<string>();
  const pending: unknown[] = [context.trailerInfo.Root, context.trailerInfo.Info];
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof PDFRef) {
      if (reachable.has(value.tag)) continue;
      reachable.add(value.tag);
      pending.push(context.lookup(value));
    } else if (value instanceof PDFDict) pending.push(...value.values());
    else if (value instanceof PDFArray) pending.push(...value.asArray());
    else if (value instanceof PDFStream) pending.push(value.dict);
  }
  for (const [ref] of context.enumerateIndirectObjects()) if (!reachable.has(ref.tag)) context.delete(ref);
}

export async function signatureImage(image: string): Promise<Buffer> {
  const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new AppError('validation_failed', 'signatures.invalidImage');
  try {
    return await sharp(bytes, {
      limitInputPixels: 2_000_000,
    })
      .rotate()
      .resize({ width: 1200, height: 400, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    throw new AppError('validation_failed', 'signatures.invalidImage');
  }
}

export function pageSize(page: PDFPage) {
  const { width, height } = page.getCropBox();
  return Math.abs(page.getRotation().angle % 180) === 90
    ? { width: height, height: width }
    : { width, height };
}

function beginPage(page: PDFPage) {
  const { x, y, width, height } = page.getCropBox();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  page.pushOperators(pushGraphicsState());
  if (angle === 90) page.pushOperators(concatTransformationMatrix(0, 1, -1, 0, x + width, y));
  else if (angle === 180) page.pushOperators(concatTransformationMatrix(-1, 0, 0, -1, x + width, y + height));
  else if (angle === 270) page.pushOperators(concatTransformationMatrix(0, -1, 1, 0, x, y + height));
  else page.pushOperators(concatTransformationMatrix(1, 0, 0, 1, x, y));
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Keeps everything drawn until the matching pop inside the box. */
function clipTo(page: PDFPage, box: Box) {
  page.pushOperators(rectangle(box.x, box.y, box.width, box.height), clip(), endPath());
}

const LINE = 1.2;

function encodable(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

function wideCharacter(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/**
 * How wide a line is at a size: measured in the standard font when it can draw every character,
 * and otherwise estimated generously, since those lines are drawn as pictures by the system's fonts.
 */
function measurer(font: PDFFont, text: string) {
  if (encodable(font, text)) return (line: string, size: number) => font.widthOfTextAtSize(line, size);
  return (line: string, size: number) => {
    let ems = 0;
    for (const character of line) ems += wideCharacter(character.codePointAt(0)!) ? 1.05 : 0.68;
    return ems * size;
  };
}

/** Breaks text into lines that fit, between words where it can. */
function wrap(text: string, fits: (line: string) => boolean): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    if (fits(word)) {
      line = word;
      continue;
    }
    // A word wider than the line breaks between characters.
    for (const character of word) {
      if (line && !fits(line + character)) {
        lines.push(line);
        line = character;
      } else line += character;
    }
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

/** Draws lines of text, as text when the standard font can, and as pictures of the lines otherwise. */
async function drawLines(
  document: PDFDocument,
  page: PDFPage,
  font: PDFFont,
  lines: readonly string[],
  at: { x: number; top: number; width: number; size: number },
) {
  const vector = lines.every((line) => encodable(font, line));
  for (const [index, line] of lines.entries()) {
    const top = at.top - index * at.size * LINE;
    if (vector) {
      page.drawText(line, { x: at.x, y: top - at.size * 0.95, size: at.size, font });
      continue;
    }
    // The picture is exactly the line's box, so it can never grow past what the page allows.
    const height = at.size * LINE;
    const scale = Math.min(4, 4000 / Math.max(1, at.width), 4000 / Math.max(1, height));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(at.width * scale)}" height="${Math.ceil(height * scale)}" viewBox="0 0 ${at.width} ${height}"><text x="0" y="${at.size * 0.95}" font-size="${at.size}" font-family="sans-serif">${escapeHtml(line)}</text></svg>`;
    const image = await document.embedPng(await sharp(Buffer.from(svg)).png().toBuffer());
    page.drawImage(image, { x: at.x, y: top - height, width: at.width, height });
  }
}

/** Text wrapped and sized to fit its box, then drawn inside it.  What still can't fit is clipped by the caller. */
async function drawInBox(document: PDFDocument, page: PDFPage, font: PDFFont, text: string, box: Box) {
  const pad = Math.min(2, box.width * 0.05);
  const width = Math.max(1, box.width - pad * 2);
  const measure = measurer(font, text);
  let size = Math.max(4, Math.min(12, box.height * 0.75));
  let lines = wrap(text, (line) => measure(line, size) <= width);
  while (size > 4 && lines.length * size * LINE > box.height) {
    size = Math.max(4, size - 0.5);
    lines = wrap(text, (line) => measure(line, size) <= width);
  }
  const used = lines.length * size * LINE;
  const top = box.y + box.height - Math.max(0, (box.height - used) / 2);
  // Lines wholly below the box would only be clipped away.
  const shown = lines.slice(0, Math.max(1, Math.ceil(box.height / (size * LINE))));
  await drawLines(document, page, font, shown, { x: box.x + pad, top, width, size });
}

export async function previewDocument(
  original: Buffer,
  fields: readonly SignatureField[],
  options: {
    onlyPage?: number;
    /** Other signers' fields, outlined and labeled with the name of the person who fills each in */
    others?: ReadonlyArray<{ field: SignatureField; name: string }>;
  } = {},
) {
  const { onlyPage } = options;
  const source = await readDocument(original);
  removeActiveContent(source);
  const document = onlyPage === undefined ? source : await PDFDocument.create();
  if (onlyPage !== undefined) {
    if (onlyPage >= source.getPageCount()) throw new AppError('validation_failed', 'signatures.invalid');
    const [page] = await document.copyPages(source, [onlyPage]);
    document.addPage(page!);
  }
  const font = await document.embedFont(StandardFonts.Helvetica);
  const place = (field: SignatureField) => {
    if (field.page >= source.getPageCount()) throw new AppError('validation_failed', 'signatures.invalid');
    const page = document.getPage(onlyPage === undefined ? field.page : 0);
    const size = pageSize(page);
    const box = {
      x: field.x * size.width,
      y: (1 - field.y - field.height) * size.height,
      width: field.width * size.width,
      height: field.height * size.height,
    };
    return { page, box };
  };
  for (const [index, field] of fields.entries()) {
    if (onlyPage !== undefined && field.page !== onlyPage) continue;
    const { page, box } = place(field);
    beginPage(page);
    page.drawRectangle({
      ...box,
      color: rgb(0.85, 0.92, 1),
      opacity: 0.6,
      borderColor: rgb(0.1, 0.3, 0.6),
      borderWidth: 1,
    });
    page.drawText(String(index + 1), { x: box.x + 2, y: box.y + 2, size: 10, font });
    page.pushOperators(popGraphicsState());
  }
  for (const { field, name } of options.others ?? []) {
    if (onlyPage !== undefined && field.page !== onlyPage) continue;
    const { page, box } = place(field);
    beginPage(page);
    page.drawRectangle({
      ...box,
      borderColor: rgb(0.35, 0.35, 0.35),
      borderWidth: 1,
      borderDashArray: [3, 2],
    });
    clipTo(page, box);
    const label = signatureText('otherSigner', { name: plainText(name) });
    const height = Math.min(box.height, 12);
    await drawInBox(document, page, font, label, { ...box, y: box.y + box.height - height, height });
    page.pushOperators(popGraphicsState());
  }
  return Buffer.from(await document.save({ updateFieldAppearances: false }));
}

const CERTIFICATE = { left: 36, labelWidth: 150, value: 196, valueWidth: 380, size: 9, top: 750, bottom: 48 };

/**
 * The certificate pages, laid out as labeled rows.  A label sits in the left column and its value
 * wraps only inside the right one, so nothing a signer supplies can begin a line of its own that
 * reads as another label.
 */
class Certificate {
  private page!: PDFPage;
  private y = 0;

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.addPage();
  }

  private addPage() {
    this.page = this.document.addPage([612, 792]);
    this.y = CERTIFICATE.top;
  }

  private room(height: number) {
    if (this.y - height < CERTIFICATE.bottom) this.addPage();
  }

  title(text: string) {
    this.page.drawText(text, { x: CERTIFICATE.left, y: this.y - 14, size: 14, font: this.bold });
    this.y -= 28;
  }

  /** The certificate's own wording, across the page. */
  async paragraph(text: string) {
    const width = CERTIFICATE.value + CERTIFICATE.valueWidth - CERTIFICATE.left;
    const measure = measurer(this.font, text);
    for (const line of wrap(text, (candidate) => measure(candidate, CERTIFICATE.size) <= width)) {
      this.room(CERTIFICATE.size * LINE);
      await drawLines(this.document, this.page, this.font, [line], {
        x: CERTIFICATE.left,
        top: this.y,
        width,
        size: CERTIFICATE.size,
      });
      this.y -= CERTIFICATE.size * LINE;
    }
    this.y -= 8;
  }

  async row(label: string, value: string) {
    const { size } = CERTIFICATE;
    const text = plainText(value);
    const measure = measurer(this.font, text);
    const labels = wrap(label, (line) => this.bold.widthOfTextAtSize(line, size) <= CERTIFICATE.labelWidth);
    const values = wrap(text, (line) => measure(line, size) <= CERTIFICATE.valueWidth);
    // A short row stays together on one page.
    this.room(Math.min(Math.max(labels.length, values.length), 4) * size * LINE);
    for (let index = 0; index < Math.max(labels.length, values.length); index++) {
      this.room(size * LINE);
      const label = labels[index];
      if (label !== undefined)
        this.page.drawText(label, { x: CERTIFICATE.left, y: this.y - size * 0.95, size, font: this.bold });
      const line = values[index];
      if (line !== undefined)
        await drawLines(this.document, this.page, this.font, [line], {
          x: CERTIFICATE.value,
          top: this.y,
          width: CERTIFICATE.valueWidth,
          size,
        });
      this.y -= size * LINE;
    }
    this.y -= 3;
  }

  gap() {
    this.y -= 10;
  }
}

export async function stampDocument(
  original: Buffer,
  originalHash: string,
  fields: readonly SignatureField[],
  signers: readonly SignatureSigner[],
) {
  if (documentHash(original) !== originalHash) throw new AppError('conflict', 'signatures.changed');
  const document = await readDocument(original);
  removeActiveContent(document);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  // One copy of each distinct image, however many fields it fills.
  const images = new Map<string, PDFImage>();
  for (const field of fields) {
    const signer = signers[field.signer]!;
    const page = document.getPage(field.page);
    const { width: pw, height: ph } = pageSize(page);
    beginPage(page);
    const box = {
      x: field.x * pw,
      y: (1 - field.y - field.height) * ph,
      width: field.width * pw,
      height: field.height * ph,
    };
    clipTo(page, box);
    const answer = signer.values[field.id];
    if (field.kind === 'signature' || field.kind === 'initials') {
      const data = answer!.image!;
      let image = images.get(data);
      if (!image) {
        image = await document.embedPng(await signatureImage(data));
        images.set(data, image);
      }
      const fit = image.scaleToFit(box.width, box.height);
      page.drawImage(image, {
        x: box.x,
        y: box.y + (box.height - fit.height) / 2,
        width: fit.width,
        height: fit.height,
      });
    } else {
      const value =
        field.kind === 'date'
          ? dateSigned(signer.signedAt!, signer.timeZone ?? null)
          : field.kind === 'name'
            ? plainText(signer.name)
            : plainText(answer!.text);
      await drawInBox(document, page, font, value, box);
    }
    page.pushOperators(popGraphicsState());
  }
  const certificate = new Certificate(document, font, bold);
  certificate.title(signatureText('certificate'));
  await certificate.paragraph(signatureText('simple'));
  await certificate.row(signatureText('originalHash'), originalHash);
  await certificate.paragraph(signatureText('hashNote'));
  for (const signer of signers) {
    certificate.gap();
    await certificate.row(signatureText('signer'), signer.name);
    await certificate.row(signatureText('email'), signer.email);
    await certificate.row(signatureText('time'), certificateTime(signer.signedAt!));
    await certificate.row(signatureText('zone'), signer.timeZone ?? 'UTC');
    await certificate.row(signatureText('address'), signer.ip ?? '');
    await certificate.row(signatureText('browser'), signer.userAgent ?? '');
    await certificate.row(signatureText('consentRecorded'), signer.consent ?? '');
  }
  const bytes = Buffer.from(await document.save({ useObjectStreams: false, updateFieldAppearances: false }));
  return { bytes, finalHash: documentHash(bytes) };
}
