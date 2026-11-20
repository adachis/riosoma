import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  FieldId,
  SetFieldPermissions,
  SetRecordRules,
  TableId,
  isGroup,
  type FilterGroup,
  type PermissionAudience,
  type RecordRule,
  type TablePermissions,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { auditEvent, authDatabase } from '../../auth/database.js';
import { requireActor } from '../../auth/sessions.js';
import type { Actor } from '../../http/policy.js';
import { parse } from '../../http/validate.js';
import { AccessScope } from '../access.js';
import { dataStore, type DataSchemas } from '../context.js';
import { loadField, loadFields, loadTable } from '../metadata.js';
import { notifyAccess } from './notify.js';
import { redactConfig } from './redact.js';
import { loadDatabaseRules, saveFieldRules, saveRecordRules } from './store.js';
import { overriddenFields, readsLive, rulesTranslate } from '../../sources/live.js';

const notFound = () => new AppError('not_found', 'errors.notFound');

/** Field types that only show what every record carries anyway */
const RECORD_DETAILS = new Set([
  'createdBy',
  'createdTime',
  'lastModifiedBy',
  'lastModifiedTime',
  'recordId',
]);

/** A table the actor may manage the rules of: live, in their organization, and theirs to change. */
async function managedTable(db: Queryable, schemas: DataSchemas, scope: AccessScope, tableId: string) {
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed || table.orgId !== scope.actor.orgId) throw notFound();
  await scope.require(table.databaseId, 'editSchema');
  return table;
}

/** Everyone a rule names has to be a member of the organization. */
async function checkPeople(
  scope: AccessScope,
  audiences: ReadonlyArray<PermissionAudience | null>,
): Promise<void> {
  const ids = new Set(audiences.flatMap((audience) => audience?.users ?? []));
  if (!ids.size) return;
  const members = await scope.organizationMemberIds();
  if ([...ids].some((id) => !members.has(id))) throw new AppError('validation_failed', 'data.user.unknown');
}

function conditionFields(group: FilterGroup): string[] {
  return group.conditions.flatMap((condition) =>
    isGroup(condition) ? conditionFields(condition) : [condition.fieldId],
  );
}

/** Every rule on a table, as the actor may see them: rules on fields they can't see are left out. */
async function tablePermissions(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  table: { id: string; databaseId: string },
): Promise<TablePermissions> {
  await scope.prepare(table.databaseId);
  const rules = await loadDatabaseRules(db, schemas, table.databaseId);
  const fields = await loadFields(db, schemas, [table.id]);
  const visible = new Set(scope.visibleFields(table.id, fields).map((field) => field.id));
  const hidden = new Set(fields.filter((field) => !visible.has(field.id)).map((field) => field.id));
  return {
    tableId: table.id,
    fields: rules.fields
      .filter((rule) => rule.tableId === table.id && visible.has(rule.fieldId))
      .map(({ fieldId, restricted, locked }) => ({ fieldId, restricted, locked })),
    records: rules.records
      .filter((rule) => rule.tableId === table.id)
      .map(({ id, roles, users, condition }) => ({
        id,
        roles,
        users,
        condition: redactConfig(condition, hidden),
      })),
  };
}

/**
 * Field permissions and record rules.  People who can change a database's schema manage them, for
 * fields they can see and for tables whose records no rule limits for them, so nobody can widen
 * their own access.  Every change is audited with IDs only, and open tabs of the database
 * recheck what they may see.
 */
export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  const session = { config: { policy: { kind: 'session' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  app.get('/api/tables/:tableId/permissions', session, async (request): Promise<TablePermissions> => {
    const actor = requireActor(request);
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const { pool, schemas } = dataStore(app.ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = new AccessScope(db, schemas, actor);
      const table = await managedTable(db, schemas, scope, tableId);
      return tablePermissions(db, schemas, scope, table);
    });
  });

  app.put('/api/fields/:fieldId/permissions', session, async (request): Promise<TablePermissions> => {
    const actor = requireActor(request);
    const { fieldId } = parse(z.object({ fieldId: FieldId }), request.params);
    const input = parse(SetFieldPermissions, request.body);
    return setFieldPermissions(app, actor, fieldId, input);
  });

  app.put('/api/tables/:tableId/record-rules', session, async (request): Promise<TablePermissions> => {
    const actor = requireActor(request);
    const { tableId } = parse(z.object({ tableId: TableId }), request.params);
    const input = parse(SetRecordRules, request.body);
    return setRecordRules(app, actor, tableId, input.rules);
  });
}

async function lockDatabase(db: Queryable, schemas: DataSchemas, databaseId: string): Promise<void> {
  // One rule change at a time per database, so two editors can't each check against the old rules.
  await query(db, sql`SELECT pg_advisory_xact_lock(hashtextextended(${`permissions:${databaseId}`}, 0))`);
}

export async function setFieldPermissions(
  app: FastifyInstance,
  actor: Actor,
  fieldId: string,
  input: SetFieldPermissions,
): Promise<TablePermissions> {
  const { pool, schemas } = dataStore(app.ctx);
  const { audit } = authDatabase(app.ctx);
  return withTransaction(pool, async (db) => {
    const field = await loadField(db, schemas, fieldId);
    if (!field || field.trashed) throw notFound();
    const table = await loadTable(db, schemas, field.tableId);
    if (!table || table.trashed || table.orgId !== actor.orgId) throw notFound();
    await lockDatabase(db, schemas, table.databaseId);
    const scope = new AccessScope(db, schemas, actor);
    await managedTable(db, schemas, scope, table.id);
    if (!scope.visibleFields(table.id, [field]).length) throw notFound();
    // Who made and last changed a record, when, and its ID come with every record, so a field that
    // only shows them can't be restricted: hiding the field wouldn't hide what it shows.
    if (input.restricted && RECORD_DETAILS.has(field.type))
      throw new AppError('validation_failed', 'data.access.recordDetail');
    const clean = (audience: PermissionAudience | null) =>
      audience ? { roles: [...new Set(audience.roles)], users: [...new Set(audience.users)] } : null;
    const restricted = clean(input.restricted);
    const locked = clean(input.locked);
    await checkPeople(scope, [restricted, locked]);
    await saveFieldRules(
      db,
      schemas,
      { orgId: actor.orgId, databaseId: table.databaseId, tableId: table.id, fieldId },
      { restricted, locked },
      actor.userId,
    );
    await auditEvent(db, audit, 'data.permissions.fieldChanged', actor, {
      databaseId: table.databaseId,
      tableId: table.id,
      fieldId,
      restricted,
      locked,
    });
    await notifyAccess(db, schemas, actor, table.databaseId);
    return tablePermissions(db, schemas, new AccessScope(db, schemas, actor), table);
  });
}

export async function setRecordRules(
  app: FastifyInstance,
  actor: Actor,
  tableId: string,
  rules: readonly RecordRule[],
): Promise<TablePermissions> {
  const { pool, schemas } = dataStore(app.ctx);
  const { audit } = authDatabase(app.ctx);
  return withTransaction(pool, async (db) => {
    const found = await loadTable(db, schemas, tableId);
    if (!found || found.trashed || found.orgId !== actor.orgId) throw notFound();
    await lockDatabase(db, schemas, found.databaseId);
    const scope = new AccessScope(db, schemas, actor);
    const table = await managedTable(db, schemas, scope, tableId);
    // Someone a rule limits here could otherwise loosen or remove it.
    await scope.requireAdministerRecordRules(tableId);
    const fields = await loadFields(db, schemas, [tableId]);
    const visible = new Set(scope.visibleFields(tableId, fields).map((field) => field.id));
    const hidden = new Set(fields.filter((field) => !visible.has(field.id)).map((field) => field.id));
    const existing = (await loadDatabaseRules(db, schemas, table.databaseId)).records.filter(
      (rule) => rule.tableId === tableId,
    );
    // Rules on a field the actor can't see were sent to them without their values, so saving what
    // they send back would lose those values.  Only someone who sees those fields changes them.
    const known = new Set(fields.map((field) => field.id));
    for (const rule of rules)
      for (const id of conditionFields(rule.condition))
        if (!known.has(id) || hidden.has(id)) throw new AppError('validation_failed', 'data.field.unknown');
    // A live table's rules run in its source, so each has to read only what the source answers
    // exactly: source fields no record overrides.
    if (
      readsLive(table) &&
      !rulesTranslate(
        table.source!.sourceKind,
        fields,
        await overriddenFields(db, schemas, tableId),
        rules.map((rule) => rule.condition),
      )
    )
      throw new AppError('validation_failed', 'sources.live.ruleUntranslatable');
    const ids = rules.map((rule) => rule.id);
    if (new Set(ids).size !== ids.length) throw new AppError('validation_failed', 'errors.validationFailed');
    const elsewhere = await query(
      db,
      sql`SELECT id FROM ${ident(schemas.app, 'record_rules')} WHERE id = ANY(${ids}::text[]) AND table_id <> ${tableId}`,
    );
    if (elsewhere.rowCount) throw new AppError('conflict', 'errors.conflict');
    const cleaned = rules.map((rule) => ({
      ...rule,
      roles: [...new Set(rule.roles)],
      users: [...new Set(rule.users)],
    }));
    await checkPeople(scope, cleaned);
    await saveRecordRules(
      db,
      schemas,
      { orgId: actor.orgId, databaseId: table.databaseId, tableId },
      cleaned,
      actor.userId,
    );
    const before = new Set(existing.map((rule) => rule.id));
    const after = new Set(ids);
    await auditEvent(db, audit, 'data.permissions.recordRulesChanged', actor, {
      databaseId: table.databaseId,
      tableId,
      ruleIds: ids,
      added: ids.filter((id) => !before.has(id)),
      removed: [...before].filter((id) => !after.has(id)),
      rules: cleaned.map((rule) => ({
        id: rule.id,
        roles: rule.roles,
        users: rule.users,
        fieldIds: [...new Set(conditionFields(rule.condition))],
      })),
    });
    await notifyAccess(db, schemas, actor, table.databaseId);
    return tablePermissions(db, schemas, new AccessScope(db, schemas, actor), table);
  });
}
