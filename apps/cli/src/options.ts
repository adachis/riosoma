import { message } from './messages.js';
import { splitList, type Args } from './args.js';
import { UsageError } from './io.js';

/**
 * The options more than one command takes, read in one place so `--page-size` means the same thing
 * everywhere and a mistake in one says the same as a mistake in another.
 */

/** How many records a request reads, which the API caps at a hundred. */
export function pageSizeOf(args: Args): number | undefined {
  return bounded(args.string('page-size'), '--page-size', 1, 100);
}

/** Whether values come back as data or as the text the app shows. */
export function cellFormatOf(args: Args): 'json' | 'string' | undefined {
  return oneOf(args.string('cell-format'), ['json', 'string'], '--cell-format');
}

/** Whether a write reads values as text where a field can take either, which is on unless turned off. */
export function typecastOf(args: Args): boolean {
  return args.boolean('typecast') || !args.boolean('no-typecast');
}

/** The most records to read, where 0 means every one. */
export function limitOf(args: Args): number {
  const value = args.string('limit');
  if (value === undefined) return 0;
  const found = Number(value);
  if (!Number.isInteger(found) || found < 0)
    throw new UsageError(message('cli.options.limitTakesAWholeNumberOfRecords'));
  return found;
}

/** How many records a request carries. */
export function batchOf(args: Args, fallback: number, largest: number): number {
  const value = args.string('batch');
  if (value === undefined) return fallback;
  const found = Number(value);
  if (!Number.isInteger(found) || found < 1 || found > largest)
    throw new UsageError(message('cli.options.batchTakesAWholeNumberFromTo', { largest: largest }));
  return found;
}

/** Which file shape a transfer uses, from the option or, without it, from the file's name. */
export function formatOf(args: Args, path: string, fallback: 'csv' | 'json'): 'csv' | 'json' {
  const given = oneOf(args.string('format'), ['csv', 'tsv', 'json', 'jsonl', 'ndjson'], '--format');
  if (given) return given === 'csv' || given === 'tsv' ? 'csv' : 'json';
  return /\.(?:json|jsonl|ndjson)$/i.test(path) ? 'json' : fallback;
}

/** What separates CSV fields, which a `.tsv` file's name says. */
export function delimiterOf(args: Args, path = ''): string | undefined {
  const given = args.string('delimiter');
  if (given) return given.length === 1 ? given : named(given);
  return /\.tsv$/i.test(path) ? '\t' : undefined;
}

function named(value: string): string {
  if (value.toLowerCase() === 'tab') return '\t';
  if (value.toLowerCase() === 'semicolon') return ';';
  throw new UsageError(message('cli.options.delimiterTakesOneCharacterOrTheWord'));
}

/** The fields a command was asked for, split on commas. */
export function fieldsOf(args: Args): string[] {
  return splitList(args.string('fields'));
}

export function bounded(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  const found = Number(value);
  if (!Number.isInteger(found) || found < min || found > max)
    throw new UsageError(message('cli.options.takesAWholeNumberFromTo', { name: name, min: min, max: max }));
  return found;
}

/** A list of choices as English reads it, with a comma between each and one "or" before the last. */
function listed(allowed: readonly string[]): string {
  if (allowed.length < 2) return allowed[0] ?? '';
  return message('cli.options.or', { value1: allowed.slice(0, -1).join(', '), value2: allowed.at(-1) ?? '' });
}

export function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  name: string,
): T | undefined {
  if (value === undefined) return undefined;
  const found = allowed.find((entry) => entry === value);
  if (!found) throw new UsageError(message('cli.options.takes', { name: name, value2: listed(allowed) }));
  return found;
}
