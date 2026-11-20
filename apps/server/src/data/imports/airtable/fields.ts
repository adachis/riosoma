import {
  DateFormat,
  isPrimaryType,
  isTimeZone,
  LIMITS,
  newId,
  type Choice,
  type ChoiceColor,
  type FieldOptionsOf,
  type FieldSpec,
} from '@riosoma/contracts';
import type { AirtableField } from './api.js';
import type { Note } from '../core/report.js';
import { currencyCode, textOf } from '../core/values.js';

export type { Note } from '../core/report.js';
export { currencyCode, textOf } from '../core/values.js';

/**
 * How each Airtable field type comes across.  Most become the matching Riosoma field and keep
 * their options.  Fields Airtable computes (formulas, lookups, rollups, and counts) start as plain
 * fields holding the values Airtable computed, and turn into the real thing once records and links
 * are in, so nothing is lost when one can't.  People fields start as their email addresses and
 * become person fields when everyone in them is a member here.
 */

/** What a field turns into once records and links are in. */
export type Finish =
  | { kind: 'formula'; formula: string; valid: boolean; options: FormulaOptions }
  | { kind: 'lookup'; link: string | null; target: string | null }
  | { kind: 'rollup'; link: string | null; target: string | null; result: string | null }
  | { kind: 'count'; link: string | null }
  | { kind: 'autoNumber' }
  | { kind: 'people'; allowMultiple: boolean };

type DateFormatName = FieldOptionsOf<'date'>['dateFormat'];

export interface FormulaOptions {
  precision: number | null;
  dateFormat: DateFormatName;
  timeFormat: 'local' | '12h' | '24h';
  timeZone: string;
}

interface PlanBase {
  source: AirtableField;
  /** The field's ID here.  An inverse link gets its ID when its pair is made. */
  id: string;
  name: string;
  notes: Note[];
}

export type FieldPlan =
  | (PlanBase & {
      kind: 'value';
      spec: FieldSpec;
      /** Reads one Airtable cell.  What doesn't fit is caught when the value is checked. */
      read(value: unknown): unknown;
      finish?: Finish;
      /** Email addresses a people field has seen, in lowercase */
      people?: Set<string>;
    })
  | (PlanBase & { kind: 'files' })
  | (PlanBase & {
      kind: 'link';
      /** The linked table, by its Airtable ID */
      linkedTable: string;
      /** The field on the linked table that shows the other side, by its Airtable ID */
      inverse: string | null;
      prefersSingle: boolean;
    })
  | (PlanBase & { kind: 'omitted' });

export type ValuePlan = Extract<FieldPlan, { kind: 'value' }>;
export type LinkPlan = Extract<FieldPlan, { kind: 'link' }>;

type Options = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionText(options: Options | undefined, key: string): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}
function optionNumber(options: Options | undefined, key: string): number | undefined {
  const value = options?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function optionObject(options: Options | undefined, key: string): Options | undefined {
  const value = options?.[key];
  return isRecord(value) ? value : undefined;
}

/** Airtable's colors have a hue and a shade.  Riosoma's themes supply the shades. */
export function colorOf(name: unknown): ChoiceColor {
  const hue =
    typeof name === 'string' ? /^(blue|cyan|teal|green|yellow|orange|red|pink|purple|gray)/.exec(name) : null;
  if (!hue) return 'gray';
  return hue[1] === 'cyan' ? 'teal' : (hue[1] as ChoiceColor);
}

function dateFormat(options: Options | undefined): DateFormatName {
  const parsed = DateFormat.safeParse(optionText(optionObject(options, 'dateFormat'), 'name'));
  return parsed.success ? parsed.data : 'local';
}

function timeFormat(options: Options | undefined): 'local' | '12h' | '24h' {
  const name = optionText(optionObject(options, 'timeFormat'), 'name');
  return name === '12hour' ? '12h' : name === '24hour' ? '24h' : 'local';
}

function timeZone(options: Options | undefined): string {
  const zone = optionText(options, 'timeZone');
  if (!zone || zone === 'client') return 'client';
  if (zone === 'utc') return 'UTC';
  return isTimeZone(zone) ? zone : 'client';
}

function dateSpec(options: Options | undefined, includeTime: boolean): FieldSpec {
  return {
    type: 'date',
    options: {
      includeTime,
      dateFormat: dateFormat(options),
      timeFormat: timeFormat(options),
      timeZone: includeTime ? timeZone(options) : 'client',
    },
  };
}

function precisionOf(options: Options | undefined, max = 8): number | null {
  const value = optionNumber(options, 'precision');
  return value === undefined ? null : Math.min(max, Math.max(0, Math.round(value)));
}

/** A computed value as text, formatted the way its result is. */
function formattedText(value: unknown, result: Options | undefined): string | null {
  const type = optionText(result, 'type');
  const options = optionObject(result, 'options');
  const precision = precisionOf(options);
  if (typeof value === 'number' && Number.isFinite(value) && precision !== null) {
    if (type === 'percent') return `${(value * 100).toFixed(precision)}%`;
    if (type === 'currency') return `${optionText(options, 'symbol') ?? ''}${value.toFixed(precision)}`;
    if (type === 'number') return value.toFixed(precision);
  }
  return textOf(value);
}

const asText = (value: unknown) => textOf(value);
const asTrimmed = (value: unknown) => (typeof value === 'string' ? value.trim() : textOf(value));
const asNumber = (value: unknown) => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
    return Number(value);
  return value ?? null;
};
const asCheck = (value: unknown) => value === true || value === 1;

function asDay(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

function asInstant(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : new Date(time).toISOString();
}

/** Choices with IDs here, read by name the way Airtable's cells hold them. */
function choicesOf(options: Options | undefined): { choices: Choice[]; byName: Map<string, string> } {
  const raw = Array.isArray(options?.choices) ? options.choices : [];
  const choices: Choice[] = [];
  const byName = new Map<string, string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string') continue;
    const name = item.name.trim().slice(0, LIMITS.nameLength);
    if (!name || byName.has(item.name)) continue;
    const id = newId('choice');
    choices.push({ id, name, color: colorOf(item.color) });
    byName.set(item.name, id);
  }
  return { choices, byName };
}

/** A choice's name, the way Airtable's cells hold one, or null when the value isn't one. */
export function choiceName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.name === 'string') return value.name;
  return null;
}

function emailsOf(value: unknown): string[] {
  const people = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return people.flatMap((person) => {
    if (!isRecord(person)) return typeof person === 'string' && person.trim() ? [person.trim()] : [];
    const email = typeof person.email === 'string' ? person.email.trim() : '';
    const name = typeof person.name === 'string' ? person.name.trim() : '';
    return email || name ? [email || name] : [];
  });
}

/** Riosoma's formula display options, from what an Airtable computed field produces. */
function formulaOptions(result: Options | undefined): FormulaOptions {
  const options = optionObject(result, 'options');
  return {
    precision: precisionOf(options),
    dateFormat: dateFormat(options),
    timeFormat: timeFormat(options),
    timeZone: timeZone(options),
  };
}

export interface PlanContext {
  /** Every table in the base, by Airtable ID */
  tables: ReadonlySet<string>;
  /** Whether this is its table's primary field */
  primary: boolean;
}

function note(status: Note['status'], key: string, params?: Note['params']): Note {
  return { status, key, ...(params ? { params } : {}) };
}

function value(
  field: AirtableField,
  spec: FieldSpec,
  read: (value: unknown) => unknown,
  notes: Note[] = [],
  finish?: Finish,
): FieldPlan {
  return {
    kind: 'value',
    source: field,
    id: newId('field'),
    name: field.name,
    spec,
    read,
    notes,
    ...(finish ? { finish } : {}),
  };
}

function computed(field: AirtableField, result: Options | undefined, finish: Finish): FieldPlan {
  return value(field, { type: 'text', options: {} }, (cell) => formattedText(cell, result), [], finish);
}

/** The plan for one Airtable field, before names are made unique. */
export function planField(field: AirtableField, context: PlanContext): FieldPlan {
  const options = field.options ?? undefined;
  const plan = planByType(field, options, context);
  if (plan.kind !== 'value' || !context.primary || isPrimaryType(plan.spec.type)) return plan;
  // The primary field has to be one of the types that can name a record, so it keeps its text.
  return value(field, { type: 'text', options: {} }, textOf, [
    note('changed', 'import.airtable.report.primaryText'),
  ]);
}

function planByType(field: AirtableField, options: Options | undefined, context: PlanContext): FieldPlan {
  switch (field.type) {
    case 'singleLineText':
      return value(field, { type: 'text', options: {} }, asText);
    case 'email':
      return value(field, { type: 'email', options: {} }, asTrimmed);
    case 'url':
      return value(field, { type: 'url', options: {} }, asTrimmed);
    case 'phoneNumber':
      return value(field, { type: 'phone', options: {} }, asTrimmed);
    case 'multilineText':
      return context.primary
        ? value(field, { type: 'text', options: {} }, asText, [
            note('changed', 'import.airtable.report.primaryLines'),
          ])
        : value(field, { type: 'longText', options: { richText: false } }, asText);
    // Airtable sends rich text as Markdown, which is how Riosoma's rich text is stored.  A primary
    // field is one line of plain text, so there the formatting goes.
    case 'richText':
      return context.primary
        ? value(field, { type: 'text', options: {} }, asText, [
            note('changed', 'import.airtable.report.richText'),
          ])
        : value(field, { type: 'longText', options: { richText: true } }, asText);
    case 'number':
      return value(
        field,
        {
          type: 'number',
          options: { precision: precisionOf(options), thousands: true, allowNegative: true },
        },
        asNumber,
      );
    case 'percent':
      return value(
        field,
        { type: 'percent', options: { precision: precisionOf(options) ?? 0, allowNegative: true } },
        asNumber,
      );
    case 'currency': {
      const code = currencyCode(optionText(options, 'symbol'));
      const precision = precisionOf(options) ?? 2;
      return code
        ? value(field, { type: 'currency', options: { code, precision, allowNegative: true } }, asNumber)
        : value(
            field,
            { type: 'number', options: { precision, thousands: true, allowNegative: true } },
            asNumber,
            [
              note('changed', 'import.airtable.report.currencyUnknown', {
                symbol: optionText(options, 'symbol') ?? '',
              }),
            ],
          );
    }
    case 'duration': {
      const format = optionText(options, 'durationFormat');
      const formats = {
        'h:mm:ss': 'h:mm:ss',
        'h:mm:ss.S': 'h:mm:ss.s',
        'h:mm:ss.SS': 'h:mm:ss.ss',
        'h:mm:ss.SSS': 'h:mm:ss.sss',
      } as const;
      return value(
        field,
        { type: 'duration', options: { format: formats[format as keyof typeof formats] ?? 'h:mm' } },
        asNumber,
      );
    }
    case 'rating': {
      const icons = {
        star: 'star',
        heart: 'heart',
        thumbsUp: 'thumbsUp',
        flag: 'flag',
        dot: 'circle',
      } as const;
      const max = Math.min(10, Math.max(1, Math.round(optionNumber(options, 'max') ?? 5)));
      return value(
        field,
        {
          type: 'rating',
          options: {
            max,
            icon: icons[optionText(options, 'icon') as keyof typeof icons] ?? 'star',
            color: colorOf(optionText(options, 'color') ?? 'yellow'),
          },
        },
        asNumber,
      );
    }
    case 'checkbox': {
      const icon = optionText(options, 'icon');
      return value(
        field,
        { type: 'checkbox', options: { color: colorOf(optionText(options, 'color') ?? 'green') } },
        asCheck,
        icon && icon !== 'check' ? [note('changed', 'import.airtable.report.checkboxIcon')] : [],
      );
    }
    case 'date':
      return value(field, dateSpec(options, false), asDay);
    case 'dateTime':
      return value(field, dateSpec(options, true), asInstant);
    case 'createdTime':
    case 'lastModifiedTime': {
      const result = optionObject(options, 'result');
      return value(field, dateSpec(optionObject(result, 'options'), true), asInstant, [
        note('changed', 'import.airtable.report.timeFixed'),
      ]);
    }
    case 'singleSelect':
    case 'externalSyncSource': {
      const { choices, byName } = choicesOf(options);
      if (choices.length > LIMITS.choicesPerField)
        return value(field, { type: 'text', options: {} }, (cell) => choiceName(cell), [
          note('changed', 'import.airtable.report.tooManyChoices', { max: LIMITS.choicesPerField }),
        ]);
      const notes =
        field.type === 'externalSyncSource' ? [note('changed', 'import.airtable.report.syncSource')] : [];
      return value(
        field,
        { type: 'singleSelect', options: { choices } },
        (cell) => {
          const name = choiceName(cell);
          return name === null ? null : (byName.get(name) ?? name);
        },
        notes,
      );
    }
    case 'multipleSelects': {
      const { choices, byName } = choicesOf(options);
      if (choices.length > LIMITS.choicesPerField)
        return value(field, { type: 'text', options: {} }, asText, [
          note('changed', 'import.airtable.report.tooManyChoices', { max: LIMITS.choicesPerField }),
        ]);
      return value(field, { type: 'multipleSelect', options: { choices } }, (cell) => {
        if (!Array.isArray(cell)) return cell ?? null;
        const names = cell.map(choiceName);
        const ids = names.map((name) => (name === null ? undefined : byName.get(name)));
        return ids.every((id) => id !== undefined) ? ids : textOf(cell);
      });
    }
    case 'singleCollaborator':
    case 'multipleCollaborators':
    case 'createdBy':
    case 'lastModifiedBy': {
      const people = new Set<string>();
      const plan = value(
        field,
        { type: 'text', options: {} },
        (cell) => {
          const emails = emailsOf(cell);
          for (const email of emails) people.add(email.toLowerCase());
          return emails.length ? emails.join(', ') : null;
        },
        field.type === 'createdBy' || field.type === 'lastModifiedBy'
          ? [note('changed', 'import.airtable.report.peopleFixed')]
          : [],
        { kind: 'people', allowMultiple: field.type === 'multipleCollaborators' },
      );
      return plan.kind === 'value' ? { ...plan, people } : plan;
    }
    case 'multipleRecordLinks': {
      const linkedTable = optionText(options, 'linkedTableId');
      if (!linkedTable || !context.tables.has(linkedTable))
        return omitted(field, 'import.airtable.report.linkMissing');
      return {
        kind: 'link',
        source: field,
        id: newId('field'),
        name: field.name,
        notes: [],
        linkedTable,
        inverse: optionText(options, 'inverseLinkFieldId') ?? null,
        prefersSingle: options?.prefersSingleRecordLink === true,
      };
    }
    case 'multipleAttachments':
      return { kind: 'files', source: field, id: newId('field'), name: field.name, notes: [] };
    case 'formula': {
      const result = optionObject(options, 'result');
      return computed(field, result, {
        kind: 'formula',
        formula: optionText(options, 'formula') ?? '',
        valid: options?.isValid !== false,
        options: formulaOptions(result),
      });
    }
    case 'multipleLookupValues':
      return computed(field, optionObject(options, 'result'), {
        kind: 'lookup',
        link: optionText(options, 'recordLinkFieldId') ?? null,
        target: optionText(options, 'fieldIdInLinkedTable') ?? null,
      });
    case 'rollup': {
      const result = optionObject(options, 'result');
      return computed(field, result, {
        kind: 'rollup',
        link: optionText(options, 'recordLinkFieldId') ?? null,
        target: optionText(options, 'fieldIdInLinkedTable') ?? null,
        result: optionText(result, 'type') ?? null,
      });
    }
    case 'count':
      return value(
        field,
        { type: 'number', options: { precision: 0, thousands: true, allowNegative: true } },
        asNumber,
        [],
        { kind: 'count', link: optionText(options, 'recordLinkFieldId') ?? null },
      );
    case 'autoNumber':
      return value(
        field,
        { type: 'number', options: { precision: 0, thousands: false, allowNegative: true } },
        asNumber,
        [],
        { kind: 'autoNumber' },
      );
    case 'barcode':
      return value(
        field,
        { type: 'text', options: {} },
        (cell) => (isRecord(cell) && typeof cell.text === 'string' ? cell.text : textOf(cell)),
        [note('changed', 'import.airtable.report.barcode')],
      );
    case 'button':
      return value(
        field,
        { type: 'url', options: {} },
        (cell) => (isRecord(cell) && typeof cell.url === 'string' ? cell.url.trim() : null),
        [note('changed', 'import.airtable.report.button')],
      );
    case 'aiText':
      return value(
        field,
        context.primary ? { type: 'text', options: {} } : { type: 'longText', options: { richText: false } },
        (cell) => (isRecord(cell) && typeof cell.value === 'string' ? cell.value : textOf(cell)),
        [note('changed', 'import.airtable.report.generatedText')],
      );
    default:
      return omitted(field, 'import.airtable.report.typeUnsupported', { type: field.type.slice(0, 64) });
  }
}

function omitted(field: AirtableField, key: string, params?: Note['params']): FieldPlan {
  return {
    kind: 'omitted',
    source: field,
    id: newId('field'),
    name: field.name,
    notes: [note('omitted', key, params)],
  };
}
