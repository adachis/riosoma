import { isChangeLogEntry } from '@riosoma/contracts';
import { formatTimeOfDay, isMultiCurrencyValue, multiCurrencyText } from '@riosoma/contracts';
import { i18n, type MessageDescriptor } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { personLabel, type DisplayPerson } from '../data/people';
import { resultField } from '../data/formulas';
import { markdownLine } from '../fields/richText/markdown';
import {
  coordinatesText,
  dateRangeText,
  idsOf,
  isDateRangeValue,
  isLocationValue,
  isSignatureValue,
  type AttachmentMeta,
  type CellValue,
  type FieldMeta,
  type FieldOptionsOf,
  type SignatureValue,
} from '@riosoma/contracts';

/**
 * The text a cell shows and copies, and the text an inline editor starts with.  Both are pure
 * functions of the field, the stored value, and who is looking: no React, no DOM, no clock.
 *
 * The grid calls these for every visible cell on every scroll frame, and building an `Intl` object
 * costs far more than using one, so each distinct set of options is built once and cached.
 */

export interface FormatContext {
  /** BCP 47 tag, e.g. `en-US`, `de`, `ja` */
  locale: string;
  /** The viewer's IANA time zone */
  timeZone: string;
  collaborators: ReadonlyMap<string, DisplayPerson & { email?: string }>;
  /** Linked records' display text by record ID, from the pages loaded so far */
  linked?: ReadonlyMap<string, string>;
  /** Attachment details by ID, from the pages loaded so far */
  attachments?: ReadonlyMap<string, AttachmentMeta>;
  fieldsById?: ReadonlyMap<string, FieldMeta>;
}

/** Options shared by every field that shows a moment. */
type DateOptions = FieldOptionsOf<'date'>;
type DateFormat = DateOptions['dateFormat'];
type TimeFormat = DateOptions['timeFormat'];

/** What a checked checkbox copies; the grid itself draws a checkmark. */
const CHECKED = msg({ id: 'grid.cell.checked', message: 'checked' });

/** How a multiple select's names are joined on the clipboard. */
const CHOICE_JOIN = ', ';

/** Decimal places a number shows when its field leaves the precision open. */
const OPEN_PRECISION_DIGITS = 10;

/**
 * The layouts a field prescribes keep their own order in every language, so the date and the time
 * are joined here rather than by the locale.  ISO 8601 puts a space between them.
 */
const PRESCRIBED_JOIN: Record<'us' | 'european' | 'iso', string> = { us: ', ', european: ', ', iso: ' ' };

/** A date-only value has no time zone; rendering it as UTC noon keeps the calendar day put. */
const WALL_DATE_ZONE = 'UTC';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The other shape a stored date can have: an ISO 8601 instant, as `checkCellValue` writes one. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Above this many distinct option sets the caches start over rather than grow without end. */
const CACHE_LIMIT = 256;

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function cached<T>(cache: Map<string, T>, key: string, create: () => T): T {
  const found = cache.get(key);
  if (found !== undefined) return found;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const created = create();
  cache.set(key, created);
  return created;
}

function translate(descriptor: MessageDescriptor): string {
  // The app activates a locale at boot, and it is the locale a grid is drawn in.  Formatting also
  // runs before that (an early paint, a test), and drawing a cell must never throw, so fall back to
  // the source text, with its values filled in.
  if (i18n.locale !== '') return i18n._(descriptor);
  const values = (descriptor.values ?? {}) as Record<string, unknown>;
  return (descriptor.message ?? descriptor.id).replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

/** The moment of a signature, in the viewer's own zone. */
const SIGNED_TIME: DateOptions = {
  includeTime: true,
  dateFormat: 'local',
  timeFormat: 'local',
  timeZone: 'client',
};

/** Who signed and when, the words a download uses too. */
export function signatureText(value: SignatureValue, ctx: FormatContext): string {
  const time = formatMoment(value.signedAt, SIGNED_TIME, ctx);
  const name = value.name ?? (value.signedBy ? ctx.collaborators.get(value.signedBy)?.name : undefined);
  return name
    ? translate(msg({ id: 'fields.signature.signedBy', message: `Signed by ${name} at ${time}` }))
    : translate(msg({ id: 'fields.signature.signedAt', message: `Signed at ${time}` }));
}

function numberFormat(locale: string, precision: number | null, grouping: boolean): Intl.NumberFormat {
  return cached(
    numberFormats,
    `${locale}|${String(precision)}|${grouping}`,
    () =>
      new Intl.NumberFormat(locale, {
        useGrouping: grouping,
        minimumFractionDigits: precision ?? 0,
        maximumFractionDigits: precision ?? OPEN_PRECISION_DIGITS,
      }),
  );
}

function dateFormat(locale: string, layout: DateFormat, zone: string): Intl.DateTimeFormat {
  const style = layout === 'friendly' ? 'long' : 'medium';
  return cached(
    dateTimeFormats,
    `date|${locale}|${style}|${zone}`,
    () => new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: zone }),
  );
}

function hourCycleOf(timeFormat: TimeFormat): 'h12' | 'h23' | null {
  if (timeFormat === '12h') return 'h12';
  if (timeFormat === '24h') return 'h23';
  return null;
}

function timeFormatter(locale: string, timeFormat: TimeFormat, zone: string): Intl.DateTimeFormat {
  const hourCycle = hourCycleOf(timeFormat);
  return cached(
    dateTimeFormats,
    `time|${locale}|${timeFormat}|${zone}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        timeStyle: 'short',
        timeZone: zone,
        ...(hourCycle === null ? {} : { hourCycle }),
      }),
  );
}

/**
 * The locale's own date pattern, with the time the field asks for.  `hourCycle` is honored next to
 * `timeStyle`, so one object covers both the locale's clock and a prescribed one.
 */
function dateTimeFormat(locale: string, layout: 'local' | 'friendly', timeFormat: TimeFormat, zone: string) {
  const hourCycle = hourCycleOf(timeFormat);
  return cached(
    dateTimeFormats,
    `dateTime|${locale}|${layout}|${timeFormat}|${zone}`,
    () =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: layout === 'friendly' ? 'long' : 'medium',
        timeStyle: 'short',
        timeZone: zone,
        ...(hourCycle === null ? {} : { hourCycle }),
      }),
  );
}

/** Numeric year, month, and day in a zone, for the layouts that don't follow the locale's order. */
function calendarParts(zone: string): Intl.DateTimeFormat {
  return cached(
    dateTimeFormats,
    `parts|${zone}`,
    () =>
      // A fixed locale keeps the pieces unpadded and free of separators; the layout below arranges them.
      new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: zone }),
  );
}

function zoneNameFormat(locale: string, zone: string): Intl.DateTimeFormat {
  return cached(
    dateTimeFormats,
    `zone|${locale}|${zone}`,
    () => new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' }),
  );
}

/** The zone's short name, `PDT`, which only appears when it isn't the viewer's own zone. */
function zoneAbbreviation(locale: string, zone: string, instant: Date): string {
  const part = zoneNameFormat(locale, zone)
    .formatToParts(instant)
    .find((piece) => piece.type === 'timeZoneName');
  return part ? part.value : '';
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** `2026-09-27`, `9/27/2026`, or `27/9/2026` for the layouts the field prescribes. */
function prescribedDate(instant: Date, layout: 'us' | 'european' | 'iso', zone: string): string {
  const parts = calendarParts(zone).formatToParts(instant);
  const get = (type: string): string => parts.find((piece) => piece.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  if (layout === 'iso') return `${pad(Number(year), 4)}-${pad(Number(month), 2)}-${pad(Number(day), 2)}`;
  return layout === 'us' ? `${month}/${day}/${year}` : `${day}/${month}/${year}`;
}

function dateOnlyText(instant: Date, layout: DateFormat, locale: string, zone: string): string {
  return layout === 'us' || layout === 'european' || layout === 'iso'
    ? prescribedDate(instant, layout, zone)
    : dateFormat(locale, layout, zone).format(instant);
}

function dateAndTimeText(
  instant: Date,
  layout: DateFormat,
  timeFormat: TimeFormat,
  locale: string,
  zone: string,
): string {
  if (layout === 'local' || layout === 'friendly') {
    return dateTimeFormat(locale, layout, timeFormat, zone).format(instant);
  }
  const date = prescribedDate(instant, layout, zone);
  const time = timeFormatter(locale, timeFormat, zone).format(instant);
  return `${date}${PRESCRIBED_JOIN[layout]}${time}`;
}

/** What a stored date value points at: an instant in a zone, or a calendar day with no zone. */
interface StoredDate {
  instant: Date;
  zone: string;
  /** True for `YYYY-MM-DD`, which means the day itself and so shows no time and no zone name. */
  wallDate: boolean;
}

function readStoredDate(value: string, zone: string): StoredDate | null {
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly !== null) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    // Noon keeps the day put in UTC; a day that never happened (February 30) rolls over instead.
    const instant = new Date(Date.UTC(year, month - 1, day, 12));
    if (
      instant.getUTCFullYear() !== year ||
      instant.getUTCMonth() !== month - 1 ||
      instant.getUTCDate() !== day
    ) {
      return null;
    }
    return { instant, zone: WALL_DATE_ZONE, wallDate: true };
  }
  // Anything else is a value this field can't hold; showing a date `Date.parse` guessed at would
  // read as a real one.
  if (!INSTANT.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : { instant: new Date(time), zone, wallDate: false };
}

function formatMoment(value: string, options: DateOptions, ctx: FormatContext): string {
  const zone = options.timeZone === 'client' ? ctx.timeZone : options.timeZone;
  const stored = readStoredDate(value, zone);
  if (stored === null) return '';
  const { instant, zone: shownIn, wallDate } = stored;
  const showsTime = options.includeTime && !wallDate;
  const text = showsTime
    ? dateAndTimeText(instant, options.dateFormat, options.timeFormat, ctx.locale, shownIn)
    : dateOnlyText(instant, options.dateFormat, ctx.locale, shownIn);
  if (!showsTime) return text;
  // A fixed zone that isn't the viewer's own is the one thing they can't work out themselves.
  const fixed =
    options.timeZone !== 'client' && options.timeZone.toLowerCase() !== ctx.timeZone.toLowerCase();
  if (!fixed) return text;
  const abbreviation = zoneAbbreviation(ctx.locale, shownIn, instant);
  return abbreviation === '' ? text : `${text} ${abbreviation}`;
}

/**
 * The text a cell shows and a copy puts on the clipboard.  Empty values, and values of a type the
 * field can't hold, show as nothing.
 */
export function formatCell(field: FieldMeta, value: CellValue, ctx: FormatContext): string {
  switch (field.type) {
    case 'time':
      return typeof value === 'string' ? formatTimeOfDay(value, ctx.locale, field.options.timeFormat) : '';
    case 'multiCurrency':
      return isMultiCurrencyValue(value)
        ? `${value.code} ${numberFormat(ctx.locale, field.options.precision, true).format(value.amount)}`
        : '';
    case 'changeLog':
      return Array.isArray(value)
        ? value
            .filter(isChangeLogEntry)
            .map((entry) => {
              const fields = new Intl.ListFormat(ctx.locale, { style: 'long', type: 'conjunction' }).format(
                entry.fieldIds.flatMap((id) => ctx.fieldsById?.get(id)?.name ?? []),
              );
              if (!fields) return '';
              const actor =
                (entry.actorId ? personLabel(ctx.collaborators.get(entry.actorId)) : undefined) ??
                translate(msg({ id: 'fields.changeLog.unknownPerson', message: 'Unknown person' }));
              const at = new Intl.DateTimeFormat(ctx.locale, {
                dateStyle: 'short',
                timeStyle: 'short',
                timeZone: ctx.timeZone,
              }).format(new Date(entry.at));
              return translate(msg({ id: 'fields.changeLog.entry', message: `${at} ${actor}: ${fields}` }));
            })
            .filter(Boolean)
            .join('\n')
        : '';
    case 'barcode':
      return typeof value === 'string' ? value : '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? numberFormat(ctx.locale, field.options.precision, field.options.thousands).format(value)
        : '';
    case 'checkbox':
      return value === true ? translate(CHECKED) : '';
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
      return typeof value === 'string' ? formatMoment(value, field.options, ctx) : '';
    case 'singleSelect':
      if (typeof value !== 'string') return '';
      return field.options.choices.find((choice) => choice.id === value)?.name ?? '';
    case 'multipleSelect': {
      if (!Array.isArray(value)) return '';
      // A choice name is never empty, so one that isn't found drops out of the list.
      return value
        .map((id) => field.options.choices.find((choice) => choice.id === id)?.name ?? '')
        .filter((name) => name !== '')
        .join(CHOICE_JOIN);
    }
    case 'createdBy':
    case 'lastModifiedBy':
      return typeof value === 'string' ? personLabel(ctx.collaborators.get(value)) : '';
    case 'longText':
      // Rich text shows its words on one line.  Copying and editing keep its Markdown.
      if (typeof value !== 'string') return '';
      return field.options.richText ? markdownLine(value) : value;
    case 'text':
    case 'email':
    case 'url':
    case 'phone':
    case 'recordId':
      return typeof value === 'string' ? value : '';
    case 'lineItems': {
      const count = idsOf(value).length;
      return i18n._(
        msg({ id: 'lineItems.count', message: plural(count, { one: '# line', other: '# lines' }) }),
      );
    }
    case 'link':
      return idsOf(value)
        .map((id) => ctx.linked?.get(id) ?? id)
        .join(CHOICE_JOIN);
    case 'count':
      return typeof value === 'number' ? numberFormat(ctx.locale, 0, true).format(value) : '';
    case 'lookup': {
      const target = displayField(field, ctx);
      const values = Array.isArray(value) ? value : value === null ? [] : [value];
      return values
        .map((item) =>
          formatCell(target, target.type === 'multipleSelect' || target.type === 'link' ? [item] : item, ctx),
        )
        .filter(Boolean)
        .join(CHOICE_JOIN);
    }
    case 'rollup':
    case 'formula':
      return field.options.resultType === 'array'
        ? plainText(value, ctx)
        : formatCell(resultField(field), value, ctx);
    case 'currency':
      return typeof value === 'number' && Number.isFinite(value)
        ? cached(
            numberFormats,
            `${ctx.locale}|${field.options.code}|${field.options.precision}`,
            () =>
              new Intl.NumberFormat(ctx.locale, {
                style: 'currency',
                currency: field.options.code,
                minimumFractionDigits: field.options.precision,
                maximumFractionDigits: field.options.precision,
              }),
          ).format(value)
        : '';
    case 'percent':
      return typeof value === 'number' && Number.isFinite(value)
        ? cached(
            numberFormats,
            `${ctx.locale}|%|${field.options.precision}`,
            () =>
              new Intl.NumberFormat(ctx.locale, {
                style: 'percent',
                minimumFractionDigits: field.options.precision,
                maximumFractionDigits: field.options.precision,
              }),
          ).format(value)
        : '';
    case 'duration':
      return typeof value === 'number' && Number.isFinite(value)
        ? durationText(value, field.options.format)
        : '';
    case 'rating':
    case 'autoNumber':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'user':
      return (typeof value === 'string' ? [value] : idsOf(value))
        .map((id) => personLabel(ctx.collaborators.get(id)))
        .filter((name) => name !== '')
        .join(CHOICE_JOIN);
    case 'attachment':
      return idsOf(value)
        .map((id) => ctx.attachments?.get(id)?.name ?? id)
        .join(CHOICE_JOIN);
    case 'dateRange': {
      if (!isDateRangeValue(value)) return '';
      const start = formatMoment(value.start, field.options, ctx);
      const end = formatMoment(value.end, field.options, ctx);
      return start === end ? start : `${start} – ${end}`;
    }
    case 'json':
      return typeof value === 'string' ? value : '';
    // The grid shows the label when there is one, and `copyText` keeps the coordinates too.
    case 'location':
      return isLocationValue(value) ? (value.label ?? coordinatesText(value)) : '';
    case 'signature':
      return isSignatureValue(value) ? signatureText(value, ctx) : '';
    case 'button':
      return '';
  }
}

/** Lookups inherit their target's formatting, even when the target is another lookup. */
export function displayField(field: FieldMeta, ctx: FormatContext): FieldMeta {
  const seen = new Set<string>();
  while (field.type === 'lookup' && !seen.has(field.id)) {
    seen.add(field.id);
    const target = ctx.fieldsById?.get(field.options.targetFieldId);
    if (!target) break;
    field = target;
  }
  return resultField(field);
}

/** Seconds as hours, minutes, and optionally seconds with up to three decimals: `1:02:05.5`. */
export function durationText(seconds: number, format: FieldOptionsOf<'duration'>['format']): string {
  const digits = format.length > 7 ? format.length - 8 : 0;
  const showSeconds = format !== 'h:mm';
  const scale = 10 ** digits;
  const total = showSeconds ? Math.round(seconds * scale) : Math.round(seconds / 60) * 60;
  const whole = showSeconds ? Math.floor(total / scale) : total;
  const hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, '0');
  if (!showSeconds) return `${hours}:${minutes}`;
  const secs = String(whole % 60).padStart(2, '0');
  const fraction = digits ? `.${String(total % scale).padStart(digits, '0')}` : '';
  return `${hours}:${minutes}:${secs}${fraction}`;
}

/** Lists from formulas and rollups may mix scalar value types. */
function plainText(value: CellValue, ctx: FormatContext): string {
  if (isMultiCurrencyValue(value)) return multiCurrencyText(value);
  if (isDateRangeValue(value)) return dateRangeText(value);
  if (isLocationValue(value)) return coordinatesText(value);
  if (isSignatureValue(value)) return signatureText(value, ctx);
  if (Array.isArray(value)) {
    return value
      .map((item) => plainText(item, ctx))
      .filter((text) => text !== '')
      .join(CHOICE_JOIN);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? numberFormat(ctx.locale, null, true).format(value) : '';
  }
  if (typeof value === 'boolean') return value ? translate(CHECKED) : '';
  return typeof value === 'string' ? value : '';
}

/**
 * The text an inline editor starts with.  Numbers drop their grouping so selecting all and typing
 * replaces digits and not separators; everything else edits as it shows.
 */
export function editText(field: FieldMeta, value: CellValue, ctx: FormatContext): string {
  if (field.type === 'longText') return typeof value === 'string' ? value : '';
  if (
    (field.type === 'currency' || field.type === 'percent' || field.type === 'duration') &&
    typeof value === 'number' &&
    Number.isFinite(value)
  ) {
    const [coefficient, exponent = '0'] = String(value).split('e');
    const editable =
      field.type === 'percent'
        ? Number(`${coefficient}e${Number(exponent) + 2}`)
        : field.type === 'duration' && field.options.format === 'h:mm'
          ? value / 60
          : value;
    return new Intl.NumberFormat(ctx.locale, { useGrouping: false, maximumSignificantDigits: 17 }).format(
      editable,
    );
  }
  if (field.type === 'number' && typeof value === 'number' && Number.isFinite(value)) {
    return numberFormat(ctx.locale, field.options.precision, false).format(value);
  }
  return formatCell(field, value, ctx);
}
