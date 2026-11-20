import type { Sort } from '@riosoma/contracts';
import { ident, join, keyword, sql, type Sql } from '@riosoma/db';
import type { ReadContext, StoredField } from '../types.js';
import { linkNamesExpr, resultType } from './relations.js';
import { attachmentNames } from '../files/expressions.js';
import { columnRef, SYSTEM } from './columns.js';
import { formulaScalar } from './formulas.js';

export function sortExpression(
  field: StoredField,
  ctx: ReadContext,
  dataSchema: string,
  appSchema?: string,
): Sql {
  if (field.type === 'changeLog') return sql`NULL::text`;
  field = { ...field, readContext: ctx };
  const col = field.type === 'formula' ? formulaScalar(field, undefined, ctx) : columnRef(field);
  const text = (value: Sql) =>
    ctx.natural
      ? sql`NULLIF(${value}, '') COLLATE ${ident(dataSchema, 'rio_natural')}`
      : sql`NULLIF(${value}, '')`;
  if (field.type === 'link' || field.type === 'lineItems') return text(linkNamesExpr(field, undefined, true));
  if (
    field.type === 'lookup' ||
    field.type === 'rollup' ||
    field.type === 'count' ||
    field.type === 'formula'
  ) {
    const type = resultType(field);
    const value = field.type === 'lookup' || type === 'array' ? sql`(${col} ->> 0)` : col;
    if (type === 'number') return sql`(${value})::numeric`;
    if (type === 'boolean') return sql`(${value})::boolean`;
    if (type === 'date') return sql`(${value})::date`;
    if (type === 'datetime') return sql`(${value})::timestamptz`;
    return text(value);
  }
  switch (field.type) {
    case 'multiCurrency':
      return sql`(${col} -> 'code') || (${col} -> 'amount')`;
    case 'barcode':
      return text(col);
    case 'attachment':
      return text(attachmentNames(appSchema, field, col, true));
    case 'text':
    case 'longText':
    case 'email':
    case 'url':
    case 'phone':
    case 'recordId':
      return text(col);
    case 'singleSelect':
      return (
        field.selectRead?.rank(col) ??
        sql`array_position(${field.options.choices.map((c) => c.id)}::text[], ${col})`
      );
    case 'multipleSelect':
      return (
        field.selectRead?.rank(sql`(${col})[1]`) ??
        sql`array_position(${field.options.choices.map((c) => c.id)}::text[], (${col})[1])`
      );
    case 'checkbox':
      return sql`(${col} IS TRUE)`;
    case 'user':
      if (!appSchema) throw new Error('People sorts require the app schema');
      return text(sql`(SELECT u.name FROM ${ident(appSchema, 'users')} u WHERE u.id = (${col})[1])`);
    case 'createdBy':
    case 'lastModifiedBy':
      if (!appSchema) throw new Error('People sorts require the app schema');
      return text(sql`(SELECT u.name FROM ${ident(appSchema, 'users')} u WHERE u.id = ${col})`);
    // Ranges sort by the moment they start.
    case 'dateRange':
      return sql`lower(${col})`;
    case 'json':
      return text(col);
    // As the grid shows them: the label, or the coordinates when there's none.
    case 'location':
      return text(
        sql`COALESCE(NULLIF(${col} ->> 'label', ''), (${col} ->> 'lat') || ', ' || (${col} ->> 'lng'))`,
      );
    // UTC instants in one fixed layout sort as bytes in the order they happened.
    case 'signature':
      return sql`((${col} ->> 'signedAt') COLLATE "C")`;
    default:
      return col;
  }
}

/** An ORDER BY list, without the clause keyword, suitable for queries and aggregates. */
export function compileOrder(
  sorts: readonly Sort[],
  fields: ReadonlyMap<string, StoredField>,
  ctx: ReadContext,
  dataSchema: string,
  appSchema?: string,
): Sql {
  const order: Sql[] = [];
  for (const sort of sorts) {
    const field = fields.get(sort.fieldId);
    // A button holds nothing to sort by.
    if (field && field.type !== 'button' && field.type !== 'changeLog')
      order.push(sql`${sortExpression(field, ctx, dataSchema, appSchema)}
      ${keyword(sort.direction === 'desc' ? 'DESC' : 'ASC')} NULLS LAST`);
  }
  const rid = ident(SYSTEM.rid);
  // Simulated inserts must follow saved rows and retain the order approval will assign them.
  order.push(
    ctx.simulatedRids
      ? sql`(${rid} < 0) ASC, CASE WHEN ${rid} < 0 THEN -${rid} ELSE ${rid} END ASC`
      : sql`${rid} ASC`,
  );
  return join(order, ', ');
}
