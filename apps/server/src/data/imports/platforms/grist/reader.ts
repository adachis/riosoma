import { isTimeZone, type ViewType } from '@riosoma/contracts';
import { z } from 'zod';
import type { Attachment } from '../../core/files.js';
import type { Note } from '../../core/report.js';
import { isRecord, textOf } from '../../core/values.js';
import {
  asNumber,
  asText,
  choicesOf,
  colorOfHex,
  dateFormatOf,
  filesPlan,
  formulaOptions,
  linkPlan,
  note,
  precisionOf,
  valuePlan,
} from '../fields.js';
import type { PlatformClient } from '../http.js';
import type { ReaderFactory } from '../importer.js';
import type {
  FieldPlan,
  Finish,
  PlatformSource,
  SourceCondition,
  SourceFilter,
  SourceRecord,
  SourceSchema,
  SourceTable,
  SourceView,
} from '../model.js';
import { lookedUp, translateGrist, type ColumnKinds } from './formulas.js';

/**
 * Grist, through its REST API with an API key sent as a bearer token.  Documents come from each
 * organization's workspaces, tables and columns from the document's API, records a page at a time,
 * with the SQL endpoint picking each page's record IDs in the document's own order, and files from
 * its attachments.  Grist keeps its pages, widgets, sorts, and filters in metadata tables, which
 * its API reads like any table, so each widget becomes a view with its columns, sort, and filter.
 * Formulas are Python, and come across as formulas here when they translate.
 */

const PAGE = 500;

const Org = z.object({ id: z.number(), name: z.string() });
const Workspaces = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    docs: z.array(z.object({ id: z.string().min(1), name: z.string() })).default([]),
  }),
);
const Tables = z.object({
  tables: z.array(
    z.object({
      id: z.string().min(1),
      fields: z.object({
        tableRef: z.number().optional(),
        primaryViewId: z.number().nullish(),
        rawViewSectionRef: z.number().nullish(),
        summarySourceTable: z.number().nullish(),
      }),
    }),
  ),
});
const Column = z.object({
  id: z.string().min(1),
  fields: z.object({
    colRef: z.number().optional(),
    label: z.string().nullish(),
    description: z.string().nullish(),
    type: z.string(),
    isFormula: z.boolean().nullish(),
    formula: z.string().nullish(),
    widgetOptions: z.string().nullish(),
    reverseCol: z.number().nullish(),
  }),
});
type Column = z.infer<typeof Column>;
const Columns = z.object({ columns: z.array(Column) });
const Records = z.object({
  records: z.array(
    z.object({
      id: z.number(),
      fields: z.record(z.string(), z.unknown()),
      errors: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
});
const Sql = z.object({ records: z.array(z.object({ fields: z.object({ id: z.number() }) })) });
const meta = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ records: z.array(z.object({ id: z.number(), fields: z.object(shape) })) });
const Sections = meta({
  tableRef: z.number(),
  parentId: z.number(),
  parentKey: z.string(),
  title: z.string().nullish(),
  sortColRefs: z.string().nullish(),
  linkSrcSectionRef: z.number().nullish(),
});
const SectionFields = meta({ parentId: z.number(), parentPos: z.number().nullish(), colRef: z.number() });
const Filters = meta({ viewSectionRef: z.number(), colRef: z.number(), filter: z.string().nullish() });
const Views = meta({ name: z.string().nullish() });
const Pages = meta({ viewRef: z.number(), pagePos: z.number().nullish() });
const ColumnMeta = meta({ colId: z.string(), parentId: z.number() });
const AttachmentMeta = meta({ fileName: z.string().nullish(), fileSize: z.number().nullish() });

type Kind = ReturnType<ColumnKinds>;

const helper = (id: string) => id === 'manualSort' || id.startsWith('gristHelper_');

function options(column: Column): Record<string, unknown> {
  try {
    const parsed: unknown = column.fields.widgetOptions ? JSON.parse(column.fields.widgetOptions) : {};
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Grist's type for a column, and what it names after the colon, like a table or a time zone */
function typeOf(column: Column): { base: string; detail: string } {
  const [base = 'Any', ...rest] = column.fields.type.split(':');
  return { base, detail: rest.join(':') };
}

function kindOf(column: Column): Kind {
  switch (typeOf(column).base) {
    case 'Text':
    case 'Choice':
      return 'text';
    case 'Numeric':
    case 'Int':
      return 'number';
    case 'Bool':
      return 'boolean';
    case 'Date':
    case 'DateTime':
      return 'date';
    default:
      return 'unknown';
  }
}

/** A Grist list, like `["L", 1, 2]`, as its items */
function listOf(value: unknown): unknown[] {
  return Array.isArray(value) && value[0] === 'L' ? value.slice(1) : [];
}

const asDay = (value: unknown) =>
  typeof value === 'number' ? new Date(value * 1_000).toISOString().slice(0, 10) : (value ?? null);
const asInstant = (value: unknown) =>
  typeof value === 'number' ? new Date(value * 1_000).toISOString() : (value ?? null);

function anyText(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value[0] === 'L') return textOf(listOf(value));
  if (isRecord(value) || Array.isArray(value)) return JSON.stringify(value);
  return textOf(value);
}

function readerFor(column: Column): (value: unknown) => unknown {
  switch (typeOf(column).base) {
    case 'Numeric':
    case 'Int':
      return asNumber;
    case 'Bool':
      return (value) => value === true;
    case 'Date':
      return asDay;
    case 'DateTime':
      return asInstant;
    case 'ChoiceList':
      return (value) => textOf(listOf(value));
    default:
      return (value) => (Array.isArray(value) && value[0] === 'L' ? textOf(listOf(value)) : asText(value));
  }
}

interface Context {
  kinds: ColumnKinds;
  /** Column IDs by their row IDs in the metadata */
  columnIds: ReadonlyMap<number, string>;
  attachment(id: number): Attachment | null;
  tables: ReadonlySet<string>;
}

/** How one Grist column comes across, or null for the columns Grist keeps for itself. */
export function planGristColumn(column: Column, context: Context): FieldPlan | null {
  if (helper(column.id)) return null;
  const field = {
    id: column.id,
    name: column.fields.label?.trim() || column.id,
    description: column.fields.description ?? null,
  };
  const widget = options(column);
  const { base, detail } = typeOf(column);
  const formula = column.fields.formula?.trim() ?? '';
  const computed = Boolean(column.fields.isFormula) && formula !== '';
  const notes: Note[] =
    !column.fields.isFormula && formula ? [note('changed', 'import.platform.report.triggerFormula')] : [];
  const read = readerFor(column);

  if (base === 'Ref' || base === 'RefList') {
    if (!context.tables.has(detail))
      return valuePlan(field, { type: 'text', options: {} }, read, [
        note('changed', 'import.platform.report.linkMissing'),
      ]);
    const inverse = column.fields.reverseCol
      ? (context.columnIds.get(column.fields.reverseCol) ?? null)
      : null;
    const plan = linkPlan(field, detail, inverse, base === 'Ref', (value) =>
      base === 'Ref'
        ? typeof value === 'number' && value > 0
          ? [String(value)]
          : []
        : listOf(value).flatMap((item) => (typeof item === 'number' ? [String(item)] : [])),
    );
    if (computed) plan.notes.push(note('changed', 'import.platform.report.formulaLinks', { formula }));
    return plan;
  }
  if (base === 'Attachments')
    return filesPlan(field, (value) =>
      listOf(value).flatMap((item) => {
        const found = typeof item === 'number' ? context.attachment(item) : null;
        return found ? [found] : [];
      }),
    );

  let finish: Finish | undefined;
  const looked = computed ? lookedUp(formula) : null;
  if (looked) {
    const via = { table: looked.table, field: looked.field };
    finish =
      looked.kind === 'count'
        ? { kind: 'count', via, shown: formula }
        : looked.kind === 'lookup'
          ? { kind: 'lookup', via, target: looked.target, shown: formula }
          : { kind: 'rollup', via, target: looked.target, fn: looked.fn, shown: formula };
  } else if (computed) {
    const written = translateGrist(formula, context.kinds);
    finish = {
      kind: 'formula',
      shown: formula,
      expression: written.expression,
      ...(written.problem ? { problem: written.problem } : {}),
      functions: written.functions,
      options: formulaOptions({
        precision: precisionOf(widget.decimals),
        dateFormat: dateFormatOf(widget.dateFormat),
        ...(base === 'DateTime' && isTimeZone(detail) ? { timeZone: detail } : {}),
      }),
    };
  }
  const plan = (spec: Parameters<typeof valuePlan>[1], reader = read, extra: Note[] = []) =>
    valuePlan(field, spec, reader, [...notes, ...extra], finish);

  switch (base) {
    case 'Text': {
      if (widget.widget === 'HyperLink') {
        // Grist keeps a link's label before its address, and a URL field here holds only the address.
        const labels: Note[] = [];
        const made = plan({ type: 'url', options: {} }, (value) => {
          if (typeof value !== 'string') return value ?? null;
          const parts = value.trim().split(/\s+/);
          if (parts.length > 1 && !labels.length) {
            labels.push(note('changed', 'import.platform.report.linkLabels'));
            made.notes.push(...labels);
          }
          return parts.at(-1) ?? null;
        });
        return made;
      }
      if (widget.widget === 'Markdown') return plan({ type: 'longText', options: { richText: true } });
      if (widget.wrap === true) return plan({ type: 'longText', options: { richText: false } });
      return plan({ type: 'text', options: {} });
    }
    case 'Numeric':
    case 'Int': {
      const precision = base === 'Int' ? 0 : precisionOf(widget.decimals);
      if (widget.numMode === 'currency') {
        const code = typeof widget.currency === 'string' ? widget.currency.toUpperCase() : 'USD';
        if (/^[A-Z]{3}$/.test(code) && Intl.supportedValuesOf('currency').includes(code))
          return plan({
            type: 'currency',
            options: { code, precision: precision ?? 2, allowNegative: true },
          });
        return plan({ type: 'number', options: { precision, thousands: true, allowNegative: true } }, read, [
          note('changed', 'import.platform.report.currencyUnknown', { symbol: code }),
        ]);
      }
      if (widget.numMode === 'percent')
        return plan({ type: 'percent', options: { precision: precision ?? 0, allowNegative: true } });
      return plan({
        type: 'number',
        options: { precision, thousands: base === 'Numeric', allowNegative: true },
      });
    }
    case 'Bool':
      return plan(
        { type: 'checkbox', options: { color: 'green' } },
        read,
        widget.widget === 'Switch' ? [note('changed', 'import.platform.report.checkboxIcon')] : [],
      );
    case 'Date':
      return plan({
        type: 'date',
        options: {
          includeTime: false,
          dateFormat: dateFormatOf(widget.dateFormat),
          timeFormat: 'local',
          timeZone: 'client',
        },
      });
    case 'DateTime':
      return plan({
        type: 'date',
        options: {
          includeTime: true,
          dateFormat: dateFormatOf(widget.dateFormat),
          timeFormat:
            typeof widget.timeFormat === 'string' ? (/a/i.test(widget.timeFormat) ? '12h' : '24h') : 'local',
          timeZone: isTimeZone(detail) ? detail : 'client',
        },
      });
    case 'Choice':
    case 'ChoiceList': {
      const listed = Array.isArray(widget.choices)
        ? widget.choices.filter((item): item is string => typeof item === 'string')
        : [];
      const colors = isRecord(widget.choiceOptions) ? widget.choiceOptions : {};
      const { choices, byName } = choicesOf(
        listed.map((name) => {
          const style = colors[name];
          return { name, color: isRecord(style) && style.fillColor ? colorOfHex(style.fillColor) : 'gray' };
        }),
      );
      if (base === 'Choice')
        return plan({ type: 'singleSelect', options: { choices } }, (value) =>
          typeof value === 'string' ? (value === '' ? null : (byName.get(value) ?? value)) : (value ?? null),
        );
      return plan({ type: 'multipleSelect', options: { choices } }, (value) => {
        const names = listOf(value).map(String);
        const ids = names.map((name) => byName.get(name));
        return ids.every((id) => id !== undefined) ? ids : names.join(', ');
      });
    }
    default:
      // `Any` holds whatever was put in it, which comes across as its text.
      return plan(
        { type: 'text', options: {} },
        anyText,
        computed ? [] : [note('changed', 'import.platform.report.anyText')],
      );
  }
}

/** A Grist column filter, like `{"included": ["Doing"]}` or `{"min": 3}`, as conditions here. */
export function gristCondition(spec: string, column: Column): SourceCondition | SourceFilter | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const field = column.id;
  const { base } = typeOf(column);
  const included = Array.isArray(parsed.included) ? parsed.included : null;
  const excluded = Array.isArray(parsed.excluded) ? parsed.excluded : null;
  // Excluding nothing is Grist's way of showing everything.
  if (excluded && !excluded.length && !('min' in parsed) && !('max' in parsed))
    return { conjunction: 'and', conditions: [] };
  const values = included ?? excluded ?? [];
  if (values.some((value) => value === null || value === '')) return null;
  const each = (make: (value: unknown) => SourceCondition | null): SourceFilter | SourceCondition | null => {
    const made = values.map(make);
    if (!made.length || made.some((item) => item === null)) return null;
    const conditions = made as SourceCondition[];
    return conditions.length === 1 ? conditions[0]! : { conjunction: included ? 'or' : 'and', conditions };
  };
  const range = (conditions: SourceCondition[]): SourceFilter | SourceCondition | null =>
    conditions.length === 1 ? conditions[0]! : conditions.length ? { conjunction: 'and', conditions } : null;
  switch (base) {
    case 'Choice':
      return values.length && values.every((value) => typeof value === 'string')
        ? {
            field,
            operator: included
              ? values.length === 1
                ? 'is'
                : 'isAnyOf'
              : values.length === 1
                ? 'isNot'
                : 'isNoneOf',
            value: { kind: 'choices', names: values as string[] },
          }
        : null;
    case 'ChoiceList':
      return values.length && values.every((value) => typeof value === 'string')
        ? {
            field,
            operator: included ? 'hasAnyOf' : 'hasNoneOf',
            value: { kind: 'choices', names: values as string[] },
          }
        : null;
    case 'Bool':
      if (values.length !== 1 || typeof values[0] !== 'boolean') return null;
      return { field, operator: 'is', value: { kind: 'boolean', value: included ? values[0] : !values[0] } };
    case 'Text':
      return each((value) =>
        typeof value === 'string'
          ? { field, operator: included ? 'is' : 'isNot', value: { kind: 'text', text: value } }
          : null,
      );
    case 'Ref':
    case 'RefList':
      return values.length && values.every((value) => typeof value === 'number')
        ? {
            field,
            operator: included ? 'hasAnyOf' : 'hasNoneOf',
            value: { kind: 'records', ids: values.map(String) },
          }
        : null;
    case 'Numeric':
    case 'Int': {
      if (included || excluded)
        return each((value) =>
          typeof value === 'number'
            ? { field, operator: included ? 'eq' : 'neq', value: { kind: 'number', number: value } }
            : null,
        );
      const conditions: SourceCondition[] = [];
      if (typeof parsed.min === 'number')
        conditions.push({ field, operator: 'gte', value: { kind: 'number', number: parsed.min } });
      if (typeof parsed.max === 'number')
        conditions.push({ field, operator: 'lte', value: { kind: 'number', number: parsed.max } });
      return range(conditions);
    }
    case 'Date':
    case 'DateTime': {
      if (included || excluded) return null;
      const day = (value: unknown) =>
        typeof value === 'number' ? new Date(value * 1_000).toISOString().slice(0, 10) : null;
      const min = day(parsed.min);
      const max = day(parsed.max);
      // Grist's relative dates, like a week ago, have no match here.
      if (('min' in parsed && !min) || ('max' in parsed && !max)) return null;
      const conditions: SourceCondition[] = [];
      if (min)
        conditions.push({
          field,
          operator: 'isOnOrAfter',
          value: { kind: 'date', target: { mode: 'exactDate', date: min } },
        });
      if (max)
        conditions.push({
          field,
          operator: 'isOnOrBefore',
          value: { kind: 'date', target: { mode: 'exactDate', date: max } },
        });
      return range(conditions);
    }
    default:
      return null;
  }
}

const KINDS: Readonly<Record<string, { name: string; kind: ViewType | null }>> = {
  record: { name: 'table', kind: 'grid' },
  detail: { name: 'card list', kind: 'gallery' },
  single: { name: 'card', kind: 'gallery' },
  form: { name: 'form', kind: 'form' },
  chart: { name: 'chart', kind: null },
  custom: { name: 'custom widget', kind: null },
};

function sortsOf(text: string | null | undefined, byRef: ReadonlyMap<number, Column>) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text || '[]');
  } catch {
    parsed = [];
  }
  return (Array.isArray(parsed) ? parsed : []).flatMap((item: unknown) => {
    // A sort is a column's row ID, negative for descending, sometimes with options after it.
    const ref =
      typeof item === 'number' ? item : typeof item === 'string' ? Number.parseInt(item, 10) : Number.NaN;
    const column = Number.isFinite(ref) ? byRef.get(Math.abs(ref)) : undefined;
    return column && !helper(column.id)
      ? [{ field: column.id, direction: ref < 0 ? ('desc' as const) : ('asc' as const) }]
      : [];
  });
}

class GristSource implements PlatformSource {
  readonly platform = 'grist' as const;
  /** Whether each table keeps a manual order, which its records come in */
  private readonly ordered = new Map<string, boolean>();

  constructor(
    private readonly client: PlatformClient,
    private readonly address: string,
    private readonly docId: string,
  ) {}

  private get base() {
    return `/api/docs/${encodeURIComponent(this.docId)}`;
  }

  private metaTable<T>(name: string, schema: z.ZodType<T>): Promise<T> {
    return this.client.json(`${this.base}/tables/${name}/records`, schema);
  }

  async schema(): Promise<SourceSchema> {
    const { tables } = await this.client.json(`${this.base}/tables`, Tables);
    const sections = await this.metaTable('_grist_Views_section', Sections);
    const sectionFields = await this.metaTable('_grist_Views_section_field', SectionFields);
    const filters = await this.metaTable('_grist_Filters', Filters);
    const views = await this.metaTable('_grist_Views', Views);
    const pages = await this.metaTable('_grist_Pages', Pages);
    const columnMeta = await this.metaTable('_grist_Tables_column', ColumnMeta);
    const attachments = await this.client.json(`${this.base}/attachments`, AttachmentMeta);
    const columnIds = new Map(columnMeta.records.map((row) => [row.id, row.fields.colId]));
    const files = new Map(attachments.records.map((row) => [row.id, row.fields]));
    const headers = this.client.headers();
    const attachment = (id: number): Attachment => {
      const found = files.get(id);
      return {
        url: `${this.address}${this.base}/attachments/${id}/download`,
        filename: found?.fileName ?? null,
        size: found?.fileSize ?? null,
        headers,
      };
    };
    const tableIds = new Set(tables.map((table) => table.id));
    const pageOrder = new Map(
      pages.records.map((page) => [page.fields.viewRef, page.fields.pagePos ?? page.id]),
    );
    const viewNames = new Map(views.records.map((view) => [view.id, view.fields.name ?? '']));
    const result: SourceTable[] = [];
    // Tables in the order the document's pages list them, and the rest after.
    const position = (table: (typeof tables)[number]) =>
      pageOrder.get(table.fields.primaryViewId ?? -1) ?? Number.MAX_SAFE_INTEGER;
    const ordered = [...tables].sort(
      (a, b) => position(a) - position(b) || (a.fields.tableRef ?? 0) - (b.fields.tableRef ?? 0),
    );
    for (const table of ordered) {
      const { columns } = await this.client.json(
        `${this.base}/tables/${encodeURIComponent(table.id)}/columns`,
        Columns,
        { query: { hidden: 'true' } },
      );
      this.ordered.set(
        table.id,
        columns.some((column) => column.id === 'manualSort'),
      );
      const byRef = new Map(columns.map((column) => [column.fields.colRef ?? -1, column]));
      const kinds: ColumnKinds = (id) => {
        const found = columns.find((column) => column.id === id);
        return found ? kindOf(found) : undefined;
      };
      const fields = columns.flatMap((column) => {
        const plan = planGristColumn(column, { kinds, columnIds, attachment, tables: tableIds });
        return plan ? [plan] : [];
      });
      const shownIn = (sectionId: number) =>
        sectionFields.records
          .filter((row) => row.fields.parentId === sectionId)
          .sort((a, b) => (a.fields.parentPos ?? 0) - (b.fields.parentPos ?? 0))
          .flatMap((row) => {
            const column = byRef.get(row.fields.colRef);
            return column && !helper(column.id) ? [column.id] : [];
          });
      const primaryPage = table.fields.primaryViewId;
      const onPages = sections.records
        .filter(
          (section) =>
            section.fields.tableRef === table.fields.tableRef &&
            section.fields.parentId > 0 &&
            pageOrder.has(section.fields.parentId),
        )
        .sort(
          (a, b) =>
            Number(b.fields.parentId === primaryPage) - Number(a.fields.parentId === primaryPage) ||
            (pageOrder.get(a.fields.parentId) ?? 0) - (pageOrder.get(b.fields.parentId) ?? 0) ||
            a.id - b.id,
        );
      const raw = sections.records.find((section) => section.id === table.fields.rawViewSectionRef);
      // A table on no page still has its raw data, which is its grid here.
      const chosen =
        onPages.some((section) => section.fields.parentKey === 'record') || !raw
          ? onPages
          : [raw, ...onPages];
      const made: SourceView[] = chosen.map((section) => {
        const known = KINDS[section.fields.parentKey];
        const notes: Note[] = [];
        if (section.fields.linkSrcSectionRef)
          notes.push(note('omitted', 'import.platform.report.viewLinked'));
        if (section.fields.parentKey === 'single')
          notes.push(note('changed', 'import.platform.report.viewCardList'));
        const conditions: SourceFilter['conditions'] = [];
        let unmatched = 0;
        for (const filter of filters.records.filter((row) => row.fields.viewSectionRef === section.id)) {
          const column = byRef.get(filter.fields.colRef);
          const condition =
            column && filter.fields.filter ? gristCondition(filter.fields.filter, column) : null;
          if (!condition) unmatched++;
          else if (!('conjunction' in condition) || condition.conditions.length) conditions.push(condition);
        }
        const name =
          section === raw
            ? table.id
            : section.fields.title?.trim() || viewNames.get(section.fields.parentId)?.trim() || table.id;
        return {
          id: String(section.id),
          name,
          type: known?.name ?? section.fields.parentKey,
          kind: known?.kind ?? null,
          shown: shownIn(section.id),
          filter: conditions.length ? { conjunction: 'and', conditions } : null,
          unmatched,
          sorts: sortsOf(section.fields.sortColRefs, byRef),
          notes,
        };
      });
      const primary =
        (raw ? shownIn(raw.id) : [])[0] ?? columns.find((column) => !helper(column.id))?.id ?? null;
      result.push({
        id: table.id,
        name: table.id,
        primary,
        fields,
        views: made,
        notes: table.fields.summarySourceTable
          ? [note('changed', 'import.platform.report.summaryTable')]
          : [],
      });
    }
    return { tables: result, notes: [] };
  }

  async *records(table: SourceTable): AsyncGenerator<SourceRecord[]> {
    const name = table.id.replace(/"/g, '""');
    const order = this.ordered.get(table.id) ? '"manualSort", id' : 'id';
    for (let offset = 0; ; offset += PAGE) {
      const ids = await this.client.json(`${this.base}/sql`, Sql, {
        query: { q: `SELECT id FROM "${name}" ORDER BY ${order} LIMIT ${PAGE} OFFSET ${offset}` },
      });
      const wanted = ids.records.map((row) => row.fields.id);
      if (!wanted.length) return;
      const page = await this.client.json(
        `${this.base}/tables/${encodeURIComponent(table.id)}/records`,
        Records,
        {
          query: { filter: JSON.stringify({ id: wanted }) },
        },
      );
      const byId = new Map(page.records.map((record) => [record.id, record]));
      yield wanted.flatMap((id) => {
        const record = byId.get(id);
        if (!record) return [];
        const values = { ...record.fields };
        // A cell whose formula failed in Grist holds nothing to bring across.
        for (const failed of Object.keys(record.errors ?? {})) delete values[failed];
        return [{ id: String(id), values }];
      });
      if (wanted.length < PAGE) return;
    }
  }
}

export const gristReader: ReaderFactory = (context) => {
  const key = context.credential.kind === 'token' ? context.credential.token : '';
  const client = context.client({
    credentials: () => ({ authorization: `Bearer ${key}` }),
    secrets: () => [key],
  });
  return {
    async bases() {
      const orgs = await client.json('/api/orgs', z.array(Org), { purpose: 'list' });
      const bases = [];
      for (const org of orgs) {
        const workspaces = await client.json(`/api/orgs/${org.id}/workspaces`, Workspaces, {
          purpose: 'list',
        });
        for (const workspace of workspaces)
          for (const doc of workspace.docs)
            bases.push({
              id: doc.id,
              name: doc.name,
              group: orgs.length > 1 ? `${org.name} › ${workspace.name}` : workspace.name,
            });
      }
      return bases;
    },
    kept: async () => context.credential,
    source: (docId) => new GristSource(client, context.address, docId),
  };
};
