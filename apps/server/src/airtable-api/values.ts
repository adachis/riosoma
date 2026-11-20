import { isMultiCurrencyValue, multiCurrencyText } from '@riosoma/contracts';
import { ChoiceId } from '@riosoma/contracts';
import {
  cellValue,
  dateRangeText,
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  locationText,
  type AttachmentMeta,
  type CellValue,
  type RowData,
} from '@riosoma/contracts';
import {
  buttonLink,
  formatValue,
  relationContext,
  withButtonSources,
  type FormatContext,
} from '../data/format.js';
import type { StoredField } from '../data/types.js';
import type { TableAccess } from '../api-v1/reads.js';

/**
 * Cell values the way Airtable's Web API sends them.  Linked records are lists of record IDs,
 * attachments are objects with `id`, `url`, `filename`, `size`, `type`, and `thumbnails`, and
 * people are `{ id, email, name }`, one object for a field that holds one person.  Select options
 * are their names and dates are ISO text.  Empty fields are left out, and so are checkboxes that
 * aren't checked, as Airtable does.
 *
 * Riosoma types Airtable doesn't have come through as the nearest shape: JSON as its text, a
 * location as `label (lat, lng)` text, a date range as `start/end` text, a signature as the time
 * it was signed, and a record ID field as the ID's text.  The help page lists them.
 */

export interface AirtableRecord {
  id: string;
  createdTime: string;
  fields: Record<string, unknown>;
}

export interface OutputOptions {
  cellFormat: 'json' | 'string';
  /** Key fields by ID instead of name */
  byId: boolean;
  timeZone: string;
  locale: string;
  /** Where this server answers, which attachment addresses start with */
  origin: string;
}

/** Thumbnail edges, as the server makes them: each fits inside a square this many pixels wide. */
const THUMBNAILS = { small: 256, large: 1_600 } as const;

function fit(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function attachmentValue(file: AttachmentMeta, origin: string) {
  const address = (path: string) => `${origin}${path}`;
  const sized = file.width !== null && file.height !== null;
  const url = file.url ? address(file.url) : '';
  const thumbnails =
    file.thumbnails.small && file.thumbnails.large
      ? {
          small: {
            url: address(file.thumbnails.small),
            ...(sized ? fit(file.width!, file.height!, THUMBNAILS.small) : {}),
          },
          large: {
            url: address(file.thumbnails.large),
            ...(sized ? fit(file.width!, file.height!, THUMBNAILS.large) : {}),
          },
          full: { url, ...(sized ? { width: file.width, height: file.height } : {}) },
        }
      : null;
  return {
    id: file.id,
    ...(sized ? { width: file.width, height: file.height } : {}),
    url,
    filename: file.name,
    size: file.size,
    type: file.type,
    ...(thumbnails ? { thumbnails } : {}),
  };
}

/** One stored value in Airtable's shape, before empty values are left out. */
function shaped(field: StoredField, value: CellValue, ctx: FormatContext & { origin: string }): unknown {
  const list = Array.isArray(value) ? value : value === null ? [] : [value];
  switch (field.type) {
    case 'barcode':
      return typeof value === 'string' ? { text: value } : null;
    case 'multiCurrency':
      return isMultiCurrencyValue(value) ? multiCurrencyText(value) : null;
    case 'singleSelect':
      return (
        ctx.selectChoices?.get(field.id)?.get(String(value)) ??
        field.options.choices.find((choice) => choice.id === value)?.name ??
        (field.options.source && ChoiceId.safeParse(value).success ? value : null)
      );
    case 'multipleSelect':
      return list.flatMap((id) => {
        const choice = field.options.choices.find((c) => c.id === id);
        const name = ctx.selectChoices?.get(field.id)?.get(String(id)) ?? choice?.name;
        return name ? [name] : field.options.source && ChoiceId.safeParse(id).success ? [id] : [];
      });
    case 'createdBy':
    case 'lastModifiedBy': {
      const person = ctx.people.get(String(value));
      return person ? { id: person.id, email: person.email, name: person.name } : null;
    }
    case 'user': {
      const people = list.flatMap((id) => {
        const person = ctx.people.get(String(id));
        return person ? [{ id: person.id, email: person.email, name: person.name }] : [];
      });
      return field.options.allowMultiple ? people : (people[0] ?? null);
    }
    case 'attachment':
      return list.flatMap((id) => {
        const file = ctx.files.get(String(id));
        return file ? [attachmentValue(file, ctx.origin)] : [];
      });
    case 'lineItems':
    case 'link':
      return list;
    case 'location':
      return isLocationValue(value) ? locationText(value) : null;
    case 'dateRange':
      return isDateRangeValue(value) ? dateRangeText(value) : null;
    case 'signature':
      return isSignatureValue(value) ? value.signedAt : null;
    case 'lookup': {
      const target = field.relation?.target;
      if (!target) return list;
      // A lookup is one flat list, whatever each linked record holds.
      return list.flatMap((item) => {
        const one = shaped(
          target,
          ['multipleSelect', 'link', 'user', 'attachment'].includes(target.type) ? [item] : item,
          ctx,
        );
        return Array.isArray(one) ? one : one === null ? [] : [one];
      });
    }
    default:
      return value;
  }
}

function empty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** A record's cell for one field, or undefined when Airtable would leave it out. */
export function airtableCell(
  field: StoredField,
  row: RowData,
  readable: ReadonlyMap<string, StoredField>,
  ctx: FormatContext & { origin: string },
  cellFormat: 'json' | 'string',
): unknown {
  if (row.errors?.[field.id]) return cellFormat === 'string' ? '#ERROR!' : { error: '#ERROR!' };
  if (field.type === 'button') {
    const url = buttonLink(field, row, readable, ctx);
    if (cellFormat === 'string') return url ?? undefined;
    return { label: field.options.label || field.name, ...(url ? { url } : {}) };
  }
  const value = cellValue(row, field);
  const result = cellFormat === 'string' ? formatValue(field, value, ctx) : shaped(field, value, ctx);
  return empty(result) ? undefined : result;
}

/** Records in Airtable's shape, with the fields given, in the order of `rows`. */
export async function airtableRecords(
  access: TableAccess,
  fields: readonly StoredField[],
  rows: readonly RowData[],
  options: OutputOptions,
): Promise<AirtableRecord[]> {
  const { pool, schemas, table, scope } = access;
  const relations = await relationContext({
    db: pool,
    schemas,
    table,
    scope,
    fields: withButtonSources(fields, access.fields),
    rows,
    // A button's link names the records it uses, whatever shape the other cells take.
    names: options.cellFormat === 'string' || fields.some((field) => field.type === 'button'),
  });
  const readable = new Map(access.fields.map((field) => [field.id, field]));
  const ctx = { locale: options.locale, timeZone: options.timeZone, origin: options.origin, ...relations };
  return rows.map((row) => ({
    id: row.id,
    createdTime: row.createdAt,
    fields: Object.fromEntries(
      fields.flatMap((field) => {
        const value = airtableCell(field, row, readable, ctx, options.cellFormat);
        return value === undefined ? [] : [[options.byId ? field.id : field.name, value]];
      }),
    ),
  }));
}

/**
 * Fields whose values arrive as text here, because that is how these routes show them, and which
 * `typecast` reads whatever the request says: JSON, locations, and date ranges.
 */
export function sentAsText(field: StoredField): boolean {
  return field.type === 'json' || field.type === 'location' || field.type === 'dateRange';
}
