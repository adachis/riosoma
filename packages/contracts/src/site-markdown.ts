/** A deliberately small tree, with no HTML nodes or arbitrary attributes. */
export type SiteMarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'break' }
  | { kind: 'em' | 'strong'; children: SiteMarkdownInline[] }
  | { kind: 'link'; href: string; children: SiteMarkdownInline[] };
export type SiteMarkdownBlock =
  | { kind: 'paragraph'; children: SiteMarkdownInline[] }
  | { kind: 'list'; ordered: boolean; start: number; items: SiteMarkdownInline[][] };

function inline(text: string, depth = 0): SiteMarkdownInline[] {
  if (depth >= 12) return [{ kind: 'text', text }];
  const nodes: SiteMarkdownInline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) nodes.push({ kind: 'text', text: plain });
    plain = '';
  };
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === '\\' && /[\\*_[\]()]/.test(text[index + 1] ?? '')) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '\n') {
      flush();
      nodes.push({ kind: 'break' });
      index++;
      continue;
    }
    if (character === '[') {
      const endLabel = text.indexOf('](', index + 1);
      if (endLabel >= 0) {
        let end = endLabel + 2;
        let nesting = 1;
        while (end < text.length && nesting) {
          if (text[end] === '(') nesting++;
          if (text[end] === ')') nesting--;
          if (nesting) end++;
        }
        if (!nesting) {
          flush();
          nodes.push({
            kind: 'link',
            href: text.slice(endLabel + 2, end),
            children: inline(text.slice(index + 1, endLabel), depth + 1),
          });
          index = end + 1;
          continue;
        }
      }
    }
    if (
      (character === '*' || character === '_') &&
      (index === 0 || !/\w/.test(text[index - 1]!) || character === '*')
    ) {
      const marker = text[index + 1] === character ? character + character : character;
      const end = text.indexOf(marker, index + marker.length);
      if (end > index + marker.length) {
        flush();
        nodes.push({
          kind: marker.length === 2 ? 'strong' : 'em',
          children: inline(text.slice(index + marker.length, end), depth + 1),
        });
        index = end + marker.length;
        continue;
      }
    }
    plain += character;
    index++;
  }
  flush();
  return nodes;
}

/** Unsupported markup stays text.  Limits bound parsing work as well as the rendered tree. */
export function parseSiteMarkdown(text: string): SiteMarkdownBlock[] {
  const lines = text.slice(0, 10000).replace(/\r\n?/g, '\n').split('\n');
  const blocks: SiteMarkdownBlock[] = [];
  const listItem = (line: string) => /^\s{0,3}(?:([-+*])|([0-9]{1,6})[.)])\s+(.+)$/.exec(line);
  for (let index = 0; index < lines.length;) {
    if (!lines[index]!.trim()) {
      index++;
      continue;
    }
    const first = listItem(lines[index]!);
    if (first) {
      const ordered = Boolean(first[2]);
      const items: SiteMarkdownInline[][] = [];
      while (index < lines.length) {
        const item = listItem(lines[index]!);
        if (!item || Boolean(item[2]) !== ordered) break;
        items.push(inline(item[3]!));
        index++;
      }
      blocks.push({ kind: 'list', ordered, start: ordered ? Number(first[2]) : 1, items });
    } else {
      const paragraph: string[] = [];
      while (index < lines.length && lines[index]!.trim() && !listItem(lines[index]!))
        paragraph.push(lines[index++]!);
      blocks.push({ kind: 'paragraph', children: inline(paragraph.join('\n')) });
    }
  }
  return blocks;
}
