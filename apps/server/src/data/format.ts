import { formatTimeOfDay, isMultiCurrencyValue, multiCurrencyText } from '@riosoma/contracts';
import { isSelect, sourceChoices } from './select-options.js';
import {
  cellValue,
  coordinatesText,
  dateRangeText,
  FieldSpec,
  fillTemplate,
  idsOf,
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  isChangeLogEntry,
  templateFieldIds,
  templateText,
  type AttachmentMeta,
  type CellValue,
  type Collaborator,
  type ChangeLogEntry,
  type FieldOptionsOf,
  type ObjectValue,
  type RowData,
} from '@riosoma/contracts';
import { ident, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { attachmentMeta, loadFiles, rowAttachments } from './files/metadata.js';
import { loadCollaborators } from './metadata.js';
import { displayExpr } from './physical/relations.js';
import type { StoredField, StoredTable } from './types.js';
import { formatMessage } from '../reports/messages.js';

/**
 * Values as the app shows them.  The public API's `cellFormat=string` and every downloaded file
 * read through here, so one field family is never worded two ways.
 */

/** What a checked box reads as; the app's `grid.cell.checked` says the same. */
const CHECKED = 'checked';

/** How a signature reads.  The app's `fields.signature.signedBy` and `.signedAt` say the same. */
const signedBy = (name: string, time: string) => `Signed by ${name} at ${time}`;
const signedAt = (time: string) => `Signed at ${time}`;

const historyMessages = {
  person: /*i18n*/ { id: 'fields.changeLog.unknownPerson', message: 'Unknown person' },
  entry: /*i18n*/ { id: 'fields.changeLog.entry', message: '{at} {actor}: {fields}' },
};
const deactivatedPerson = /*i18n*/ { id: 'ui.avatar.deactivated', message: '{name} (deactivated)' };

function personName(person: Collaborator | undefined, locale: string): string | undefined {
  if (!person) return undefined;
  return person.deactivated
    ? formatMessage(deactivatedPerson.message, { name: person.name }, { locale, html: false })
    : person.name;
}

/** The moment of a signature, in the reader's own zone. */
const SIGNED_TIME: FieldOptionsOf<'date'> = {
  includeTime: true,
  dateFormat: 'local',
  timeFormat: 'local',
  timeZone: 'client',
};

export interface FormatContext {
  locale: string;
  timeZone: string;
  people: ReadonlyMap<string, Collaborator>;
  files: ReadonlyMap<string, AttachmentMeta>;
  linked: ReadonlyMap<string, string>;
  selectChoices?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  fields?: ReadonlyMap<string, Pick<StoredField, 'name'>>;
}

function historyText(entry: ChangeLogEntry, ctx: FormatContext): string {
  const fields = new Intl.ListFormat(ctx.locale, { style: 'long', type: 'conjunction' }).format(
    entry.fieldIds.flatMap((id) => ctx.fields?.get(id)?.name ?? []),
  );
  if (!fields) return '';
  const actor =
    (entry.actorId ? personName(ctx.people.get(entry.actorId), ctx.locale) : undefined) ??
    historyMessages.person.message;
  const at = new Intl.DateTimeFormat(ctx.locale, {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: ctx.timeZone,
  }).format(new Date(entry.at));
  return formatMessage(
    historyMessages.entry.message,
    { at, actor, fields },
    { locale: ctx.locale, html: false },
  );
}

function dateText(value: string, options: FieldOptionsOf<'date'>, ctx: FormatContext): string {
  const wall = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = new Date(wall ? `${value}T12:00:00Z` : value);
  if (!Number.isFinite(instant.getTime())) return '';
  const timeZone = wall ? 'UTC' : options.timeZone === 'client' ? ctx.timeZone : options.timeZone;
  const showTime = options.includeTime && !wall;
  const timeOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    timeStyle: 'short',
    ...(options.timeFormat === 'local' ? {} : { hourCycle: options.timeFormat === '12h' ? 'h12' : 'h23' }),
  };
  let text: string;
  if (options.dateFormat === 'local' || options.dateFormat === 'friendly') {
    text = new Intl.DateTimeFormat(ctx.locale, {
      timeZone,
      dateStyle: options.dateFormat === 'friendly' ? 'long' : 'medium',
      ...(showTime ? timeOptions : {}),
    }).format(instant);
  } else {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(instant);
    const part = (name: string) => parts.find((p) => p.type === name)!.value;
    const [y, m, d] = [part('year'), part('month'), part('day')];
    text =
      options.dateFormat === 'iso'
        ? `${y!.padStart(4, '0')}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
        : options.dateFormat === 'us'
          ? `${m}/${d}/${y}`
          : `${d}/${m}/${y}`;
    if (showTime)
      text +=
        (options.dateFormat === 'iso' ? ' ' : ', ') +
        new Intl.DateTimeFormat(ctx.locale, timeOptions).format(instant);
  }
  if (showTime && options.timeZone !== 'client' && timeZone.toLowerCase() !== ctx.timeZone.toLowerCase()) {
    const zone = new Intl.DateTimeFormat(ctx.locale, { timeZone, timeZoneName: 'short' })
      .formatToParts(instant)
      .find((p) => p.type === 'timeZoneName')?.value;
    if (zone) text += ` ${zone}`;
  }
  return text;
}

/** A date range, location, or signature with nothing to say how its field words it. */
function objectText(value: ObjectValue, ctx: FormatContext): string {
  if (isChangeLogEntry(value)) return historyText(value, ctx);
  if (isMultiCurrencyValue(value)) return multiCurrencyText(value);
  if (isDateRangeValue(value)) return dateRangeText(value);
  if (isLocationValue(value)) return coordinatesText(value);
  return value.name ?? '';
}

function plain(value: CellValue, ctx: FormatContext): string {
  if (Array.isArray(value))
    return value
      .map((item) => plain(item, ctx))
      .filter(Boolean)
      .join(', ');
  if (typeof value === 'boolean') return value ? CHECKED : '';
  if (typeof value === 'number') return numbers(ctx.locale, { maximumFractionDigits: 10 }).format(value);
  if (value !== null && typeof value === 'object')
    return 'values' in value ? JSON.stringify(value) : objectText(value, ctx);
  return value ?? '';
}

/**
 * Formatters by shape.  Building one costs more than reading a cell, and a download of a million
 * records asks for the same handful of shapes a million times over.
 */
const NUMBER_FORMATS = new Map<string, Intl.NumberFormat>();
const NUMBER_FORMAT_LIMIT = 64;

function numbers(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify([locale, options]);
  const cached = NUMBER_FORMATS.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(locale, options);
  // A request supplies the language, so the cache stays small enough to be forgotten.
  if (NUMBER_FORMATS.size < NUMBER_FORMAT_LIMIT) NUMBER_FORMATS.set(key, created);
  return created;
}

export function formatValue(field: StoredField, value: CellValue, ctx: FormatContext): string {
  if (value === null) return '';
  const list = Array.isArray(value) ? value : [value];
  switch (field.type) {
    case 'time':
      return typeof value === 'string' ? formatTimeOfDay(value, ctx.locale, field.options.timeFormat) : '';
    case 'multiCurrency':
      return isMultiCurrencyValue(value) ? multiCurrencyText(value) : '';
    case 'changeLog':
      return Array.isArray(value)
        ? value
            .filter(isChangeLogEntry)
            .map((entry) => historyText(entry, ctx))
            .filter(Boolean)
            .join('\n')
        : '';
    case 'barcode':
      return typeof value === 'string' ? value : '';
    case 'lookup': {
      const target = field.relation?.target;
      if (!target) return plain(value, ctx);
      return list
        .map((item) =>
          formatValue(
            target,
            ['multipleSelect', 'link', 'user', 'attachment'].includes(target.type) ? [item] : item,
            ctx,
          ),
        )
        .filter(Boolean)
        .join(', ');
    }
    case 'formula':
    case 'rollup': {
      const type = field.options.resultType;
      if (type === 'array') return plain(value, ctx);
      const spec = FieldSpec.parse({
        type: type === 'boolean' ? 'checkbox' : type === 'datetime' ? 'date' : type,
        options: { ...field.options, includeTime: type === 'datetime', thousands: true },
      });
      return formatValue({ ...field, ...spec }, value, ctx);
    }
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
      return typeof value === 'string' ? dateText(value, field.options, ctx) : '';
    case 'checkbox':
      return value === true ? CHECKED : '';
    case 'singleSelect':
    case 'multipleSelect':
      return list
        .map(
          (id) =>
            ctx.selectChoices?.get(field.id)?.get(String(id)) ??
            field.options.choices.find((choice) => choice.id === id)?.name ??
            '',
        )
        .filter(Boolean)
        .join(', ');
    case 'createdBy':
    case 'lastModifiedBy':
    case 'user':
      return list
        .map((id) => personName(ctx.people.get(String(id)), ctx.locale) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'attachment':
      return list
        .flatMap((id) => {
          const file = ctx.files.get(String(id));
          return file?.scanState && file.scanState !== 'clean' ? [] : [file?.name ?? String(id)];
        })
        .join(', ');
    case 'lineItems':
    case 'link':
      return list.map((id) => ctx.linked.get(String(id)) ?? String(id)).join(', ');
    case 'number':
    case 'currency':
    case 'percent':
    case 'count': {
      if (typeof value !== 'number') return '';
      const precision = field.type === 'count' ? 0 : field.options.precision;
      return numbers(ctx.locale, {
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? 10,
        useGrouping: field.type === 'number' ? field.options.thousands : true,
        ...(field.type === 'currency' ? { style: 'currency', currency: field.options.code } : {}),
        ...(field.type === 'percent' ? { style: 'percent' } : {}),
      }).format(value);
    }
    case 'duration': {
      if (typeof value !== 'number') return '';
      const format = field.options.format;
      const digits = Math.max(0, format.length - 8);
      const scale = 10 ** digits;
      const ticks = format === 'h:mm' ? Math.round(value / 60) * 60 : Math.round(value * scale);
      const seconds = Math.floor(ticks / scale);
      const text = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`;
      return format === 'h:mm'
        ? text
        : `${text}:${String(seconds % 60).padStart(2, '0')}${digits ? `.${String(ticks % scale).padStart(digits, '0')}` : ''}`;
    }
    case 'dateRange': {
      if (!isDateRangeValue(value)) return '';
      const start = dateText(value.start, field.options, ctx);
      const end = dateText(value.end, field.options, ctx);
      return start === end ? start : `${start} – ${end}`;
    }
    case 'location':
      return isLocationValue(value) ? coordinatesText(value) : '';
    case 'signature': {
      if (!isSignatureValue(value)) return '';
      const time = dateText(value.signedAt, SIGNED_TIME, ctx);
      const name = value.name ?? (value.signedBy ? ctx.people.get(value.signedBy)?.name : undefined);
      return name ? signedBy(name, time) : signedAt(time);
    }
    case 'button':
      return '';
    default:
      return typeof value === 'object' ? objectText(value as ObjectValue, ctx) : String(value);
  }
}

/**
 * The link a button opens for a record, or null when it can't open one.  Only fields the reader
 * can see fill it in: a field missing from `fields` leaves the button without a link rather than
 * passing on a value the reader isn't allowed to read.
 */
export function buttonLink(
  field: StoredField,
  row: RowData,
  fields: ReadonlyMap<string, StoredField>,
  ctx: FormatContext,
): string | null {
  if (field.type !== 'button' || field.options.action.kind !== 'openUrl') return null;
  const filled = fillTemplate(field.options.action.urlTemplate, (id) => {
    const source = fields.get(id);
    if (!source) return undefined;
    return templateText(source, cellValue(row, source), {
      person: (person) => ctx.people.get(person)?.name,
      record: (record) => ctx.linked.get(record),
      file: (file) => ctx.files.get(file)?.name,
    });
  });
  return filled.ok ? filled.url : null;
}

/** A cell as a download words it: a button as its link, everything else as `formatValue` does. */
export function formatCellText(
  field: StoredField,
  row: RowData,
  fields: ReadonlyMap<string, StoredField>,
  ctx: FormatContext,
): string {
  return field.type === 'button'
    ? (buttonLink(field, row, fields, ctx) ?? '')
    : formatValue(field, cellValue(row, field), { ...ctx, fields: ctx.fields ?? fields });
}

/**
 * The fields to read so every button among `fields` can fill in its link: `fields`, plus the
 * ones its templates use that are among `visible`.
 */
export function withButtonSources(
  fields: readonly StoredField[],
  visible: readonly StoredField[],
): StoredField[] {
  const ids = new Set(fields.map((field) => field.id));
  const extra = new Set<string>();
  for (const field of fields)
    if (field.type === 'button' && field.options.action.kind === 'openUrl')
      for (const id of templateFieldIds(field.options.action.urlTemplate)) if (!ids.has(id)) extra.add(id);
  return [...fields, ...visible.filter((field) => extra.has(field.id))];
}

export interface RelationLookup {
  db: Queryable;
  schemas: DataSchemas;
  table: StoredTable;
  scope: AccessScope;
  fields: readonly StoredField[];
  rows: readonly RowData[];
  /** Linked records are only named when cells are shown as text; JSON cells keep their IDs. */
  names: boolean;
}

/**
 * The people, files, and linked-record names a page of records needs before its values can be
 * worded.  The same masks that hide a field or a record hide what it points at: a name is read
 * only for a field the caller can see, and only for records the caller's predicate allows.
 */
export async function relationContext(
  lookup: RelationLookup,
): Promise<Pick<FormatContext, 'people' | 'files' | 'linked' | 'fields' | 'selectChoices'>> {
  const { db, schemas, table, scope, fields, rows, names } = lookup;
  const people = await loadCollaborators(db, schemas, table.orgId, scope);
  const attached = await rowAttachments(db, schemas.app, table.id, fields, rows);
  const linked = new Map<string, string>();
  const labels = new Map(fields.map((field) => [field.id, field]));
  const visited = new Set<string>();
  const historyLabels = (field: StoredField) => {
    if (visited.has(field.id)) return;
    visited.add(field.id);
    // Scoped history can name readable fields that were not requested as output columns.
    for (const source of field.historyFields ?? []) labels.set(source.id, source);
    if (field.relation?.target) historyLabels(field.relation.target);
    for (const source of field.formula?.fields ?? []) historyLabels(source);
  };
  for (const field of fields) historyLabels(field);
  const selectChoices = new Map<string, Map<string, string>>();
  for (const returned of fields) {
    let field = returned;
    const seen = new Set<string>();
    while (field.type === 'lookup' && field.relation?.target && !seen.has(field.id)) {
      seen.add(field.id);
      field = field.relation.target;
    }
    const ids = [
      ...new Set(
        rows.flatMap((row) => {
          const value = row.values[returned.id] ?? null;
          return typeof value === 'string' ? [value] : idsOf(value);
        }),
      ),
    ];
    if (!ids.length || !scope.visibleFields(field.tableId, [field]).length) continue;
    if (isSelect(field) && field.options.source) {
      const choices = await sourceChoices(db, schemas, scope, field, { ids });
      selectChoices.set(field.id, new Map(choices.map((choice) => [choice.id, choice.name])));
    }
    if (returned.type === 'lookup' && field.type === 'attachment') {
      for (const file of await loadFiles(db, schemas.app, ids)) {
        if (file.org_id === table.orgId && file.table_id === field.tableId && file.field_id === field.id)
          attached[file.id] = attachmentMeta(file);
      }
    }
    if (!names || (field.type !== 'link' && field.type !== 'lineItems') || !field.relation?.primary) continue;
    const relation = field.relation;
    const primary = relation.primary!;
    if (!scope.visibleFields(relation.linkedTableId, [primary]).length) continue;
    const found = await query<{ id: string; name: string }>(
      db,
      sql`SELECT __id AS id, ${displayExpr(primary)} AS name
        FROM ${ident(schemas.data, relation.linkedTableId)} WHERE __id = ANY(${ids}::text[])
        AND __deleted_at IS NULL AND (${scope.recordPredicate(relation.linkedTableId)})`,
    );
    for (const row of found.rows) linked.set(row.id, row.name);
  }
  return {
    fields: labels,
    people: new Map(people.map((person) => [person.id, person])),
    files: new Map(Object.entries(attached)),
    linked,
    selectChoices,
  };
}
