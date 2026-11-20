import {
  FieldMeta,
  LIMITS,
  checkCellValue,
  type CellValue,
  type IngestRowReason,
  type ValueCheck,
} from '@riosoma/contracts';
import {
  boolean,
  date,
  duration,
  instant,
  isEmpty,
  number,
  text,
  type CleanerInput,
  type CleanerResult,
} from '@riosoma/ingest';
import type { StoredField } from '../../data/types.js';
import { decodeValue } from '../../data/physical/columns.js';

/** These fields physically hold text, including text that fails their semantic check. */
export function retainedIngestText(field: StoredField, input: unknown): ValueCheck | null {
  // An unexpected model choice stays visible for review without adding it to the allowed choices.
  if (field.type === 'singleSelect' && typeof input === 'string') {
    const checked = checkCellValue(FieldMeta.parse({ ...field, type: 'text', options: {} }), input);
    return checked.ok ? { ok: true, value: input } : checked;
  }
  if (field.type === 'multipleSelect' && Array.isArray(input) && input.length <= LIMITS.choicesPerField) {
    const textField = FieldMeta.parse({ ...field, type: 'text', options: {} });
    return input.every((item: unknown) => typeof item === 'string' && checkCellValue(textField, item).ok)
      ? { ok: true, value: input }
      : null;
  }
  if (!['text', 'longText', 'barcode', 'email', 'url', 'phone', 'json', 'time'].includes(field.type))
    return null;
  if (typeof input !== 'string') return null;
  // JSON is stored as text and can contain line breaks.  Retaining a failed check must still
  // respect its size limit without flattening or otherwise editing the original value.
  if (field.type === 'json')
    return input.length > LIMITS.jsonLength
      ? { ok: false, messageKey: 'data.value.tooLong' }
      : { ok: true, value: input };
  return checkCellValue(
    FieldMeta.parse({ ...field, type: field.type === 'longText' ? 'longText' : 'text', options: {} }),
    input,
  );
}

export interface CheckContext {
  choices: ReadonlyMap<string, ReadonlyMap<string, string | null>>;
  links: ReadonlyMap<string, ReadonlySet<string>>;
}
export function checkOutputValue(
  field: StoredField,
  key: string,
  input: unknown,
  required: boolean,
  context: CheckContext,
  retainChoice = false,
): { value: CellValue; reasons: IngestRowReason[] } {
  const reasons: IngestRowReason[] = [];
  const issue = (name: string, messageId: string) => {
    reasons.push({ messageId, params: { field: field.name }, source: { kind: 'check', name } });
  };
  const scalar =
    input === undefined || input === null || ['string', 'number', 'boolean'].includes(typeof input);
  const empty = scalar ? isEmpty(input as CleanerInput) : Array.isArray(input) && input.length === 0;
  let value: unknown = empty ? null : input;
  let invalid = false;
  if (!empty) {
    let cleaned: CleanerResult<unknown> | undefined;
    switch (field.type) {
      case 'number':
      case 'currency':
      case 'percent':
      case 'rating':
        if (scalar) {
          cleaned = number(input as CleanerInput);
          value = cleaned.value === null ? null : Number(cleaned.value);
        } else invalid = true;
        break;
      case 'duration':
        if (scalar) {
          cleaned = duration(input as CleanerInput, { unit: 'seconds' });
          value = cleaned.value === null ? null : Number(cleaned.value);
        } else invalid = true;
        break;
      case 'checkbox':
        if (scalar) {
          cleaned = boolean(input as CleanerInput);
          value = cleaned.value;
        } else invalid = true;
        break;
      case 'date':
        if (scalar) {
          cleaned = field.options.includeTime ? instant(input as CleanerInput) : date(input as CleanerInput);
          value =
            field.options.includeTime && cleaned.value !== null
              ? new Date(Number(cleaned.value) * 1000).toISOString()
              : cleaned.value;
        } else invalid = true;
        break;
      case 'text':
      case 'longText':
      case 'barcode':
      case 'email':
      case 'url':
      case 'phone':
      case 'json':
      case 'time':
        if (scalar) {
          cleaned = text(input as CleanerInput);
          value = cleaned.value;
        } else invalid = true;
        break;
      case 'singleSelect':
      case 'multipleSelect': {
        const offered = context.choices.get(field.id) ?? new Map();
        const items = field.type === 'multipleSelect' ? (Array.isArray(input) ? input : [input]) : [input];
        const ids = items.map((item: unknown) => {
          if (typeof item !== 'string') return null;
          return offered.get(text(item).value ?? '') ?? null;
        });
        if (ids.some((id) => id === null)) {
          invalid = true;
          issue('choice', 'ingest.write.choice');
        } else value = field.type === 'singleSelect' ? ids[0] : [...new Set(ids)];
        break;
      }
      case 'link': {
        const ids = Array.isArray(input) ? input : [input];
        if (ids.some((id: unknown) => typeof id !== 'string' || !context.links.get(field.id)?.has(id))) {
          invalid = true;
          issue('link', 'ingest.write.link');
        } else value = ids;
        break;
      }
    }
    if (cleaned && !cleaned.certain) invalid = true;
  }
  const checked = checkCellValue(field, invalid ? null : value);
  if (!checked.ok) invalid = true;
  if (invalid && reasons.length === 0) issue('type', 'ingest.write.type');
  const choice = field.type === 'singleSelect' || field.type === 'multipleSelect';
  const retained = invalid && (!choice || retainChoice) ? retainedIngestText(field, input) : null;
  const result = invalid ? (retained?.ok ? retained.value : null) : checked.ok ? checked.value : null;
  if (required && (empty || result === null)) issue('required', 'ingest.write.required');
  // Check reasons describe the value that was kept or emptied.  Only earlier decisions name a
  // field to suppress, so a retained invalid text value is never erased by its own check reason.
  return {
    value: decodeValue(field, result),
    reasons: reasons.map((reason) => ({ ...reason, params: { ...reason.params, key } })),
  };
}
