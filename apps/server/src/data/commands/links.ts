import { createLineTable } from './line-items.js';
import { readNamedFunctions } from '../named-functions.js';
import { selectSpec } from './select-options.js';
import { validateConditional } from './conditional.js';
import { relationalConditions } from '../physical/conditional.js';
import { formulaSpec, readsBack } from '../physical/formulas.js';
import {
  AppError,
  LIMITS,
  newId,
  resolveTemplate,
  templateScheme,
  type FieldSpec,
  FieldCreate,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { loadField, loadTable, loadFields, loadTables, loadView } from '../metadata.js';
import { resultType, rollupType } from '../physical/relations.js';
import type { StoredField } from '../types.js';
import {
  field,
  invalid,
  nextPosition,
  publicField,
  table,
  visibleField,
  visibleFieldsOf,
  scopeOf,
  type CommandContext,
  type Mutation,
} from './context.js';
import { insertField, saveField } from './fields.js';
import { mirrored } from './matches.js';
import { requireOwnPublicFields } from './public-pages.js';

export async function computedSpec(
  c: CommandContext,
  tableId: string,
  spec: FieldSpec,
  id: string,
  name?: string,
): Promise<FieldSpec> {
  if (spec.type === 'singleSelect' || spec.type === 'multipleSelect') return selectSpec(c, tableId, spec, id);
  // A person can only build on fields they can see: one they can't reads as unknown.
  if (spec.type === 'formula') {
    const tables = await loadTables(c.db, c.schemas, c.databaseId);
    const scope = await scopeOf(c, tableId);
    for (const table of tables) await scope.ensureTable(table.id);
    const fields = await loadFields(
      c.db,
      c.schemas,
      tables.map((item) => item.id),
    );
    const readable = tables.flatMap((item) =>
      scope
        .visibleFields(
          item.id,
          fields.filter((field) => field.tableId === item.id),
        )
        .map((field) => ({ ...field, tableName: item.name, dataSchema: c.schemas.data })),
    );
    return formulaSpec(
      spec,
      id,
      readable,
      name,
      tableId,
      await readNamedFunctions(c.db, c.schemas, c.databaseId, scope),
    );
  }
  if (spec.type === 'button') return buttonSpec(spec, await visibleFieldsOf(c, tableId), id);
  if (spec.type === 'link') {
    if (spec.options.filter && spec.options.limitToViewId) invalid('errors.validationFailed');
    if (spec.options.match && (spec.options.filter || spec.options.limitToViewId))
      invalid('errors.validationFailed');
    await validateConditional(c, tableId, spec.options.linkedTableId, spec, id);
    for (const fieldId of spec.options.displayFieldIds ?? []) {
      const target = await visibleField(c, fieldId, false, 'read');
      if (target.tableId !== spec.options.linkedTableId || target.id === id) invalid('data.field.unknown');
    }
    if (spec.options.limitToViewId) {
      const view = await loadView(c.db, c.schemas, spec.options.limitToViewId);
      if (!view || view.trashed || view.view.tableId !== spec.options.linkedTableId)
        invalid('data.link.limitUnavailable');
      await table(c, view.view.tableId, false, 'read');
      // The choices follow the view's filter, so a field it reads has to be one the person can
      // see, as a field in the link's own filter does.  A condition on a field that's gone offers
      // no choices at all, so it has nothing to tell.
      for (const condition of relationalConditions(view.view.config.filter ?? undefined)) {
        const read = await loadField(c.db, c.schemas, condition.fieldId);
        if (read && !read.trashed) await visibleField(c, read.id, false, 'read');
      }
    }
  }
  if (spec.type === 'link' && spec.options.match) {
    await visibleField(c, spec.options.match.fieldId);
    await visibleField(c, spec.options.match.linkedFieldId, false, 'read');
  }
  if (spec.type !== 'lookup' && spec.type !== 'rollup' && spec.type !== 'count') return spec;
  const link = await visibleField(c, spec.options.linkFieldId);
  if ((link.type !== 'link' && link.type !== 'lineItems') || link.tableId !== tableId || link.id === id)
    invalid('data.field.unknown');
  await validateConditional(c, tableId, link.options.linkedTableId, spec, id);
  if (spec.type === 'count') return spec;
  const target = await visibleField(c, spec.options.targetFieldId, false, 'read');
  if (target.tableId !== link.options.linkedTableId || target.id === id) invalid('data.field.unknown');
  // A button holds nothing to look up or roll up.
  if (target.type === 'button') invalid('data.field.buttonTarget');
  const seen = new Set([id]);
  const check = async (f: StoredField): Promise<void> => {
    if (seen.has(f.id)) invalid('errors.validationFailed');
    if (f.type !== 'lookup' && f.type !== 'rollup') return;
    seen.add(f.id);
    await check(await field(c, f.options.targetFieldId, false, 'read'));
    seen.delete(f.id);
  };
  await check(target);
  // A formula elsewhere that reads this field back makes a loop, as a formula reading itself would,
  // and so does an AI field whose prompt reads it.
  const loop = readsBack([target], id, await loadFields(c.db, c.schemas, [tableId]));
  if (loop) invalid(loop === 'aiField' ? 'aiFields.loop' : 'formula.field.circular');
  if (spec.type === 'lookup')
    return { ...spec, options: { ...spec.options, resultType: resultType(target) } };
  const type = resultType(target);
  if (
    (['sum', 'average'].includes(spec.options.fn) && type !== 'number') ||
    (['and', 'or'].includes(spec.options.fn) && type !== 'boolean') ||
    (['earliest', 'latest'].includes(spec.options.fn) && type !== 'date' && type !== 'datetime')
  )
    invalid('errors.validationFailed');
  return { ...spec, options: { ...spec.options, resultType: rollupType(spec.options.fn, target) } };
}

/**
 * A button's options with the fields its link names stored by ID.  A name that matches no other
 * field of the table is refused, and so is a link that could never be `http` or `https`.
 */
export function buttonSpec(
  spec: Extract<FieldSpec, { type: 'button' }>,
  fields: ReadonlyArray<{ id: string; name: string }>,
  id: string,
) {
  if (spec.options.action.kind !== 'openUrl') return spec;
  const { urlTemplate } = spec.options.action;
  if (!templateScheme(urlTemplate)) invalid('data.field.buttonLink');
  const resolved = resolveTemplate(
    urlTemplate,
    fields.filter((field) => field.id !== id),
  );
  if ('unknown' in resolved)
    throw new AppError('validation_failed', 'data.field.buttonField', { params: { name: resolved.unknown } });
  return {
    ...spec,
    options: { ...spec.options, action: { ...spec.options.action, urlTemplate: resolved.template } },
  };
}

export async function createPair(c: CommandContext, source: StoredField): Promise<Mutation[]> {
  if (source.type !== 'link' && source.type !== 'lineItems') return [];
  const child = source.type === 'lineItems' ? await createLineTable(c, source) : undefined;
  const parent = await table(c, source.tableId);
  const oneWay = source.type === 'link' && source.options.oneWay === true;
  const copied = oneWay ? c.copiedLinkFields?.get(source.id) : undefined;
  const action = copied === 'readable' ? 'read' : oneWay ? 'editRecords' : 'editSchema';
  // A duplicate retains an empty relation without reading the destination's fields or records.
  const linked =
    copied === 'unavailable'
      ? await loadTable(c.db, c.schemas, source.options.linkedTableId)
      : await table(c, source.options.linkedTableId, false, action);
  if (!linked || linked.orgId !== c.actor.orgId || linked.trashed) return [];
  if (copied !== 'unavailable') {
    const scope = await scopeOf(c, linked.id);
    await scope.require(linked.databaseId, action);
    await visibleField(c, linked.primaryFieldId, false, 'read');
  }
  if (c.pairedCopyFields?.has(source.id)) {
    const existing = await query(
      c.db,
      sql`SELECT id FROM ${ident(c.schemas.app, 'links')}
      WHERE left_field_id = ${source.id} OR right_field_id = ${source.id}`,
    );
    if (existing.rowCount) return [];
  }
  const fields = oneWay ? [] : await loadFields(c.db, c.schemas, [linked.id]);
  if (!oneWay && fields.length >= LIMITS.fieldsPerTable) invalid('data.field.tooMany');
  const used = new Set(fields.map((f) => f.name.toLowerCase()));
  let name = parent.name;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = parent.name.slice(0, LIMITS.nameLength - suffix.length) + suffix;
  }
  const match = source.type === 'link' ? mirrored(source.options.match) : undefined;
  let inverse: FieldCreate = {
    id: c.plannedInverseFieldIds?.get(source.id) ?? newId('field'),
    name,
    description: '',
    type: 'link',
    options: {
      linkedTableId: parent.id,
      inverseFieldId: source.id,
      prefersSingle: source.type === 'lineItems',
      ...(match ? { match } : {}),
    },
  };
  const reused =
    c.pairedCopyFields?.has(source.id) && source.options.inverseFieldId
      ? fields.find((field) => field.id === source.options.inverseFieldId)
      : undefined;
  if (reused) inverse = FieldCreate.parse(reused);
  else if (!oneWay) await insertField(c, linked.id, inverse, await nextPosition(c, 'field', linked.id));
  await saveField(
    c,
    source.type === 'lineItems'
      ? { ...source, options: { ...source.options, inverseFieldId: inverse.id } }
      : { ...source, options: { ...source.options, inverseFieldId: oneWay ? null : inverse.id } },
  );

  const linkId = newId('field');
  await query(
    c.db,
    sql`INSERT INTO ${ident(c.schemas.app, 'links')}
    (id, org_id, left_table_id, left_field_id, right_table_id, right_field_id)
    VALUES (${linkId}, ${c.actor.orgId}, ${parent.id}, ${source.id}, ${linked.id}, ${oneWay ? null : inverse.id})`,
  );
  await query(
    c.db,
    sql`CREATE TABLE ${ident(c.schemas.data, `lnk_${linkId}`)} (
    left_rid bigint NOT NULL REFERENCES ${ident(c.schemas.data, parent.id)} (__rid) ON DELETE CASCADE,
    right_rid bigint NOT NULL REFERENCES ${ident(c.schemas.data, linked.id)} (__rid) ON DELETE CASCADE,
    left_pos double precision NOT NULL, right_pos double precision NOT NULL,
    PRIMARY KEY (left_rid, right_rid))`,
  );
  await query(
    c.db,
    sql`CREATE INDEX ${ident(`lnk_${linkId}_right`)}
    ON ${ident(c.schemas.data, `lnk_${linkId}`)} (right_rid)`,
  );
  // A converted one-way field can have older junctions kept for undo under the same field ID.
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} SET link_id = ${linkId}
    WHERE id = ANY(${oneWay ? [source.id] : [source.id, inverse.id]}::text[])`,
  );
  // The other side is a new field of its own table, where a link sharing every field shows it.
  if (!oneWay && !reused) await requireOwnPublicFields(c, [{ id: inverse.id, tableId: linked.id }]);
  return [
    ...(child ? [child] : []),
    ...(oneWay || reused
      ? []
      : [
          {
            body: {
              kind: 'field.created' as const,
              field: publicField(await field(c, inverse.id, false, 'read')),
              views: [],
            },
            prev: { dependent: true },
          },
        ]),
  ];
}

export async function conversionPrimary(c: CommandContext, tableId: string): Promise<StoredField> {
  await table(c, tableId, false, 'read');
  const scope = await scopeOf(c, tableId);
  const primary = await primaryField(c.db, c.schemas, tableId);
  const visible = scope.visibleFields(tableId, [primary])[0];
  if (!visible) invalid('data.field.unknown');
  return visible;
}

export async function primaryField(
  db: CommandContext['db'],
  schemas: CommandContext['schemas'],
  tableId: string,
): Promise<StoredField> {
  const parent = await loadTable(db, schemas, tableId);
  const primary = parent && (await loadField(db, schemas, parent.primaryFieldId));
  if (!primary) invalid('data.field.unknown');
  return primary;
}
