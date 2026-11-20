import { csvCell, csvRow } from './csv.js';
import type { Writer } from './files.js';
import type { RioRecord } from '@riosoma/sdk';

/**
 * The shapes a transfer writes, both of them streamed: a record is written as it arrives and none
 * of them is held, so an export of a table too big for memory finishes all the same.  The two
 * shapes are the ones an import reads back, which is what makes a round trip through a file work.
 */

export interface RecordWriter {
  /** Writes one record, and whatever a file needs before its first one */
  write(record: RioRecord): Promise<void>;
  /** Ends the file, which a JSON array needs and an empty CSV needs its heading for */
  end(): Promise<void>;
  /** The field names written, which the first record settles when no list was given */
  columns(): string[];
  readonly count: number;
}

/** Records as a JSON array, one per line, which a reader can also take one line at a time. */
export function jsonRecordWriter(writer: Writer): RecordWriter {
  let count = 0;
  let started = false;
  return {
    get count() {
      return count;
    },
    columns: () => [],
    async write(record) {
      await writer.write(`${started ? ',\n' : '[\n'}  ${JSON.stringify(record)}`);
      started = true;
      count += 1;
    },
    async end() {
      await writer.write(started ? '\n]\n' : '[]\n');
    },
  };
}

export interface CsvWriterOptions {
  /** The fields to write, in this order, or the first record's own when none is given */
  columns?: string[];
  /** Whether to write a leading `id` column, which an import reads back as the record to change */
  withId?: boolean;
  delimiter?: string;
}

/** Records as CSV, with a heading row of field names. */
export function csvRecordWriter(writer: Writer, options: CsvWriterOptions = {}): RecordWriter {
  const delimiter = options.delimiter ?? ',';
  const requested = options.columns?.length ? [...options.columns] : null;
  let count = 0;
  let heading: string[] | null = null;

  const head = async (names: string[]) => {
    heading = names;
    await writer.write(`${csvRow([...(options.withId ? ['id'] : []), ...names], delimiter)}\n`);
  };

  return {
    get count() {
      return count;
    },
    columns: () => heading ?? requested ?? [],
    async write(record) {
      if (!heading) await head(requested ?? Object.keys(record.fields));
      const cells = heading!.map((name) => csvCell(record.fields[name]));
      await writer.write(`${csvRow([...(options.withId ? [record.id] : []), ...cells], delimiter)}\n`);
      count += 1;
    },
    async end() {
      // A table with nothing in it still gets its heading, so the file says what it would have held.
      if (!heading && requested) await head(requested);
    },
  };
}
