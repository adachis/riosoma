import type {
  CellValue,
  GoogleSheetsConnection,
  SourceColumn,
  SourceObject,
  SourceObjectRef,
  SourceSelect,
  SourceTestResult,
  TestStep,
} from '@riosoma/contracts';
import { Budget } from '../common.js';
import {
  cellColumn,
  cellValue,
  emptyStats,
  keyFieldType,
  observe,
  readingOf,
  type CellReading,
  type CellStats,
  type FileCell,
} from '../files/cells.js';
import { nodeSockets, type Sockets } from '../files/connector.js';
import { FileNetworkError, NO_NETWORK, type FileNetwork } from '../files/network.js';
import { sourceKey } from '../registry.js';
import { readBody } from '../rest/connector.js';
import { cachedToken, forgetToken, keepToken, pace, retryAfterMs, sleep, tokenKey } from '../rest/http.js';
import { positive } from '../sql.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorContext,
  type SourcePreviewRows,
  type SourceRow,
} from '../types.js';
import { scrubDetail } from '../warehouses/errors.js';
import { RowBatcher } from '../warehouses/values.js';
import {
  googleProblem,
  readServiceAccountKey,
  serviceAccountAssertion,
  SHEETS_READ_SCOPE,
  type ServiceAccountKey,
} from './google.js';

/**
 * Sheets in Google spreadsheets, read through the Sheets API as a service account that people share
 * their spreadsheets with.  Each sheet is offered like a table.  Its header row names the columns,
 * every row below it is a record, and columns take the types file sources give a CSV file's or a
 * workbook's columns, so a sheet and the same data exported as a file agree.
 *
 * Every request goes through the server's guarded network, and only ever to Google's own token and
 * Sheets addresses, whatever the key says.  The key signs a token request with Node's own crypto,
 * and the token it gets is kept in memory until it's close to expiring.  Requests keep to one a
 * second for each service account, which is Google's own limit for reading, and a 429 or a busy
 * Google is waited out as long as Retry-After asks, within bounds.  No key, assertion, or token
 * ever reaches a message.
 */

export const SHEETS_KEYS = {
  key: 'sources.google.key',
  keyRefused: 'sources.google.keyRefused',
  tokenFailed: 'sources.google.tokenFailed',
  unreachable: 'sources.google.unreachable',
  notShared: 'sources.google.notShared',
  notFound: 'sources.google.notFound',
  apiDisabled: 'sources.google.apiDisabled',
  notSheets: 'sources.google.notSheets',
  noSheets: 'sources.google.noSheets',
  headerEmpty: 'sources.google.headerEmpty',
  rateLimited: 'sources.google.rateLimited',
  status: 'sources.google.status',
  tooLarge: 'sources.google.tooLarge',
  noQueries: 'sources.google.noQueries',
  read: 'sources.sync.read',
  objectMissing: 'sources.sync.objectMissing',
  columnMissing: 'sources.sync.columnMissing',
  secretsMissing: 'sources.secretsMissing',
  timeout: 'sources.test.timeout',
} as const;

/** Keys a failed test step carries as they are.  The others say less than the step's own advice. */
const ADVICE = new Set<string>(
  Object.values(SHEETS_KEYS).filter(
    (key) =>
      ![
        SHEETS_KEYS.read,
        SHEETS_KEYS.objectMissing,
        SHEETS_KEYS.columnMissing,
        SHEETS_KEYS.tooLarge,
        SHEETS_KEYS.status,
      ].includes(key as never),
  ),
);

/** The column a sheet's row numbers arrive in, which no header can take from it. */
export const ROW_NUMBER = 'Row number';

export const GOOGLE_SHEETS_URL = 'https://sheets.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface SheetsConnectorOptions {
  /** The guarded network the server supplies.  Without one, nothing is reached. */
  network?: FileNetwork;
  sockets?: Sockets;
  /** Where the Sheets API answers.  Tests point it at a stand-in. */
  sheetsUrl?: string;
  /** Where tokens come from.  Tests point it at a stand-in. */
  tokenUrl?: string;
  /** Requests a second for each service account: one unless set, which is Google's reading quota */
  requestsPerSecond?: number;
  /** Cells one request for rows asks for at most: 500,000 unless set */
  cellsPerRequest?: number;
  /** The most one answer may hold: 50 MB unless set */
  maxPageBytes?: number;
  /** How long a sync's whole read may take: 20 minutes unless set */
  deadlineMs?: number;
  /** The longest a Retry-After is waited out before the call gives up: 60 seconds unless set */
  maxRetryWaitMs?: number;
  /** How often one request is tried again after a 429 or a busy Google: 5 times unless set */
  retries?: number;
  /** How long finding key candidates may read before it offers only row numbers: 15 seconds unless set */
  keyScanMs?: number;
  /** The clock tokens expire and assertions are dated by */
  now?: () => number;
}

const DEFAULT_PAGE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DEADLINE_MS = 20 * 60_000;
const DEFAULT_RETRY_WAIT_MS = 60_000;
const DEFAULT_RETRIES = 5;
const DEFAULT_KEY_SCAN_MS = 15_000;
const DEFAULT_CELLS_PER_REQUEST = 500_000;
/** Rows sampled for types, as the importer samples a column's first thousand values. */
const SAMPLE_ROWS = 1_000;
const ERROR_BYTES = 16 * 1024;
const TOKEN_BYTES = 64 * 1024;
/** Busy answers worth waiting out, as Google's own guidance says. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
/** Reasons an older Google answer gives for a 403 that's really a request to slow down. */
const SLOW_DOWN = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'RATE_LIMIT_EXCEEDED']);
/** Error values a formula can hold, which read as errors rather than text. */
const SHEET_ERRORS = /^#(?:N\/A|DIV\/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|ERROR!|SPILL!|CALC!)$/;
const KEYABLE_TYPES = new Set(['number', 'text', 'email', 'url', 'phone', 'date']);
const MAX_NAME = 255;

/** One answer, read whole. */
interface Answer {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

/** One call's settings, its key, when it must stop, and the values no message of its may hold. */
interface Call {
  ctx: ConnectorContext;
  settings: GoogleSheetsConnection;
  key: ServiceAccountKey;
  signal: AbortSignal;
  deadline: number;
  idleMs: number;
  hidden: Set<string>;
}

interface SheetInfo {
  id: number;
  title: string;
  rows: number;
  columns: number;
}

interface Spreadsheet {
  id: string;
  title: string;
  /** Only the sheets that hold cells: a chart on a sheet of its own has none */
  sheets: SheetInfo[];
}

/** A row below the header, with its number in the sheet. */
interface SheetRow {
  number: number;
  cells: FileCell[];
}

/** A column as a sheet describes it, and where its cells are. */
interface SheetColumn {
  column: SourceColumn;
  /** Its place in each row, or -1 for the row number */
  index: number;
  reading: CellReading;
  keyable: boolean;
}

const ROW_NUMBER_READING: CellReading = { type: 'number', precision: 0, dateOrder: 'mdy' };

function rowNumberColumn(): SheetColumn {
  return {
    column: {
      name: ROW_NUMBER,
      sourceType: 'row number',
      nullable: false,
      suggested: { type: 'number', options: { precision: 0 } },
      alternatives: ['text'],
      role: 'rowNumber',
    },
    index: -1,
    reading: ROW_NUMBER_READING,
    keyable: true,
  };
}

/** A sheet's name as a range writes it, quoted so spaces and punctuation are safe. */
function quoted(title: string): string {
  return `'${title.replaceAll("'", "''")}'`;
}

/** One cell from the Sheets API, read unformatted, with dates and times in the sheet's own format. */
export function sheetCell(raw: unknown): FileCell {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return SHEET_ERRORS.test(raw) ? { error: raw } : raw;
  return String(raw);
}

function headerText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return (typeof raw === 'string' ? raw : String(raw)).replace(/\s+/g, ' ').trim();
}

/**
 * Column names from a header row, the way file sources name a file's columns: a blank header by
 * its place, like `column3`, and a repeated one numbered, like `Total_1`.  The row number's own
 * name is taken first, so a header that repeats it is the one that gets numbered.
 */
export function sheetColumnNames(header: readonly unknown[], width: number): string[] {
  const used = new Set([ROW_NUMBER.toLowerCase()]);
  const names: string[] = [];
  for (let index = 0; index < width; index++) {
    const text = headerText(header[index]).slice(0, MAX_NAME);
    const base = text === '' ? `column${index}` : text;
    let name = base;
    for (let suffix = 1; used.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`;
    used.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

function isBlankRow(cells: readonly FileCell[]): boolean {
  return cells.every((cell) => cell === null || (typeof cell === 'string' && cell.trim() === ''));
}

/**
 * The columns a sheet offers, from its header and its first rows: every column with a header or a
 * value, typed by the rules file sources use, and the row number last.
 */
function describeSheet(names: readonly string[], header: readonly unknown[], rows: readonly SheetRow[]) {
  const stats = names.map((): CellStats => emptyStats());
  const seen = names.map((_name, index) => headerText(header[index]) !== '');
  for (const row of rows)
    row.cells.forEach((cell, index) => {
      if (index >= names.length) return;
      observe(stats[index]!, cell);
      if (cell !== null) seen[index] = true;
    });
  const columns: SheetColumn[] = [];
  names.forEach((name, index) => {
    if (!seen[index]) return;
    const reading = readingOf(stats[index]!);
    columns.push({
      column: cellColumn(name, reading.type, reading),
      index,
      reading,
      keyable: KEYABLE_TYPES.has(keyFieldType(reading)),
    });
  });
  columns.push(rowNumberColumn());
  return columns;
}

function valueOf(column: SheetColumn, row: SheetRow, fieldType: string): CellValue {
  if (column.index < 0) return fieldType === 'number' ? row.number : String(row.number);
  return cellValue(row.cells[column.index] ?? null, fieldType, column.reading);
}

function keyOf(column: SheetColumn, row: SheetRow): CellValue {
  return valueOf(column, row, keyFieldType(column.reading));
}

export type SheetsConnector = Connector;

export function createGoogleSheetsConnector(options: SheetsConnectorOptions = {}): SheetsConnector {
  const network = options.network ?? NO_NETWORK;
  const sockets = options.sockets ?? nodeSockets;
  const sheetsUrl = (options.sheetsUrl ?? GOOGLE_SHEETS_URL).replace(/\/+$/, '');
  const tokenUrl = options.tokenUrl ?? GOOGLE_TOKEN_URL;
  const perSecond = options.requestsPerSecond ?? 1;
  const cellsPerRequest = options.cellsPerRequest ?? DEFAULT_CELLS_PER_REQUEST;
  const maxPageBytes = options.maxPageBytes ?? DEFAULT_PAGE_BYTES;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxRetryWaitMs = options.maxRetryWaitMs ?? DEFAULT_RETRY_WAIT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const keyScanMs = options.keyScanMs ?? DEFAULT_KEY_SCAN_MS;
  const now = options.now ?? Date.now;

  function settingsOf(ctx: ConnectorContext): GoogleSheetsConnection {
    if (ctx.connection.kind !== 'google-sheets')
      throw new ConnectorError(
        SHEETS_KEYS.read,
        `the connection settings are for ${ctx.connection.kind}, not google-sheets`,
      );
    return ctx.connection;
  }

  function keyOfContext(ctx: ConnectorContext): ServiceAccountKey {
    const json = ctx.secrets.serviceAccountJson;
    if (!json) throw new ConnectorError(SHEETS_KEYS.secretsMissing, 'the service account key isn’t stored');
    const key = readServiceAccountKey(json);
    if (!key) throw new ConnectorError(SHEETS_KEYS.key, 'the key isn’t a service account’s JSON key');
    return key;
  }

  /** A call that stops after `ms`, or sooner when its caller gives up. */
  function begin(ctx: ConnectorContext, ms: number, extra?: AbortSignal): Call {
    const settings = settingsOf(ctx);
    return {
      ctx,
      settings,
      key: keyOfContext(ctx),
      signal: AbortSignal.any([
        ...(ctx.signal ? [ctx.signal] : []),
        ...(extra ? [extra] : []),
        AbortSignal.timeout(ms),
      ]),
      deadline: Date.now() + ms,
      idleMs: positive(ctx.timeoutMs, 30000),
      hidden: new Set(),
    };
  }

  function scrubbed(detail: unknown, ctx: ConnectorContext, call?: Call): string | undefined {
    let text = scrubDetail(detail, ctx);
    if (text === undefined) return undefined;
    for (const value of [...(call?.hidden ?? [])].sort((a, b) => b.length - a.length))
      if (value.length >= 4) text = text.split(value).join('[redacted]');
    return text;
  }

  /** The error a call leaves with: a key people can act on, and scrubbed words behind it. */
  function failure(error: unknown, ctx: ConnectorContext, call?: Call): ConnectorError {
    if (error instanceof ConnectorError) {
      const timedOut = error.messageKey === SHEETS_KEYS.timeout;
      const detail =
        error.detail !== undefined
          ? scrubbed(error.detail, ctx, call)
          : timedOut
            ? `Google took longer than ${positive(ctx.timeoutMs, 30000)} ms to answer`
            : ctx.signal?.aborted
              ? 'the call was stopped before it finished'
              : undefined;
      return new ConnectorError(timedOut ? SHEETS_KEYS.read : error.messageKey, detail, error.params);
    }
    if (error instanceof FileNetworkError) {
      const detail = scrubbed(error.detail ?? error.problem, ctx, call);
      if (error.problem === 'tooLarge')
        return new ConnectorError(SHEETS_KEYS.tooLarge, detail, {
          megabytes: Math.floor(maxPageBytes / 1024 / 1024),
        });
      if (error.problem === 'https' || error.problem === 'blocked' || error.problem === 'resolve')
        return new ConnectorError(SHEETS_KEYS.unreachable, detail);
      return new ConnectorError(SHEETS_KEYS.read, detail);
    }
    if (
      ctx.signal?.aborted ||
      call?.signal.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    )
      return new ConnectorError(
        SHEETS_KEYS.read,
        'the call was stopped or ran out of time before it finished',
      );
    return new ConnectorError(SHEETS_KEYS.read, scrubbed(error, ctx, call));
  }

  /** An access token for the service account, from memory while it lasts, or fresh from Google. */
  async function token(call: Call, fresh = false): Promise<string> {
    const secret = call.ctx.secrets.serviceAccountJson ?? '';
    const cacheKey = tokenKey(['google-sheets', tokenUrl, call.key.clientEmail, SHEETS_READ_SCOPE, secret]);
    if (fresh) forgetToken(cacheKey);
    const cached = cachedToken(cacheKey, now());
    if (cached) {
      call.hidden.add(cached);
      return cached;
    }
    const url = new URL(tokenUrl);
    if (!network.allowsAddress(url))
      throw new FileNetworkError('https', `${url.protocol} token addresses aren’t allowed`);
    const assertion = serviceAccountAssertion(
      call.key,
      SHEETS_READ_SCOPE,
      tokenUrl,
      Math.floor(now() / 1_000),
    );
    call.hidden.add(assertion);
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const response = await network.request({
      url,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'Riosoma-Sources',
      },
      body: form.toString(),
      maxBytes: TOKEN_BYTES,
      signal: call.signal,
      idleMs: call.idleMs,
    });
    const body = await readBody(response, TOKEN_BYTES, false);
    let answer: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (typeof parsed === 'object' && parsed !== null) answer = parsed as Record<string, unknown>;
    } catch {
      // A token address that doesn't answer in JSON is covered below.
    }
    if (response.status < 200 || response.status >= 300) {
      const code = typeof answer.error === 'string' ? answer.error.slice(0, 100) : '';
      const said = typeof answer.error_description === 'string' ? answer.error_description.slice(0, 200) : '';
      const detail = `the token address answered HTTP ${response.status}${code ? ` ${code}` : ''}${said ? `: ${said}` : ''}`;
      if ([400, 401, 403].includes(response.status)) throw new ConnectorError(SHEETS_KEYS.keyRefused, detail);
      throw new ConnectorError(SHEETS_KEYS.tokenFailed, detail);
    }
    const value = answer.access_token;
    if (typeof value !== 'string' || !value)
      throw new ConnectorError(SHEETS_KEYS.tokenFailed, 'the token address answered without an access_token');
    call.hidden.add(value);
    const seconds = Number(answer.expires_in);
    const lasts = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 3_600_000;
    keepToken(cacheKey, value, now() + lasts, now());
    return value;
  }

  /**
   * One GET, at the service account's pace.  A busy answer is tried again after the wait its
   * Retry-After asks for, or a growing one when it asks for none, within bounds and the deadline.
   * A token Google refuses is renewed once.  Any other answer comes back as it is.
   */
  async function get(call: Call, url: URL): Promise<Answer> {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const authorization = `Bearer ${await token(call, renewed)}`;
      if (!network.allowsAddress(url))
        throw new FileNetworkError('https', `${url.protocol} addresses aren’t allowed`);
      await pace(`google-sheets:${call.key.clientEmail}`, perSecond, call.signal);
      const response = await network.request({
        url,
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'Riosoma-Sources', authorization },
        maxBytes: maxPageBytes,
        signal: call.signal,
        idleMs: call.idleMs,
      });
      const ok = response.status >= 200 && response.status < 300;
      const answer: Answer = {
        status: response.status,
        headers: response.headers,
        body: ok
          ? await readBody(response, maxPageBytes, true)
          : await readBody(response, ERROR_BYTES, false),
      };
      const slowDown =
        RETRY_STATUSES.has(answer.status) ||
        (answer.status === 403 && SLOW_DOWN.has(googleProblem(answer.body).reason));
      if (slowDown) {
        const asked = retryAfterMs(answer.headers['retry-after'], now());
        const ms = asked ?? 1_000 * 2 ** attempt;
        if (attempt < retries && ms <= maxRetryWaitMs && Date.now() + ms < call.deadline) {
          await sleep(ms, call.signal);
          continue;
        }
        const busy = answer.status >= 500;
        throw new ConnectorError(
          busy ? SHEETS_KEYS.status : SHEETS_KEYS.rateLimited,
          `HTTP ${answer.status}${asked === null ? '' : `, asked to wait ${Math.ceil(asked / 1_000)} seconds`} after ${attempt + 1} tries`,
          busy ? { status: answer.status } : undefined,
        );
      }
      if (answer.status === 401 && !renewed) {
        renewed = true;
        continue;
      }
      return answer;
    }
  }

  /** The error an answer outside 2xx stands for. */
  function refusal(answer: Answer, spreadsheet: string): ConnectorError {
    const problem = googleProblem(answer.body);
    const detail = `HTTP ${answer.status}${problem.message ? `: ${problem.message}` : ''} (spreadsheet ${spreadsheet})`;
    if (answer.status === 401) return new ConnectorError(SHEETS_KEYS.keyRefused, detail);
    if (answer.status === 403)
      return new ConnectorError(
        problem.reason === 'SERVICE_DISABLED' ||
          problem.reason === 'accessNotConfigured' ||
          /has not been used in project|is disabled/i.test(problem.message)
          ? SHEETS_KEYS.apiDisabled
          : SHEETS_KEYS.notShared,
        detail,
      );
    if (answer.status === 404) return new ConnectorError(SHEETS_KEYS.notFound, detail);
    if (
      answer.status === 400 &&
      (problem.status === 'FAILED_PRECONDITION' || /not supported for this document/i.test(problem.message))
    )
      return new ConnectorError(SHEETS_KEYS.notSheets, detail);
    return new ConnectorError(SHEETS_KEYS.status, detail, { status: answer.status });
  }

  function json(answer: Answer): unknown {
    try {
      return JSON.parse(answer.body.toString('utf8'));
    } catch {
      throw new ConnectorError(SHEETS_KEYS.read, 'Google’s answer doesn’t read as JSON');
    }
  }

  /** A spreadsheet's title and its sheets that hold cells, with each one's size. */
  async function spreadsheet(call: Call, id: string): Promise<Spreadsheet> {
    const url = new URL(`${sheetsUrl}/v4/spreadsheets/${encodeURIComponent(id)}`);
    url.searchParams.set(
      'fields',
      'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,sheetType,gridProperties(rowCount,columnCount))',
    );
    const answer = await get(call, url);
    if (answer.status < 200 || answer.status >= 300) throw refusal(answer, id);
    const document = json(answer) as {
      properties?: { title?: unknown };
      sheets?: Array<{ properties?: Record<string, unknown> }>;
    };
    const sheets: SheetInfo[] = [];
    for (const entry of Array.isArray(document.sheets) ? document.sheets : []) {
      const properties = entry?.properties ?? {};
      const grid = (properties.gridProperties ?? {}) as { rowCount?: unknown; columnCount?: unknown };
      if (properties.sheetType !== undefined && properties.sheetType !== 'GRID') continue;
      if (typeof properties.sheetId !== 'number' || typeof properties.title !== 'string') continue;
      sheets.push({
        id: properties.sheetId,
        title: properties.title,
        rows: typeof grid.rowCount === 'number' ? grid.rowCount : 0,
        columns: typeof grid.columnCount === 'number' ? grid.columnCount : 0,
      });
    }
    const title = typeof document.properties?.title === 'string' ? document.properties.title : id;
    return { id, title, sheets };
  }

  /** A sheet's rows from `first` to `last`, counting from 1, as the API gives them. */
  async function rowsOf(
    call: Call,
    spreadsheetId: string,
    sheet: SheetInfo,
    first: number,
    last: number,
  ): Promise<unknown[][]> {
    const range = `${quoted(sheet.title)}!${first}:${last}`;
    const url = new URL(
      `${sheetsUrl}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
    );
    url.searchParams.set('majorDimension', 'ROWS');
    url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
    url.searchParams.set('dateTimeRenderOption', 'FORMATTED_STRING');
    const answer = await get(call, url);
    if (answer.status < 200 || answer.status >= 300) throw refusal(answer, spreadsheetId);
    const values = (json(answer) as { values?: unknown }).values;
    if (values === undefined) return [];
    if (!Array.isArray(values))
      throw new ConnectorError(SHEETS_KEYS.read, 'Google’s answer holds no rows where it should');
    return values.map((row) => (Array.isArray(row) ? (row as unknown[]) : []));
  }

  /** The spreadsheet and sheet a select names, by the IDs that stay put when either is renamed. */
  async function sheetOf(
    call: Call,
    select: SourceSelect,
  ): Promise<{ spreadsheet: Spreadsheet; sheet: SheetInfo }> {
    if (select.kind !== 'object')
      throw new ConnectorError(SHEETS_KEYS.noQueries, 'Google Sheets sources read sheets, not queries');
    const missing = () =>
      new ConnectorError(SHEETS_KEYS.objectMissing, 'the spreadsheet has no such sheet', {
        object: select.object.name,
      });
    const id = select.object.schema;
    if (id === null || !call.settings.spreadsheets.includes(id)) throw missing();
    const found = await spreadsheet(call, id);
    const sheet = found.sheets.find((entry) => String(entry.id) === select.object.name);
    if (!sheet) throw missing();
    return { spreadsheet: found, sheet };
  }

  /** Rows a request asks for at most, so each answer stays well under the size limit. */
  function rowsPerRequest(sheet: SheetInfo): number {
    return Math.max(100, Math.floor(cellsPerRequest / Math.max(1, sheet.columns)));
  }

  /**
   * A sheet's header and its first rows below it, enough to decide each column's type, and whether
   * they were every row it has.
   */
  async function sample(
    call: Call,
    spreadsheetId: string,
    sheet: SheetInfo,
  ): Promise<{ names: string[]; columns: SheetColumn[]; rows: SheetRow[]; complete: boolean; next: number }> {
    const headerRow = call.settings.headerRow;
    const empty = () =>
      new ConnectorError(SHEETS_KEYS.headerEmpty, `${sheet.title} has nothing in row ${headerRow}`);
    if (headerRow > sheet.rows) throw empty();
    const last = Math.min(sheet.rows, headerRow + Math.min(SAMPLE_ROWS, rowsPerRequest(sheet)));
    const values = await rowsOf(call, spreadsheetId, sheet, headerRow, last);
    const header = values[0] ?? [];
    if (header.every((cell) => headerText(cell) === '')) throw empty();
    const width = Math.max(sheet.columns, header.length, ...values.map((row) => row.length));
    const names = sheetColumnNames(header, width);
    const rows = rowsFrom(values.slice(1), headerRow + 1);
    return {
      names,
      columns: describeSheet(names, header, rows),
      rows,
      complete: last >= sheet.rows,
      next: last + 1,
    };
  }

  function rowsFrom(values: readonly unknown[][], first: number): SheetRow[] {
    const rows: SheetRow[] = [];
    values.forEach((raw, offset) => {
      const cells = raw.map(sheetCell);
      // A blank row is a gap between records, not a record, though it keeps its number.
      if (!isBlankRow(cells)) rows.push({ number: first + offset, cells });
    });
    return rows;
  }

  /** Every row of a sheet below its header, a request at a time, starting with the sample's. */
  async function* allRows(
    call: Call,
    spreadsheetId: string,
    sheet: SheetInfo,
    sampled: { rows: SheetRow[]; complete: boolean; next: number },
  ): AsyncGenerator<SheetRow[]> {
    yield sampled.rows;
    if (sampled.complete) return;
    const step = rowsPerRequest(sheet);
    for (let first = sampled.next; first <= sheet.rows; first += step) {
      const last = Math.min(sheet.rows, first + step - 1);
      yield rowsFrom(await rowsOf(call, spreadsheetId, sheet, first, last), first);
    }
  }

  async function preview(
    ctx: ConnectorContext,
    select: SourceSelect,
    limit: number,
  ): Promise<SourcePreviewRows> {
    let call: Call | undefined;
    try {
      positive(limit, 50);
      call = begin(ctx, positive(ctx.timeoutMs, 30000));
      const { spreadsheet: found, sheet } = await sheetOf(call, select);
      const sampled = await sample(call, found.id, sheet);
      return {
        columns: sampled.columns.map((entry) => entry.column),
        rows: sampled.rows
          .slice(0, limit)
          .map((row) =>
            sampled.columns.map((entry) =>
              entry.column.suggested ? valueOf(entry, row, entry.column.suggested.type) : null,
            ),
          ),
        rowEstimate: sampled.complete ? sampled.rows.length : null,
      };
    } catch (error) {
      throw failure(error, ctx, call);
    }
  }

  async function test(ctx: ConnectorContext): Promise<SourceTestResult> {
    const steps: SourceTestResult['steps'] = [];
    let current: TestStep = 'resolve';
    let start = Date.now();
    let call: Call | undefined;
    const passed = (step: TestStep) => steps.push({ step, status: 'ok', ms: Date.now() - start });
    const enter = (step: TestStep) => {
      current = step;
      start = Date.now();
    };
    try {
      const budget = new Budget(ctx);
      const within = async <T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const controller = new AbortController();
        try {
          return await budget.run(
            () => action(AbortSignal.any([controller.signal, ...(ctx.signal ? [ctx.signal] : [])])),
            () => controller.abort(),
          );
        } finally {
          controller.abort();
        }
      };
      const settings = settingsOf(ctx);
      const address = new URL(sheetsUrl);
      const port = Number(address.port || (address.protocol === 'https:' ? 443 : 80));
      if (!network.allowsAddress(address))
        throw new FileNetworkError('https', `${address.protocol} addresses aren’t allowed`);
      const checked = await within((signal) => network.check(address, signal));
      passed('resolve');
      enter('connect');
      await within((signal) => sockets.connect(checked, port, signal));
      passed('connect');
      enter('tls');
      if (address.protocol === 'https:') {
        await within((signal) => sockets.handshake(checked, port, address.hostname, signal));
        passed('tls');
      } else steps.push({ step: 'tls', status: 'skipped', ms: null });

      // Signing in is the token request, always a new one, to prove the key works.
      enter('authenticate');
      const tested = begin(ctx, budget.ms);
      call = tested;
      await within(() => token(tested, true));
      passed('authenticate');

      enter('sheets');
      let first: { spreadsheet: Spreadsheet; sheet: SheetInfo } | undefined;
      for (const id of settings.spreadsheets) {
        const found = await within(() => spreadsheet(tested, id));
        if (!found.sheets.length)
          throw new ConnectorError(SHEETS_KEYS.noSheets, `spreadsheet ${id} has no sheets of cells`);
        first ??= { spreadsheet: found, sheet: found.sheets[0]! };
      }
      passed('sheets');

      enter('rows');
      const headerRow = settings.headerRow;
      const { sheet } = first!;
      if (headerRow > sheet.rows)
        throw new ConnectorError(SHEETS_KEYS.headerEmpty, `${sheet.title} has fewer than ${headerRow} rows`);
      const values = await within(() =>
        rowsOf(tested, first!.spreadsheet.id, sheet, headerRow, Math.min(sheet.rows, headerRow + 1)),
      );
      if ((values[0] ?? []).every((cell) => headerText(cell) === ''))
        throw new ConnectorError(SHEETS_KEYS.headerEmpty, `${sheet.title} has nothing in row ${headerRow}`);
      passed('rows');
      return { ok: true, steps };
    } catch (error) {
      const detail = scrubbed(error instanceof ConnectorError ? (error.detail ?? '') : error, ctx, call);
      steps.push({
        step: current,
        status: 'failed',
        ms: Date.now() - start,
        messageKey: testKey(error, current),
        ...(detail ? { detail } : {}),
      });
      return { ok: false, steps };
    }
  }

  /** The advice a failed step carries.  Keys that need a value filled in give way to the step's own. */
  function testKey(error: unknown, step: TestStep): string {
    if (error instanceof ConnectorError) {
      if (error.messageKey === SHEETS_KEYS.timeout) return SHEETS_KEYS.timeout;
      return ADVICE.has(error.messageKey) ? error.messageKey : `sources.test.${step}`;
    }
    if (error instanceof FileNetworkError) {
      if (error.problem === 'resolve') return 'sources.test.resolve';
      if (error.problem === 'https' || error.problem === 'blocked') return SHEETS_KEYS.unreachable;
    }
    const text =
      error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : '';
    if (/timeout|timed out|ETIMEDOUT/i.test(text)) return SHEETS_KEYS.timeout;
    return `sources.test.${step}`;
  }

  return {
    kind: 'google-sheets',
    test,
    async listObjects(ctx): Promise<SourceObject[]> {
      let call: Call | undefined;
      try {
        call = begin(ctx, deadlineMs);
        const objects: SourceObject[] = [];
        for (const id of call.settings.spreadsheets) {
          const found = await spreadsheet(call, id);
          for (const sheet of found.sheets)
            objects.push({
              schema: found.id,
              schemaLabel: found.title,
              name: String(sheet.id),
              label: sheet.title,
              type: 'sheet',
              // A sheet's grid has room for more rows than it holds, so its size says little.
              rowEstimate: null,
            });
        }
        return objects;
      } catch (error) {
        throw failure(error, ctx, call);
      }
    },
    async describe(ctx, select) {
      return (await preview(ctx, select, 1)).columns;
    },
    preview,
    async keyCandidates(ctx, object: SourceObjectRef) {
      // A full read proves which columns are keys.  Row numbers are always offered, last.
      const scan = new AbortController();
      const timer = setTimeout(() => scan.abort(), keyScanMs);
      let call: Call | undefined;
      try {
        call = begin(ctx, deadlineMs, scan.signal);
        const { spreadsheet: found, sheet } = await sheetOf(call, { kind: 'object', object });
        const sampled = await sample(call, found.id, sheet);
        const open = new Map(
          sampled.columns
            .filter((entry) => entry.keyable && entry.index >= 0)
            .slice(0, 50)
            .map((entry) => [entry.column.name, { entry, seen: new Set<string>() }]),
        );
        let total = 0;
        for await (const rows of allRows(call, found.id, sheet, sampled))
          for (const row of rows) {
            total++;
            for (const [name, { entry, seen }] of open) {
              const key = keyOf(entry, row);
              const text = key === null || key === '' ? null : JSON.stringify(key);
              if (text === null || seen.has(text)) open.delete(name);
              else seen.add(text);
            }
          }
        return [...(total ? [...open.keys()].map((name) => [name]) : []), [ROW_NUMBER]];
      } catch (error) {
        if (scan.signal.aborted && !ctx.signal?.aborted) return [[ROW_NUMBER]];
        throw failure(error, ctx, call);
      } finally {
        clearTimeout(timer);
      }
    },
    async *read(ctx, select, readOptions) {
      let call: Call | undefined;
      try {
        const size = positive(readOptions.batchSize, 5000);
        call = begin(ctx, deadlineMs);
        const running = call;
        const { spreadsheet: found, sheet } = await sheetOf(running, select);
        const sampled = await sample(running, found.id, sheet);
        const byName = new Map(sampled.columns.map((entry) => [entry.column.name, entry]));
        // A column that has gone from the sheet fails the sync, rather than emptying its field.
        const columnOf = (name: string): SheetColumn => {
          const entry =
            byName.get(name) ??
            (sampled.names.includes(name)
              ? (() => {
                  const index = sampled.names.indexOf(name);
                  const reading = readingOf(emptyStats());
                  return {
                    column: cellColumn(name, reading.type, reading),
                    index,
                    reading,
                    keyable: false,
                  };
                })()
              : undefined);
          if (!entry)
            throw new ConnectorError(
              SHEETS_KEYS.columnMissing,
              `${sheet.title} has no column named ${name}`,
              {
                column: name,
              },
            );
          return entry;
        };
        const wanted = readOptions.columns.map((name) => [name, columnOf(name)] as const);
        const keys = readOptions.keyColumns.map(columnOf);
        const toRow = (row: SheetRow): SourceRow => ({
          key: sourceKey(keys.map((entry) => keyOf(entry, row))),
          values: Object.fromEntries(
            wanted.map(([name, entry]) => [
              name,
              valueOf(entry, row, readOptions.types[name] ?? entry.column.suggested?.type ?? 'text'),
            ]),
          ),
        });
        const batcher = new RowBatcher<SourceRow>(size);
        for await (const rows of allRows(running, found.id, sheet, sampled))
          for (const batch of batcher.add(rows.map(toRow))) {
            running.signal.throwIfAborted();
            yield batch;
          }
        const rest = batcher.flush();
        running.signal.throwIfAborted();
        if (rest) yield rest;
      } catch (error) {
        throw failure(error, ctx, call);
      }
    },
  };
}
