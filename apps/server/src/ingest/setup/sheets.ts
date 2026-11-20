import {
  AppError,
  IngestFieldKey,
  INGEST_PROCESS_FIELDS,
  IngestSheetProposal,
  SPREADSHEET_LIMITS,
  type FieldType,
  type SheetCell,
} from '@riosoma/contracts';
import type { Cell } from '@riosoma/ingest';
import type { CommandContext } from '../../data/commands/context.js';
import { inspectOriginal } from '../../data/files/originals.js';
import { readSpreadsheet } from '../../data/imports/spreadsheet.js';
import { decodeText, textGrid } from '../extract/text.js';
import { extractSource } from '../extract/index.js';

export interface SetupUpload {
  name: string;
  base64: string;
  mediaType?: string;
}
export const uploadBytes = (file: SetupUpload) => Buffer.from(file.base64, 'base64');
const blank = (value: unknown) =>
  value === null || value === undefined || (typeof value === 'string' && !value.trim());
const cellValue = (value: SheetCell) =>
  typeof value === 'object' && value !== null ? ('date' in value ? value.date : value.error) : value;

/** Safety always precedes decoding, including a pasted sheet offered as expected rows. */
export async function setupSheet(
  c: CommandContext,
  file: { name: string; bytes: Buffer; statedType?: string },
): Promise<unknown[][]> {
  const checked = await inspectOriginal(c.db, c.schemas.app, c.fileConfig!, c.actor.orgId, file);
  let rows: unknown[][] = [];
  if (checked.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    let first = true;
    for await (const event of readSpreadsheet(file.bytes, {
      signal: AbortSignal.timeout(SPREADSHEET_LIMITS.seconds * 1000),
    })) {
      if (event.kind === 'sheet') {
        if (!first) break;
        first = false;
      } else if (event.kind === 'row') rows.push(event.cells.map(cellValue));
      else if (event.kind === 'end' && event.total > SPREADSHEET_LIMITS.rowsPerSheet)
        throw new AppError('payload_too_large', 'ingest.setup.sheetRows');
    }
  } else if (checked.type === 'application/x-ole-storage') {
    const extracted = await extractSource(file.name, file.bytes);
    if (extracted.status !== 'extracted') {
      if (extracted.status === 'unclaimed' || extracted.status === 'outside-feature')
        throw new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
      throw new AppError('validation_failed', extracted.messageKey);
    }
    if (extracted.source.kind !== 'workbook' || !extracted.source.sheets?.length)
      throw new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
    rows = extracted.source.sheets[0]!.rows.map((row) => row.map((item: Cell) => item.v));
  } else {
    if (!['text/plain', 'text/csv', 'text/tab-separated-values'].includes(checked.type))
      throw new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
    const text = decodeText(file.bytes);
    if (text === undefined) throw new AppError('validation_failed', 'import.spreadsheet.notSpreadsheet');
    rows = textGrid(text).map((row) => row.map((item) => item.v));
  }
  rows = rows.filter((row) => row.some((value) => !blank(value)));
  if (!rows.length) throw new AppError('validation_failed', 'ingest.setup.emptySheet');
  if (rows.length > SPREADSHEET_LIMITS.rowsPerSheet + 1)
    throw new AppError('payload_too_large', 'ingest.setup.sheetRows');
  return rows;
}

function suggestedType(values: unknown[]): FieldType {
  if (!values.length) return 'text';
  if (values.every((value) => typeof value === 'boolean' || /^(true|false)$/i.test(String(value))))
    return 'checkbox';
  if (
    values.every(
      (value) => typeof value === 'number' || /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value)),
    )
  )
    return 'number';
  if (
    values.every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(String(value)) && Number.isFinite(Date.parse(String(value))),
    )
  )
    return 'date';
  return 'text';
}

export function proposeSheet(rows: unknown[][]): IngestSheetProposal {
  const headings = rows[0]!;
  const keys = new Set<string>(Object.keys(INGEST_PROCESS_FIELDS));
  const fields = headings.map((value, column) => {
    const heading = String(value ?? '').trim();
    let key = heading
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 90);
    if (!/^[a-zA-Z]/.test(key)) key = `field_${column + 1}_${key}`;
    if (!IngestFieldKey.safeParse(key).success) key = `field_${column + 1}`;
    const root = key;
    for (let suffix = 2; keys.has(key); suffix++) key = `${root}_${suffix}`;
    keys.add(key);
    const values = rows.slice(1).map((row) => row[column] ?? null);
    const present = values.filter((value) => !blank(value));
    return {
      heading,
      key,
      type: suggestedType(present),
      hasEmpty: values.some(blank),
      examples: [...new Map(present.map((value) => [JSON.stringify(value), value])).values()].slice(0, 3),
    };
  });
  return IngestSheetProposal.parse({ fields });
}

export function expectedSheet(rows: unknown[][], fields: readonly { key: string; name: string }[]) {
  const headings = rows[0]!.map((heading) => {
    const label = String(heading ?? '').trim();
    if (fields.some((field) => field.key === label)) return label;
    const matching = fields.filter((field) => field.name.trim().toLowerCase() === label.toLowerCase());
    return matching.length === 1 ? matching[0]!.key : label;
  });
  if (
    new Set(headings).size !== headings.length ||
    headings.some((heading) => !heading) ||
    rows.some((row) => row.length > headings.length)
  )
    throw new AppError('validation_failed', 'ingest.setup.sheetColumns');
  // Unknown and missing columns remain visible to checkPair, which returns all blocking findings.
  return rows.slice(1).map((row) => ({
    values: Object.fromEntries(headings.map((heading, index) => [heading, row[index] ?? null])),
  }));
}
