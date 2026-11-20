import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DemoScript, FIELD_TYPES, VIEW_TYPES } from '@riosoma/contracts';
import { parseModule } from '../docs/loader';
import { ANCHORS, anchorInfo } from './anchors';
import { NARRATION } from './messages';
import { createDemoLoader } from './scripts';

const ROOT = join(import.meta.dirname, '../../../..');
const MODULES = join(ROOT, 'docs/modules');

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, test);
    return test(name) ? [path] : [];
  });
}

const demos = files(MODULES, (name) => name === 'demo.json').map((path) => ({
  path: path.slice(ROOT.length + 1),
  directory: path.slice(0, path.lastIndexOf('/')),
  script: DemoScript.parse(JSON.parse(readFileSync(path, 'utf8'))),
}));
const modules = files(MODULES, (name) => name === 'en-US.md').map((path) => ({
  directory: path.slice(0, path.lastIndexOf('/')),
  meta: parseModule(readFileSync(path, 'utf8'), path).meta,
}));

/** Anchors the interface sets, read from the code that sets them. */
function anchorsInInterface(): Set<string> {
  const found = new Set<string>();
  const sources = [
    ...files(join(ROOT, 'apps/web/src'), (name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)),
    ...files(join(ROOT, 'packages/grid-core/src'), (name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name)),
  ];
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/\banchor\('([^']+)'\)/g)) found.add(match[1]!);
    for (const match of text.matchAll(/data-anchor="([a-z][A-Za-z0-9.]*)"/g)) found.add(match[1]!);
    // Help headings and typed settings maps pass their marks through a shared component.
    for (const match of text.matchAll(/anchorId(?:=|:)\s*["']([^"']+)["']/g)) found.add(match[1]!);
    for (const match of text.matchAll(/dataset\.anchor = '([^']+)'/g)) found.add(match[1]!);
  }
  return found;
}

/** Keys the items a demo points at can have, by the anchor whose menu or list holds them */
const ITEM_KEYS: Record<string, readonly string[]> = {
  'database.views.add': VIEW_TYPES,
  'field.type': FIELD_TYPES,
  'database.table.menu': ['rename', 'duplicate', 'delete', 'findLinks', 'findDuplicates', 'importInto'],
  'database.menu': [
    'theme',
    'snapshots',
    'duplicate',
    'saveTemplate',
    'webhooks',
    'airtableReport',
    'platformReport',
  ],
  'view.menu': [
    'csv',
    'xlsx',
    'docx',
    'pptx',
    'pdf',
    'reports',
    'subscribe',
    'rename',
    'duplicate',
    'share',
    'delete',
  ],
};

describe('shipped demos', () => {
  it('cover the core help modules, and each one belongs to a module that offers it', () => {
    const ids = demos.map(({ script }) => script.id).sort();
    expect(ids.length).toBeGreaterThanOrEqual(25);
    expect(ids).toEqual(
      expect.arrayContaining([
        'databases-and-tables',
        'fields',
        'views',
        'kanban',
        'forms',
        'linked-records',
        'formulas',
        'sharing',
        'automations',
        'asking-rio',
        'dashboards',
        'interfaces',
        'sites',
        'scheduled-reports',
        'public-view-links',
        'importing',
        'synced-tables',
        'comments-and-history',
        'field-and-record-permissions',
        'trash-and-favorites',
        'snapshots-and-copies',
        'downloading',
        'merging-duplicates',
        'palette',
        'notifications',
      ]),
    );
    for (const { directory, script, path } of demos) {
      const module = modules.find((entry) => entry.directory === directory);
      expect(module?.meta.id, path).toBe(script.id);
      expect(module?.meta.demo, path).toBe(script.id);
    }
    for (const { meta, directory } of modules.filter((entry) => entry.meta.demo))
      expect(
        demos.some((demo) => demo.directory === directory),
        meta.id,
      ).toBe(true);
  });

  it('never press, type into, or choose anything that saves, sends, deletes, publishes, or leaves', () => {
    const problems: string[] = [];
    for (const { path, script } of demos) {
      script.steps.forEach((step, index) => {
        const where = `${path} step ${index + 1}`;
        const info = anchorInfo(step.anchor);
        if (!info) return;
        if (step.item && !info.items) problems.push(`${where}: ${step.anchor} has no items`);
        if (!step.do || step.do === 'scroll' || step.do === 'wait') return;
        if (step.item) {
          if (step.do === 'choose' && info.items !== 'local') problems.push(`${where}: its items save`);
          else if (step.do !== 'choose') problems.push(`${where}: only a choice acts on an item`);
        } else if (info.persists || info.external) problems.push(`${where}: ${step.anchor} saves or leaves`);
      });
    }
    expect(problems).toEqual([]);
  });

  it('point only at anchors the interface sets', () => {
    const inInterface = anchorsInInterface();
    const registered = new Set(Object.keys(ANCHORS));
    // Every registered anchor is set somewhere, so a demo can find it.
    expect([...registered].filter((id) => !inInterface.has(id))).toEqual([]);
    // And the interface sets no anchor the registry doesn't know, so none escapes its marks.
    expect([...inInterface].filter((id) => !registered.has(id))).toEqual([]);
    const missing: string[] = [];
    for (const { path, script } of demos)
      for (const step of script.steps) {
        if (!registered.has(step.anchor)) missing.push(`${path}: ${step.anchor}`);
        const keys = step.item ? ITEM_KEYS[step.anchor] : undefined;
        if (step.item && !keys?.includes(step.item)) missing.push(`${path}: ${step.anchor} → ${step.item}`);
      }
    expect(missing).toEqual([]);
  });

  it('say and type only lines that have text, so every line can be translated', () => {
    const catalog = readFileSync(join(ROOT, 'apps/web/src/locales/en-US/messages.po'), 'utf8');
    const ids = new Set([...catalog.matchAll(/^msgid "([^"]+)"$/gm)].map((match) => match[1]!));
    const missing: string[] = [];
    for (const { path, script } of demos)
      for (const step of script.steps)
        for (const id of [step.say, step.text].filter((id): id is string => Boolean(id))) {
          if (!NARRATION[id]?.message) missing.push(`${path}: ${id} has no text`);
          if (!ids.has(id)) missing.push(`${path}: ${id} isn't in the catalog`);
        }
    expect(missing).toEqual([]);
  });

  it('keep narration short and plain, one idea to a step', () => {
    const problems: string[] = [];
    for (const [id, descriptor] of Object.entries(NARRATION)) {
      const text = descriptor.message ?? '';
      if (text.includes(';')) problems.push(`${id}: a semicolon`);
      if (/\. [A-Z]/.test(text)) problems.push(`${id}: one space after a sentence`);
      if (text.length > 120) problems.push(`${id}: too long for one step`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the demo loader', () => {
  it('loads a module’s demo, and refuses one that names another module', async () => {
    const script = { id: 'fields', where: 'table', steps: [{ anchor: 'grid', say: 'demos.fields.add' }] };
    const loader = createDemoLoader({
      '/databases/fields/demo.json': async () => script,
      '/databases/views/demo.json': async () => script,
    });
    expect(await loader.loadDemo('fields')).toEqual(script);
    expect(await loader.loadDemo('kanban')).toBeNull();
    await expect(loader.loadDemo('views')).rejects.toThrow('doesn');
  });

  it('refuses a step with an action outside the fixed set', () => {
    const step = { anchor: 'grid', say: 'demos.fields.add' };
    expect(DemoScript.safeParse({ id: 'x', where: 'table', steps: [{ ...step, do: 'click' }] }).success).toBe(
      false,
    );
    expect(DemoScript.safeParse({ id: 'x', where: 'table', steps: [{ ...step, do: 'type' }] }).success).toBe(
      false,
    );
    expect(
      DemoScript.safeParse({ id: 'x', where: 'table', steps: [{ ...step, do: 'wait', ms: 500 }] }).success,
    ).toBe(true);
  });
});
