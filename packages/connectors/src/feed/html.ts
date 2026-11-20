import {
  docToMarkdown,
  safeLinkHref,
  type RichBlock,
  type RichDoc,
  type RichInline,
  type RichListItem,
  type RichMark,
} from '@riosoma/contracts';

/**
 * Feeds carry HTML, and Riosoma never shows HTML as markup.  This reads it leniently, the way a
 * browser forgives a missing end tag, and keeps only what rich text can say: paragraphs, headings,
 * lists, quotes, code, bold, italic, strikethrough, line breaks, and links to http, https, and
 * mailto addresses.  Scripts, styles, frames, forms, and images are dropped, and every other tag
 * gives up its text alone, so nothing a feed sends can become markup or run.
 */

/** Tags whose content is never text anyone reads, dropped whole. */
const DROPPED = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'select',
  'textarea',
  'button',
  'head',
  'title',
]);

/** Tags that never have content or an end tag. */
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Tags that start a block of their own, so text around them is a paragraph of its own. */
const BLOCKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

/** Elements nest this deep at most, and anything deeper gives up its text alone. */
const MAX_DEPTH = 24;
/** The most HTML one value reads, which is far more than any feed item holds. */
const MAX_HTML = 1_000_000;

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  ensp: '\u2002',
  emsp: '\u2003',
  thinsp: '\u2009',
  shy: '',
  zwnj: '\u200c',
  zwj: '\u200d',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  sbquo: '‚',
  ldquo: '“',
  rdquo: '”',
  bdquo: '„',
  laquo: '«',
  raquo: '»',
  lsaquo: '‹',
  rsaquo: '›',
  bull: '•',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  Dagger: '‡',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  iexcl: '¡',
  iquest: '¿',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  szlig: 'ß',
  ccedil: 'ç',
  agrave: 'à',
  egrave: 'è',
};

/** Text with its character references read: named ones HTML knows, and numbers in either base. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      // Nothing a reference names may be a control character or outside Unicode.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return '\ufffd';
      if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return '';
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(NAMED, name) ? NAMED[name]! : whole;
  });
}

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = string | Element;

const TAG =
  /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(ATTR)) {
    const name = match[1]!.toLowerCase();
    if (!Object.hasOwn(found, name)) found[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return found;
}

/** Reads HTML into a small tree, closing what a browser would close on its own. */
function tree(html: string): Element {
  const root: Element = { name: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const top = () => stack[stack.length - 1]!;
  const text = (value: string) => {
    if (value) top().children.push(decodeEntities(value));
  };
  const close = (name: string): boolean => {
    for (let at = stack.length - 1; at > 0; at -= 1) {
      if (stack[at]!.name === name) {
        stack.length = at;
        return true;
      }
    }
    return false;
  };
  let at = 0;
  const source = html.slice(0, MAX_HTML);
  const lower = source.toLowerCase();
  while (at < source.length) {
    const next = source.indexOf('<', at);
    if (next < 0) {
      text(source.slice(at));
      break;
    }
    text(source.slice(at, next));
    at = next;
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at + 9);
      const inner = source.slice(at + 9, end < 0 ? source.length : end);
      top().children.push(inner);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source[at + 1] === '!' || source[at + 1] === '?') {
      const end = source.indexOf('>', at);
      at = end < 0 ? source.length : end + 1;
      continue;
    }
    TAG.lastIndex = at;
    const match = TAG.exec(source);
    if (!match) {
      // A lone `<` is text, as a browser reads it.
      text('<');
      at += 1;
      continue;
    }
    at = TAG.lastIndex;
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase().replace(/^.*:/, '');
    if (closing) {
      close(name);
      continue;
    }
    if (DROPPED.has(name)) {
      if (VOID.has(name) || match[4] === '/') continue;
      // Skip to its own end tag, whatever it holds.
      const end = lower.indexOf(`</${name}`, at);
      if (end < 0) break;
      const after = source.indexOf('>', end);
      at = after < 0 ? source.length : after + 1;
      continue;
    }
    // A new paragraph, item, or heading ends the one still open, as a browser would.
    if (['p', 'li', 'dt', 'dd', 'tr', 'td', 'th'].includes(name) || /^h[1-6]$/.test(name)) {
      const open = top().name;
      if (
        (name === 'li' && open === 'li') ||
        ((name === 'dt' || name === 'dd') && (open === 'dt' || open === 'dd')) ||
        (name === 'tr' && open === 'tr') ||
        ((name === 'td' || name === 'th') && (open === 'td' || open === 'th'))
      )
        stack.pop();
    }
    if (BLOCKS.has(name) && top().name === 'p') stack.pop();
    const element: Element = { name, attrs: attributes(match[3] ?? ''), children: [] };
    top().children.push(element);
    if (!VOID.has(name) && match[4] !== '/' && stack.length <= MAX_DEPTH) stack.push(element);
  }
  return root;
}

/** Every piece of text under a node, as it reads, with breaks as new lines. */
function textOf(node: Node): string {
  if (typeof node === 'string') return node;
  if (node.name === 'br') return '\n';
  if (node.name === 'img') return node.attrs.alt ?? '';
  return node.children.map(textOf).join('');
}

/**
 * The words of some HTML as one line of plain text, for titles and summaries: tags gone, references
 * read, and every run of white space one space.
 */
export function htmlText(html: string): string {
  const root = tree(html);
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (typeof node === 'string') parts.push(node);
    else if (node.name === 'img') parts.push(node.attrs.alt ? ` ${node.attrs.alt} ` : ' ');
    else {
      if (BLOCKS.has(node.name) || node.name === 'br') parts.push(' ');
      node.children.forEach(walk);
      if (BLOCKS.has(node.name)) parts.push(' ');
    }
  };
  walk(root);
  return parts.join('').replace(/\s+/gu, ' ').trim();
}

const MARKS: Record<string, RichMark['type']> = {
  b: 'bold',
  strong: 'bold',
  i: 'italic',
  em: 'italic',
  cite: 'italic',
  s: 'strike',
  strike: 'strike',
  del: 'strike',
  code: 'code',
  kbd: 'code',
  samp: 'code',
  tt: 'code',
};

function withMark(marks: readonly RichMark[], mark: RichMark): RichMark[] {
  return marks.some((existing) => existing.type === mark.type) ? [...marks] : [...marks, mark];
}

/** An address as a link may use it: made absolute against the feed's address, and only if safe. */
function linkOf(href: string | undefined, base: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  try {
    return safeLinkHref(base ? new URL(trimmed, base).href : trimmed);
  } catch {
    return null;
  }
}

class DocBuilder {
  constructor(private readonly base: string | undefined) {}

  blocks(nodes: readonly Node[]): RichBlock[] {
    const out: RichBlock[] = [];
    let inline: Node[] = [];
    const flush = () => {
      const content = this.inline(inline, []);
      if (content.some((node) => node.type === 'text' && node.text.trim()))
        out.push({ type: 'paragraph', content });
      inline = [];
    };
    for (const node of nodes) {
      if (typeof node === 'string' || !BLOCKS.has(node.name)) {
        inline.push(node);
        continue;
      }
      flush();
      out.push(...this.block(node));
    }
    flush();
    return out;
  }

  private block(element: Element): RichBlock[] {
    const heading = /^h([1-6])$/.exec(element.name);
    if (heading) {
      const content = this.inline(element.children, []);
      return content.length
        ? [{ type: 'heading', attrs: { level: Number(heading[1]) as 1 | 2 | 3 | 4 | 5 | 6 }, content }]
        : [];
    }
    switch (element.name) {
      case 'blockquote': {
        const content = this.blocks(element.children);
        return content.length ? [{ type: 'blockquote', content }] : [];
      }
      case 'ul':
      case 'ol': {
        const items: RichListItem[] = [];
        for (const child of element.children) {
          if (typeof child === 'string' && !child.trim()) continue;
          const content = this.blocks(
            typeof child !== 'string' && child.name === 'li' ? child.children : [child],
          );
          if (content.length) items.push({ type: 'listItem', content });
        }
        if (!items.length) return [];
        if (element.name === 'ul') return [{ type: 'bulletList', content: items }];
        const start = Number.parseInt(element.attrs.start ?? '1', 10);
        return [
          {
            type: 'orderedList',
            attrs: { start: Number.isSafeInteger(start) && start >= 0 ? start : 1 },
            content: items,
          },
        ];
      }
      case 'pre': {
        const text = textOf(element).replace(/^\n/, '').replace(/\s+$/, '');
        return text
          ? [{ type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text }] }]
          : [];
      }
      case 'hr':
        return [];
      case 'tr': {
        // A table row reads as one paragraph, its cells side by side.
        const cells = element.children
          .filter(
            (child): child is Element =>
              typeof child !== 'string' && (child.name === 'td' || child.name === 'th'),
          )
          .map((cell) => this.inline(cell.children, []))
          .filter((content) => content.some((node) => node.type === 'text' && node.text.trim()));
        const content: RichInline[] = [];
        cells.forEach((cell, index) => {
          if (index) content.push({ type: 'text', text: ' | ' });
          content.push(...cell);
        });
        return content.length ? [{ type: 'paragraph', content }] : [];
      }
      default:
        return this.blocks(element.children);
    }
  }

  private inline(nodes: readonly Node[], marks: readonly RichMark[]): RichInline[] {
    const out: RichInline[] = [];
    const push = (text: string, active: readonly RichMark[]) => {
      if (!text) return;
      out.push(active.length ? { type: 'text', text, marks: [...active] } : { type: 'text', text });
    };
    const walk = (node: Node, active: readonly RichMark[]): void => {
      if (typeof node === 'string') {
        push(
          node.replace(/[\s\u00a0]+/gu, (space) => (space.includes('\u00a0') ? '\u00a0' : ' ')),
          active,
        );
        return;
      }
      if (node.name === 'br') {
        out.push({ type: 'hardBreak' });
        return;
      }
      if (node.name === 'img') {
        if (node.attrs.alt?.trim()) push(node.attrs.alt.trim(), active);
        return;
      }
      let next = active;
      const mark = MARKS[node.name];
      if (mark) next = withMark(next, { type: mark } as RichMark);
      if (node.name === 'a') {
        const href = linkOf(node.attrs.href, this.base);
        if (href)
          next = withMark(next, { type: 'link', attrs: { href, title: node.attrs.title?.trim() || null } });
      }
      for (const child of node.children) walk(child, next);
    };
    for (const node of nodes) walk(node, marks);
    // Space at a paragraph's edges and around its breaks reads as nothing.
    const trimmed: RichInline[] = [];
    for (const [index, node] of out.entries()) {
      if (node.type !== 'text') {
        trimmed.push(node);
        continue;
      }
      let text = node.text;
      const previous = trimmed[trimmed.length - 1];
      if (!previous || previous.type === 'hardBreak') text = text.replace(/^ +/, '');
      else if (previous.type === 'text' && previous.text.endsWith(' ')) text = text.replace(/^ +/, '');
      const following = out[index + 1];
      if (!following || following.type === 'hardBreak') text = text.replace(/ +$/, '');
      if (text) trimmed.push({ ...node, text });
    }
    while (trimmed[0]?.type === 'hardBreak') trimmed.shift();
    while (trimmed[trimmed.length - 1]?.type === 'hardBreak') trimmed.pop();
    return trimmed;
  }
}

/** HTML as rich text: a document in the subset rich text can say, with links made absolute. */
export function htmlToDoc(html: string, base?: string): RichDoc {
  return { type: 'doc', content: new DocBuilder(base).blocks(tree(html).children) };
}

/** HTML as the Markdown a rich text field stores. */
export function htmlToMarkdown(html: string, base?: string): string {
  return docToMarkdown(htmlToDoc(html, base));
}
