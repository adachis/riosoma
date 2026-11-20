import type { TaskImportField } from '@riosoma/contracts';
import { AppError, FieldSpec, LIMITS, newId } from '@riosoma/contracts';
import { z } from 'zod';
import { isRecord } from '../core/values.js';
import type { Note } from '../core/report.js';
import { platformAttachment } from './attachments.js';
import {
  choicesOf,
  colorOfHex,
  colorOfName,
  emailsOf,
  filesPlan,
  linkPlan,
  note,
  valuePlan,
} from './fields.js';
import type { ReaderContext } from './importer.js';
import type { PlatformClient } from './http.js';
import type { FieldPlan, LinkPlan, SourceField, SourceSchema, SourceTable } from './model.js';

export const object = z.record(z.string(), z.unknown());
/** A task can be removed or made private between its listing and its detail request. */
export async function readableTask<T>(
  client: PlatformClient,
  path: string,
  schema: z.ZodType<T>,
  options?: Parameters<PlatformClient['json']>[2],
): Promise<T | null> {
  try {
    return await client.json(path, schema, options);
  } catch (error) {
    if (error instanceof AppError && error.messageKey === 'import.platform.baseUnavailable') return null;
    throw error;
  }
}
export function taskValuePlan(
  field: SourceField,
  spec: z.input<typeof FieldSpec>,
  read: (value: unknown) => unknown,
  notes: Note[] = [],
): FieldPlan {
  const converted =
    spec.type === 'json'
      ? (raw: unknown) => {
          const value = read(raw);
          return value == null ? null : JSON.stringify(value);
        }
      : read;
  return valuePlan(field, FieldSpec.parse(spec), converted, notes);
}
export const pathId = (id: string) => encodeURIComponent(id);
export const itemsOf = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];
export const stringOf = (value: unknown): string | null =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
export const taskPeople = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.flatMap((item) => {
    if (!isRecord(item)) return idsOf(item);
    const found = emailsOf({ ...item, name: item.name ?? item.username });
    return found.length ? found : idsOf(item);
  });
};
export const idsOf = (value: unknown): string[] => {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  return items.flatMap((item) => {
    const id = isRecord(item) ? stringOf(item.gid ?? item.id) : stringOf(item);
    return id ? [id] : [];
  });
};
export const label = (context: ReaderContext, id: TaskImportField): SourceField => ({
  id,
  name: context.fieldNames?.[id] ?? `import.platform.fields.${id}`,
});
export const instant = (value: unknown): unknown => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= 8.64e15 ? new Date(number).toISOString() : value;
};

/** Retain disabled options too, since old tasks can still name them. */
export function taskChoices(options: Record<string, unknown>[], hex = false) {
  const names = options.map((item) => ({
    name: stringOf(item.name ?? item.label ?? item.status) ?? '',
    color: hex ? colorOfHex(item.color) : colorOfName(item.color),
  }));
  const { choices, byName } = choicesOf(names);
  const byId = new Map<string, string>();
  options.forEach((item, index) => {
    const choice = byName.get(names[index]!.name);
    if (!choice) return;
    for (const key of [item.gid, item.id, item.orderindex]) {
      const id = stringOf(key);
      if (id !== null) byId.set(id, choice);
    }
    byId.set(names[index]!.name, choice);
  });
  return {
    choices,
    one: (value: unknown) => {
      if (value == null || value === '') return null;
      const key = isRecord(value) ? stringOf(value.gid ?? value.id ?? value.name) : stringOf(value);
      return (key === null ? undefined : byId.get(key)) ?? value;
    },
    many: (value: unknown) => idsOf(value).map((id) => byId.get(id) ?? id),
  };
}

/** The API supplies download URLs.  Credentials never follow them to a storage service. */
export function taskFiles(field: SourceField, address: string): FieldPlan {
  return filesPlan(field, (value) =>
    itemsOf(value).map((item) => {
      const url = stringOf(item.download_url ?? item.url) ?? '';
      if (!url) return { url: '', filename: item.name ?? item.title, size: null, problem: 'failed' as const };
      return platformAttachment(
        address,
        {
          url,
          filename: item.name ?? item.title,
          size: typeof item.size === 'number' ? item.size : null,
        },
        (path) => /^\/(?:api\/v2\/attachments|api\/1\.0\/attachments|files)\//.test(path),
      );
    }),
  );
}

/** Deferred links resolve after every selected table and its descendants have been read. */
export class TaskLinks {
  private readonly members = new Map<string, Set<string>>();
  private readonly refs = new Map<string, Map<string, Record<string, string[]>>>();
  private readonly fields = new Map<string, { relation: string; target: string }>();

  plans(field: SourceField, tables: readonly { id: string; name: string }[], single = false): FieldPlan[] {
    return [
      {
        kind: 'deferredLink',
        source: field,
        id: newId('field'),
        name: field.name,
        notes: [],
        targets: tables,
        prefersSingle: single,
      },
    ];
  }

  preview(schema: SourceSchema): void {
    const incoming = new Map<string, number>();
    for (const table of schema.tables)
      for (const field of table.fields)
        if (field.kind === 'deferredLink')
          for (const target of field.targets) incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1);
    for (const table of schema.tables) {
      const sourceFields = table.fields.filter(
        (field) => field.kind !== 'omitted' && field.kind !== 'deferredLink',
      ).length;
      const outgoing = table.fields.reduce(
        (count, field) => count + (field.kind === 'deferredLink' ? field.targets.length : 0),
        0,
      );
      if (sourceFields + outgoing + (incoming.get(table.id) ?? 0) > LIMITS.fieldsPerTable)
        table.notes.push(
          note('changed', 'import.platform.report.taskLinkCapacity', { max: LIMITS.fieldsPerTable }),
        );
    }
  }

  finalize(schema: SourceSchema): void {
    for (const table of schema.tables) {
      const plans: FieldPlan[] = [];
      for (const field of table.fields) {
        if (field.kind !== 'deferredLink') continue;
        const needed = new Set<string>();
        let outside = 0;
        for (const refs of this.refs.get(table.id)?.values() ?? [])
          for (const id of refs[field.source.id] ?? []) {
            const members = this.members.get(id);
            if (!members) outside++;
            else for (const member of members) needed.add(member);
          }
        if (outside)
          table.notes.push(note('omitted', 'import.platform.report.taskLinksOutside', { count: outside }));
        for (const target of field.targets) {
          if (!needed.has(target.id)) continue;
          const id = `${field.source.id}:${target.id}`;
          this.fields.set(id, { relation: field.source.id, target: target.id });
          plans.push(
            linkPlan(
              { ...field.source, id, name: `${field.source.name} (${target.name})` },
              target.id,
              null,
              field.prefersSingle,
              null,
            ),
          );
        }
      }
      // Source fields get the available slots before synthetic links and their inverse fields.
      table.fields = [...table.fields.filter((field) => field.kind !== 'deferredLink'), ...plans];
    }
  }

  record(table: string, id: string, refs: Record<string, string[]>): void {
    const members = this.members.get(id) ?? new Set<string>();
    members.add(table);
    this.members.set(id, members);
    const rows = this.refs.get(table) ?? new Map<string, Record<string, string[]>>();
    rows.set(id, refs);
    this.refs.set(table, rows);
  }

  async *links(table: SourceTable, link: LinkPlan, ids: readonly string[]) {
    const field = this.fields.get(link.source.id)!;
    for (let at = 0; at < ids.length; at += 100) {
      yield ids.slice(at, at + 100).map((record) => ({
        record,
        targets: [...new Set(this.refs.get(table.id)?.get(record)?.[field.relation] ?? [])].filter((id) =>
          this.members.get(id)?.has(field.target),
        ),
      }));
    }
  }
}

/** Read offsets only, never an API-provided next-page URL that could send credentials elsewhere. */
export async function* asanaPages<T>(
  client: PlatformClient,
  path: string,
  schema: z.ZodType<T>,
  query: Record<string, string | number | undefined> = {},
  purpose: 'list' | 'base' = 'base',
): AsyncGenerator<T[]> {
  const pageSchema = z.object({
    data: z.array(schema),
    next_page: z.object({ offset: z.string().min(1) }).nullish(),
  });
  const seen = new Set<string>();
  let offset: string | undefined;
  do {
    const page = await client.json(path, pageSchema, { query: { ...query, limit: 100, offset }, purpose });
    yield page.data;
    offset = page.next_page?.offset;
    if (offset && seen.has(offset)) throw new AppError('unavailable', 'import.platform.unreadable');
    if (offset) seen.add(offset);
  } while (offset);
}
