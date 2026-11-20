import {
  AppError,
  Command,
  FieldCreate,
  idsOf,
  isPrimaryType,
  LIMITS,
  newId,
  RecordId,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { AccessScope } from '../access.js';
import { loadFields, loadTable } from '../metadata.js';
import { writeGuard } from '../permissions/enforce.js';
import { requireUnlockedRecordsInScope } from '../record-locks.js';
import type { StoredField, StoredTable } from '../types.js';
import { invalid, publicTable, scopeOf, type CommandContext, type Mutation } from './context.js';
import { createTable } from './schema.js';
import { applyRecords } from './records.js';

type Lines = Extract<StoredField, { type: 'lineItems' }>;

export async function createLineTable(c: CommandContext, source: Lines): Promise<Mutation | undefined> {
  if (c.restoredLineTables?.has(source.options.linkedTableId)) {
    const child = await loadTable(c.db, c.schemas, source.options.linkedTableId);
    if (
      !child ||
      child.databaseId !== c.databaseId ||
      child.lineItems?.parentTableId !== source.tableId ||
      child.lineItems.parentFieldId !== source.id
    )
      invalid('errors.validationFailed');
    c.scope = new AccessScope(c.db, c.schemas, c.actor);
    return;
  }
  const columns = source.options.columns.map((column) => FieldCreate.parse(column));
  if (!columns.length) invalid('errors.validationFailed');
  const parent = await loadTable(c.db, c.schemas, source.tableId);
  if (!parent || parent.lineItems || parent.source || parent.joined) invalid('errors.validationFailed');
  const fields = isPrimaryType(columns[0]!.type)
    ? columns
    : [FieldCreate.parse({ id: newId('field'), name: source.id, type: 'recordId' }), ...columns];
  const mutation = await createTable(c, {
    id: source.options.linkedTableId,
    name: `${parent.name.slice(0, 100)} / ${source.id}`,
    description: '',
    fields,
    records: [],
    view: { id: newId('view'), name: source.id },
  });
  const ownership = { parentTableId: source.tableId, parentFieldId: source.id };
  await query(
    c.db,
    sql`UPDATE ${ident(c.schemas.app, 'tables')}
    SET line_items = ${JSON.stringify(ownership)}::jsonb WHERE id = ${source.options.linkedTableId}`,
  );
  await query(
    c.db,
    sql`ALTER TABLE ${ident(c.schemas.data, source.options.linkedTableId)}
    ADD COLUMN __parent_id text REFERENCES ${ident(c.schemas.data, source.tableId)} (__id) ON DELETE CASCADE`,
  );
  await query(
    c.db,
    sql`CREATE INDEX ${ident(`${source.options.linkedTableId}_parent`)}
    ON ${ident(c.schemas.data, source.options.linkedTableId)} (__parent_id)`,
  );
  // The new table's ownership must be visible to every subsequent access check in this transaction.
  c.scope = new AccessScope(c.db, c.schemas, c.actor);
  if (mutation.body.kind === 'table.created')
    mutation.body.table = publicTable((await loadTable(c.db, c.schemas, source.options.linkedTableId))!);
  return mutation;
}

/** Child writes inherit the parent's visibility, field lock, and record lock. */
export async function guardLineWrite(
  c: CommandContext,
  parent: StoredTable,
  command: Parameters<typeof applyRecords>[1],
): Promise<Map<string, string>> {
  const ownership = parent.lineItems;
  const parents = new Map<string, string>();
  if (!ownership) return parents;
  const owningTable = await loadTable(c.db, c.schemas, ownership.parentTableId);
  if (!owningTable || owningTable.trashed) throw new AppError('forbidden', 'data.access.recordHidden');
  const scope = await scopeOf(c, ownership.parentTableId);
  const fields = await loadFields(c.db, c.schemas, [ownership.parentTableId]);
  const field = fields.find((field) => field.id === ownership.parentFieldId);
  if (!field || field.type !== 'lineItems') invalid('data.field.unknown');
  const inverse = field.options.inverseFieldId!;
  if (command.kind === 'record.create') {
    for (const row of command.records) {
      const ids = idsOf(row.values[inverse] as never);
      if (ids.length !== 1) invalid('data.link.single');
      parents.set(row.id, ids[0]!);
    }
  } else {
    const ids = 'records' in command ? command.records.map((row) => row.id) : command.recordIds;
    const rows = await query<{ id: string; parent: string }>(
      c.db,
      sql`SELECT __id AS id, __parent_id AS parent FROM ${ident(c.schemas.data, parent.id)}
        WHERE __id = ANY(${ids}::text[]) FOR UPDATE`,
    );
    for (const row of rows.rows) parents.set(row.id, row.parent);
    if (command.kind === 'record.update')
      for (const row of command.records)
        if (
          Object.hasOwn(row.values, inverse) &&
          JSON.stringify(idsOf(row.values[inverse] as never)) !== JSON.stringify([parents.get(row.id)])
        )
          invalid('errors.validationFailed');
  }
  const guard = writeGuard(c.db, c.schemas, scope, ownership.parentTableId, fields);
  const ids = [...new Set(parents.values())];
  await guard.requireVisible(ids);
  await guard.requireEditable(ids.map((id) => ({ id, values: { [field.id]: [] } })));
  await requireUnlockedRecordsInScope(
    c.db,
    c.schemas,
    scope,
    ownership.parentTableId,
    ids,
    command.kind === 'record.trash' || command.kind === 'record.restore'
      ? c.undoCopiedRecords?.get(ownership.parentTableId)
      : undefined,
  );
  const existing = await query(
    c.db,
    sql`SELECT __id FROM ${ident(c.schemas.data, ownership.parentTableId)}
    WHERE __id = ANY(${ids}::text[]) AND __deleted_at IS NULL`,
  );
  if (existing.rowCount !== ids.length) throw new AppError('forbidden', 'data.access.recordHidden');
  return parents;
}

/** Nested API and form input is materialized as ordinary record commands in one undo group. */
export async function* replaceLineRows(
  c: CommandContext,
  field: Lines,
  parentId: string,
  input: unknown[],
): AsyncGenerator<Mutation> {
  if (input.length > LIMITS.recordsPerCommand) invalid('errors.validationFailed');
  const tableId = field.options.linkedTableId;
  if (c.publicForm) {
    const allowed = field.options.columns
      .filter((column) => column.type !== 'link')
      .map((column) => column.id);
    for (const value of input) {
      const row = value as { values?: Record<string, unknown> } | null;
      if (!row?.values || Object.keys(row.values).some((id) => !allowed.includes(id)))
        invalid('data.form.unknownField');
    }
    c = {
      ...c,
      publicForm: false,
      publicFormEdit: undefined,
      prepareRecordCreate: undefined,
      scope: new AccessScope(c.db, c.schemas, c.actor, {
        publicQuestions: { tableId: field.tableId, fieldIds: new Set([field.id]), recordId: parentId },
        publicLines: { tableId, fieldIds: new Set([...allowed, field.options.inverseFieldId!]) },
      }),
    };
  }
  const inverse = field.options.inverseFieldId!;
  const stored = await query<{ id: string; deleted: boolean }>(
    c.db,
    sql`SELECT __id AS id, __deleted_at IS NOT NULL AS deleted FROM ${ident(c.schemas.data, tableId)}
      WHERE __parent_id = ${parentId}`,
  );
  const known = new Map(stored.rows.map((row) => [row.id, row]));
  const columns = new Set(field.options.columns.map((column) => column.id));
  const ids: string[] = [];
  for (const value of input) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('errors.validationFailed');
    const row = value as { id?: unknown; values?: unknown };
    const id = row.id === undefined ? newId('record') : RecordId.parse(row.id);
    if (ids.includes(id) || !row.values || typeof row.values !== 'object' || Array.isArray(row.values))
      invalid('errors.validationFailed');
    const values = row.values as Record<string, unknown>;
    if (Object.keys(values).some((key) => !columns.has(key))) invalid('data.field.unknown');
    if (known.get(id)?.deleted)
      yield await applyLineCommand(c, { kind: 'record.restore', tableId, recordIds: [id] });
    yield await applyLineCommand(
      c,
      known.has(id)
        ? { kind: 'record.update', tableId, records: [{ id, values }] }
        : { kind: 'record.create', tableId, records: [{ id, values: { ...values, [inverse]: [parentId] } }] },
    );
    ids.push(id);
  }
  const removed = stored.rows.filter((row) => !row.deleted && !ids.includes(row.id)).map((row) => row.id);
  if (removed.length) yield await applyLineCommand(c, { kind: 'record.trash', tableId, recordIds: removed });
  yield await applyLineCommand(
    { ...c, lineItemsJunction: true },
    {
      kind: 'record.update',
      tableId: field.tableId,
      records: [{ id: parentId, values: { [field.id]: ids } }],
    },
  );
}

async function applyLineCommand(c: CommandContext, input: Record<string, unknown>): Promise<Mutation> {
  return applyRecords(
    c,
    Command.parse({ ...input, id: newId('command'), groupId: newId('action') }) as Parameters<
      typeof applyRecords
    >[1],
  );
}
