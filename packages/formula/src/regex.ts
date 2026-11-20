type Predicate = (character: string) => boolean;
type Assertion = (text: string, position: number) => boolean;
type Pattern =
  | { kind: 'character'; test: Predicate; byte?: boolean }
  | { kind: 'assert'; test: Assertion }
  | { kind: 'sequence' | 'alternative'; children: Pattern[] }
  | { kind: 'repeat'; child: Pattern; min: number; max: number; greedy: boolean }
  | { kind: 'capture'; child: Pattern; index: number };
type Instruction =
  | { kind: 'character'; test: Predicate; byte?: boolean; next: number }
  | { kind: 'assert'; test: Assertion; next: number }
  | { kind: 'save'; index: number; next: number }
  | { kind: 'split'; first: number; second: number }
  | { kind: 'match' };
interface Flags {
  i: boolean;
  m: boolean;
  s: boolean;
  U: boolean;
}
interface Character {
  test: Predicate;
  literal?: string;
}
interface Thread {
  remaining?: number;
  pc: number;
  captures: number[];
}
export interface RegexMatch {
  start: number;
  end: number;
  groups: (string | undefined)[];
}
const invalid = (): never => {
  throw new Error('formula.runtime.regex');
};
const empty = (): Pattern => ({ kind: 'sequence', children: [] });
const ascii: Record<string, string> = {
  alnum: '0-9A-Za-z',
  alpha: 'A-Za-z',
  ascii: '\\x00-\\x7f',
  blank: '\\t ',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: '!-/:-@\\[-`{-~',
  space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z',
  word: '0-9A-Za-z_',
  xdigit: '0-9A-Fa-f',
};
const word = (value: string | undefined) => value !== undefined && /^[0-9A-Za-z_]$/.test(value);
const escapeLiteral = (value: string) => `\\u{${value.codePointAt(0)!.toString(16)}}`;

function parsePattern(source: string): {
  pattern: Pattern;
  captures: number;
  names: ReadonlyMap<string, number>;
} {
  let position = 0,
    captures = 0,
    depth = 0;
  const names = new Map<string, number>();
  if (source.length > 10_000) invalid();
  const character = (): string => {
    const point = source.codePointAt(position);
    if (point === undefined) return invalid();
    const value = String.fromCodePoint(point);
    position += value.length;
    return value;
  };
  const literal = (value: string, flags: Flags): Character => {
    const expression = flags.i ? new RegExp(escapeLiteral(value), 'iu') : null;
    return { literal: value, test: expression ? (c) => expression.test(c) : (c) => c === value };
  };
  const characterClass = (body: string, flags: Flags, negate = false): Character => {
    const expression = new RegExp(`[${body}]`, flags.i ? 'iu' : 'u');
    return { test: (value) => expression.test(value) !== negate };
  };
  const escaped = (flags: Flags): Character => {
    const next = character();
    const shorthand: Record<string, string> = { d: '0-9', w: '0-9A-Za-z_', s: '\\t\\n\\f\\r ' };
    const body = shorthand[next.toLowerCase()];
    if (body) return characterClass(body, flags, next !== next.toLowerCase());
    if (next === 'p' || next === 'P') {
      let property: string;
      if (source[position] === '{') {
        const end = source.indexOf('}', ++position);
        if (end < 0) return invalid();
        property = source.slice(position, end);
        position = end + 1;
      } else property = character();
      let negate = next === 'P';
      if (property.startsWith('^')) {
        property = property.slice(1);
        negate = !negate;
      }
      if (!/^[A-Za-z_]+$/.test(property) || ['Cn', 'LC', 'Cased_Letter'].includes(property)) return invalid();
      let expression: RegExp;
      try {
        expression = new RegExp(`\\p{${property}}`, flags.i ? 'iu' : 'u');
      } catch {
        expression = new RegExp(`\\p{Script=${property}}`, flags.i ? 'iu' : 'u');
      }
      return { test: (value) => expression.test(value) !== negate };
    }
    const controls: Record<string, string> = { a: '\x07', f: '\f', t: '\t', n: '\n', r: '\r', v: '\v' };
    if (controls[next]) return literal(controls[next]!, flags);
    if (next === 'x') {
      let digits: string;
      if (source[position] === '{') {
        const end = source.indexOf('}', ++position);
        if (end < 0) return invalid();
        digits = source.slice(position, end);
        position = end + 1;
      } else {
        digits = source.slice(position, position + 2);
        position += 2;
        if (digits.length !== 2) return invalid();
      }
      if (!/^[0-9a-fA-F]+$/.test(digits) || Number.parseInt(digits, 16) > 0x10ffff) return invalid();
      return literal(String.fromCodePoint(Number.parseInt(digits, 16)), flags);
    }
    if (/[0-7]/.test(next)) {
      const rest = /^[0-7]{0,2}/.exec(source.slice(position))![0];
      if (next !== '0' && rest.length === 0) return invalid();
      position += rest.length;
      return literal(String.fromCodePoint(Number.parseInt(next + rest, 8)), flags);
    }
    if (/^[A-Za-z0-9]$/.test(next)) return invalid();
    return literal(next, flags);
  };
  const bracket = (flags: Flags): Character => {
    const negate = source[position] === '^';
    if (negate) position++;
    const elements: Predicate[] = [];
    const atom = (): Character => {
      if (source.slice(position, position + 2) === '[:') {
        const end = source.indexOf(':]', position + 2);
        if (end < 0) return invalid();
        let name = source.slice(position + 2, end);
        position = end + 2;
        const inverted = name.startsWith('^');
        if (inverted) name = name.slice(1);
        const body = ascii[name];
        if (!body) return invalid();
        return characterClass(body, flags, inverted);
      }
      const c = character();
      return c === '\\' ? escaped(flags) : literal(c, flags);
    };
    while (position < source.length && (source[position] !== ']' || elements.length === 0)) {
      const left = atom();
      if (source[position] === '-' && source[position + 1] !== ']') {
        position++;
        const right = atom();
        if (
          left.literal === undefined ||
          right.literal === undefined ||
          left.literal.codePointAt(0)! > right.literal.codePointAt(0)!
        )
          return invalid();
        elements.push(
          characterClass(`${escapeLiteral(left.literal)}-${escapeLiteral(right.literal)}`, flags).test,
        );
      } else elements.push(left.test);
    }
    if (source[position++] !== ']') return invalid();
    return { test: (value) => elements.some((test) => test(value)) !== negate };
  };
  const expression = (flags: Flags): Pattern => {
    if (++depth > 128) return invalid();
    const alternatives: Pattern[] = [],
      sequence: Pattern[] = [];
    while (position < source.length && source[position] !== ')') {
      if (source[position] === '|') {
        position++;
        alternatives.push({ kind: 'sequence', children: sequence.splice(0) });
        continue;
      }
      const c = character();
      let node: Pattern;
      if (c === '(') {
        let capture = 0;
        const scoped = { ...flags };
        if (source[position] !== '?') capture = ++captures;
        else {
          position++;
          if (source[position] === ':') position++;
          else if (source[position] === '<' || source.slice(position, position + 2) === 'P<') {
            position += source[position] === '<' ? 1 : 2;
            const end = source.indexOf('>', position);
            if (end < 0) return invalid();
            const name = source.slice(position, end);
            position = end + 1;
            if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || names.has(name)) return invalid();
            capture = ++captures;
            names.set(name, capture);
          } else {
            const match = /^([imsU]*)(?:-([imsU]+))?([:)])/.exec(source.slice(position));
            if (!match || (!match[1] && !match[2])) return invalid();
            position += match[0].length;
            for (const flag of match[1]!) scoped[flag as keyof Flags] = true;
            for (const flag of match[2] ?? '') scoped[flag as keyof Flags] = false;
            if (match[3] === ')') {
              Object.assign(flags, scoped);
              sequence.push(empty());
              continue;
            }
          }
        }
        const child = expression(scoped);
        if (source[position++] !== ')') return invalid();
        node = capture ? { kind: 'capture', child, index: capture } : child;
      } else if (c === '[') node = { kind: 'character', test: bracket(flags).test };
      else if (c === '.') {
        const dotAll = flags.s;
        node = { kind: 'character', test: (value) => dotAll || value !== '\n' };
      } else if (c === '^' || c === '$') {
        const multiline = flags.m;
        node = {
          kind: 'assert',
          test:
            c === '^'
              ? (text, at) => at === 0 || (multiline && text[at - 1] === '\n')
              : (text, at) => at === text.length || (multiline && text[at] === '\n'),
        };
      } else if (c === '\\') {
        const code = source[position];
        if (code === 'C') {
          position++;
          node = { kind: 'character', byte: true, test: () => true };
        } else if (code === 'A' || code === 'z' || code === 'b' || code === 'B') {
          position++;
          node = {
            kind: 'assert',
            test: (text, at) =>
              code === 'A'
                ? at === 0
                : code === 'z'
                  ? at === text.length
                  : (word(text[at - 1]) !== word(text[at])) === (code === 'b'),
          };
        } else if (code === 'Q') {
          position++;
          const children: Pattern[] = [];
          while (position < source.length && source.slice(position, position + 2) !== '\\E')
            children.push({ kind: 'character', test: literal(character(), flags).test });
          if (source.slice(position, position + 2) === '\\E') position += 2;
          node = children.pop() ?? empty();
          sequence.push(...children);
        } else node = { kind: 'character', test: escaped(flags).test };
      } else if ('*+?'.includes(c)) return invalid();
      else node = { kind: 'character', test: literal(c, flags).test };
      let min = -1,
        max = 0;
      const quantifier = source[position];
      if (quantifier === '*' || quantifier === '+' || quantifier === '?') {
        position++;
        min = quantifier === '+' ? 1 : 0;
        max = quantifier === '?' ? 1 : Infinity;
      } else if (quantifier === '{') {
        const repetition = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(position));
        if (repetition) {
          position += repetition[0].length;
          min = Number(repetition[1]);
          max = repetition[2] ? (repetition[3] ? Number(repetition[3]) : Infinity) : min;
          if (min > 1000 || (max !== Infinity && max > 1000) || max < min) return invalid();
        }
      }
      if (min >= 0) {
        let greedy = !flags.U;
        if (source[position] === '?') {
          position++;
          greedy = !greedy;
        }
        node = { kind: 'repeat', child: node, min, max, greedy };
        if (/^[*+?{]$/.test(source[position] ?? '')) return invalid();
      }
      sequence.push(node);
    }
    alternatives.push({ kind: 'sequence', children: sequence });
    depth--;
    return alternatives.length === 1 ? alternatives[0]! : { kind: 'alternative', children: alternatives };
  };
  const pattern = expression({ i: false, m: false, s: false, U: false });
  if (position !== source.length) invalid();
  return { pattern, captures, names };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
interface Subject {
  bytes: Uint8Array;
  binary: string;
  characters: ReadonlyMap<number, { value: string; width: number }>;
}
function subjectOf(text: string): Subject {
  const bytes = encoder.encode(text),
    characters = new Map<number, { value: string; width: number }>();
  let index = 0;
  for (const value of text) {
    const point = value.codePointAt(0)!;
    const width = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    characters.set(index, { value, width });
    index += width;
  }
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return { bytes, characters, binary: chunks.join('') };
}

class Regex {
  private readonly instructions: Instruction[] = [];
  private readonly start: number;
  private readonly groups: number;
  private readonly names: ReadonlyMap<string, number>;
  constructor(source: string) {
    const { pattern, captures, names } = parsePattern(source);
    this.groups = captures;
    this.names = names;
    const emit = (instruction: Instruction) => {
      if (this.instructions.length >= 20_000) return invalid();
      this.instructions.push(instruction);
      return this.instructions.length - 1;
    };
    const build = (node: Pattern, next: number): number => {
      switch (node.kind) {
        case 'character':
          return emit({ kind: 'character', test: node.test, byte: node.byte, next });
        case 'assert':
          return emit({ kind: 'assert', test: node.test, next });
        case 'capture':
          return emit({
            kind: 'save',
            index: node.index * 2,
            next: build(node.child, emit({ kind: 'save', index: node.index * 2 + 1, next })),
          });
        case 'sequence': {
          let start = next;
          for (let i = node.children.length - 1; i >= 0; i--) start = build(node.children[i]!, start);
          return start;
        }
        case 'alternative': {
          let start = build(node.children.at(-1)!, next);
          for (let i = node.children.length - 2; i >= 0; i--)
            start = emit({ kind: 'split', first: build(node.children[i]!, next), second: start });
          return start;
        }
        case 'repeat': {
          let start = next;
          if (node.max === Infinity) {
            const fork: Instruction = { kind: 'split', first: next, second: next };
            start = emit(fork);
            const child = build(node.child, start);
            if (node.greedy) fork.first = child;
            else fork.second = child;
          } else
            for (let i = node.min; i < node.max; i++) {
              const child = build(node.child, start);
              start = emit({
                kind: 'split',
                first: node.greedy ? child : start,
                second: node.greedy ? start : child,
              });
            }
          for (let i = 0; i < node.min; i++) start = build(node.child, start);
          return start;
        }
      }
    };
    this.start = build({ kind: 'capture', child: pattern, index: 0 }, emit({ kind: 'match' }));
  }
  /** Each instruction runs at most once per byte position; alternatives never backtrack. */
  private find(subject: Subject, offset = 0): RegexMatch | null {
    let current: Thread[] = [],
      candidate: number[] | null = null;
    const add = (list: Thread[], seen: Set<number>, pc: number, captures: number[], at: number) => {
      const pending: Thread[] = [{ pc, captures }];
      while (pending.length) {
        const thread = pending.pop()!;
        const key = thread.pc * 4;
        if (seen.has(key)) continue;
        seen.add(key);
        const instruction = this.instructions[thread.pc]!;
        if (instruction.kind === 'split') {
          pending.push(
            { pc: instruction.second, captures: thread.captures },
            { pc: instruction.first, captures: thread.captures },
          );
        } else if (instruction.kind === 'save') {
          const saved = [...thread.captures];
          saved[instruction.index] = at;
          pending.push({ pc: instruction.next, captures: saved });
        } else if (instruction.kind === 'assert') {
          if (instruction.test(subject.binary, at))
            pending.push({ pc: instruction.next, captures: thread.captures });
        } else list.push(thread);
      }
    };
    const wait = (list: Thread[], seen: Set<number>, pc: number, captures: number[], remaining: number) => {
      const key = pc * 4 + remaining;
      if (!seen.has(key)) {
        seen.add(key);
        list.push({ pc, captures, remaining });
      }
    };
    add(current, new Set(), this.start, [], offset);
    for (let at = offset; at <= subject.bytes.length; at++) {
      const next: Thread[] = [],
        seen = new Set<number>();
      for (const thread of current) {
        if (thread.remaining) {
          if (thread.remaining === 1) add(next, seen, thread.pc, thread.captures, at + 1);
          else wait(next, seen, thread.pc, thread.captures, thread.remaining - 1);
          continue;
        }
        const instruction = this.instructions[thread.pc]!;
        if (instruction.kind === 'match') {
          candidate = thread.captures;
          break;
        }
        if (instruction.kind !== 'character' || at === subject.bytes.length) continue;
        if (instruction.byte) add(next, seen, instruction.next, thread.captures, at + 1);
        else {
          const character = subject.characters.get(at);
          if (character && instruction.test(character.value)) {
            if (character.width === 1) add(next, seen, instruction.next, thread.captures, at + 1);
            else wait(next, seen, instruction.next, thread.captures, character.width - 1);
          }
        }
      }
      if (candidate && next.length === 0) break;
      if (at === subject.bytes.length) break;
      if (!candidate) add(next, seen, this.start, [], at + 1);
      current = next;
    }
    if (!candidate) return null;
    return {
      start: candidate[0]!,
      end: candidate[1]!,
      groups: Array.from({ length: this.groups + 1 }, (_, i) =>
        candidate[i * 2] === undefined || candidate[i * 2 + 1] === undefined
          ? undefined
          : decoder.decode(subject.bytes.subarray(candidate[i * 2], candidate[i * 2 + 1])),
      ),
    };
  }
  match(text: string): RegexMatch | null {
    return this.find(subjectOf(text));
  }
  replace(text: string, replacement: string): string {
    const subject = subjectOf(text);
    const slice = (start: number, end = subject.bytes.length) =>
      decoder.decode(subject.bytes.subarray(start, end));
    let offset = 0,
      copied = 0;
    const result: Uint8Array[] = [];
    while (offset <= subject.bytes.length) {
      const match = this.find(subject, offset);
      if (!match) break;
      result.push(subject.bytes.subarray(copied, match.start));
      result.push(
        encoder.encode(
          replacement.replace(/\$(\$|&|`|'|[1-9][0-9]?|<[^>]+>)/g, (whole, token: string) => {
            if (token === '$') return '$';
            if (token === '&') return match.groups[0]!;
            if (token === '`') return slice(0, match.start);
            if (token === "'") return slice(match.end);
            if (token.startsWith('<')) {
              const index = this.names.get(token.slice(1, -1));
              return index === undefined ? whole : (match.groups[index] ?? '');
            }
            const index = Number(token);
            if (index <= this.groups) return match.groups[index] ?? '';
            if (token.length === 2 && Number(token[0]) <= this.groups)
              return (match.groups[Number(token[0])] ?? '') + token[1];
            return whole;
          }),
        ),
      );
      copied = match.end;
      offset =
        match.end === match.start ? match.end + (subject.characters.get(match.end)?.width ?? 1) : match.end;
    }
    result.push(subject.bytes.subarray(copied));
    const bytes = new Uint8Array(result.reduce((total, part) => total + part.length, 0));
    let index = 0;
    for (const part of result) {
      bytes.set(part, index);
      index += part.length;
    }
    return decoder.decode(bytes);
  }
}
const cache = new Map<string, Regex>();
export function regex(pattern: string): Regex {
  let compiled = cache.get(pattern);
  if (!compiled) {
    compiled = new Regex(pattern);
    if (cache.size >= 128) cache.delete(cache.keys().next().value!);
    cache.set(pattern, compiled);
  }
  return compiled;
}
