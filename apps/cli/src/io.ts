import { message } from './messages.js';
import { writeFileSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike, Sleep } from '@riosoma/sdk';
import { renderJson, renderTable, type Column } from './format.js';

/**
 * The world a command runs in: where it prints, what the environment says, and the few things only
 * this machine can do, which are opening a browser and reaching the keychain.  A command takes
 * these as arguments rather than reaching for `process` itself, so a test can run the whole tool
 * and read what it printed, and so nothing here has to guess whether it's being watched.
 */

/** A mistake in how the command was written, which the tool answers with its usage. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Something the command couldn't do, with a line under it saying what to try instead. */
export class Failure extends Error {
  readonly exitCode = 1;
  constructor(
    message: string,
    readonly details: { hint?: string; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'Failure';
  }
}

/** What a program of this machine printed and how it ended. */
export interface Spawned {
  status: number;
  stdout: string;
  stderr: string;
}

export type Spawn = (command: string, args: readonly string[], input?: string) => Promise<Spawned>;

export interface Io {
  /** Prints a line where the tool's answers go */
  print(text: string): void;
  /** Writes text with no line added, which is how a streamed answer reaches standard output */
  raw(text: string): Promise<void> | void;
  /** Prints a line where its warnings go, which a script's pipe leaves out */
  warn(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** Whether the answers are going to a terminal rather than a pipe */
  tty: boolean;
  /** Whether this run asked for JSON instead of a table */
  json: boolean;
  /** Whether this run asked for nothing but its answer */
  quiet: boolean;
  /** Sends a person to an address in their browser, and says whether one opened */
  open?: (url: string) => Promise<boolean>;
  fetch?: FetchLike;
  sleep?: Sleep;
  /** Runs a program of this machine, which is how the keychain is reached */
  spawn?: Spawn;
  /** The platform this is, which a test names to reach a keychain this machine doesn't have */
  platform?: string;
  now?: () => number;
  /** Where credentials are kept, which a test points at a folder of its own */
  home?: string;
}

/** Rows as a table, or the API's own values as JSON when the run asked for it. */
export function printList(
  io: Io,
  json: unknown,
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly Column[],
): void {
  io.print(io.json ? renderJson(json) : renderTable(rows, columns));
}

/** Rows as a table, or as JSON when the run asked for it. */
export function printRows(
  io: Io,
  rows: ReadonlyArray<Record<string, unknown>>,
  columns: readonly Column[],
): void {
  io.print(io.json ? renderJson(rows) : renderTable(rows, columns));
}

/**
 * A line about what a command did, which goes to standard error so a pipe sees only the answer, and
 * is left out of a run that asked for JSON or for nothing but its answer.
 */
export function note(io: Io, text: string): void {
  if (!io.json && !io.quiet) io.warn(text);
}

export interface TerminalOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  json?: boolean;
  quiet?: boolean;
  home?: string;
  platform?: string;
  open?: (url: string) => Promise<boolean>;
  fetch?: FetchLike;
  sleep?: Sleep;
  spawn?: Spawn;
  now?: () => number;
  print?: (text: string) => void;
  raw?: (text: string) => Promise<void> | void;
  warn?: (text: string) => void;
  tty?: boolean;
}

/** The tool as it runs from a terminal, with everything a test replaces named here. */
export function terminalIo(options: TerminalOptions = {}): Io {
  const env = options.env ?? process.env;
  return {
    print: options.print ?? ((text: string) => process.stdout.write(`${text}\n`)),
    raw:
      options.raw ??
      (async (text: string) => {
        if (!process.stdout.write(text)) await drained(process.stdout);
      }),
    warn: options.warn ?? ((text: string) => process.stderr.write(`${text}\n`)),
    env,
    cwd: options.cwd ?? process.cwd(),
    tty: options.tty ?? Boolean(process.stdout.isTTY),
    json: options.json ?? false,
    quiet: options.quiet ?? false,
    ...(options.open ? { open: options.open } : { open: openBrowser }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.spawn ? { spawn: options.spawn } : { spawn: runProgram }),
    platform: options.platform ?? process.platform,
    now: options.now ?? (() => Date.now()),
    home: options.home ?? env.RIOSOMA_CLI_HOME ?? join(homedir(), '.config', 'riosoma'),
  };
}

/** A program of this machine, run with something on its standard input and read to its end. */
export function runProgram(command: string, args: readonly string[], input?: string): Promise<Spawned> {
  return new Promise((settle) => {
    const child = spawnChild(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    // A failed program may close its input before the pipe is written.
    child.stdin.on('error', () => undefined);
    child.once('error', () =>
      settle({
        status: 127,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: message('cli.io.notInstalled'),
      }),
    );
    child.once('close', (status) =>
      settle({
        status: status ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      }),
    );
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

/**
 * Opens an address in whatever browser this machine answers with.  A headless machine has none, so
 * this says so rather than failing: every command that opens a browser also prints the address,
 * and a person can copy it into a browser of their own.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const found = process.platform;
  const command: [string, string[]] =
    found === 'darwin'
      ? ['open', [url]]
      : found === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    return (await runProgram(command[0], command[1])).status === 0;
  } catch {
    return false;
  }
}

/** Waits for a stream that asked for it, so a fast writer never outruns a slow reader. */
export function drained(stream: { once(event: 'drain', listener: () => void): void }): Promise<void> {
  return new Promise((settle) => stream.once('drain', () => settle()));
}

/** Writes a file only this person may read, which is how a credential that can't go in a keychain is kept. */
export function writePrivate(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
}
