import { describe, expect, it } from 'vitest';
import { SiteSettings } from '@riosoma/contracts';
import { reportEmail } from '../reports/email.js';
import { escapeHtml } from '../reports/messages.js';
import { xss } from '../test/corpora/xss.js';
import { documentHtml } from './render.js';

describe('shared XSS corpus in sites and email', () => {
  it.each(xss)('escapes untrusted names and values: %s', (payload) => {
    const settings = SiteSettings.parse({
      slug: 'corpus',
      title: payload,
      pages: [{ pageId: 'page01', slug: 'notes', title: payload, description: payload }],
      theme: { id: 'palette', scheme: 'house' },
    });
    const html = documentHtml(
      settings,
      '/sites/corpus',
      'https://example.test',
      payload,
      payload,
      '/sites/corpus/notes',
      '',
    );
    const email = reportEmail({
      to: 'reader@example.test',
      locale: 'en-US',
      timeZone: 'UTC',
      reportName: payload,
      viewName: payload,
      tableName: payload,
      ownerName: payload,
      sentAt: new Date('2026-01-01T00:00:00Z'),
      format: 'csv',
      count: 1,
      columns: [payload],
      rows: [[payload]],
      attachment: null,
      tooLarge: false,
      viewLink: 'https://example.test/view',
      stopLink: 'https://example.test/stop',
      oneClickLink: 'https://example.test/stop',
    });
    expect(html).toContain(escapeHtml(payload));
    expect(email.html).toContain(escapeHtml(payload));
    for (const rendered of [html, email.html!]) {
      expect(rendered).not.toMatch(/<(?:img|svg|iframe|math|textarea|input)\b/i);
      expect(rendered).not.toContain('<script>globalThis');
    }
    expect(email.text).toContain(payload);
  });
});

const hostilePresentation = [
  ...xss,
  '**unfinished [link](https://example.test (( _text',
  'word'.repeat(2000),
  'مرحبا بالعالم שלום עולם \u202eexample\u202c',
];
const corpusSettings = SiteSettings.parse({
  slug: 'presentation',
  title: 'Presentation',
  footer: '<img src=x onerror=alert(1)>',
  pages: [
    { pageId: 'page01', slug: 'home', title: 'Home' },
    { pageId: 'page02', slug: 'about', title: 'About' },
  ],
});

describe('presentation blocks keep hostile content in the allowlisted tree', () => {
  it.each(hostilePresentation)(
    'renders text, leads, heroes, images, videos, buttons, and cards safely: %.60s',
    async (payload) => {
      const { InterfacePage } = await import('@riosoma/contracts');
      const { renderPage } = await import('./render.js');
      const label = payload.slice(0, 100);
      const page = InterfacePage.parse({
        id: 'page01',
        name: 'Home',
        blocks: [
          {
            id: 'text01',
            kind: 'text',
            style: 'paragraph',
            text: payload,
            place: { x: 0, y: 0, w: 6, h: 2 },
          },
          { id: 'lead01', kind: 'text', style: 'lead', text: payload, place: { x: 6, y: 0, w: 6, h: 2 } },
          {
            id: 'heading01',
            kind: 'text',
            style: 'heading',
            text: payload,
            place: { x: 0, y: 15, w: 12, h: 2 },
          },
          {
            id: 'hero01',
            kind: 'hero',
            heading: label,
            text: payload,
            alt: payload,
            buttons: [{ label, action: { kind: 'url', url: 'https://example.test/' } }],
            place: { x: 0, y: 2, w: 12, h: 4 },
          },
          { id: 'image01', kind: 'media', alt: payload, caption: payload, place: { x: 0, y: 6, w: 6, h: 3 } },
          {
            id: 'video01',
            kind: 'media',
            mediaType: 'video',
            alt: payload,
            caption: payload,
            place: { x: 6, y: 6, w: 6, h: 3 },
          },
          {
            id: 'cards01',
            kind: 'records',
            display: 'cards',
            source: { tableId: 'tbl00000000000000', viewId: 'viw00000000000000' },
            fieldIds: [],
            place: { x: 0, y: 10, w: 12, h: 3 },
          },
          {
            id: 'button01',
            kind: 'button',
            label,
            action: { kind: 'page', pageId: 'page02' },
            place: { x: 0, y: 9, w: 6, h: 1 },
          },
        ],
      });
      const html = renderPage(
        corpusSettings,
        page,
        corpusSettings.pages[0]!,
        {
          records: [
            {
              id: 'cards01',
              title: '',
              display: 'cards',
              fields: [{ id: 'field01', name: label }],
              rows: [
                {
                  address: 'record01',
                  values: { field01: payload },
                  cover: 'page01.cards01.record01.file01',
                },
              ],
              offset: 0,
              more: false,
              detail: true,
            },
          ],
          filters: [],
          summaries: {},
          media: {
            hero01: { path: 'page01.hero01' },
            image01: { path: 'page01.image01' },
            video01: { path: 'page01.video01', poster: 'page01.video01.poster' },
          },
        },
        '/sites/presentation',
        'https://site.test',
        {},
      );
      expect(html).not.toMatch(/<(?:iframe|math|input|textarea)[^>]*>/i);
      // Only the server's external script is present, and no untrusted attribute becomes markup.
      const tags = html.match(/<[^>]+>/g) ?? [];
      for (const tag of tags)
        expect(tag.replace(/="[^"]*"/g, '')).not.toMatch(/\s(?:onerror|onload|onfocus|autoplay|style)\s*=/i);
      expect(html.match(/<script\b/g)).toHaveLength(1);
      expect(html).not.toMatch(/href="(?:javascript:|data:)/i);
      expect(html).toContain('controls preload="metadata" playsinline');
      expect(html).toContain('href="/sites/presentation/about"');
      expect(html).toContain(escapeHtml(payload));
      expect(Buffer.byteLength(html)).toBeLessThan(1024 * 1024);
    },
  );
});

it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'https://example.test/\npath'])(
  'refuses hostile URL actions in heroes and buttons even if stored content bypasses validation: %s',
  async (url) => {
    const { InterfacePage } = await import('@riosoma/contracts');
    const { renderPage } = await import('./render.js');
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        {
          id: 'hero001',
          kind: 'hero',
          buttons: [{ label: 'Unsafe hero action', action: { kind: 'url', url: 'https://example.test/' } }],
          place: { x: 0, y: 0, w: 12, h: 4 },
        },
        {
          id: 'button01',
          kind: 'button',
          label: 'Unsafe button action',
          action: { kind: 'url', url: 'https://example.test/' },
          place: { x: 0, y: 4, w: 6, h: 1 },
        },
      ],
    });
    const hero = page.blocks[0]!;
    const button = page.blocks[1]!;
    if (hero.kind === 'hero') hero.buttons[0]!.action = { kind: 'url', url };
    if (button.kind === 'button') button.action = { kind: 'url', url };
    expect(InterfacePage.safeParse(page).success).toBe(false);
    const html = renderPage(
      corpusSettings,
      page,
      corpusSettings.pages[0]!,
      { records: [], filters: [], summaries: {} },
      '/sites/presentation',
      'https://site.test',
      {},
    );
    expect(html).not.toContain('Unsafe hero action');
    expect(html).not.toContain('Unsafe button action');
    expect(html).not.toMatch(/href="(?:javascript|data):/);
  },
);
