/**
 * Rich text in a long text field, stored as Markdown.  Storage stays text, so filters, search,
 * sorting, formulas, downloads, and the API keep reading what people wrote.  This module reads and
 * writes one documented subset, the formatting the editor offers, and nothing more:
 *
 * - `**bold**`, `*italic*` (also `_italic_`), `~~strikethrough~~`, and `` `inline code` ``
 * - `[text](https://example.com "optional title")` and `<https://example.com>`.  Only http, https,
 *   and mailto addresses become links.  Any other address stays text, exactly as typed.
 * - Headings, from `#` to `######`
 * - Bulleted lists (`-`, `*`, or `+`), numbered lists (`1.` or `1)`), and checklists (`- [ ]` and
 *   `- [x]`), nested by indenting under the item
 * - Block quotes (`>`) and code blocks fenced with three or more backticks or tildes
 * - A line break inside a paragraph stays a line break, the way comments on GitHub keep it.  A blank
 *   line starts a new paragraph, and a backslash at the end of a line is a line break too.
 *
 * Nothing else is interpreted.  HTML, entities such as `&amp;`, images, tables, and indented code
 * stay the characters they were typed with, so a value never becomes markup.  Plain text is already
 * valid, which is why turning rich text on changes no values.
 *
 * Reading is lenient and writing is strict.  `printMarkdown` escapes only what would otherwise read
 * as formatting, and reads each paragraph back to check it, so what it writes always reads back as
 * the document it came from.
 *
 * The app's editor and the server's Word documents both read rich text through here, so a value is
 * never formatted two ways.
 */

export type RichMark =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'strike' }
  | { type: 'code' }
  | { type: 'link'; attrs: { href: string; title: string | null } };

export interface RichText {
  type: 'text';
  text: string;
  marks?: RichMark[];
}
export interface RichBreak {
  type: 'hardBreak';
}
export type RichInline = RichText | RichBreak;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface RichParagraph {
  type: 'paragraph';
  content?: RichInline[];
}
export interface RichHeading {
  type: 'heading';
  attrs: { level: HeadingLevel };
  content?: RichInline[];
}
export interface RichQuote {
  type: 'blockquote';
  content: RichBlock[];
}
export interface RichCodeBlock {
  type: 'codeBlock';
  attrs: { language: string | null };
  content?: RichText[];
}
export interface RichListItem {
  type: 'listItem';
  content: RichBlock[];
}
export interface RichTaskItem {
  type: 'taskItem';
  attrs: { checked: boolean };
  content: RichBlock[];
}
export interface RichBulletList {
  type: 'bulletList';
  content: RichListItem[];
}
export interface RichOrderedList {
  type: 'orderedList';
  attrs: { start: number };
  content: RichListItem[];
}
export interface RichTaskList {
  type: 'taskList';
  content: RichTaskItem[];
}
export type RichList = RichBulletList | RichOrderedList | RichTaskList;
export type RichBlock = RichParagraph | RichHeading | RichQuote | RichCodeBlock | RichList;

export interface RichDoc {
  type: 'doc';
  content: RichBlock[];
}

/** Containers nest this deep at most.  Deeper markers stay text, so a value can't exhaust the stack. */
const MAX_DEPTH = 32;
/** The largest number a numbered list can start from, as Markdown allows. */
const MAX_START = 999_999_999;

const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const PUNCTUATION = /^[\p{P}\p{S}]$/u;
const WHITESPACE = /^\s$/u;
const BREAK: RichBreak = { type: 'hardBreak' };

/* ------------------------------------------------------------------------------------------------
 * Links
 * --------------------------------------------------------------------------------------------- */

/**
 * The address a link may open, or null.  Only http and https addresses with a host, and mailto
 * addresses, qualify.  Everything else, such as `javascript:`, `data:`, or a relative path, is
 * refused, whatever its case or spacing.
 */
export function safeLinkHref(href: string): string | null {
  if (href === '' || href.length > 2_048 || /[\s\p{Cc}]/u.test(href)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') return null;
  try {
    const url = new URL(href);
    if (url.protocol === 'mailto:') return url.pathname === '' ? null : href;
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' ? href : null;
  } catch {
    return null;
  }
}

const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\p{Cc} ]*)>/uy;
const EMAIL_AUTOLINK =
  /<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;

function matchesWhole(pattern: RegExp, text: string): boolean {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  return match !== null && match[0].length === text.length;
}

/* ------------------------------------------------------------------------------------------------
 * Marks and inline content
 * --------------------------------------------------------------------------------------------- */

const MARK_ORDER: Record<RichMark['type'], number> = { link: 0, strike: 1, bold: 2, italic: 3, code: 4 };

function markKey(mark: RichMark): string {
  return mark.type === 'link' ? `link:${JSON.stringify([mark.attrs.href, mark.attrs.title])}` : mark.type;
}

function marksKey(marks: readonly RichMark[] | undefined, loose = false): string {
  if (!marks || marks.length === 0) return '';
  return marks
    .filter((mark) => !loose || mark.type === 'link' || mark.type === 'code')
    .map(markKey)
    .sort()
    .join('|');
}

function sortMarks(marks: RichMark[]): RichMark[] {
  return marks.sort((a, b) => MARK_ORDER[a.type] - MARK_ORDER[b.type]);
}

/** Adds text, joining it to the text before when the marks are the same. */
function pushText(out: RichInline[], text: string, marks: readonly RichMark[]): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last?.type === 'text' && marksKey(last.marks) === marksKey(marks)) {
    last.text += text;
    return;
  }
  out.push(marks.length ? { type: 'text', text, marks: [...marks] } : { type: 'text', text });
}

function hasCode(node: RichText): boolean {
  return node.marks?.some((mark) => mark.type === 'code') ?? false;
}

/**
 * Whether two runs of inline content read the same.  Whitespace may differ in bold, italic, and
 * strikethrough, since Markdown can't open or close those next to a space.
 */
function sameInline(a: readonly RichInline[], b: readonly RichInline[]): boolean {
  let i = 0;
  let j = 0;
  let offsetA = 0;
  let offsetB = 0;
  for (;;) {
    while (i < a.length && a[i]!.type === 'text' && (a[i] as RichText).text.length === offsetA) {
      i += 1;
      offsetA = 0;
    }
    while (j < b.length && b[j]!.type === 'text' && (b[j] as RichText).text.length === offsetB) {
      j += 1;
      offsetB = 0;
    }
    const x = a[i];
    const y = b[j];
    if (!x || !y) return !x && !y;
    if (x.type === 'hardBreak' || y.type === 'hardBreak') {
      if (x.type !== y.type) return false;
      i += 1;
      j += 1;
      continue;
    }
    const length = Math.min(x.text.length - offsetA, y.text.length - offsetB);
    const part = x.text.slice(offsetA, offsetA + length);
    if (part !== y.text.slice(offsetB, offsetB + length)) return false;
    if (marksKey(x.marks) !== marksKey(y.marks)) {
      if (marksKey(x.marks, true) !== marksKey(y.marks, true) || /\S/u.test(part)) return false;
    }
    offsetA += length;
    offsetB += length;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Reading inline content
 * --------------------------------------------------------------------------------------------- */

type InlineKind = 'text' | 'code' | 'break' | 'bold' | 'italic' | 'strike' | 'link';

interface InlineNode {
  kind: InlineKind;
  text: string;
  children: InlineNode[];
  href: string;
  title: string | null;
  prev: InlineNode | null;
  next: InlineNode | null;
}

interface Delimiter {
  node: InlineNode;
  char: string;
  count: number;
  length: number;
  canOpen: boolean;
  canClose: boolean;
  prev: Delimiter | null;
  next: Delimiter | null;
}

interface Bracket {
  node: InlineNode;
  prev: Bracket | null;
  /** The top of the delimiter stack when the bracket opened */
  delimiters: Delimiter | null;
  active: boolean;
}

function inlineNode(kind: InlineKind, text = ''): InlineNode {
  return { kind, text, children: [], href: '', title: null, prev: null, next: null };
}

function unescapePunctuation(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** The character before `index`, keeping a surrogate pair whole.  A line's edge reads as a newline. */
function charBefore(source: string, index: number): string {
  if (index <= 0) return '\n';
  const low = source.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = source.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return source.slice(index - 2, index);
  }
  return source[index - 1]!;
}

function charAt(source: string, index: number): string {
  const point = source.codePointAt(index);
  return point === undefined ? '\n' : String.fromCodePoint(point);
}

class InlineParser {
  private pos = 0;
  private head: InlineNode | null = null;
  private tail: InlineNode | null = null;
  private delimiters: Delimiter | null = null;
  private brackets: Bracket | null = null;
  /** Backtick runs with no closer on their line, by line end and length */
  private readonly unclosed = new Set<string>();

  constructor(private readonly source: string) {}

  parse(): InlineNode[] {
    const source = this.source;
    while (this.pos < source.length) {
      const char = source[this.pos]!;
      if (char === '\\') this.backslash();
      else if (char === '\n') {
        this.append(inlineNode('break'));
        this.pos += 1;
      } else if (char === '`') this.backticks();
      else if (char === '*' || char === '_') this.run(char);
      else if (char === '~') this.tildes();
      else if (char === '[') this.openBracket();
      else if (char === ']') this.closeBracket();
      else if (char === '<') this.angle();
      else this.plain();
    }
    this.processEmphasis(null);
    const nodes: InlineNode[] = [];
    for (let node = this.head; node; node = node.next) nodes.push(node);
    return nodes;
  }

  private append(node: InlineNode): InlineNode {
    node.prev = this.tail;
    node.next = null;
    if (this.tail) this.tail.next = node;
    else this.head = node;
    this.tail = node;
    return node;
  }

  private unlink(node: InlineNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = null;
    node.next = null;
  }

  private insertAfter(anchor: InlineNode, node: InlineNode): void {
    node.prev = anchor;
    node.next = anchor.next;
    if (anchor.next) anchor.next.prev = node;
    else this.tail = node;
    anchor.next = node;
  }

  private plain(): void {
    const special = /[\\\n`*_~[\]<]/g;
    special.lastIndex = this.pos + 1;
    const match = special.exec(this.source);
    const end = match ? match.index : this.source.length;
    this.append(inlineNode('text', this.source.slice(this.pos, end)));
    this.pos = end;
  }

  private backslash(): void {
    const next = this.source[this.pos + 1];
    if (next === '\n') {
      this.append(inlineNode('break'));
      this.pos += 2;
    } else if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
      this.append(inlineNode('text', next));
      this.pos += 2;
    } else {
      this.append(inlineNode('text', '\\'));
      this.pos += 1;
    }
  }

  /** A code span closes with a run of the same length on the same line. */
  private backticks(): void {
    const source = this.source;
    const start = this.pos;
    let end = start;
    while (source[end] === '`') end += 1;
    const length = end - start;
    const lineEnd = source.indexOf('\n', end);
    const limit = lineEnd === -1 ? source.length : lineEnd;
    const key = `${limit}:${length}`;
    if (!this.unclosed.has(key)) {
      let from = end;
      for (;;) {
        const found = source.indexOf('`', from);
        if (found === -1 || found >= limit) break;
        let after = found;
        while (source[after] === '`') after += 1;
        if (after - found === length) {
          let code = source.slice(end, found);
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && /[^ ]/.test(code))
            code = code.slice(1, -1);
          this.append(inlineNode('code', code));
          this.pos = after;
          return;
        }
        from = after;
      }
      this.unclosed.add(key);
    }
    this.append(inlineNode('text', source.slice(start, end)));
    this.pos = end;
  }

  private run(char: string): void {
    const source = this.source;
    const start = this.pos;
    let end = start;
    while (source[end] === char) end += 1;
    this.delimiter(char, start, end);
  }

  /** Only a pair of tildes marks strikethrough.  One tilde, or three, is just text. */
  private tildes(): void {
    const source = this.source;
    const start = this.pos;
    let end = start;
    while (source[end] === '~') end += 1;
    if (end - start === 2) this.delimiter('~', start, end);
    else {
      this.append(inlineNode('text', source.slice(start, end)));
      this.pos = end;
    }
  }

  /**
   * An asterisk or tilde run opens when a non-space follows it and closes when a non-space comes
   * before it.  Underscores follow the stricter CommonMark rules, so snake_case names stay text.
   */
  private delimiter(char: string, start: number, end: number): void {
    const before = charBefore(this.source, start);
    const after = charAt(this.source, end);
    const beforeSpace = WHITESPACE.test(before);
    const afterSpace = WHITESPACE.test(after);
    let canOpen = !afterSpace;
    let canClose = !beforeSpace;
    if (char === '_') {
      const beforePunct = PUNCTUATION.test(before);
      const afterPunct = PUNCTUATION.test(after);
      const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
      const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
      canOpen = left && (!right || beforePunct);
      canClose = right && (!left || afterPunct);
    }
    const node = this.append(inlineNode('text', this.source.slice(start, end)));
    this.pos = end;
    if (!canOpen && !canClose) return;
    const delimiter: Delimiter = {
      node,
      char,
      count: end - start,
      length: end - start,
      canOpen,
      canClose,
      prev: this.delimiters,
      next: null,
    };
    if (this.delimiters) this.delimiters.next = delimiter;
    this.delimiters = delimiter;
  }

  private removeDelimiter(delimiter: Delimiter): void {
    if (delimiter.prev) delimiter.prev.next = delimiter.next;
    if (delimiter.next) delimiter.next.prev = delimiter.prev;
    else this.delimiters = delimiter.prev;
    delimiter.prev = null;
    delimiter.next = null;
  }

  private openBracket(): void {
    const node = this.append(inlineNode('text', '['));
    this.brackets = { node, prev: this.brackets, delimiters: this.delimiters, active: true };
    this.pos += 1;
  }

  private closeBracket(): void {
    this.pos += 1;
    const opener = this.brackets;
    if (!opener) {
      this.append(inlineNode('text', ']'));
      return;
    }
    this.brackets = opener.prev;
    const tail = opener.active ? this.linkTail(this.pos) : null;
    if (!tail) {
      this.append(inlineNode('text', ']'));
      return;
    }
    this.processEmphasis(opener.delimiters);
    const link = inlineNode('link');
    link.href = tail.href;
    link.title = tail.title;
    for (let node = opener.node.next; node;) {
      const next = node.next;
      this.unlink(node);
      link.children.push(node);
      node = next;
    }
    this.insertAfter(opener.node, link);
    this.unlink(opener.node);
    this.pos = tail.end;
    // Links never hold links, so the brackets before this one can't make one around it.
    for (let bracket = this.brackets; bracket; bracket = bracket.prev) bracket.active = false;
  }

  /** `(destination "title")` right after a `]`, when the destination is one a link may open. */
  private linkTail(start: number): { href: string; title: string | null; end: number } | null {
    const source = this.source;
    if (source[start] !== '(') return null;
    let pos = skipSpaces(source, start + 1);
    let href: string;
    if (source[pos] === '<') {
      let end = pos + 1;
      while (end < source.length && source[end] !== '>') {
        const char = source[end]!;
        if (char === '<' || char === '\n') return null;
        end += char === '\\' && ASCII_PUNCTUATION.test(source[end + 1] ?? '') ? 2 : 1;
      }
      if (source[end] !== '>') return null;
      href = unescapePunctuation(source.slice(pos + 1, end));
      pos = end + 1;
    } else {
      let end = pos;
      let depth = 0;
      while (end < source.length) {
        const char = source[end]!;
        if (char === '\\' && ASCII_PUNCTUATION.test(source[end + 1] ?? '')) {
          end += 2;
          continue;
        }
        if (char === '(') {
          depth += 1;
          if (depth > 32) return null;
        } else if (char === ')') {
          if (depth === 0) break;
          depth -= 1;
        } else if (/[\s\p{Cc}]/u.test(char)) break;
        end += 1;
      }
      if (depth !== 0) return null;
      href = unescapePunctuation(source.slice(pos, end));
      pos = end;
    }
    const afterDestination = pos;
    pos = skipSpaces(source, pos);
    let title: string | null = null;
    const quote = source[pos];
    if (pos > afterDestination && (quote === '"' || quote === "'" || quote === '(')) {
      const close = quote === '(' ? ')' : quote;
      let end = pos + 1;
      while (end < source.length && source[end] !== close) {
        const char = source[end]!;
        if (char === '\n' || (quote === '(' && char === '(')) return null;
        end += char === '\\' && ASCII_PUNCTUATION.test(source[end + 1] ?? '') ? 2 : 1;
      }
      if (end >= source.length) return null;
      title = unescapePunctuation(source.slice(pos + 1, end));
      pos = skipSpaces(source, end + 1);
    }
    if (source[pos] !== ')' || safeLinkHref(href) === null) return null;
    return { href, title, end: pos + 1 };
  }

  private angle(): void {
    for (const pattern of [URI_AUTOLINK, EMAIL_AUTOLINK]) {
      pattern.lastIndex = this.pos;
      const match = pattern.exec(this.source);
      if (!match) continue;
      const text = match[1]!;
      const href = pattern === EMAIL_AUTOLINK ? `mailto:${text}` : text;
      if (safeLinkHref(href) === null) continue;
      const link = inlineNode('link');
      link.href = href;
      link.children.push(inlineNode('text', text));
      this.append(link);
      this.pos = pattern.lastIndex;
      return;
    }
    this.append(inlineNode('text', '<'));
    this.pos += 1;
  }

  /** CommonMark's pairing of delimiter runs, above `bottom` on the stack. */
  private processEmphasis(bottom: Delimiter | null): void {
    const floors = new Map<string, Delimiter | null>();
    let closer = this.delimiters === bottom ? null : this.delimiters;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (!closer.canClose) {
        closer = closer.next;
        continue;
      }
      const key = `${closer.char}${closer.canOpen ? 1 : 0}${closer.length % 3}`;
      const floor = floors.has(key) ? floors.get(key)! : bottom;
      let opener = closer.prev;
      let found = false;
      while (opener && opener !== bottom && opener !== floor) {
        if (opener.char === closer.char && opener.canOpen) {
          const odd =
            closer.char !== '~' &&
            (closer.canOpen || opener.canClose) &&
            closer.length % 3 !== 0 &&
            (opener.length + closer.length) % 3 === 0;
          if (!odd) {
            found = true;
            break;
          }
        }
        opener = opener.prev;
      }
      if (!found || !opener) {
        floors.set(key, closer.prev);
        const next = closer.next;
        if (!closer.canOpen) this.removeDelimiter(closer);
        closer = next;
        continue;
      }
      const use = closer.char === '~' ? 2 : closer.count >= 2 && opener.count >= 2 ? 2 : 1;
      const kind: InlineKind = closer.char === '~' ? 'strike' : use === 2 ? 'bold' : 'italic';
      opener.count -= use;
      closer.count -= use;
      opener.node.text = opener.node.text.slice(0, opener.node.text.length - use);
      closer.node.text = closer.node.text.slice(use);
      const wrapper = inlineNode(kind);
      for (let node = opener.node.next; node && node !== closer.node;) {
        const next: InlineNode | null = node.next;
        this.unlink(node);
        wrapper.children.push(node);
        node = next;
      }
      this.insertAfter(opener.node, wrapper);
      for (let between = closer.prev; between && between !== opener;) {
        const below: Delimiter | null = between.prev;
        this.removeDelimiter(between);
        between = below;
      }
      if (opener.count === 0) {
        this.removeDelimiter(opener);
        this.unlink(opener.node);
      }
      if (closer.count === 0) {
        const next = closer.next;
        this.removeDelimiter(closer);
        this.unlink(closer.node);
        closer = next;
      }
    }
    while (this.delimiters && this.delimiters !== bottom) this.removeDelimiter(this.delimiters);
  }
}

function skipSpaces(source: string, index: number): number {
  let pos = index;
  while (source[pos] === ' ' || source[pos] === '\t') pos += 1;
  return pos;
}

function withMark(marks: RichMark[], mark: RichMark): RichMark[] {
  // An inner link wins over an outer one, as it does in CommonMark.
  const kept = marks.filter((existing) => existing.type !== mark.type);
  return sortMarks([...kept, mark]);
}

/** The parsed tree as editor content, walked without recursion so deep nesting stays safe. */
function flatten(nodes: InlineNode[]): RichInline[] {
  const out: RichInline[] = [];
  const stack: Array<{ list: InlineNode[]; index: number; marks: RichMark[] }> = [
    { list: nodes, index: 0, marks: [] },
  ];
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const node = frame.list[frame.index];
    if (!node) {
      stack.pop();
      continue;
    }
    frame.index += 1;
    switch (node.kind) {
      case 'text':
        pushText(out, node.text, frame.marks);
        break;
      case 'code':
        pushText(out, node.text, withMark(frame.marks, { type: 'code' }));
        break;
      case 'break':
        out.push(BREAK);
        break;
      case 'link':
        stack.push({
          list: node.children,
          index: 0,
          marks: withMark(frame.marks, { type: 'link', attrs: { href: node.href, title: node.title } }),
        });
        break;
      default:
        stack.push({ list: node.children, index: 0, marks: withMark(frame.marks, { type: node.kind }) });
    }
  }
  return out;
}

/** Inline Markdown as editor content: text with marks, and line breaks. */
export function parseInline(source: string): RichInline[] {
  return flatten(new InlineParser(source).parse());
}

/* ------------------------------------------------------------------------------------------------
 * Reading blocks
 * --------------------------------------------------------------------------------------------- */

function isBlank(line: string): boolean {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string): number {
  let count = 0;
  while (line.charCodeAt(count) === 32) count += 1;
  return count;
}

function stripIndent(line: string, count: number): string {
  return line.slice(Math.min(count, indentOf(line)));
}

interface Fence {
  indent: number;
  char: string;
  length: number;
  language: string | null;
}

function fenceOpen(line: string): Fence | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const [, indent = '', marker = '', info = ''] = match;
  if (marker.startsWith('`') && info.includes('`')) return null;
  const language = info.trim().split(/[ \t]/, 1)[0] ?? '';
  return { indent: indent.length, char: marker[0]!, length: marker.length, language: language || null };
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence.char && marker.length >= fence.length;
}

function headingOpen(line: string): { level: HeadingLevel; text: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return null;
  let text = (match[2] ?? '').trim();
  text = /^#+$/.test(text) ? '' : text.replace(/[ \t]+#+$/, '').trim();
  return { level: match[1]!.length as HeadingLevel, text };
}

function quoteContent(line: string): string | null {
  const match = /^ {0,3}> ?(.*)$/.exec(line);
  return match ? match[1]! : null;
}

interface Marker {
  kind: 'bullet' | 'task' | 'ordered';
  /** The bullet, or the character after a number */
  bullet: string;
  number: number;
  /** Where the item's content starts, which later lines indent to */
  width: number;
  content: string;
  checked: boolean;
  /** Nothing follows the marker, so it can't interrupt a paragraph */
  empty: boolean;
}

function listMarker(line: string): Marker | null {
  const indent = indentOf(line);
  if (indent > 3) return null;
  let pos = indent;
  let kind: Marker['kind'];
  let bullet: string;
  let number = 0;
  const char = line[pos];
  if (char === '-' || char === '*' || char === '+') {
    kind = 'bullet';
    bullet = char;
    pos += 1;
  } else {
    const match = /^(\d{1,9})([.)])/.exec(line.slice(pos, pos + 10));
    if (!match) return null;
    kind = 'ordered';
    number = Number(match[1]);
    bullet = match[2]!;
    pos += match[0].length;
  }
  const end = pos;
  if (pos < line.length && line[pos] !== ' ' && line[pos] !== '\t') return null;
  let content: string;
  let width: number;
  if (isBlank(line.slice(pos))) {
    content = '';
    width = end + 1;
  } else if (line[pos] === '\t') {
    content = line.slice(pos + 1);
    width = end + 1;
  } else {
    let spaces = 0;
    while (line[pos + spaces] === ' ') spaces += 1;
    width = spaces > 4 ? end + 1 : end + spaces;
    content = line.slice(width);
  }
  const empty = content === '';
  let checked = false;
  if (kind === 'bullet') {
    const task = /^\[([ xX])\](?:[ \t]|$)/.exec(content);
    if (task) {
      kind = 'task';
      checked = task[1] !== ' ';
      content = content.slice(task[0].length);
    }
  }
  return { kind, bullet, number, width, content, checked, empty };
}

function interrupts(line: string, depth: number): boolean {
  if (headingOpen(line) || fenceOpen(line)) return true;
  if (depth >= MAX_DEPTH) return false;
  if (quoteContent(line) !== null) return true;
  const marker = listMarker(line);
  return marker !== null && !marker.empty && (marker.kind !== 'ordered' || marker.number === 1);
}

function paragraphOf(content: RichInline[]): RichParagraph {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function codeBlockOf(text: string, language: string | null): RichCodeBlock {
  return text
    ? { type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] }
    : { type: 'codeBlock', attrs: { language } };
}

function parseBlocks(lines: readonly string[], depth: number): RichBlock[] {
  const blocks: RichBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index]!, fence)) {
        body.push(stripIndent(lines[index]!, fence.indent));
        index += 1;
      }
      index += 1;
      blocks.push(codeBlockOf(body.join('\n'), fence.language));
      continue;
    }
    const heading = headingOpen(line);
    if (heading) {
      const content = parseInline(heading.text);
      blocks.push(
        content.length
          ? { type: 'heading', attrs: { level: heading.level }, content }
          : { type: 'heading', attrs: { level: heading.level } },
      );
      index += 1;
      continue;
    }
    if (depth < MAX_DEPTH) {
      if (quoteContent(line) !== null) {
        const inner: string[] = [];
        for (let content = quoteContent(line); content !== null; content = quoteContent(lines[index] ?? '')) {
          inner.push(content);
          index += 1;
          if (index >= lines.length) break;
        }
        const content = parseBlocks(inner, depth + 1);
        blocks.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
        continue;
      }
      const marker = listMarker(line);
      if (marker) {
        const list = parseList(lines, index, marker, depth);
        blocks.push(list.block);
        index = list.next;
        continue;
      }
    }
    const text = [line];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!) && !interrupts(lines[index]!, depth)) {
      text.push(lines[index]!);
      index += 1;
    }
    blocks.push(paragraphOf(parseInline(text.join('\n'))));
  }
  return blocks;
}

function parseList(
  lines: readonly string[],
  start: number,
  first: Marker,
  depth: number,
): { block: RichList; next: number } {
  const items: Array<{ marker: Marker; content: RichBlock[] }> = [];
  let index = start;
  while (index < lines.length) {
    const marker = listMarker(lines[index]!);
    if (!marker || marker.kind !== first.kind || marker.bullet !== first.bullet) break;
    const body = [marker.content];
    index += 1;
    while (index < lines.length) {
      const line = lines[index]!;
      if (isBlank(line)) {
        let ahead = index;
        while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
        if (ahead >= lines.length || indentOf(lines[ahead]!) < marker.width) break;
        // Spaces past the item's indent belong to the item, such as a code block's blank-looking line.
        for (; index < ahead; index += 1) body.push(lines[index]!.slice(marker.width));
        continue;
      }
      if (indentOf(line) < marker.width) break;
      body.push(line.slice(marker.width));
      index += 1;
    }
    const content = parseBlocks(body, depth + 1);
    items.push({
      marker,
      content: content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content],
    });
    let ahead = index;
    while (ahead < lines.length && isBlank(lines[ahead]!)) ahead += 1;
    const next = ahead < lines.length ? listMarker(lines[ahead]!) : null;
    if (!next || next.kind !== first.kind || next.bullet !== first.bullet) break;
    index = ahead;
  }
  if (first.kind === 'task')
    return {
      block: {
        type: 'taskList',
        content: items.map(({ marker, content }) => ({
          type: 'taskItem',
          attrs: { checked: marker.checked },
          content,
        })),
      },
      next: index,
    };
  const content = items.map(({ content }): RichListItem => ({ type: 'listItem', content }));
  return {
    block:
      first.kind === 'ordered'
        ? { type: 'orderedList', attrs: { start: first.number }, content }
        : { type: 'bulletList', content },
    next: index,
  };
}

/** Markdown as it was written, read into blocks.  Use `markdownToDoc` for editor content. */
export function parseMarkdown(markdown: string): RichDoc {
  return { type: 'doc', content: parseBlocks(markdown.replace(/\r\n?/g, '\n').split('\n'), 0) };
}

/* ------------------------------------------------------------------------------------------------
 * Canonical documents
 * --------------------------------------------------------------------------------------------- */

interface LooseNode {
  type?: unknown;
  attrs?: unknown;
  content?: unknown;
  marks?: unknown;
  text?: unknown;
}

function looseNode(value: unknown): LooseNode | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as LooseNode) : null;
}

function looseChildren(node: LooseNode): LooseNode[] {
  return Array.isArray(node.content) ? node.content.flatMap((child: unknown) => looseNode(child) ?? []) : [];
}

function looseAttr(node: LooseNode, name: string): unknown {
  const attrs = looseNode(node.attrs);
  return attrs ? (attrs as Record<string, unknown>)[name] : undefined;
}

function looseText(node: LooseNode): string {
  if (typeof node.text === 'string') return node.text;
  return looseChildren(node).map(looseText).join('');
}

function canonicalMarks(value: unknown): RichMark[] {
  const marks = new Map<RichMark['type'], RichMark>();
  for (const item of Array.isArray(value) ? value : []) {
    const mark = looseNode(item);
    const type = mark?.type;
    if (type === 'bold' || type === 'italic' || type === 'strike' || type === 'code')
      marks.set(type, { type });
    else if (mark && type === 'link') {
      const href = looseAttr(mark, 'href');
      const title = looseAttr(mark, 'title');
      if (typeof href === 'string' && safeLinkHref(href) !== null) {
        const text = typeof title === 'string' ? title.replace(/[\r\n]+/g, ' ') : '';
        marks.set('link', { type: 'link', attrs: { href, title: text === '' ? null : text } });
      }
    }
  }
  return sortMarks([...marks.values()]);
}

function segmentsOf(content: readonly RichInline[]): RichText[][] {
  const segments: RichText[][] = [[]];
  for (const node of content) {
    if (node.type === 'hardBreak') segments.push([]);
    else segments[segments.length - 1]!.push(node);
  }
  return segments;
}

function joinSegments(segments: readonly RichText[][]): RichInline[] {
  const out: RichInline[] = [];
  segments.forEach((segment, index) => {
    if (index > 0) out.push(BREAK);
    for (const node of segment) pushText(out, node.text, node.marks ?? []);
  });
  return out;
}

/** Nothing but spaces, which a line of Markdown can't hold: it would read as a blank line. */
function isBlankSegment(segment: readonly RichText[]): boolean {
  return segment.every((node) => !hasCode(node) && /^[ \t]*$/.test(node.text));
}

const DELIMITED = new Set<RichMark['type']>(['bold', 'italic', 'strike']);

/**
 * Bold, italic, and strikethrough can't start or end at a space, so a space only keeps one of them
 * when the characters on both sides of it have it too.  Two documents that differ only there look
 * the same, and now they print the same.
 */
function settleSpaces(segment: readonly RichText[]): RichText[] {
  const pieces: Array<{ text: string; marks: RichMark[]; space: boolean }> = [];
  for (const node of segment) {
    const marks = node.marks ?? [];
    if (hasCode(node)) pieces.push({ text: node.text, marks, space: false });
    else
      for (const part of node.text.split(/(\s+)/u))
        if (part) pieces.push({ text: part, marks, space: /^\s/u.test(part) });
  }
  const left: Array<readonly RichMark[]> = [];
  let seen: readonly RichMark[] = [];
  for (const piece of pieces) {
    left.push(seen);
    if (!piece.space) seen = piece.marks;
  }
  const right: Array<readonly RichMark[]> = [];
  seen = [];
  for (let index = pieces.length - 1; index >= 0; index -= 1) {
    right[index] = seen;
    if (!pieces[index]!.space) seen = pieces[index]!.marks;
  }
  const out: RichInline[] = [];
  pieces.forEach((piece, index) => {
    const marks = piece.space
      ? piece.marks.filter(
          (mark) =>
            !DELIMITED.has(mark.type) ||
            (left[index]!.some((other) => other.type === mark.type) &&
              right[index]!.some((other) => other.type === mark.type)),
        )
      : piece.marks;
    pushText(out, piece.text, marks);
  });
  return out as RichText[];
}

function canonicalInline(nodes: readonly LooseNode[]): RichInline[] {
  const out: RichInline[] = [];
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      out.push(BREAK);
      continue;
    }
    const marks = node.type === 'text' ? canonicalMarks(node.marks) : [];
    const parts = looseText(node).replace(/\r\n?/g, '\n').split('\n');
    parts.forEach((part, index) => {
      if (index > 0) out.push(BREAK);
      pushText(out, part, marks);
    });
  }
  // A paragraph can't end on a line break or on lines of spaces, which read as blank lines.
  const segments = segmentsOf(out);
  while (segments.length > 1 && isBlankSegment(segments[segments.length - 1]!)) segments.pop();
  if (segments.length === 1 && isBlankSegment(segments[0]!)) return [];
  return joinSegments(segments.map(settleSpaces));
}

/** Removes the spaces text starts with, across as many text nodes as they fill. */
function trimStart(nodes: RichInline[], space: RegExp): RichInline[] {
  const out = [...nodes];
  while (out.length) {
    const first = out[0]!;
    if (first.type !== 'text' || hasCode(first)) break;
    const text = first.text.replace(space, '');
    if (text) {
      out[0] = { ...first, text };
      break;
    }
    out.shift();
  }
  return out;
}

/** Removes the spaces text ends with, across as many text nodes as they fill. */
function trimEnd(nodes: RichInline[]): RichInline[] {
  const out = [...nodes];
  while (out.length) {
    const last = out[out.length - 1]!;
    if (last.type !== 'text' || hasCode(last)) break;
    const text = last.text.replace(/\s+$/u, '');
    if (text) {
      out[out.length - 1] = { ...last, text };
      break;
    }
    out.pop();
  }
  return out;
}

/** Headings are one line, without spaces around it. */
function canonicalHeading(nodes: readonly LooseNode[]): RichInline[] {
  const joined: RichText[] = [];
  for (const node of canonicalInline(nodes)) {
    if (node.type === 'hardBreak') pushText(joined, ' ', []);
    else pushText(joined, node.text, node.marks ?? []);
  }
  return trimEnd(trimStart(settleSpaces(joined), /^\s+/u));
}

function isEmptyParagraph(block: RichBlock | undefined): boolean {
  return block?.type === 'paragraph' && !block.content?.length;
}

function stripLeadingSpace(block: RichParagraph): RichParagraph {
  const content = block.content ?? [];
  const stripped = trimStart(content, /^[ \t]+/);
  return stripped.length === content.length && stripped[0] === content[0]
    ? block
    : paragraphOf(canonicalInline(stripped));
}

/**
 * An item always starts with a paragraph, which is empty when the item starts with another block.
 * A bulleted or numbered item's first line can't start with spaces, since Markdown reads them as
 * part of the marker.
 */
function canonicalItem(blocks: RichBlock[], strip: boolean): RichBlock[] {
  let list = settleBlocks(blocks.filter((block, index) => index === 0 || !isEmptyParagraph(block)));
  if (list[0]?.type !== 'paragraph') list = [{ type: 'paragraph' }, ...list];
  for (;;) {
    const first = list[0] as RichParagraph;
    if (strip) list[0] = stripLeadingSpace(first);
    if (!(list.length > 1 && isEmptyParagraph(list[0]) && list[1]?.type === 'paragraph')) break;
    list = list.slice(1);
  }
  return list;
}

function canonicalBlocks(nodes: readonly LooseNode[], depth: number): RichBlock[] {
  return nodes.flatMap((node) => canonicalBlock(node, depth));
}

/** Spaces that start a paragraph right after a list would make it part of the list's last item. */
function settleBlocks(blocks: readonly RichBlock[]): RichBlock[] {
  return blocks.map((block, index) => {
    const previous = blocks[index - 1];
    return block.type === 'paragraph' && previous && isList(previous) ? stripLeadingSpace(block) : block;
  });
}

function canonicalBlock(node: LooseNode, depth: number): RichBlock[] {
  const children = looseChildren(node);
  switch (node.type) {
    case 'paragraph':
      return [paragraphOf(canonicalInline(children))];
    case 'heading': {
      const level = looseAttr(node, 'level');
      const content = canonicalHeading(children);
      const attrs = {
        level: (typeof level === 'number' && level >= 1 && level <= 6
          ? Math.floor(level)
          : 1) as HeadingLevel,
      };
      return [content.length ? { type: 'heading', attrs, content } : { type: 'heading', attrs }];
    }
    case 'codeBlock': {
      const language = looseAttr(node, 'language');
      const text = children.map(looseText).join('').replace(/\r\n?/g, '\n');
      return [
        codeBlockOf(text, typeof language === 'string' && /^[^\s`]+$/.test(language) ? language : null),
      ];
    }
    case 'blockquote': {
      const content = depth < MAX_DEPTH ? canonicalBlocks(children, depth + 1) : [];
      const kept = settleBlocks(content.filter((block) => !isEmptyParagraph(block)));
      return [{ type: 'blockquote', content: kept.length ? kept : [{ type: 'paragraph' }] }];
    }
    case 'bulletList':
    case 'orderedList': {
      if (depth >= MAX_DEPTH) return [];
      const content = children.map((item): RichListItem => ({
        type: 'listItem',
        content: canonicalItem(canonicalBlocks(looseChildren(item), depth + 1), true),
      }));
      if (!content.length) return [];
      if (node.type === 'bulletList') return [{ type: 'bulletList', content }];
      const start = looseAttr(node, 'start');
      return [
        {
          type: 'orderedList',
          attrs: {
            start:
              typeof start === 'number' && Number.isInteger(start) && start >= 0
                ? Math.min(start, MAX_START)
                : 1,
          },
          content,
        },
      ];
    }
    case 'taskList': {
      if (depth >= MAX_DEPTH) return [];
      const content = children.map((item): RichTaskItem => ({
        type: 'taskItem',
        attrs: { checked: looseAttr(item, 'checked') === true },
        content: canonicalItem(canonicalBlocks(looseChildren(item), depth + 1), false),
      }));
      return content.length ? [{ type: 'taskList', content }] : [];
    }
    case 'text':
    case 'hardBreak':
      return [paragraphOf(canonicalInline([node]))];
    default: {
      // Anything else keeps its words: as a paragraph when it holds text, or as the blocks inside.
      if (children.some((child) => child.type === 'text' || child.type === 'hardBreak'))
        return [paragraphOf(canonicalInline(children))];
      return canonicalBlocks(children, depth + 1);
    }
  }
}

/**
 * Editor content in the one shape Markdown can say it in: the formats above and nothing else,
 * no empty paragraphs between blocks, and links only to addresses a link may open.
 */
export function canonicalDoc(value: unknown): RichDoc {
  const root = looseNode(value);
  const nodes = root?.type === 'doc' ? looseChildren(root) : root ? [root] : [];
  return {
    type: 'doc',
    content: settleBlocks(canonicalBlocks(nodes, 0).filter((block) => !isEmptyParagraph(block))),
  };
}

/** Stored Markdown as editor content. */
export function markdownToDoc(markdown: string): RichDoc {
  return canonicalDoc(parseMarkdown(markdown));
}

/** A document an editor can hold, which always has at least one paragraph. */
export function editorDoc(doc: RichDoc): RichDoc {
  return doc.content.length ? doc : { type: 'doc', content: [{ type: 'paragraph' }] };
}

/* ------------------------------------------------------------------------------------------------
 * Writing inline content
 * --------------------------------------------------------------------------------------------- */

type Tree = { leaf: RichText } | { mark: RichMark; key: string; children: Tree[] };

/**
 * Marks as nested spans.  A mark still open continues, and new marks open with the one that runs
 * furthest outermost, so spans close and reopen as seldom as possible.
 */
function buildTree(nodes: readonly RichText[]): Tree[] {
  const keyed = nodes.map((node) =>
    (node.marks ?? []).filter((mark) => mark.type !== 'code').map((mark) => ({ mark, key: markKey(mark) })),
  );
  const runs: Array<Map<string, number>> = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const lengths = new Map<string, number>();
    for (const { key } of keyed[index]!) lengths.set(key, 1 + (runs[index + 1]?.get(key) ?? 0));
    runs[index] = lengths;
  }
  const root: Tree[] = [];
  const open: Array<{ key: string; children: Tree[] }> = [];
  nodes.forEach((node, index) => {
    const marks = keyed[index]!;
    let keep = 0;
    while (keep < open.length && marks.some(({ key }) => key === open[keep]!.key)) keep += 1;
    open.length = keep;
    const fresh = marks.filter(({ key }) => !open.some((span) => span.key === key));
    fresh.sort(
      (a, b) =>
        (runs[index]!.get(b.key) ?? 0) - (runs[index]!.get(a.key) ?? 0) ||
        MARK_ORDER[a.mark.type] - MARK_ORDER[b.mark.type],
    );
    for (const { mark, key } of fresh) {
      const span = { mark, key, children: [] as Tree[] };
      (open[open.length - 1]?.children ?? root).push(span);
      open.push(span);
    }
    (open[open.length - 1]?.children ?? root).push({ leaf: node });
  });
  return root;
}

/**
 * Every run of text with its own spans, closing everything between runs.  Longer to write, but it
 * says some overlaps of bold and italic inside a word that nested spans can't.
 */
function buildFlatTree(nodes: readonly RichText[]): Tree[] {
  return nodes.map((node) => {
    const marks = sortMarks((node.marks ?? []).filter((mark) => mark.type !== 'code'));
    let tree: Tree = { leaf: node };
    for (const mark of marks.reverse()) tree = { mark, key: markKey(mark), children: [tree] };
    return tree;
  });
}

type TreeBuilder = (nodes: readonly RichText[]) => Tree[];
const TREE_BUILDERS: readonly TreeBuilder[] = [buildTree, buildFlatTree];

/** Bold, italic, or strikethrough: the spans written with delimiters, unlike links. */
function isDelimited(tree: Tree): boolean {
  return 'mark' in tree && tree.mark.type !== 'link';
}

/** Removes and returns the spaces a span starts with, through spans that start with it. */
function takeLeading(children: Tree[]): string {
  let taken = '';
  while (children.length) {
    const first = children[0]!;
    if (!('leaf' in first) || hasCode(first.leaf)) break;
    const space = /^\s+/u.exec(first.leaf.text)?.[0] ?? '';
    if (!space) break;
    taken += space;
    const rest = first.leaf.text.slice(space.length);
    if (rest) {
      children[0] = { leaf: { ...first.leaf, text: rest } };
      break;
    }
    children.shift();
  }
  return taken;
}

function takeTrailing(children: Tree[]): string {
  let taken = '';
  while (children.length) {
    const last = children[children.length - 1]!;
    if (!('leaf' in last) || hasCode(last.leaf)) break;
    const space = /\s+$/u.exec(last.leaf.text)?.[0] ?? '';
    if (!space) break;
    taken = space + taken;
    const rest = last.leaf.text.slice(0, last.leaf.text.length - space.length);
    if (rest) {
      children[children.length - 1] = { leaf: { ...last.leaf, text: rest } };
      break;
    }
    children.pop();
  }
  return taken;
}

/**
 * Bold, italic, and strikethrough can't start or end next to a space in Markdown, so the spaces
 * move outside them.  Links keep theirs, since brackets have no such rule.
 */
function expel(trees: readonly Tree[]): Tree[] {
  const out: Tree[] = [];
  for (const tree of trees) {
    if ('leaf' in tree) {
      out.push(tree);
      continue;
    }
    const children = expel(tree.children);
    if (!isDelimited(tree)) {
      out.push({ ...tree, children });
      continue;
    }
    const leading = takeLeading(children);
    const trailing = takeTrailing(children);
    if (leading) out.push({ leaf: { type: 'text', text: leading } });
    if (children.length) out.push({ ...tree, children });
    if (trailing) out.push({ leaf: { type: 'text', text: trailing } });
  }
  return out;
}

type Escapes = ReadonlySet<string>;

/**
 * Text with a backslash before whatever would read as formatting.  `after` is the character that
 * follows the text, since a backslash at its end escapes that character, or at a line's end makes a
 * line break.
 */
function escapeText(text: string, escapes: Escapes, inLink: boolean, after: string): string {
  return text.replace(/[\\*_~`[\]<]/g, (char, offset: number) => {
    if (char === '\\') {
      const next = text[offset + 1] ?? after;
      return next === '' || ASCII_PUNCTUATION.test(next) ? '\\\\' : '\\';
    }
    return escapes.has(char) || (inLink && (char === '[' || char === ']')) ? `\\${char}` : char;
  });
}

function codeSpan(text: string): string {
  const runs = new Set((text.match(/`+/g) ?? []).map((run) => run.length));
  let length = 1;
  while (runs.has(length)) length += 1;
  const fence = '`'.repeat(length);
  const pad =
    text.startsWith('`') ||
    text.endsWith('`') ||
    (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text));
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

function balanced(href: string): boolean {
  let depth = 0;
  for (const char of href) {
    if (char === '(') depth += 1;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function destination(href: string): string {
  if (!/[<>]/.test(href) && balanced(href)) return href.replace(/\\/g, '\\\\');
  return `<${href.replace(/[\\<>]/g, (char) => `\\${char}`)}>`;
}

/** Whether a character counts as a word's edge: a space, punctuation, or the start or end of a line. */
function isEdge(char: string): boolean {
  return char === '' || WHITESPACE.test(char) || PUNCTUATION.test(char);
}

function firstChar(text: string): string {
  const point = text.codePointAt(0);
  return point === undefined ? '' : String.fromCodePoint(point);
}

function lastChar(text: string): string {
  return text === '' ? '' : charBefore(text, text.length);
}

/**
 * The first character a tree renders as.  A span starts with its delimiter, which is punctuation, and
 * the stand-in says so without matching any real delimiter, since the span picks its own later.
 */
const SPAN_START = '!';

function leadingChar(tree: Tree | undefined, escapes: Escapes, inLink: boolean): string {
  if (!tree) return '';
  if (!('leaf' in tree)) return SPAN_START;
  return hasCode(tree.leaf) ? '`' : firstChar(escapeText(tree.leaf.text, escapes, inLink, SPAN_START));
}

function isEmphasis(tree: Tree | undefined): boolean {
  return tree !== undefined && 'mark' in tree && (tree.mark.type === 'bold' || tree.mark.type === 'italic');
}

/**
 * Bold and italic each have two spellings, with asterisks or with underscores.  Underscores only
 * work at a word's edges.  A run must never touch another run of the same character, or Markdown
 * reads them as one: `**a***b*` is ambiguous where `**a**_b_` isn't.  So italic takes underscores
 * where it can, as GitHub writes it, bold takes asterisks, and either one switches when the run
 * next to it already uses its character or can't use anything else.
 */
function emphasisChar(italic: boolean, previous: string, next: string, nextNeedsStar: boolean): string {
  const underscores = isEdge(previous) && isEdge(next);
  let char = italic && underscores ? '_' : '*';
  if (char === previous || char === next || (char === '*' && nextNeedsStar))
    char = char === '_' ? '*' : underscores && previous !== '_' && next !== '_' ? '_' : '*';
  return char;
}

/** Renders spans, knowing the characters just outside them. */
function renderTrees(
  trees: readonly Tree[],
  escapes: Escapes,
  inLink: boolean,
  before: string,
  after: string,
): string {
  let out = '';
  const nextOf = (index: number) =>
    index >= trees.length - 1 ? after : leadingChar(trees[index + 1], escapes, inLink);
  trees.forEach((tree, index) => {
    if ('leaf' in tree) {
      out += hasCode(tree.leaf)
        ? codeSpan(tree.leaf.text)
        : escapeText(tree.leaf.text, escapes, inLink, nextOf(index));
      return;
    }
    const mark = tree.mark;
    if (mark.type === 'link') {
      out += renderLink(mark.attrs, tree.children, escapes);
      return;
    }
    let delimiter = '~~';
    if (mark.type !== 'strike') {
      // A bold or italic span right after this one that can't use underscores needs asterisks,
      // so this one has to end with underscores.
      const nextNeedsStar = isEmphasis(trees[index + 1]) && !isEdge(nextOf(index + 1));
      const char = emphasisChar(
        mark.type === 'italic',
        out === '' ? before : lastChar(out),
        nextOf(index),
        nextNeedsStar,
      );
      delimiter = mark.type === 'bold' ? char + char : char;
    }
    const edge = delimiter[0]!;
    out += `${delimiter}${renderTrees(tree.children, escapes, inLink, edge, edge)}${delimiter}`;
  });
  return out;
}

function renderLink(
  attrs: { href: string; title: string | null },
  children: readonly Tree[],
  escapes: Escapes,
) {
  const { href, title } = attrs;
  const only = children.length === 1 ? children[0] : undefined;
  if (title === null && only && 'leaf' in only && !hasCode(only.leaf)) {
    const text = only.leaf.text;
    if (text === href && matchesWhole(URI_AUTOLINK, `<${href}>`)) return `<${href}>`;
    if (href === `mailto:${text}` && matchesWhole(EMAIL_AUTOLINK, `<${text}>`)) return `<${text}>`;
  }
  const quoted = title === null ? '' : ` "${title.replace(/["\\]/g, (char) => `\\${char}`)}"`;
  return `[${renderTrees(children, escapes, true, '[', ']')}](${destination(href)}${quoted})`;
}

/**
 * Where a line would start a block rather than continue the paragraph, the position of the
 * character to escape, or -1.  A paragraph's first line can start any block, and a later line only
 * the blocks that interrupt a paragraph.
 */
function blockStart(line: string, first: boolean): number {
  const indent = indentOf(line);
  if (indent > 3) return -1;
  const rest = line.slice(indent);
  if (/^(?:#{1,6}(?:[ \t]|$)|>|`{3,}|~{3,}|[-+*](?:[ \t]|$))/.test(rest)) return indent;
  const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(rest);
  if (ordered && (first || Number(ordered[1]) === 1)) return indent + ordered[1]!.length;
  return -1;
}

function renderLines(segments: readonly RichText[][], escapes: Escapes, build: TreeBuilder): string {
  return segments
    .map((segment, index) => {
      const trees = expel(build(segment));
      let line = renderTrees(trees, escapes, false, '', '');
      const first = trees[0];
      if (first && 'leaf' in first && !hasCode(first.leaf)) {
        const at = blockStart(line, index === 0);
        const leaf = escapeText(first.leaf.text, escapes, false, leadingChar(trees[1], escapes, false));
        if (at !== -1 && at < leaf.length) line = `${line.slice(0, at)}\\${line.slice(at)}`;
      }
      // A line of nothing but spaces would end the paragraph, so its line break is a backslash.
      if (index < segments.length - 1 && /^[ \t]*$/.test(line)) line += '\\';
      return line;
    })
    .join('\n');
}

function linesAreSafe(source: string): boolean {
  return source.split('\n').every((line, index) => blockStart(line, index === 0) === -1);
}

const ESCAPABLE = ['*', '_', '~', '`', '[', ']', '<'];

/**
 * The fewest escapes that read back right: none, then one kind of character at a time, then every
 * kind the text holds.
 */
function escapeSets(nodes: readonly RichInline[]): Escapes[] {
  const present = ESCAPABLE.filter((char) =>
    nodes.some((node) => node.type === 'text' && !hasCode(node) && node.text.includes(char)),
  );
  return [new Set<string>(), ...present.map((char) => new Set([char])), new Set(present)];
}

function printParagraph(content: readonly RichInline[]): string {
  const segments = segmentsOf(content);
  const sets = escapeSets(content);
  for (const build of TREE_BUILDERS)
    for (const escapes of sets) {
      const source = renderLines(segments, escapes, build);
      if (linesAreSafe(source) && sameInline(parseInline(source), content)) return source;
    }
  return renderLines(segments, sets[sets.length - 1]!, buildTree);
}

function renderHeading(nodes: readonly RichText[], escapes: Escapes, build: TreeBuilder): string {
  const source = renderTrees(expel(build(nodes)), escapes, false, '', '');
  // A run of hash marks at the end, after a space, would read as the heading's closing marks.
  const closing = /#+$/.exec(source);
  return closing && (closing.index === 0 || /[ \t]/.test(source[closing.index - 1]!))
    ? `${source.slice(0, closing.index)}\\${source.slice(closing.index)}`
    : source;
}

function printHeading(content: readonly RichInline[]): string {
  const nodes = content.filter((node): node is RichText => node.type === 'text');
  const sets = escapeSets(nodes);
  for (const build of TREE_BUILDERS)
    for (const escapes of sets) {
      const source = renderHeading(nodes, escapes, build);
      if (sameInline(parseInline(source.trim()), nodes)) return source;
    }
  return renderHeading(nodes, sets[sets.length - 1]!, buildTree);
}

/* ------------------------------------------------------------------------------------------------
 * Writing blocks
 * --------------------------------------------------------------------------------------------- */

function isList(block: RichBlock): block is RichList {
  return block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'taskList';
}

/** Whether a list can start on the line after a paragraph, as a list inside an item does. */
function listInterrupts(list: RichList): boolean {
  if (list.type === 'taskList') return true;
  const first = list.content[0];
  if (!first || isEmptyParagraph(first.content[0])) return false;
  return list.type === 'bulletList' || list.attrs.start === 1;
}

function printBlocks(blocks: readonly RichBlock[], inItem: boolean): string[] {
  const lines: string[] = [];
  let previous: RichBlock | null = null;
  let previousMarker = '';
  for (const block of blocks) {
    let marker = '';
    if (isList(block)) {
      // Two lists in a row stay two lists when the second uses the other bullet or delimiter.
      const plain = block.type === 'orderedList' ? '.' : '-';
      const other = block.type === 'orderedList' ? ')' : '*';
      marker = previous?.type === block.type && previousMarker === plain ? other : plain;
    }
    if (previous) {
      const tight =
        inItem &&
        previous.type === 'paragraph' &&
        (isEmptyParagraph(previous) || (isList(block) && listInterrupts(block)));
      if (!tight) lines.push('');
    }
    lines.push(...printBlock(block, marker));
    previous = block;
    previousMarker = marker;
  }
  return lines;
}

function printItem(content: readonly RichBlock[], marker: string, width: number, task: boolean): string[] {
  const body = printBlocks(content, true);
  let first = body[0] ?? '';
  // A bulleted item that happens to start with brackets isn't a checklist item.
  if (!task && /^\[[ xX]\](?:[ \t]|$)/.test(first)) first = `\\${first}`;
  const indent = ' '.repeat(width);
  return [
    first === '' ? marker : `${marker} ${first}`,
    ...body.slice(1).map((line) => (line ? indent + line : '')),
  ];
}

function printBlock(block: RichBlock, marker: string): string[] {
  switch (block.type) {
    case 'paragraph':
      return block.content?.length ? printParagraph(block.content).split('\n') : [''];
    case 'heading': {
      const text = block.content?.length ? printHeading(block.content) : '';
      return [`${'#'.repeat(block.attrs.level)}${text ? ` ${text}` : ''}`];
    }
    case 'codeBlock': {
      const text = (block.content ?? []).map((node) => node.text).join('');
      let longest = 0;
      for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
      const fence = '`'.repeat(Math.max(3, longest + 1));
      return [`${fence}${block.attrs.language ?? ''}`, ...(text === '' ? [] : text.split('\n')), fence];
    }
    case 'blockquote':
      return printBlocks(block.content, false).map((line) => (line ? `> ${line}` : '>'));
    case 'bulletList':
      return block.content.flatMap((item) => printItem(item.content, marker, marker.length + 1, false));
    case 'taskList':
      return block.content.flatMap((item) =>
        printItem(item.content, `${marker} [${item.attrs.checked ? 'x' : ' '}]`, marker.length + 1, true),
      );
    case 'orderedList':
      return block.content.flatMap((item, index) => {
        const number = block.attrs.start + index;
        const label = `${number > MAX_START ? block.attrs.start : number}${marker}`;
        return printItem(item.content, label, label.length + 1, false);
      });
  }
}

/** A canonical document as Markdown.  Use `docToMarkdown` for what an editor holds. */
export function printMarkdown(doc: RichDoc): string {
  return printBlocks(doc.content, false).join('\n');
}

/**
 * What an editor holds, as the Markdown to store.  Where Markdown can't say exactly what the editor
 * holds, such as a space inside bold where the bold has to close, the text is read back and written
 * again until it settles, so the same words always store as the same Markdown.
 */
export function docToMarkdown(value: unknown): string {
  let markdown = printMarkdown(canonicalDoc(value));
  for (let pass = 0; pass < 3; pass += 1) {
    const again = printMarkdown(markdownToDoc(markdown));
    if (again === markdown) break;
    markdown = again;
  }
  return markdown;
}

/* ------------------------------------------------------------------------------------------------
 * One line of plain text
 * --------------------------------------------------------------------------------------------- */

/** Enough of a long value for a line of text.  The rest never shows in one line anyway. */
const LINE_SOURCE_LIMIT = 20_000;
const LINE_CACHE_LIMIT = 500;
const lineCache = new Map<string, string>();

function collectText(blocks: readonly RichBlock[], parts: string[]): void {
  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        parts.push((block.content ?? []).map((node) => (node.type === 'text' ? node.text : ' ')).join(''));
        break;
      case 'codeBlock':
        parts.push((block.content ?? []).map((node) => node.text).join(''));
        break;
      case 'blockquote':
        collectText(block.content, parts);
        break;
      default:
        for (const item of block.content) collectText(item.content, parts);
    }
  }
}

/**
 * The words of a value on one line, for a grid cell or a card: formatting, list markers, and heading
 * marks left out, and every line break and block joined by a space.
 */
export function markdownLine(markdown: string): string {
  const cached = lineCache.get(markdown);
  if (cached !== undefined) return cached;
  const parts: string[] = [];
  collectText(parseMarkdown(markdown.slice(0, LINE_SOURCE_LIMIT)).content, parts);
  const line = parts.join(' ').replace(/\s+/gu, ' ').trim();
  if (lineCache.size >= LINE_CACHE_LIMIT) lineCache.clear();
  lineCache.set(markdown, line);
  return line;
}
