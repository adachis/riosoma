import { describe, expect, it } from 'vitest';
import {
  canonicalDoc,
  docToMarkdown,
  markdownLine,
  markdownToDoc,
  parseMarkdown,
  printMarkdown,
  safeLinkHref,
  type RichBlock,
  type RichDoc,
  type RichInline,
  type RichMark,
  type RichText,
} from './markdown';

const roundTrip = (markdown: string) => docToMarkdown(markdownToDoc(markdown));

/** Every mark in a document, so a test can say no unsafe link survived. */
function marksOf(doc: RichDoc): RichMark[] {
  const marks: RichMark[] = [];
  const walk = (blocks: readonly RichBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'paragraph' || block.type === 'heading')
        for (const node of block.content ?? []) if (node.type === 'text') marks.push(...(node.marks ?? []));
      if (block.type === 'blockquote') walk(block.content);
      if (block.type === 'bulletList' || block.type === 'orderedList' || block.type === 'taskList')
        for (const item of block.content) walk(item.content);
    }
  };
  walk(doc.content);
  return marks;
}

function text(value: string, ...marks: RichMark[]): RichText {
  return marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };
}

const bold: RichMark = { type: 'bold' };
const italic: RichMark = { type: 'italic' };
const code: RichMark = { type: 'code' };
const link = (href: string, title: string | null = null): RichMark => ({
  type: 'link',
  attrs: { href, title },
});

/** Markdown the editor writes, which reads into a document and prints back unchanged. */
const CORPUS = [
  'Plain text',
  'Line one\nLine two',
  'First paragraph\n\nSecond paragraph',
  '**Bold** and _italic_ and ~~struck~~ and `code`',
  '**_Bold and italic_** text',
  '**Bold with _italic_ inside**',
  '_Italic with **bold** inside_',
  'un*frigging*believable',
  '**Note:**text',
  '[A link](https://example.com)',
  '[A link](https://example.com "With a title")',
  '<https://example.com/path?q=1>',
  '<ada@example.com>',
  '[Email me](mailto:ada@example.com)',
  '[**Bold** inside](https://example.com)',
  '[`code` link](https://example.com)',
  '[Wiki](https://en.wikipedia.org/wiki/Foo_(bar))',
  '[Odd](<https://example.com/a)b>)',
  '``code with ` inside``',
  '`` `starts with a backtick ``',
  '# Heading one',
  '## Heading two',
  '###### Heading six',
  '# Heading with **bold**',
  '# C#',
  '# Ends with \\#',
  '#',
  '- One\n- Two\n- Three',
  '1. One\n2. Two\n3. Three',
  '3. Three\n4. Four',
  '0. Zero',
  '- [ ] Open\n- [x] Done',
  '- [ ]',
  '- Parent\n  - Child\n    - Grandchild',
  '1. First\n   - Nested bullet\n2. Second',
  '- [ ] Task\n  - [x] Subtask',
  '- Item with two paragraphs\n\n  Second paragraph\n- Next item',
  '- Line one\n  Line two',
  '-\n  - Only a nested list',
  '-\n  > A quote in an item',
  '- \\[ ] Not a checklist item',
  '- One\n\n* Two',
  '1. One\n\n1) Two',
  '- [ ] Task\n\n- Bullet',
  '> Quoted',
  '> Quoted\n> second line',
  '> One\n>\n> Two',
  '> > Nested quote',
  '> - Quoted list\n> - Second',
  '>',
  '```\ncode\n```',
  '```js\nconst x = 1;\n```',
  '````\n```\nfence inside\n```\n````',
  '```\n```',
  '```\nline one\n\nline three\n```',
  '- Item\n\n  ```\n  code in item\n  ```',
  'Escaped \\*stars\\* stay',
  '\\# Not a heading',
  '\\- Not a list',
  '1\\. Not a list',
  '\\> Not a quote',
  '\\```not a fence',
  'a \\[not a link](https://example.com)',
  'Line one\n\\\nLine three',
  '\\\nStarts with a break',
  'Tabs\tand  spaces  stay',
  '  Leading spaces stay',
  'snake_case_name stays',
  '2 * 3 * 4',
  'Text with <b>html</b>, &amp; entities, and <script>alert(1)</script>',
  'C:\\Users\\Ada',
  'A trailing backslash\\\\',
  'Price: 5€, 50% off!  "Quotes" and \'apostrophes\'',
  'Emoji 🎉 and 日本語 stay',
];

describe('rich text Markdown', () => {
  it.each(CORPUS)('prints %j back exactly', (markdown) => {
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('reads the formats into editor content', () => {
    expect(markdownToDoc('**Bold** *italic* ~~gone~~ `x` [site](https://example.com "Home")')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text('Bold', bold),
            text(' '),
            text('italic', italic),
            text(' '),
            text('gone', { type: 'strike' }),
            text(' '),
            text('x', code),
            text(' '),
            text('site', link('https://example.com', 'Home')),
          ],
        },
      ],
    });
    expect(markdownToDoc('# Title\n\n- [x] Done\n  - Nested\n\n2. Two\n\n> Quote\n\n```sh\nls\n```')).toEqual(
      {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
          {
            type: 'taskList',
            content: [
              {
                type: 'taskItem',
                attrs: { checked: true },
                content: [
                  { type: 'paragraph', content: [text('Done')] },
                  {
                    type: 'bulletList',
                    content: [
                      { type: 'listItem', content: [{ type: 'paragraph', content: [text('Nested')] }] },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'orderedList',
            attrs: { start: 2 },
            content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('Two')] }] }],
          },
          { type: 'blockquote', content: [{ type: 'paragraph', content: [text('Quote')] }] },
          { type: 'codeBlock', attrs: { language: 'sh' }, content: [text('ls')] },
        ],
      },
    );
  });

  it('keeps a line break inside a paragraph, and a blank line between paragraphs', () => {
    expect(markdownToDoc('One\nTwo\n\nThree').content).toEqual([
      { type: 'paragraph', content: [text('One'), { type: 'hardBreak' }, text('Two')] },
      { type: 'paragraph', content: [text('Three')] },
    ]);
  });

  it('keeps inline code together with other formatting', () => {
    expect(markdownToDoc('**`x`** [`y`](https://example.com)').content[0]).toEqual({
      type: 'paragraph',
      content: [text('x', bold, code), text(' '), text('y', link('https://example.com'), code)],
    });
  });

  it.each([
    ['* One\n* Two', '- One\n- Two'],
    ['+ One', '- One'],
    ['1) One\n2) Two', '1. One\n2. Two'],
    ['5. Five\n9. Nine', '5. Five\n6. Nine'],
    ['Shopping:\n- milk\n- eggs', 'Shopping:\n\n- milk\n- eggs'],
    ['A\n\n\n\nB', 'A\n\nB'],
    ['__bold__ and *italic*', '**bold** and _italic_'],
    ['Back\\\nslash', 'Back\nslash'],
    ['# Heading #', '# Heading'],
    ['#    Spaced    ', '# Spaced'],
    ['- loose\n\n- list', '- loose\n- list'],
    ['~~~\ncode\n~~~', '```\ncode\n```'],
    ['```js extra words\nx\n```', '```js\nx\n```'],
    ['```\nunclosed', '```\nunclosed\n```'],
    ['> lazy\ncontinuation', '> lazy\n\ncontinuation'],
    ['- [X] Done', '- [x] Done'],
    ['Text\n', 'Text'],
    ['  \n\nText\n\n  ', 'Text'],
    ['[x](https://example.com "")', '[x](https://example.com)'],
    ['- # Heading in an item', '-\n  # Heading in an item'],
    ['-\n\n  Late content', '- Late content'],
    ['<https://example.com>', '<https://example.com>'],
    ['[https://example.com](https://example.com)', '<https://example.com>'],
    ['***both***', '**_both_**'],
    ['**a *b***', '**a _b_**'],
  ])('normalizes %j to %j, and that is stable', (input, expected) => {
    expect(roundTrip(input)).toBe(expected);
    expect(roundTrip(expected)).toBe(expected);
  });

  it('leaves plain text exactly as it was', () => {
    const notes = [
      'Call Ada about the Q3 report.\nShe prefers mornings.',
      'Address:\n12 Main St.\nSpringfield, IL 62701',
      'Ratio 2:1, cost $5 * 3 = $15',
      'file_name_v2.txt and another_file.md',
      'Use <angle brackets> & ampersands freely',
      'Mr. Smith (the tall one) said "hi!"',
      '#hashtag and #another',
      '100% sure — maybe 99%',
      'C:\\Program Files\\App',
      'a -> b => c',
      '~approximately 5 minutes~',
      'Email: ada@example.com, site: example.com',
    ];
    for (const note of notes) expect(roundTrip(note)).toBe(note);
  });

  describe('links', () => {
    it.each([
      ['https://example.com', 'https://example.com'],
      ['HTTPS://EXAMPLE.COM/Path', 'HTTPS://EXAMPLE.COM/Path'],
      ['http://localhost:8080/a?b=c#d', 'http://localhost:8080/a?b=c#d'],
      ['mailto:ada@example.com', 'mailto:ada@example.com'],
      ['javascript:alert(1)', null],
      ['JaVaScRiPt:alert(1)', null],
      [' javascript:alert(1)', null],
      ['java\tscript:alert(1)', null],
      ['\u0001javascript:alert(1)', null],
      ['vbscript:msgbox(1)', null],
      ['data:text/html,<script>alert(1)</script>', null],
      ['file:///etc/passwd', null],
      ['ftp://example.com', null],
      ['//example.com', null],
      ['/relative/path', null],
      ['example.com', null],
      ['&#106;avascript:alert(1)', null],
      ['https://', null],
      ['mailto:', null],
      ['', null],
    ])('allows %j as %j', (href, expected) => {
      expect(safeLinkHref(href)).toBe(expected);
    });

    it.each([
      '[click](javascript:alert(1))',
      '[click](JaVaScRiPt:alert(1))',
      '[click](  javascript:alert(1)  )',
      '[click](<javascript:alert(1)>)',
      '[click](data:text/html,<script>alert(1)</script>)',
      '[click](vbscript:msgbox(1))',
      '[click](//evil.example)',
      '[click](/relative)',
      '[click](example.com)',
      '[click](&#106;avascript:alert(1))',
      '[click](java\\\nscript:alert(1))',
      '<javascript:alert(1)>',
      '<data:text/html,hi>',
      '[**nested**](javascript:alert(1)) text',
    ])('keeps %j as harmless text', (markdown) => {
      const doc = markdownToDoc(markdown);
      expect(marksOf(doc).filter((mark) => mark.type === 'link')).toEqual([]);
      expect(roundTrip(markdown)).toBe(roundTrip(roundTrip(markdown)));
    });

    it('never nests a link inside another', () => {
      const doc = markdownToDoc('[a [b](https://b.example) c](https://a.example)');
      const links = marksOf(doc).filter((mark) => mark.type === 'link');
      expect(links).toEqual([link('https://b.example')]);
    });

    it('drops a link an editor holds to an address a link may not open', () => {
      const markdown = docToMarkdown({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'bad',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
              {
                type: 'text',
                text: ' good',
                marks: [{ type: 'link', attrs: { href: 'ftp://example.com' } }],
              },
            ],
          },
        ],
      });
      expect(markdown).toBe('bad good');
    });
  });

  it('never reads HTML or entities, so they stay the characters typed', () => {
    const source = '<script>alert(1)</script> <img src=x onerror=alert(1)> &lt;b&gt; &amp; &#x3C;';
    expect(markdownToDoc(source).content).toEqual([{ type: 'paragraph', content: [text(source)] }]);
    expect(roundTrip(source)).toBe(source);
  });

  it('writes what an editor holds, including shapes Markdown needs help with', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Bold with spaces ', marks: [{ type: 'bold' }] }],
        },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: '1. not a list' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'hardBreak' },
            { type: 'hardBreak' },
            { type: 'text', text: 'b' },
            { type: 'hardBreak' },
          ],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '  Trimmed #  ' }] },
        { type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'let a = "```";' }] },
        {
          type: 'orderedList',
          attrs: { start: 9, type: null },
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'nine' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ten' }] }] },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toBe(
      [
        '**Bold with spaces** ',
        '',
        '1\\. not a list',
        '',
        'a\n\\\nb',
        '',
        '## Trimmed \\#',
        '',
        '````ts\nlet a = "```";\n````',
        '',
        '9. nine\n10. ten',
      ].join('\n'),
    );
    expect(roundTrip(markdown)).toBe(markdown);
  });

  it('reads deeply nested markers as text instead of running out of stack', () => {
    const quotes = `${'>'.repeat(5_000)} deep`;
    expect(() => markdownToDoc(quotes)).not.toThrow();
    const stars = `${'*'.repeat(20_000)}x${'*'.repeat(20_000)}`;
    expect(() => markdownToDoc(stars)).not.toThrow();
    expect(roundTrip(roundTrip(stars))).toBe(roundTrip(stars));
    const lists = Array.from({ length: 200 }, (_, depth) => `${'  '.repeat(depth)}- item`).join('\n');
    expect(() => markdownToDoc(lists)).not.toThrow();
  });

  it('reads long values with runs that never close', () => {
    // Unclosed backticks and brackets are the inputs that make a careless reader quadratic.
    expect(markdownToDoc('`a '.repeat(50_000)).content).toHaveLength(1);
    expect(markdownToDoc('[a](b '.repeat(20_000)).content).toHaveLength(1);
    const long = '**bold** and text\n'.repeat(20_000);
    expect(roundTrip(long)).toBe(long.trimEnd());
  });

  describe('one line of text', () => {
    it.each([
      ['**Bold** and *italic*', 'Bold and italic'],
      ['# Heading\n\nParagraph', 'Heading Paragraph'],
      ['- One\n- Two\n  - Three', 'One Two Three'],
      ['- [x] Done\n- [ ] Open', 'Done Open'],
      ['1. First\n2. Second', 'First Second'],
      ['> Quote\n\n```\ncode\nmore\n```', 'Quote code more'],
      ['Line one\nLine two', 'Line one Line two'],
      ['[Link text](https://example.com)', 'Link text'],
      ['<script>x</script> &amp;', '<script>x</script> &amp;'],
      ['  spaced   out  ', 'spaced out'],
      ['', ''],
    ])('shows %j as %j', (markdown, line) => {
      expect(markdownLine(markdown)).toBe(line);
    });
  });
});

/* ------------------------------------------------------------------------------------------------
 * Seeded fuzzing: random documents print and read back as themselves, and random text prints
 * the same way twice.
 * --------------------------------------------------------------------------------------------- */

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number) => Math.floor(next() * max);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  return { next, int, pick };
}

const ALPHABET = [
  ...'abcdefghij',
  ...'  ',
  '\t',
  ...'*_~`[]()<>#-+.!\\&"\':/|=',
  '1',
  '2',
  '\u00a0',
  '🎉',
  'é',
];
const HREFS = [
  'https://example.com',
  'https://example.com/a_b*c',
  'https://en.wikipedia.org/wiki/Foo_(bar)',
  'https://example.com/a)b',
  'https://example.com/<x>',
  'https://example.com/back\\slash',
  'mailto:ada@example.com',
];

function randomText(rng: ReturnType<typeof random>, max = 8): string {
  const length = 1 + rng.int(max);
  let out = '';
  for (let i = 0; i < length; i++) out += rng.pick(ALPHABET);
  return out;
}

function randomInline(rng: ReturnType<typeof random>): RichInline[] {
  const content: RichInline[] = [];
  const count = 1 + rng.int(6);
  for (let i = 0; i < count; i++) {
    if (rng.next() < 0.12) {
      content.push({ type: 'hardBreak' });
      continue;
    }
    const marks: RichMark[] = [];
    if (rng.next() < 0.3) marks.push({ type: 'bold' });
    if (rng.next() < 0.3) marks.push({ type: 'italic' });
    if (rng.next() < 0.2) marks.push({ type: 'strike' });
    if (rng.next() < 0.15) marks.push({ type: 'code' });
    if (rng.next() < 0.2)
      marks.push({
        type: 'link',
        attrs: { href: rng.pick(HREFS), title: rng.next() < 0.2 ? randomText(rng, 4) : null },
      });
    content.push({ type: 'text', text: randomText(rng), marks });
  }
  return content;
}

function randomBlocks(rng: ReturnType<typeof random>, depth: number, max = 4): RichBlock[] {
  const blocks: RichBlock[] = [];
  const count = 1 + rng.int(max);
  for (let i = 0; i < count; i++) {
    const roll = rng.int(depth > 2 ? 3 : 8);
    const item = () => [
      { type: 'paragraph' as const, content: rng.next() < 0.1 ? [] : randomInline(rng) },
      ...(rng.next() < 0.4 ? randomBlocks(rng, depth + 1, 2) : []),
    ];
    if (roll === 0 || roll === 1) blocks.push({ type: 'paragraph', content: randomInline(rng) });
    else if (roll === 2)
      blocks.push({
        type: 'heading',
        attrs: { level: (1 + rng.int(6)) as 1 },
        content: randomInline(rng),
      });
    else if (roll === 3)
      blocks.push({
        type: 'codeBlock',
        attrs: { language: rng.next() < 0.5 ? null : 'js' },
        content: [{ type: 'text', text: `${randomText(rng)}\n${randomText(rng)}` }],
      });
    else if (roll === 4) blocks.push({ type: 'blockquote', content: randomBlocks(rng, depth + 1, 2) });
    else if (roll === 5)
      blocks.push({
        type: 'bulletList',
        content: Array.from({ length: 1 + rng.int(3) }, () => ({ type: 'listItem', content: item() })),
      });
    else if (roll === 6)
      blocks.push({
        type: 'orderedList',
        attrs: { start: rng.int(12) },
        content: Array.from({ length: 1 + rng.int(3) }, () => ({ type: 'listItem', content: item() })),
      });
    else
      blocks.push({
        type: 'taskList',
        content: Array.from({ length: 1 + rng.int(3) }, () => ({
          type: 'taskItem',
          attrs: { checked: rng.next() < 0.5 },
          content: item(),
        })),
      });
  }
  return blocks;
}

/** Content as characters with their marks.  Spaces may differ in bold, italic, and strikethrough. */
function sameContent(a: readonly RichInline[] = [], b: readonly RichInline[] = []): boolean {
  const chars = (content: readonly RichInline[]) =>
    content.flatMap((node) => {
      if (node.type === 'hardBreak') return [{ char: '\n', full: 'break', loose: 'break' }];
      const names = (node.marks ?? [])
        .map((mark) => (mark.type === 'link' ? `link ${mark.attrs.href} ${mark.attrs.title}` : mark.type))
        .sort();
      const full = names.join(',');
      const loose = names.filter((name) => !['bold', 'italic', 'strike'].includes(name)).join(',');
      return [...node.text].map((char) => ({ char, full, loose }));
    });
  const x = chars(a);
  const y = chars(b);
  return (
    x.length === y.length &&
    x.every((unit, index) => {
      const other = y[index]!;
      return (
        unit.char === other.char &&
        (unit.full === other.full || (/\s/u.test(unit.char) && unit.loose === other.loose))
      );
    })
  );
}

function sameBlocks(a: readonly RichBlock[], b: readonly RichBlock[]): boolean {
  return (
    a.length === b.length &&
    a.every((block, index) => {
      const other = b[index]!;
      if (block.type !== other.type) return false;
      switch (block.type) {
        case 'paragraph':
          return sameContent(block.content, (other as typeof block).content);
        case 'heading':
          return (
            block.attrs.level === (other as typeof block).attrs.level &&
            sameContent(block.content, (other as typeof block).content)
          );
        case 'codeBlock':
          return JSON.stringify(block) === JSON.stringify(other);
        case 'blockquote':
          return sameBlocks(block.content, (other as typeof block).content);
        case 'orderedList':
          if (block.attrs.start !== (other as typeof block).attrs.start) return false;
          return block.content.every((item, i) =>
            sameBlocks(item.content, (other as typeof block).content[i]?.content ?? []),
          );
        case 'bulletList':
          return (
            block.content.length === (other as typeof block).content.length &&
            block.content.every((item, i) =>
              sameBlocks(item.content, (other as typeof block).content[i]!.content),
            )
          );
        case 'taskList':
          return (
            block.content.length === (other as typeof block).content.length &&
            block.content.every(
              (item, i) =>
                item.attrs.checked === (other as typeof block).content[i]!.attrs.checked &&
                sameBlocks(item.content, (other as typeof block).content[i]!.content),
            )
          );
      }
    })
  );
}

// A thousand of each on every run; the performance pass runs twenty thousand.
const FUZZ_RUNS = process.env.RIOSOMA_PERF ? 20_000 : 1_000;

describe('rich text Markdown, fuzzed', { timeout: 120_000 }, () => {
  it('prints random documents that read back as themselves', () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= FUZZ_RUNS && failures.length < 5; seed++) {
      const doc = canonicalDoc({ type: 'doc', content: randomBlocks(random(seed), 0) });
      const markdown = docToMarkdown(doc);
      const back = markdownToDoc(markdown);
      if (!sameBlocks(back.content, doc.content) || docToMarkdown(back) !== markdown)
        failures.push(
          `seed ${seed}: ${JSON.stringify(markdown)}\n${JSON.stringify(doc)}\n${JSON.stringify(back)}`,
        );
    }
    expect(failures).toEqual([]);
  });

  it('prints any text the same way twice', () => {
    const pieces = [
      '**',
      '*',
      '_',
      '__',
      '~~',
      '~',
      '`',
      '``',
      '```',
      '[',
      ']',
      '(',
      ')',
      '](https://example.com)',
      '<',
      '>',
      '<https://example.com>',
      '\\',
      '\n',
      '\n\n',
      '# ',
      '- ',
      '* ',
      '1. ',
      '2) ',
      '> ',
      '- [ ] ',
      '  ',
      '    ',
      '\t',
      'word',
      'x',
      ' ',
      '#',
      '!',
      '&amp;',
      '<b>',
    ];
    const failures: string[] = [];
    for (let seed = 1; seed <= FUZZ_RUNS && failures.length < 5; seed++) {
      const rng = random(seed);
      let source = '';
      const count = 1 + rng.int(14);
      for (let i = 0; i < count; i++) source += rng.pick(pieces);
      const once = roundTrip(source);
      const twice = roundTrip(once);
      if (twice !== once)
        failures.push(
          `seed ${seed}: ${JSON.stringify(source)} -> ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`,
        );
    }
    expect(failures).toEqual([]);
  });

  it('reads what it wrote without losing a character', () => {
    // Formatting may change on the way in, but the words never do.
    for (let seed = 1; seed <= 500; seed++) {
      const doc = canonicalDoc({ type: 'doc', content: randomBlocks(random(seed), 0) });
      expect(markdownLine(printMarkdown(doc))).toBe(
        markdownLine(printMarkdown(parseMarkdown(printMarkdown(doc)))),
      );
    }
  });
});
