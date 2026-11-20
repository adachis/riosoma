import {
  AppError,
  cellValue,
  checkCellValue,
  isComputedType,
  idsOf,
  roleAllows,
  withDefaults,
  type CellValue,
  type LinkChoicesPage,
  type LinkChoicesRequest,
} from '@riosoma/contracts';
import { ident, join, query, sql, type Queryable } from '@riosoma/db';
import type { AccessScope } from './access.js';
import type { DataSchemas } from './context.js';
import { fieldMeta, loadField, loadFields, loadTable } from './metadata.js';
import { linkLimitPredicate } from './link-limits.js';
import { columnRef, columnType, jsonValueExpr } from './physical/columns.js';
import { choiceName, displayExpr, linkNamesExpr } from './physical/relations.js';
import type { StoredField } from './types.js';
import { fetchRowsById } from './physical/records.js';
import { readsSourceLive } from '@riosoma/contracts';
import { resolveSelectOptions } from './select-options.js';
import { prepareJoinedRead } from '../sources/joined-live.js';
import type { AppContext } from '../app.js';

const missing = () => new AppError('not_found', 'errors.notFound');

function draftFields(fields: readonly StoredField[], draft: ReadonlyMap<string, CellValue>) {
  const own = new Map(fields.map((field) => [field.id, field]));
  const resolved = new Map<string, StoredField>();
  const resolve = (field: StoredField): StoredField => {
    field = own.get(field.id) ?? field;
    if (!own.has(field.id)) return field;
    const cached = resolved.get(field.id);
    if (cached) return cached;
    const result = { ...field };
    resolved.set(field.id, result);
    const linkId =
      field.type === 'link'
        ? field.id
        : field.type === 'count' || field.type === 'lookup' || field.type === 'rollup'
          ? field.options.linkFieldId
          : undefined;
    if (field.relation)
      result.relation = {
        ...field.relation,
        ...(linkId && draft.has(linkId)
          ? { draft: { alias: 'source', ids: idsOf(draft.get(linkId) ?? null) } }
          : {}),
        conditionFields: field.relation.conditionFields?.map(resolve),
      };
    if (field.formula) result.formula = { ...field.formula, fields: field.formula.fields.map(resolve) };
    return result;
  };
  fields.forEach(resolve);
  return resolved;
}

function searchText(field: StoredField) {
  if (field.type === 'singleSelect')
    return sql`COALESCE(${choiceName(field, columnRef(field, 'target'))}, '')`;
  if (field.type === 'multipleSelect')
    return sql`COALESCE((SELECT string_agg(${choiceName(field, sql`chosen.id`)}, ', ')
    FROM unnest(${columnRef(field, 'target')}) chosen(id)), '')`;
  if (field.type === 'link') return sql`COALESCE(${linkNamesExpr(field, 'target')}, '')`;
  return displayExpr(field, 'target');
}

export async function linkChoices(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  fieldId: string,
  input: LinkChoicesRequest,
  context?: AppContext,
): Promise<LinkChoicesPage> {
  const link = await loadField(db, schemas, fieldId);
  if (!link || link.trashed || link.type !== 'link') throw missing();
  const source = await loadTable(db, schemas, link.tableId);
  const target = await loadTable(db, schemas, link.options.linkedTableId);
  if (!source || source.trashed || !target || target.trashed) throw missing();
  await scope.require(source.databaseId, 'read');
  if (!scope.visibleFields(source.id, [link]).length) throw missing();
  const role = await scope.require(target.databaseId, 'read');
  if (context) await prepareJoinedRead(context, scope, target);
  if (readsSourceLive(target.source)) throw new AppError('validation_failed', 'sources.live.viewUnsupported');
  const fields = await loadFields(db, schemas, [...new Set([source.id, target.id])]);
  const ownFields = scope.visibleFields(
    source.id,
    fields.filter((field) => field.tableId === source.id),
  );
  const visible = await resolveSelectOptions(
    db,
    schemas,
    scope,
    scope.visibleFields(
      target.id,
      fields.filter((field) => field.tableId === target.id),
    ),
  );
  const primary = visible.find((field) => field.id === target.primaryFieldId);
  if (!primary) throw missing();
  let draft = new Map<string, CellValue>();
  for (const [id, value] of Object.entries(input.values ?? {})) {
    const field = ownFields.find((field) => field.id === id);
    if (!field) throw missing();
    if (isComputedType(field.type)) continue;
    const checked = checkCellValue(field, value);
    if (!checked.ok) throw new AppError('validation_failed', checked.messageKey);
    draft.set(id, checked.value);
  }
  if (input.recordId) {
    const record = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.data, source.id)} source
      WHERE source.__id = ${input.recordId} AND source.__deleted_at IS NULL AND NOT source.__source_gone
        AND (${scope.recordPredicate(source.id, 'source')})`,
    );
    if (!record.rows.length) throw missing();
  }
  if (!input.recordId && !source.source && !source.joined)
    draft = new Map(
      Object.entries(
        withDefaults(
          ownFields.filter((field) => !field.managed),
          Object.fromEntries(draft),
          Object.fromEntries(draft),
          { now: new Date(), userId: scope.actor.kind === 'guest' ? null : scope.actor.userId },
        ),
      ),
    );
  // Overlay physical inputs before computing formulas, including nested formulas and defaults.
  const overlay = ownFields.flatMap((field) =>
    columnType(field) && draft.has(field.id)
      ? [
          sql`(${field.columnName}::text, to_jsonb(${jsonValueExpr(field, sql`${JSON.stringify(draft.get(field.id))}::jsonb`)}))`,
        ]
      : [],
  );
  const currentSource = sql`CROSS JOIN LATERAL jsonb_populate_record(
    ${input.recordId ? sql`saved` : sql`NULL::${ident(schemas.data, source.id)}`},
    ${overlay.length ? sql`(SELECT jsonb_object_agg(inputs.name, inputs.value) FROM (VALUES ${join(overlay, ', ')}) inputs(name, value))` : sql`'{}'::jsonb`}) source`;
  const currentFields = draftFields(ownFields, draft);
  const predicate = await linkLimitPredicate(db, schemas, link, fields, 'target', (field) =>
    columnRef(currentFields.get(field.id) ?? field, 'source'),
  );
  const searchable = [
    primary,
    ...(link.options.displayFieldIds ?? []).flatMap((id) => {
      const field = visible.find((field) => field.id === id);
      return field ? [field] : [];
    }),
  ];
  const limit = input.limit ?? 100;
  const names = await query<{ id: string; name: string }>(
    db,
    sql`
    SELECT target.__id AS id, ${displayExpr(primary, 'target')} AS name
    FROM ${ident(schemas.data, target.id)} target
    ${input.recordId ? sql`CROSS JOIN ${ident(schemas.data, source.id)} saved` : sql``}
    ${currentSource}
    WHERE target.__deleted_at IS NULL AND NOT target.__source_gone
      AND (${scope.recordPredicate(target.id, 'target')}) AND (${predicate})
      ${input.recordId ? sql`AND saved.__id = ${input.recordId}` : sql``}
      AND (${join(
        searchable.map((field) => sql`strpos(lower(${searchText(field)}), lower(${input.query ?? ''})) > 0`),
        ' OR ',
      )})
    ORDER BY target.__updated_at DESC, target.__rid DESC LIMIT ${limit + 1} OFFSET ${input.offset ?? 0}`,
  );
  const page = names.rows.slice(0, limit);
  const rows = await fetchRowsById(
    db,
    schemas.data,
    target.id,
    visible,
    page.map((row) => row.id),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    records: page.map(({ id, name }) => ({
      id,
      name,
      values: Object.fromEntries(
        visible.map((field) => [field.id, byId.get(id) ? cellValue(byId.get(id)!, field) : null]),
      ),
      ...(byId.get(id)?.selectChoices ? { selectChoices: byId.get(id)!.selectChoices } : {}),
    })),
    fields: visible.map(fieldMeta),
    hasMore: names.rows.length > limit,
    canCreate:
      !target.source &&
      !target.joined &&
      roleAllows(role, 'editRecords') &&
      !isComputedType(primary.type) &&
      scope.canEditField(target.id, primary) &&
      !link.options.match,
  };
}
