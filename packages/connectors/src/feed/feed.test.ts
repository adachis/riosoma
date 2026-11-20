import { FixtureBoundary } from '../contract/boundary.test-support.js';
import { strictFixture } from '../contract/strict.test-support.js';
/**
 * Feeds from fixture files in every format a feed source reads, the HTML they carry made safe, and
 * reads that send the last answer's validators and stop when the feed says nothing changed.  The
 * network here is a stand-in, since the private-network rule belongs to the server and its own
 * tests hold feeds to it.
 */
import { readFileSync } from 'node:fs';
import { FeedConnection, type SourceSelect } from '@riosoma/contracts';
import { describe, expect, it } from 'vitest';
import type { FileNetwork, FileRequest } from '../files/network.js';
import { ConnectorError, NotModified, type ConnectorContext, type SourceRow } from '../types.js';
import { createFeedConnector, FEED_SOURCE_COLUMNS } from './connector.js';
import { htmlText, htmlToMarkdown } from './html.js';
import { feedDate, parseFeed } from './parse.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const ITEMS: SourceSelect = { kind: 'object', object: { schema: null, name: 'items' } };

describe('reading feeds', () => {
  it('reads RSS 2.0, with HTML in titles, a relative link, and a missing guid', () => {
    const feed = parseFeed(fixture('rss2.xml'), 'https://news.example.test/feed.xml');
    expect(feed.format).toBe('rss2');
    expect(feed.title).toBe('Field Notes & More');
    const [first, second, third] = feed.items;
    expect(first).toMatchObject({
      id: 'note-1',
      title: 'Big news & notes',
      link: 'https://news.example.test/posts/1',
      author: 'Jo Park',
      published: '2026-09-28T10:00:00.000Z',
      updated: null,
      summary: 'The first note.',
      categories: ['Field', 'Weather'],
      enclosure: 'https://cdn.example.test/one.mp3',
    });
    // Links in the content are made absolute, a script never survives, and an unsafe link is text.
    expect(first!.content).toContain('[a relative link](https://news.example.test/about)');
    expect(first!.content).not.toContain('javascript');
    expect(first!.content).not.toContain('never');
    expect(first!.content).toContain('a bad one');
    expect(first!.content).toContain('**first**');
    expect(first!.content).toContain('- One');
    expect(second).toMatchObject({
      id: 'note-2',
      link: 'https://news.example.test/posts/2',
      author: 'Sam Lee',
      published: '2026-09-29T15:30:00.000Z',
      summary: 'Plain text, with no markup & an ampersand.',
      enclosure: 'https://news.example.test/media/two.mp3',
      categories: [],
    });
    // With no guid, the link is the key.
    expect(third).toMatchObject({
      id: 'https://news.example.test/posts/3',
      title: 'No guid here',
      published: '2026-09-30T17:00:00.000Z',
    });
  });

  it('reads RSS 1.0, keyed by each item’s own address', () => {
    const feed = parseFeed(fixture('rss1.rdf'), 'https://journal.example.test/index.rdf');
    expect(feed.format).toBe('rss1');
    expect(feed.title).toBe('The Journal');
    expect(feed.items.map((item) => item.id)).toEqual([
      'https://journal.example.test/entries/a',
      'https://journal.example.test/entries/b',
    ]);
    expect(feed.items[0]).toMatchObject({
      author: 'Ana Ruiz',
      published: '2026-09-20T07:15:00.000Z',
      summary: 'The first entry, summed up.',
      content: 'The whole _first_ entry.',
      categories: ['Journal'],
    });
    expect(feed.items[1]!.categories).toEqual(['Journal', 'Travel']);
  });

  it('reads Atom 1.0, with xml:base, XHTML and escaped HTML, and the feed’s author', () => {
    const feed = parseFeed(fixture('atom.xml'), 'https://blog.example.test/atom.xml');
    expect(feed.format).toBe('atom');
    expect(feed.title).toBe('The Build Log');
    const [first, second] = feed.items;
    expect(first).toMatchObject({
      id: 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
      title: 'Shipping v2 & beyond',
      link: 'https://blog.example.test/archive/2026/09/shipping',
      author: 'Riley Chen',
      published: '2026-09-26T16:00:00.000Z',
      updated: '2026-09-27T18:30:02.000Z',
      summary: 'A short summary & nothing more.',
      categories: ['Releases', 'team'],
      enclosure: 'https://blog.example.test/files/notes.pdf',
    });
    expect(first!.content).toContain('## What changed');
    expect(first!.content).toContain('[the docs](https://blog.example.test/archive/2026/docs)');
    expect(first!.content).toContain('> Quoted words.');
    expect(second).toMatchObject({
      author: 'Morgan Diaz',
      published: null,
      content: 'Escaped **HTML** content.',
    });
  });

  it('reads JSON Feed 1.1, resolving addresses against the feed’s own', () => {
    const feed = parseFeed(fixture('feed.json'), 'https://mirror.example.test/feed.json');
    expect(feed.format).toBe('json');
    expect(feed.items[0]).toMatchObject({
      id: '2',
      link: 'https://small.example.test/posts/two',
      title: 'Second thing',
      author: 'Pat Kim',
      summary: 'The second thing.',
      content: 'Second [thing](https://small.example.test/more).',
      categories: ['things', 'small'],
      enclosure: 'https://small.example.test/two.m4a',
      updated: '2026-09-25T10:00:00.000Z',
    });
    expect(feed.items[1]).toMatchObject({ id: '1', author: 'Lee Wong', content: 'Just text.\nTwo lines.' });
  });

  it('keeps one of each item, and refuses what isn’t a feed', () => {
    const doubled = `<rss><channel><item><guid>a</guid><title>One</title></item><item><guid>a</guid><title>Again</title></item></channel></rss>`;
    expect(parseFeed(doubled).items.map((item) => item.title)).toEqual(['One']);
    const bare = `<rss><channel><item><title>No guid or link</title></item></channel></rss>`;
    expect(parseFeed(bare).items[0]!.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => parseFeed('<html><body>hello</body></html>')).toThrow(ConnectorError);
    expect(() => parseFeed('{"items": []}')).toThrow(ConnectorError);
  });

  it('never expands a feed’s own entities', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><guid>1</guid><title>&b;&x;</title></item></channel></rss>`;
    const [item] = parseFeed(bomb).items;
    expect(item!.title).not.toContain('aaaaaaaaaa');
    expect(item!.title).not.toContain('root');
  });

  it('reads dates in the forms feeds write them', () => {
    expect(feedDate('Mon, 28 Sep 2026 10:00:00 GMT')).toBe('2026-09-28T10:00:00.000Z');
    expect(feedDate('28 Sep 2026 10:00:00 PDT')).toBe('2026-09-28T17:00:00.000Z');
    expect(feedDate('2026-09-28T10:00:00+02:00')).toBe('2026-09-28T08:00:00.000Z');
    expect(feedDate('someday')).toBeNull();
  });

  it('turns HTML into plain text and into rich text it can say', () => {
    expect(htmlText('<p>One &amp; <b>two</b></p><p>three&nbsp;four</p>')).toBe('One & two three four');
    expect(htmlToMarkdown('<h1>Title</h1><p>Line<br>break</p><ol start="3"><li>c</li><li>d</li></ol>')).toBe(
      '# Title\n\nLine\nbreak\n\n3. c\n4. d',
    );
    expect(
      htmlToMarkdown('<p><a href="mailto:jo@example.test">mail</a> <a href="data:text/html,x">data</a></p>'),
    ).toBe('[mail](mailto:jo@example.test) data');
    expect(htmlToMarkdown('<pre><code>let x = 1;\nx++;</code></pre>')).toBe('```\nlet x = 1;\nx++;\n```');
    expect(htmlToMarkdown('<p>*not bold*</p>')).toBe('\\*not bold\\*');
  });
});

/** A stand-in network with one feed, which honors `If-None-Match` and `If-Modified-Since`. */
function network(body: string, etag = '"v1"', modified = 'Mon, 28 Sep 2026 10:00:00 GMT') {
  const requests: FileRequest[] = [];
  const net: FileNetwork = {
    allowsAddress: (url) => url.protocol === 'https:',
    check: async () => ({ address: '93.184.216.34', family: 4 }),
    async request(request) {
      requests.push(request);
      const unchanged =
        request.headers['if-none-match'] === etag || request.headers['if-modified-since'] === modified;
      return {
        status: unchanged ? 304 : 200,
        headers: { etag, 'last-modified': modified, 'content-type': 'application/rss+xml' },
        url: request.url,
        body: (async function* () {
          if (!unchanged) yield Buffer.from(body);
        })(),
        close: () => undefined,
      };
    },
  };
  return { net, requests };
}

function context(url = 'https://news.example.test/feed.xml', secrets = {}): ConnectorContext {
  return { connection: FeedConnection.parse({ kind: 'feed', url }), secrets, timeoutMs: 5_000 };
}

async function rows(iterable: AsyncIterable<SourceRow[]>): Promise<SourceRow[]> {
  const all: SourceRow[] = [];
  for await (const batch of iterable) all.push(...batch);
  return all;
}

describe('the feed connector', () => {
  const columns = FEED_SOURCE_COLUMNS.map((column) => column.name);
  const types = Object.fromEntries(
    FEED_SOURCE_COLUMNS.map((column) => [column.name, column.suggested!.type]),
  );

  it('offers its items with the same columns every time, keyed by ID', async () => {
    const { net } = network(fixture('rss2.xml').toString());
    const connector = createFeedConnector({ network: net });
    expect(await connector.listObjects(context())).toEqual([
      { schema: null, name: 'items', type: 'feed', rowEstimate: null },
    ]);
    expect((await connector.describe(context(), ITEMS)).map((column) => column.suggested?.type)).toEqual([
      'text',
      'text',
      'url',
      'text',
      'date',
      'date',
      'longText',
      'longText',
      'multipleSelect',
      'url',
    ]);
    expect(await connector.keyCandidates(context(), ITEMS.object)).toEqual([['id']]);
    const preview = await connector.preview(context(), ITEMS, 2);
    expect(preview.rowEstimate).toBe(3);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]![columns.indexOf('categories')]).toEqual(['Field', 'Weather']);
    const test = await connector.test(context());
    expect(test).toMatchObject({ ok: true, serverVersion: 'RSS 2.0' });
    expect(test.steps.map((step) => step.step)).toEqual(['resolve', 'read', 'feed']);
  });

  it('sends the last answer’s validators, and stops when the feed says nothing changed', async () => {
    const { net, requests } = network(fixture('atom.xml').toString());
    const connector = createFeedConnector({ network: net });
    const heard: unknown[] = [];
    const first = await rows(
      connector.read(context(), ITEMS, {
        columns,
        types,
        keyColumns: ['id'],
        onValidators: (validators) => heard.push(validators),
      }),
    );
    expect(first.map((row) => row.key)).toEqual([
      JSON.stringify(['urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a']),
      JSON.stringify(['tag:blog.example.test,2026:entry-2']),
    ]);
    expect(first[0]!.values.categories).toEqual(['Releases', 'team']);
    expect(heard).toEqual([{ etag: '"v1"', lastModified: 'Mon, 28 Sep 2026 10:00:00 GMT' }]);
    expect(requests[0]!.headers['if-none-match']).toBeUndefined();
    await expect(
      rows(connector.read(context(), ITEMS, { columns, types, keyColumns: ['id'], since: { etag: '"v1"' } })),
    ).rejects.toBeInstanceOf(NotModified);
    expect(requests[1]!.headers['if-none-match']).toBe('"v1"');
    await expect(
      rows(
        connector.read(context(), ITEMS, {
          columns,
          types,
          keyColumns: ['id'],
          since: { lastModified: 'Mon, 28 Sep 2026 10:00:00 GMT' },
        }),
      ),
    ).rejects.toBeInstanceOf(NotModified);
    expect(requests[2]!.headers['if-modified-since']).toBe('Mon, 28 Sep 2026 10:00:00 GMT');
    // A changed feed answers in full again.
    const changed = await rows(
      connector.read(context(), ITEMS, { columns, types, keyColumns: ['id'], since: { etag: '"v0"' } }),
    );
    expect(changed).toHaveLength(2);
  });

  it('sends its request headers, and says plainly when the feed refuses or isn’t one', async () => {
    const { net, requests } = network('<html></html>');
    const connector = createFeedConnector({ network: net });
    await expect(
      connector.preview(context(undefined, { headers: 'Authorization: Bearer abc' }), ITEMS, 5),
    ).rejects.toMatchObject({
      messageKey: 'sources.feed.parse',
    });
    expect(requests[0]!.headers.Authorization).toBe('Bearer abc');
    const refused = createFeedConnector({
      network: {
        ...net,
        request: async (request) => ({
          status: 403,
          headers: {},
          url: request.url,
          body: (async function* () {})(),
          close: () => undefined,
        }),
      },
    });
    await expect(refused.preview(context(), ITEMS, 5)).rejects.toMatchObject({
      messageKey: 'sources.feed.denied',
    });
    const failed = await refused.test(context());
    expect(failed.ok).toBe(false);
    expect(failed.steps.at(-1)).toMatchObject({ step: 'read', messageKey: 'sources.feed.denied' });
    // Without the server's network, nothing is reached.
    await expect(createFeedConnector().preview(context(), ITEMS, 5)).rejects.toMatchObject({
      messageKey: 'sources.feed.https',
    });
  });
});

it('runs every declared feed contract against its RSS fixture', async () => {
  const boundary = new FixtureBoundary();
  const { net } = network(fixture('rss2.xml').toString());
  await strictFixture(
    createFeedConnector({ network: boundary.wrap(net) }),
    context(),
    { kind: 'object', object: { schema: null, name: 'items' } },
    ['id'],
    3,
    boundary,
  );
});
