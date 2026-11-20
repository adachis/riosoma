import { createHash } from 'node:crypto';
import {
  SYNC_OUT_KEY_COLUMN,
  cellValue,
  type ChoiceColor,
  type RowData,
  type SyncOutValueKind,
  type SyncOutWrite,
} from '@riosoma/contracts';
import type { ColumnPlan, OutboundCell } from './destination.js';
import { formatCellText, type FormatContext } from '../data/format.js';
import { resolvedField } from '../data/export/xlsx.js';
import type { StoredField } from '../data/types.js';

/**
 * Turning a Riosoma field into a neutral column plan, and a cell into a neutral value.  An adapter
 * maps these to its own column types and values, so no field type reaches an adapter.  The hash of
 * a row is of exactly the values that were sent, keyed in one fixed order, so the same values
 * always hash the same and a rerun sends only what changed.
 */

/** What the app shows for a cell that failed to compute. */
const ERROR_TEXT = '#ERROR!';

/** The value kind each field maps to, after a formula or rollup is read as its returned type. */
export function valueKind(field: StoredField): SyncOutValueKind {
  const resolved = resolvedField(field);
  switch (resolved.type) {
    case 'longText':
    case 'json':
    case 'lineItems':
    case 'changeLog':
    case 'attachment':
      return 'longText';
    case 'number':
    case 'count':
    case 'autoNumber':
      return 'number';
    case 'currency':
      return 'currency';
    case 'percent':
      return 'percent';
    case 'duration':
      return 'duration';
    case 'rating':
      return 'rating';
    case 'checkbox':
      return 'checkbox';
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
      return (resolved.options as { includeTime?: boolean }).includeTime ? 'dateTime' : 'date';
    case 'singleSelect':
      return 'singleSelect';
    case 'multipleSelect':
      return 'multipleSelect';
    case 'email':
      return 'email';
    case 'url':
    case 'button':
      return 'url';
    case 'phone':
      return 'phone';
    default:
      // text, recordId, barcode, time, dateRange, location, multiCurrency, signature, link, lookup,
      // user, createdBy, lastModifiedBy, and any array-typed formula or rollup go as text.
      return 'text';
  }
}

function currencySymbol(code: string, locale: string): string {
  try {
    const parts = new Intl.NumberFormat(locale, { style: 'currency', currency: code }).formatToParts(0);
    return parts.find((part) => part.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
}

export interface PlanOptions {
  timeZone: string;
  locale: string;
}

/** The plan one field maps to.  `primary` is decided by `buildColumnPlans`. */
export function planForField(field: StoredField, options: PlanOptions): ColumnPlan {
  const resolved = resolvedField(field);
  const kind = valueKind(field);
  const opts = resolved.options as {
    precision?: number | null;
    code?: string;
    format?: string;
    max?: number;
    richText?: boolean;
    choices?: ReadonlyArray<{ name: string; color: ChoiceColor }>;
  };
  const plan: ColumnPlan = { fieldId: field.id, name: field.name, kind, primary: false };
  if (kind === 'number' || kind === 'percent' || kind === 'duration') {
    if (typeof opts.precision === 'number') plan.precision = opts.precision;
  }
  if (kind === 'currency') {
    // Airtable currency takes 0 to 7 decimal places.
    if (typeof opts.precision === 'number') plan.precision = Math.min(opts.precision, 7);
    const code = opts.code ?? 'USD';
    plan.currency = { code, symbol: currencySymbol(code, options.locale) };
  }
  if (kind === 'duration') plan.durationFormat = opts.format;
  if (kind === 'rating') plan.ratingMax = opts.max;
  if (kind === 'longText') plan.richText = Boolean(opts.richText);
  if (kind === 'dateTime') plan.timeZone = options.timeZone;
  if (kind === 'singleSelect' || kind === 'multipleSelect') {
    plan.choices = (opts.choices ?? []).map((choice) => ({ name: choice.name, color: choice.color }));
  }
  return plan;
}

/** The plan for the column Riosoma owns, which holds each row's record ID. */
export function keyColumnPlan(primary: boolean): ColumnPlan {
  return { fieldId: null, name: SYNC_OUT_KEY_COLUMN, kind: 'text', primary };
}

/**
 * Every field's plan in view order, with the key column's plan, and exactly one primary.  The
 * primary field's plan is primary when it is sent, and the key column's plan is primary otherwise,
 * so a service that needs a primary column always has one and never gets a type it refuses.
 */
export function buildColumnPlans(
  fields: readonly StoredField[],
  primaryFieldId: string,
  options: PlanOptions,
): { plans: ColumnPlan[]; keyPlan: ColumnPlan } {
  const plans = fields.map((field) => planForField(field, options));
  const primaryIndex = plans.findIndex((plan) => plan.fieldId === primaryFieldId);
  if (primaryIndex >= 0) {
    plans[primaryIndex]!.primary = true;
    const [primary] = plans.splice(primaryIndex, 1);
    plans.unshift(primary!);
    return { plans, keyPlan: keyColumnPlan(false) };
  }
  return { plans, keyPlan: keyColumnPlan(true) };
}

export const EMPTY_CELL: OutboundCell = { text: '' };

function dateParts(value: unknown, timeZone: string): { date?: string; instant?: string } {
  if (typeof value !== 'string' || !value) return {};
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return {};
  const instant = at.toISOString();
  // The date in the sync's time zone, as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return { date: parts, instant };
}

/** One field's cell, as the neutral value an adapter writes. */
export function cellForField(
  field: StoredField,
  row: RowData,
  fields: ReadonlyMap<string, StoredField>,
  ctx: FormatContext,
): OutboundCell {
  if (row.errors?.[field.id]) return { text: ERROR_TEXT };
  const text = formatCellText(field, row, fields, ctx);
  const kind = valueKind(field);
  const value = cellValue(row, field);
  switch (kind) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'rating': {
      const number = typeof value === 'number' ? value : undefined;
      return number === undefined ? { text } : { text, number };
    }
    case 'checkbox':
      return { text, boolean: value === true };
    case 'date': {
      // A date without a time is a calendar day, which no time zone moves.
      const day = typeof value === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] : undefined;
      const date = day ?? dateParts(value, ctx.timeZone).date;
      return date ? { text, date } : { text };
    }
    case 'dateTime': {
      const { date, instant } = dateParts(value, ctx.timeZone);
      return { text, ...(date ? { date } : {}), ...(instant ? { instant } : {}) };
    }
    case 'singleSelect':
    case 'multipleSelect': {
      const ids = Array.isArray(value) ? value : value == null ? [] : [value];
      const names = (ctx.selectChoices?.get(field.id) ?? new Map()) as ReadonlyMap<string, string>;
      const resolved = ids
        .map((id) => (typeof id === 'string' ? (names.get(id) ?? '') : ''))
        .filter((name) => name !== '');
      const choices = resolved.length ? resolved : text ? [text] : [];
      return choices.length ? { text, choices } : { text };
    }
    default:
      return { text };
  }
}

/** A cell with its keys in one fixed order, so the same values always serialize the same. */
function orderedCell(cell: OutboundCell): Record<string, unknown> {
  const ordered: Record<string, unknown> = { text: cell.text };
  if (cell.number !== undefined) ordered.number = cell.number;
  if (cell.boolean !== undefined) ordered.boolean = cell.boolean;
  if (cell.date !== undefined) ordered.date = cell.date;
  if (cell.instant !== undefined) ordered.instant = cell.instant;
  if (cell.choices !== undefined) ordered.choices = cell.choices;
  return ordered;
}

/** The hash of a row's cells under a mapping signature, short enough to store cheaply. */
export function hashRow(signature: string, cells: readonly OutboundCell[]): string {
  const json = JSON.stringify(cells.map(orderedCell));
  return createHash('sha256').update(`${signature}\n${json}`).digest().subarray(0, 16).toString('base64url');
}

/** The signature of a mapping, which goes into every row's hash so a change sends every row once. */
export function columnSignature(
  entries: ReadonlyArray<{
    fieldId: string | null;
    columnId: string;
    columnType: string;
    write: SyncOutWrite;
    sent: boolean;
  }>,
  keyColumnId: string,
): string {
  const shape = entries.map((entry) => [
    entry.fieldId,
    entry.columnId,
    entry.columnType,
    entry.write,
    entry.sent,
  ]);
  return createHash('sha256')
    .update(JSON.stringify([keyColumnId, shape]))
    .digest('hex');
}
