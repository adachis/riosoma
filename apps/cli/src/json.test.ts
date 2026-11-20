import { describe, expect, it } from 'vitest';
import { readJsonValues } from './json.js';

/**
 * Reading JSON records as they arrive.  An import file is either an array of records or one record
 * per line, and either can be bigger than memory, so the reader hands over one value at a time and
 * says which one was wrong when the file is.
 */

async function* chunks(text: string, size: number): AsyncGenerator<string> {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

async function values(text: string, size = 1): Promise<unknown[]> {
  const found: unknown[] = [];
  for await (const value of readJsonValues(chunks(text, size))) found.push(value);
  return found;
}

describe('reading JSON records', () => {
  it('reads an array of objects, whatever size the chunks arrive in', async () => {
    const text = '[{"fields":{"Name":"Ada"}}, {"fields":{"Name":"Grace"}}]';
    expect(await values(text, text.length)).toEqual([
      { fields: { Name: 'Ada' } },
      { fields: { Name: 'Grace' } },
    ]);
    for (const size of [1, 3, 9, 17]) expect(await values(text, size)).toEqual(await values(text, 1000));
  });

  it('reads an array spread over lines, and one with an empty record list', async () => {
    const text = '[\n  {"id": "rec1", "fields": {"Name": "Ada"}},\n  {"fields": {"Name": "Grace"}}\n]\n';
    expect(await values(text)).toEqual([
      { id: 'rec1', fields: { Name: 'Ada' } },
      { fields: { Name: 'Grace' } },
    ]);
    expect(await values('[]')).toEqual([]);
    expect(await values('[ ]\n')).toEqual([]);
  });

  it('reads a record per line, with blank lines between', async () => {
    const text = '{"fields":{"Name":"Ada"}}\n\n{"fields":{"Name":"Grace"}}\n';
    expect(await values(text)).toEqual([{ fields: { Name: 'Ada' } }, { fields: { Name: 'Grace' } }]);
    expect(await values('{"a":1}')).toEqual([{ a: 1 }]);
  });

  it('keeps a value whose text holds the characters a reader watches for', async () => {
    const text = JSON.stringify([
      { fields: { Notes: 'braces { } and brackets [ ] and a "quote" and a \\ backslash' } },
      { fields: { Nested: { list: [1, 2, { deep: 'x}' }] } } },
    ]);
    expect(await values(text)).toEqual(JSON.parse(text));
  });

  it('reads a file that starts with a mark some editors leave', async () => {
    expect(await values('\uFEFF[{"a":1}]')).toEqual([{ a: 1 }]);
    expect(await values('\uFEFF{"a":1}\n')).toEqual([{ a: 1 }]);
  });

  it('says which record was wrong, and that a file ended too soon', async () => {
    await expect(values('{"a":1}\nnot json\n')).rejects.toThrow(/Line 2 isn't JSON/);
    await expect(values('[{"a":1}, {"b":')).rejects.toThrow(/ended in the middle/);
    await expect(values('[{"a":1}, nope]')).rejects.toThrow(/Record 2 isn't JSON/);
  });

  it('reads a value that isn’t an object, and leaves what it means to the caller', async () => {
    expect(await values('[1, "two", true, null]')).toEqual([1, 'two', true, null]);
  });
});

describe('malformed array boundaries', () => {
  it.each([
    '[',
    '[{}',
    '[{},',
    '[{},]',
    '[,{}]',
    '[{} {}]',
    '[{}][{}]',
    '[{}] false',
    '[1 2]',
    '[1,,2]',
    '[}',
    '[{}]\u00a0',
  ])('rejects %j across chunk boundaries', async (text) => {
    for (const size of [1, 3, text.length]) await expect(values(text, size)).rejects.toThrow();
  });
});
