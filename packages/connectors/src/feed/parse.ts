import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { FeedFormat } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { decodeEntities, htmlText, htmlToMarkdown } from './html.js';

/**
 * Reads the four feed formats people publish: RSS 2.0, RSS 1.0 (RDF), Atom 1.0, and JSON Feed 1.1
 * (and 1.0, which differs only in how it names authors).  Each item comes out in one shape, with
 * its addresses made absolute, its title and summary as plain text, and its content as the Markdown
 * a rich text field stores, so nothing a feed says can become markup.
 */

export const FEED_KEYS = {
  parse: 'sources.feed.parse',
  empty: 'sources.feed.empty',
} as const;

export interface FeedItem {
  /** The item's `guid` or `id`, its link when it has neither, or a digest of what it says */
  id: string;
  title: string | null;
  link: string | null;
  author: string | null;
  /** When it was published, as an instant in UTC */
  published: string | null;
  updated: string | null;
  summary: string | null;
  /** Its content as rich text Markdown */
  content: string | null;
  categories: string[];
  /** The address of its first enclosure or attachment */
  enclosure: string | null;
}

export interface ParsedFeed {
  format: FeedFormat;
  title: string | null;
  items: FeedItem[];
}

/** Tags that can repeat, which the reader always gives as lists. */
const LISTS = new Set([
  'item',
  'entry',
  'category',
  'link',
  'author',
  'contributor',
  'enclosure',
  'dc:creator',
  'dc:subject',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: false,
  htmlEntities: false,
  // A feed's own entity definitions are never read: its declaration is removed before parsing.
  processEntities: true,
  isArray: (name) => LISTS.has(name),
  // Atom text can be HTML or XHTML, which is kept as it's written and read as HTML afterward.
  stopNodes: ['feed.title', 'feed.entry.title', 'feed.entry.summary', 'feed.entry.content'],
});

type Loose = Record<string, unknown>;

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** An element's own text, whether it has attributes or not. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isObject(value) && typeof value['#text'] === 'string') return value['#text'];
  return null;
}

function attr(value: unknown, name: string): string | null {
  return isObject(value) && typeof value[`@_${name}`] === 'string' ? (value[`@_${name}`] as string) : null;
}

/** Text as one line, or null when there's nothing to it. */
function line(text: string | null | undefined): string | null {
  const value = text?.replace(/\s+/gu, ' ').trim();
  return value ? value : null;
}

/** Raw XML text kept as written: CDATA sections as their own text, and references read elsewhere. */
function rawXml(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, inner: string) =>
    inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  );
}

/**
 * Atom text, which says what it is: `text`, `html` (escaped HTML), or `xhtml` (markup inside a
 * `div`).  The answer is always HTML, so text reads through the same path.
 */
function atomHtml(value: unknown): string | null {
  const raw = textOf(value);
  if (raw === null) return null;
  const type = (attr(value, 'type') ?? 'text').toLowerCase();
  if (type === 'xhtml') return raw.replace(/^\s*<div[^>]*>/i, '').replace(/<\/div>\s*$/i, '');
  const decoded = decodeEntities(rawXml(raw));
  if (type === 'html' || type === 'text/html') return decoded;
  // Plain text becomes HTML that says the same thing.
  return decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

/** An address made absolute against a base, kept only when it's a web address. */
function absolute(address: string | null | undefined, base: string | undefined): string | null {
  const text = address?.trim();
  if (!text) return null;
  try {
    const url = base ? new URL(text, base) : new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** A base address, resolved against the one around it, as `xml:base` works. */
function baseOf(value: unknown, outer: string | undefined): string | undefined {
  const base = attr(value, 'xml:base');
  if (!base) return outer;
  try {
    return new URL(base, outer).href;
  } catch {
    return outer;
  }
}

/** A date as an instant in UTC, from the RFC 822 dates RSS uses or the RFC 3339 dates Atom uses. */
export function feedDate(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  let time = Date.parse(value);
  if (!Number.isFinite(time)) {
    // Some feeds name the zone with letters `Date` doesn't know, or leave out the weekday's comma.
    const cleaned = value
      .replace(/^[A-Za-z]{3},?\s+/, '')
      .replace(/\s+(UT|Z)$/i, ' GMT')
      .replace(/\s+([A-Z]{3,4})$/, (whole, zone: string) => (ZONES[zone] ? ` ${ZONES[zone]}` : whole));
    time = Date.parse(cleaned);
  }
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

const ZONES: Record<string, string> = {
  EST: '-0500',
  EDT: '-0400',
  CST: '-0600',
  CDT: '-0500',
  MST: '-0700',
  MDT: '-0600',
  PST: '-0800',
  PDT: '-0700',
  BST: '+0100',
  CET: '+0100',
  CEST: '+0200',
};

/** A stand-in ID for an item that has no ID and no link: a digest of what it says. */
function digest(parts: ReadonlyArray<string | null>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function unique(values: ReadonlyArray<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** RSS's `author` is an address with a name after it in parentheses, and the name is what people want. */
function rssAuthor(text: string | null): string | null {
  const value = line(text);
  if (!value) return null;
  const named = /^\S+@\S+\s+\((.+)\)$/.exec(value);
  return named ? named[1]!.trim() : value;
}

function finish(partial: Omit<FeedItem, 'id'> & { id: string | null }): FeedItem {
  const id =
    line(partial.id) ??
    partial.link ??
    digest([partial.title, partial.summary, partial.published, partial.content]);
  return { ...partial, id };
}

function rssItem(item: Loose, base: string | undefined, rdf: boolean): FeedItem {
  const link = absolute(textOf(list(item.link)[0]), base);
  const description = textOf(item.description);
  const encoded = textOf(item['content:encoded']);
  const html = encoded ?? description;
  const enclosure =
    list(item.enclosure)
      .map((entry) => absolute(attr(entry, 'url'), base))
      .find(Boolean) ?? null;
  const categories = unique([
    ...list(item.category).map((entry) => line(htmlText(textOf(entry) ?? ''))),
    ...list(item['dc:subject']).map((entry) => line(htmlText(textOf(entry) ?? ''))),
  ]);
  const authors = unique([
    ...list(item.author).map((entry) => rssAuthor(textOf(entry))),
    ...list(item['dc:creator']).map((entry) => line(htmlText(textOf(entry) ?? ''))),
  ]);
  return finish({
    id: rdf ? attr(item, 'rdf:about') : textOf(item.guid),
    title: line(htmlText(textOf(item.title) ?? '')),
    link,
    author: authors.length ? authors.join(', ') : null,
    published: feedDate(textOf(item.pubDate) ?? textOf(item['dc:date'])),
    updated: feedDate(textOf(item['atom:updated']) ?? textOf(item['dcterms:modified'])),
    summary: description === null ? null : line(htmlText(description)),
    content: html === null ? null : htmlToMarkdown(html, link ?? base) || null,
    categories,
    enclosure,
  });
}

function atomPeople(value: unknown): string[] {
  return unique(
    list(value).map((person) => (isObject(person) ? line(textOf(person.name)) : line(textOf(person)))),
  );
}

function atomItem(entry: Loose, base: string | undefined, feedAuthors: string[]): FeedItem {
  const own = baseOf(entry, base);
  const links = list(entry.link);
  const rel = (link: unknown) => (attr(link, 'rel') ?? 'alternate').toLowerCase();
  const link = absolute(
    attr(
      links.find((entry) => rel(entry) === 'alternate'),
      'href',
    ),
    own,
  );
  const enclosure = absolute(
    attr(
      links.find((entry) => rel(entry) === 'enclosure'),
      'href',
    ),
    own,
  );
  const summary = atomHtml(entry.summary);
  const content = atomHtml(entry.content) ?? summary;
  const authors = atomPeople(entry.author);
  return finish({
    id: textOf(entry.id),
    title: line(htmlText(atomHtml(entry.title) ?? '')),
    link,
    author: (authors.length ? authors : feedAuthors).join(', ') || null,
    published: feedDate(textOf(entry.published) ?? textOf(entry.issued)),
    updated: feedDate(textOf(entry.updated) ?? textOf(entry.modified)),
    summary: summary === null ? null : line(htmlText(summary)),
    content: content === null ? null : htmlToMarkdown(content, link ?? own) || null,
    categories: unique(
      list(entry.category).map((category) => line(attr(category, 'label') ?? attr(category, 'term'))),
    ),
    enclosure,
  });
}

function jsonItem(item: Loose, base: string | undefined, feedAuthors: string[]): FeedItem {
  const text = (value: unknown) =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  const link = absolute(text(item.url) ?? text(item.external_url), base);
  const html = text(item.content_html);
  const plain = text(item.content_text);
  const authors = unique(
    [...list(item.authors), ...list(item.author)].map((person) =>
      isObject(person) ? line(text(person.name)) : null,
    ),
  );
  const attachment = list(item.attachments).map((entry) =>
    isObject(entry) ? absolute(text(entry.url), base) : null,
  );
  const summary = text(item.summary);
  const escaped = plain
    ?.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  const content = html ?? escaped ?? null;
  return finish({
    id: text(item.id),
    title: line(htmlText(text(item.title) ?? '')),
    link,
    author: (authors.length ? authors : feedAuthors).join(', ') || null,
    published: feedDate(text(item.date_published)),
    updated: feedDate(text(item.date_modified)),
    summary: summary === null ? null : line(summary),
    content: content === null ? null : htmlToMarkdown(content, link ?? base) || null,
    categories: unique(list(item.tags).map((tag) => line(text(tag)))),
    enclosure: attachment.find(Boolean) ?? null,
  });
}

/** Items that share an ID are one item, and the feed's first word on it stands. */
function distinct(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function parseJsonFeed(text: string, url: string | undefined): ParsedFeed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ConnectorError(FEED_KEYS.parse, 'the answer isn’t valid JSON');
  }
  if (!isObject(document) || typeof document.version !== 'string' || !/jsonfeed\.org/.test(document.version))
    throw new ConnectorError(FEED_KEYS.parse, 'the JSON isn’t a JSON Feed');
  const base = absolute(typeof document.feed_url === 'string' ? document.feed_url : null, url) ?? url;
  const authors = unique(
    [...list(document.authors), ...list(document.author)].map((person) =>
      isObject(person) && typeof person.name === 'string' ? line(person.name) : null,
    ),
  );
  const items = list(document.items)
    .filter(isObject)
    .map((item) => jsonItem(item, base, authors));
  return {
    format: 'json',
    title: typeof document.title === 'string' ? line(document.title) : null,
    items: distinct(items),
  };
}

/**
 * Reads a feed's bytes, which may be XML or JSON.  `url` is where the answer came from, after any
 * redirects, which relative addresses are resolved against.
 */
export function parseFeed(bytes: Buffer | string, url?: string): ParsedFeed {
  const text = (typeof bytes === 'string' ? bytes : bytes.toString('utf8')).replace(/^\uFEFF/, '');
  if (/^\s*[{[]/.test(text)) return parseJsonFeed(text, url);
  let document: Loose;
  try {
    // A feed's own entity declarations are removed, so none is ever expanded or fetched.
    const safe = text.replace(/<!DOCTYPE(?:[^[>]*\[[\s\S]*?\])?[^>]*>/gi, '');
    document = parser.parse(safe) as Loose;
  } catch (error) {
    throw new ConnectorError(
      FEED_KEYS.parse,
      error instanceof Error ? error.message.slice(0, 300) : undefined,
    );
  }
  if (isObject(document.rss)) {
    const channel = isObject(document.rss.channel) ? document.rss.channel : {};
    return {
      format: 'rss2',
      title: line(htmlText(textOf(channel.title) ?? '')),
      items: distinct(
        list(channel.item)
          .filter(isObject)
          .map((item) => rssItem(item, url, false)),
      ),
    };
  }
  if (isObject(document['rdf:RDF'])) {
    const root = document['rdf:RDF'];
    const channel = isObject(root.channel) ? root.channel : {};
    const items = [...list(root.item), ...list(channel.item)].filter(isObject);
    return {
      format: 'rss1',
      title: line(htmlText(textOf(channel.title) ?? '')),
      items: distinct(items.map((item) => rssItem(item, url, true))),
    };
  }
  if (isObject(document.feed)) {
    const feed = document.feed;
    const base = baseOf(feed, url);
    const authors = atomPeople(feed.author);
    return {
      format: 'atom',
      title: line(htmlText(atomHtml(feed.title) ?? '')),
      items: distinct(
        list(feed.entry)
          .filter(isObject)
          .map((entry) => atomItem(entry, base, authors)),
      ),
    };
  }
  throw new ConnectorError(FEED_KEYS.parse, 'the answer isn’t an RSS, Atom, or JSON feed');
}
