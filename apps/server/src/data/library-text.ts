import { Worker } from 'node:worker_threads';
import { AppError } from '@riosoma/contracts';

const invalid = () => new AppError('validation_failed', 'libraries.unreadable');
const limit = () => new AppError('payload_too_large', 'libraries.limit');
const MAX_INPUT = 10 * 1024 * 1024;
const MAX_WORKERS = 2;
const waiting: Array<{ person: string; start: () => void }> = [];
const people = new Set<string>();
let active = 0;

export interface LibraryChunk {
  section: string;
  text: string;
  value: number[] | null;
}
export interface LibraryText {
  text: string;
  chunks: LibraryChunk[];
}

function advance() {
  while (active < MAX_WORKERS) {
    const index = waiting.findIndex((item) => !people.has(item.person));
    if (index < 0) return;
    waiting.splice(index, 1)[0]!.start();
  }
}

/** A bounded waiting list lets other people proceed while one person has an active worker. */
export async function prepareLibraryText(
  name: string,
  bytes: Buffer,
  maxText = 500000,
  person = '',
  signal?: AbortSignal,
): Promise<LibraryText> {
  if (!bytes.length || name.length > 200) throw invalid();
  if (bytes.length > MAX_INPUT) throw limit();
  signal?.throwIfAborted();
  if (waiting.length >= 8 || waiting.filter((item) => item.person === person).length >= 3) throw limit();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(item);
      if (index >= 0) waiting.splice(index, 1);
      reject(signal!.reason);
    };
    const item = {
      person,
      start: () => {
        signal?.removeEventListener('abort', abort);
        active++;
        people.add(person);
        resolve();
      },
    };
    waiting.push(item);
    signal?.addEventListener('abort', abort, { once: true });
    advance();
  });
  let worker: Worker | undefined;
  try {
    signal?.throwIfAborted();
    const built = import.meta.url.endsWith('.js');
    worker = new Worker(
      new URL(built ? './library-text-worker.js' : './library-text-worker.ts', import.meta.url),
      {
        workerData: { name, bytes, maxText },
        execArgv: built ? [] : ['--import', 'tsx'],
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 },
      },
    );
    const thread = worker;
    return await new Promise<LibraryText>((resolve, reject) => {
      const finish = (error?: unknown, result?: LibraryText) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => finish(signal!.reason);
      const timer = setTimeout(() => finish(limit()), 5000);
      signal?.addEventListener('abort', abort, { once: true });
      thread.once('message', (result: LibraryText & { error?: string }) =>
        finish(result.error ? (result.error === 'libraries.limit' ? limit() : invalid()) : undefined, result),
      );
      thread.once('error', (error: Error & { code?: string }) =>
        finish(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? limit() : invalid()),
      );
      thread.once('exit', () => finish(invalid()));
    });
  } finally {
    await worker?.terminate();
    active--;
    people.delete(person);
    advance();
  }
}

export async function extractLibraryText(name: string, bytes: Buffer, maxText = 500000) {
  return (await prepareLibraryText(name, bytes, maxText)).text;
}

/** Heading scanning and minimum passage sizes bound both CPU work and embedding fan-out. */
export function chunkLibraryText(text: string, maxText = 500000): LibraryChunk[] {
  if (text.length > Math.min(maxText, 500000)) throw limit();
  const chunks: LibraryChunk[] = [];
  const headings: string[] = [];
  let pending = '';
  let section = '';
  const flush = () => {
    if (pending.trim()) chunks.push({ section, text: pending.trim(), value: null });
    pending = '';
    if (chunks.length > Math.max(1, Math.ceil(maxText / 1000))) throw limit();
  };
  const append = (line: string) => {
    const parts = line.match(/[\s\S]{1,1200}/gu) ?? [''];
    for (const [index, part] of parts.entries()) {
      if (pending.length + part.length + 1 > 3000) flush();
      if (!pending) section = headings.filter(Boolean).join(' / ').slice(0, 500);
      pending += part + (index === parts.length - 1 ? '\n' : '');
    }
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    let level = 0;
    while (level < 7 && line[level] === '#') level++;
    const heading =
      level > 0 && level <= 6 && (line[level] === ' ' || line[level] === '\t')
        ? line.slice(level + 1).trim()
        : '';
    if (heading) {
      if (pending.length >= 1000) flush();
      headings.length = level;
      headings[level - 1] = heading;
      if (pending) append(line);
    } else append(line);
  }
  flush();
  if (!chunks.length && headings.some(Boolean))
    chunks.push({
      section: headings.filter(Boolean).join(' / ').slice(0, 500),
      text: headings.filter(Boolean).join('\n'),
      value: null,
    });
  if (!chunks.length) throw invalid();
  return chunks;
}
