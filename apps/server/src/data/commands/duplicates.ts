import {
  AppError,
  readsSourceLive,
  FieldCreate,
  LIMITS,
  idsOf,
  isComputedType,
  newId,
  type CellValues,
  type Command,
  type FieldSpec,
  type GridConfig,
  type ViewMeta,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import { loadField, loadFields, loadViews } from '../metadata.js';
import { currentValues } from '../physical/records.js';
import { writeGuard } from '../permissions/enforce.js';
import { loadDatabaseRules, saveFieldRules, saveRecordRules } from '../permissions/store.js';
import type { StoredField } from '../types.js';
import {
  field,
  invalid,
  publicTable,
  publicField,
  scopeOf,
  table,
  view,
  visibleField,
  type CommandContext,
  type Mutation,
} from './context.js';
import { applyFields, saveField } from './fields.js';
import { computedSpec } from './links.js';
import { requireLinkLimits } from '../link-limits.js';
import { applyMove } from './positions.js';
import { applyRecords } from './records.js';
import { applySchema, createTable } from './schema.js';

/** Materialize nested writes before returning so later writes and access checks see their results. */
async function append(result: Mutation[], mutation: Mutation): Promise<void> {
  const extra = mutation.additional;
  delete mutation.additional;
  result.push(mutation);
  if (extra) for await (const item of extra) await append(result, item);
}

function combined(mutations: Mutation[], output: Record<string, unknown>): Mutation {
  const first = mutations.shift()!;
  return { ...first, additional: mutations, output };
}

/** Remap references in definitions and view configurations, including field IDs used as object keys. */
function remap<T>(value: T, ids: ReadonlyMap<string, string>): T {
  if (typeof value === 'string')
    return (ids.get(value) ??
      value.replace(/(?:fld|tbl|viw|rec)[0-9A-Za-z]{14}/g, (id) => ids.get(id) ?? id)) as T;
  if (Array.isArray(value)) return value.map((item) => remap(item, ids)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [ids.get(key) ?? key, remap(item, ids)]),
    ) as T;
  return value;
}

async function liveIds(c: CommandContext, tableId: string): Promise<string[]> {
  const scope = await scopeOf(c, tableId);
  const result = await query<{ id: string }>(
    c.db,
    sql`SELECT __id AS id FROM ${ident(c.schemas.data, tableId)}
    WHERE __deleted_at IS NULL AND NOT __source_gone AND (${scope.recordPredicate(tableId)}) ORDER BY __rid`,
  );
  return result.rows.map((row) => row.id);
}

async function writable(c: CommandContext, tableId: string, fields: StoredField[]): Promise<StoredField[]> {
  const scope = await scopeOf(c, tableId);
  const out: StoredField[] = [];
  for (const field of scope.visibleFields(tableId, fields)) {
    if (isComputedType(field.type) || field.managed || !scope.canEditField(tableId, field)) continue;
    if (field.type === 'link' && field.options.match) continue;
    if ((field.type === 'link' || field.type === 'lineItems') && field.options.inverseFieldId) {
      const inverse = await loadField(c.db, c.schemas, field.options.inverseFieldId);
      if (inverse && !scope.canEditField(inverse.tableId, inverse)) continue;
    }
    if (field.type === 'link' && field.options.oneWay) {
      try {
        await table(c, field.options.linkedTableId, false, 'editRecords');
      } catch (error) {
        if (!(error instanceof AppError) || !['forbidden', 'not_found'].includes(error.code)) throw error;
        continue;
      }
    }
    out.push(field);
  }
  return out;
}

async function copiedValues(
  c: CommandContext,
  tableId: string,
  fields: StoredField[],
  recordIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const scope = await scopeOf(c, tableId);
  const values = await currentValues(
    c.db,
    c.schemas.data,
    tableId,
    scope.visibleFields(tableId, fields),
    recordIds,
  );
  const out = new Map<string, Record<string, unknown>>();
  for (const id of recordIds) {
    const source = values.get(id) ?? {};
    const copied: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.type !== 'lineItems') {
        copied[field.id] = source[field.id] ?? null;
        continue;
      }
      const children = idsOf(source[field.id] ?? null);
      if (!children.length) {
        copied[field.id] = [];
        continue;
      }
      const columns = await writable(
        c,
        field.options.linkedTableId,
        (await loadFields(c.db, c.schemas, [field.options.linkedTableId])).filter((column) =>
          field.options.columns.some((spec) => spec.id === column.id),
        ),
      );
      const childValues = await copiedValues(c, field.options.linkedTableId, columns, children);
      copied[field.id] = children.map((child) => ({ values: childValues.get(child) ?? {} }));
    }
    out.set(id, copied);
  }
  return out;
}

async function duplicateRecords(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.duplicate' }>,
): Promise<Mutation> {
  c = { ...c, copyCellMetadata: true };
  await table(c, command.tableId);
  const all = await loadFields(c.db, c.schemas, [command.tableId]);
  const guard = writeGuard(c.db, c.schemas, await scopeOf(c, command.tableId), command.tableId, all);
  await guard.requireVisible(command.recordIds);
  const found = await query(
    c.db,
    sql`SELECT __id FROM ${ident(c.schemas.data, command.tableId)}
    WHERE __id = ANY(${command.recordIds}::text[]) AND __deleted_at IS NULL AND NOT __source_gone`,
  );
  if (found.rowCount !== command.recordIds.length) invalid('data.record.missing');
  const target = command.viewId ? (await view(c, command.viewId)).view : undefined;
  if (target && target.tableId !== command.tableId) invalid('data.record.missing');
  const values = await copiedValues(
    c,
    command.tableId,
    await writable(c, command.tableId, all),
    command.recordIds,
  );
  const records = command.recordIds.map((id) => ({ id: newId('record'), values: values.get(id)! }));
  const mutations: Mutation[] = [];
  await append(mutations, await applyRecords(c, { ...command, kind: 'record.create', records }));
  if (target && !target.config.sorts.length && ['grid', 'list', 'gallery', 'kanban'].includes(target.type))
    for (const [index, record] of records.entries())
      await append(
        mutations,
        await applyMove(
          { ...c, copyRecordPlacement: true },
          {
            id: command.id,
            groupId: command.groupId,
            kind: 'record.move',
            tableId: command.tableId,
            viewId: target.id,
            recordIds: [record.id],
            place: { after: command.recordIds[index]! },
          },
        ),
      );
  const createdIds = new Set<string>();
  for (const mutation of mutations)
    if (mutation.body.kind === 'record.created') {
      const body = mutation.body;
      for (const row of body.records) createdIds.add(row.id);
      const parent = await table(c, body.tableId);
      const copied = await query<{ id: string; updatedAt: string; parentId?: string }>(
        c.db,
        sql`SELECT __id AS id, __updated_at::text AS "updatedAt"
        ${parent.lineItems ? sql`, __parent_id AS "parentId"` : sql``}
        FROM ${ident(c.schemas.data, body.tableId)}
        WHERE __id = ANY(${body.records.map((record) => record.id)}::text[])`,
      );
      mutation.prev.copiedRecords = copied.rows;
    }
  for (const mutation of mutations)
    if (
      mutation.body.kind === 'record.updated' &&
      mutation.body.records.every((row) => createdIds.has(row.id))
    )
      mutation.prev.dependent = true;
  return combined(mutations, { recordIds: records.map((record) => record.id) });
}

function copyDefinition(
  source: StoredField,
  id: string,
  name: string,
  ids: Map<string, string>,
): FieldCreate {
  if (source.type === 'lineItems') {
    if (!ids.has(source.options.linkedTableId)) ids.set(source.options.linkedTableId, newId('table'));
    for (const column of source.options.columns) if (!ids.has(column.id)) ids.set(column.id, newId('field'));
  }
  const spec = remap({ type: source.type, options: source.options }, ids) as FieldSpec;
  if (spec.type === 'lineItems') spec.options.inverseFieldId = null;
  if (source.type === 'link' && spec.type === 'link' && !ids.has(source.options.linkedTableId))
    spec.options.inverseFieldId = null;
  return FieldCreate.parse({
    id,
    name,
    description: source.description,
    ...spec,
    ...(source.ai ? { ai: { ...source.ai, prompt: remap(source.ai.prompt, ids) } } : {}),
  });
}

/** New attachment identities retain the stored bytes and previews, with no upload or storage write. */
async function copyAttachments(
  c: CommandContext,
  source: StoredField,
  target: StoredField,
  values: Record<string, unknown>[],
): Promise<void> {
  if (source.type !== 'attachment') return;
  const ids = [...new Set(values.flatMap((row) => idsOf(row[source.id] as never)))];
  const mapping = new Map<string, string>();
  for (const id of ids) {
    const stored = await query<{ storage_key: string }>(
      c.db,
      sql`SELECT storage_key FROM ${ident(c.schemas.app, 'files')} WHERE id = ${id}`,
    );
    if (!stored.rowCount) invalid('data.file.unknown');
    await query(
      c.db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${c.schemas.app}:file:${stored.rows[0]!.storage_key}`}, 0))`,
    );
    const fresh = newId('attachment');
    const inserted = await query(
      c.db,
      sql`INSERT INTO ${ident(c.schemas.app, 'files')}
      (id, org_id, table_id, field_id, name, size, type, width, height, sha256, storage, storage_key,
       thumbnails, created_by, attached_at, scan_state, scan_signature, scan_attempts)
      SELECT ${fresh}, org_id, ${target.tableId}, ${target.id}, name, size, type, width, height, sha256,
        storage, storage_key, thumbnails, ${c.actor.userId}, statement_timestamp(), scan_state, scan_signature, scan_attempts
      FROM ${ident(c.schemas.app, 'files')} WHERE id = ${id} AND field_id = ${source.id} AND org_id = ${c.actor.orgId}`,
    );
    if (!inserted.rowCount) invalid('data.file.unknown');
    mapping.set(id, fresh);
  }
  for (const row of values) row[source.id] = idsOf(row[source.id] as never).map((id) => mapping.get(id)!);
}

async function mapCells(
  c: CommandContext,
  fields: StoredField[],
  targets: StoredField[],
  rows: Record<string, unknown>[],
  ids: ReadonlyMap<string, string>,
): Promise<Record<string, unknown>[]> {
  for (const source of fields) {
    const target = targets.find((field) => field.id === (ids.get(source.id) ?? source.id));
    if (target) await copyAttachments(c, source, target, rows);
  }
  const result: Record<string, unknown>[] = [];
  for (const row of rows) {
    const mapped: Record<string, unknown> = {};
    for (const source of fields) {
      if (!Object.hasOwn(row, source.id)) continue;
      let value = row[source.id];
      if (source.type === 'link')
        value = idsOf(value as never)
          .filter((id) => !c.preview || !ids.has(source.options.linkedTableId) || ids.has(id))
          .map((id) => ids.get(id) ?? id);
      if (source.type === 'lineItems') {
        const target = targets.find((field) => field.id === (ids.get(source.id) ?? source.id));
        if (!target || target.type !== 'lineItems') invalid('data.field.unknown');
        const children = value as Array<{ values: Record<string, unknown> }>;
        if (children.length) {
          const columns = await loadFields(c.db, c.schemas, [source.options.linkedTableId]);
          const targetColumns = await loadFields(c.db, c.schemas, [target.options.linkedTableId]);
          value = (
            await mapCells(
              c,
              columns,
              targetColumns,
              children.map((child) => child.values),
              ids,
            )
          ).map((values) => ({ values }));
        }
      }
      mapped[ids.get(source.id) ?? source.id] = value;
    }
    result.push(mapped);
  }
  return result;
}

async function copyClassification(c: CommandContext, ids: ReadonlyMap<string, string>): Promise<void> {
  for (const [source, target] of ids) {
    const relation = source.startsWith('fld') ? 'fields' : source.startsWith('tbl') ? 'tables' : undefined;
    if (!relation) continue;
    await query(
      c.db,
      sql`UPDATE ${ident(c.schemas.app, relation)} fresh SET classification_label = original.classification_label
      FROM ${ident(c.schemas.app, relation)} original WHERE fresh.id = ${target} AND original.id = ${source}`,
    );
  }
}

async function duplicateField(
  c: CommandContext,
  command: Extract<Command, { kind: 'field.duplicate' }>,
): Promise<Mutation> {
  c = { ...c, copyCellMetadata: true };
  const source = await visibleField(c, command.fieldId);
  const fields = await loadFields(c.db, c.schemas, [source.tableId]);
  const views = await loadViews(c.db, c.schemas, [source.tableId]);
  const mapping = new Map<string, string>();
  const definition = copyDefinition(source, command.newFieldId, command.name, mapping);
  const mutations: Mutation[] = [];
  await append(
    mutations,
    await applyFields(c, { ...command, kind: 'field.create', tableId: source.tableId, field: definition }),
  );
  const next = fields.find((field) => field.position > source.position)?.position ?? source.position + 2;
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'fields')} SET position = ${(source.position + next) / 2} WHERE id = ${command.newFieldId}`,
  );
  const created = await field(c, command.newFieldId);
  mapping.set(source.id, created.id);
  if (mutations[0]!.body.kind === 'field.created') mutations[0]!.body.field.position = created.position;
  for (const view of views) {
    const config: Partial<GridConfig> = {};
    const order = [...view.config.fieldOrder];
    for (const field of fields) if (!order.includes(field.id)) order.push(field.id);
    order.splice(order.indexOf(source.id) + 1, 0, created.id);
    config.fieldOrder = order;
    if (view.config.hiddenFieldIds.includes(source.id))
      config.hiddenFieldIds = [...view.config.hiddenFieldIds, created.id];
    const rules = view.config.colorRules
      .filter((rule) => rule.target === 'cell' && rule.condition.fieldId === source.id)
      .map((rule) => ({
        ...rule,
        id: newId('field'),
        condition: { ...rule.condition, fieldId: created.id },
      }));
    if (rules.length) config.colorRules = [...view.config.colorRules, ...rules];
    for (const key of ['colorScales', 'dataBars', 'iconSets'] as const) {
      const copies = view.config[key]
        .filter((item) => item.fieldId === source.id)
        .map((item) => ({ ...item, fieldId: created.id }));
      if (copies.length) config[key] = [...view.config[key], ...copies] as never[];
    }
    const placement = await applySchema(
      { ...c, copyViewPlacement: true },
      { id: command.id, groupId: command.groupId, kind: 'view.update', viewId: view.id, config },
    );
    placement.prev.copyViewPlacement = { fieldId: created.id };
    await append(mutations, placement);
  }
  if (
    command.withValues &&
    !isComputedType(source.type) &&
    !(source.type === 'link' && source.options.match)
  ) {
    const found = await liveIds(c, source.tableId);
    const ids = c.preview ? found.slice(0, 25) : found;
    const values = await copiedValues(c, source.tableId, [source], ids);
    mapping.set(source.id, created.id);
    const copied = await mapCells(
      c,
      [source],
      [created],
      ids.map((id) => values.get(id)!),
      mapping,
    );
    for (let start = 0; start < ids.length; start += LIMITS.recordsPerCommand)
      await append(
        mutations,
        await applyRecords(c, {
          id: command.id,
          groupId: command.groupId,
          kind: 'record.update',
          tableId: source.tableId,
          records: ids
            .slice(start, start + LIMITS.recordsPerCommand)
            .map((id, index) => ({ id, values: copied[start + index]! })),
        }),
      );
  }
  mapping.set(source.id, created.id);
  if (
    (source.type === 'link' || source.type === 'lineItems') &&
    (created.type === 'link' || created.type === 'lineItems') &&
    source.options.inverseFieldId &&
    created.options.inverseFieldId
  )
    mapping.set(source.options.inverseFieldId, created.options.inverseFieldId);
  await copyClassification(c, mapping);
  const databaseIds = new Set([c.databaseId]);
  for (const id of mapping.keys())
    if (id.startsWith('fld')) {
      const original = await loadField(c.db, c.schemas, id);
      if (original) databaseIds.add((await table(c, original.tableId, false, 'read')).databaseId);
    }
  const rules = {
    fields: (await Promise.all([...databaseIds].map((id) => loadDatabaseRules(c.db, c.schemas, id)))).flatMap(
      (rules) => rules.fields,
    ),
  };
  for (const rule of rules.fields) {
    const targetId = mapping.get(rule.fieldId);
    if (!targetId) continue;
    const target = await field(c, targetId, false, 'editSchema');
    const databaseId = (await table(c, target.tableId, false, 'editSchema')).databaseId;
    await saveFieldRules(
      c.db,
      c.schemas,
      { orgId: c.actor.orgId, databaseId, tableId: target.tableId, fieldId: target.id },
      rule,
      c.actor.userId,
    );
  }
  mutations.push({ body: { kind: 'access.changed' }, prev: { dependent: true } });
  mutations[0]!.prev.schemaCopy = true;
  for (const mutation of mutations)
    if (mutation.body.kind.startsWith('record.') || mutation.body.kind === 'table.created')
      mutation.prev.dependent = true;
  c.scope = new AccessScope(c.db, c.schemas, c.actor);
  return combined(mutations, { fieldId: created.id });
}

async function duplicateTable(
  c: CommandContext,
  command: Extract<Command, { kind: 'table.duplicate' }>,
): Promise<Mutation> {
  c = { ...c, copyCellMetadata: true };
  const source = await table(c, command.tableId);
  if (source.lineItems || (command.withRecords && readsSourceLive(source.source)))
    throw new AppError('forbidden', 'sources.syncedReadOnly');
  const fields = await loadFields(c.db, c.schemas, [source.id]);
  const scope = await scopeOf(c, source.id);
  if (scope.visibleFields(source.id, fields).length !== fields.length)
    throw new AppError('forbidden', 'data.access.denied');
  const views = await loadViews(c.db, c.schemas, [source.id]);
  const rules = await loadDatabaseRules(c.db, c.schemas, c.databaseId);
  const ids = new Map<string, string>([[source.id, command.newTableId]]);
  for (const field of fields) ids.set(field.id, newId('field'));
  for (const view of views) ids.set(view.id, newId('view'));
  const sourceRecords = command.withRecords ? await liveIds(c, source.id) : [];
  // Preview shows a bounded sample; the worker validates every copied row before committing.
  const records = c.preview ? sourceRecords.slice(0, 25) : sourceRecords;
  for (const record of records) ids.set(record, newId('record'));
  for (const field of fields)
    if (field.type === 'lineItems') {
      ids.set(field.options.linkedTableId, newId('table'));
      for (const column of field.options.columns) ids.set(column.id, newId('field'));
    }
  const definitions = fields.map((field) => copyDefinition(field, ids.get(field.id)!, field.name, ids));
  const viewLimits = new Map<string, string>();
  for (const definition of definitions)
    if (
      definition.type === 'link' &&
      definition.options.linkedTableId === command.newTableId &&
      definition.options.limitToViewId
    ) {
      // The mapped views must exist before their limits can be checked against the completed copy.
      viewLimits.set(definition.id, definition.options.limitToViewId);
      delete definition.options.limitToViewId;
    }
  const primary = definitions.findIndex((field) => field.id === ids.get(source.primaryFieldId));
  definitions.unshift(...definitions.splice(primary, 1));
  c = {
    ...c,
    pairedCopyFields: new Set(
      definitions
        .filter((field) => field.type === 'link' && field.options.linkedTableId === command.newTableId)
        .map((field) => field.id),
    ),
  };
  const mutations: Mutation[] = [];
  const firstView = views.find((view) => view.type === 'grid') ?? views[0]!;
  await append(
    mutations,
    await createTable(c, {
      id: command.newTableId,
      name: command.name,
      description: source.description,
      fields: definitions,
      view: { id: ids.get(firstView.id)!, name: firstView.name },
      records: [],
    }),
  );
  c.scope = new AccessScope(c.db, c.schemas, c.actor);
  const targetFields = await loadFields(c.db, c.schemas, [command.newTableId]);
  for (const field of fields)
    if ((field.type === 'lineItems' || field.type === 'link') && field.options.inverseFieldId) {
      const fresh = targetFields.find((item) => item.id === ids.get(field.id))!;
      if ((fresh.type === 'lineItems' || fresh.type === 'link') && fresh.options.inverseFieldId)
        ids.set(field.options.inverseFieldId, fresh.options.inverseFieldId);
    }
  await copyClassification(c, ids);
  const foreignFields: string[] = [];
  const foreignDatabases = new Set<string>();
  for (const mutation of mutations)
    if (mutation.body.kind === 'field.created') {
      const parent = await table(c, mutation.body.field.tableId, false, 'editSchema');
      if (parent.databaseId !== c.databaseId) {
        foreignFields.push(mutation.body.field.id);
        foreignDatabases.add(parent.databaseId);
        mutation.prev.dependent = true;
      }
    }
  for (const databaseId of foreignDatabases)
    rules.fields.push(...(await loadDatabaseRules(c.db, c.schemas, databaseId)).fields);
  await c.copyProgress?.(0, records.length);
  const valueFields = fields.filter(
    (field) =>
      !isComputedType(field.type) && !field.managed && !(field.type === 'link' && field.options.match),
  );
  const links: Array<{ id: string; values: CellValues }> = [];
  const created: Mutation[] = [];
  for (let start = 0; start < records.length; start += LIMITS.recordsPerCommand) {
    const batch = records.slice(start, start + LIMITS.recordsPerCommand);
    const values = await copiedValues(c, source.id, valueFields, batch);
    const mapped = await mapCells(
      c,
      valueFields,
      targetFields,
      batch.map((id) => values.get(id)!),
      ids,
    );
    const rows = batch.map((old, index) => {
      const scalar: Record<string, unknown> = {};
      const edges: CellValues = {};
      for (const field of valueFields) {
        let value = mapped[index]![ids.get(field.id)!];
        if (c.preview && field.type === 'link' && field.options.linkedTableId === source.id)
          value = idsOf(value as never).filter((id) => !sourceRecords.includes(id));
        if (field.type === 'link') edges[ids.get(field.id)!] = value as CellValues[string];
        // New parents already have empty line collections; only populated collections need writes.
        else if (!(field.type === 'lineItems' && Array.isArray(value) && value.length === 0))
          scalar[ids.get(field.id)!] = value;
      }
      const id = ids.get(old)!;
      if (Object.keys(edges).length) links.push({ id, values: edges });
      return { id, values: scalar };
    });
    created.push(
      await applyRecords(
        { ...c },
        {
          id: command.id,
          groupId: command.groupId,
          kind: 'record.create',
          tableId: command.newTableId,
          records: rows,
        },
      ),
    );
    await c.copyProgress?.(Math.min(start + batch.length, records.length), records.length);
  }
  // Line-item links may reach another parent batch, so create every parent before its children.
  for (const mutation of created) {
    await append(mutations, mutation);
    await c.copyProgress?.(records.length, records.length);
  }
  for (let start = 0; start < links.length; start += LIMITS.recordsPerCommand)
    await append(
      mutations,
      await applyRecords(c, {
        id: command.id,
        groupId: command.groupId,
        kind: 'record.update',
        tableId: command.newTableId,
        records: links.slice(start, start + LIMITS.recordsPerCommand),
      }),
    );
  for (const original of views) {
    const config = remap(original.config, ids);
    if (!command.withRecords) config.pinnedRecordIds = [];
    else if (c.preview)
      config.pinnedRecordIds = config.pinnedRecordIds.filter((id) => !sourceRecords.includes(id));
    if (original.id === firstView.id) {
      // The starter view takes the original's type before its type-specific settings are checked.
      await query(
        c.db,
        sql`UPDATE ${ident(c.schemas.app, 'views')} SET type = ${original.type} WHERE id = ${ids.get(original.id)!}`,
      );
      await append(
        mutations,
        await applySchema(c, {
          id: command.id,
          groupId: command.groupId,
          kind: 'view.update',
          viewId: ids.get(original.id)!,
          config,
        }),
      );
    } else
      await append(
        mutations,
        await applySchema(c, {
          id: command.id,
          groupId: command.groupId,
          kind: 'view.create',
          view: {
            id: ids.get(original.id)!,
            tableId: command.newTableId,
            name: original.name,
            type: original.type,
            config,
          },
          position: original.position,
        }),
      );
    if (command.withRecords)
      await query(
        c.db,
        sql`INSERT INTO ${ident(c.schemas.app, 'record_positions')} (view_id, record_id, position)
      SELECT ${ids.get(original.id)!}, mapping.fresh, COALESCE(p.position, source.__rid::numeric)
      FROM ${ident(c.schemas.data, source.id)} source
      JOIN unnest(${records}::text[], ${records.map((id) => ids.get(id)!)}::text[]) AS mapping(old, fresh) ON mapping.old = source.__id
      LEFT JOIN ${ident(c.schemas.app, 'record_positions')} p ON p.record_id = source.__id AND p.view_id = ${original.id}
      WHERE (${scope.recordPredicate(source.id, 'source')})`,
      );
  }
  for (const [fieldId, viewId] of viewLimits) {
    const copied = await field(c, fieldId);
    if (copied.type !== 'link') invalid('data.field.unknown');
    const completed = {
      ...copied,
      ...(await computedSpec(
        c,
        copied.tableId,
        { ...copied, options: { ...copied.options, limitToViewId: viewId } },
        copied.id,
        copied.name,
      )),
    } as StoredField;
    await saveField(c, completed);
    await requireLinkLimits(
      c.db,
      c.schemas.data,
      completed,
      records.map((id) => ids.get(id)!),
    );
  }
  for (const original of rules.fields) {
    const freshId = ids.get(original.fieldId);
    if (!freshId) continue;
    const fresh = await field(c, freshId, false, 'editSchema');
    const databaseId = (await table(c, fresh.tableId, false, 'editSchema')).databaseId;
    await saveFieldRules(
      c.db,
      c.schemas,
      { orgId: c.actor.orgId, databaseId, tableId: fresh.tableId, fieldId: fresh.id },
      original,
      c.actor.userId,
    );
  }
  for (const [originalId, freshId] of ids)
    if (originalId.startsWith('tbl'))
      await saveRecordRules(
        c.db,
        c.schemas,
        { orgId: c.actor.orgId, databaseId: c.databaseId, tableId: freshId },
        rules.records
          .filter((rule) => rule.tableId === originalId)
          .map((rule) => ({ ...remap(rule, ids), id: newId('recordRule') })),
        c.actor.userId,
      );
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'tables')} SET record_lock = ${JSON.stringify(remap(source.recordLock ?? null, ids))}::jsonb,
    allow_computed_overrides = ${source.allowComputedOverrides ?? false}, history_retention_days = ${source.historyRetentionDays ?? 90} WHERE id = ${command.newTableId}`,
  );
  c.scope = new AccessScope(c.db, c.schemas, c.actor);
  const guard = writeGuard(
    c.db,
    c.schemas,
    await scopeOf(c, command.newTableId),
    command.newTableId,
    targetFields,
  );
  await guard.requireWithinRules(records.map((id) => ids.get(id)!));
  if (mutations[0]!.body.kind === 'table.created') {
    mutations[0]!.body.table = publicTable(await table(c, command.newTableId));
    mutations[0]!.body.views = (await loadViews(c.db, c.schemas, [command.newTableId])) as ViewMeta[];
    mutations[0]!.body.fields = (await loadFields(c.db, c.schemas, [command.newTableId])).map(publicField);
  }
  mutations[0]!.prev.schemaCopy = true;
  if (foreignFields.length) mutations[0]!.prev.copyForeignFields = foreignFields;
  for (const mutation of mutations)
    if (mutation.body.kind.startsWith('record.') || mutation.body.kind.startsWith('view.'))
      mutation.prev.dependent = true;
  mutations.push({ body: { kind: 'access.changed' }, prev: { dependent: true } });
  return combined(mutations, { tableId: command.newTableId });
}

export async function applyDuplicate(
  c: CommandContext,
  command: Extract<Command, { kind: 'record.duplicate' | 'field.duplicate' | 'table.duplicate' }>,
): Promise<Mutation> {
  switch (command.kind) {
    case 'record.duplicate':
      return duplicateRecords(c, command);
    case 'field.duplicate':
      return duplicateField(c, command);
    case 'table.duplicate':
      return duplicateTable(c, command);
  }
}
