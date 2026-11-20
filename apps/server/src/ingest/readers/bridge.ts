import { lookup, type ExtractedSource, type IngestRow, type Scalar } from '@riosoma/ingest';
import { ScriptError, type ScriptHost } from '../../automations/script.js';
import { READER_LIMITS, type LookupTables, type ReaderCheck, type ReaderFacts } from './types.js';

function dictionary(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
  );
}
function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function jsonValue(value: unknown, depth = 0): boolean {
  if (scalar(value)) return true;
  if (depth >= 16) return false;
  return Array.isArray(value)
    ? value.every((item) => jsonValue(item, depth + 1))
    : dictionary(value) && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
function validRow(value: unknown): value is IngestRow {
  if (!dictionary(value) || !keys(value, ['values', 'at', 'raw'])) return false;
  const { values, at, raw } = value;
  return (
    dictionary(values) &&
    Object.values(values).every(scalar) &&
    dictionary(raw) &&
    Object.values(raw).every((item) => typeof item === 'string') &&
    dictionary(at) &&
    Object.entries(at).every(([key, item]) =>
      key === 'sheet'
        ? typeof item === 'string'
        : ['row', 'page', 'line', 'table'].includes(key) && integer(item) && item > 0,
    )
  );
}

/** Each run owns its output.  Only the selected, validated slice of the source crosses the bridge. */
export class ReaderBridge implements ScriptHost {
  readonly rows: IngestRow[] = [];
  readonly checks: ReaderCheck[] = [];
  readonly notes: string[] = [];
  private outputBytes = 0;
  private closed = false;

  constructor(
    private readonly source: ExtractedSource,
    private readonly lookups: LookupTables,
    private readonly facts: ReaderFacts,
  ) {}

  close(discard = false): void {
    this.closed = true;
    if (discard) {
      this.rows.length = 0;
      this.checks.length = 0;
      this.notes.length = 0;
    }
  }

  async call(method: string, args: unknown[], remainingMs: number): Promise<unknown> {
    const refuse = () => {
      throw new ScriptError('ingest.reader.invalidArgument');
    };
    if (this.closed || remainingMs <= 0) throw new ScriptError('automations.script.timeout');
    if (!Array.isArray(args)) return refuse();
    switch (method) {
      case 'source.sheets': {
        if (args.length) return refuse();
        return (this.source.sheets ?? []).map((sheet) => {
          if (
            typeof sheet.name !== 'string' ||
            typeof sheet.hidden !== 'boolean' ||
            !Array.isArray(sheet.rows)
          )
            return refuse();
          const merges = sheet.merges ?? [];
          if (
            !merges.every(
              (merge) =>
                dictionary(merge) &&
                keys(merge as unknown as Record<string, unknown>, ['top', 'left', 'bottom', 'right']) &&
                [merge.top, merge.left, merge.bottom, merge.right].every(
                  (item) => integer(item) && item > 0,
                ) &&
                merge.bottom >= merge.top &&
                merge.right >= merge.left,
            )
          )
            return refuse();
          let columnCount = 0;
          for (const row of sheet.rows) {
            if (!Array.isArray(row)) return refuse();
            columnCount = Math.max(columnCount, row.length);
          }
          return { name: sheet.name, hidden: sheet.hidden, rowCount: sheet.rows.length, columnCount, merges };
        });
      }
      case 'source.rows': {
        const [name, start, count] = args;
        // Paging uses zero-based offsets.  Emitted locations remain one-based.
        if (
          args.length !== 3 ||
          typeof name !== 'string' ||
          !integer(start) ||
          !integer(count) ||
          count > READER_LIMITS.pageRows
        )
          return refuse();
        const sheet = this.source.sheets?.find((sheet) => sheet.name === name);
        if (!sheet || !Array.isArray(sheet.rows)) return refuse();
        return sheet.rows.slice(start, start + count).map((row) => {
          if (!Array.isArray(row)) return refuse();
          return row.map((cell) => {
            if (
              !dictionary(cell) ||
              !keys(cell, ['v', 't']) ||
              !scalar(cell.v) ||
              !(cell.t === 'empty'
                ? cell.v === null
                : cell.t === 'number'
                  ? typeof cell.v === 'number'
                  : cell.t === 'bool'
                    ? typeof cell.v === 'boolean'
                    : typeof cell.t === 'string' &&
                      ['text', 'date'].includes(cell.t) &&
                      typeof cell.v === 'string')
            )
              return refuse();
            return cell;
          });
        });
      }
      case 'source.pages':
        if (args.length) return refuse();
        return (this.source.pages ?? []).map((page) => {
          if (
            !integer(page.number) ||
            page.number < 1 ||
            typeof page.text !== 'string' ||
            !['clean', 'garbled', 'none'].includes(page.textQuality)
          )
            return refuse();
          return { number: page.number, text: page.text, textQuality: page.textQuality };
        });
      case 'source.email': {
        if (args.length) return refuse();
        const email = this.source.email;
        if (!email) return null;
        if (
          !['from', 'subject', 'date', 'bodyText', 'messageId'].every(
            (key) => typeof email[key as keyof typeof email] === 'string',
          ) ||
          ![email.originalFrom, email.originalDate].every(
            (value) => value === undefined || typeof value === 'string',
          ) ||
          !Array.isArray(email.tables) ||
          !email.tables.every(
            (table) =>
              Array.isArray(table) &&
              table.every((row) => Array.isArray(row) && row.every((value) => typeof value === 'string')),
          )
        )
          return refuse();
        return {
          from: email.from,
          subject: email.subject,
          date: email.date,
          bodyText: email.bodyText,
          messageId: email.messageId,
          tables: email.tables,
          ...(email.originalFrom === undefined ? {} : { originalFrom: email.originalFrom }),
          ...(email.originalDate === undefined ? {} : { originalDate: email.originalDate }),
        };
      }
      case 'emit': {
        const batch = args[0];
        if (args.length !== 1 || !Array.isArray(batch) || !batch.every(validRow))
          throw new ScriptError('ingest.reader.invalidRow');
        if (this.rows.length + batch.length > READER_LIMITS.rows)
          throw new ScriptError('ingest.reader.rowLimit');
        this.outputBytes += Buffer.byteLength(JSON.stringify(batch));
        if (this.outputBytes > READER_LIMITS.outputBytes) throw new ScriptError('ingest.reader.invalidRow');
        for (const row of batch) this.rows.push(row);
        return null;
      }
      case 'check': {
        const [name, expected, actual] = args;
        if (
          args.length !== 3 ||
          typeof name !== 'string' ||
          name.length > 500 ||
          !scalar(expected) ||
          !scalar(actual) ||
          this.checks.length >= READER_LIMITS.checks
        )
          return refuse();
        this.outputBytes += Buffer.byteLength(JSON.stringify({ name, expected, actual }));
        if (this.outputBytes > READER_LIMITS.outputBytes) return refuse();
        this.checks.push({ name, expected, actual });
        return null;
      }
      case 'note': {
        const [text] = args;
        if (
          args.length !== 1 ||
          typeof text !== 'string' ||
          Array.from(text).length > READER_LIMITS.noteCharacters ||
          this.notes.length >= READER_LIMITS.notes
        )
          return refuse();
        this.notes.push(text);
        return null;
      }
      case 'lookup': {
        const [fieldKey, text] = args;
        if (args.length !== 2 || typeof fieldKey !== 'string' || typeof text !== 'string') return refuse();
        const entries = Object.hasOwn(this.lookups, fieldKey) ? this.lookups[fieldKey] : {};
        if (!dictionary(entries) || !Object.values(entries).every(scalar)) return refuse();
        return lookup(text, { entries: entries as Record<string, Scalar> });
      }
      case 'fact': {
        const [name] = args;
        if (args.length !== 1 || typeof name !== 'string') return refuse();
        const value = Object.hasOwn(this.facts, name) ? this.facts[name] : null;
        if (!jsonValue(value)) return refuse();
        return value;
      }
      default:
        return refuse();
    }
  }
}
