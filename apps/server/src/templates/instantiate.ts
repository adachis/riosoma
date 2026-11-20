import { readNamedFunctions } from '../data/named-functions.js';
import { scopeOf } from '../data/commands/context.js';
import { FieldCreate, GridConfig, newId } from '@riosoma/contracts';
import { parse as parseFormula, references, resolve } from '@riosoma/formula';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../data/access.js';
import { actionFor, applyCommand, parseCommand } from '../data/commands/index.js';
import type { CommandContext } from '../data/commands/context.js';
import { recordChange } from '../data/commands/transaction.js';
import { loadField } from '../data/metadata.js';
import type {
  RelativeDay,
  SampleValue,
  StarterTemplate,
  TemplateAutomation,
  TemplateChart,
  TemplateField,
  TemplateFilter,
  TemplateGroup,
  TemplateTable,
  TemplateTile,
  TemplateValue,
  TemplateView,
} from './types.js';

/** Use the command bus's transaction-level operations so failure rolls back the entire template. */
export async function templateCommand(
  c: CommandContext,
  groupId: string,
  input: Record<string, unknown>,
  // One template's commands share a scope, so the creator's role is read once.
  scope = new AccessScope(c.db, c.schemas, c.actor),
): Promise<void> {
  const command = parseCommand({ ...input, id: input.id ?? newId('command'), groupId });
  await scope.require(c.databaseId, actionFor(command.kind));
  const mutation = await applyCommand(c, command);
  const seq = await recordChange(c, mutation, { commandId: command.id, groupId, clientId: null });
  const result = { id: command.id, status: 'applied', seq };
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'commands')}
    (id, org_id, actor_id, database_id, status, result)
    VALUES (${command.id}, ${c.actor.orgId}, ${c.actor.userId}, ${c.databaseId}, 'applied', ${JSON.stringify(result)}::jsonb)`,
  );
}

export function relativeDate(value: RelativeDay, now: Date): string {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + value.days));
  const date = day.toISOString().slice(0, 10);
  return value.time ? `${date}T${value.time}:00.000Z` : date;
}

/** The field names a button's link holds in braces. */
export function buttonFieldNames(field: TemplateField): string[] {
  if (field.type !== 'button' || field.options?.action?.kind !== 'openUrl') return [];
  const template = field.options?.action?.urlTemplate ?? '';
  return [...template.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1]!.trim());
}

/** Keys of `{{trigger.record.<key>}}` tokens become the fields' IDs. */
const TRIGGER_TOKEN = /\{\{\s*trigger\.record\.([A-Za-z0-9_-]+)\s*\}\}/g;

export async function instantiate(
  c: CommandContext,
  groupId: string,
  template: StarterTemplate,
  now: Date,
  commandRunner?: (input: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const tableIds = new Map(template.tables.map((table) => [table.key, newId('table')]));
  const fieldIds = new Map(
    template.tables.flatMap((table) =>
      table.fields.map((field) => [`${table.key}.${field.key}`, newId('field')]),
    ),
  );
  const recordIds = new Map(
    template.tables.flatMap((table) =>
      table.records.map((record) => [`${table.key}.${record.key}`, newId('record')]),
    ),
  );
  const viewIds = new Map(
    template.tables.flatMap((table) =>
      table.views.map((view) => [`${table.key}.${view.key}`, newId('view')]),
    ),
  );
  const choiceIds = new Map<string, string>();
  const ready = new Set<string>();
  const visiting = new Set<string>();
  const scope = new AccessScope(c.db, c.schemas, c.actor);
  const tableId = (key: string) => required(tableIds, key);
  const fieldId = (table: string, field: string) => required(fieldIds, `${table}.${field}`);
  const viewId = (table: string, view: string) => required(viewIds, `${table}.${view}`);
  const run =
    commandRunner ?? ((input: Record<string, unknown>) => templateCommand(c, groupId, input, scope));
  const tableOf = (key: string): TemplateTable => {
    const found = template.tables.find((value) => value.key === key);
    if (!found) throw new Error(`Unknown template table: ${key}`);
    return found;
  };
  const definition = (table: string, field: string): [TemplateTable, TemplateField] => {
    const parent = tableOf(table);
    const found = parent.fields.find((value) => value.key === field);
    if (!found) throw new Error(`Unknown template field: ${table}.${field}`);
    return [parent, found];
  };
  const choiceId = (table: string, field: string, name: string) =>
    required(choiceIds, `${table}.${field}.${name}`);
  const materialize = (table: TemplateTable, field: TemplateField): FieldCreate => {
    let options: unknown = field.options ?? {};
    if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
      options = {
        choices: field.options.choices.map((choice) => {
          const key = `${table.key}.${field.key}.${choice.name}`;
          if (!choiceIds.has(key)) choiceIds.set(key, newId('choice'));
          return { ...choice, id: required(choiceIds, key) };
        }),
      };
    } else if (field.type === 'link') {
      options = {
        linkedTableId: tableId(field.options.linkedTableKey),
        prefersSingle: field.options.prefersSingle,
      };
    } else if (field.type === 'lookup' || field.type === 'rollup') {
      const [, link] = definition(table.key, field.options.linkFieldKey);
      if (link.type !== 'link') throw new Error('Expected a template link');
      options = {
        linkFieldId: fieldId(table.key, link.key),
        targetFieldId: fieldId(link.options.linkedTableKey, field.options.targetFieldKey),
        fn: field.options.fn,
      };
    } else if (field.type === 'count') {
      options = { linkFieldId: fieldId(table.key, field.options.linkFieldKey) };
    }
    return FieldCreate.parse({
      id: fieldId(table.key, field.key),
      name: field.name,
      description: field.description,
      type: field.type,
      options,
    });
  };

  // All physical tables must exist before link commands create their paired fields.
  for (const table of template.tables) {
    const primary = table.fields[0]!;
    const grid = table.views[0]!;
    if (primary.type !== 'text' || grid.type !== 'grid')
      throw new Error('Expected a text primary field and a grid');
    await run({
      kind: 'table.create',
      table: {
        id: tableId(table.key),
        name: table.name,
        fields: [materialize(table, primary)],
        view: { id: viewId(table.key, grid.key), name: grid.name },
      },
    });
    ready.add(`${table.key}.${primary.key}`);
  }

  const createField = async (table: TemplateTable, field: TemplateField): Promise<void> => {
    const key = `${table.key}.${field.key}`;
    if (ready.has(key)) return;
    if (visiting.has(key)) throw new Error(`Circular template field: ${key}`);
    visiting.add(key);
    if (field.type === 'link' && field.inverse) {
      await createField(...definition(field.options.linkedTableKey, field.options.inverseFieldKey));
    } else {
      if (field.type === 'lookup' || field.type === 'rollup' || field.type === 'count') {
        const pair = definition(table.key, field.options.linkFieldKey);
        await createField(...pair);
        if (field.type !== 'count') {
          const link = pair[1];
          if (link.type !== 'link') throw new Error('Expected a template link');
          await createField(...definition(link.options.linkedTableKey, field.options.targetFieldKey));
        }
      } else if (field.type === 'formula') {
        const parsed = parseFormula(field.options?.expression ?? '');
        if (!('ast' in parsed)) throw new Error(`Invalid template formula: ${key}`);
        const resolved = resolve(
          parsed.ast,
          table.fields.map((value) => ({ id: value.key, name: value.name, type: value.type })),
          undefined,
          undefined,
          (await readNamedFunctions(c.db, c.schemas, c.databaseId, await scopeOf(c))).map(
            ({ name, parameters, body }) => ({ name, parameters, body }),
          ),
        );
        if (!('ast' in resolved)) throw new Error(`Unknown template formula field: ${key}`);
        for (const dependency of references(resolved.ast))
          await createField(...definition(table.key, dependency));
      } else if (field.type === 'button') {
        // The server stores the link with field IDs, so the fields it names come first.
        for (const name of buttonFieldNames(field)) {
          const named = table.fields.find((value) => value.name.toLowerCase() === name.toLowerCase());
          if (!named) throw new Error(`Unknown template button field: ${key}`);
          await createField(table, named);
        }
      }
      await run({ kind: 'field.create', tableId: tableId(table.key), field: materialize(table, field) });
      if (field.type === 'link') {
        const created = await loadField(c.db, c.schemas, fieldId(table.key, field.key));
        if (created?.type !== 'link' || !created.options.inverseFieldId)
          throw new Error('Missing inverse field');
        const [otherTable, inverse] = definition(field.options.linkedTableKey, field.options.inverseFieldKey);
        if (inverse.type !== 'link' || !inverse.inverse) throw new Error('Expected an inverse definition');
        fieldIds.set(`${otherTable.key}.${inverse.key}`, created.options.inverseFieldId);
        await run({
          kind: 'field.update',
          fieldId: created.options.inverseFieldId,
          name: inverse.name,
          options: {
            linkedTableId: tableId(table.key),
            inverseFieldId: created.id,
            prefersSingle: inverse.options.prefersSingle ?? false,
          },
        });
        ready.add(`${otherTable.key}.${inverse.key}`);
      }
    }
    visiting.delete(key);
    ready.add(key);
  };
  for (const table of template.tables) for (const field of table.fields) await createField(table, field);

  const cell = (table: TemplateTable, field: TemplateField, value: SampleValue): unknown => {
    if (value === null) return null;
    if (field.type === 'link') {
      if (!Array.isArray(value)) throw new Error('Expected record keys');
      return value.map((key) => required(recordIds, `${field.options.linkedTableKey}.${key}`));
    }
    if (field.type === 'singleSelect') return choiceId(table.key, field.key, String(value));
    if (field.type === 'multipleSelect') {
      if (!Array.isArray(value)) throw new Error('Expected choice names');
      return value.map((name) => choiceId(table.key, field.key, name));
    }
    if (typeof value === 'object' && 'days' in value) return relativeDate(value, now);
    if (typeof value === 'object' && 'start' in value)
      return { start: relativeDate(value.start, now), end: relativeDate(value.end, now) };
    return value;
  };
  // Insert every record before applying links so forward references are checked normally.
  for (const links of [false, true])
    for (const table of template.tables) {
      const records = table.records
        .map((record) => ({
          id: required(recordIds, `${table.key}.${record.key}`),
          values: Object.fromEntries(
            Object.entries(record.values).flatMap(([key, value]) => {
              const [, field] = definition(table.key, key);
              return (field.type === 'link') === links
                ? [[fieldId(table.key, key), cell(table, field, value)]]
                : [];
            }),
          ),
        }))
        .filter((record) => !links || Object.keys(record.values).length > 0);
      if (records.length)
        await run({ kind: links ? 'record.update' : 'record.create', tableId: tableId(table.key), records });
    }

  const optional = (table: string, key: string | undefined) => (key ? fieldId(table, key) : null);
  const filter = (table: string, group: TemplateFilter | undefined) =>
    group
      ? {
          conjunction: group.conjunction,
          conditions: group.conditions.map((condition, index) => {
            const [, field] = definition(table, condition.field);
            const choice = (name: string) => choiceId(table, field.key, name);
            let value: unknown = condition.value;
            if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
              if (typeof value === 'string') value = choice(value);
              else if (Array.isArray(value)) value = value.map(choice);
            }
            return {
              id: `condition-${index + 1}`,
              fieldId: fieldId(table, condition.field),
              operator: condition.operator,
              ...(value === undefined ? {} : { value }),
            };
          }),
        }
      : null;
  const group = (table: string, value: TemplateGroup) => ({
    fieldId: fieldId(table, value.field),
    dateBucket: value.dateBucket ?? null,
  });
  const computed = (table: string, value: TemplateValue | undefined) => ({
    fn: value?.fn ?? 'count',
    fieldId: optional(table, value?.field),
  });
  const chart = (table: string, value: TemplateChart) => ({
    groupBy: group(table, value.groupBy),
    value: computed(table, value.value),
    seriesBy: optional(table, value.seriesField),
    sort: value.sort ?? 'category',
    stacked: value.stacked ?? false,
  });
  const config = (table: TemplateTable, view: TemplateView) => {
    const key = table.key;
    const dates = { startFieldId: optional(key, view.startField), endFieldId: optional(key, view.endField) };
    const order = fieldOrder(table, view);
    return GridConfig.parse({
      fieldOrder: order.map((field) => fieldId(key, field)),
      // Cards show the primary field and the next three unless the template says otherwise.
      hiddenFieldIds: (
        view.hiddenFields ??
        (view.type === 'kanban' || view.type === 'gallery'
          ? order.filter((field) => field !== table.fields[0]?.key).slice(3)
          : [])
      ).map((field) => fieldId(key, field)),
      filter: filter(key, view.filter),
      sorts: (view.sorts ?? []).map((sort) => ({
        fieldId: fieldId(key, sort.field),
        direction: sort.direction,
      })),
      summaries: Object.fromEntries(
        Object.entries(view.summaries ?? {}).map(([field, kind]) => [fieldId(key, field), kind]),
      ),
      kanban: { stackFieldId: optional(key, view.stackField) },
      calendar: view.type === 'calendar' ? dates : {},
      timeline:
        view.type === 'timeline'
          ? { ...dates, groupFieldId: optional(key, view.groupField), zoom: view.zoom }
          : {},
      gantt:
        view.type === 'gantt'
          ? {
              ...dates,
              dependencyFieldId: optional(key, view.dependencyField),
              progressFieldId: optional(key, view.progressField),
              zoom: view.zoom,
            }
          : {},
      list:
        view.type === 'list'
          ? { groupFieldId: optional(key, view.groupField), parentFieldId: optional(key, view.parentField) }
          : {},
      map:
        view.type === 'map'
          ? {
              locationFieldId: optional(key, view.locationField),
              colorFieldId: optional(key, view.colorField),
            }
          : {},
      chart: view.chart ? { ...chart(key, view.chart), chart: view.chart.type ?? 'column' } : {},
      pivot: view.pivot
        ? {
            rows: view.pivot.rows.map((row) => group(key, row)),
            column: view.pivot.column ? group(key, view.pivot.column) : null,
            values: (view.pivot.values ?? [{ fn: 'count' }]).map((value) => computed(key, value)),
          }
        : {},
      form: {
        ...view.form,
        questions: view.questions?.map((question) => ({
          fieldId: fieldId(key, question.field),
          required: question.required,
          label: question.label,
          help: question.help,
        })),
      },
    });
  };
  for (const table of template.tables)
    for (const [index, view] of table.views.entries()) {
      const id = viewId(table.key, view.key);
      if (index === 0) await run({ kind: 'view.update', viewId: id, config: config(table, view) });
      else
        await run({
          kind: 'view.create',
          view: {
            id,
            tableId: tableId(table.key),
            name: view.name,
            type: view.type,
            config: config(table, view),
          },
        });
    }

  const tile = (value: TemplateTile) => {
    const base = { id: `tile-${value.key}`, title: value.title, place: value.place };
    if (value.kind === 'text') return { ...base, kind: 'text', text: value.text };
    const source = {
      tableId: tableId(value.table),
      viewId: value.view ? viewId(value.table, value.view) : null,
    };
    switch (value.kind) {
      case 'number':
        return { ...base, kind: 'number', source, value: computed(value.table, value.value) };
      case 'chart':
        return {
          ...base,
          kind: 'chart',
          source,
          ...chart(value.table, value.chart),
          chart: value.chart.type ?? 'column',
          limit: value.limit,
        };
      case 'records':
        return {
          ...base,
          kind: 'records',
          source,
          fieldIds: value.fields.map((field) => fieldId(value.table, field)),
          limit: value.limit,
        };
    }
  };
  for (const dashboard of template.dashboards ?? [])
    await run({
      kind: 'dashboard.create',
      dashboard: {
        id: newId('dashboard'),
        name: dashboard.name,
        config: { tiles: dashboard.tiles.map(tile) },
      },
    });

  const trigger = (value: TemplateAutomation['trigger']) => {
    switch (value.kind) {
      case 'recordCreated':
        return { kind: value.kind, tableId: tableId(value.table) };
      case 'recordUpdated':
        return {
          kind: value.kind,
          tableId: tableId(value.table),
          fieldIds: (value.fields ?? []).map((field) => fieldId(value.table, field)),
        };
      case 'recordMatches':
        return {
          kind: value.kind,
          tableId: tableId(value.table),
          viewId: value.view ? viewId(value.table, value.view) : null,
          filter: filter(value.table, value.filter),
        };
      case 'formSubmitted':
        return { kind: value.kind, viewId: viewId(value.table, value.view) };
    }
  };
  // Automations are created turned off, so they only act once someone turns them on.
  for (const automation of template.automations ?? []) {
    const table = automation.trigger.table;
    const text = (value: string) =>
      value.replace(TRIGGER_TOKEN, (_token, key: string) => `{{trigger.record.${fieldId(table, key)}}}`);
    await run({
      kind: 'automation.create',
      automation: {
        id: newId('automation'),
        name: automation.name,
        config: {
          trigger: trigger(automation.trigger),
          conditions: filter(table, automation.conditions),
          steps: automation.steps.map((step) => ({
            id: `step-${step.key}`,
            name: step.name ?? '',
            kind: step.kind,
            tableId: tableId(table),
            record: 'trigger',
            values: Object.fromEntries(
              Object.entries(step.values).map(([field, value]) => [fieldId(table, field), text(value)]),
            ),
          })),
        },
      },
    });
  }
}

/** A view's fields by key: the ones it names first, then the rest in the table's order. */
export function fieldOrder(table: TemplateTable, view: TemplateView): string[] {
  const all = table.fields.map((field) => field.key);
  const listed = view.fieldOrder ?? all;
  return [...listed, ...all.filter((key) => !listed.includes(key))];
}

function required(map: Map<string, string>, key: string): string {
  const value = map.get(key);
  if (!value) throw new Error(`Unknown template key: ${key}`);
  return value;
}
