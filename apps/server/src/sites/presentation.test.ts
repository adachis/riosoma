import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
  Block,
  Command,
  DatabaseCreate,
  InterfacePage,
  SiteSettings,
  newId,
  type ChartBlock,
  type TileData,
} from '@riosoma/contracts';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import * as previews from '../data/files/previews.js';
import { chartSvg } from './charts.js';
import { markdownHtml } from './markdown.js';
import { mediaRange } from './media.js';
import { documentHtml, renderPage, SITE_CSS, SITE_SCRIPT } from './render.js';
import type { SiteContent } from './reads.js';
import { readSiteTheme, siteCss } from './site.css.js';

const settings = SiteSettings.parse({
  slug: 'studio',
  title: 'Studio',
  footer: 'Made with care.',
  logo: {
    tableId: 'tbl00000000000000',
    fieldId: 'fld00000000000000',
    recordId: 'rec00000000000000',
    attachmentId: 'att00000000000000',
  },
  pages: [
    { pageId: 'page02', slug: 'about', title: 'About' },
    { pageId: 'page01', slug: 'home', title: 'Home' },
  ],
});
const chart = (kind: string): ChartBlock =>
  Block.parse({
    id: 'chart01',
    kind: 'chart',
    chart: kind,
    place: { x: 0, y: 0, w: 6, h: 4 },
    source: { tableId: 'tbl00000000000000' },
    value: { fn: 'count' },
    groupBy: { fieldId: 'fld00000000000000' },
  }) as ChartBlock;

async function presentationTheme(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'site-presentation-theme-'));
  const fontDirectory = join(root, 'palette', 'assets', 'fonts', 'remote');
  await mkdir(fontDirectory, { recursive: true });
  await writeFile(join(root, 'index.json'), '{}');
  await writeFile(
    join(root, 'palette', 'theme.json'),
    JSON.stringify({ defaultScheme: 'house', schemes: [{ id: 'house' }, { id: 'midnight' }] }),
  );
  await writeFile(
    join(root, 'palette', 'theme.css'),
    '@font-face { font-family: SiteTest; font-display: swap; src: url(assets/fonts/remote/presentation.woff2); }\n:root { --rio-font-body: SiteTest, system-ui; }',
  );
  // These server requests inspect the stylesheet without decoding a browser font.
  await writeFile(join(fontDirectory, 'presentation.woff2'), 'fixture');
  return root;
}

describe('published site presentation', () => {
  it.each(['subtle', 'none'] as const)(
    'renders motion %s without inline script, style, or hidden content',
    (motion) => {
      expect(SiteSettings.parse({ ...settings, motion: undefined }).motion).toBe('subtle');
      const configured = SiteSettings.parse({ ...settings, motion });
      const page = InterfacePage.parse({
        id: 'page01',
        name: 'Home',
        blocks: [
          {
            id: 'passage01',
            kind: 'text',
            text: 'A quiet page.',
            place: { x: 0, y: 0, w: 12, h: 1 },
          },
        ],
      });
      const html = renderPage(
        configured,
        page,
        configured.pages[1]!,
        { records: [], filters: [], summaries: {} },
        '/sites/studio',
        'https://site.test',
        {},
      );
      expect(html).toContain(`data-site-motion="${motion}"`);
      expect(html).toContain('id="site-block-passage01"');
      expect(html).not.toMatch(
        /data-site-pending|data-site-reveal-ready|data-site-introduce| hidden|style=|<style|<script>/,
      );
      expect(siteCss(motion)).toContain(
        `@view-transition { navigation: ${motion === 'none' ? 'none' : 'auto'}; }`,
      );
      expect(SiteSettings.safeParse({ ...settings, motion: 'fast' }).success).toBe(false);
    },
  );

  it('holds the compressed script and stylesheet growth budgets', () => {
    // These are the compressed asset sizes before site motion was introduced.
    expect(gzipSync(SITE_SCRIPT).length).toBeLessThanOrEqual(2922 + 2500);
    expect(gzipSync(SITE_CSS).length).toBeLessThanOrEqual(4545 + 2000);
    expect(gzipSync(siteCss('none')).length).toBeLessThanOrEqual(4545 + 2000);
  });

  it.each(['sections', 'cards', 'list'] as const)(
    'enlarges image and looping video covers in %s while retaining file links',
    (display) => {
      const page = InterfacePage.parse({
        id: 'page01',
        name: 'Home',
        blocks: [
          {
            id: 'records01',
            kind: 'records',
            display,
            playback: 'loop',
            enlarge: true,
            coverFieldId: 'fld00000000000002',
            source: { tableId: 'tbl00000000000000', viewId: 'viw00000000000000' },
            place: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      });
      expect(page.blocks[0]).toMatchObject({ enlarge: true });
      const content: SiteContent = {
        filters: [],
        summaries: {},
        records: [
          {
            id: 'records01',
            title: '',
            display,
            fields: [],
            detail: false,
            more: false,
            offset: 0,
            rows: [
              {
                address: 'picture01',
                values: {},
                cover: 'picture',
                coverType: 'image',
                alt: 'Still scene',
                coverSize: { width: 320, height: 180 },
              },
              {
                address: 'video001',
                values: {},
                cover: 'loop',
                coverType: 'video',
                alt: 'Moving scene',
                coverPoster: 'poster',
                coverSize: { width: 320, height: 180 },
              },
            ],
          },
        ],
      };
      const html = render(page, content);
      expect(html.match(/data-site-enlarge /g)).toHaveLength(2);
      expect(html).toContain('href="/sites/studio/media/picture" data-site-enlarge');
      expect(html).toContain('href="/sites/studio/media/loop" data-site-enlarge');
      expect(html).toContain('data-site-close="Close image" aria-label="Enlarge image: Still scene"');
      expect(html).toContain('data-site-close="Close video" aria-label="Enlarge video: Moving scene"');
      expect(html).toMatch(
        /<video[^>]+muted loop data-site-loop[^>]+poster="\/sites\/studio\/media\/poster"[^>]+width="320" height="180"/,
      );
      const ordinary = render(
        InterfacePage.parse({ ...page, blocks: [{ ...page.blocks[0], enlarge: false }] }),
        content,
      );
      expect(ordinary).not.toContain('data-site-enlarge');
      expect(ordinary).toContain('muted loop data-site-loop');
    },
  );

  const render = (
    page: InterfacePage,
    content: SiteContent = { records: [], filters: [], summaries: {} },
    record?: string,
  ) =>
    renderPage(settings, page, settings.pages[1]!, content, '/sites/studio', 'https://site.test', {}, record);

  it('joins matching consecutive rows into full-width bands and leaves mixed rows unbanded', () => {
    const text = (id: string, x: number, y: number, band: string, h = 1) => ({
      id,
      kind: 'text',
      text: id,
      band,
      place: { x, y, w: 6, h },
    });
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        text('quiet01', 0, 0, 'quiet'),
        text('quiet02', 6, 0, 'quiet'),
        text('quiet03', 0, 1, 'quiet'),
        text('quiet04', 6, 1, 'quiet'),
        text('mixed01', 0, 2, 'quiet'),
        text('mixed02', 6, 2, 'accent'),
        text('accent1', 0, 3, 'accent'),
        text('inverse1', 0, 4, 'inverse'),
      ],
    });
    const html = render(page);
    expect(html.match(/class="site-band" data-band="quiet"/g)).toHaveLength(1);
    expect(html.match(/class="site-band" data-band="none"/g)).toHaveLength(1);
    expect(html).toMatch(/data-band="quiet"[\s\S]*quiet01[\s\S]*quiet04[\s\S]*data-band="none"/);
    expect(html).toContain('class="site-banded"');
    const spanning = render(
      InterfacePage.parse({
        ...page,
        blocks: [
          text('spanning', 0, 0, 'quiet', 2),
          text('beside01', 6, 0, 'quiet'),
          text('beside02', 6, 1, 'inverse'),
        ],
      }),
    );
    expect(spanning).not.toContain('class="site-band"');
    const defaults = render(InterfacePage.parse({ ...page, blocks: [text('default1', 0, 0, 'none')] }));
    expect(defaults).not.toContain('class="site-banded"');
  });

  const recordPresentation = (display: 'accordion' | 'sections', showFieldNames = false) => {
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        {
          id: 'records01',
          kind: 'records',
          display,
          showFieldNames,
          playback: 'loop',
          source: { tableId: 'tbl00000000000000', viewId: 'viw00000000000000' },
          fieldIds: ['fld00000000000000', 'fld00000000000001'],
          place: { x: 0, y: 0, w: 12, h: 4 },
        },
      ],
    });
    const content: SiteContent = {
      filters: [],
      summaries: {},
      records: [
        {
          id: 'records01',
          title: '',
          display,
          more: false,
          offset: 0,
          detail: false,
          fields: [
            { id: 'fld00000000000000', name: 'Question' },
            { id: 'fld00000000000001', name: 'Answer' },
          ],
          rows: [
            {
              address: 'first',
              values: { fld00000000000000: 'Why <care>?', fld00000000000001: 'First line.\nSecond line.' },
            },
          ],
        },
      ],
    };
    return { page, content };
  };

  it.each([false, true])(
    'renders native accordion disclosure with field names %s and printable answers',
    (names) => {
      const { page, content } = recordPresentation('accordion', names);
      const html = render(page, content);
      expect(html).toContain(
        '<div class="site-accordion"><details><summary id="site-question-records01-0" aria-controls="site-question-records01-0-answer">',
      );
      expect(html).toContain(
        '</summary></details><div id="site-question-records01-0-answer" class="site-answer" role="region" aria-labelledby="site-question-records01-0">',
      );
      expect(html).toContain('Why &lt;care&gt;?');
      expect(html).toContain('First line.\nSecond line.');
      expect(html.includes('<strong>Question</strong>')).toBe(names);
      expect(html.includes('<strong>Answer</strong>')).toBe(names);
      expect(html).not.toContain('<details open');
      expect(SITE_CSS).toContain(
        '@media screen {\n  .site-accordion > details:not([open]) + .site-answer { display: none }',
      );
    },
  );

  it('gives each accordion answer a unique relationship to its disclosure across rows and blocks', () => {
    const { page, content } = recordPresentation('accordion');
    content.records[0]!.rows.push({ ...content.records[0]!.rows[0]!, address: 'second' });
    page.blocks.push({ ...page.blocks[0]!, id: 'records02', place: { x: 0, y: 4, w: 12, h: 4 } });
    content.records.push({ ...content.records[0]!, id: 'records02' });
    const html = render(page, content);
    const questions = [...html.matchAll(/<summary id="([^"]+)" aria-controls="([^"]+)">/g)];
    expect(questions).toHaveLength(4);
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, question, answer] of questions)
      expect(html).toContain(
        `</details><div id="${answer}" class="site-answer" role="region" aria-labelledby="${question}">`,
      );
  });

  it.each(['accordion', 'sections'] as const)('names an empty %s heading', (display) => {
    const { page, content } = recordPresentation(display);
    content.records[0]!.rows[0]!.values.fld00000000000000 = '  \n  ';
    const html = render(page, content);
    expect(html).toContain(
      display === 'accordion' ? '>Untitled record</summary>' : '<h3>Untitled record</h3>',
    );
  });

  it('renders section headings, paragraphs, safe links, optional pictures, and looping videos', () => {
    const { page, content } = recordPresentation('sections');
    const row = content.records[0]!.rows[0]!;
    row.values.fld00000000000000 = 'Why <care>?\nHere is why.';
    row.link = 'https://example.test/work';
    row.linkLabel = 'Explore <work>';
    row.alt = 'Our <studio>';
    row.cover = 'cover';
    row.coverSize = { width: 960, height: 640 };
    content.records[0]!.rows.push({
      address: 'second',
      values: { fld00000000000000: 'Words alone', fld00000000000001: 'No media.' },
    });
    let html = render(page, content);
    expect(html).toContain('<article class="site-record-section" data-media>');
    expect(html).toContain('<h3>Why &lt;care&gt;?\nHere is why.</h3><p>First line.\nSecond line.</p>');
    expect(html).toContain('alt="Our &lt;studio&gt;" loading="lazy" width="960" height="640"');
    expect(html).toContain(
      'href="https://example.test/work" rel="noopener noreferrer">Explore &lt;work&gt;</a>',
    );
    expect(html).toContain(
      '<article class="site-record-section"><div class="site-section-words"><h3>Words alone</h3>',
    );
    row.linkLabel = '  \n  ';
    expect(render(page, content)).toContain(
      'href="https://example.test/work" rel="noopener noreferrer">Open</a>',
    );
    row.coverType = 'video';
    row.coverPoster = 'poster';
    html = render(page, content);
    expect(html).toMatch(
      /<video[^>]+ muted loop data-site-loop[^>]* poster="\/sites\/studio\/media\/poster"/,
    );
  });

  it.each([
    '',
    'javascript:alert(1)',
    'data:text/html,hostile',
    'https://example.test/ bad',
    'https://example.test/\n',
  ])('omits unsafe or empty section links %j', (link) => {
    const { page, content } = recordPresentation('sections');
    content.records[0]!.rows[0]!.link = link;
    const html = render(page, content);
    expect(html).not.toContain('class="site-button"');
  });

  it('keeps default controls, marks muted inline loops, and makes enlarged images readable without scripts', () => {
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        { id: 'default1', kind: 'media', mediaType: 'video', place: { x: 0, y: 0, w: 12, h: 1 } },
        {
          id: 'looping1',
          kind: 'media',
          mediaType: 'video',
          playback: 'loop',
          place: { x: 0, y: 1, w: 12, h: 1 },
        },
        {
          id: 'hero001',
          kind: 'hero',
          mediaType: 'video',
          playback: 'loop',
          place: { x: 0, y: 2, w: 12, h: 1 },
        },
        { id: 'enlarge1', kind: 'media', enlarge: true, alt: 'Studio', place: { x: 0, y: 3, w: 12, h: 1 } },
      ],
    });
    const html = render(page, {
      records: [],
      filters: [],
      summaries: {},
      media: {
        default1: { path: 'default', kind: 'video' },
        looping1: { path: 'loop', kind: 'video', poster: 'poster' },
        hero001: { path: 'hero', kind: 'video' },
        enlarge1: { path: 'picture', size: { width: 320, height: 240 } },
      },
    });
    const videos = html.match(/<video[^>]+>/g)!;
    expect(videos).toHaveLength(3);
    expect(videos[0]).toContain(' controls preload="metadata" playsinline');
    expect(videos[0]).not.toContain('muted');
    for (const video of videos.slice(1)) {
      expect(video).toContain('muted loop data-site-loop');
      expect(video).not.toContain('autoplay');
    }
    expect(html).toContain('href="/sites/studio/media/picture" data-site-enlarge');
    expect(html).toContain('data-site-close="Close image" aria-label="Enlarge image: Studio"');
    expect(html).not.toMatch(/onclick=|style=/);
  });

  it.each([
    [false, 'subtle'],
    [true, 'subtle'],
    [false, 'none'],
  ] as const)('respects reduced motion %s with motion %s and always enforces mute', (reduced, motion) => {
    const still = reduced || motion === 'none';
    const events = new Map<string, () => void>();
    const attributes = new Set<string>(['data-site-loop']);
    const video = {
      muted: false,
      volume: 1,
      controls: true,
      autoplay: false,
      currentTime: 5,
      pause: vi.fn(),
      play: vi.fn(() => Promise.resolve()),
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string) => attributes.add(name),
      addEventListener: (name: string, listener: () => void) => events.set(name, listener),
    };
    runInNewContext(SITE_SCRIPT, {
      document: {
        documentElement: { lang: 'en-US', dataset: { siteMotion: motion }, removeAttribute: () => undefined },
        querySelector: () => null,
        querySelectorAll: (query: string) =>
          query === 'video' || query === 'video[data-site-loop]' ? [video] : [],
        addEventListener: () => undefined,
      },
      matchMedia: () => ({ matches: reduced, addEventListener: () => undefined }),
      window: { addEventListener: () => undefined },
    });
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
    expect(video.controls).toBe(still);
    expect(video.autoplay).toBe(!still);
    expect(video.play).toHaveBeenCalledTimes(still ? 0 : 1);
    expect(video.pause).toHaveBeenCalledTimes(still ? 1 : 0);
    if (still) expect(video.currentTime).toBe(0);
    video.muted = false;
    video.volume = 1;
    events.get('volumechange')!();
    expect(video.muted).toBe(true);
    expect(video.volume).toBe(0);
  });

  it.each([
    [3, false, 'subtle', true],
    [3, false, 'subtle', false],
    [2, false, 'subtle', true],
    [4, false, 'subtle', true],
    [3, true, 'subtle', true],
    [3, false, 'none', true],
  ] as const)(
    'handles media error %s with one reload at most, reduced motion %s and motion %s and loop %s',
    (code, reduced, motion, looping) => {
      const attributes = new Map<string, string>(looping ? [['data-site-loop', '']] : []);
      const events = new Map<string, () => void>();
      const changes: Array<() => void> = [];
      const video = {
        muted: false,
        volume: 1,
        controls: true,
        autoplay: false,
        loop: looping,
        currentTime: 0,
        duration: 1.008,
        paused: true,
        isConnected: true,
        error: null as { code: number; message: string } | null,
        pause: vi.fn(() => {
          video.paused = true;
        }),
        play: vi.fn(() => {
          video.paused = false;
          return Promise.resolve();
        }),
        load: vi.fn(() => {
          video.error = null;
          video.paused = true;
          video.currentTime = 0;
          video.muted = false;
          video.volume = 1;
          video.loop = false;
        }),
        hasAttribute: (name: string) => attributes.has(name),
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
        addEventListener: (name: string, handler: () => void) => events.set(name, handler),
      };
      runInNewContext(SITE_SCRIPT, {
        document: {
          documentElement: { lang: 'en-US', dataset: { siteMotion: motion }, removeAttribute: vi.fn() },
          querySelector: () => null,
          querySelectorAll: (query: string) =>
            query === 'video' || query === 'video[data-site-loop]' ? [video] : [],
          addEventListener: vi.fn(),
        },
        matchMedia: () => ({
          matches: reduced,
          addEventListener: (_name: string, handler: () => void) => changes.push(handler),
        }),
        window: { addEventListener: vi.fn() },
      });
      const still = reduced || motion === 'none';
      video.currentTime = looping ? 0.5 : video.duration;
      if (!looping) {
        video.paused = false;
        video.volume = 0.25;
      }
      video.error = { code, message: 'Could not demultiplex stream' };
      events.get('error')?.();
      if (code === 4) {
        expect(video.load).not.toHaveBeenCalled();
        expect(video.controls).toBe(true);
        expect(video.autoplay).toBe(false);
        video.error = { code: 3, message: 'A later fault' };
        events.get('error')?.();
        expect(video.load).not.toHaveBeenCalled();
        return;
      }
      expect(video.load).toHaveBeenCalledTimes(1);
      expect(JSON.parse(attributes.get('data-site-media-recovery')!)).toEqual({
        code,
        message: 'Could not demultiplex stream',
      });
      expect(video.muted).toBe(looping);
      expect(video.volume).toBe(looping ? 0 : 0.25);
      expect(video.loop).toBe(looping);
      events.get('loadeddata')!();
      expect(video.error).toBeNull();
      expect(video.currentTime).toBe(still ? 0 : looping ? 0.5 : video.duration);
      expect(video.paused).toBe(still);
      expect(video.controls).toBe(still || !looping);
      expect(video.autoplay).toBe(!still && looping);
      expect(attributes.has('data-site-media-recovered')).toBe(true);
      video.error = { code, message: 'Another native fault' };
      events.get('error')?.();
      expect(video.load).toHaveBeenCalledTimes(1);
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.paused).toBe(true);
      for (const change of changes) change();
      expect(video.load).toHaveBeenCalledTimes(1);
      expect(video.autoplay).toBe(false);
      expect(video.paused).toBe(true);
    },
  );

  it.each([
    ['a midpoint', 0.5, false, false, 0.5, false],
    ['the loop boundary', 1.008, false, false, 0, false],
    ['a motion change', 0.5, true, false, 0, false],
    ['a closed dialog', 0.5, false, true, 0, false],
    ['an early decode error', 0.5, false, false, 0.5, true],
  ] as const)(
    'defers an enlarged loop seek for %s and recovers only once',
    (_name, position, reduce, closed, expected, early) => {
      type Handler = (event?: unknown) => void;
      class ElementFixture {}
      class VideoFixture extends ElementFixture {
        muted = false;
        volume = 1;
        loop = true;
        error: { code: number; message: string } | null = null;
        load = vi.fn(() => {
          this.error = null;
          this.position = 0;
        });
        controls = true;
        autoplay = false;
        paused = true;
        duration = Number.NaN;
        isConnected = false;
        position = 0;
        attributes = new Set(['data-site-loop']);
        events = new Map<string, Handler>();
        seek = vi.fn((time: number) => {
          this.position = time;
        });
        get currentTime() {
          return this.position;
        }
        set currentTime(time: number) {
          this.seek(time);
        }
        pause() {
          this.paused = true;
        }
        play() {
          this.paused = false;
          return Promise.resolve();
        }
        hasAttribute(name: string) {
          return this.attributes.has(name);
        }
        setAttribute(name: string) {
          this.attributes.add(name);
        }
        removeAttribute(name: string) {
          this.attributes.delete(name);
        }
        addEventListener(name: string, handler: Handler) {
          const previous = this.events.get(name);
          this.events.set(name, (event) => {
            previous?.(event);
            handler(event);
          });
        }
        cloneNode(): VideoFixture {
          picture.attributes = new Set(this.attributes);
          return picture;
        }
      }
      const source = new VideoFixture();
      source.position = position;
      source.duration = 1.008;
      source.isConnected = true;
      source.attributes.add('data-site-media-recovery');
      source.attributes.add('data-site-media-recovered');
      const picture = new VideoFixture();
      const clicks: Handler[] = [];
      const changes: Handler[] = [];
      const media = {
        matches: false,
        addEventListener: (_event: string, handler: Handler) => changes.push(handler),
      };
      const dialogEvents = new Map<string, Handler>();
      const dialog = {
        setAttribute: vi.fn(),
        hasAttribute: () => false,
        append: vi.fn(),
        showModal: vi.fn(),
        addEventListener: (name: string, handler: Handler) => dialogEvents.set(name, handler),
        remove: () => {
          picture.isConnected = false;
        },
      };
      const close = { addEventListener: vi.fn(), focus: vi.fn() };
      const link = Object.assign(new ElementFixture(), {
        href: 'https://site.test/movie.webm',
        getAttribute: (name: string) => (name === 'aria-label' ? 'Enlarge video' : 'Close video'),
        closest: (selector: string): unknown =>
          selector === '.site-enlarge-video'
            ? { querySelector: () => source }
            : ['a[href]', 'a[data-site-enlarge]'].includes(selector)
              ? link
              : null,
        focus: vi.fn(),
      });
      runInNewContext(SITE_SCRIPT, {
        document: {
          documentElement: { lang: 'en-US', dataset: { siteMotion: 'subtle' }, removeAttribute: vi.fn() },
          body: {
            append: () => {
              picture.isConnected = true;
            },
          },
          querySelector: () => null,
          querySelectorAll: (query: string) =>
            query === 'video' || query === 'video[data-site-loop]'
              ? [source, ...(picture.isConnected ? [picture] : [])]
              : [],
          createElement: (tag: string) => (tag === 'dialog' ? dialog : close),
          addEventListener: (name: string, handler: Handler) => {
            if (name === 'click') clicks.push(handler);
          },
        },
        Element: ElementFixture,
        HTMLVideoElement: VideoFixture,
        URL,
        location: { origin: 'https://site.test', pathname: '/sites/studio', search: '' },
        matchMedia: () => media,
        window: { addEventListener: vi.fn() },
      });
      for (const click of clicks) click({ target: link, button: 0, preventDefault: vi.fn() });
      expect(picture.seek).not.toHaveBeenCalled();
      expect(picture.hasAttribute('data-site-media-recovery')).toBe(false);
      expect(picture.hasAttribute('data-site-media-recovered')).toBe(false);
      picture.duration = source.duration;
      picture.events.get('loadedmetadata')?.();
      expect(picture.seek).not.toHaveBeenCalled();
      if (reduce) {
        media.matches = true;
        for (const change of changes) change();
      }
      if (closed) dialogEvents.get('close')!();
      if (early) {
        picture.error = { code: 3, message: 'Could not demultiplex stream' };
        picture.events.get('error')?.();
        expect(picture.load).toHaveBeenCalledTimes(1);
      }
      picture.events.get('loadeddata')!();
      expect(picture.currentTime).toBe(expected);
      expect(picture.muted).toBe(true);
      expect(picture.volume).toBe(0);
      if (reduce) expect(picture.paused).toBe(true);
      if (!closed) {
        if (!early) {
          picture.error = { code: 3, message: 'Could not demultiplex stream' };
          picture.events.get('error')?.();
          expect(picture.load).toHaveBeenCalledTimes(1);
          picture.events.get('loadeddata')!();
        }
        expect(picture.currentTime).toBe(expected);
        expect(picture.hasAttribute('data-site-media-recovered')).toBe(true);
        expect(picture.paused).toBe(reduce);
        expect(picture.muted).toBe(true);
        expect(picture.volume).toBe(0);
        expect(picture.loop).toBe(true);
        picture.error = { code: 3, message: 'Still unreadable' };
        picture.events.get('error')?.();
        expect(picture.load).toHaveBeenCalledTimes(1);
        expect(picture.controls).toBe(true);
        expect(picture.autoplay).toBe(false);
        expect(picture.paused).toBe(true);
      }
    },
  );

  it('uses the first hero heading as the only page heading while preserving the title and navigation', () => {
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        { id: 'later01', kind: 'hero', heading: 'Later hero', place: { x: 6, y: 0, w: 6, h: 2 } },
        { id: 'below01', kind: 'text', text: 'Below', place: { x: 0, y: 2, w: 12, h: 1 } },
        { id: 'first01', kind: 'hero', heading: 'Welcome <home>', place: { x: 0, y: 0, w: 6, h: 2 } },
      ],
    });
    const html = render(page);
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<h1>Welcome &lt;home&gt;</h1>');
    expect(html).not.toContain('<h1>Home</h1>');
    expect(html).toContain('<h2>Later hero</h2>');
    expect(html).toContain('<title>Home</title>');
    expect(html).toContain('aria-current="page">Home</a>');
    const detail = render(page, undefined, 'record01');
    expect(detail.match(/<h1>/g)).toHaveLength(1);
    expect(detail).toContain('<h1>Home</h1>');
  });

  it.each(['empty', 'blank hero', 'later hero'])(
    'keeps the page title as its only h1 with an %s opening',
    (opening) => {
      const page = InterfacePage.parse({
        id: 'page01',
        name: 'Home',
        blocks:
          opening === 'empty'
            ? []
            : [
                {
                  id: 'first01',
                  kind: opening === 'blank hero' ? 'hero' : 'text',
                  text: 'Opening',
                  place: { x: 0, y: 0, w: 12, h: 2 },
                },
                { id: 'later01', kind: 'hero', heading: 'Later hero', place: { x: 0, y: 2, w: 12, h: 2 } },
              ],
      });
      const html = render(page);
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html).toContain('<h1>Home</h1>');
      if (opening !== 'empty') expect(html).toContain('<h2>Later hero</h2>');
    },
  );

  it.each(['list', 'cards', 'table'] as const)(
    'can hide field names in %s without changing table headings or the default',
    (display) => {
      const input = {
        id: 'page01',
        name: 'Home',
        blocks: [
          {
            id: 'records01',
            kind: 'records',
            source: { tableId: 'tbl00000000000000', viewId: 'viw00000000000000' },
            fieldIds: ['fld00000000000000', 'fld00000000000001', 'fld00000000000002'],
            display,
            place: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      };
      const content: SiteContent = {
        filters: [],
        summaries: {},
        records: [
          {
            id: 'records01',
            title: '',
            display,
            fields: [
              { id: 'fld00000000000000', name: 'Name' },
              { id: 'fld00000000000001', name: 'Summary' },
              { id: 'fld00000000000002', name: 'Empty' },
            ],
            rows: [
              {
                address: 'record01',
                values: {
                  fld00000000000000: 'First <record>',
                  fld00000000000001: 'Useful details',
                  fld00000000000002: '',
                },
              },
              {
                address: 'record02',
                values: { fld00000000000000: 'Second record', fld00000000000001: '', fld00000000000002: '' },
              },
            ],
            more: false,
            offset: 0,
            detail: false,
          },
        ],
      };
      const defaultHtml = render(InterfacePage.parse(input), content);
      expect(defaultHtml).toContain(display === 'table' ? '<th scope="col">Name</th>' : '<dt>Name</dt>');
      const html = render(
        InterfacePage.parse({ ...input, blocks: [{ ...input.blocks[0], showFieldNames: false }] }),
        content,
      );
      if (display === 'table') {
        expect(html).toContain('<th scope="col">Name</th>');
        expect(html).toContain('<th scope="col">Summary</th>');
        expect(html).not.toContain('<h3>');
      } else {
        expect(html.match(/<h3>/g)).toHaveLength(2);
        expect(html).toContain('<h3>First &lt;record&gt;</h3><p>Useful details</p>');
        expect(html).toContain('<h3>Second record</h3></div>');
        expect(html).not.toMatch(/<dt>|<dd>|<dl>|<p><\/p>/);
        expect(html).not.toContain('Summary');
      }
    },
  );

  it('gives hero and media pictures a theme border and radius inside their existing boxes', () => {
    const reference = {
      tableId: 'tbl00000000000000',
      fieldId: 'fld00000000000000',
      recordId: 'rec00000000000000',
      attachmentId: 'att00000000000000',
    };
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        {
          id: 'hero001',
          kind: 'hero',
          heading: 'Studio',
          image: reference,
          place: { x: 0, y: 0, w: 12, h: 1 },
        },
        { id: 'image01', kind: 'media', attachment: reference, place: { x: 0, y: 1, w: 12, h: 1 } },
        {
          id: 'video01',
          kind: 'media',
          mediaType: 'video',
          attachment: reference,
          place: { x: 0, y: 2, w: 12, h: 1 },
        },
        {
          id: 'cards01',
          kind: 'records',
          source: { tableId: reference.tableId, viewId: 'viw00000000000000' },
          display: 'cards',
          place: { x: 0, y: 3, w: 12, h: 1 },
        },
      ],
    });
    const html = render(page, {
      filters: [],
      summaries: {},
      media: { hero001: { path: 'hero' }, image01: { path: 'image' }, video01: { path: 'video' } },
      records: [
        {
          id: 'cards01',
          title: '',
          fields: [],
          display: 'cards',
          detail: false,
          more: false,
          offset: 0,
          rows: [{ address: 'record01', values: {}, cover: 'cover' }],
        },
      ],
    });
    expect(html.match(/class="site-picture"/g)).toHaveLength(2);
    expect(html).toContain('class="site-picture"><img src="/sites/studio/media/hero"');
    expect(html).toContain('class="site-picture"><img src="/sites/studio/media/image"');
    expect(html).toContain('<figure><video');
    expect(html).toContain('<article><img class="site-cover"');
    const edge = /\.site-picture::after\s*\{([^}]+)\}/.exec(SITE_CSS)?.[1];
    expect(edge).toMatch(/border:\s*1px solid var\(--rio-border\)/);
    expect(edge).toMatch(/border-radius:\s*var\(--rio-radius\)/);
    expect(edge).toMatch(/position:\s*absolute/);
  });

  it('keeps page order, marks the current page, uses a logo, and offers native phone navigation', () => {
    const html = documentHtml(
      settings,
      '/sites/studio',
      'https://site.test',
      'Home',
      '',
      '/sites/studio/home',
      '',
      'home',
    );
    expect(html.indexOf('/sites/studio/about')).toBeLessThan(html.indexOf('href="/sites/studio/home"'));
    expect(html).toContain('href="/sites/studio/home" aria-current="page"');
    expect(html).toContain('<details class="site-nav"><summary');
    expect(html).toContain('src="/sites/studio/media/logo" alt="Studio"');
    expect(html).toContain('<footer class="site-footer"><p>Made with care.</p>');
    expect(SITE_CSS).toContain('.site-nav:not([open]) nav { display: none }');
    // A wide logo keeps its shape and stays a line tall, so the phone header holds it beside the menu.
    const logo = /\.site-brand img\s*\{([^}]+)\}/.exec(SITE_CSS)?.[1];
    expect(logo).toContain('max-height: 3rem');
    expect(logo).toContain('width: auto');
    expect(logo).toContain('height: auto');
  });

  it.each([
    { width: 960, height: 640 },
    { width: 320, height: 480 },
    { width: 1200, height: 100 },
  ])('reserves the logo dimensions before it loads for a $width by $height image', (size) => {
    const html = documentHtml(
      settings,
      '/sites/studio',
      'https://site.test',
      'Home',
      '',
      '/sites/studio/home',
      '',
      'home',
      true,
      size,
    );
    expect(html).toContain(
      `<span class="site-logo"><svg width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}" aria-hidden="true" focusable="false"></svg><img src="/sites/studio/media/logo" alt="Studio" width="${size.width}" height="${size.height}"></span>`,
    );
    expect(html).not.toContain('style=');
    const frame = /\.site-logo\s*\{([^}]+)\}/.exec(SITE_CSS)?.[1];
    expect(frame).toContain('position: relative');
    expect(frame).toContain('max-width: min(18rem, 100%)');
    const reserve = /\.site-logo > svg\s*\{([^}]+)\}/.exec(SITE_CSS)?.[1];
    expect(reserve).toContain('max-height: 3rem');
    expect(reserve).toContain('max-width: 100%');
    expect(reserve).toContain('visibility: hidden');
    const image = /\.site-logo > img\s*\{([^}]+)\}/.exec(SITE_CSS)?.[1];
    expect(image).toContain('position: absolute');
    expect(image).toContain('width: 100%');
    expect(image).toContain('height: 100%');
    expect(image).toContain('object-fit: contain');
  });

  it('uses optional fonts when available and system fallbacks when the asset bundle is absent', async () => {
    const root = await presentationTheme();
    try {
      const available = await readSiteTheme(root, 'palette');
      expect(available).toContain('font-display: optional;');
      expect(available).not.toContain('font-display: swap;');
      expect(available).toContain('url(/themes/palette/assets/fonts/remote/presentation.woff2)');
      await rm(join(root, 'palette', 'assets'), { recursive: true });
      const fallback = await readSiteTheme(root, 'palette');
      expect(fallback).not.toContain('@font-face');
      expect(fallback).not.toContain('url(');
      expect(fallback).toContain('--rio-font-body: SiteTest, system-ui;');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves grid positions at wide widths and DOM reading order when blocks stack', () => {
    const page = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        { id: 'right01', kind: 'text', text: 'Right', place: { x: 6, y: 0, w: 6, h: 2 } },
        { id: 'below01', kind: 'text', text: 'Below', place: { x: 0, y: 2, w: 12, h: 1 } },
        { id: 'left001', kind: 'text', text: 'Left', place: { x: 0, y: 0, w: 6, h: 2 } },
      ],
    });
    const html = renderPage(
      settings,
      page,
      settings.pages[1]!,
      { records: [], filters: [], summaries: {} },
      '/sites/studio',
      'https://site.test',
      {},
    );
    expect(html.indexOf('data-block="left001"')).toBeLessThan(html.indexOf('data-block="right01"'));
    expect(html.indexOf('data-block="right01"')).toBeLessThan(html.indexOf('data-block="below01"'));
    expect(html).toContain('site-x-6 site-w-6 site-row-1 site-span-1');
    expect(html).toContain('site-x-0 site-w-12 site-row-2 site-span-1');
    expect(html).not.toContain('style=');
    expect(SITE_CSS).toContain('@media (min-width: 48rem)');
    expect(SITE_CSS).toContain('.site-x-6 { grid-column-start: 7 }');
  });

  it('defaults to no header button and title labels for every published page', () => {
    expect(settings.headerButton).toBeNull();
    expect(settings.footerFormat).toBe('plain');
    expect(settings.pages.every((page) => page.showInNav && page.navLabel === undefined)).toBe(true);
    const html = render(InterfacePage.parse({ id: 'page01', name: 'Home', blocks: [] }));
    expect(html).not.toContain('site-header-with-button');
    expect(html).toContain('aria-current="page">Home</a>');
    expect(html).toContain('<footer class="site-footer"><p>Made with care.</p>');
  });

  it('puts one safely escaped primary button after both navigation controls', () => {
    const custom = SiteSettings.parse({
      ...settings,
      headerButton: {
        label: '<img src=x onerror=alert(1)> "Join"',
        action: { kind: 'url', url: 'https://elsewhere.test/?a=1&b=2' },
      },
    });
    const html = documentHtml(
      custom,
      '/sites/studio',
      'https://site.test',
      'Home',
      '',
      '/sites/studio/home',
      '',
      'home',
    );
    const header = /<header\b[\s\S]*?<\/header>/.exec(html)![0];
    expect(header.match(/class="site-button"/g)).toHaveLength(1);
    expect(header).toContain('href="https://elsewhere.test/?a=1&amp;b=2" rel="noopener noreferrer"');
    expect(header).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;Join&quot;</a>');
    expect(header).not.toContain('<img src=x');
    expect(header.indexOf('</details>')).toBeLessThan(header.indexOf('class="site-button"'));
  });

  it('rejects unsafe header addresses in settings and refuses them in stored content', () => {
    const headerButton = { label: 'Unsafe', action: { kind: 'url', url: 'javascript:alert(1)' } };
    expect(SiteSettings.safeParse({ ...settings, headerButton }).success).toBe(false);
    const custom = SiteSettings.parse({
      ...settings,
      headerButton: { ...headerButton, action: { kind: 'url', url: 'https://elsewhere.test/' } },
    });
    custom.headerButton!.action = { kind: 'url', url: headerButton.action.url };
    const html = documentHtml(
      custom,
      '/sites/studio',
      'https://site.test',
      'Home',
      '',
      '/sites/studio/home',
      '',
      'home',
    );
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('site-header-with-button');
    expect(html).not.toContain('>Unsafe</a>');
  });

  it('links header page actions only while their destination is published', () => {
    const custom = SiteSettings.parse({
      ...settings,
      headerButton: { label: 'Visit us', action: { kind: 'page', pageId: 'page02' } },
    });
    const html = () =>
      documentHtml(
        custom,
        '/sites/studio',
        'https://site.test',
        'Home',
        '',
        '/sites/studio/home',
        '',
        'home',
      );
    expect(html()).toContain('<a class="site-button" href="/sites/studio/about">Visit us</a>');
    custom.pages = custom.pages.filter((page) => page.pageId !== 'page02');
    expect(html()).not.toContain('>Visit us</a>');
    expect(html()).not.toContain('site-header-with-button');
  });

  it('uses escaped navigation labels in both menus without changing headings or document titles', () => {
    const custom = SiteSettings.parse({
      ...settings,
      pages: [
        settings.pages[0],
        { ...settings.pages[1], title: 'Welcome to our studio', navLabel: 'Home <script>alert(1)</script>' },
      ],
    });
    const html = renderPage(
      custom,
      InterfacePage.parse({ id: 'page01', name: 'Home', blocks: [] }),
      custom.pages[1]!,
      { records: [], filters: [], summaries: {} },
      '/sites/studio',
      'https://site.test',
      {},
    );
    expect(
      html.match(/aria-current="page">Home &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/a>/g),
    ).toHaveLength(2);
    expect(html).toContain('<h1>Welcome to our studio</h1>');
    expect(html).toContain('<title>Welcome to our studio</title>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('leaves hidden pages published and available to header, hero, and Markdown links', () => {
    const custom = SiteSettings.parse({
      ...settings,
      pages: [{ ...settings.pages[0], showInNav: false }, settings.pages[1]],
      headerButton: { label: 'Visit us', action: { kind: 'page', pageId: 'page02' } },
      footer: '[About us](about)',
      footerFormat: 'markdown',
    });
    const home = InterfacePage.parse({
      id: 'page01',
      name: 'Home',
      blocks: [
        {
          id: 'hero001',
          kind: 'hero',
          heading: 'Welcome',
          buttons: [{ label: 'Explore', action: { kind: 'page', pageId: 'page02' } }],
          place: { x: 0, y: 0, w: 12, h: 2 },
        },
      ],
    });
    const html = renderPage(
      custom,
      home,
      custom.pages[1]!,
      { records: [], filters: [], summaries: {} },
      '/sites/studio',
      'https://site.test',
      {},
    );
    for (const nav of html.match(/<nav\b[\s\S]*?<\/nav>/g)!) {
      expect(nav).not.toContain('/sites/studio/about');
      expect(nav).toContain('aria-current="page">Home</a>');
    }
    expect(html).toContain('href="/sites/studio/about">Visit us</a>');
    expect(html).toContain('href="/sites/studio/about">Explore</a>');
    expect(html).toContain('href="/sites/studio/about">About us</a>');
    const hidden = renderPage(
      custom,
      InterfacePage.parse({ id: 'page02', name: 'About', blocks: [] }),
      custom.pages[0]!,
      { records: [], filters: [], summaries: {} },
      '/sites/studio',
      'https://site.test',
      {},
    );
    expect(hidden).toContain('<h1>About</h1>');
    expect(hidden).toContain('<link rel="canonical" href="https://site.test/sites/studio/about">');
  });

  it('renders the safe paragraph Markdown subset in the footer and keeps its length limit', () => {
    const custom = SiteSettings.parse({
      ...settings,
      footerFormat: 'markdown',
      footer:
        '**Care** and *craft*.\nNext line.\n\n- [About](about)\n- [Partner](https://elsewhere.test/)\n\n1. First\n2. Second\n\n[Unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>',
    });
    const html = documentHtml(
      custom,
      '/sites/studio',
      'https://site.test',
      'Home',
      '',
      '/sites/studio/home',
      '',
      'home',
    );
    const footer = /<footer\b[\s\S]*?<\/footer>/.exec(html)![0];
    expect(footer).toContain('<p><strong>Care</strong> and <em>craft</em>.<br>Next line.</p>');
    expect(footer).toContain('<ul><li><a href="/sites/studio/about">About</a></li>');
    expect(footer).toContain('href="https://elsewhere.test/" rel="noopener noreferrer"');
    expect(footer).toContain('<ol start="1"><li>First</li><li>Second</li></ol>');
    expect(footer).toContain('Unsafe &lt;img src=x onerror=alert(1)&gt;');
    expect(footer).not.toMatch(/javascript:|<img|target=/);
    expect(SiteSettings.safeParse({ ...settings, footer: 'x'.repeat(500) }).success).toBe(true);
    expect(SiteSettings.safeParse({ ...settings, footer: 'x'.repeat(501) }).success).toBe(false);
  });

  it.each(['stored', 'parsed', 'plain'] as const)(
    'preserves literal legacy footer content with %s settings',
    (format) => {
      const legacy = {
        ...settings,
        footer: 'Support *our* work.  [Terms](https://example.com/terms)\n- Care <br>',
      };
      Reflect.deleteProperty(legacy, 'footerFormat');
      const custom =
        format === 'stored'
          ? legacy
          : SiteSettings.parse({ ...legacy, ...(format === 'plain' ? { footerFormat: 'plain' } : {}) });
      const html = documentHtml(
        custom,
        '/sites/studio',
        'https://site.test',
        'Home',
        '',
        '/sites/studio/home',
        '',
        'home',
      );
      expect(/<footer\b[\s\S]*?<\/footer>/.exec(html)![0]).toBe(
        '<footer class="site-footer"><p>Support *our* work.  [Terms](https://example.com/terms)\n- Care &lt;br&gt;</p></footer>',
      );
    },
  );

  it('renders the formatting subset, blocks HTML and unsafe links, and keeps site links in the same tab', () => {
    const html = markdownHtml(
      'Opening **strong** and *emphasis*.\nNext line.\n\n- First\n- Second\n\n3. Third\n4. Fourth\n\n[About](about) [Away](https://elsewhere.test/) [bad](javascript:alert(1)) [bad](data:text/html,x) <img onerror=bad()>',
      settings,
      '/sites/studio',
      'https://site.test',
      'home',
    );
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<em>emphasis</em>');
    expect(html).toContain('<br>');
    expect(html).toContain('<ul><li>First</li><li>Second</li></ul>');
    expect(html).toContain('<ol start="3">');
    expect(html).toContain('<a href="/sites/studio/about">About</a>');
    expect(html).toContain('href="https://elsewhere.test/" rel="noopener noreferrer"');
    expect(html).not.toContain('target=');
    expect(html).not.toMatch(/href="(?:javascript|data):|<img/);
    expect(
      markdownHtml(
        'Opening **studio**\n\n- First',
        settings,
        '/sites/studio',
        'https://site.test',
        'home',
        true,
      ),
    ).toBe('<h2>Opening <strong>studio</strong></h2><ul><li>First</li></ul>');
  });

  it.each(['bar', 'column', 'line', 'donut'])(
    'draws %s with zero, negative, missing, and very large values',
    (kind) => {
      const data: Extract<TileData, { kind: 'chart' }> = {
        kind: 'chart',
        truncated: false,
        categories: [
          { key: 'zero', label: 'Zero' },
          { key: 'negative', label: '<script>bad()</script>' },
          { key: 'missing', label: 'Missing' },
          { key: 'large', label: 'Large' },
        ],
        series: [{ key: 'values', label: 'Values', values: [0, -5, null, Number.MAX_VALUE] }],
      };
      const svg = chartSvg(chart(kind), data);
      expect(svg).toContain('<svg');
      expect(svg).not.toMatch(/NaN|Infinity|<script|style=/);
      expect(svg).toContain('aria-hidden="true"');
      expect(
        chartSvg(chart(kind), { ...data, series: [{ ...data.series[0]!, values: [0, 0, null, 0] }] }),
      ).not.toMatch(/NaN|Infinity/);
      expect(chartSvg(chart(kind), { ...data, categories: [], series: [] })).not.toMatch(/NaN|Infinity/);
    },
  );

  it('keeps negative stacks separate and breaks a line at missing values', () => {
    const data: Extract<TileData, { kind: 'chart' }> = {
      kind: 'chart',
      truncated: false,
      categories: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      series: [
        { key: 'one', label: 'One', values: [5, null, -3] },
        { key: 'two', label: 'Two', values: [-2, 0, 4] },
      ],
    };
    const stacked = chartSvg({ ...chart('column'), stacked: true }, data);
    expect(stacked.match(/<rect/g)).toHaveLength(5);
    expect(stacked).not.toMatch(/height="-/);
    const line = chartSvg(chart('line'), { ...data, series: [data.series[0]!] });
    expect(line).toMatch(/d="M[\d.]+ [\d.]+M[\d.]+ [\d.]+"/);
  });

  it.each([
    ['bytes=0-2', { start: 0, end: 2 }],
    ['bytes=7-', { start: 7, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }],
    ['bytes=0-99', { start: 0, end: 9 }],
    ['bytes=-99', { start: 0, end: 9 }],
    ['bytes=20-', null],
    ['bytes=9-1', null],
    ['bytes=-0', null],
    ['bytes=0-1,3-4', null],
    ['bytes=9007199254740992-', null],
  ] as const)('checks media range %s', (header, range) => {
    expect(mediaRange(header, 10)).toEqual(range);
    expect(mediaRange(header, 0)).toBeNull();
  });
});

describe('published picture dimensions', () => {
  let kit: TestPostgres;
  let server: ServerFixture;
  let themeRoot: string;

  beforeAll(async () => {
    themeRoot = await presentationTheme();
    kit = await startTestPostgres();
    server = await startServer(kit, 'sitepictures', { themesDir: themeRoot });
  });
  afterAll(async () => {
    await server?.close();
    await kit?.stop();
    if (themeRoot) await rm(themeRoot, { recursive: true, force: true });
  });

  it('uses display values for selected and auxiliary section fields, including people and linked records', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const viewId = newId('view');
    const teams = newId('table');
    const heading = newId('field');
    const person = newId('field');
    const creator = newId('field');
    const editor = newId('field');
    const relation = newId('field');
    const teamName = newId('field');
    const address = newId('field');
    const lookup = newId('field');
    const recordId = newId('record');
    const teamId = newId('record');
    const interfaceId = newId('interface');
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: DatabaseCreate.parse({
        id: databaseId,
        name: 'Section names',
        table: {
          id: tableId,
          name: 'Scenes',
          fields: [
            { id: heading, name: 'Heading', type: 'text' },
            { id: person, name: 'Owner', type: 'user' },
            { id: creator, name: 'Creator', type: 'createdBy' },
            { id: editor, name: 'Editor', type: 'lastModifiedBy' },
          ],
          view: { id: viewId, name: 'Scenes' },
        },
      }),
    });
    expect(created.statusCode, created.body).toBe(200);
    const run = async (inputs: unknown[]) => {
      const response = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: inputs.map((input) =>
            Command.parse({
              id: newId('command'),
              groupId: newId('action'),
              ...(input as object),
            }),
          ),
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        response.json<{ results: Array<{ status: string }> }>().results.map((result) => result.status),
      ).toEqual(inputs.map(() => 'applied'));
    };
    await run([
      {
        kind: 'table.create',
        table: {
          id: teams,
          name: 'Teams',
          fields: [
            { id: teamName, name: 'Name', type: 'text' },
            { id: address, name: 'Address', type: 'url' },
          ],
          view: { id: newId('view'), name: 'Teams' },
        },
      },
    ]);
    await run([
      {
        kind: 'field.create',
        tableId,
        field: { id: relation, name: 'Team', type: 'link', options: { linkedTableId: teams } },
      },
    ]);
    await run([
      {
        kind: 'field.create',
        tableId,
        field: {
          id: lookup,
          name: 'Address',
          type: 'lookup',
          options: { linkFieldId: relation, targetFieldId: address },
        },
      },
    ]);
    await run([
      {
        kind: 'record.create',
        tableId: teams,
        records: [
          { id: teamId, values: { [teamName]: 'Studio team', [address]: 'https://example.test/work' } },
        ],
      },
      {
        kind: 'record.create',
        tableId,
        records: [
          {
            id: recordId,
            values: { [heading]: 'Scene', [person]: [server.owner.userId], [relation]: [teamId] },
          },
        ],
      },
    ]);
    await run([
      {
        kind: 'interface.create',
        interface: {
          id: interfaceId,
          name: 'Scenes',
          pages: [
            {
              id: 'page01',
              name: 'Home',
              blocks: [person, creator, editor].flatMap((label, index) =>
                [false, true].map((selected) => ({
                  id: `section${index}${Number(selected)}`,
                  kind: 'records',
                  display: 'sections',
                  source: { tableId, viewId },
                  fieldIds: selected ? [heading, label, relation] : [heading],
                  altFieldId: relation,
                  linkFieldId: lookup,
                  linkLabelFieldId: label,
                  showFieldNames: false,
                  place: { x: 0, y: index * 2 + Number(selected), w: 12, h: 1 },
                })),
              ),
            },
          ],
        },
      },
    ]);
    const slug = `names-${interfaceId.toLowerCase()}`;
    const published = await server.app.inject({
      method: 'PUT',
      url: `/api/interfaces/${interfaceId}/site`,
      headers: server.owner.headers,
      payload: { slug, title: 'Scenes', pages: [{ pageId: 'page01', slug: 'home', title: 'Scenes' }] },
    });
    expect(published.statusCode, published.body).toBe(200);
    const response = await server.app.inject({ url: `/api/public/sites/${slug}/home` });
    expect(response.statusCode, response.body).toBe(200);
    const content = response.json<SiteContent>();
    expect(content.records).toHaveLength(6);
    const selectedRow = content.records[1]!.rows[0]!;
    const ownerName = selectedRow.values[person];
    expect(ownerName).toBe('Owner');
    expect(selectedRow.values[relation]).toBe('Studio team');
    for (const block of content.records)
      expect(block.rows[0]).toMatchObject({
        alt: 'Studio team',
        link: 'https://example.test/work',
        linkLabel: ownerName,
      });
    const html = await server.app.inject({ url: `/sites/${slug}/home` });
    expect(html.body.match(/>Owner<\/a>/g)).toHaveLength(6);
  });

  it('reads section media and auxiliary fields through current permissions, filters, ordering, and paging', async () => {
    const databaseId = newId('database');
    const tableId = newId('table');
    const viewId = newId('view');
    const interfaceId = newId('interface');
    const name = newId('field');
    const body = newId('field');
    const media = newId('field');
    const alt = newId('field');
    const link = newId('field');
    const label = newId('field');
    const slug = `sections-${interfaceId.toLowerCase()}`;
    const created = await server.app.inject({
      method: 'POST',
      url: '/api/databases',
      headers: server.owner.headers,
      payload: DatabaseCreate.parse({
        id: databaseId,
        name: 'Sections',
        table: {
          id: tableId,
          name: 'Sections',
          fields: [
            { id: name, name: 'Heading', type: 'text' },
            { id: body, name: 'Words', type: 'longText' },
            { id: media, name: 'Media', type: 'attachment' },
            { id: alt, name: 'Description', type: 'text' },
            { id: link, name: 'Address', type: 'text' },
            { id: label, name: 'Link label', type: 'text' },
          ],
          view: { id: viewId, name: 'Sections' },
        },
      }),
    });
    expect(created.statusCode, created.body).toBe(200);
    const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#496b5c' } })
      .png()
      .toBuffer();
    const files = [newId('attachment'), newId('attachment')];
    for (const [index, id] of files.entries()) {
      const content = index ? Buffer.from('Local video bytes') : bytes;
      await server.pool.query(
        `INSERT INTO ${server.schemas.app}.files
        (id, org_id, table_id, field_id, name, size, type, width, height, sha256, storage, storage_key, scan_state, attached_at)
        VALUES ($1, $2, $3, $4, 'scene', $5, $6, $8, $9, $7, 'postgres', $1, 'clean', statement_timestamp())`,
        [
          id,
          server.owner.info.org.id,
          tableId,
          media,
          content.length,
          index ? 'video/webm' : 'image/png',
          createHash('sha256').update(content).digest('hex'),
          index ? null : 320,
          index ? null : 180,
        ],
      );
      await server.pool.query(
        `INSERT INTO ${server.schemas.app}.file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
        [id, content],
      );
    }
    const rows = Array.from({ length: 28 }, (_, index) => ({
      id: newId('record'),
      values: {
        [name]: index === 27 ? 'Hidden' : `Scene ${String(index).padStart(2, '0')}`,
        [body]: 'One line.\nAnother line.',
        [alt]: 'A green scene',
        [link]: index === 26 ? 'javascript:alert(1)' : 'https://example.test/work',
        [label]: 'Explore the scene',
        [media]:
          index === 26 ? [files[1], files[0]] : index === 25 ? [] : index === 24 ? [files[1]] : [files[0]],
      },
    }));
    const commands = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${databaseId}/commands`,
      headers: server.owner.headers,
      payload: {
        clientId: newId('client'),
        commands: [
          { kind: 'record.create', tableId, records: rows },
          {
            kind: 'view.update',
            viewId,
            config: {
              sorts: [{ fieldId: name, direction: 'desc' }],
              filter: {
                conjunction: 'and',
                conditions: [{ id: 'visible', fieldId: name, operator: 'isNot', value: 'Hidden' }],
              },
            },
          },
          {
            kind: 'interface.create',
            interface: {
              id: interfaceId,
              name: 'Sections',
              pages: [
                {
                  id: 'page01',
                  name: 'Home',
                  blocks: [
                    {
                      id: 'sections01',
                      kind: 'records',
                      display: 'sections',
                      source: { tableId, viewId },
                      fieldIds: [name, body],
                      coverFieldId: media,
                      altFieldId: alt,
                      linkFieldId: link,
                      linkLabelFieldId: label,
                      showFieldNames: false,
                      playback: 'loop',
                      place: { x: 0, y: 0, w: 12, h: 4 },
                    },
                    {
                      id: 'heroVideo',
                      kind: 'hero',
                      heading: 'Posterless scene',
                      mediaType: 'video',
                      playback: 'loop',
                      image: { tableId, fieldId: media, recordId: rows[24]!.id, attachmentId: files[1] },
                      place: { x: 0, y: 4, w: 12, h: 4 },
                    },
                  ],
                },
              ],
            },
          },
        ].map((command) => Command.parse({ id: newId('command'), groupId: newId('action'), ...command })),
      },
    });
    expect(commands.statusCode, commands.body).toBe(200);
    expect(
      commands.json<{ results: Array<{ status: string }> }>().results.map((result) => result.status),
    ).toEqual(['applied', 'applied', 'applied']);
    const published = await server.app.inject({
      method: 'PUT',
      url: `/api/interfaces/${interfaceId}/site`,
      headers: server.owner.headers,
      payload: { slug, title: 'Sections', pages: [{ pageId: 'page01', slug: 'home', title: 'Sections' }] },
    });
    expect(published.statusCode, published.body).toBe(200);
    const first = await server.app.inject({ url: `/sites/${slug}/home` });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.body.match(/class="site-record-section"/g)).toHaveLength(25);
    expect(first.body.indexOf('<h3>Scene 26</h3>')).toBeLessThan(first.body.indexOf('<h3>Scene 25</h3>'));
    expect(first.body).not.toContain('<h3>Hidden</h3>');
    expect(first.body).not.toContain('javascript:');
    expect(first.body).toContain('aria-label="A green scene" muted loop data-site-loop');
    expect(first.body).toContain('<h3>Scene 25</h3><p>One line.\nAnother line.</p>');
    expect(first.body).toContain('>Explore the scene</a>');
    expect(first.body).toMatch(
      /<svg width="640" height="360"[^>]*>[\s\S]*?<video[^>]*page01\.heroVideo"[^>]* width="640" height="360"/,
    );
    expect(first.body).toMatch(
      new RegExp(`<video[^>]*sections01\\.${rows[24]!.id}\\.${files[1]}"[^>]* width="640" height="360"`),
    );
    expect(first.body).toMatch(
      new RegExp(
        `<video[^>]*sections01\\.${rows[26]!.id}\\.${files[1]}"[^>]*poster="[^"]+" width="320" height="180"`,
      ),
    );
    const path = `page01.sections01.${rows[26]!.id}`;
    const video = await server.app.inject({ url: `/sites/${slug}/media/${path}.${files[1]}` });
    expect(video.statusCode).toBe(200);
    expect(video.headers['content-type']).toContain('video/webm');
    const poster = await server.app.inject({ url: `/sites/${slug}/media/${path}.${files[0]}` });
    expect(poster.statusCode).toBe(200);
    const next = await server.app.inject({ url: `/sites/${slug}/home?offset.sections01=25` });
    expect(next.body.match(/class="site-record-section"/g)).toHaveLength(2);
    expect(next.body).toContain('<h3>Scene 01</h3>');
    expect(next.body).toContain('<h3>Scene 00</h3>');
    for (const fieldId of [alt, link, label, media]) {
      const permission = await server.app.inject({
        method: 'PUT',
        url: `/api/fields/${fieldId}/permissions`,
        headers: server.owner.headers,
        payload: { restricted: { roles: ['owner'], users: [] }, locked: null },
      });
      expect(permission.statusCode, permission.body).toBe(200);
    }
    const restricted = await server.app.inject({ url: `/sites/${slug}/home` });
    expect(restricted.statusCode).toBe(200);
    expect(restricted.body).not.toContain('A green scene');
    expect(restricted.body).not.toContain('example.test/work');
    expect(restricted.body).not.toContain('<video');
    expect((await server.app.inject({ url: `/sites/${slug}/media/${path}.${files[1]}` })).statusCode).toBe(
      404,
    );
  });

  it.each(['stored', 'read from bytes'])(
    'reserves pictures, covers, logos, and video posters with dimensions %s',
    async (source) => {
      const databaseId = newId('database');
      const tableId = newId('table');
      const fieldId = newId('field');
      const viewId = newId('view');
      const recordId = newId('record');
      const interfaceId = newId('interface');
      const slug = `pictures-${interfaceId.toLowerCase()}`;
      const created = await server.app.inject({
        method: 'POST',
        url: '/api/databases',
        headers: server.owner.headers,
        payload: DatabaseCreate.parse({
          id: databaseId,
          name: 'Pictures',
          table: {
            id: tableId,
            name: 'Pictures',
            fields: [
              { id: newId('field'), name: 'Name', type: 'text' },
              { id: fieldId, name: 'Photo', type: 'attachment' },
            ],
            view: { id: viewId, name: 'Pictures' },
          },
        }),
      });
      expect(created.statusCode, created.body).toBe(200);

      const files = [];
      for (const [type, width, height] of [
        ['image/png', 960, 640],
        ['image/png', 320, 480],
        ['image/png', null, null],
        ['video/mp4', 1920, 1080],
        ['video/mp4', null, null],
      ] as const) {
        const id = newId('attachment');
        const bytes =
          type === 'image/png' && width && height
            ? await sharp({ create: { width, height, channels: 3, background: '#496b5c' } })
                .png()
                .toBuffer()
            : Buffer.from('Unreadable media');
        await server.pool.query(
          `INSERT INTO ${server.schemas.app}.files
          (id, org_id, table_id, field_id, name, size, type, width, height, sha256, storage, storage_key, scan_state, attached_at)
          VALUES ($1, $2, $3, $4, 'picture', $5, $6, $7, $8, $9, 'postgres', $1, 'clean', statement_timestamp())`,
          [
            id,
            server.owner.info.org.id,
            tableId,
            fieldId,
            bytes.length,
            type,
            source === 'stored' || type.startsWith('video/') ? width : null,
            source === 'stored' || type.startsWith('video/') ? height : null,
            createHash('sha256').update(bytes).digest('hex'),
          ],
        );
        await server.pool.query(
          `INSERT INTO ${server.schemas.app}.file_chunks (storage_key, position, bytes) VALUES ($1, 0, $2)`,
          [id, bytes],
        );
        // Extra request properties cannot supply an attachment's dimensions.
        files.push({ tableId, fieldId, recordId, attachmentId: id, width: 1, height: 1 });
      }
      const [landscape, portrait, unreadable, video, posterVideo] = files;
      const commands = await server.app.inject({
        method: 'POST',
        url: `/api/databases/${databaseId}/commands`,
        headers: server.owner.headers,
        payload: {
          clientId: newId('client'),
          commands: [
            {
              kind: 'record.create',
              tableId,
              records: [{ id: recordId, values: { [fieldId]: files.map((file) => file.attachmentId) } }],
            },
            {
              kind: 'interface.create',
              interface: {
                id: interfaceId,
                name: 'Pictures',
                pages: [
                  {
                    id: 'page01',
                    name: 'Home',
                    blocks: [
                      { id: 'hero001', kind: 'hero', image: portrait, place: { x: 0, y: 0, w: 12, h: 1 } },
                      ...[landscape, portrait, unreadable, video, posterVideo].map((attachment, index) => ({
                        id: `media0${index}`,
                        kind: 'media',
                        attachment,
                        mediaType: index >= 3 ? 'video' : 'image',
                        place: { x: 0, y: index + 1, w: 12, h: 1 },
                      })),
                      {
                        id: 'cards01',
                        kind: 'records',
                        source: { tableId, viewId },
                        display: 'cards',
                        coverFieldId: fieldId,
                        place: { x: 0, y: 6, w: 12, h: 1 },
                      },
                    ],
                  },
                ],
              },
            },
          ].map((command) => Command.parse({ id: newId('command'), groupId: newId('action'), ...command })),
        },
      });
      expect(commands.statusCode, commands.body).toBe(200);
      expect(
        commands.json<{ results: Array<{ status: string }> }>().results.map((result) => result.status),
      ).toEqual(['applied', 'applied']);
      const siteSettings = {
        slug,
        title: 'Pictures',
        logo: portrait,
        pages: [{ pageId: 'page01', slug: 'home', title: 'Home' }],
      };
      const published = await server.app.inject({
        method: 'PUT',
        url: `/api/interfaces/${interfaceId}/site`,
        headers: server.owner.headers,
        payload: siteSettings,
      });
      expect(published.statusCode, published.body).toBe(200);

      const read = vi.spyOn(previews, 'imagePreviews');
      try {
        const response = await server.app.inject({ url: `/sites/${slug}/home` });
        expect(response.statusCode, response.body).toBe(200);
        const checkPictures = (html: string) => {
          const image = (path: string) =>
            new RegExp(`<img\\b[^>]*src="[^"]*/media/${path}"[^>]*>`).exec(html)?.[0];
          expect(image('page01.media00')).toContain('width="960" height="640"');
          expect(image('page01.media01')).toContain('width="320" height="480"');
          expect(image('page01.hero001')).toContain('width="320" height="480"');
          expect(image(`page01.cards01.${recordId}.${landscape!.attachmentId}`)).toContain(
            'width="960" height="640"',
          );
          expect(image('logo')).toContain('width="320" height="480"');
          const broken = image('page01.media02');
          expect(broken).toBeDefined();
          expect(broken).not.toMatch(/\b(?:width|height)=/);
          expect(html).toMatch(
            /<video[^>]*page01\.media03"[^>]*poster="[^"]*\.poster" width="1920" height="1080"/,
          );
          expect(html).toMatch(
            /<video[^>]*page01\.media04"[^>]*poster="[^"]*\.poster" width="960" height="640"/,
          );
        };
        checkPictures(response.body);
        const theme = await server.app.inject({ url: `/sites/${slug}/assets/theme.css` });
        expect(theme.statusCode, theme.body).toBe(200);
        expect(theme.body).toContain('font-display: optional;');
        expect(theme.body).not.toContain('font-display: swap;');
        expect(theme.body).toContain('url(/themes/palette/assets/fonts/remote/');
        expect(read.mock.calls.map((call) => call[1]).sort()).toEqual(
          (source === 'stored'
            ? [unreadable!.attachmentId]
            : files.slice(0, 3).map((file) => file.attachmentId)
          ).sort(),
        );
        expect(read.mock.calls.every((call) => call[4] === true)).toBe(true);
        const preview = await server.app.inject({
          method: 'POST',
          url: `/api/interfaces/${interfaceId}/site/preview`,
          headers: server.owner.headers,
          payload: { settings: siteSettings, pageId: 'page01' },
        });
        expect(preview.statusCode, preview.body).toBe(200);
        checkPictures(preview.json<{ html: string }>().html);
        const previewThemePath = /href="([^"]*\/assets\/theme\.css)"/.exec(
          preview.json<{ html: string }>().html,
        )![1]!;
        const previewTheme = await server.app.inject({
          url: previewThemePath,
          headers: server.owner.headers,
        });
        expect(previewTheme.statusCode, previewTheme.body).toBe(200);
        expect(previewTheme.body).toBe(theme.body);
        const thumbnails = await server.pool.query(
          `SELECT 1 FROM ${server.schemas.app}.file_chunks WHERE storage_key LIKE '%_small' OR storage_key LIKE '%_large'`,
        );
        expect(thumbnails.rowCount).toBe(0);
      } finally {
        read.mockRestore();
      }
    },
  );
});
