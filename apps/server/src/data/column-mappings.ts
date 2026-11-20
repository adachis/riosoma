import { message } from '../api-v1/messages.js';
import {
  AppError,
  joinedFieldSpec,
  mappedFieldSpec,
  type ColumnSuggestions,
  type ColumnSuggestionsRequest,
  type ColumnSuggestion,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { Budget, JOIN_LIMITS, nameWords, type JoinLimits } from './joins.js';
import { loadTables, loadFields } from './metadata.js';
import { isMatchable, matchKey } from './physical/matches.js';
import { selectExpr } from './physical/columns.js';
import type { StoredField } from './types.js';

const abbreviations: Record<string, string> = {
  cust: 'customer',
  prod: 'product',
  addr: 'address',
  qty: 'quantity',
  desc: 'description',
  tel: 'phone',
  zip: 'postal',
  fname: 'firstname',
  lname: 'lastname',
};
function comparable(field: StoredField, value: unknown): string {
  const spec = joinedFieldSpec(field);
  const text = String(value);
  if (['number', 'currency', 'percent', 'rating', 'duration'].includes(spec.type)) {
    const decimal = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
    if (decimal) {
      const integer = decimal[2]!.replace(/^0+(?=\d)/, '');
      const fraction = decimal[3]?.replace(/0+$/, '');
      return `${integer === '0' && !fraction ? '' : decimal[1]}${integer}${fraction ? `.${fraction}` : ''}`;
    }
  }
  if (spec.type === 'date') {
    const instant = Date.parse(text);
    if (Number.isFinite(instant)) return new Date(instant).toISOString();
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return text;
}

export function columnName(name: string): string {
  const words = nameWords(name).map((word) => abbreviations[word] ?? word);
  if (words.join('') === 'sku' || words.join('') === 'productcode') return 'productcode';
  return words.join('');
}

/** Compare values on the joined rows, rather than treating coincidental overlap as correspondence. */
export async function suggestColumns(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  databaseId: string,
  input: ColumnSuggestionsRequest,
  limits: JoinLimits = JOIN_LIMITS,
): Promise<ColumnSuggestions> {
  const started = Date.now();
  const budget = new Budget(db, limits, started);
  const ids = [input.baseTableId, ...input.steps.map((step) => step.tableId)];
  const tables = await loadTables(db, schemas, databaseId);
  if (new Set(ids).size !== ids.length || ids.some((id) => !tables.some((table) => table.id === id)))
    throw new AppError('validation_failed', 'joined.invalid');
  const all = await loadFields(db, schemas, ids);
  const fields = ids.flatMap((id) =>
    scope.visibleFields(
      id,
      all.filter((field) => field.tableId === id),
    ),
  );
  const byId = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set([input.baseTableId]);
  for (const step of input.steps) {
    const left = byId.get(step.leftFieldId);
    const right = byId.get(step.rightFieldId);
    if (
      !seen.has(step.leftTableId) ||
      left?.tableId !== step.leftTableId ||
      right?.tableId !== step.tableId ||
      !isMatchable(left.type) ||
      !isMatchable(right.type)
    )
      throw new AppError('validation_failed', 'joined.invalid');
    seen.add(step.tableId);
  }
  const share = Math.floor(limits.maxFields / ids.length);
  const selected = ids.flatMap((id) =>
    fields
      .filter(
        (field) =>
          field.tableId === id &&
          !['button', 'changeLog', 'attachment', 'signature', 'json', 'link', 'lineItems', 'lookup'].includes(
            field.type,
          ),
      )
      .slice(0, share),
  );
  const suggestions: Array<Omit<ColumnSuggestion, 'explanation'>> = input.steps.map((step) => ({
    sources: [
      { tableId: step.leftTableId, fieldId: step.leftFieldId },
      { tableId: step.tableId, fieldId: step.rightFieldId },
    ],
    confidence: 1,
    reason: { messageKey: 'joined.mapping.keys' },
    matchingRows: 0,
    agreement: 1,
  }));
  const keyPairs = new Set(
    suggestions.map((item) =>
      item.sources
        .map((source) => source.fieldId)
        .sort()
        .join('|'),
    ),
  );
  const pairs: Array<[StoredField, StoredField]> = [];
  for (const [index, left] of selected.entries())
    for (const right of selected.slice(index + 1)) {
      if (
        left.tableId === right.tableId ||
        columnName(left.name) !== columnName(right.name) ||
        !mappedFieldSpec([left, right]) ||
        keyPairs.has([left.id, right.id].sort().join('|'))
      )
        continue;
      pairs.push([left, right]);
    }
  const finish = (): ColumnSuggestions => ({
    suggestions: suggestions.map((item) => ({
      ...item,
      explanation: message(item.reason.messageKey, item.reason.params),
    })),
    profiledFields: selected.length,
    ms: Date.now() - started,
  });
  if (!pairs.length) return finish();
  const sampled = [...new Map(pairs.flat().map((field) => [field.id, field])).values()];
  const alias = (id: string) => `mapping_side${ids.indexOf(id)}`;
  // Limit each input and the joined result, and share discovery's statement and wall-clock budget.
  const side = (id: string) => sql`(SELECT * FROM ${ident(schemas.data, id)} t
    WHERE t.__deleted_at IS NULL AND NOT t.__source_gone AND (${scope.recordPredicate(id, 't')})
    ORDER BY t.__rid LIMIT ${limits.sampleRows}) ${ident(alias(id))}`;
  let from = side(input.baseTableId);
  for (const step of input.steps) {
    const kind =
      step.kind === 'inner' ? sql`INNER JOIN` : step.kind === 'left' ? sql`LEFT JOIN` : sql`FULL JOIN`;
    from = sql`${from} ${kind} ${side(step.tableId)} ON
      ${matchKey(byId.get(step.leftFieldId)!, alias(step.leftTableId))} =
      ${matchKey(byId.get(step.rightFieldId)!, alias(step.tableId))}`;
  }
  const result = await budget.run(() =>
    query<Record<string, unknown>>(
      db,
      sql`SELECT ${join(
        [
          ...ids.map((id) => sql`${ident(alias(id), '__id')} AS ${ident(id)}`),
          ...sampled.map(
            (field) => sql`CASE WHEN ${ident(alias(field.tableId), '__id')} IS NULL THEN NULL
            ELSE ${selectExpr(field, alias(field.tableId))} END AS ${ident(field.id)}`,
          ),
        ],
        ', ',
      )}
    FROM ${from} LIMIT ${limits.sampleRows}`,
    ),
  );
  for (const [left, right] of pairs) {
    if (budget.left <= 0) break;
    let both = 0;
    let same = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    const filled = (value: unknown) =>
      value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
    for (const row of result?.rows ?? []) {
      if (budget.left <= 0) return finish();
      const a = row[left.id];
      const b = row[right.id];
      if (filled(a) && filled(b)) {
        both++;
        if (comparable(left, a) === comparable(right, b)) same++;
      } else if (filled(a) && row[right.tableId] === null) leftOnly++;
      else if (filled(b) && row[left.tableId] === null) rightOnly++;
    }
    const agreement = both ? same / both : 0;
    const complementary =
      !both && leftOnly > 0 && rightOnly > 0 && input.steps.some((step) => step.kind === 'full');
    if (!(both >= 3 && agreement >= 0.98) && !complementary) continue;
    suggestions.push({
      sources: [left, right].map((field) => ({ tableId: field.tableId, fieldId: field.id })),
      confidence: complementary ? 0.9 : agreement,
      reason: complementary
        ? { messageKey: 'joined.mapping.complementary' }
        : { messageKey: 'joined.mapping.agreement', params: { percent: Math.round(agreement * 100) } },
      matchingRows: both,
      agreement,
    });
  }
  return finish();
}
