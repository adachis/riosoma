/** Patterns run as a state machine so ambiguous alternatives never cause backtracking. */
type Node =
  | { kind: 'char'; test: (value: string) => boolean }
  | { kind: 'start' | 'end' }
  | { kind: 'sequence' | 'choice'; children: Node[] }
  | { kind: 'repeat'; child: Node; min: number; max: number };

type Edge = { to: number; test?: (value: string) => boolean; assertion?: 'start' | 'end' };

export const PATTERN_LIMIT = 10_000;
const syntax = () => new Error('data.validation.patternSyntax');

export function parsePattern(source: string): (value: string) => boolean {
  if (!source.length || source.length > 512) throw syntax();
  let position = 0;
  let depth = 0;
  const quantified = (node: Node): boolean =>
    node.kind === 'repeat' || ('children' in node && node.children.some(quantified));
  function atom(): Node {
    const char = source[position++];
    if (char === '(') {
      if (++depth > 20 || source[position] === '?') throw syntax();
      const child = choice();
      if (source[position++] !== ')') throw syntax();
      depth--;
      return child;
    }
    if (char === '^') return { kind: 'start' };
    if (char === '$') return { kind: 'end' };
    if (char === '.') return { kind: 'char', test: (value) => !'\n\r\u2028\u2029'.includes(value) };
    if (char === '[') {
      const start = position - 1;
      if (source[position] === '^') position++;
      while (position < source.length && source[position] !== ']') {
        if (source[position] === '\\') escape();
        else position++;
      }
      if (source[position++] !== ']') throw syntax();
      let expression: RegExp;
      try {
        expression = new RegExp(`^(?:${source.slice(start, position)})$`, 'u');
      } catch {
        throw syntax();
      }
      return { kind: 'char', test: (value) => expression.test(value) };
    }
    if (char === '\\') {
      position--;
      const text = escape();
      const expression = new RegExp(`^(?:${text})$`, 'u');
      return { kind: 'char', test: (value) => expression.test(value) };
    }
    if (!char || '*+?{}|)'.includes(char)) throw syntax();
    return { kind: 'char', test: (value) => value === char };
  }
  function escape(): string {
    const start = position++;
    const next = source[position++];
    // Numeric escapes and named references are excluded together with unsupported extensions.
    if (!next || !'dDsSwWnrt\\.^$|?*+()[]{}-/'.includes(next)) throw syntax();
    return source.slice(start, position);
  }
  function sequence(): Node {
    const children: Node[] = [];
    while (position < source.length && !')|'.includes(source[position]!)) {
      let child = atom();
      const next = source[position];
      if (next && '*+?{'.includes(next)) {
        if (quantified(child) || child.kind === 'start' || child.kind === 'end') throw syntax();
        position++;
        let min = next === '+' ? 1 : 0;
        let max = next === '?' ? 1 : Infinity;
        if (next === '{') {
          const match = /^(\d+)(?:,(\d*))?\}/.exec(source.slice(position));
          if (!match) throw syntax();
          position += match[0].length;
          min = Number(match[1]);
          max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2]);
          if (min > 100 || (max !== Infinity && max > 100) || max < min) throw syntax();
        }
        child = { kind: 'repeat', child, min, max };
      }
      children.push(child);
    }
    return { kind: 'sequence', children };
  }
  function choice(): Node {
    const children = [sequence()];
    while (source[position] === '|') {
      position++;
      children.push(sequence());
    }
    return children.length === 1 ? children[0]! : { kind: 'choice', children };
  }
  const root = choice();
  if (position !== source.length) throw syntax();
  const states: Edge[][] = [];
  function state(): number {
    if (states.length >= 4096) throw syntax();
    states.push([]);
    return states.length - 1;
  }
  function edge(from: number, to: number, extra: Omit<Edge, 'to'> = {}) {
    states[from]!.push({ to, ...extra });
  }
  function build(node: Node, from: number, to: number): void {
    switch (node.kind) {
      case 'char':
        edge(from, to, { test: node.test });
        break;
      case 'start':
      case 'end':
        edge(from, to, { assertion: node.kind });
        break;
      case 'choice':
        for (const child of node.children) build(child, from, to);
        break;
      case 'sequence': {
        let current = from;
        for (const child of node.children) {
          const next = state();
          build(child, current, next);
          current = next;
        }
        edge(current, to);
        break;
      }
      case 'repeat': {
        let current = from;
        for (let count = 0; count < node.min; count++) {
          const next = state();
          build(node.child, current, next);
          current = next;
        }
        edge(current, to);
        if (node.max === Infinity) {
          const next = state();
          build(node.child, current, next);
          edge(next, current);
        } else
          for (let count = node.min; count < node.max; count++) {
            const next = state();
            build(node.child, current, next);
            edge(next, to);
            current = next;
          }
        break;
      }
    }
  }
  const start = state();
  const end = state();
  build(root, start, end);
  return (value) => {
    if (value.length > PATTERN_LIMIT) return false;
    const chars = Array.from(value);
    let active = new Set<number>();
    for (let offset = 0; offset <= chars.length; offset++) {
      active.add(start);
      const queue = [...active];
      for (let index = 0; index < queue.length; index++) {
        for (const link of states[queue[index]!]!) {
          if (
            link.test ||
            (link.assertion === 'start' && offset !== 0) ||
            (link.assertion === 'end' && offset !== chars.length)
          )
            continue;
          if (!active.has(link.to)) {
            active.add(link.to);
            queue.push(link.to);
          }
        }
      }
      if (active.has(end)) return true;
      const next = new Set<number>();
      if (offset < chars.length)
        for (const id of active) {
          for (const link of states[id]!) if (link.test?.(chars[offset]!)) next.add(link.to);
        }
      active = next;
    }
    return false;
  };
}

export function validPattern(source: string): boolean {
  try {
    parsePattern(source);
    return true;
  } catch {
    return false;
  }
}

export const PATTERN_PRESETS = {
  email: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
  url: '^https?://[^\\s.]+\\.[^\\s]+$',
  phone: '^\\+?[0-9 ()-]{3,64}$',
  postalCode: '^[A-Za-z0-9][A-Za-z0-9 -]{1,15}$',
  digits: '^[0-9]+$',
  letters: '^[A-Za-z]+$',
} as const;
