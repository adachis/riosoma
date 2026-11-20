import { isCurrencyCode, type PlatformBase } from '@riosoma/contracts';
import { z } from 'zod';
import { isRecord } from '../../core/values.js';
import {
  asCheck,
  asDay,
  asInstant,
  asNumber,
  asText,
  emailsOf,
  note,
  peoplePlan,
  precisionOf,
} from '../fields.js';
import { PlatformResponseError, type PlatformClient } from '../http.js';
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
  asanaPages,
  idsOf,
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
} from '../tasks.js';

const API = '/api/1.0';
const Item = z.object({ gid: z.string(), name: z.string() }).passthrough();
const Field = z.object({ gid: z.string(), name: z.string(), resource_subtype: z.string() }).passthrough();
type Field = z.infer<typeof Field>;
const Task = z
  .object({ gid: z.string(), name: z.string(), custom_fields: z.array(Field).default([]) })
  .passthrough();
const CUSTOM_FIELDS =
  'gid,name,resource_subtype,description,enum_options,precision,format,currency_code,custom_label,custom_label_position,is_formula_field,is_value_read_only,representation_type,input_restrictions,id_prefix';
const TASK_FIELDS =
  'gid,name,notes,completed,completed_at,created_at,modified_at,start_on,start_at,due_on,due_at,assignee.name,assignee.email,followers.name,followers.email,tags.name,parent.gid,projects.name,memberships.project.gid,memberships.section.gid,permalink_url,resource_subtype,actual_time_minutes,custom_fields.gid,custom_fields.name,custom_fields.resource_subtype,custom_fields.text_value,custom_fields.number_value,custom_fields.enum_value.gid,custom_fields.multi_enum_values.gid,custom_fields.date_value,custom_fields.people_value.name,custom_fields.people_value.email,custom_fields.reference_value,custom_fields.display_value';

/** Computed fields retain their API results.  Task references become links inside the selection. */
export function asanaField(
  field: Field,
  context: ReaderContext,
  graph: TaskLinks,
  tables: readonly { id: string; name: string }[],
): FieldPlan[] {
  const notes =
    field.is_formula_field || field.is_value_read_only
      ? [note('changed', 'import.platform.report.taskSnapshot')]
      : [];
  const source = { id: field.gid, name: field.name, description: stringOf(field.description) };
  const read = (spec: Parameters<typeof valuePlan>[1], value: (value: unknown) => unknown = asText) => [
    valuePlan(source, spec, value, notes),
  ];
  if (typeof field.id_prefix === 'string' && field.id_prefix) {
    notes.push(note('changed', 'import.platform.report.taskSnapshot'));
    return read({ type: 'text', options: {} }, (value) =>
      isRecord(value) ? (value.display_value ?? null) : null,
    );
  }
  switch (field.resource_subtype) {
    case 'text':
      return read({ type: 'longText', options: {} }, (value) =>
        isRecord(value) ? (value.text_value ?? null) : value,
      );
    case 'enum':
    case 'multi_enum': {
      const choices = taskChoices(itemsOf(field.enum_options));
      return field.resource_subtype === 'enum'
        ? read({ type: 'singleSelect', options: { choices: choices.choices } }, (value) =>
            choices.one(isRecord(value) ? value.enum_value : null),
          )
        : read({ type: 'multipleSelect', options: { choices: choices.choices } }, (value) =>
            choices.many(isRecord(value) ? value.multi_enum_values : null),
          );
    }
    case 'number': {
      const precision = precisionOf(field.precision) ?? 0;
      const code = stringOf(field.currency_code) ?? '';
      const number = (value: unknown) => (isRecord(value) ? asNumber(value.number_value ?? null) : null);
      if (field.format === 'currency' && isCurrencyCode(code))
        return read({ type: 'currency', options: { code, precision } }, number);
      if (field.format === 'currency' && !isCurrencyCode(code))
        notes.push(note('changed', 'import.platform.report.currencyUnknown', { symbol: code }));
      if (field.format === 'duration' || field.format === 'identifier')
        notes.push(note('changed', 'import.platform.report.taskNumberFormat'));
      if (field.format === 'percentage') return read({ type: 'percent', options: { precision } }, number);
      if (field.format === 'custom')
        notes.push(
          note('changed', 'import.platform.report.numberAffixes', {
            prefix: field.custom_label_position === 'prefix' ? (stringOf(field.custom_label) ?? '') : '',
            suffix: field.custom_label_position === 'suffix' ? (stringOf(field.custom_label) ?? '') : '',
          }),
        );
      return read({ type: 'number', options: { precision } }, number);
    }
    case 'date':
      return read({ type: 'date', options: { includeTime: true, timeZone: 'UTC' } }, (value) => {
        const date = isRecord(value) && isRecord(value.date_value) ? value.date_value : null;
        return date
          ? asInstant(date.date_time ?? (typeof date.date === 'string' ? `${date.date}T00:00:00.000Z` : null))
          : null;
      });
    case 'people':
      return [
        peoplePlan(source, (value) => emailsOf(isRecord(value) ? value.people_value : null), true, [
          ...notes,
          note('changed', 'import.platform.report.taskPeople'),
        ]),
      ];
    case 'reference': {
      // Mixed references retain projects, goals, and portfolios beside the task links.
      return [
        ...graph.plans(source, tables),
        valuePlan(
          { ...source, id: `${source.id}:value` },
          { type: 'json', options: {} },
          (value) => (isRecord(value) ? (value.reference_value ?? null) : null),
          [note('changed', 'import.platform.report.taskStructured')],
        ),
      ];
    }
    case 'id':
      return read({ type: 'text', options: {} }, (value) =>
        isRecord(value) ? (value.display_value ?? null) : null,
      );
    default:
      return [
        valuePlan(source, { type: 'json', options: {} }, (value) => value, [
          note('changed', 'import.platform.report.taskUnknown', { type: field.resource_subtype }),
        ]),
      ];
  }
}

class AsanaSource implements PlatformSource {
  readonly platform = 'asana' as const;
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
    const listed: Array<z.infer<typeof Item> & { id: string }> = [];
    for (const id of this.ids) {
      const { data } = await this.client.json(`${API}/projects/${pathId(id)}`, z.object({ data: Item }), {
        query: { opt_fields: 'gid,name,notes,archived,default_view' },
      });
      listed.push({ ...data, id: data.gid });
    }
    const tables: SourceTable[] = [];
    for (const project of listed) {
      const sections = [];
      for await (const page of asanaPages(
        this.client,
        `${API}/projects/${pathId(project.id)}/sections`,
        Item,
      ))
        sections.push(...page);
      const choices = taskChoices(sections);
      const custom: Field[] = [];
      for await (const page of asanaPages(
        this.client,
        `${API}/projects/${pathId(project.id)}/custom_field_settings`,
        z.object({ custom_field: Field }),
        {
          opt_fields: CUSTOM_FIELDS.split(',')
            .map((key) => `custom_field.${key}`)
            .join(','),
        },
      )) {
        custom.push(...page.map((setting) => setting.custom_field));
      }
      const fields: FieldPlan[] = [
        valuePlan(label(this.context, 'name'), { type: 'text', options: {} }, asText),
        valuePlan(label(this.context, 'description'), { type: 'longText', options: {} }, asText),
        valuePlan(label(this.context, 'completed'), { type: 'checkbox', options: {} }, asCheck),
        peoplePlan(label(this.context, 'assignees'), emailsOf, false),
        peoplePlan(label(this.context, 'followers'), emailsOf, true),
        valuePlan(label(this.context, 'customFields'), { type: 'json', options: {} }, (value) => value, [
          note('changed', 'import.platform.report.taskExtraFields'),
        ]),
        ...(['start', 'due', 'created', 'updated'] as const).map((id) =>
          valuePlan(
            label(this.context, id),
            { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
            asInstant,
            id === 'start' || id === 'due' ? [note('changed', 'import.platform.report.taskDate')] : [],
          ),
        ),
        valuePlan(
          label(this.context, 'completedAt'),
          { type: 'date', options: { includeTime: true, timeZone: 'UTC' } },
          asInstant,
        ),
        valuePlan(label(this.context, 'tags'), { type: 'longText', options: {} }, asText, [
          note('changed', 'import.platform.report.taskTags'),
        ]),
        valuePlan(label(this.context, 'projects'), { type: 'json', options: {} }, (value) => value, [
          note('changed', 'import.platform.report.taskMultiHome'),
        ]),
        valuePlan(
          label(this.context, 'section'),
          { type: 'singleSelect', options: { choices: choices.choices } },
          choices.one,
        ),
        valuePlan(label(this.context, 'spent'), { type: 'duration', options: {} }, (value) =>
          value == null ? null : Number(value) * 60,
        ),
        valuePlan(label(this.context, 'url'), { type: 'url', options: {} }, asText),
        valuePlan(label(this.context, 'taskType'), { type: 'text', options: {} }, asText),
        taskFiles(label(this.context, 'attachments'), this.context.address),
        ...this.graph.plans(label(this.context, 'parent'), listed, true),
        ...this.graph.plans(label(this.context, 'dependencies'), listed),
        ...custom.flatMap((field) => asanaField(field, this.context, this.graph, listed)),
      ];
      tables.push({
        id: project.id,
        name: project.name,
        description: stringOf(project.notes),
        primary: 'name',
        fields,
        views: [
          {
            id: `${project.id}:sections`,
            name: project.name,
            type: stringOf(project.default_view) ?? 'list',
            kind:
              project.default_view === 'board'
                ? 'kanban'
                : project.default_view === 'calendar'
                  ? 'calendar'
                  : project.default_view === 'timeline'
                    ? 'timeline'
                    : 'list',
            start: project.default_view === 'calendar' ? 'due' : 'start',
            end: 'due',
            group: 'section',
            notes: [note('changed', 'import.platform.report.taskViews')],
          },
        ],
        notes: [],
      });
    }
    const schema = { tables, notes: this.notes };
    this.graph.preview(schema);
    return schema;
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const seen = new Set<string>();
    const taskPath = `${API}/projects/${pathId(table.id)}/tasks`;
    for await (const page of asanaPages(this.client, taskPath, z.object({ gid: z.string() }), {
      completed_since: '1970-01-01T00:00:00.000Z',
    })) {
      // A growing work list reads descendants without recursion or repeating multi-homed subtasks.
      const pending = page.map((task) => task.gid);
      for (let at = 0; at < pending.length; at++) {
        const id = pending[at]!;
        if (seen.has(id)) continue;
        seen.add(id);
        const answer = await readableTask(
          this.client,
          `${API}/tasks/${pathId(id)}`,
          z.object({ data: Task }),
          { query: { opt_fields: TASK_FIELDS } },
        );
        if (!answer) {
          this.notes.push(note('omitted', 'import.platform.report.taskUnavailable'));
          continue;
        }
        const task = answer.data;
        const dependencies: string[] = [];
        try {
          for await (const deps of asanaPages(
            this.client,
            `${API}/tasks/${pathId(id)}/dependencies`,
            z.object({ gid: z.string() }),
          ))
            dependencies.push(...deps.map((dep) => dep.gid));
        } catch (error) {
          if (!(error instanceof PlatformResponseError) || error.responseStatus !== 402) throw error;
          table.notes.push(note('omitted', 'import.platform.report.taskDependenciesPremium'));
        }
        const attachments: Record<string, unknown>[] = [];
        for await (const files of asanaPages(
          this.client,
          `${API}/attachments`,
          z.object({ gid: z.string() }),
          { parent: id },
        )) {
          for (const file of files) {
            const answer = await readableTask(
              this.client,
              `${API}/attachments/${pathId(file.gid)}`,
              z.object({ data: object }),
              { query: { opt_fields: 'gid,name,download_url,permanent_url,host' } },
            );
            attachments.push(answer?.data ?? { gid: file.gid });
          }
        }
        const refs: Record<string, string[]> = { parent: idsOf(task.parent), dependencies };
        const membership = itemsOf(task.memberships).find(
          (member) => isRecord(member.project) && member.project.gid === table.id,
        );
        const values: Record<string, unknown> = {
          name: task.name,
          description: task.notes,
          completed: task.completed,
          assignees: task.assignee,
          followers: task.followers,
          customFields: task.custom_fields,
          start:
            task.start_at ??
            (typeof task.start_on === 'string' ? `${asDay(task.start_on)}T00:00:00.000Z` : null),
          due:
            task.due_at ?? (typeof task.due_on === 'string' ? `${asDay(task.due_on)}T00:00:00.000Z` : null),
          created: task.created_at,
          updated: task.modified_at,
          completedAt: task.completed_at,
          tags:
            itemsOf(task.tags)
              .map((tag) => tag.name)
              .join(', ') || null,
          projects: task.projects,
          section: isRecord(membership?.section) ? membership.section.gid : null,
          spent: task.actual_time_minutes,
          url: task.permalink_url,
          taskType: task.resource_subtype,
          attachments,
        };
        for (const field of task.custom_fields) {
          values[field.gid] = field;
          if (field.resource_subtype === 'reference') {
            refs[field.gid] = idsOf(
              itemsOf(field.reference_value).filter((item) => item.resource_type === 'task'),
            );
            values[`${field.gid}:value`] = field;
          }
        }
        this.graph.record(table.id, task.gid, refs);
        yield [{ id: task.gid, values }];
        for await (const children of asanaPages(
          this.client,
          `${API}/tasks/${pathId(id)}/subtasks`,
          z.object({ gid: z.string() }),
        ))
          pending.push(...children.map((child) => child.gid));
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

export const asanaReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => [token],
  });
  return {
    async bases(): Promise<PlatformBase[]> {
      const bases: PlatformBase[] = [];
      for await (const workspaces of asanaPages(client, `${API}/workspaces`, Item, {}, 'list')) {
        for (const workspace of workspaces) {
          // Workspace project listing includes teamless personal projects as well as team projects.
          for await (const projects of asanaPages(
            client,
            `${API}/projects`,
            Item,
            { workspace: workspace.gid, opt_fields: 'gid,name,archived,team.name' },
            'list',
          )) {
            bases.push(
              ...projects.map((project) => ({
                id: project.gid,
                name: project.name,
                group:
                  isRecord(project.team) && typeof project.team.name === 'string'
                    ? `${workspace.name} / ${project.team.name}`
                    : workspace.name,
              })),
            );
          }
        }
      }
      return [...new Map(bases.map((base) => [base.id, base])).values()];
    },
    kept: async () => context.credential,
    source: (id, additional = []) => new AsanaSource(client, context, [...new Set([id, ...additional])]),
  };
};
