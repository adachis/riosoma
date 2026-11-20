import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@riosoma/contracts';
import type { z } from 'zod';
import { clickupReader } from './clickup/reader.js';
import { linkPlan, valuePlan } from './fields.js';
import type { PlatformClient } from './http.js';
import type { LinkPlan, SourceSchema, SourceTable } from './model.js';
import { planBase } from './plan.js';
import { TaskLinks } from './tasks.js';

const text = (id: string) => valuePlan({ id, name: id }, { type: 'text', options: {} }, (value) => value);
const table = (id: string, fields = [text('name')]): SourceTable => ({
  id,
  name: id,
  primary: 'name',
  fields,
  views: [],
  notes: [],
});

describe('task link capacity', () => {
  it('creates only referenced targets and resolves every selected occurrence', async () => {
    const graph = new TaskLinks();
    const origin = table('origin');
    const first = table('first');
    const second = table('second');
    const unrelated = table('unrelated');
    const schema: SourceSchema = { tables: [origin, first, second, unrelated], notes: [] };
    origin.fields.push(...graph.plans({ id: 'dependencies', name: 'Dependencies' }, schema.tables));
    graph.record('origin', 'a', { dependencies: ['b', 'outside'] });
    graph.record('first', 'b', {});
    graph.record('second', 'b', {});
    graph.finalize(schema);
    const links = origin.fields.filter((field): field is LinkPlan => field.kind === 'link');
    expect(links.map((link) => link.linkedTable)).toEqual(['first', 'second']);
    expect(unrelated.fields).toHaveLength(1);
    for (const link of links) {
      const pages = [];
      for await (const page of graph.links(origin, link, ['a'])) pages.push(...page);
      expect(pages).toEqual([{ record: 'a', targets: ['b'] }]);
    }
    expect(origin.notes).toContainEqual({
      status: 'omitted',
      key: 'import.platform.report.taskLinksOutside',
      params: { count: 1 },
    });
  });

  it('reports references outside the selection even when no link field is created', () => {
    const graph = new TaskLinks();
    const origin = table('origin');
    origin.fields.push(...graph.plans({ id: 'dependencies', name: 'Dependencies' }, [origin]));
    graph.record('origin', 'a', { dependencies: ['outside'] });
    graph.finalize({ tables: [origin], notes: [] });
    expect(origin.fields).toHaveLength(1);
    expect(origin.notes[0]!.params?.count).toBe(1);
  });

  it('keeps custom fields when 121 lists are selected', async () => {
    const client = {
      async json(path: string, schema: z.ZodType) {
        const match = /^\/api\/v2\/list\/([^/]+)(.*)$/.exec(path)!;
        const [, id, suffix] = match;
        const value =
          suffix === '/field'
            ? { fields: [{ id: 'custom', name: 'Custom', type: 'short_text' }] }
            : suffix === '/view'
              ? { views: [] }
              : { id, name: id };
        return schema.parse(value);
      },
    } as PlatformClient;
    const reader = clickupReader({
      platform: 'clickup',
      address: 'https://api.clickup.com',
      credential: { kind: 'token', token: randomBytes(24).toString('hex') },
      client: () => client,
    });
    const ids = Array.from({ length: 121 }, (_, at) => String(at));
    const source = reader.source(ids[0]!, ids.slice(1));
    const schema = await source.schema();
    const plan = planBase(schema);
    for (const item of plan.tables) {
      expect(item.fields.find((field) => field.source.id === 'custom')?.kind).toBe('value');
      expect(item.fields.filter((field) => field.kind === 'link')).toHaveLength(0);
    }
    expect(schema.tables[0]!.notes).toContainEqual(
      expect.objectContaining({
        key: 'import.platform.report.taskLinkCapacity',
      }),
    );
  });

  it('reserves the inverse field and keeps source fields before a link', () => {
    const full = table(
      'full',
      Array.from({ length: LIMITS.fieldsPerTable }, (_, at) => text(String(at))),
    );
    const origin = table('origin', [
      text('name'),
      linkPlan({ id: 'relation', name: 'Relation' }, 'full', null, false, null),
    ]);
    const plan = planBase({ tables: [origin, full], notes: [] });
    expect(plan.tables[0]!.fields.find((field) => field.source.id === 'relation')?.kind).toBe('omitted');
    expect(plan.tables[1]!.fields.every((field) => field.kind === 'value')).toBe(true);
  });

  it('requires two slots for a self link', () => {
    const source = table('self', [
      ...Array.from({ length: LIMITS.fieldsPerTable - 1 }, (_, at) => text(String(at))),
      linkPlan({ id: 'parent', name: 'Parent' }, 'self', null, true, null),
    ]);
    const schema: SourceSchema = { tables: [source], notes: [] };
    expect(planBase(schema).tables[0]!.fields.at(-1)?.kind).toBe('omitted');
  });
});
