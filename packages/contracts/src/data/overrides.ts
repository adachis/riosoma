import { FieldSpec, type FieldMeta, type FieldType } from './fields.js';
import { checkCellValue, type ValueCheck } from './values.js';

export function isOverrideType(type: FieldType): boolean {
  return type === 'formula' || type === 'lookup' || type === 'rollup';
}

/** Validate a pin against the computed result, without making the field itself editable. */
export function checkComputedOverride(field: FieldMeta, input: unknown): ValueCheck {
  if (!isOverrideType(field.type) || !('resultType' in field.options))
    return { ok: false, messageKey: 'data.value.computed' };
  const result = field.type === 'lookup' ? 'array' : field.options.resultType;
  if (result === 'array') {
    if (input === null) return { ok: true, value: null };
    if (
      Array.isArray(input) &&
      input.length <= 1000 &&
      input.every(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item)),
      )
    )
      return { ok: true, value: input };
    return { ok: false, messageKey: 'errors.validationFailed' };
  }
  const spec = FieldSpec.parse({
    type: result === 'boolean' ? 'checkbox' : result === 'datetime' ? 'date' : result,
    options: result === 'datetime' ? { includeTime: true } : {},
  });
  return checkCellValue({ ...field, ...spec }, input);
}
