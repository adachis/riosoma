import { FieldId } from './fields.js';
import {
  coordinatesText,
  dateRangeText,
  type DateRangeValue,
  type LocationValue,
  type SignatureValue,
} from './compound-values.js';
import type { CellValue } from './values.js';

/**
 * A button's link template: a URL with fields in braces.  Clients show and take field names,
 * and the server stores field IDs.  Filling it happens on both sides, so the link a person opens is
 * the link a download or the REST API reports.
 */

const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The IDs and names the template's braces hold, in order, with where each one sits. */
function placeholders(template: string): Array<{ text: string; index: number; length: number }> {
  return [...template.matchAll(PLACEHOLDER)].map((match) => ({
    text: match[1]!.trim(),
    index: match.index,
    length: match[0].length,
  }));
}

/** The field IDs a stored template uses. */
export function templateFieldIds(template: string): string[] {
  return [...new Set(placeholders(template).map((part) => part.text))].filter(
    (text) => FieldId.safeParse(text).success,
  );
}

type NamedField = { id: string; name: string };

/**
 * A template with its field names turned into IDs.  An ID already in braces stays as it is when
 * the field exists.  A name that matches no field, or more than one, is returned as `unknown`.
 */
export function resolveTemplate(
  template: string,
  fields: readonly NamedField[],
): { template: string } | { unknown: string } {
  const ids = new Set(fields.map((field) => field.id));
  let out = '';
  let last = 0;
  for (const part of placeholders(template)) {
    let id: string | undefined;
    if (ids.has(part.text)) id = part.text;
    else {
      const named = fields.filter((field) => field.name.trim().toLowerCase() === part.text.toLowerCase());
      if (named.length === 1) id = named[0]!.id;
    }
    if (!id) return { unknown: part.text };
    out += `${template.slice(last, part.index)}{${id}}`;
    last = part.index + part.length;
  }
  return { template: out + template.slice(last) };
}

/** A stored template with names in place of IDs, for editing.  Unknown IDs stay as they are. */
export function describeTemplate(template: string, fields: readonly NamedField[]): string {
  const names = new Map(fields.map((field) => [field.id, field.name]));
  return template.replace(PLACEHOLDER, (whole, text: string) => {
    const name = names.get(text.trim());
    return name === undefined ? whole : `{${name}}`;
  });
}

/**
 * Whether a template can ever make an `http` or `https` link: it starts with one, or with a field
 * that might hold one.  An empty template is fine too, though its button can't be pressed yet.
 */
export function templateScheme(template: string): boolean {
  const trimmed = template.trim();
  return trimmed === '' || trimmed.startsWith('{') || /^https?:\/\/[^\s/]/i.test(trimmed);
}

export type FilledLink =
  | { ok: true; url: string }
  /** A field the template uses is gone, or hidden from the reader */
  | { ok: false; reason: 'missingField'; fieldId: string }
  /** No template yet */
  | { ok: false; reason: 'empty' }
  /** The filled link isn't `http` or `https`, or isn't a link at all */
  | { ok: false; reason: 'invalid' };

/**
 * The link a button opens.  `text` gives each field's value as text, or undefined when the field
 * doesn't exist.  A field at the very start goes in as it is, so a URL field can be the whole
 * link, and a bare domain there gains `https://`.  Anywhere else values are encoded.
 */
export function fillTemplate(template: string, text: (fieldId: string) => string | undefined): FilledLink {
  const trimmed = template.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  let url = '';
  let last = 0;
  for (const part of placeholders(trimmed)) {
    const value = text(part.text);
    if (value === undefined) return { ok: false, reason: 'missingField', fieldId: part.text };
    url += trimmed.slice(last, part.index) + (part.index === 0 ? value.trim() : encodeURIComponent(value));
    last = part.index + part.length;
  }
  url += trimmed.slice(last);
  if (trimmed.startsWith('{') && !/^[a-z][a-z\d+.-]*:/i.test(url) && /^[\p{L}\p{N}]/u.test(url))
    url = `https://${url}`;
  return safeLink(url) ? { ok: true, url } : { ok: false, reason: 'invalid' };
}

/** An absolute `http` or `https` link with a host and nothing unprintable in it. */
export function safeLink(url: string): boolean {
  if (url.length > 8_192 || /[\s\p{Cc}]/u.test(url)) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/** What a template needs to word a field's value: names for choices, people, records, and files. */
export interface TemplateNames {
  person?(id: string): string | undefined;
  record?(id: string): string | undefined;
  file?(id: string): string | undefined;
}

interface TemplateField {
  id: string;
  type: string;
  options: unknown;
}

function plain(item: unknown): string {
  if (item === null || item === undefined) return '';
  if (typeof item === 'object') {
    if ('start' in item && 'end' in item) return dateRangeText(item as DateRangeValue);
    if ('lat' in item && 'lng' in item) return coordinatesText(item as LocationValue);
    if ('amount' in item && 'code' in item) return `${String(item.code)} ${String(item.amount)}`;
    if ('signedAt' in item) return (item as SignatureValue).name ?? '';
    return '';
  }
  return String(item);
}

/**
 * A value as a link carries it: numbers and dates as stored (`1234.5`, `2026-09-27`), choices,
 * people, linked records, and files by name, checkboxes as `true` or `false`, date ranges as
 * `start/end`, locations as `lat, lng`, and signatures by the signer's typed name.
 */
export function templateText(field: TemplateField, value: CellValue, names: TemplateNames = {}): string {
  const list = Array.isArray(value) ? value : value === null ? [] : [value];
  const choices =
    typeof field.options === 'object' && field.options !== null && 'choices' in field.options
      ? (field.options.choices as ReadonlyArray<{ id: string; name: string }>)
      : [];
  const named = (lookup: ((id: string) => string | undefined) | undefined) =>
    list
      .map((id) => lookup?.(String(id)) ?? '')
      .filter(Boolean)
      .join(', ');
  switch (field.type) {
    case 'checkbox':
      return value === true ? 'true' : 'false';
    case 'singleSelect':
    case 'multipleSelect':
      return list
        .map((id) => choices.find((choice) => choice.id === id)?.name ?? '')
        .filter(Boolean)
        .join(', ');
    case 'user':
    case 'createdBy':
    case 'lastModifiedBy':
      return named(names.person);
    case 'lineItems':
    case 'link':
      return named(names.record);
    case 'attachment':
      return named(names.file);
    case 'button':
      return '';
    default:
      return list.map(plain).filter(Boolean).join(', ');
  }
}
