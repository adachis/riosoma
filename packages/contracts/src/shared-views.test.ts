import { describe, expect, it } from 'vitest';
import {
  EmbedSite,
  FieldMeta,
  GridConfig,
  embedAncestors,
  embedSite,
  newId,
  requiredFieldIds,
  SharedViewSettings,
  SharedViewUpdate,
  sharedFieldIds,
  type FieldSpec,
} from './index.js';

const tableId = newId('table');
let position = 0;
function field(spec: FieldSpec['type'] | { type: FieldSpec['type']; options?: unknown }): FieldMeta {
  position += 1;
  const value = typeof spec === 'string' ? { type: spec } : spec;
  return FieldMeta.parse({
    ...value,
    id: newId('field'),
    tableId,
    name: `Field ${position}`,
    description: '',
    position,
    createdAt: '',
    updatedAt: '',
  });
}

describe('embedding sites', () => {
  it('reads what people type as an origin', () => {
    expect(embedSite('Example.test')).toBeNull();
    expect(embedSite(' https://blog.example.test/posts/1?x=1#top ')).toBeNull();
    expect(embedSite('http://localhost:5173')).toBe('http://localhost:5173');
    expect(embedSite('*.example.test')).toBeNull();
    expect(embedSite('https://*.example.test:8443/')).toBeNull();
    expect(embedSite('https://bücher.example')).toBe('https://xn--bcher-kva.example');
    for (const text of [
      '',
      'javascript:alert(1)',
      'ftp://example.test',
      'https://user:pw@example.test',
      '::',
    ])
      expect(embedSite(text), text).toBeNull();
  });

  it('accepts only plain origins, so nothing can slip into a header', () => {
    for (const site of ['https://example.test', 'http://a.b.example.test:8080'])
      expect(EmbedSite.safeParse(site).success, site).toBe(true);
    for (const site of [
      'https://example.test/',
      'https://*.example.test',
      'https://example.test:99999',
      'https://example.test; script-src *',
      'https://example.test https://other.test',
      "'self'",
      '*',
      'https://*',
      'https://exa mple.test',
      'HTTPS://EXAMPLE.TEST',
      'https://example.test\r\nset-cookie: x=1',
    ])
      expect(EmbedSite.safeParse(site).success, site).toBe(false);
  });

  it('refuses hosts the URL parser reads loosely, so a site can’t add a directive', () => {
    // A host may hold a semicolon, a comma, or a quote as far as the parser is concerned, and each
    // of those would start a directive of its own once the sites are joined into a header.
    for (const site of [
      'https://a.test;sandbox',
      'https://a.test;script-src-elem',
      'https://a.test;report-uri',
      'https://a.test; report-uri https://collector.test',
      'https://a.test,b.test',
      "https://a.test'",
      'https://a.test"',
      'https://a.test`',
      'https://a.test|',
      'https://a..b.test',
      'https://-a.test',
      'https://a.test.',
      'https://a.test\t',
    ]) {
      expect(EmbedSite.safeParse(site).success, site).toBe(false);
      if (!site.endsWith('\t')) expect(embedSite(site), site).toBeNull();
    }
    // A line people type is trimmed first, so trailing whitespace isn't a way in either.
    expect(embedSite('https://a.test\t')).toBe('https://a.test');
  });

  it('names only exact origins in a frame policy', () => {
    const sites = ['https://blog.example.test', 'http://localhost:5173'];
    expect(embedAncestors({ enabled: true, sites })).toEqual(sites);
    expect(embedAncestors({ enabled: false, sites })).toEqual([]);
    expect(embedAncestors(null)).toEqual([]);
    expect(embedAncestors(undefined)).toEqual([]);
    // A stored rule that no longer fits, from an older version or a write that skipped the checks,
    // loses every site rather than widening who may frame the page.
    for (const stored of [
      { enabled: true, sites: ['https://a.test;sandbox'] },
      { enabled: true, sites: ['https://blog.example.test', 'https://*.example.test'] },
      { enabled: true, sites: ['https://a.test,b.test'] },
      { enabled: true },
      { enabled: 'yes', sites: 'https://a.test' },
    ])
      expect(embedAncestors(stored as never), JSON.stringify(stored)).toEqual([]);
    for (const named of embedAncestors({ enabled: true, sites }))
      expect(/[\s;,'"`|]/.test(named), named).toBe(false);
  });
});

describe('settings', () => {
  it('start private: every field the view shows, no copying, no embedding, no password', () => {
    expect(SharedViewSettings.parse({})).toEqual({
      fieldIds: null,
      allowCopy: false,
      embed: { enabled: false, sites: [] },
    });
    expect(SharedViewUpdate.safeParse({ password: 'short' }).success).toBe(false);
    expect(SharedViewUpdate.safeParse({ password: null }).success).toBe(true);
  });
});

describe('shared fields', () => {
  const name = field('text');
  const secret = field('text');
  const status = field({
    type: 'singleSelect',
    options: { choices: [{ id: newId('choice'), name: 'Open', color: 'blue' }] },
  });
  const people = field({ type: 'user', options: { allowMultiple: true } });
  const photo = field('attachment');
  const due = field('date');
  const notes = field('longText');
  const fields = [name, secret, status, people, photo, due, notes];
  const view = (type: 'grid' | 'kanban' | 'gallery' | 'calendar', config: Partial<GridConfig> = {}) => ({
    type,
    config: GridConfig.parse({ hiddenFieldIds: [secret.id], ...config }),
  });

  it('always include what the layout needs', () => {
    expect(requiredFieldIds(view('grid'), fields, name.id)).toEqual([name.id]);
    expect(
      requiredFieldIds(
        view('kanban', {
          kanban: { ...GridConfig.parse({}).kanban, stackFieldId: status.id, coverFieldId: photo.id },
        }),
        fields,
        name.id,
      ),
    ).toEqual([name.id, status.id, photo.id]);
    // A user field holding several people can't make stacks, and a text field can't be a cover.
    expect(
      requiredFieldIds(
        view('kanban', {
          kanban: { ...GridConfig.parse({}).kanban, stackFieldId: people.id, coverFieldId: notes.id },
        }),
        fields,
        name.id,
      ),
    ).toEqual([name.id]);
    expect(
      requiredFieldIds(
        view('calendar', { calendar: { startFieldId: due.id, endFieldId: notes.id, range: 'month' } }),
        fields,
        name.id,
      ),
    ).toEqual([name.id, due.id]);
  });

  it('never include a field the view hides, unless its layout needs it', () => {
    expect(sharedFieldIds(view('grid'), fields, name.id, { fieldIds: null })).toEqual({
      shown: [name.id, status.id, people.id, photo.id, due.id, notes.id],
      hidden: [],
    });
    expect(sharedFieldIds(view('grid'), fields, name.id, { fieldIds: [secret.id, notes.id] })).toEqual({
      shown: [name.id, notes.id],
      hidden: [],
    });
    const board = view('kanban', {
      hiddenFieldIds: [secret.id, status.id],
      kanban: { ...GridConfig.parse({}).kanban, stackFieldId: status.id },
    });
    expect(sharedFieldIds(board, fields, name.id, { fieldIds: [] })).toEqual({
      shown: [name.id],
      hidden: [status.id],
    });
  });
});

it('keeps every required scheduling and summary field while excluding unrelated fields', () => {
  const name = field('text');
  const secret = field('text');
  const start = field('date');
  const end = field('date');
  const group = field('singleSelect');
  const label = field('text');
  const progress = field('percent');
  const dependency = field({ type: 'link', options: { linkedTableId: tableId } });
  const fields = [name, secret, start, end, group, label, progress, dependency];
  const config = GridConfig.parse({
    hiddenFieldIds: fields.filter((item) => item !== name).map((item) => item.id),
    timeline: { startFieldId: start.id, endFieldId: end.id, groupFieldId: group.id, labelFieldId: label.id },
    gantt: {
      startFieldId: start.id,
      endFieldId: end.id,
      dependencyFieldId: dependency.id,
      progressFieldId: progress.id,
      labelFieldId: label.id,
    },
    chart: { groupBy: { fieldId: group.id }, seriesBy: label.id, value: { fn: 'sum', fieldId: progress.id } },
    pivot: {
      rows: [{ fieldId: group.id }],
      column: { fieldId: label.id },
      values: [{ fn: 'sum', fieldId: progress.id }],
    },
  });
  for (const [type, required] of [
    ['timeline', [start.id, end.id, group.id, label.id]],
    ['gantt', [start.id, end.id, dependency.id, progress.id, label.id]],
    ['chart', [group.id, label.id, progress.id]],
    ['pivot', [group.id, label.id, progress.id]],
  ] as const) {
    expect(sharedFieldIds({ type, config }, fields, name.id, { fieldIds: [] })).toEqual({
      shown: [name.id],
      hidden: [...required],
    });
    if (type === 'chart' || type === 'pivot') {
      const shared = sharedFieldIds({ type, config: { ...config, hiddenFieldIds: [] } }, fields, name.id, {
        fieldIds: null,
      });
      expect(new Set([...shared.shown, ...shared.hidden])).toEqual(new Set([name.id, ...required]));
    }
  }
});
