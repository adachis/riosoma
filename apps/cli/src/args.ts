import { message } from './messages.js';
import { UsageError } from './io.js';

/**
 * Reading the words after `riosoma`.  The tool has no dependency to lean on for this, and a
 * command line has to answer exactly what a person typed: a flag they misspelled is a refusal that
 * names it, not a flag quietly ignored, and `--` ends the flags so a value that starts with a dash
 * can still be given.
 */

export interface FlagSpec {
  /** The flag takes a value, as `--url https://…` or `--url=https://…` */
  value?: boolean;
  /** Repeating the flag collects a list, as `--field Name=x --field Amount=1` */
  many?: boolean;
  /** A one-letter form, as `-f` for `--file` */
  short?: string;
  /** What the flag means, for the help a command prints */
  help?: string;
}

export type FlagSpecs = Record<string, FlagSpec>;

export interface Args {
  /** The words that name what to run and what to run it on, in the order they were typed */
  positional: string[];
  /** A flag's value, or undefined when it wasn't given */
  string(name: string): string | undefined;
  /** A flag that has to be there, or the refusal that says it isn't */
  required(name: string): string;
  /** Whether a flag with no value was given, or a valued one reads as yes */
  boolean(name: string): boolean;
  /** Every value a repeated flag carried, or an empty list */
  list(name: string): string[];
  /** Whether a flag was given at all, which a `--no-…` default turns on */
  given(name: string): boolean;
}

const FALSEY = ['false', 'no', 'off', '0'];

export function parseArgs(argv: readonly string[], specs: FlagSpecs = {}): Args {
  const byShort = new Map<string, string>();
  for (const [name, spec] of Object.entries(specs)) if (spec.short) byShort.set(spec.short, name);
  const values = new Map<string, string | boolean | string[]>();
  const positional: string[] = [];
  let onlyPositional = false;

  const set = (name: string, value: string | boolean) => {
    const spec = specs[name];
    if (spec?.many) {
      const found = values.get(name);
      values.set(name, [
        ...(Array.isArray(found) ? found : found === undefined ? [] : [String(found)]),
        String(value),
      ]);
      return;
    }
    values.set(name, value);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index]!;
    if (onlyPositional) {
      positional.push(word);
      continue;
    }
    if (word === '--') {
      onlyPositional = true;
      continue;
    }
    if (word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals < 0 ? word.slice(2) : word.slice(2, equals);
      const inline = equals < 0 ? undefined : word.slice(equals + 1);
      const spec = specs[name];
      if (!spec) throw new UsageError(message('cli.args.thereSNoOptionTryRiosomaHelp2', { name: name }));
      if (!spec.value) {
        if (inline !== undefined) throw new UsageError(message('cli.args.takesNoValue', { name: name }));
        set(name, true);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        value = argv[index + 1];
        if (value === undefined || value.startsWith('--'))
          throw new UsageError(message('cli.args.needsAValueAfterIt2', { name: name }));
        index += 1;
      }
      set(name, value);
      continue;
    }
    if (word.length > 1 && word.startsWith('-')) {
      const letters = word.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const letter = letters[at]!;
        const name = byShort.get(letter);
        if (!name) throw new UsageError(message('cli.args.thereSNoOptionTryRiosomaHelp', { letter: letter }));
        const spec = specs[name]!;
        if (!spec.value) {
          set(name, true);
          continue;
        }
        // Whatever follows the letter in this word is the value, or the next word is.
        let value = letters.slice(at + 1);
        if (value.startsWith('=')) value = value.slice(1);
        if (!value) {
          const next = argv[index + 1];
          if (next === undefined || next.startsWith('-'))
            throw new UsageError(message('cli.args.needsAValueAfterIt', { letter: letter }));
          value = next;
          index += 1;
        }
        set(name, value);
        break;
      }
      continue;
    }
    positional.push(word);
  }

  return {
    positional,
    string: (name) => {
      const found = values.get(name);
      if (found === undefined || typeof found === 'boolean') return undefined;
      return Array.isArray(found) ? found.at(-1) : found;
    },
    required: (name) => {
      const found = values.get(name);
      const value = Array.isArray(found) ? found.at(-1) : found;
      if (typeof value !== 'string' || !value)
        throw new UsageError(message('cli.args.thisCommandNeedsTryRiosomaHelp', { name: name }));
      return value;
    },
    boolean: (name) => {
      const found = values.get(name);
      if (typeof found === 'string') return !FALSEY.includes(found.toLowerCase());
      if (Array.isArray(found)) return Boolean(found.length);
      return found === true;
    },
    list: (name) => {
      const found = values.get(name);
      if (found === undefined || found === false) return [];
      if (Array.isArray(found)) return found;
      return found === true ? [] : [found];
    },
    given: (name) => values.has(name),
  };
}

/** A list from one flag, split on commas, as `--fields Name,Amount` gives two names. */
export function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
