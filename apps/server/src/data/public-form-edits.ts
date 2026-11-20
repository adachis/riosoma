import {
  AppError,
  idsOf,
  newId,
  visibleFormQuestions,
  type ChangeBody,
  type PublicForm,
  type PublicSubmitted,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { applyCommand, parseCommand } from './commands/index.js';
import type { CommandContext, Previous } from './commands/context.js';
import { ensureGroup, lock, recordChange, retry } from './commands/transaction.js';
import { dataStore } from './context.js';
import { loadFields } from './metadata.js';
import { currentValues } from './physical/records.js';
import { writeGuard } from './permissions/enforce.js';
import { reverseRecordChange } from './undo.js';
import { loadTable } from './metadata.js';
import { pricedAnswers } from '../payments/store.js';
import { isAccessRefusal } from './permissions/enforce.js';
import {
  addressKey,
  admit,
  audit,
  DEFAULT_HOURLY_LIMIT,
  loadLiveForm,
  nobodyIn,
  publicDefinition,
  publicQuestions,
  type LiveForm,
} from './public-forms.js';
import {
  EDIT_SESSION_MS,
  issueFormEditToken,
  readFormEditToken,
  type FormEditClaims,
} from './public-form-edit-tokens.js';

function requireEditing(live: LiveForm, claims: FormEditClaims) {
  if (!live.form.allowEdits || live.editVersion !== claims.version)
    throw new AppError('forbidden', 'forms.edit.revoked');
}

export async function admitEdit(
  ctx: AppContext,
  formId: string,
  address: string,
  reply: { header(name: string, value: string): unknown },
) {
  const wait = await admit(
    ctx,
    formId,
    addressKey(ctx.config.secretKey, address),
    ctx.config.publicFormHourlyLimit ?? DEFAULT_HOURLY_LIMIT,
  );
  if (wait) {
    reply.header('retry-after', String(wait));
    throw new AppError('rate_limited', 'forms.public.rateLimited');
  }
}

export async function openFormEdit(
  ctx: AppContext,
  formId: string,
  token: string,
  address: string,
): Promise<PublicForm> {
  const claims = readFormEditToken(ctx.config.secretKey, token, { formId, purpose: 'link' });
  const { schemas } = dataStore(ctx);
  const form = await publicDefinition(ctx, formId, undefined, async (db, live, questions, fields) => {
    requireEditing(live, claims);
    const scope = new AccessScope(db, schemas, nobodyIn(live.orgId), {
      publicQuestions: {
        tableId: live.tableId,
        fieldIds: new Set(live.form.questions.map((question) => question.fieldId)),
        recordId: claims.recordId,
      },
    });
    await scope.prepare(live.databaseId);
    fields = scope
      .visibleFields(live.tableId, await loadFields(db, schemas, [live.tableId]))
      .filter((field) => scope.canEditField(live.tableId, field));
    await writeGuard(db, schemas, scope, live.tableId, fields).requireVisible([claims.recordId]);
    const exists = await query(
      db,
      sql`SELECT 1 FROM ${ident(schemas.data, live.tableId)}
      WHERE __id = ${claims.recordId} AND __deleted_at IS NULL AND NOT __source_gone`,
    );
    if (!exists.rowCount) throw new AppError('not_found', 'forms.public.notFound');
    const asked = new Set(questions.map((question) => question.fieldId));
    const values =
      (
        await currentValues(
          db,
          schemas.data,
          live.tableId,
          fields.filter((field) => asked.has(field.id)),
          [claims.recordId],
        )
      ).get(claims.recordId) ?? {};
    // Evaluate conditions in order, then discard hidden values before anything leaves the server.
    const visible = visibleFormQuestions(questions, values);
    const safeValues = Object.fromEntries(
      visible.map((question) => [question.fieldId, values[question.fieldId] ?? null]),
    );
    for (const field of fields) {
      if (field.type !== 'lineItems' || !Object.hasOwn(safeValues, field.id)) continue;
      const tableId = field.options.linkedTableId;
      const allowed = new Set(
        field.options.columns.filter((column) => column.type !== 'link').map((column) => column.id),
      );
      const columns = scope
        .visibleFields(tableId, await loadFields(db, schemas, [tableId]))
        .filter((column) => allowed.has(column.id) && scope.canEditField(tableId, column));
      const ids = idsOf(values[field.id] ?? null);
      await writeGuard(db, schemas, scope, tableId, columns).requireVisible(ids);
      const rows = await currentValues(db, schemas.data, tableId, columns, ids);
      safeValues[field.id] = ids.flatMap((id) => (rows.has(id) ? [{ id, values: rows.get(id)! }] : []));
    }
    const issuedAt = Date.now();
    readFormEditToken(
      ctx.config.secretKey,
      token,
      { formId, purpose: 'link', version: live.editVersion },
      issuedAt,
    );
    const expires = Math.min(claims.expires, issuedAt + EDIT_SESSION_MS);
    // The page shows the answers a payment was priced by, without letting them change.
    const priced = await pricedAnswers(db, schemas, claims.recordId);
    const locked = visible.map((question) => question.fieldId).filter((id) => priced.has(id));
    return {
      ...(locked.length ? { locked } : {}),
      values: safeValues,
      expiresAt: new Date(expires).toISOString(),
      session: issueFormEditToken(ctx.config.secretKey, {
        ...claims,
        purpose: 'session',
        issuedAt,
        expires,
        address: addressKey(ctx.config.secretKey, address),
      }),
    };
  });
  // Editing keeps empty answers empty, and never starts another checkout.
  return {
    ...form,
    payment: null,
    editEmailAvailable: false,
    questions: form.questions.map((question) => {
      const options = { ...question.options };
      delete options.defaultValue;
      return { ...question, options };
    }),
  };
}

export async function saveFormEdit(
  ctx: AppContext,
  formId: string,
  session: string,
  values: Record<string, unknown>,
  address: string,
  baseValues?: Record<string, string | null>,
): Promise<PublicSubmitted> {
  const { pool, schemas } = dataStore(ctx);
  return retry(() =>
    withTransaction(pool, async (db) => {
      const claims = readFormEditToken(ctx.config.secretKey, session, {
        formId,
        purpose: 'session',
        address: addressKey(ctx.config.secretKey, address),
      });
      let live = await loadLiveForm(db, schemas, formId);
      const c: CommandContext = {
        db,
        schemas,
        actor: nobodyIn(live.orgId),
        databaseId: live.databaseId,
        secretKey: ctx.config.secretKey,
        publicForm: true,
        publicFormEdit: { viewId: live.viewId, recordId: claims.recordId },
      };
      await lock(c, [`database:${live.databaseId}`]);
      live = await loadLiveForm(db, schemas, formId);
      readFormEditToken(ctx.config.secretKey, session, {
        formId,
        purpose: 'session',
        version: live.editVersion,
      });
      requireEditing(live, claims);
      const scope = new AccessScope(db, schemas, c.actor, {
        publicQuestions: {
          tableId: live.tableId,
          fieldIds: new Set(live.form.questions.map((question) => question.fieldId)),
          recordId: claims.recordId,
        },
      });
      c.scope = scope;
      await scope.prepare(live.databaseId);
      const fields = (await loadFields(db, schemas, [live.tableId])).filter((field) =>
        scope.canEditField(live.tableId, field),
      );
      const questions = publicQuestions(live.form, fields).questions;
      const allowed = new Set(questions.map((question) => question.fieldId));
      for (const fieldId of Object.keys(values))
        if (!allowed.has(fieldId))
          throw new AppError('validation_failed', 'data.form.unknownField', { params: { fieldId } });
      const command = parseCommand({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.update',
        tableId: live.tableId,
        records: [{ id: claims.recordId, values, ...(baseValues ? { baseValues } : {}) }],
      });
      const mutation = await applyCommand(c, command);
      const seq = await recordChange(c, mutation, {
        commandId: command.id,
        groupId: command.groupId,
        clientId: `form:${live.viewId}`,
        system: true,
      });
      await audit(db, schemas, live.orgId, null, 'data.form.edited', {
        databaseId: live.databaseId,
        tableId: live.tableId,
        viewId: live.viewId,
        recordId: claims.recordId,
        seq,
        actor: 'submitterLink',
        formId,
        count: 1,
        answered: Object.keys(values).length,
      });
      return {
        thankYou: '',
        allowAnother: false,
        ...(Array.isArray(mutation.output?.textMerges)
          ? { textMerges: mutation.output.textMerges as NonNullable<PublicSubmitted['textMerges']> }
          : {}),
      };
    }),
  );
}

/** Restore only cells still holding the link's edit, through the requesting person's access. */
export async function undoFormEdit(ctx: AppContext, actor: Actor, viewId: string, seq: number) {
  const { pool, schemas } = dataStore(ctx);
  return retry(() =>
    withTransaction(pool, async (db) => {
      const view = await query<{ database_id: string }>(
        db,
        sql`SELECT t.database_id
      FROM ${ident(schemas.app, 'views')} v JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id WHERE v.id = ${viewId}`,
      );
      const databaseId = view.rows[0]?.database_id;
      if (!databaseId) throw new AppError('not_found', 'errors.notFound');
      const c: CommandContext = { db, schemas, actor, databaseId, secretKey: ctx.config.secretKey };
      await lock(c, [`database:${databaseId}`]);
      const scope = new AccessScope(db, schemas, actor);
      await scope.require(databaseId, 'editRecords');
      const history = await query<{ body: ChangeBody; prev: Previous; group_id: string }>(
        db,
        sql`SELECT body, prev, group_id FROM ${ident(schemas.app, 'changes')}
        WHERE database_id = ${databaseId} AND seq = ${seq} AND client_id = ${`form:${viewId}`} AND actor_id IS NULL`,
      );
      const change = history.rows[0];
      if (!change || change.body.kind !== 'record.updated')
        throw new AppError('not_found', 'errors.notFound');
      const undone = await query(
        db,
        sql`SELECT 1 FROM ${ident(schemas.app, 'changes')}
      WHERE database_id = ${databaseId} AND undo_of = ${change.group_id} LIMIT 1`,
      );
      if (undone.rowCount) return { restored: 0 };
      c.scope = scope;
      const changes = await query<{ body: ChangeBody; prev: Previous }>(
        db,
        sql`SELECT body, prev FROM ${ident(schemas.app, 'changes')}
          WHERE database_id = ${databaseId} AND group_id = ${change.group_id}
          AND client_id = ${`form:${viewId}`} AND actor_id IS NULL
          AND undo_of IS NULL AND redo_of IS NULL ORDER BY seq DESC`,
      );
      const parentTableId = change.body.tableId;
      let restored = 0;
      const groupId = newId('action');
      for (const saved of changes.rows) {
        const body = saved.body;
        if (
          saved.prev.dependent ||
          (body.kind !== 'record.updated' &&
            body.kind !== 'record.created' &&
            body.kind !== 'record.trashed' &&
            body.kind !== 'record.restored')
        )
          continue;
        if (body.tableId !== parentTableId) {
          const child = await loadTable(db, schemas, body.tableId);
          if (child?.lineItems?.parentTableId !== parentTableId) continue;
        }
        await query(db, sql`SAVEPOINT form_undo_item`);
        try {
          const mutation = await reverseRecordChange(c, body, saved.prev);
          const count =
            mutation.body.kind === 'record.updated'
              ? mutation.body.records.reduce((count, row) => count + Object.keys(row.values).length, 0)
              : 'records' in mutation.body
                ? mutation.body.records.length
                : 'recordIds' in mutation.body
                  ? mutation.body.recordIds.length
                  : 0;
          if (count) {
            await ensureGroup(c, groupId);
            await recordChange(c, mutation, {
              commandId: newId('command'),
              groupId,
              clientId: null,
              undoOf: change.group_id,
            });
            restored += count;
          }
        } catch (error) {
          if (!(error instanceof AppError) || (error.code !== 'not_found' && !isAccessRefusal(error)))
            throw error;
          await query(db, sql`ROLLBACK TO SAVEPOINT form_undo_item`);
        }
        await query(db, sql`RELEASE SAVEPOINT form_undo_item`);
      }
      return { restored };
    }),
  );
}
