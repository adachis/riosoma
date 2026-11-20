import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SOURCE_KINDS } from '../../../packages/contracts/src/source-refs.js';

/**
 * Everything the website's database holds, and where each part comes from: the copy in
 * `content.json` beside this file, the themes in the repository's own `themes/` folder, and the
 * data sources the product connects to.  The last two are read when the seed runs, so the tables
 * follow the repository and the product instead of a copy of either that goes stale.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

/** The site's own copy.  The pages that show it come later; the seed writes the two lists below. */
export interface SiteCopy {
  title: string;
  headline: string;
  lead: string;
  demoLabel: string;
  tourLabel: string;
  footer: string;
}

/** One thing the site says Riosoma does, filed under the area of the product it belongs to. */
export interface Feature {
  name: string;
  area: string;
  summary: string;
}

/** One of the questions the site answers. */
export interface Question {
  question: string;
  answer: string;
}

export interface WebsiteContent {
  site: SiteCopy;
  features: Feature[];
  questions: Question[];
}

function words(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`The website content has no ${what}.`);
  return value;
}

function entries(value: unknown, what: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.length) throw new Error(`The website content has no ${what}.`);
  return value as Array<Record<string, unknown>>;
}

/** The copy in `content.json`, read as the seed runs and checked so a broken file says so at once. */
export function readContent(file = join(import.meta.dirname, 'content.json')): WebsiteContent {
  const found = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const site = (found.site ?? {}) as Record<string, unknown>;
  return {
    site: {
      title: words(site.title, 'site title'),
      headline: words(site.headline, 'headline'),
      lead: words(site.lead, 'lead'),
      demoLabel: words(site.demoLabel, 'demo label'),
      tourLabel: words(site.tourLabel, 'tour label'),
      footer: words(site.footer, 'footer'),
    },
    features: entries(found.features, 'features').map((feature, index) => ({
      name: words(feature.name, `name for feature ${index + 1}`),
      area: words(feature.area, `area for feature ${index + 1}`),
      summary: words(feature.summary, `summary for feature ${index + 1}`),
    })),
    questions: entries(found.questions, 'questions').map((entry, index) => ({
      question: words(entry.question, `question ${index + 1}`),
      answer: words(entry.answer, `answer to question ${index + 1}`),
    })),
  };
}

export const content: WebsiteContent = readContent();

/** The areas the features name, in the order a reader first meets each one. */
export function areas(): string[] {
  return [...new Set(content.features.map((feature) => feature.area))];
}

/** A theme in the repository: what it calls itself, its folder's name, and its color schemes. */
export interface ThemeEntry {
  name: string;
  slug: string;
  schemes: number;
}

/** Every theme in `themes/`, which is the folder the server serves themes from, by display name. */
export function themeEntries(root = join(ROOT, 'themes')): ThemeEntry[] {
  const found: ThemeEntry[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(root, entry.name, 'theme.json');
    if (!existsSync(manifest)) continue;
    const theme = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; schemes?: unknown };
    if (!Array.isArray(theme.schemes))
      throw new Error(`The theme ${entry.name} lists no color schemes in its manifest.`);
    found.push({
      name: words(theme.name, `display name for the theme ${entry.name}`),
      slug: entry.name,
      schemes: theme.schemes.length,
    });
  }
  if (!found.length) throw new Error(`The folder ${root} holds no themes.`);
  return found.sort((one, other) => one.name.localeCompare(other.name, 'en-US'));
}

/** A data source the product connects to, as the picker names it and files it. */
export interface SourceKindEntry {
  name: string;
  group: string;
}

/** The picker's catalog of data sources: its four groups, and every kind in its own order. */
export interface SourceCatalog {
  groups: string[];
  kinds: SourceKindEntry[];
}

const PICKER = join(ROOT, 'apps/web/src/screens/settings/sources');

/**
 * The picker's four groups, in the order a reader meets them.  Three of them list their own kinds
 * and everything else is a database, which is how the picker decides too.
 */
const GROUP_KEYS = ['databases', 'files', 'web', 'services'] as const;

function quoted(text: string): string[] {
  return [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

/**
 * Each kind's name, in the order the picker lists them.  The picker's catalog is a module of the
 * web app whose names are translation macros, so it loads only in a browser build; this reads the
 * same file and checks it against the contract's own list of kinds, which fails loudly rather than
 * seeding a table that quietly missed one.
 */
function kindNames(): Array<{ kind: string; name: string }> {
  const text = readFileSync(join(PICKER, 'kinds.ts'), 'utf8');
  const start = text.indexOf('export const KIND_INFO');
  const end = text.indexOf('\n];', start);
  if (start < 0 || end < 0) throw new Error('The picker catalog in kinds.ts is not where it was.');
  const found = [
    ...text.slice(start, end).matchAll(/kind:\s*'([^']+)'(?:(?!kind:)[\s\S])*?message:\s*'([^']*)'/g),
  ].map((match) => ({ kind: match[1]!, name: match[2]! }));
  const listed = new Set(found.map((entry) => entry.kind));
  const missing = SOURCE_KINDS.filter((kind) => !listed.has(kind));
  const unknown = found.filter((entry) => !(SOURCE_KINDS as readonly string[]).includes(entry.kind));
  if (missing.length || unknown.length)
    throw new Error(
      `The picker catalog and the contract's kinds disagree.  Missing ${JSON.stringify(missing)}, ` +
        `not a kind ${JSON.stringify(unknown.map((entry) => entry.kind))}.`,
    );
  return found;
}

/** What the picker calls each group, and the kinds each of its three lists holds. */
function kindGroups(): { labels: Map<string, string>; members: Map<string, string> } {
  const text = readFileSync(join(PICKER, 'SourceForm.tsx'), 'utf8');
  const labels = new Map<string, string>();
  for (const match of text.matchAll(/id:\s*'sources\.groups\.(\w+)',\s*message:\s*'([^']*)'/g))
    labels.set(match[1]!, match[2]!);
  const members = new Map<string, string>();
  for (const key of GROUP_KEYS) {
    if (!labels.has(key)) throw new Error(`The picker names no group called ${key}.`);
    const lists = [...text.matchAll(new RegExp(`const ${key} = \\[([^\\]]*)\\]`, 'g'))];
    // Every group but the databases lists its own kinds, and the picker files the rest there.
    if (!lists.length && key !== 'databases')
      throw new Error(`The picker no longer lists its ${key} kinds where they were.`);
    for (const match of lists) for (const kind of quoted(match[1]!)) members.set(kind, key);
  }
  return { labels, members };
}

/** Every data source the product connects to, read from the picker the sync dialog shows. */
export function sourceCatalog(): SourceCatalog {
  const { labels, members } = kindGroups();
  const kinds = kindNames().map(({ kind, name }) => ({
    name,
    group: labels.get(members.get(kind) ?? 'databases')!,
  }));
  return { groups: GROUP_KEYS.map((key) => labels.get(key)!), kinds };
}
