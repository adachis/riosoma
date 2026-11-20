import { isCurrencyCode, type PlatformBase, type ViewType } from '@riosoma/contracts';
import { z } from 'zod';
import { isRecord } from '../../core/values.js';
import { asCheck, asNumber, asText, note, peoplePlan } from '../fields.js';
import type { PlatformClient } from '../http.js';
import type { ReaderContext, ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  LinkPlan,
  PlatformSource,
  SourceRecord,
  SourceSchema,
  SourceTable,
} from '../model.js';
import {
  idsOf,
  instant,
  itemsOf,
  label,
  object,
  pathId,
  readableTask,
  stringOf,
  TaskLinks,
  taskChoices,
  taskFiles,
  taskValuePlan as valuePlan,
  taskPeople,
} from '../tasks.js';

const Item = z
  .object({ id: z.coerce.string(), name: z.string(), archived: z.boolean().optional() })
  .passthrough();
const Field = z
  .object({ id: z.string(), name: z.string(), type: z.string(), type_config: object.default({}) })
  .passthrough();
type Field = z.infer<typeof Field>;
const Task = z
  .object({ id: z.string(), name: z.string(), custom_fields: z.array(Field).default([]) })
  .passthrough();
const tasksPage = z.object({ tasks: z.array(Task), last_page: z.boolean().optional() });
const VIEW_KINDS: Readonly<Record<string, ViewType>> = {
  list: 'list',
  board: 'kanban',
  table: 'grid',
  calendar: 'calendar',
  timeline: 'timeline',
  gantt: 'gantt',
};
const GROUP_FIELDS: Readonly<Record<string, string>> = {
  status: 'status',
  priority: 'priority',
  assignee: 'assignees',
  tags: 'tags',
  due_date: 'due',
  start_date: 'start',
};
const API = '/api/v2';

/** Map every documented custom type, keeping unfamiliar future types as structured values. */
export function clickupField(
  field: Field,
  context: ReaderContext,
  graph: TaskLinks,
  tables: readonly { id: string; name: string }[],
): FieldPlan[] {
  const config = field.type_config;
  const read = (
    spec: Parameters<typeof valuePlan>[1],
    value: (value: unknown) => unknown = asText,
    notes: Parameters<typeof valuePlan>[3] = [],
  ) => [valuePlan(field, spec, value, notes)];
  switch (field.type) {
    case 'short_text':
      return read({ type: 'text', options: {} });
    case 'text':
      return read({ type: 'longText', options: {} });
    case 'url':
      return read({ type: 'url', options: {} });
    case 'email':
      return read({ type: 'email', options: {} });
    case 'phone':
      return read({ type: 'phone', options: {} });
    case 'checkbox':
      return read({ type: 'checkbox', options: {} }, asCheck);
    case 'number':
      return read({ type: 'number', options: {} }, asNumber);
    case 'currency': {
      const code = stringOf(config.currency_type) ?? '';
      return isCurrencyCode(code)
        ? read({ type: 'currency', options: { code, precision: Number(config.precision ?? 2) } }, asNumber)
        : read({ type: 'number', options: {} }, asNumber, [
            note('changed', 'import.platform.report.currencyUnknown', { symbol: code }),
          ]);
    }
    case 'date':
      return read({ type: 'date', options: { includeTime: true, timeZone: 'UTC' } }, instant, [
        note('changed', 'import.platform.report.taskDate'),
      ]);
    case 'drop_down':
    case 'labels': {
      const choices = taskChoices(itemsOf(config.options), true);
      return field.type === 'drop_down'
        ? read({ type: 'singleSelect', options: { choices: choices.choices } }, choices.one)
        : read({ type: 'multipleSelect', options: { choices: choices.choices } }, choices.many);
    }
    case 'users':
      return [peoplePlan(field, taskPeople, true, [note('changed', 'import.platform.report.taskPeople')])];
    case 'tasks':
    case 'list_relationship':
      return graph.plans(field, tables);
    case 'attachment':
    case 'files':
      return [taskFiles(field, context.address)];
    case 'emoji':
      return read(
        { type: 'rating', options: { max: Math.min(10, Math.max(1, Number(config.count ?? 5))) } },
        asNumber,
        [note('changed', 'import.platform.report.ratingIcon', { icon: stringOf(config.code_point) ?? '' })],
      );
    case 'location':
      return read({ type: 'json', options: {} }, (value) => value, [
        note('changed', 'import.platform.report.taskStructured'),
      ]);
    case 'manual_progress':
    case 'automatic_progress':
    case 'progress':
      return read(
        { type: 'number', options: {} },
        (value) => (isRecord(value) ? asNumber(value.current ?? value.percent_completed) : asNumber(value)),
        [note('changed', 'import.platform.report.taskSnapshot')],
      );
    case 'formula':
    case 'rollup':
      return read({ type: 'json', options: {} }, (value) => value, [
        note('changed', 'import.platform.report.taskSnapshot'),
      ]);
    case 'voting':
    case 'votes':
      return read({ type: 'json', options: {} }, (value) => value, [
        note('changed', 'import.platform.report.taskSnapshot'),
      ]);
    default:
      return read({ type: 'json', options: {} }, (value) => value, [
        note('changed', 'import.platform.report.taskUnknown', { type: field.type }),
      ]);
  }
}

class ClickupSource implements PlatformSource {
  readonly platform = 'clickup' as const;
  private readonly graph = new TaskLinks();
  private readonly notes = [
    note('changed', 'import.platform.report.taskHierarchy'),
    note('changed', 'import.platform.report.taskScope'),
    note('changed', 'import.platform.report.taskMultiHome'),
    note('omitted', 'import.platform.report.notShared'),
    note('changed', 'import.platform.report.taskLinksDeferred'),
  ];
  constructor(
    private readonly client: PlatformClient,
    private readonly context: ReaderContext,
    private readonly ids: readonly string[],
  ) {}

  async schema(): Promise<SourceSchema> {
    const listed: z.infer<typeof Item>[] = [];
    for (const id of this.ids) listed.push(await this.client.json(`${API}/list/${pathId(id)}`, Item));
    const tables: SourceTable[] = [];
    for (const list of listed) {
      const custom = (
        await this.client.json(`${API}/list/${pathId(list.id)}/field`, z.object({ fields: z.array(Field) }))
      ).fields;
      const statuses = taskChoices(itemsOf(list.statuses), true);
      const space = isRecord(list.space) ? stringOf(list.space.id) : null;
      const tags = space
        ? (await this.client.json(`${API}/space/${pathId(space)}/tag`, z.object({ tags: z.array(object) })))
            .tags
        : [];
      const tagChoices = taskChoices(
        tags.map((tag) => ({ ...tag, color: tag.tag_fg })),
        true,
      );
      const fields: FieldPlan[] = [
        valuePlan(label(this.context, 'name'), { type: 'text', options: {} }, asText),
        valuePlan(label(this.context, 'description'), { type: 'longText', options: {} }, asText),
        valuePlan(
          label(this.context, 'status'),
          statuses.choices.length
            ? { type: 'singleSelect', options: { choices: statuses.choices } }
            : { type: 'text', options: {} },
          statuses.choices.length ? statuses.one : asText,
          statuses.choices.length ? [] : [note('changed', 'import.platform.report.taskChoiceText')],
        ),
        peoplePlan(label(this.context, 'assignees'), taskPeople, true),
        peoplePlan(label(this.context, 'followers'), taskPeople, true),
        valuePlan(label(this.context, 'customFields'), { type: 'json', options: {} }, (value) => value, [
          note('changed', 'import.platform.report.taskExtraFields'),
        ]),
        ...(['start', 'due', 'created', 'updated', 'completedAt'] as const).map((id) =>
          valuePlan(
            label(this.context, id),
            { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
            instant,
            [note('changed', 'import.platform.report.taskDate')],
          ),
        ),
        valuePlan(label(this.context, 'priority'), { type: 'text', options: {} }, asText, [
          note('changed', 'import.platform.report.taskChoiceText'),
        ]),
        valuePlan(
          label(this.context, 'tags'),
          { type: 'multipleSelect', options: { choices: tagChoices.choices } },
          tagChoices.many,
        ),
        ...(['estimate', 'spent'] as const).map((id) =>
          valuePlan(label(this.context, id), { type: 'duration', options: {} }, (value) =>
            value == null ? null : Number(value) / 1000,
          ),
        ),
        valuePlan(label(this.context, 'url'), { type: 'url', options: {} }, asText),
        valuePlan(label(this.context, 'taskType'), { type: 'number', options: {} }, asNumber),
        valuePlan(label(this.context, 'archived'), { type: 'checkbox', options: {} }, asCheck),
        taskFiles(label(this.context, 'attachments'), this.context.address),
        ...this.graph.plans(label(this.context, 'parent'), listed, true),
        ...this.graph.plans(label(this.context, 'dependencies'), listed),
        ...this.graph.plans(label(this.context, 'dependents'), listed),
        ...this.graph.plans(label(this.context, 'relationships'), listed),
        ...custom.flatMap((field) => clickupField(field, this.context, this.graph, listed)),
      ];
      const views = await this.client.json(
        `${API}/list/${pathId(list.id)}/view`,
        z.object({ views: z.array(object) }),
      );
      tables.push({
        id: list.id,
        name: list.name,
        description: stringOf(list.content),
        primary: 'name',
        fields,
        views: views.views.map((view) => {
          const type = stringOf(view.type) ?? 'list';
          const grouping = isRecord(view.grouping) ? view.grouping : {};
          const grouped = stringOf(grouping.custom_field_id ?? grouping.field);
          const group = grouped
            ? (GROUP_FIELDS[grouped] ?? (custom.some((field) => field.id === grouped) ? grouped : null))
            : type === 'board'
              ? 'status'
              : null;
          return {
            id: stringOf(view.id) ?? list.id,
            name: stringOf(view.name) ?? list.name,
            type,
            kind: VIEW_KINDS[type] ?? null,
            group,
            start: type === 'calendar' ? 'due' : 'start',
            end: 'due',
            notes: [note('changed', 'import.platform.report.taskViews')],
          };
        }),
        notes: [],
      });
    }
    const schema = { tables, notes: this.notes };
    this.graph.preview(schema);
    return schema;
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const seen = new Set<string>();
    // Archived and active tasks are separate API result sets.  Closed tasks are included in both.
    for (const archived of ['false', 'true']) {
      for (let page = 0; ; page++) {
        const answer = await this.client.json(`${API}/list/${pathId(table.id)}/task`, tasksPage, {
          query: { page, archived, subtasks: 'true', include_closed: 'true', include_timl: 'true' },
        });
        const records: SourceRecord[] = [];
        for (const item of answer.tasks) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const task = await readableTask(this.client, `${API}/task/${pathId(item.id)}`, Task);
          if (!task) {
            this.notes.push(note('omitted', 'import.platform.report.taskUnavailable'));
            continue;
          }
          const refs: Record<string, string[]> = {
            parent: idsOf(task.parent),
            dependencies: itemsOf(task.dependencies)
              .filter((dep) => stringOf(dep.task_id) === task.id)
              .flatMap((dep) => idsOf(dep.depends_on)),
            dependents: itemsOf(task.dependencies)
              .filter((dep) => stringOf(dep.depends_on) === task.id)
              .flatMap((dep) => idsOf(dep.task_id)),
            relationships: itemsOf(task.linked_tasks).flatMap((link) =>
              idsOf(link.task_id === task.id ? link.link_id : link.task_id),
            ),
          };
          const values: Record<string, unknown> = {
            name: task.name,
            description: task.description,
            status: isRecord(task.status) ? task.status.status : null,
            assignees: task.assignees,
            followers: task.watchers,
            customFields: task.custom_fields,
            start: task.start_date,
            due: task.due_date,
            created: task.date_created,
            updated: task.date_updated,
            completedAt: task.date_done ?? task.date_closed,
            priority: isRecord(task.priority) ? task.priority.priority : null,
            tags: itemsOf(task.tags).map((tag) => tag.name),
            estimate: task.time_estimate,
            spent: task.time_spent,
            attachments: task.attachments,
            url: task.url,
            taskType: task.custom_item_id,
            archived: task.archived,
          };
          for (const field of task.custom_fields) {
            values[field.id] = field.value ?? null;
            if (field.type === 'tasks' || field.type === 'list_relationship')
              refs[field.id] = idsOf(field.value);
          }
          this.graph.record(table.id, task.id, refs);
          records.push({ id: task.id, values });
        }
        yield records;
        if (answer.last_page === true || (answer.last_page === undefined && answer.tasks.length < 100)) break;
      }
    }
  }
  links(table: SourceTable, link: LinkPlan, ids: readonly string[]) {
    return this.graph.links(table, link, ids);
  }
  finalizeLinks(schema: SourceSchema): void {
    this.graph.finalize(schema);
  }
}

export const clickupReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({ credentials: () => ({ authorization: token }), secrets: () => [token] });
  return {
    async bases(): Promise<PlatformBase[]> {
      const bases: PlatformBase[] = [];
      const teams = await client.json(`${API}/team`, z.object({ teams: z.array(Item) }), { purpose: 'list' });
      for (const team of teams.teams) {
        for (const archived of ['false', 'true']) {
          const spaces = await client.json(
            `${API}/team/${pathId(team.id)}/space`,
            z.object({ spaces: z.array(Item) }),
            { query: { archived }, purpose: 'list' },
          );
          for (const space of spaces.spaces) {
            for (const folderArchived of ['false', 'true']) {
              const folders = await client.json(
                `${API}/space/${pathId(space.id)}/folder`,
                z.object({ folders: z.array(Item) }),
                { query: { archived: folderArchived }, purpose: 'list' },
              );
              for (const folder of folders.folders) {
                for (const listArchived of ['false', 'true']) {
                  const lists = await client.json(
                    `${API}/folder/${pathId(folder.id)}/list`,
                    z.object({ lists: z.array(Item) }),
                    { query: { archived: listArchived }, purpose: 'list' },
                  );
                  bases.push(
                    ...lists.lists.map((list) => ({
                      id: list.id,
                      name: list.name,
                      group: `${team.name} / ${space.name} / ${folder.name}`,
                    })),
                  );
                }
              }
              const lists = await client.json(
                `${API}/space/${pathId(space.id)}/list`,
                z.object({ lists: z.array(Item) }),
                { query: { archived: folderArchived }, purpose: 'list' },
              );
              bases.push(
                ...lists.lists.map((list) => ({
                  id: list.id,
                  name: list.name,
                  group: `${team.name} / ${space.name}`,
                })),
              );
            }
          }
        }
      }
      return [...new Map(bases.map((base) => [base.id, base])).values()];
    },
    kept: async () => context.credential,
    source: (id, additional = []) => new ClickupSource(client, context, [...new Set([id, ...additional])]),
  };
};
