import { describe, expect, it } from 'vitest';
import { parseSiteMarkdown } from './site-markdown.js';
import { Block, HeroButton } from './data/interfaces.js';

describe('the site Markdown tree', () => {
  it('contains only paragraphs, lists, text, breaks, emphasis, strong, and links', () => {
    expect(parseSiteMarkdown('A **strong** *opening*.\nAnother line.\n\n- One\n- Two\n\n2. Second')).toEqual([
      {
        kind: 'paragraph',
        children: [
          { kind: 'text', text: 'A ' },
          { kind: 'strong', children: [{ kind: 'text', text: 'strong' }] },
          { kind: 'text', text: ' ' },
          { kind: 'em', children: [{ kind: 'text', text: 'opening' }] },
          { kind: 'text', text: '.' },
          { kind: 'break' },
          { kind: 'text', text: 'Another line.' },
        ],
      },
      {
        kind: 'list',
        ordered: false,
        start: 1,
        items: [[{ kind: 'text', text: 'One' }], [{ kind: 'text', text: 'Two' }]],
      },
      { kind: 'list', ordered: true, start: 2, items: [[{ kind: 'text', text: 'Second' }]] },
    ]);
  });
  it('leaves unsupported HTML and malformed markup as text and bounds input', () => {
    expect(parseSiteMarkdown('<script onload="bad()">bad()</script>')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '<script onload="bad()">bad()</script>' }] },
    ]);
    expect(parseSiteMarkdown('**unfinished [link](address')).toEqual([
      { kind: 'paragraph', children: [{ kind: 'text', text: '**unfinished [link](address' }] },
    ]);
    expect(JSON.stringify(parseSiteMarkdown('a'.repeat(20000))).length).toBeLessThan(10200);
  });
  it.each(['javascript:alert(1)', 'data:text/html,bad', '//elsewhere.test', 'https://example.test/\npath'])(
    'rejects unsafe button addresses %s',
    (url) => {
      expect(HeroButton.safeParse({ label: 'Read more', action: { kind: 'url', url } }).success).toBe(false);
      expect(
        Block.safeParse({
          id: 'button01',
          kind: 'button',
          action: { kind: 'url', url },
          place: { x: 0, y: 0, w: 6, h: 1 },
        }).success,
      ).toBe(false);
    },
  );
  it('limits heroes to two buttons and accepts page destinations and attachment settings', () => {
    const button = { label: 'Read more', action: { kind: 'page', pageId: 'page02' } };
    const hero = {
      id: 'hero001',
      kind: 'hero',
      buttons: [button, button],
      place: { x: 0, y: 0, w: 12, h: 4 },
    };
    expect(Block.safeParse(hero).success).toBe(true);
    expect(Block.safeParse({ ...hero, buttons: [...hero.buttons, button] }).success).toBe(false);
  });
});
