import { AppError, LIMITS, type PlatformBase, type PlatformImportRequest } from '@riosoma/contracts';
import { z } from 'zod';
import type { Attachment } from '../../core/files.js';
import { isRecord, textOf } from '../../core/values.js';
import { platformAttachment } from '../attachments.js';
import {
  asDay,
  asInstant,
  asNumber,
  asText,
  choicesOf,
  colorOfName,
  emailsOf,
  filesPlan,
  formulaOptions,
  linkPlan,
  note,
  peoplePlan,
  valuePlan,
} from '../fields.js';
import type { PlatformClient, Purpose } from '../http.js';
import type { ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  SourceCondition,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';
import { smartsheetFormula } from './formulas.js';

/** Numeric API IDs stay strings internally.  Unsafe integers are refused before they can collide. */
const Id = z.number().int().positive().refine(Number.isSafeInteger).transform(String);
const PAGE = 200;
const unreadable = () => new AppError('unavailable', 'import.platform.unreadable');
const Item = z.object({ id: Id, name: z.string(), accessLevel: z.string().optional() });
const Cell = z.object({
  columnId: Id,
  value: z.unknown().optional(),
  displayValue: z.string().nullish(),
  objectValue: z.unknown().optional(),
  formula: z.string().optional(),
  linkInFromCell: z.unknown().optional(),
  linksOutToCells: z.array(z.unknown()).optional(),
});
const Row = z.object({ id: Id, parentId: Id.optional(), cells: z.array(Cell) });
type Row = z.infer<typeof Row>;
const Column = z.object({
  id: Id,
  title: z.string(),
  type: z.string(),
  index: z.number().int().nonnegative(),
  primary: z.boolean().optional(),
  description: z.string().nullish(),
  hidden: z.boolean().optional(),
  systemColumnType: z.string().nullish(),
  formula: z.string().optional(),
  symbol: z.string().optional(),
  options: z.array(z.string()).optional(),
  autoNumberFormat: z
    .object({ prefix: z.string().optional(), suffix: z.string().optional(), fill: z.string().optional() })
    .nullish(),
  tags: z.array(z.string()).optional(),
});
type Column = z.infer<typeof Column>;
const Filter = z.object({
  id: Id,
  name: z.string().optional(),
  excludeSelected: z.boolean().optional(),
  query: z.object({
    operator: z.string().optional(),
    includeParent: z.boolean().optional(),
    criteria: z.array(z.unknown()),
  }),
});
const Sheet = z.object({
  id: Id,
  name: z.string(),
  version: z.number().optional(),
  totalRowCount: z.number().int().nonnegative(),
  columns: z.array(Column),
  rows: z.array(Row),
  crossSheetReferences: z.array(z.unknown()).optional(),
  filters: z.array(Filter).optional(),
  ganttEnabled: z.boolean().optional(),
  projectSettings: z
    .object({ lengthOfDay: z.number().min(1).max(24), workingDays: z.array(z.string()).optional() })
    .optional(),
});
type Sheet = z.infer<typeof Sheet>;
const File = z.object({
  id: Id,
  name: z.string(),
  attachmentType: z.string(),
  parentType: z.string().optional(),
  parentId: Id.optional(),
  sizeInKb: z.number().nonnegative().optional(),
  url: z.string().optional(),
});
type File = z.infer<typeof File>;

/** IndexResult uses numbered pages.  The server can return fewer items than the requested page size. */
async function* pages<T>(
  client: PlatformClient,
  path: string,
  item: z.ZodType<T>,
  purpose: Purpose = 'base',
) {
  const schema = z.object({
    pageNumber: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    data: z.array(item),
  });
  for (let page = 1; ; page++) {
    const answer = await client.json(path, schema, { query: { page, pageSize: PAGE }, purpose });
    // Empty IndexResults can report page zero even when page one was requested.
    if (answer.totalPages === 0 && !answer.data.length) return;
    if (answer.pageNumber !== page || (page < answer.totalPages && !answer.data.length)) throw unreadable();
    yield answer.data;
    if (page >= answer.totalPages) return;
  }
}

/** The path response is one workspace with one folder at each level, ending at the sheet. */
export function pathGroup(path: unknown, sheetId: string): string | null {
  let node = path;
  const names: string[] = [];
  for (let depth = 0; depth < 32 && isRecord(node); depth++) {
    if (typeof node.name === 'string' && node.name) names.push(node.name);
    if (
      Array.isArray(node.sheets) &&
      node.sheets.some((sheet) => isRecord(sheet) && String(sheet.id) === sheetId)
    )
      return names.join(' / ') || null;
    node = Array.isArray(node.folders) && node.folders.length === 1 ? node.folders[0] : null;
  }
  return null;
}

function raw(cell: z.infer<typeof Cell> | undefined): unknown {
  const value = cell?.objectValue ?? cell?.value ?? null;
  if (isRecord(value) && ['DATE', 'DATETIME', 'ABSTRACT_DATETIME'].includes(String(value.objectType)))
    return value.value ?? null;
  return value;
}
const shown = (value: unknown) => (isRecord(value) ? textOf(value) : asText(value));
const ids = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(ids) : [];

function pickValues(value: unknown, multiple: boolean): unknown[] | null {
  if (value === null || value === undefined || value === '') return [];
  if (!multiple) return [value];
  const list = isRecord(value) ? value.values : value;
  return Array.isArray(list) ? list : null;
}

function pickLabel(value: unknown): string | null {
  const label = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof label === 'string' &&
    label.length > 0 &&
    label.length <= LIMITS.nameLength &&
    label.trim() === label
    ? label
    : null;
}

/** Project datetimes without an offset do not identify an instant in the sheet response. */
function projectInstant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : new Date(date).toISOString();
}

/** Durations use the sheet's workday, while elapsed durations use calendar days. */
export function durationSeconds(value: unknown, sheet: Pick<Sheet, 'projectSettings'>): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (isRecord(value) && value.objectType === 'DURATION') {
    const day = value.elapsed === true ? 24 : (sheet.projectSettings?.lengthOfDay ?? 8);
    const week = value.elapsed === true ? 7 : (sheet.projectSettings?.workingDays?.length ?? 5);
    const units = {
      weeks: week * day * 3600,
      days: day * 3600,
      hours: 3600,
      minutes: 60,
      seconds: 1,
      milliseconds: 0.001,
    };
    let seconds = 0;
    let found = false;
    for (const [unit, multiplier] of Object.entries(units)) {
      if (value[unit] === undefined) continue;
      const amount = value[unit];
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return value;
      found = true;
      seconds += amount * multiplier;
    }
    return found ? (value.negative === true ? -seconds : seconds) : value;
  }
  if (typeof value !== 'string') return value;
  const match = /^(e)?\s*([+-])?\s*((?:\d+(?:\.\d+)?\s*[wdhms]\s*)+)$/i.exec(value.trim());
  if (!match) return value;
  const day = match[1] ? 24 : (sheet.projectSettings?.lengthOfDay ?? 8);
  const week = match[1] ? 7 : (sheet.projectSettings?.workingDays?.length ?? 5);
  const units: Record<string, number> = { w: week * day * 3600, d: day * 3600, h: 3600, m: 60, s: 1 };
  let seconds = 0;
  for (const part of match[3]!.matchAll(/(\d+(?:\.\d+)?)\s*([wdhms])/gi))
    seconds += Number(part[1]) * units[part[2]!.toLowerCase()]!;
  return (match[2] === '-' ? -1 : 1) * seconds;
}

export function planColumn(column: Column, sheet: Sheet): FieldPlan {
  const source = { id: column.id, name: column.title, description: column.description };
  const values = sheet.rows
    .map((row) => raw(row.cells.find((cell) => cell.columnId === column.id)))
    .filter((value) => value !== null && value !== '');
  const numeric = values.length > 0 && values.every((value) => typeof value === 'number');
  const notes = [];
  if (
    sheet.rows.some((row) =>
      row.cells.some(
        (cell) => cell.columnId === column.id && (cell.linkInFromCell || cell.linksOutToCells?.length),
      ),
    )
  )
    notes.push(note('changed', 'import.platform.report.cellLinksFixed'));
  let plan: FieldPlan;
  if (column.systemColumnType === 'AUTO_NUMBER') {
    const format = column.autoNumberFormat;
    plan =
      format?.prefix || format?.suffix || format?.fill
        ? valuePlan(source, { type: 'text', options: {} }, asText, [
            note('changed', 'import.platform.report.autoNumberMask'),
          ])
        : valuePlan(
            source,
            { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
            asNumber,
            [],
            { kind: 'autoNumber' },
          );
  } else if (['CREATED_BY', 'MODIFIED_BY'].includes(column.systemColumnType ?? '')) {
    plan = peoplePlan(source, emailsOf, false, [note('changed', 'import.platform.report.peopleFixed')]);
  } else if (['CREATED_DATE', 'MODIFIED_DATE'].includes(column.systemColumnType ?? '')) {
    plan = valuePlan(
      source,
      {
        type: 'date',
        options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'client' },
      },
      asInstant,
      [note('changed', 'import.platform.report.timeFixed')],
    );
  } else
    switch (column.type) {
      case 'TEXT_NUMBER':
        plan =
          numeric && !column.primary
            ? valuePlan(
                source,
                column.tags?.some((tag) =>
                  ['GANTT_PERCENT_COMPLETE', 'RESOURCE_MANAGEMENT_PERCENT_ALLOCATION'].includes(tag),
                )
                  ? { type: 'percent', options: { precision: 2, allowNegative: true } }
                  : { type: 'number', options: { precision: null, thousands: true, allowNegative: true } },
                (value) => value,
              )
            : valuePlan(source, { type: 'text', options: {} }, asText, [
                note('changed', 'import.platform.report.textNumber'),
              ]);
        break;
      case 'DATE':
        plan = valuePlan(
          source,
          {
            type: 'date',
            options: {
              includeTime: false,
              dateFormat: 'local',
              timeFormat: 'local',
              timeZone: 'client',
            },
          },
          asDay,
        );
        break;
      case 'ABSTRACT_DATETIME':
        plan = values.every((value) => projectInstant(value) !== null)
          ? valuePlan(
              source,
              {
                type: 'date',
                options: { includeTime: true, dateFormat: 'local', timeFormat: 'local', timeZone: 'client' },
              },
              projectInstant,
            )
          : valuePlan(source, { type: 'text', options: {} }, asText, [
              note('changed', 'import.platform.report.datetimeText'),
            ]);
        break;
      case 'CONTACT_LIST':
      case 'MULTI_CONTACT_LIST':
        plan = peoplePlan(
          source,
          (value) =>
            emailsOf(
              isRecord(value) && Array.isArray(value.values ?? value.value)
                ? (value.values ?? value.value)
                : value,
            ),
          column.type === 'MULTI_CONTACT_LIST',
        );
        break;
      case 'CHECKBOX':
        // Lenient Smartsheet cells can hold text.  Passing it through lets validation report it.
        plan = valuePlan(
          source,
          { type: 'checkbox', options: { color: 'green' } },
          (value) => value ?? null,
          [
            ...(column.symbol ? [note('changed', 'import.platform.report.checkboxIcon')] : []),
            ...(sheet.rows.some(
              (row) => !row.cells.some((cell) => cell.columnId === column.id && raw(cell) !== null),
            )
              ? [note('changed', 'import.platform.report.checkboxBlank')]
              : []),
          ],
        );
        break;
      case 'PICKLIST':
      case 'MULTI_PICKLIST': {
        const multiple = column.type === 'MULTI_PICKLIST';
        const observed = values.map((value) => pickValues(value, multiple));
        const labels = [...(column.options ?? []), ...observed.flatMap((list) => list ?? []).map(pickLabel)];
        if (
          observed.some((list) => list === null) ||
          labels.some((label) => pickLabel(label) === null) ||
          new Set(labels).size > LIMITS.choicesPerField
        ) {
          plan = valuePlan(
            source,
            { type: 'text', options: {} },
            (value) =>
              asText(multiple && isRecord(value) && Array.isArray(value.values) ? value.values : value),
            [note('changed', 'import.platform.report.selectText')],
          );
          break;
        }
        const { choices, byName } = choicesOf(
          (labels as string[]).map((name) => ({ name, color: column.symbol ? colorOfName(name) : 'gray' })),
        );
        plan = valuePlan(
          source,
          { type: multiple ? 'multipleSelect' : 'singleSelect', options: { choices } },
          (value) => {
            const selected = (pickValues(value, multiple) ?? []).map((name) => byName.get(String(name))!);
            return selected.length ? (multiple ? selected : selected[0]) : null;
          },
        );
        if (labels.some((label) => !(column.options ?? []).includes(label!)))
          plan.notes.push(note('changed', 'import.platform.report.selectExpanded'));
        if (column.symbol) plan.notes.push(note('changed', 'import.platform.report.symbolSelect'));
        break;
      }
      case 'DURATION': {
        const valid = values.every((value) => typeof durationSeconds(value, sheet) === 'number');
        plan = valid
          ? valuePlan(
              source,
              { type: 'duration', options: { format: 'h:mm:ss' } },
              (value) => durationSeconds(value, sheet),
              [note('changed', 'import.platform.report.durationCalendar')],
            )
          : valuePlan(source, { type: 'text', options: {} }, asText, [
              note('changed', 'import.platform.report.durationText'),
            ]);
        break;
      }
      case 'PREDECESSOR':
        plan = linkPlan(source, sheet.id, null, false, (value) =>
          isRecord(value) && Array.isArray(value.predecessors)
            ? value.predecessors.flatMap((item) =>
                isRecord(item) && typeof item.rowId === 'number' && Number.isSafeInteger(item.rowId)
                  ? [String(item.rowId)]
                  : [],
              )
            : [],
        );
        plan.notes.push(note('changed', 'import.platform.report.predecessorSchedule'));
        // Keep the displayed relationship and lag beside the links, including free-form values.
        break;
      default:
        plan = valuePlan(source, { type: 'text', options: {} }, shown, [
          note('changed', 'import.platform.report.unknownColumn', { type: column.type.slice(0, 64) }),
        ]);
    }
  plan.notes.push(...notes);
  if (plan.kind === 'value' && column.formula) {
    const written = smartsheetFormula(column.formula);
    plan.finish = { kind: 'formula', shown: column.formula, ...written, options: formulaOptions() };
    if (written.expression === null) plan.notes.push(note('changed', 'import.platform.report.formulaUnread'));
  } else if (sheet.rows.some((row) => row.cells.some((cell) => cell.columnId === column.id && cell.formula)))
    plan.notes.push(note('changed', 'import.platform.report.triggerFormula'));
  return plan;
}

/** Shared filters become grid views.  Row and grid predicates remain explicit fidelity notes. */
function views(sheet: Sheet): SourceView[] {
  const shown = sheet.columns.filter((column) => !column.hidden).map((column) => column.id);
  const grid: SourceView = { id: sheet.id, name: sheet.name, type: 'GRID', kind: 'grid', shown, notes: [] };
  if (sheet.ganttEnabled) grid.notes.push(note('changed', 'import.platform.report.projectViews'));
  return [
    grid,
    ...(sheet.filters ?? []).map((filter): SourceView => {
      const conditions: SourceCondition[] = [];
      for (const criterion of filter.query.criteria) {
        if (!isRecord(criterion) || typeof criterion.columnId !== 'number') continue;
        const field = String(criterion.columnId);
        const column = sheet.columns.find((item) => item.id === field);
        if (!column) continue;
        const args = Array.isArray(criterion.values) ? criterion.values : [];
        const operator = String(criterion.operator);
        if (operator === 'IS_BLANK' || operator === 'IS_NOT_BLANK')
          conditions.push({
            field,
            operator: operator === 'IS_BLANK' ? 'isEmpty' : 'isNotEmpty',
            value: { kind: 'none' },
          });
        else if (column.type === 'CHECKBOX' && ['IS_CHECKED', 'IS_UNCHECKED'].includes(operator))
          conditions.push({
            field,
            operator: 'is',
            value: { kind: 'boolean', value: operator === 'IS_CHECKED' },
          });
        else if (
          ['PICKLIST', 'MULTI_PICKLIST'].includes(column.type) &&
          ['IS_ONE_OF', 'IS_NOT_ONE_OF', 'HAS_ANY_OF', 'HAS_ALL_OF', 'HAS_NONE_OF'].includes(operator)
        ) {
          const operators = {
            IS_ONE_OF: 'isAnyOf',
            IS_NOT_ONE_OF: 'isNoneOf',
            HAS_ANY_OF: 'hasAnyOf',
            HAS_ALL_OF: 'hasAllOf',
            HAS_NONE_OF: 'hasNoneOf',
          } as const;
          conditions.push({
            field,
            operator: operators[operator as keyof typeof operators],
            value: { kind: 'choices', names: args.map(String) },
          });
        } else if (
          ['EQUAL', 'NOT_EQUAL', 'CONTAINS', 'DOES_NOT_CONTAIN'].includes(operator) &&
          typeof args[0] === 'string'
        ) {
          const operators = {
            EQUAL: 'is',
            NOT_EQUAL: 'isNot',
            CONTAINS: 'contains',
            DOES_NOT_CONTAIN: 'doesNotContain',
          } as const;
          conditions.push({
            field,
            operator: operators[operator as keyof typeof operators],
            value: { kind: 'text', text: args[0] },
          });
        }
      }
      const dropped = filter.excludeSelected || filter.query.includeParent;
      return {
        id: filter.id,
        name: filter.name ?? filter.id,
        type: 'GRID',
        kind: 'grid',
        shown,
        filter:
          dropped || !conditions.length
            ? null
            : { conjunction: filter.query.operator === 'OR' ? 'or' : 'and', conditions },
        unmatched: dropped ? filter.query.criteria.length : filter.query.criteria.length - conditions.length,
        notes: [],
      };
    }),
  ];
}

class SmartsheetSource {
  readonly platform = 'smartsheet' as const;
  private loaded?: Promise<SourceSchema>;
  private sheet?: Sheet;
  private attachments: File[] = [];

  constructor(
    private readonly client: PlatformClient,
    private readonly sheetId: string,
    private readonly names: Required<
      Pick<
        NonNullable<PlatformImportRequest['fieldNames']>,
        'parent' | 'attachments' | 'attachmentName' | 'attachmentParent' | 'predecessorDetails'
      >
    >,
  ) {}

  schema(): Promise<SourceSchema> {
    return (this.loaded ??= this.load());
  }

  private async load(): Promise<SourceSchema> {
    if (!/^\d+$/.test(this.sheetId)) throw new AppError('not_found', 'import.platform.baseUnavailable');
    const rows: Row[] = [];
    let sheet: Sheet | undefined;
    for (let page = 1; ; page++) {
      const answer = await this.client.json(`/sheets/${this.sheetId}`, Sheet, {
        query: {
          level: 2,
          include: 'objectValue,crossSheetReferences,filterDefinitions',
          page,
          pageSize: PAGE,
        },
      });
      if (
        answer.id !== this.sheetId ||
        (sheet && (sheet.version !== answer.version || sheet.totalRowCount !== answer.totalRowCount))
      )
        throw unreadable();
      sheet ??= answer;
      rows.push(...answer.rows);
      if (rows.length >= answer.totalRowCount) break;
      if (!answer.rows.length) throw unreadable();
    }
    if (new Set(rows.map((row) => row.id)).size !== rows.length || rows.length !== sheet.totalRowCount)
      throw unreadable();
    sheet.rows = rows;
    this.sheet = sheet;
    for await (const page of pages(this.client, `/sheets/${this.sheetId}/attachments`, File))
      this.attachments.push(...page);
    const fields = [...sheet.columns]
      .sort((a, b) => a.index - b.index)
      .map((column) => planColumn(column, sheet));
    for (const column of sheet.columns.filter((item) => item.type === 'PREDECESSOR'))
      fields.push(
        valuePlan(
          { id: `details:${column.id}`, name: `${column.title} (${this.names.predecessorDetails})` },
          { type: 'text', options: {} },
          asText,
        ),
      );
    fields.push(linkPlan({ id: 'parent', name: this.names.parent }, sheet.id, null, true, ids));
    fields.push(
      filesPlan({ id: 'attachments', name: this.names.attachments }, (value) =>
        Array.isArray(value) ? (value as Attachment[]) : [],
      ),
    );
    const notes = [note('changed', 'import.platform.report.notShared')];
    if (sheet.crossSheetReferences?.length)
      notes.push(note('changed', 'import.platform.report.crossSheetFixed'));
    const tables: SourceTable[] = [
      {
        id: sheet.id,
        name: sheet.name,
        recordCount: rows.length,
        primary: sheet.columns.find((column) => column.primary)?.id ?? null,
        fields,
        views: views(sheet),
        notes,
      },
    ];
    if (this.attachments.some((file) => file.parentType !== 'ROW')) {
      tables.push({
        id: 'sheetAttachments',
        name: this.names.attachments,
        recordCount: this.attachments.filter((file) => file.parentType !== 'ROW').length,
        primary: 'name',
        fields: [
          valuePlan({ id: 'name', name: this.names.attachmentName }, { type: 'text', options: {} }, asText),
          valuePlan(
            { id: 'parent', name: this.names.attachmentParent },
            { type: 'text', options: {} },
            asText,
          ),
          filesPlan({ id: 'files', name: this.names.attachments }, (value) =>
            Array.isArray(value) ? (value as Attachment[]) : [],
          ),
        ],
        views: [],
        notes: [note('changed', 'import.platform.report.sheetAttachments')],
      });
    }
    return { tables, notes: [] };
  }

  private attachment(file: File): Attachment {
    return {
      url: '',
      filename: file.name,
      size: file.sizeInKb === undefined ? null : file.sizeInKb * 1024,
      ...(file.attachmentType === 'FILE'
        ? { prepare: () => this.signedAttachment(file) }
        : { problem: 'failed' as const }),
    };
  }

  private async signedAttachment(file: File): Promise<Attachment> {
    const fallback: Attachment = {
      url: '',
      filename: file.name,
      size: file.sizeInKb === undefined ? null : file.sizeInKb * 1024,
      problem: 'failed',
    };
    if (file.attachmentType !== 'FILE') return fallback;
    try {
      // Signed links are resolved just before download, and carry no API credentials.
      const detail = await this.client.json(`/sheets/${this.sheetId}/attachments/${file.id}`, File);
      if (!detail.url || detail.id !== file.id) return fallback;
      return platformAttachment(
        this.client.options.address,
        { url: detail.url, filename: file.name, size: fallback.size },
        () => false,
      );
    } catch (error) {
      this.client.options.signal?.throwIfAborted();
      if (error instanceof AppError) return fallback;
      throw error;
    }
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    await this.schema();
    if (table.id === 'sheetAttachments') {
      for (const file of this.attachments.filter((item) => item.parentType !== 'ROW'))
        yield [
          {
            id: file.id,
            values: {
              name: file.name,
              parent: `${file.parentType ?? ''}:${file.parentId ?? ''}`,
              files: [this.attachment(file)],
            },
          },
        ];
      return;
    }
    const rows = this.sheet!.rows;
    for (let start = 0; start < rows.length; start += PAGE) {
      const records: SourceRecord[] = [];
      for (const row of rows.slice(start, start + PAGE)) {
        const values = Object.fromEntries(row.cells.map((cell) => [cell.columnId, raw(cell)]));
        for (const column of this.sheet!.columns.filter((item) => item.type === 'PREDECESSOR')) {
          const cell = row.cells.find((item) => item.columnId === column.id);
          values[`details:${column.id}`] = cell?.displayValue ?? cell?.value ?? textOf(cell?.objectValue);
        }
        values.parent = row.parentId ?? null;
        const files = this.attachments.filter(
          (file) => file.parentType === 'ROW' && file.parentId === row.id,
        );
        values.attachments = [];
        for (const file of files) (values.attachments as Attachment[]).push(this.attachment(file));
        records.push({ id: row.id, values });
      }
      yield records;
    }
  }
}

export const smartsheetReader: ReaderFactory = (context) => {
  const token = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: `Bearer ${token}` }),
    secrets: () => [token],
  });
  return {
    kept: async () => context.credential,
    bases: async (): Promise<PlatformBase[]> => {
      const bases: PlatformBase[] = [];
      for await (const page of pages(client, '/sheets', Item, 'list')) {
        for (const sheet of page) {
          let group: string | null = null;
          try {
            group = pathGroup(await client.json(`/sheets/${sheet.id}/path`, z.unknown()), sheet.id);
          } catch (error) {
            context.signal?.throwIfAborted();
            if (!(error instanceof AppError) || error.code !== 'not_found') throw error;
          }
          bases.push({ id: sheet.id, name: sheet.name, group });
        }
      }
      return bases;
    },
    source: (id) => {
      const { parent, attachments, attachmentName, attachmentParent, predecessorDetails } =
        context.fieldNames ?? {};
      if (!parent || !attachments || !attachmentName || !attachmentParent || !predecessorDetails)
        throw new AppError('validation_failed', 'errors.validationFailed', {
          fields: { fieldNames: 'validation.custom' },
        });
      return new SmartsheetSource(client, id, {
        parent,
        attachments,
        attachmentName,
        attachmentParent,
        predecessorDetails,
      });
    },
  };
};
