import { ErrorBody, SPREADSHEET_LIMITS, SpreadsheetLine } from '@riosoma/contracts';
import { ApiError, currentCsrfToken, type ApiErrorInfo } from '../../api';

/**
 * Spreadsheets are read by the server, which answers every sheet's rows one line at a time.  Each
 * sheet's lines are kept as a file of their own here, so the preview can read one sheet again, as
 * it does a CSV file, without asking the server twice.
 */
export interface SheetSource {
  kind: 'sheet';
  name: string;
  /** Its place among the workbook's tabs */
  position: number;
  /** One JSON row per line: the row's number, then its cells */
  rows: Blob;
  /** Rows sent, which stop at the limit */
  sent: number;
  /** Every row with a value, sent or not */
  total: number;
}

export interface Workbook {
  sheets: SheetSource[];
}

const OFFLINE: ApiErrorInfo = { code: 'unavailable', messageKey: 'errors.offline', userFault: false };
const UNREADABLE: ApiErrorInfo = {
  code: 'validation_failed',
  messageKey: 'import.spreadsheet.unreadable',
  userFault: true,
};
const unreadable = () => new ApiError(422, UNREADABLE);

const SPREADSHEET_NAME = /\.(xlsx|xlsm|xls)$/i;

/** By its name or by its first bytes: every workbook is a zip, or an older compound file. */
export async function isSpreadsheet(file: File): Promise<boolean> {
  if (SPREADSHEET_NAME.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const compound = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  return zip || compound;
}

async function* responseLines(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    yield* (await response.text()).split('\n');
    return;
  }
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let start = 0;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n', start)) {
      yield pending.slice(start, end);
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  pending += decoder.decode();
  if (pending) yield pending;
}

/** Sends the workbook and gathers every sheet the server reads from it, in tab order. */
export async function uploadSpreadsheet(file: Blob, signal?: AbortSignal): Promise<Workbook> {
  if (file.size > SPREADSHEET_LIMITS.uploadBytes)
    throw new ApiError(413, {
      code: 'payload_too_large',
      messageKey: 'import.spreadsheet.tooLarge',
      params: { megabytes: SPREADSHEET_LIMITS.uploadBytes / 1024 / 1024 },
      userFault: true,
    });
  let response: Response;
  try {
    response = await fetch('/api/imports/spreadsheet', {
      method: 'POST',
      credentials: 'same-origin',
      body: file,
      signal,
      headers: {
        'content-type': 'application/octet-stream',
        'x-csrf-token': currentCsrfToken() ?? '',
      },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ApiError(0, OFFLINE);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = ErrorBody.safeParse(body);
    throw new ApiError(response.status, parsed.success ? parsed.data.error : UNREADABLE);
  }
  const sheets: SheetSource[] = [];
  let current: { name: string; position: number; parts: string[] } | undefined;
  let finished = false;
  for await (const line of responseLines(response)) {
    if (!line) continue;
    // Row lines stay text until the preview reads them.
    if (line.startsWith('[')) {
      if (!current) throw unreadable();
      current.parts.push(line, '\n');
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw unreadable();
    }
    const parsed = SpreadsheetLine.safeParse(value);
    if (!parsed.success) throw unreadable();
    const item = parsed.data;
    if ('sheet' in item) current = { name: item.sheet, position: item.position, parts: [] };
    else if ('rows' in item) {
      if (!current) throw unreadable();
      sheets.push({
        kind: 'sheet',
        name: current.name,
        position: current.position,
        rows: new Blob(current.parts, { type: 'application/x-ndjson' }),
        sent: item.rows,
        total: item.total,
      });
      current = undefined;
    } else if ('done' in item) finished = true;
    else throw new ApiError(422, item.error);
  }
  if (!finished || current) throw unreadable();
  return { sheets: sheets.sort((a, b) => a.position - b.position) };
}
