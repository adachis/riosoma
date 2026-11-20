import { message } from './messages.js';
/**
 * Reads arrays and JSON lines one value at a time.  Array boundaries are checked even after
 * the last value so a truncated file or appended document cannot look like a complete import.
 */
export async function* readJsonValues(chunks: AsyncIterable<string>): AsyncGenerator<unknown> {
  let mode: 'unknown' | 'array' | 'lines' = 'unknown';
  let state: 'first' | 'value' | 'separator' | 'done' = 'first';
  let buffer = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let fresh = true;
  let count = 0;
  let line = 1;
  const whitespace = (character: string) => /^[ \t\r\n]$/.test(character);
  const value = (text: string): unknown => {
    count += 1;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(
        mode === 'lines'
          ? message('cli.json.lineIsnTJson', { line: line, value2: (error as Error).message })
          : message('cli.json.recordIsnTJson', { count: count, value2: (error as Error).message }),
        { cause: error },
      );
    }
  };
  const boundary = () => new Error(message('cli.json.theJsonHasAnInvalidArrayBoundary', { count: count }));

  for await (const chunk of chunks) {
    for (const character of chunk) {
      if (fresh) {
        fresh = false;
        if (character === '\uFEFF') continue;
      }
      if (mode === 'unknown') {
        if (whitespace(character)) continue;
        mode = character === '[' ? 'array' : 'lines';
        if (mode === 'array') continue;
      }
      if (mode === 'lines') {
        if (character === '\n') {
          if (buffer.trim()) yield value(buffer);
          buffer = '';
          line += 1;
        } else buffer += character;
        continue;
      }
      if (state === 'done') {
        if (!whitespace(character)) throw boundary();
        continue;
      }
      if (
        !inString &&
        depth === 0 &&
        buffer &&
        (character === ',' || character === ']' || whitespace(character))
      ) {
        yield value(buffer);
        buffer = '';
        state = 'separator';
      }
      if (!buffer) {
        if (whitespace(character)) continue;
        if (state === 'separator') {
          if (character === ',') {
            state = 'value';
            continue;
          }
          if (character === ']') {
            state = 'done';
            continue;
          }
          throw boundary();
        }
        if (character === ']' && state === 'first') {
          state = 'done';
          continue;
        }
        if (character === ',' || character === ']') throw boundary();
      }
      buffer += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === '{' || character === '[') depth += 1;
      else if (character === '}' || character === ']') depth -= 1;
      if (!inString && depth === 0 && (character === '}' || character === ']' || character === '"')) {
        yield value(buffer);
        buffer = '';
        state = 'separator';
      }
    }
  }
  if (mode === 'lines') {
    if (buffer.trim()) yield value(buffer);
  } else if (mode === 'array' && state !== 'done') {
    throw new Error(message('cli.json.theJsonEndedInTheMiddleOf', { value1: count + 1 }));
  }
}
