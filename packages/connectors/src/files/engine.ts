import { open, readFile } from 'node:fs/promises';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { CellValue, FileFormat, SheetCell, SourceColumn } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { describeColumn, type Described } from '../warehouses/mapping.js';
import { duckTypeClass, plainOfDuck } from '../warehouses/motherduck.js';
import { cellOf, keyPartOf } from '../warehouses/values.js';
import {
  cellColumn,
  cellValue,
  emptyStats,
  keyFieldType,
  observe,
  readingOf,
  SAMPLE_VALUES,
  type CellReading,
  type FileCell,
} from './cells.js';
import { CELL_FORMATS } from './formats.js';

/**
 * DuckDB, locked into one temporary directory.  Downloaded files land there, the engine reads them
 * into one table, and every question a connector asks (columns, rows, counts, and which columns
 * could be a key) is a query against that table.  The engine can't read or write anything outside
 * the directory, can't reach the network, and can't load an extension, and nothing it runs ever
 * comes from a person: file sources don't take queries.
 */

export type SpreadsheetEvent =
  | { kind: 'sheet'; name: string; position: number }
  | { kind: 'row'; number: number; cells: SheetCell[] }
  | { kind: 'end'; rows: number; total: number };

/** Reads a workbook's sheets and rows the way uploaded workbooks are read.  The server supplies it. */
export type SpreadsheetReader = (
  bytes: Buffer,
  options: { signal?: AbortSignal },
) => AsyncIterable<SpreadsheetEvent>;

export interface LocalFile {
  /** Where the file came from, which messages name instead of the local path */
  name: string;
  path: string;
  format: FileFormat;
}

export interface LoadOptions {
  sheet?: string;
  spreadsheet?: SpreadsheetReader;
  spreadsheetMaxBytes: number;
  signal?: AbortSignal;
}

/** One column: how it's described, and how its values become cells and key parts. */
export interface FileColumn {
  column: SourceColumn;
  value(raw: unknown, fieldType: string): CellValue;
  key(raw: unknown): CellValue;
  /** Whether it can be offered as a key: short values that people can tell apart */
  keyable: boolean;
}

export const KEYS = {
  unreadable: 'sources.file.unreadable',
  columnsDiffer: 'sources.file.columnsDiffer',
  sheetMissing: 'sources.file.sheetMissing',
  tooLarge: 'sources.file.tooLarge',
} as const;

const TABLE = 'data';
/** Columns a key candidate scan looks at, first ones first. */
const KEY_COLUMNS = 50;
/**
 * Rows the type scan reads at most.  The importer reads every row for a column's first thousand
 * values, which only a column almost always empty in a very large file would need, so a sync stops
 * here instead of reading millions of rows before it starts.
 */
const SAMPLE_ROWS = 100_000;
const KEYABLE_TYPES = new Set(['number', 'text', 'email', 'url', 'phone', 'date']);

function literal(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

export function quoteName(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Column names the way DuckDB's CSV reader writes them: blanks by position, repeats numbered. */
function namesOf(header: readonly string[]): string[] {
  const used = new Set<string>();
  return header.map((raw, index) => {
    const base = raw.trim() === '' ? `column${index}` : raw;
    let name = base;
    for (let suffix = 1; used.has(name.toLowerCase()); suffix++) name = `${base}_${suffix}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function sameColumns(first: readonly string[], other: readonly string[]): boolean {
  if (first.length !== other.length) return false;
  const names = new Set(first);
  return other.every((name) => names.has(name));
}

async function startsWithUtf16(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    return (head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff);
  } finally {
    await handle.close();
  }
}

/** The reader for one downloaded file, as a table expression. */
async function readerSql(file: LocalFile): Promise<string> {
  const path = literal(file.path);
  switch (file.format) {
    case 'csv':
    case 'tsv': {
      const options = ['all_varchar = true', 'header = true', 'null_padding = true'];
      if (file.format === 'tsv') options.push(`delim = '\\t'`, `quote = '"'`);
      if (await startsWithUtf16(file.path)) options.push(`encoding = 'utf-16'`);
      return `read_csv(${path}, ${options.join(', ')})`;
    }
    case 'json':
      return `read_json(${path}, format = 'auto')`;
    case 'ndjson':
      return `read_json(${path}, format = 'newline_delimited')`;
    case 'parquet':
      return `read_parquet(${path})`;
    case 'xlsx':
      throw new ConnectorError(KEYS.unreadable, 'workbooks are read by the spreadsheet reader');
  }
}

export class FileEngine {
  private columns: FileColumn[] | null = null;
  private family: 'cells' | 'typed' = 'typed';
  /** Whether the table holds a workbook's cells as JSON rather than a text file's cells */
  private workbook = false;
  private closed = false;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
  ) {}

  /** An engine that can reach nothing but `dir`, which it also spills to. */
  static async open(dir: string): Promise<FileEngine> {
    const instance = await DuckDBInstance.create(':memory:', {
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      threads: '2',
      memory_limit: '1GB',
      preserve_insertion_order: 'true',
    });
    let connection: DuckDBConnection | undefined;
    try {
      connection = await instance.connect();
      // The directory is allowed before outside access goes, and then the settings are locked.
      for (const statement of [
        `SET temp_directory = ${literal(`${dir}/spill`)}`,
        `SET allowed_directories = [${literal(`${dir}/`)}]`,
        'SET enable_external_access = false',
        'SET lock_configuration = true',
      ])
        await connection.run(statement);
      return new FileEngine(instance, connection);
    } catch (error) {
      try {
        connection?.disconnectSync();
        instance.closeSync();
      } catch {
        // The error that stopped the opening is the one worth keeping.
      }
      throw error;
    }
  }

  interrupt(): void {
    try {
      this.connection.interrupt();
    } catch {
      // Interrupting an idle connection is harmless.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const step of [
      () => this.connection.interrupt(),
      () => this.connection.disconnectSync(),
      () => this.instance.closeSync(),
    ]) {
      try {
        step();
      } catch {
        // Closing is best effort.
      }
    }
  }

  private async names(sql: string): Promise<string[]> {
    const prepared = await this.connection.prepare(`SELECT * FROM ${sql}`);
    return Array.from({ length: prepared.columnCount }, (_unused, index) => prepared.columnName(index));
  }

  /**
   * Reads the files into one table, in order, so every later question reads the table instead of
   * parsing the files again.  Files read together must have the same columns.
   */
  async load(files: readonly LocalFile[], options: LoadOptions): Promise<void> {
    const format = files[0]?.format;
    if (!format) throw new ConnectorError(KEYS.unreadable, 'there are no files to read');
    this.family = CELL_FORMATS.has(format) ? 'cells' : 'typed';
    this.workbook = format === 'xlsx';
    if (format === 'xlsx') {
      await this.loadWorkbooks(files, options);
      return;
    }
    const readers: string[] = [];
    let first: string[] = [];
    for (const [index, file] of files.entries()) {
      const reader = await readerSql(file);
      const names = await this.names(reader);
      if (index === 0) first = names;
      else if (!sameColumns(first, names))
        throw new ConnectorError(KEYS.columnsDiffer, `${file.name} has different columns`, {
          file: file.name,
        });
      readers.push(reader);
    }
    // The table takes the type every file fits, then each file goes in after the last, in order.
    const shape = readers.map((reader) => `SELECT * FROM ${reader}`).join(' UNION ALL BY NAME ');
    await this.connection.run(`CREATE TABLE ${TABLE} AS SELECT * FROM (${shape}) LIMIT 0`);
    for (const reader of readers) {
      options.signal?.throwIfAborted();
      await this.connection.run(`INSERT INTO ${TABLE} BY NAME SELECT * FROM ${reader}`);
    }
  }

  /**
   * Workbooks arrive through the spreadsheet reader as typed cells, which are kept as JSON text so
   * a number, a date, and the text that looks like one stay apart.
   */
  private async loadWorkbooks(files: readonly LocalFile[], options: LoadOptions): Promise<void> {
    const reader = options.spreadsheet;
    if (!reader) throw new ConnectorError(KEYS.unreadable, 'this server reads no workbooks');
    const sheets: Array<{ file: LocalFile; bytes: Buffer; names: string[] }> = [];
    for (const file of files) {
      const bytes = await readFile(file.path);
      if (bytes.length > options.spreadsheetMaxBytes)
        throw new ConnectorError(KEYS.tooLarge, `${file.name} is larger than a workbook may be`, {
          megabytes: Math.floor(options.spreadsheetMaxBytes / 1024 / 1024),
        });
      let header: string[] | null = null;
      let width = 0;
      for await (const row of this.sheetRows(reader, bytes, file, options)) {
        if (header === null) header = row.map((cell) => (cell === null ? '' : textOfHeader(cell)));
        width = Math.max(width, row.length);
      }
      header ??= [];
      const names = namesOf([...header, ...Array<string>(Math.max(0, width - header.length)).fill('')]);
      const first = sheets[0]?.names;
      if (first && !sameColumns(first, names))
        throw new ConnectorError(KEYS.columnsDiffer, `${file.name} has different columns`, {
          file: file.name,
        });
      sheets.push({ file, bytes, names });
    }
    const names = sheets[0]!.names;
    await this.connection.run(
      `CREATE TABLE ${TABLE} (${names.map((name) => `${quoteName(name)} VARCHAR`).join(', ')})`,
    );
    const appender = await this.connection.createAppender(TABLE);
    try {
      for (const { file, bytes, names: own } of sheets) {
        // Each workbook's columns go where the first one's names put them.
        const place = names.map((name) => own.indexOf(name));
        let header = true;
        for await (const row of this.sheetRows(reader, bytes, file, options)) {
          if (header) {
            header = false;
            continue;
          }
          for (const index of place) {
            const cell = row[index];
            if (cell === null || cell === undefined) appender.appendNull();
            else appender.appendVarchar(JSON.stringify(cell));
          }
          appender.endRow();
        }
      }
      appender.flushSync();
    } finally {
      appender.closeSync();
    }
  }

  /** The chosen sheet's rows, the first sheet when none is named. */
  private async *sheetRows(
    reader: SpreadsheetReader,
    bytes: Buffer,
    file: LocalFile,
    options: LoadOptions,
  ): AsyncGenerator<SheetCell[]> {
    let reading = false;
    let found = false;
    for await (const event of reader(bytes, { signal: options.signal })) {
      if (event.kind === 'sheet') {
        if (found) break;
        reading = options.sheet === undefined ? true : event.name === options.sheet;
        found = reading;
      } else if (event.kind === 'row' && reading) yield event.cells;
      else if (event.kind === 'end' && reading) {
        if (event.total > event.rows)
          throw new ConnectorError(KEYS.tooLarge, `${file.name} has more rows than a sheet may`);
        break;
      }
    }
    if (!found)
      throw new ConnectorError(
        KEYS.sheetMissing,
        options.sheet === undefined
          ? `${file.name} has no sheets`
          : `${file.name} has no sheet ${options.sheet}`,
        { sheet: options.sheet ?? '' },
      );
  }

  /** The table's columns, each with how its values are read. */
  async describe(): Promise<FileColumn[]> {
    if (this.columns) return this.columns;
    const prepared = await this.connection.prepare(`SELECT * FROM ${TABLE}`);
    const count = prepared.columnCount;
    if (this.family === 'typed') {
      this.columns = Array.from({ length: count }, (_unused, index) => {
        const type = prepared.columnType(index);
        const { kind, scale, labels } = duckTypeClass(type);
        const described = describeColumn({
          name: prepared.columnName(index),
          sourceType: type.alias ?? String(type),
          nullable: true,
          kind,
          scale: scale ?? null,
          ...(labels === undefined ? {} : { labels }),
        });
        return typedColumn(described);
      });
      return this.columns;
    }
    const names = Array.from({ length: count }, (_unused, index) => prepared.columnName(index));
    const decode = this.decoder();
    const stats = names.map(() => emptyStats());
    // The importer decides on each column's first thousand values, so the scan stops once it has them.
    for await (const chunk of this.rows(names, SAMPLE_ROWS)) {
      for (const row of chunk)
        for (let index = 0; index < names.length; index++) observe(stats[index]!, decode(row[index]));
      if (stats.every((entry) => entry.count >= SAMPLE_VALUES)) break;
    }
    const sourceType = this.workbook ? 'CELL' : 'VARCHAR';
    this.columns = names.map((name, index) =>
      cellFileColumn(name, sourceType, readingOf(stats[index]!), decode),
    );
    return this.columns;
  }

  /** How a stored value becomes a cell: CSV text as it is, a workbook's cells from their JSON. */
  private decoder(): (raw: unknown) => FileCell {
    if (!this.workbook) return (raw) => (typeof raw === 'string' ? raw : null);
    return (raw) => {
      if (typeof raw !== 'string') return null;
      try {
        return JSON.parse(raw) as FileCell;
      } catch {
        return raw;
      }
    };
  }

  /** The chosen columns' values, as plain values, in the order the files held them. */
  async *rows(names: readonly string[], limit?: number): AsyncGenerator<unknown[][]> {
    const projection = names.length ? names.map(quoteName).join(', ') : '*';
    const result = await this.connection.stream(
      `SELECT ${projection} FROM ${TABLE}${limit === undefined ? '' : ` LIMIT ${Math.trunc(limit)}`}`,
    );
    for await (const chunk of result.yieldRows())
      yield chunk.map((values) => values.map((value) => plainOfDuck(value)));
  }

  async count(): Promise<number> {
    const reader = await this.connection.runAndReadAll(`SELECT count(*) AS total FROM ${TABLE}`);
    return Number((reader.getRowObjectsJS()[0] as { total?: unknown } | undefined)?.total ?? 0);
  }

  /**
   * Columns whose values are all there and all different in a full scan, since files declare no
   * keys.  An empty file proves nothing, so it offers none.
   */
  async keyCandidates(columns: readonly FileColumn[]): Promise<string[][]> {
    const keyable = columns.filter((entry) => entry.keyable).slice(0, KEY_COLUMNS);
    if (!keyable.length) return [];
    const parts = keyable.flatMap((entry, index) => {
      const name = quoteName(entry.column.name);
      return [
        `count(DISTINCT ${name}) AS d${index}`,
        `count(*) FILTER (WHERE ${name} IS NULL OR trim(CAST(${name} AS VARCHAR)) = '') AS e${index}`,
      ];
    });
    const reader = await this.connection.runAndReadAll(
      `SELECT count(*) AS total, ${parts.join(', ')} FROM ${TABLE}`,
    );
    const row = reader.getRowObjectsJS()[0] as Record<string, unknown>;
    const total = Number(row.total ?? 0);
    if (total === 0) return [];
    return keyable
      .filter((_entry, index) => Number(row[`d${index}`]) === total && Number(row[`e${index}`]) === 0)
      .map((entry) => [entry.column.name]);
  }
}

function textOfHeader(cell: SheetCell): string {
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (cell && 'date' in cell) return cell.date.replace('T', ' ');
  return cell && 'error' in cell ? cell.error : '';
}

function typedColumn(described: Described): FileColumn {
  const suggested = described.column.suggested?.type;
  return {
    column: described.column,
    value: (raw, fieldType) => cellOf(raw, fieldType, described),
    key: (raw) => keyPartOf(raw, described),
    keyable:
      suggested !== undefined &&
      KEYABLE_TYPES.has(suggested) &&
      !['json', 'boolean', 'binary', 'unknown'].includes(described.kind),
  };
}

function cellFileColumn(
  name: string,
  sourceType: string,
  reading: CellReading,
  decode: (raw: unknown) => FileCell,
): FileColumn {
  return {
    column: cellColumn(name, sourceType, reading),
    value: (raw, fieldType) => cellValue(decode(raw), fieldType, reading),
    key: (raw) => cellValue(decode(raw), keyFieldType(reading), reading),
    keyable: KEYABLE_TYPES.has(keyFieldType(reading)),
  };
}
