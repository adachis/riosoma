import { pieces, type Resolver } from './tokens.js';

/**
 * Email from automations.  Bodies are a small Markdown subset: paragraphs, line breaks, headings,
 * lists, bold, italics, code, and links.  Values from tokens are escaped and never read as
 * Markdown, so a record can't add links or markup to a message.
 */

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
/** Stands in for a token's value while the Markdown around it is rendered. */
const SLOT = /\uE000(\d+)\uE000/g;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!;
  });
}

function unescapeHtml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => {
    return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]!;
  });
}

function inline(source: string, values: readonly string[]): string {
  const codes: string[] = [];
  let out = escapeHtml(source).replace(/`([^`\n]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`);
    return `\uE001${codes.length - 1}\uE001`;
  });
  out = out.replace(/\[([^\]\n]+)\]\(([^()\s]+)\)/g, (_, label: string, target: string) => {
    const href = unescapeHtml(target).replace(SLOT, (_slot, index: string) => values[Number(index)] ?? '');
    return /^(https?:|mailto:)/i.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
  });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  return out.replace(/\uE001(\d+)\uE001/g, (_, index: string) => codes[Number(index)] ?? '');
}

function markdown(source: string, values: readonly string[]): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map((line) => inline(line, values)).join('<br>')}</p>`);
    paragraph = [];
    if (list)
      blocks.push(`<${list.tag}>${list.items.map((item) => `<li>${item}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push(`<h${heading[1]!.length}>${inline(heading[2]!, values)}</h${heading[1]!.length}>`);
    } else if (bullet || numbered) {
      const tag = bullet ? 'ul' : 'ol';
      if (paragraph.length || (list && list.tag !== tag)) flush();
      list ??= { tag, items: [] };
      list.items.push(inline((bullet ?? numbered)![1]!, values));
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks.join('\n');
}

/** The filled message: plain text as written, and HTML from its Markdown. */
export function renderBody(template: string, resolve: Resolver): { text: string; html: string } {
  const values: string[] = [];
  let source = '';
  let text = '';
  for (const piece of pieces(template)) {
    if ('text' in piece) {
      // Keep the marker characters out of the template's own text.
      const plain = piece.text.replace(/[\uE000\uE001]/g, '');
      source += plain;
      text += plain;
    } else {
      const value = resolve(piece.ref, piece.raw).text;
      source += `\uE000${values.length}\uE000`;
      values.push(value);
      text += value;
    }
  }
  const html = markdown(source, values).replace(SLOT, (_, index: string) =>
    escapeHtml(values[Number(index)] ?? '').replace(/\n/g, '<br>'),
  );
  return { text, html: `<div>${html}</div>` };
}

/** A subject on one line. */
export function renderSubject(template: string, resolve: Resolver): string {
  const text = pieces(template)
    .map((piece) => ('text' in piece ? piece.text : resolve(piece.ref, piece.raw).text))
    .join('');
  return text
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 900);
}

/**
 * The addresses the recipients name.  A token for an email or person field gives the addresses it
 * holds, and anything else is read as text.  Null when some entry isn't an address.
 */
export function recipients(templates: readonly string[], resolve: Resolver): string[] | null {
  const found = new Map<string, string>();
  for (const template of templates) {
    let text = '';
    for (const piece of pieces(template)) {
      if ('text' in piece) text += piece.text;
      else {
        const value = resolve(piece.ref, piece.raw);
        text += value.addresses.length ? ` ${value.addresses.join(' ')} ` : value.text;
      }
    }
    for (const entry of text.split(/[\s,;]+/)) {
      const address = entry.trim();
      if (!address) continue;
      if (!EMAIL.test(address)) return null;
      if (!found.has(address.toLowerCase())) found.set(address.toLowerCase(), address);
    }
  }
  return [...found.values()];
}
