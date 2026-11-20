import { filterProblem } from '@riosoma/contracts';
import { ConnectorError } from '../types.js';
import { fieldParts } from './paths.js';

export type Scalar = string | number | boolean | null;
export type Predicate =
  | { op: 'and' | 'or'; terms: Predicate[] }
  | {
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
      field: string;
      value: Scalar;
      numeric?: boolean;
      key?: boolean;
      missing?: boolean;
    };
export interface DocumentOrder {
  field: string;
  direction: 'asc' | 'desc';
}
export const ALL: Predicate = { op: 'and', terms: [] };
export const NONE: Predicate = { op: 'or', terms: [] };
export const and = (...terms: Predicate[]): Predicate => ({ op: 'and', terms });
export function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
export function parseSelector(text?: string): Predicate {
  if (!text) return ALL;
  if (filterProblem(text)) throw new ConnectorError('sources.nosql.filter');
  const walk = (value: unknown): Predicate => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new ConnectorError('sources.nosql.filter');
    return and(
      ...Object.entries(value).map(([field, v]): Predicate => {
        if (field === '$and' || field === '$or') {
          if (!Array.isArray(v)) throw new ConnectorError('sources.nosql.filter');
          return { op: field === '$and' ? 'and' : 'or', terms: v.map(walk) };
        }
        if (
          field.startsWith('$') ||
          !field ||
          fieldParts(field).some((p) => ['__proto__', 'constructor', 'prototype'].includes(p))
        )
          throw new ConnectorError('sources.nosql.filter');
        if (scalar(v)) return { op: 'eq', field, value: v };
        if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length === 0)
          throw new ConnectorError('sources.nosql.filter');
        return and(
          ...Object.entries(v).map(([operator, input]): Predicate => {
            const op = operator.slice(1);
            if (operator === '$in' && Array.isArray(input) && input.every(scalar))
              return { op: 'or', terms: input.map((value) => ({ op: 'eq', field, value })) };
            if (!['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'].includes(operator) || !scalar(input))
              throw new ConnectorError('sources.nosql.filter');
            return { op: op as 'eq', field, value: input };
          }),
        );
      }),
    );
  };
  return walk(JSON.parse(text));
}
export function conjunction(predicate: Predicate): Predicate[] {
  return predicate.op === 'and' ? predicate.terms.flatMap(conjunction) : [predicate];
}
export function equality(predicate: Predicate, field: string): Scalar | undefined {
  const found = conjunction(predicate).find((p) => 'field' in p && p.field === field && p.op === 'eq');
  return found && 'value' in found ? found.value : undefined;
}
export function mango(predicate: Predicate): Record<string, unknown> {
  if ('terms' in predicate) {
    if (!predicate.terms.length) return predicate.op === 'and' ? {} : { _id: { $exists: false } };
    return { [predicate.op === 'and' ? '$and' : '$or']: predicate.terms.map(mango) };
  }
  const path = fieldParts(predicate.field);
  if (path.some((part) => /[.\\$]/.test(part))) throw new ConnectorError('sources.live.unsupported');
  return {
    [predicate.field]: {
      [`$${predicate.op}`]: predicate.value,
      ...(predicate.numeric ? { $type: 'number' } : {}),
    },
  };
}
export function querySql(predicate: Predicate, dialect: 'couchbase' | 'cosmosdb') {
  const parameters: Scalar[] = [];
  const field = (name: string) =>
    dialect === 'cosmosdb'
      ? 'c' +
        fieldParts(name)
          .map((part) => `[${JSON.stringify(part)}]`)
          .join('')
      : name === '_id'
        ? 'META(c).id'
        : 'c.' +
          fieldParts(name)
            .map((part) => '`' + part.replaceAll('`', '``') + '`')
            .join('.');
  const walk = (p: Predicate): string => {
    if ('terms' in p)
      return p.terms.length
        ? '(' + p.terms.map(walk).join(p.op === 'and' ? ' AND ' : ' OR ') + ')'
        : p.op === 'and'
          ? 'true'
          : 'false';
    if (p.missing) {
      if (dialect !== 'cosmosdb' || p.op !== 'eq') throw new ConnectorError('sources.live.unsupported');
      return `NOT IS_DEFINED(${field(p.field)})`;
    }
    parameters.push(p.value);
    const comparison = `${field(p.field)} ${{ eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[p.op]} ${dialect === 'cosmosdb' ? '@p' : '$'}${parameters.length}`;
    return dialect === 'couchbase' && typeof p.value === 'number'
      ? `(ISNUMBER(${field(p.field)}) AND ${comparison})`
      : comparison;
  };
  return { where: walk(predicate), parameters, field };
}

/** Boolean identities keep denied reads empty without contacting the source. */
export function simplify(predicate: Predicate): Predicate {
  if (!('terms' in predicate)) return predicate;
  const terms = predicate.terms.map(simplify);
  const constant = (p: Predicate, op: 'and' | 'or') => p.op === op && 'terms' in p && p.terms.length === 0;
  const absorbing = predicate.op === 'and' ? 'or' : 'and';
  if (terms.some((p) => constant(p, absorbing))) return { op: absorbing, terms: [] };
  const remaining = terms.filter((p) => !constant(p, predicate.op));
  return remaining.length === 1 ? remaining[0]! : { op: predicate.op, terms: remaining };
}
export function never(predicate: Predicate): boolean {
  const reduced = simplify(predicate);
  return reduced.op === 'or' && reduced.terms.length === 0;
}
