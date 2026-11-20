import type { FieldMeta } from '@riosoma/contracts';
import { fieldType, type FormulaBuilder } from '@riosoma/formula';
import { resultType } from '../../../../data/formulas';

export type BuilderKind = FormulaBuilder['kind'];

export function builderFields(kind: BuilderKind, fields: readonly FieldMeta[]) {
  return fields.filter((field) => {
    if (kind === 'links') return field.type === 'link' || field.type === 'lineItems';
    // Lookups hold lists even when their declared result describes a scalar item.
    if (field.type === 'lookup') return false;
    const inferred =
      field.type === 'formula' || field.type === 'rollup'
        ? resultType(field)
        : fieldType({
            id: field.id,
            name: field.name,
            type: field.type,
            options: { includeTime: 'includeTime' in field.options && field.options.includeTime },
          });
    const type = typeof inferred === 'string' ? inferred : 'array';
    if (kind === 'difference') return type === 'date' || type === 'datetime';
    if (kind === 'bucket') return type === 'number';
    if (kind === 'mapping') return type === 'text';
    return ['text', 'number', 'boolean', 'date', 'datetime'].includes(type);
  });
}

export function initialBuilder(kind: BuilderKind, fields: readonly FieldMeta[]): FormulaBuilder {
  const candidates = builderFields(kind, fields);
  const first = candidates[0]?.id ?? '',
    second = candidates[1]?.id ?? first;
  switch (kind) {
    case 'combine':
      return { kind, first, second, separator: ' ' };
    case 'difference':
      return { kind, start: first, end: second, unit: 'days' };
    case 'mapping':
      return { kind, field: first, match: '', then: '', otherwise: '' };
    case 'bucket':
      return { kind, field: first, boundary: 0, then: '', otherwise: '' };
    case 'links':
      return { kind, field: first, position: 1 };
  }
}

export function builderFits(builder: FormulaBuilder, fields: readonly FieldMeta[]): boolean {
  const ids = new Set(builderFields(builder.kind, fields).map((field) => field.id));
  const references =
    builder.kind === 'combine'
      ? [builder.first, builder.second]
      : builder.kind === 'difference'
        ? [builder.start, builder.end]
        : [builder.field];
  return references.every((id) => ids.has(id));
}

/** References use IDs and text uses quoted literals, so names and typed text cannot inject syntax. */
export function builderExpression(builder: FormulaBuilder): string {
  const ref = (id: string) => `{${id.replaceAll('\\', '\\\\').replaceAll('}', '\\}')}}`;
  const quote = (value: string) => JSON.stringify(value);
  switch (builder.kind) {
    case 'combine':
      return `CONCATENATE(${ref(builder.first)}, ${quote(builder.separator)}, ${ref(builder.second)})`;
    case 'difference':
      return `DATETIME_DIFF(${ref(builder.end)}, ${ref(builder.start)}, ${quote(builder.unit)})`;
    case 'mapping':
      return `IF(${ref(builder.field)} = ${quote(builder.match)}, ${quote(builder.then)}, ${quote(builder.otherwise)})`;
    case 'bucket':
      return Number.isFinite(builder.boundary)
        ? `IF(${ref(builder.field)} < ${builder.boundary}, ${quote(builder.then)}, ${quote(builder.otherwise)})`
        : '';
    case 'links':
      return Number.isSafeInteger(builder.position) && builder.position > 0
        ? `ARRAYJOIN(ARRAYSLICE(${ref(builder.field)}, ${builder.position}, ${builder.position}), "")`
        : '';
  }
}
