import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createModuleLoader, listModules, loadModule, parseModule } from './loader';

/** Help modules in the docs folder, so adding an article never means editing this test. */
const MODULES = readdirSync(join(import.meta.dirname, '../../../../docs/modules'), { withFileTypes: true })
  .filter((area) => area.isDirectory())
  .flatMap((area) => readdirSync(join(area.parentPath, area.name))).length;

const sources = import.meta.glob<string>('../../../../docs/modules/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});
const fixture = (id: string, title = 'A topic') =>
  `---\nid: ${id}\ntitle: ${title}\nsummary: A short description.\narea: account\n---\n\nA paragraph.`;

describe('help modules', () => {
  it('explains pivot tile settings and keyboard cell drill-down in dashboard help', async () => {
    const module = await loadModule('dashboards', 'en-US');
    const pivot = module?.body.split('## Pivot tables')[1]?.split('\n## ')[0];
    expect(pivot).toBeDefined();
    for (const id of [
      'dashboards.tile.pivot',
      'views.pivot.settings.addRow',
      'views.pivot.settings.column',
      'dashboards.fn.count',
      'dashboards.fn.sum',
      'dashboards.fn.average',
      'dashboards.fn.min',
      'dashboards.fn.max',
      'views.pivot.settings.rowTotals',
      'views.pivot.settings.columnTotals',
    ])
      expect(pivot).toContain(`{{ui:${id}}}`);
    expect(pivot).toMatch(/Tab.*Enter/s);
  });

  it('validates every locale, module identity, related id, and English fallback', () => {
    const ids = new Map<string, string>();
    const modules = Object.entries(sources).map(([path, source]) => ({ path, ...parseModule(source, path) }));
    expect(modules.length).toBeGreaterThanOrEqual(8);
    for (const module of modules) {
      const directory = module.path.slice(0, module.path.lastIndexOf('/'));
      expect(ids.get(module.meta.id) ?? directory).toBe(directory);
      ids.set(module.meta.id, directory);
      expect(sources[`${directory}/en-US.md`]).toBeDefined();
      expect(directory.endsWith(`/${module.meta.area}/${module.meta.id}`)).toBe(true);
    }
    for (const module of modules) {
      for (const related of module.meta.related) expect(ids.has(related), related).toBe(true);
    }
  });

  it('resolves every interface and document macro', () => {
    const catalog = readFileSync(join(import.meta.dirname, '../locales/en-US/messages.po'), 'utf8');
    const messages = new Set([...catalog.matchAll(/^msgid "([^"\n]+)"$/gm)].map((match) => match[1]));
    const ids = new Set(Object.values(sources).map((source) => parseModule(source).meta.id));
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/\{\{(ui|doc):([^}]+)\}\}/g)) {
        expect((match[1] === 'ui' ? messages : ids).has(match[2]!), match[0]).toBe(true);
      }
    }
  });

  it('lists and loads the real modules with a per-module language fallback', async () => {
    const metadata = await listModules('fr');
    expect(metadata).toHaveLength(MODULES);
    expect((await loadModule('welcome', 'fr'))?.body).toContain('Finding your way');
    expect(await loadModule('missing', 'en-US')).toBeNull();
  });

  it('loads lazily, selects translations, caches reads, and falls back per module', async () => {
    const english = vi.fn(async () => fixture('one', 'English title'));
    const french = vi.fn(async () => fixture('one', 'French title'));
    const second = vi.fn(async () => fixture('two', 'Second title'));
    const loader = createModuleLoader({
      '/account/one/en-US.md': english,
      '/account/one/fr.md': french,
      '/account/two/en-US.md': second,
    });
    expect(english).not.toHaveBeenCalled();
    expect(french).not.toHaveBeenCalled();
    expect((await loader.loadModule('one', 'fr'))?.meta.title).toBe('French title');
    expect(second).not.toHaveBeenCalled();
    expect((await loader.listModules('fr')).map((meta) => meta.title)).toEqual([
      'French title',
      'Second title',
    ]);
    expect((await loader.loadModule('one', 'de'))?.meta.title).toBe('English title');
    await loader.loadModule('one', 'fr');
    expect(french).toHaveBeenCalledOnce();
  });

  it('retries a failed load and rejects inconsistent module paths', async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(fixture('one'));
    const loader = createModuleLoader({ '/account/one/en-US.md': read });
    await expect(loader.loadModule('one', 'en-US')).rejects.toThrow('Unavailable');
    expect(await loader.loadModule('one', 'en-US')).not.toBeNull();
    await expect(createModuleLoader({ '/account/one/fr.md': read }).loadModule('one', 'fr')).rejects.toThrow(
      'Missing en-US',
    );
    await expect(
      createModuleLoader({ '/account/two/en-US.md': read }).loadModule('two', 'en-US'),
    ).rejects.toThrow('does not match');
  });

  it('parses strings, numbers, inline lists, and Windows line endings', () => {
    const source = fixture('one', '"A quoted title"').replace(
      'area: account',
      "area: account\norder: -2\nrelated: [two, three]\nanchors: []\nvideo: 'It''s a video'",
    );
    const module = parseModule(source.replaceAll('\n', '\r\n'));
    expect(module.meta).toMatchObject({
      title: 'A quoted title',
      order: -2,
      related: ['two', 'three'],
      anchors: [],
      video: "It's a video",
    });
    expect(module.body).toBe('A paragraph.');
  });

  it('keeps quoted commas inside inline list strings', () => {
    const module = parseModule(
      fixture('one').replace('area: account', 'area: account\nanchors: ["save, close", \'account\']'),
    );
    expect(module.meta.anchors).toEqual(['save, close', 'account']);
  });

  it.each(['true', 'null', '{nested: map}', '[one, [two]]', '|', '&anchor text', '[one,,two]', 'one: two'])(
    'rejects unsupported front matter: %s',
    (value) => {
      expect(() => parseModule(fixture('one').replace('A short description.', value))).toThrow(
        /Unsupported|Invalid/,
      );
    },
  );

  it('rejects invalid metadata, duplicate fields, and missing delimiters', () => {
    expect(() => parseModule('No front matter')).toThrow('delimiters');
    expect(() => parseModule(fixture('INVALID'))).toThrow('Invalid module metadata');
    expect(() =>
      parseModule(fixture('one').replace('area: account', 'area: account\narea: account')),
    ).toThrow('Duplicate field');
  });
});
