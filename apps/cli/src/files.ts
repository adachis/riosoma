import { message } from './messages.js';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { Failure, type Io } from './io.js';

/**
 * Files a transfer reads and writes.  Both ends stream: a reader hands over chunks as the file
 * gives them, and a writer waits for the disk to take one before it's given the next, so an export
 * of a table too big for memory finishes all the same, and a name of `-` means standard input or
 * output, which is what lets the tool sit in a pipe.
 */

/** Chunks of text from a file, or from standard input when the name is `-`. */
export async function* readText(path: string): AsyncGenerator<string> {
  if (path === '-') {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) yield String(chunk);
    return;
  }
  const stream = createReadStream(path, { encoding: 'utf8' });
  try {
    for await (const chunk of stream) yield String(chunk);
  } catch (error) {
    // A throw from a stream's own event would escape the caller, so it's caught where it's read.
    throw new Failure(
      message('cli.files.theFileCouldnTBeRead', { path: path, value2: (error as Error).message }),
    );
  }
}

/** Somewhere text is written to, which is standard output when no file was named. */
export interface Writer {
  /** Where the text went, for the line a command prints when it's done */
  where: string;
  write(text: string): Promise<void>;
  close(): Promise<void>;
}

export async function openWriter(path: string | null, io: Io): Promise<Writer> {
  if (!path || path === '-')
    return {
      where: message('cli.files.standardOutput'),
      async write(text) {
        await io.raw(text);
      },
      async close() {
        // Standard output isn't the tool's to close, and closing it would end the process early.
      },
    };
  const stream: WriteStream = createWriteStream(path);
  const failed = new Promise<never>((_settle, fail) => {
    stream.once('error', (error: Error) =>
      fail(new Failure(message('cli.files.theFileCouldnTBeWritten', { path: path, value2: error.message }))),
    );
  });
  return {
    where: path,
    async write(text) {
      if (!stream.write(text)) await drained(stream);
    },
    async close() {
      await Promise.race([new Promise<void>((settle) => stream.end(() => settle())), failed]);
    },
  };
}

/** Waits for a file to take what it was given, so a big export never outruns the disk. */
function drained(stream: { once(event: 'drain', listener: () => void): void }): Promise<void> {
  return new Promise((settle) => stream.once('drain', () => settle()));
}
