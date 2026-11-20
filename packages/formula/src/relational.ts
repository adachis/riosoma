import {
  matchesFilter,
  type CellValue,
  type ConditionContext,
  type FieldMeta,
  type FieldSpec,
} from '@riosoma/contracts';
import type { FormulaRecord, FormulaValue } from './ast.js';
import { isError } from './value.js';

/** Linked records arrive in link order, after the reader's access has been applied. */
export function evaluateRelation(
  field: Extract<FieldSpec, { type: 'lookup' | 'rollup' | 'count' }>,
  current: FormulaRecord,
  linked: readonly FormulaRecord[],
  fields: readonly FieldMeta[],
  context: ConditionContext,
): FormulaValue {
  const byId = new Map(fields.map((item) => [item.id, item]));
  const valueOf = (row: FormulaRecord, id: string) => {
    const type = byId.get(id)?.type;
    if (type === 'recordId') return row.id;
    if (type === 'createdTime') return row.createdAt;
    if (type === 'lastModifiedTime') return row.updatedAt;
    if (type === 'createdBy') return row.createdBy ?? row.values[id] ?? null;
    if (type === 'lastModifiedBy') return row.updatedBy ?? row.values[id] ?? null;
    if (type === 'checkbox') return row.values[id] === true;
    return row.values[id] ?? null;
  };
  let rows = linked.filter((row) =>
    matchesFilter(field.options.filter, byId, (item) => valueOf(row, item.id) as CellValue, {
      ...context,
      currentValue: (id) => valueOf(current, id) as CellValue,
    }),
  );
  if (field.type === 'lookup') {
    const positions = new Map(linked.map((row, index) => [row.id, index]));
    rows.sort((a, b) => {
      for (const sort of field.options.sort ?? []) {
        const x = valueOf(a, sort.fieldId),
          y = valueOf(b, sort.fieldId);
        if (x === y) continue;
        if (x === null || y === null) return x === null ? 1 : -1;
        const difference = x < y ? -1 : 1;
        return sort.direction === 'desc' ? -difference : difference;
      }
      return positions.get(a.id)! - positions.get(b.id)!;
    });
    if (field.options.limit) rows = rows.slice(0, field.options.limit);
  }
  if (field.type === 'count' || (field.type === 'rollup' && field.options.fn === 'countAll'))
    return rows.length;
  const values = rows.flatMap((row) => {
    const value = valueOf(row, field.options.targetFieldId);
    return Array.isArray(value) ? value : [value];
  });
  const error = values.find(isError);
  if (error) return error;
  const present = values.filter((value) => value !== null && value !== '') as FormulaValue[];
  if (field.type === 'lookup') return present;
  const numbers = present.filter((value): value is number => typeof value === 'number');
  const unique = [...new Map(present.map((value) => [JSON.stringify(value), value])).values()];
  switch (field.options.fn) {
    case 'sum':
      return numbers.reduce((a, b) => a + b, 0);
    case 'average':
      return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null;
    case 'countAll':
      return rows.length;
    case 'count':
      return present.length;
    case 'countUnique':
      return unique.length;
    case 'arrayUnique':
      return unique;
    case 'concatenate':
      return present.join(', ');
    case 'and':
      return present.every(Boolean);
    case 'or':
      return present.some(Boolean);
    case 'min':
    case 'earliest':
    case 'max':
    case 'latest': {
      const sorted = [...present].sort((a, b) => (a === b ? 0 : a! < b! ? -1 : 1));
      return (['min', 'earliest'].includes(field.options.fn) ? sorted[0] : sorted.at(-1)) ?? null;
    }
  }
}
