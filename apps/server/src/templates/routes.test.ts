import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DatabaseSchema,
  TEMPLATE_CATEGORIES,
  describeTemplate,
  newId,
  type DashboardData,
  type FieldMeta,
  type RowData,
  type RowsPage,
  type ViewAggregate,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { startTestPostgres, type TestPostgres } from '@riosoma/testkit';
import { startServer, type ServerFixture } from '../test/fixture.js';
import { templates } from './index.js';
import { buttonFieldNames, fieldOrder } from './instantiate.js';
import type {
  SampleValue,
  StarterTemplate,
  TemplateField,
  TemplateFilter,
  TemplateTable,
  TemplateView,
} from './types.js';

let kit: TestPostgres;
let server: ServerFixture;
beforeAll(async () => {
  kit = await startTestPostgres();
  server = await startServer(kit, 'templates', { logLevel: 'error' });
}, 60_000);
afterAll(async () => {
  await server?.close();
  await kit?.stop();
});

async function create(templateId: string, id = newId('database'), name?: string) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/api/databases/from-template',
    headers: server.owner.headers,
    payload: { id, templateId, ...(name ? { name } : {}) },
  });
  expect(response.statusCode, response.body).toBe(200);
  return DatabaseSchema.parse(response.json());
}
async function get<T>(url: string): Promise<T> {
  const response = await server.app.inject({ url, headers: server.owner.headers });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
async function post<T>(url: string, payload: Record<string, unknown>): Promise<T> {
  const response = await server.app.inject({ method: 'POST', url, headers: server.owner.headers, payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}

/** Spellings and words a template's copy never uses, since it's written in American English. */
const BRITISH =
  /\b(colour|favourite|behaviour|honour|neighbour|flavour|labour|centre|theatre|metre|litre|catalogue|organis\w*|realis(?:e|ed|es|ing)|recognis\w*|apologis\w*|analys(?:e|ed|es|ing)|prioritis\w*|travell(?:ed|ing|er)|cancell(?:ed|ing)|labell(?:ed|ing)|modell(?:ed|ing)|jeweller|counsellor|defence|offence|licence|practise|grey|programme|whilst|amongst|towards|learnt|spelt|cheque|enrolment|fulfil|judgement|aluminium|mould|sceptical|tyre|kerb|storey)\b/i;

/** The words people read: names, descriptions, choices, form copy, and sample text. */
function copyOf(template: StarterTemplate): string[] {
  const copy = [template.name, template.description];
  for (const table of template.tables) {
    copy.push(table.name);
    for (const field of table.fields) {
      copy.push(field.name, field.description ?? '');
      if (field.type === 'singleSelect' || field.type === 'multipleSelect')
        copy.push(...field.options.choices.map((choice) => choice.name));
      if (field.type === 'button') copy.push(field.options?.label ?? '');
    }
    for (const view of table.views)
      copy.push(
        view.name,
        ...Object.values(view.form ?? {}).filter((value) => typeof value === 'string'),
        ...(view.questions ?? []).flatMap((question) => [question.label ?? '', question.help ?? '']),
      );
    for (const record of table.records)
      for (const [key, value] of Object.entries(record.values)) {
        const field = table.fields.find((candidate) => candidate.key === key);
        if (field?.type === 'link') continue;
        if (typeof value === 'string') copy.push(value);
        if (Array.isArray(value)) copy.push(...value);
        if (value && typeof value === 'object' && 'label' in value && value.label) copy.push(value.label);
      }
  }
  for (const dashboard of template.dashboards ?? [])
    copy.push(
      dashboard.name,
      ...dashboard.tiles.map((tile) => (tile.kind === 'text' ? tile.text : tile.title)),
    );
  for (const automation of template.automations ?? [])
    copy.push(automation.name, ...automation.steps.map((step) => step.name ?? ''));
  return copy.filter(Boolean);
}

function filterFields(filter: TemplateFilter | undefined): string[] {
  return filter?.conditions.map((condition) => condition.field) ?? [];
}

/** Every field key a view names, in any of its settings. */
function viewFields(view: TemplateView): string[] {
  return [
    ...(view.fieldOrder ?? []),
    ...(view.hiddenFields ?? []),
    ...filterFields(view.filter),
    ...(view.sorts ?? []).map((sort) => sort.field),
    ...Object.keys(view.summaries ?? {}),
    ...[
      view.stackField,
      view.startField,
      view.endField,
      view.groupField,
      view.parentField,
      view.dependencyField,
      view.progressField,
      view.locationField,
      view.colorField,
      view.chart?.groupBy.field,
      view.chart?.value?.field,
      view.chart?.seriesField,
      view.pivot?.column?.field,
    ].filter((key): key is string => Boolean(key)),
    ...(view.pivot?.rows ?? []).map((row) => row.field),
    ...(view.pivot?.values ?? []).flatMap((value) => (value.field ? [value.field] : [])),
    ...(view.questions ?? []).map((question) => question.field),
  ];
}

it('lists only public template summaries and requires a session', async () => {
  const response = await server.app.inject({ url: '/api/templates' });
  expect(response.statusCode).toBe(401);
  expect(await get('/api/templates')).toEqual(
    templates.map(({ id, name, description, icon, color, category, tables }) => ({
      id,
      name,
      description,
      icon,
      color,
      category,
      tables: tables.map((table) => table.name),
    })),
  );
});

it('offers twenty templates across work, personal, and organizations, with unique names', () => {
  expect(templates).toHaveLength(20);
  expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length);
  expect(new Set(templates.map((template) => template.name)).size).toBe(templates.length);
  for (const category of TEMPLATE_CATEGORIES)
    expect(templates.filter((template) => template.category === category).length).toBeGreaterThanOrEqual(4);
});

describe.each(templates)('$name', (template) => {
  it('connects two to four tables with keys, links, and settings that all resolve, in calm American copy', () => {
    expect(TEMPLATE_CATEGORIES).toContain(template.category);
    expect(template.tables.length).toBeGreaterThanOrEqual(2);
    expect(template.tables.length).toBeLessThanOrEqual(4);
    expect(template.description).toMatch(/^[A-Z].*\.$/);
    for (const text of copyOf(template)) {
      expect(text, 'American spelling').not.toMatch(BRITISH);
      // An initial, as in a pen name like A. Brook, isn't the end of a sentence.
      expect(text, 'two spaces between sentences').not.toMatch(/(?<!\b[A-Z])[.!?] [A-Z0-9"]/);
      expect(text, 'no semicolons').not.toContain(';');
    }
    const tableOf = (key: string) => template.tables.find((table) => table.key === key);
    const fieldOf = (table: TemplateTable | undefined, key: string) =>
      table?.fields.find((field) => field.key === key);
    const unique = (values: string[]) => expect(new Set(values).size).toBe(values.length);
    unique(template.tables.map((table) => table.key));
    unique(template.tables.map((table) => table.name.toLowerCase()));
    for (const table of template.tables) {
      unique(table.fields.map((field) => field.key));
      unique(table.fields.map((field) => field.name.toLowerCase()));
      unique(table.views.map((view) => view.key));
      unique(table.views.map((view) => view.name.toLowerCase()));
      unique(table.records.map((record) => record.key));
      expect(table.fields[0]!.type).toBe('text');
      expect(table.views[0]!.type).toBe('grid');
      const known = (key: string) => expect(fieldOf(table, key), `${table.key}.${key}`).toBeDefined();
      for (const field of table.fields) {
        if (field.type === 'link') {
          const inverse = fieldOf(tableOf(field.options.linkedTableKey), field.options.inverseFieldKey);
          expect(inverse?.type, `${table.key}.${field.key}`).toBe('link');
          if (inverse?.type !== 'link') continue;
          expect(inverse.options.linkedTableKey).toBe(table.key);
          expect(inverse.options.inverseFieldKey).toBe(field.key);
          // Exactly one side of each pair is created as the inverse of the other.
          expect(Boolean(field.inverse) !== Boolean(inverse.inverse), `${table.key}.${field.key}`).toBe(true);
        }
        if (field.type === 'lookup' || field.type === 'rollup' || field.type === 'count') {
          const link = fieldOf(table, field.options.linkFieldKey);
          expect(link?.type).toBe('link');
          if (field.type !== 'count' && link?.type === 'link')
            expect(fieldOf(tableOf(link.options.linkedTableKey), field.options.targetFieldKey)).toBeDefined();
        }
        for (const name of buttonFieldNames(field))
          expect(
            table.fields.some((other) => other.name.toLowerCase() === name.toLowerCase()),
            name,
          ).toBe(true);
      }
      for (const view of table.views) viewFields(view).forEach(known);
      for (const record of table.records)
        for (const [key, value] of Object.entries(record.values)) {
          const field = fieldOf(table, key);
          expect(field, `${table.key}.${record.key}.${key}`).toBeDefined();
          if (field?.type === 'link') {
            const target = tableOf(field.options.linkedTableKey)!;
            // Sample links point at records the template really creates.
            for (const recordKey of value as string[])
              expect(target.records.map((other) => other.key)).toContain(recordKey);
            if (field.options.prefersSingle) expect((value as string[]).length).toBeLessThanOrEqual(1);
          }
          if ((field?.type === 'singleSelect' || field?.type === 'multipleSelect') && value !== null) {
            const names = field.options.choices.map((choice) => choice.name);
            for (const name of Array.isArray(value) ? value : [value]) expect(names).toContain(name);
          }
        }
    }
    for (const dashboard of template.dashboards ?? []) {
      unique(dashboard.tiles.map((tile) => tile.key));
      for (const tile of dashboard.tiles) {
        if (tile.kind === 'text') continue;
        const table = tableOf(tile.table);
        expect(table, tile.key).toBeDefined();
        if (tile.view) expect(table!.views.map((view) => view.key)).toContain(tile.view);
        const fields =
          tile.kind === 'number'
            ? [tile.value.field]
            : tile.kind === 'chart'
              ? [tile.chart.groupBy.field, tile.chart.value?.field, tile.chart.seriesField]
              : tile.fields;
        for (const key of fields) if (key) expect(fieldOf(table, key), key).toBeDefined();
      }
    }
    for (const automation of template.automations ?? []) {
      const table = tableOf(automation.trigger.table);
      expect(table).toBeDefined();
      const trigger = automation.trigger;
      const keys = [
        ...filterFields(automation.conditions),
        ...(trigger.kind === 'recordMatches' ? filterFields(trigger.filter) : []),
        ...(trigger.kind === 'recordUpdated' ? (trigger.fields ?? []) : []),
        ...automation.steps.flatMap((step) => [
          ...Object.keys(step.values),
          ...Object.values(step.values).flatMap((text) =>
            [...text.matchAll(/\{\{\s*trigger\.record\.([A-Za-z0-9_-]+)\s*\}\}/g)].map((match) => match[1]!),
          ),
        ]),
      ];
      for (const key of keys) expect(fieldOf(table, key), key).toBeDefined();
      if (trigger.kind === 'formSubmitted')
        expect(table!.views.find((view) => view.key === trigger.view)?.type).toBe('form');
    }
  });

  it('creates matching fields, settings, sample values, and working computed values; retries and undoes as one action', async () => {
    const before = new Date();
    const schema = await create(template.id);
    const after = new Date();
    expect(schema.database).toMatchObject({
      name: template.name,
      icon: template.icon,
      color: template.color,
      role: 'owner',
    });
    expect(schema.tables.map((table) => table.name)).toEqual(template.tables.map((table) => table.name));
    expect(schema.fields).toHaveLength(template.tables.reduce((sum, table) => sum + table.fields.length, 0));
    expect(schema.views).toHaveLength(template.tables.reduce((sum, table) => sum + table.views.length, 0));
    const fields = new Map<string, FieldMeta>();
    const rows = new Map<string, RowData[]>();
    const viewIds = new Map<string, string>();
    const day = (days: number) => {
      const offset = (moment: Date) => {
        const date = new Date(moment);
        date.setUTCDate(date.getUTCDate() + days);
        return date.toISOString().slice(0, 10);
      };
      return [offset(before), offset(after)];
    };
    for (const table of template.tables) {
      const actual = schema.tables.find((value) => value.name === table.name)!;
      for (const field of table.fields) {
        const found = schema.fields.find(
          (value) => value.tableId === actual.id && value.name === field.name,
        )!;
        expect(found, field.name).toBeDefined();
        expect(found.type).toBe(field.type);
        fields.set(`${table.key}.${field.key}`, found);
      }
      for (const view of table.views) {
        const found = schema.views.find((value) => value.tableId === actual.id && value.name === view.name)!;
        expect(found, view.name).toBeDefined();
        viewIds.set(`${table.key}.${view.key}`, found.id);
      }
      const page = await get<RowsPage>(`/api/views/${viewIds.get(`${table.key}.grid`)}/rows`);
      expect(page.total).toBe(table.records.length);
      expect(page.rows).toHaveLength(table.records.length);
      expect(table.records.length).toBeGreaterThanOrEqual(15);
      expect(table.records.length).toBeLessThanOrEqual(40);
      const present = page.rows.filter((row): row is RowData => row !== null);
      rows.set(table.key, present);
      for (const row of present) {
        expect(row.errors ?? {}).toEqual({});
        const direct = await get<RowData>(`/api/tables/${actual.id}/records/${row.id}`);
        expect(direct.errors ?? {}).toEqual({});
        expect(direct.values).toEqual(row.values);
      }
    }
    const fieldId = (table: string, key: string) => fields.get(`${table}.${key}`)!.id;
    const optional = (table: string, key: string | undefined) => (key ? fieldId(table, key) : null);
    const choiceId = (table: string, key: string, name: string) => {
      const field = fields.get(`${table}.${key}`)!;
      if (field.type !== 'singleSelect' && field.type !== 'multipleSelect')
        throw new Error('Expected a select');
      return field.options.choices.find((choice) => choice.name === name)!.id;
    };
    const filter = (table: TemplateTable, value: TemplateFilter | undefined) =>
      value
        ? {
            conjunction: value.conjunction,
            conditions: value.conditions.map((condition) => {
              const field = table.fields.find((candidate) => candidate.key === condition.field)!;
              const select = field.type === 'singleSelect' || field.type === 'multipleSelect';
              const choice = (name: string) => choiceId(table.key, field.key, name);
              return expect.objectContaining({
                fieldId: fieldId(table.key, condition.field),
                operator: condition.operator,
                ...(condition.value === undefined
                  ? {}
                  : {
                      value:
                        select && typeof condition.value === 'string'
                          ? choice(condition.value)
                          : select && Array.isArray(condition.value)
                            ? condition.value.map(choice)
                            : condition.value,
                    }),
              });
            }),
          }
        : null;
    for (const table of template.tables) {
      const key = table.key;
      for (const view of table.views) {
        const actualView = schema.views.find((value) => value.id === viewIds.get(`${key}.${view.key}`))!;
        const { config } = actualView;
        expect(actualView.type).toBe(view.type);
        expect(config.fieldOrder).toEqual(fieldOrder(table, view).map((field) => fieldId(key, field)));
        if (view.hiddenFields)
          expect(config.hiddenFieldIds).toEqual(view.hiddenFields.map((f) => fieldId(key, f)));
        expect(config.filter).toEqual(filter(table, view.filter));
        expect(config.sorts).toEqual(
          (view.sorts ?? []).map((sort) => ({
            fieldId: fieldId(key, sort.field),
            direction: sort.direction,
          })),
        );
        expect(Object.keys(config.summaries)).toEqual(
          Object.keys(view.summaries ?? {}).map((field) => fieldId(key, field)),
        );
        if (view.stackField) expect(config.kanban.stackFieldId).toBe(fieldId(key, view.stackField));
        const dates = {
          startFieldId: optional(key, view.startField),
          endFieldId: optional(key, view.endField),
        };
        if (view.type === 'calendar') expect(config.calendar).toMatchObject(dates);
        if (view.type === 'timeline')
          expect(config.timeline).toMatchObject({ ...dates, groupFieldId: optional(key, view.groupField) });
        if (view.type === 'gantt')
          expect(config.gantt).toMatchObject({
            ...dates,
            dependencyFieldId: optional(key, view.dependencyField),
            progressFieldId: optional(key, view.progressField),
          });
        if (view.type === 'list')
          expect(config.list).toMatchObject({
            groupFieldId: optional(key, view.groupField),
            parentFieldId: optional(key, view.parentField),
          });
        if (view.type === 'map')
          expect(config.map).toEqual({
            locationFieldId: optional(key, view.locationField),
            colorFieldId: optional(key, view.colorField),
          });
        if (view.chart) {
          expect(config.chart).toMatchObject({
            chart: view.chart.type ?? 'column',
            groupBy: { fieldId: fieldId(key, view.chart.groupBy.field) },
            value: { fn: view.chart.value?.fn ?? 'count', fieldId: optional(key, view.chart.value?.field) },
            seriesBy: optional(key, view.chart.seriesField),
          });
        }
        if (view.pivot)
          expect(config.pivot.rows.map((row) => row.fieldId)).toEqual(
            view.pivot.rows.map((row) => fieldId(key, row.field)),
          );
        if (view.questions)
          expect(config.form.questions).toEqual(
            view.questions.map((question) => ({
              fieldId: fieldId(key, question.field),
              required: question.required ?? false,
              label: question.label ?? '',
              help: question.help ?? '',
            })),
          );
        // Charts, pivots, and summary rows compute, and every filtered view shows some records.
        const aggregate = `/api/databases/${schema.database.id}/views/${actualView.id}/aggregate`;
        if (view.type === 'chart' || view.type === 'pivot') {
          const result = await post<ViewAggregate>(aggregate, { timeZone: 'UTC' });
          expect(result.kind, `${view.name}: ${JSON.stringify(result)}`).toBe(view.type);
        }
        if (view.summaries) {
          const result = await post<ViewAggregate>(aggregate, { timeZone: 'UTC', summary: true });
          if (result.kind !== 'summary') throw new Error(`Expected a summary for ${view.name}`);
          expect(Object.keys(result.values).sort()).toEqual(
            Object.keys(view.summaries)
              .map((field) => fieldId(key, field))
              .sort(),
          );
        }
        if (view.filter && view.type !== 'chart' && view.type !== 'pivot') {
          const page = await get<RowsPage>(`/api/views/${actualView.id}/rows`);
          expect(page.total, view.name).toBeGreaterThan(0);
          expect(page.total, view.name).toBeLessThan(table.records.length);
        }
      }
    }
    for (const table of template.tables) {
      for (const field of table.fields) {
        const actual = fields.get(`${table.key}.${field.key}`)!;
        if (field.type === 'link' && actual.type === 'link') {
          const target = template.tables.find((value) => value.key === field.options.linkedTableKey)!;
          expect(actual.options.linkedTableId).toBe(
            schema.tables.find((value) => value.name === target.name)!.id,
          );
          expect(actual.options.inverseFieldId).toBe(fieldId(target.key, field.options.inverseFieldKey));
          expect(actual.options.prefersSingle).toBe(field.options.prefersSingle ?? false);
        }
        if (
          (field.type === 'lookup' || field.type === 'rollup') &&
          (actual.type === 'lookup' || actual.type === 'rollup')
        ) {
          expect(actual.options.linkFieldId).toBe(fieldId(table.key, field.options.linkFieldKey));
          const definition = table.fields.find((value) => value.key === field.options.linkFieldKey)!;
          if (definition.type !== 'link') throw new Error('Expected link');
          expect(actual.options.targetFieldId).toBe(
            fieldId(definition.options.linkedTableKey, field.options.targetFieldKey),
          );
        }
        if (field.type === 'button' && actual.type === 'button') {
          expect(actual.options.action.kind).toBe('openUrl');
          expect(field.options?.action?.kind).toBe('openUrl');
          if (actual.options.action.kind !== 'openUrl' || field.options?.action?.kind !== 'openUrl')
            throw new Error('Expected a link action');
          const siblings = schema.fields.filter((value) => value.tableId === actual.tableId);
          expect(describeTemplate(actual.options.action.urlTemplate, siblings)).toBe(
            field.options?.action?.urlTemplate,
          );
        }
      }
      for (const [index, record] of table.records.entries()) {
        const row = rows.get(table.key)![index]!;
        for (const [key, sample] of Object.entries(record.values)) {
          const field = fields.get(`${table.key}.${key}`)!;
          const definition = table.fields.find((value) => value.key === key)!;
          expectSample(
            row.values[field.id],
            sample,
            field,
            definition,
            `${table.name}: ${record.key}.${key}`,
          );
        }
      }
    }
    function expectSample(
      actual: unknown,
      sample: SampleValue,
      field: FieldMeta,
      definition: TemplateField,
      label: string,
    ) {
      if (sample && typeof sample === 'object' && 'days' in sample) {
        const text = actual as string;
        expect(day(sample.days), label).toContain(text.slice(0, 10));
        if (sample.time) expect(text.slice(11, 16), label).toBe(sample.time);
        return;
      }
      if (sample && typeof sample === 'object' && 'start' in sample) {
        const range = actual as { start: string; end: string };
        expect(day(sample.start.days), label).toContain(range.start.slice(0, 10));
        expect(day(sample.end.days), label).toContain(range.end.slice(0, 10));
        return;
      }
      let expected: unknown = sample === '' ? null : sample;
      if (field.type === 'singleSelect' && sample !== null)
        expected = field.options.choices.find((choice) => choice.name === sample)!.id;
      if (field.type === 'multipleSelect' && Array.isArray(sample))
        expected = sample.map((name) => field.options.choices.find((choice) => choice.name === name)!.id);
      if (definition.type === 'link' && Array.isArray(sample)) {
        const target = template.tables.find((value) => value.key === definition.options.linkedTableKey)!;
        expected = sample.map(
          (recordKey) =>
            rows.get(target.key)![target.records.findIndex((value) => value.key === recordKey)]!.id,
        );
      }
      expect(actual, label).toEqual(expected);
    }
    // Check useful computed results, in addition to the absence of evaluation errors.
    const value = (table: string, field: string, index = 0) =>
      rows.get(table)![index]!.values[fields.get(`${table}.${field}`)!.id];
    COMPUTED[template.id]?.(value);

    expect(schema.dashboards ?? []).toHaveLength(template.dashboards?.length ?? 0);
    for (const dashboard of template.dashboards ?? []) {
      const actual = schema.dashboards!.find((value) => value.name === dashboard.name)!;
      expect(actual.config.tiles.map((tile) => tile.title)).toEqual(
        dashboard.tiles.map((tile) => tile.title),
      );
      const data = await post<DashboardData>(`/api/dashboards/${actual.id}/data`, { timeZone: 'UTC' });
      for (const tile of dashboard.tiles) {
        if (tile.kind === 'text') continue;
        const result = data.tiles[`tile-${tile.key}`]!;
        // Every tile reads some of the sample records.
        if (result.kind === 'number') expect(result.records, tile.title).toBeGreaterThan(0);
        else if (result.kind === 'chart') expect(result.categories.length, tile.title).toBeGreaterThan(0);
        else if (result.kind === 'pivot') expect(result.rows.length, tile.title).toBeGreaterThan(0);
        else if (result.kind === 'records') expect(result.total, tile.title).toBeGreaterThan(0);
        else throw new Error(`${tile.title}: ${result.messageKey}`);
      }
    }
    expect(schema.automations ?? []).toHaveLength(template.automations?.length ?? 0);
    for (const automation of template.automations ?? []) {
      const actual = schema.automations!.find((value) => value.name === automation.name)!;
      expect(actual.enabled).toBe(false);
      const table = automation.trigger.table;
      // Stored JSON keeps its own key order, so the fields compare sorted.
      expect(
        actual.config.steps.map((step) =>
          step.kind === 'updateRecord' ? Object.keys(step.values).sort() : [],
        ),
      ).toEqual(
        automation.steps.map((step) =>
          Object.keys(step.values)
            .map((field) => fieldId(table, field))
            .sort(),
        ),
      );
    }

    const repeated = await create(template.id, schema.database.id, 'Ignored retry name');
    expect(repeated).toEqual(schema);
    const groups = await query<{ group_id: string }>(
      server.pool,
      sql`SELECT DISTINCT group_id FROM ${ident(server.schemas.app, 'changes')} WHERE database_id = ${schema.database.id}`,
    );
    expect(groups.rows).toHaveLength(1);
    const commands = await query<{ count: string }>(
      server.pool,
      sql`SELECT count(*) FROM ${ident(server.schemas.app, 'commands')} WHERE database_id = ${schema.database.id}`,
    );
    expect(Number(commands.rows[0]!.count)).toBeGreaterThan(10);
    const recordCounts = new Map<string, number>();
    for (const table of schema.tables) {
      const before = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.data, table.id)} WHERE __deleted_at IS NULL`,
      );
      recordCounts.set(table.id, Number(before.rows[0]!.count));
    }
    const undo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${schema.database.id}/undo`,
      headers: server.owner.headers,
      payload: {
        groupId: groups.rows[0]!.group_id,
        commandId: newId('command'),
        clientId: newId('client'),
        confirmedMajorCreation: true,
      },
    });
    expect(undo.statusCode, undo.body).toBe(200);
    expect(undo.json(), undo.body).toMatchObject({ status: 'applied', skipped: 0 });
    for (const table of schema.tables) {
      const remaining = await query<{ count: string }>(
        server.pool,
        sql`SELECT count(*) FROM ${ident(server.schemas.data, table.id)} WHERE __deleted_at IS NULL`,
      );
      expect(Number(remaining.rows[0]!.count)).toBe(recordCounts.get(table.id));
    }
    expect(
      (
        await server.app.inject({
          url: `/api/databases/${schema.database.id}/schema`,
          headers: server.owner.headers,
        })
      ).statusCode,
    ).toBe(404);
    for (const kind of ['tables', 'dashboards', 'automations'] as const) {
      const active = await query(
        server.pool,
        sql`SELECT id FROM ${ident(server.schemas.app, kind)} WHERE database_id = ${schema.database.id} AND trashed_at IS NULL`,
      );
      expect(active.rowCount, kind).toBe(schema[kind]?.length ?? 0);
    }
    const redo = await server.app.inject({
      method: 'POST',
      url: `/api/databases/${schema.database.id}/redo`,
      headers: server.owner.headers,
      payload: { groupId: groups.rows[0]!.group_id, commandId: newId('command'), clientId: newId('client') },
    });
    expect(redo.statusCode, redo.body).toBe(200);
    expect(redo.json()).toMatchObject({ status: 'applied', skipped: 0 });
    const restored = await server.app.inject({
      url: `/api/databases/${schema.database.id}/schema`,
      headers: server.owner.headers,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(DatabaseSchema.parse(restored.json()).tables).toEqual(schema.tables);
  }, 60_000);
});

type Value = (table: string, field: string, index?: number) => unknown;
/** Computed values worth checking by hand, by template. */
const COMPUTED: Record<string, (value: Value) => void> = {
  'project-tracker': (value) => {
    expect(value('projects', 'total')).toBe(2);
    expect(value('projects', 'progress', 1)).toBe(0.5);
  },
  'sales-pipeline': (value) => expect(value('deals', 'weighted')).toBe(300),
  'content-calendar': (value) => expect(value('posts', 'minutes')).toBe(2),
  'event-planning': (value) => {
    expect(value('events', 'cost')).toBe(875);
    expect(value('events', 'remaining')).toBe(1125);
  },
  inventory: (value) => {
    expect(value('products', 'reorder')).toBe('Reorder');
    expect(value('products', 'lead')).toEqual([3]);
  },
  'reading-list': (value) => expect(value('books', 'progress', 2)).toBe(1),
  'bug-tracker': (value) => {
    expect(value('bugs', 'number', 2)).toBe(3);
    expect(value('bugs', 'days')).toBe(6);
    expect(value('bugs', 'days', 1)).toBe(5);
    expect(value('bugs', 'open', 1)).toBe(0);
    expect(value('team', 'open')).toBe(2);
    expect(value('releases', 'count', 10)).toBe(7);
  },
  'product-roadmap': (value) => {
    expect(value('features', 'score')).toBeCloseTo(7.5, 6);
    expect(value('features', 'requests', 6)).toBe(2);
    expect(value('releases', 'count', 7)).toBe(4);
  },
  'hiring-pipeline': (value) => {
    expect(value('candidates', 'score')).toBe(4.5);
    expect(value('candidates', 'score', 3)).toBeCloseTo(4.33, 2);
    expect(value('openings', 'count')).toBe(3);
    expect(value('openings', 'days')).toBe(40);
    expect(value('openings', 'days', 7)).toBeNull();
  },
  'employee-directory': (value) => {
    expect(value('people', 'years')).toBe(7);
    expect(value('teams', 'headcount')).toBe(5);
    expect(value('offices', 'headcount')).toBe(8);
  },
  'support-tickets': (value) => {
    expect(value('tickets', 'hours')).toBeNull();
    expect(value('tickets', 'hours', 1)).toBe(4.5);
    expect(value('customers', 'total')).toBe(2);
    expect(value('customers', 'open')).toBe(1);
    expect(value('customers', 'satisfaction')).toBe(4);
    expect(value('agents', 'assigned', 2)).toBe(5);
    expect(value('agents', 'open', 2)).toBe(2);
    expect(value('agents', 'rating', 2)).toBeCloseTo(4.67, 2);
  },
  'marketing-campaigns': (value) => {
    expect(value('campaigns', 'spent')).toBe(15800);
    expect(value('campaigns', 'remaining')).toBe(24200);
    expect(value('campaigns', 'conversions')).toBe(850);
    expect(value('campaigns', 'cost')).toBeCloseTo(18.588, 3);
    expect(value('campaigns', 'starts')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value('activities', 'rate')).toBeCloseTo(7.381, 3);
    expect(value('activities', 'rate', 14)).toBeNull();
    expect(value('audiences', 'count')).toBe(4);
  },
  okrs: (value) => {
    expect(value('results', 'progress')).toBe(60);
    expect(value('results', 'progress', 1)).toBe(75);
    expect(value('results', 'progress', 17)).toBe(100);
    expect(value('results', 'progress', 24)).toBe(0);
    expect(value('results', 'last')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value('objectives', 'count')).toBe(2);
    expect(value('objectives', 'progress')).toBe(67.5);
  },
  'meeting-notes': (value) => {
    expect(value('meetings', 'length', 1)).toBe(7200);
    expect(value('meetings', 'open', 2)).toBe(1);
    expect(value('meetings', 'open', 6)).toBe(2);
    expect(value('people', 'open', 1)).toBe(3);
    expect(value('actions', 'late', 5)).toBe(true);
    expect(value('actions', 'late', 10)).toBe(false);
    expect(value('decisions', 'decided')).toMatch(/T15:00:00/);
  },
  'vendor-contracts': (value) => {
    expect(value('vendors', 'spend')).toBe(30000);
    expect(value('vendors', 'renewal')).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(value('contracts', 'left')).toBe(65);
    expect(value('contracts', 'noticeBy')).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(value('contracts', 'invoiced', 4)).toBe(7500);
    expect(value('contracts', 'category')).toHaveLength(1);
    expect(value('invoices', 'payment')).toBe('Paid');
    expect(value('invoices', 'payment', 2)).toBe('Due');
    expect(value('invoices', 'payment', 9)).toBe('Overdue');
  },
  'asset-checkout': (value) => {
    expect(value('assets', 'times')).toBe(2);
    expect(value('assets', 'out')).toBe(1);
    expect(value('assets', 'out', 1)).toBe(0);
    expect(value('checkouts', 'days')).toBe(6);
    expect(value('checkouts', 'overdue', 29)).toBe(true);
    expect(value('checkouts', 'overdue', 28)).toBe(false);
    expect(value('borrowers', 'out', 5)).toBe(1);
  },
  'course-planner': (value) => {
    expect(value('courses', 'grade')).toBe('A');
    expect(value('courses', 'grade', 2)).toBe('C');
    expect(value('courses', 'grade', 5)).toBeNull();
    expect(value('courses', 'count', 5)).toBe(7);
    expect(value('courses', 'average', 5)).toBeCloseTo(0.8667, 4);
    expect(value('assignments', 'left', 10)).toBe(1);
    expect(value('assignments', 'left', 6)).toBeNull();
    expect(value('sessions', 'length', 1)).toBe(5400);
  },
  'household-budget': (value) => {
    expect(value('categories', 'spent', 1)).toBeCloseTo(823.5, 6);
    expect(value('categories', 'left', 1)).toBeCloseTo(-173.5, 6);
    expect(value('categories', 'left', 13)).toBeNull();
    expect(value('bills', 'days')).toBe(3);
  },
  'travel-planner': (value) => {
    expect(value('trips', 'nights', 5)).toBe(9);
    expect(value('trips', 'booked', 5)).toBe(3640);
    expect(value('trips', 'left', 5)).toBe(2860);
    expect(value('trips', 'leaves', 5)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value('bookings', 'starts')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  },
  nonprofit: (value) => {
    expect(value('supporters', 'giving', 1)).toBe(225);
    expect(value('supporters', 'giving', 9)).toBe(7500);
    expect(value('supporters', 'hours', 2)).toBe(7);
    expect(value('supporters', 'hours', 11)).toBe(2);
    expect(value('supporters', 'latest', 1)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(value('shifts', 'filled')).toBe(4);
    expect(value('shifts', 'open')).toBe(4);
    expect(value('shifts', 'open', 12)).toBe(11);
  },
};

it('uses an optional name and serializes concurrent retries', async () => {
  const id = newId('database');
  const [first, second] = await Promise.all([
    create('inventory', id, 'Shop stock'),
    create('inventory', id, 'Shop stock'),
  ]);
  expect(first).toEqual(second);
  expect(first.database.name).toBe('Shop stock');
});

it('refuses guests, unknown templates, invalid IDs, and another creator’s database ID', async () => {
  const guest = await server.addMember({ kind: 'guest' });
  const payload = { id: newId('database'), templateId: 'inventory' };
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/databases/from-template',
        headers: guest.headers,
        payload,
      })
    ).statusCode,
  ).toBe(403);
  expect((await server.app.inject({ url: '/api/templates', headers: guest.headers })).statusCode).toBe(200);
  const unknown = await server.app.inject({
    method: 'POST',
    url: '/api/databases/from-template',
    headers: server.owner.headers,
    payload: { ...payload, templateId: 'missing' },
  });
  expect(unknown.statusCode).toBe(404);
  expect(unknown.json()).toMatchObject({ error: { code: 'not_found' } });
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/databases/from-template',
        headers: server.owner.headers,
        payload: { ...payload, id: 'invalid' },
      })
    ).statusCode,
  ).toBe(422);
  const created = await create('reading-list');
  const member = await server.addMember();
  expect(
    (
      await server.app.inject({
        method: 'POST',
        url: '/api/databases/from-template',
        headers: member.headers,
        payload: { ...payload, id: created.database.id },
      })
    ).statusCode,
  ).toBe(409);
});

it('rolls back the database, grant, commands, and action group when sample validation fails', async () => {
  const broken: StarterTemplate = structuredClone(templates[0]!);
  broken.id = 'invalid-sample';
  broken.tables[1]!.records[0]!.values.effort = 'invalid number';
  templates.push(broken);
  try {
    const id = newId('database');
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/databases/from-template',
      headers: server.owner.headers,
      payload: { id, templateId: broken.id },
    });
    expect(response.statusCode, response.body).toBe(422);
    for (const [table, column] of [
      ['databases', 'id'],
      ['tables', 'database_id'],
      ['commands', 'database_id'],
      ['changes', 'database_id'],
      ['undo_groups', 'database_id'],
      ['grants', 'resource_id'],
    ]) {
      const result = await query(
        server.pool,
        sql`SELECT * FROM ${ident(server.schemas.app, table!)} WHERE ${ident(column!)} = ${id}`,
      );
      expect(result.rowCount).toBe(0);
    }
  } finally {
    templates.pop();
  }
});
