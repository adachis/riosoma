/** Nesting deeper than this is left unplaced. */
const MAX_DEPTH = 2_000;

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

class JsonStop {
  constructor(readonly at: number) {}
}

/**
 * Where JSON text stops making sense, as a line and a column counted from one, or null when it
 * parses.  Browsers word and place the reason differently, so the text is read here instead.
 */
export function jsonProblem(text: string): { line: number; column: number } | null {
  try {
    JSON.parse(text);
    return null;
  } catch {
    // Read it below to find the place.
  }
  let at = 0;
  const stop = (): never => {
    throw new JsonStop(at);
  };
  const space = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at]!)) at += 1;
  };
  const word = (expected: string) => {
    for (const char of expected) {
      if (text[at] !== char) stop();
      at += 1;
    }
  };
  const string = () => {
    at += 1;
    while (at < text.length) {
      const char = text[at]!;
      if (char === '"') {
        at += 1;
        return;
      }
      if (char < ' ') stop();
      if (char === '\\') {
        const next = text[at + 1];
        if (next === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
            at += 2;
            stop();
          }
          at += 6;
        } else if (next !== undefined && '"\\/bfnrt'.includes(next)) at += 2;
        else {
          at += 1;
          stop();
        }
      } else at += 1;
    }
    stop();
  };
  const value = (depth: number): void => {
    if (depth > MAX_DEPTH) throw new JsonStop(-1);
    space();
    const char = text[at];
    if (char === '{' || char === '[') {
      const object = char === '{';
      const close = object ? '}' : ']';
      at += 1;
      space();
      if (text[at] === close) {
        at += 1;
        return;
      }
      for (;;) {
        space();
        if (object) {
          if (text[at] !== '"') stop();
          string();
          space();
          if (text[at] !== ':') stop();
          at += 1;
        }
        value(depth + 1);
        space();
        if (text[at] === ',') at += 1;
        else if (text[at] === close) {
          at += 1;
          return;
        } else stop();
      }
    }
    if (char === '"') return string();
    if (char === 't') return word('true');
    if (char === 'f') return word('false');
    if (char === 'n') return word('null');
    NUMBER.lastIndex = at;
    if (!NUMBER.test(text)) stop();
    at = NUMBER.lastIndex;
  };
  try {
    value(0);
    space();
    if (at < text.length) stop();
    return null;
  } catch (error) {
    if (!(error instanceof JsonStop) || error.at < 0) return null;
    const lines = text.slice(0, error.at).split('\n');
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  }
}
