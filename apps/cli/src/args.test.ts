import { describe, expect, it } from 'vitest';
import { parseArgs, splitList } from './args.js';
import { UsageError } from './io.js';

/**
 * How the words after `riosoma` are read.  A command line is an interface: an option nobody
 * defined is a refusal that names it, a value that starts with a dash is still a value once `--`
 * has ended the options, and a repeated option collects rather than replaces.
 */

const SPECS = {
  url: { value: true },
  token: { value: true },
  file: { value: true, short: 'f' },
  field: { value: true, many: true, short: 'F' },
  json: { short: 'j' },
  quiet: {},
  help: { short: 'h' },
};

describe('options', () => {
  it('reads a value after an option, joined to it, and as a word of its own', () => {
    expect(parseArgs(['--url', 'https://a.example'], SPECS).string('url')).toBe('https://a.example');
    expect(parseArgs(['--url=https://a.example'], SPECS).string('url')).toBe('https://a.example');
    expect(parseArgs(['--url', 'https://a.example'], SPECS).positional).toEqual([]);
  });

  it('reads an option with no value as given, and says so', () => {
    const args = parseArgs(['--json', 'databases'], SPECS);
    expect(args.boolean('json')).toBe(true);
    expect(args.boolean('quiet')).toBe(false);
    expect(args.given('json')).toBe(true);
    expect(args.given('quiet')).toBe(false);
    expect(args.positional).toEqual(['databases']);
  });

  it('collects a repeated option, and keeps the last of one that isn’t repeated', () => {
    expect(parseArgs(['--field', 'Name=Ada', '--field', 'Amount=1'], SPECS).list('field')).toEqual([
      'Name=Ada',
      'Amount=1',
    ]);
    expect(parseArgs(['--url', 'https://a.example', '--url', 'https://b.example'], SPECS).string('url')).toBe(
      'https://b.example',
    );
  });

  it('reads a short option, alone, joined to its value, and beside others', () => {
    expect(parseArgs(['-f', 'data.csv'], SPECS).string('file')).toBe('data.csv');
    expect(parseArgs(['-fdata.csv'], SPECS).string('file')).toBe('data.csv');
    expect(parseArgs(['-f=data.csv'], SPECS).string('file')).toBe('data.csv');
    expect(parseArgs(['-hj'], SPECS).boolean('help') && parseArgs(['-hj'], SPECS).boolean('json')).toBe(true);
    expect(parseArgs(['-FName=Ada'], SPECS).list('field')).toEqual(['Name=Ada']);
  });

  it('treats everything after -- as a value, so one may start with a dash', () => {
    const args = parseArgs(['records', '--', '--not-an-option'], SPECS);
    expect(args.positional).toEqual(['records', '--not-an-option']);
  });

  it('refuses an option nobody defined, and one given without the value it needs', () => {
    expect(() => parseArgs(['--nope'], SPECS)).toThrow(UsageError);
    expect(() => parseArgs(['--nope'], SPECS)).toThrow(/--nope/);
    expect(() => parseArgs(['--url'], SPECS)).toThrow(/needs a value/);
    expect(() => parseArgs(['--url', '--json'], SPECS)).toThrow(/needs a value/);
    expect(() => parseArgs(['--json=x'], SPECS)).toThrow(/takes no value/);
    expect(() => parseArgs(['-z'], SPECS)).toThrow(/-z/);
  });

  it('says which of a list is there, and reads a required one', () => {
    expect(() => parseArgs([], SPECS).required('file')).toThrow(/needs --file/);
    expect(parseArgs(['--file', 'a.csv'], SPECS).required('file')).toBe('a.csv');
    expect(splitList(' Name , Amount ,,Due ')).toEqual(['Name', 'Amount', 'Due']);
    expect(splitList(undefined)).toEqual([]);
  });
});
