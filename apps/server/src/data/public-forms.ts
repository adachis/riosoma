import { publicFormFiles } from './public-form-files.js';
import { policyAllows, policyRelevant, requirePolicy } from '../org-units/policy.js';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { pageSettings, refuseResultValues, reservePayment } from '../payments/store.js';
import { startCheckout } from '../payments/service.js';
import {
  AppError,
  GridConfig,
  defaultIssue,
  fieldDefault,
  newId,
  type FormSettings,
  type PublicForm,
  type PublicFormLink,
  type PublicQuestion,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import type { Actor } from '../http/policy.js';
import { AccessScope } from './access.js';
import { applyCommand, parseCommand } from './commands/index.js';
import type { CommandContext } from './commands/context.js';
import { isPublicQuestionType } from './commands/forms.js';
import { lock, recordChange, retry } from './commands/transaction.js';
import { dataStore, type DataSchemas } from './context.js';
import { publicTheme } from '../themes/choices.js';
import { issueFormEditToken, EDIT_DAY_MS } from './public-form-edit-tokens.js';
import { loadFields } from './metadata.js';
import type { StoredField } from './types.js';
import { demoReadOnly } from '../demo/boundary.js';

/**
 * Public form links, following `packages/contracts/src/public-forms.ts`.  A link is a random ID of
 * 22 characters.  The routes that use it are open to anyone, so everything here returns only what
 * answering needs, and every submission runs the form's own checks through the command bus.
 */

/** A ticket younger than this is refused: people take longer than scripts to fill in a form. */
export const TICKET_MIN_AGE_MS = 2_000;
export const TICKET_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
/** Submissions one address may make to one form in an hour, unless the server says otherwise */
export const DEFAULT_HOURLY_LIMIT = 20;
export const SUBMISSION_BODY_LIMIT = 64 * 1024;

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function notAvailable(): AppError {
  return new AppError('not_found', 'forms.public.notFound');
}

/** A new link ID: 22 base-62 characters from the secure random source, with no bias. */
export function newPublicFormId(): string {
  let id = '';
  for (let i = 0; i < 22; i += 1) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}

/** What a ticket lets someone do: answer a public form, or book on a booking page. */
export type TicketPurpose = 'publicForm' | 'bookingPage';

function ticketMac(key: Buffer, formId: string, issuedAt: number, purpose: TicketPurpose): string {
  return createHmac('sha256', key)
    .update(`riosoma.${purpose}.ticket\n${formId}\n${issuedAt}`)
    .digest('base64url');
}

/** Proof that the form was fetched, bound to the link and the moment it was issued. */
export function issueTicket(
  key: Buffer,
  formId: string,
  issuedAt = Date.now(),
  purpose: TicketPurpose = 'publicForm',
): string {
  return `${issuedAt}.${ticketMac(key, formId, issuedAt, purpose)}`;
}

/** True when this server issued the ticket for this link between 2 seconds and 24 hours ago. */
export function ticketAccepted(
  key: Buffer,
  formId: string,
  ticket: string,
  now = Date.now(),
  purpose: TicketPurpose = 'publicForm',
): boolean {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!match) return false;
  const issuedAt = Number(match[1]);
  if (String(issuedAt) !== match[1]) return false;
  const expected = Buffer.from(ticketMac(key, formId, issuedAt, purpose));
  const given = Buffer.from(match[2]!);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  const age = now - issuedAt;
  return age >= TICKET_MIN_AGE_MS && age <= TICKET_MAX_AGE_MS;
}

/** Addresses are counted under a keyed hash, so the table never holds one. */
export function addressKey(key: Buffer, address: string): string {
  return createHmac('sha256', key).update(`riosoma.publicForm.address\n${address}`).digest('base64url');
}

interface FormRow {
  id: string;
  org_id: string;
  database_id: string;
  view_id: string;
  created_by: string | null;
  created_at: Date;
  submissions: string;
  /** The name of the person who shared it, read with the link while it's live */
  sharer_name?: string | null;
  /** Whether that person is suspended, which pauses the form */
  sharer_suspended?: boolean;
}

/** A link that works right now: shared, with its view, table, and database all out of the trash. */
export interface LiveForm {
  editVersion: number;
  id: string;
  orgId: string;
  databaseId: string;
  tableId: string;
  viewId: string;
  viewName: string;
  form: FormSettings;
  databaseSettings: unknown;
  /** Who shared the form, or null when they've left */
  sharerId: string | null;
  hasUnits: boolean;
}

export async function loadLiveForm(db: Queryable, schemas: DataSchemas, formId: string): Promise<LiveForm> {
  const result = await query<{
    edit_version: number;
    id: string;
    org_id: string;
    database_id: string;
    table_id: string;
    view_id: string;
    view_name: string;
    config: unknown;
    settings: unknown;
    sharer_suspended: boolean;
    created_by: string | null;
    policy_relevant: boolean;
    theme_policy_relevant: boolean;
  }>(
    db,
    sql`SELECT f.id, f.edit_version, f.org_id, f.database_id, f.created_by, t.id AS table_id, v.id AS view_id, v.name AS view_name,
        v.config, d.settings, COALESCE(u.deactivated_at IS NOT NULL, false) AS sharer_suspended,
        ${policyRelevant(schemas.app, sql`f.org_id`)} AS policy_relevant,
        ${policyRelevant(schemas.app, sql`f.org_id`, { unitsOnly: true })} AS theme_policy_relevant
      FROM ${ident(schemas.app, 'public_forms')} f
      LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = f.created_by
      JOIN ${ident(schemas.app, 'views')} v ON v.id = f.view_id
      JOIN ${ident(schemas.app, 'tables')} t ON t.id = v.table_id
      JOIN ${ident(schemas.app, 'databases')} d ON d.id = t.database_id
     WHERE f.id = ${formId} AND f.stopped_at IS NULL AND v.type = 'form'
       AND d.id = f.database_id AND d.org_id = f.org_id
       AND v.trashed_at IS NULL AND t.trashed_at IS NULL AND d.trashed_at IS NULL`,
  );
  const row = result.rows[0];
  if (!row) throw notAvailable();
  await new AccessScope(db, schemas, nobodyIn(row.org_id)).requireUse(row.database_id, 'public', {
    tableId: row.table_id,
  });
  // As with a view link, a suspended person's form answers "gone" and takes nothing until they're
  // reactivated or someone shares it again.
  if (row.sharer_suspended) throw new AppError('gone', 'forms.public.notFound');
  // Public links turned off where its sharer is pause the form the same way.  An organization with
  // no units and no unit policy can't turn them off, so its forms check nothing more.
  if (
    row.policy_relevant &&
    row.created_by &&
    !(await policyAllows(
      db,
      `"${schemas.app}"`,
      { orgId: row.org_id, userId: row.created_by },
      'publicLinks',
    ))
  )
    throw new AppError('gone', 'forms.public.notFound');
  return {
    editVersion: row.edit_version,
    id: row.id,
    orgId: row.org_id,
    databaseId: row.database_id,
    tableId: row.table_id,
    viewId: row.view_id,
    viewName: row.view_name,
    // Parsing fills defaults added since the view was saved.
    form: GridConfig.parse(row.config ?? {}).form,
    databaseSettings: row.settings,
    sharerId: row.created_by,
    hasUnits: row.theme_policy_relevant,
  };
}

/** The field's options that shape an answer, and nothing else. */
export function answerOptions(field: StoredField): Record<string, unknown> {
  switch (field.type) {
    case 'lineItems':
      return {
        columns: field.options.columns
          .filter((column) => column.type !== 'link')
          .map((column) => ({ ...column, options: answerOptions({ ...field, ...column } as StoredField) })),
      };
    case 'singleSelect':
    case 'multipleSelect':
      return {
        choices: field.options.source
          ? []
          : field.options.choices.map(({ id, name, color }) => ({ id, name, color })),
        ...(field.options.cascade ? { cascade: field.options.cascade } : {}),
      };
    case 'number':
    case 'percent':
      return { precision: field.options.precision, allowNegative: field.options.allowNegative };
    case 'time':
      return { timeFormat: field.options.timeFormat };
    case 'multiCurrency':
      return {
        code: field.options.code,
        precision: field.options.precision,
        allowNegative: field.options.allowNegative,
      };
    case 'currency':
      return {
        code: field.options.code,
        precision: field.options.precision,
        allowNegative: field.options.allowNegative,
      };
    case 'rating':
      return { max: field.options.max };
    case 'date':
    case 'dateRange':
      return { includeTime: field.options.includeTime };
    case 'longText':
      return { richText: field.options.richText };
    // A box checked by default starts checked, so leaving it that way and clearing it both answer.
    case 'checkbox':
      return field.options.defaultValue?.value === true ? { defaultValue: field.options.defaultValue } : {};
    default:
      return {};
  }
}

/**
 * The form's questions as the public sees them, and the ones it leaves out: people, linked
 * records, attachments, and computed fields.  Questions about trashed fields are simply gone.
 */
export function publicQuestions(
  form: FormSettings,
  fields: readonly StoredField[],
): { questions: PublicQuestion[]; omittedFieldIds: string[] } {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const questions: PublicQuestion[] = [];
  const omittedFieldIds: string[] = [];
  for (const question of form.questions) {
    const field = byId.get(question.fieldId);
    if (!field) continue;
    const type = field.type;
    if (
      (question.showIf && !questions.some((earlier) => earlier.fieldId === question.showIf?.fieldId)) ||
      !isPublicQuestionType(type) ||
      ((field.type === 'singleSelect' || field.type === 'multipleSelect') &&
        (field.options.source ||
          (field.options.cascade &&
            !form.questions.some(
              (question) => question.fieldId === field.options.cascade?.fieldId && byId.has(question.fieldId),
            ))))
    ) {
      omittedFieldIds.push(field.id);
      continue;
    }
    const defaultValue = !field.managed && !defaultIssue(field) ? fieldDefault(field) : undefined;
    questions.push({
      fieldId: field.id,
      ...(question.showIf ? { showIf: question.showIf } : {}),
      type,
      label: question.label || field.name,
      help: question.help,
      required: question.required,
      options: {
        ...answerOptions(field),
        ...(defaultValue ? { defaultValue } : {}),
      },
    });
  }
  return { questions, omittedFieldIds };
}

/** The form as the public sees it.  `check` may refuse its questions, given the fields they ask about. */
export async function publicDefinition(
  ctx: AppContext,
  formId: string,
  check?: (questions: readonly PublicQuestion[], fields: readonly StoredField[]) => void,
  edit?: (
    db: Queryable,
    live: LiveForm,
    questions: PublicQuestion[],
    fields: StoredField[],
  ) => Promise<PublicForm['edit']>,
): Promise<PublicForm> {
  const { pool, schemas } = dataStore(ctx);
  const { live, fields, editing } = await withTransaction(pool, async (db) => {
    await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
    const live = await loadLiveForm(db, schemas, formId);
    // The public never sees a question on a locked or restricted field, not even its name.
    const scope = new AccessScope(db, schemas, nobodyIn(live.orgId), {
      publicQuestions: {
        tableId: live.tableId,
        fieldIds: new Set(live.form.questions.map((question) => question.fieldId)),
      },
    });
    await scope.prepare(live.databaseId);
    const fields = scope
      .visibleFields(live.tableId, await loadFields(db, schemas, [live.tableId]))
      .filter((field) => scope.canEditField(live.tableId, field));
    const questions = publicQuestions(live.form, fields).questions;
    const editing = edit ? await edit(db, live, questions, fields) : undefined;
    return { live, fields, editing };
  });
  const questions = publicQuestions(live.form, fields).questions;
  check?.(questions, fields);
  // The form's own theme wins over its database's, as far as the form's sharer may choose them.
  const theme = await publicTheme(
    pool,
    `"${schemas.app}"`,
    { orgId: live.orgId, sharerId: live.sharerId, hasUnits: live.hasUnits },
    live.form.theme,
    live.databaseSettings,
    ctx.config,
  );
  const payment = await pageSettings(pool, schemas, live.viewId);
  const files = (await publicFormFiles(ctx, live.id, live)).metadata;
  return {
    ...(editing ? { edit: editing } : {}),
    ...(live.form.allowEdits && live.form.editConfirmationEmail && ctx.mailer && ctx.config.baseUrl
      ? { editEmailAvailable: true }
      : {}),
    ...(payment ? { payment } : {}),
    formId: live.id,
    ...(files.length ? { files } : {}),
    title: live.form.title || live.viewName,
    description: live.form.description,
    submitLabel: live.form.submitLabel,
    thankYou: live.form.thankYou,
    allowAnother: live.form.allowAnother,
    questions,
    theme,
    ticket: issueTicket(ctx.config.secretKey, live.id),
  };
}

export async function liveLink(
  db: Queryable,
  schemas: DataSchemas,
  viewId: string,
  options: { forUpdate?: boolean } = {},
): Promise<FormRow | undefined> {
  const select = sql`SELECT f.id, f.org_id, f.database_id, f.view_id, f.created_by, f.created_at, f.submissions,
      u.name AS sharer_name, COALESCE(u.deactivated_at IS NOT NULL, false) AS sharer_suspended
    FROM ${ident(schemas.app, 'public_forms')} f LEFT JOIN ${ident(schemas.app, 'users')} u ON u.id = f.created_by
    WHERE f.view_id = ${viewId} AND f.stopped_at IS NULL`;
  const result = await query<FormRow>(db, options.forUpdate ? sql`${select} FOR UPDATE OF f` : select);
  return result.rows[0];
}

export async function shareForm(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: { databaseId: string; tableId: string; viewId: string },
): Promise<FormRow> {
  await requirePolicy(db, `"${schemas.app}"`, actor, 'publicLinks');
  await new AccessScope(db, schemas, actor).requireUse(target.databaseId, 'public', {
    tableId: target.tableId,
  });
  // Sharing a shared form keeps its link.  Two people sharing at once meet at the unique index,
  // and the one who loses picks up the other's link.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await liveLink(db, schemas, target.viewId, { forUpdate: true });
    if (existing && (!existing.sharer_suspended || existing.created_by === actor.userId)) return existing;
    if (existing) {
      // A form paused by its sharer's suspension takes answers again, at the same address, once
      // someone else shares it again.
      const taken = await query<FormRow>(
        db,
        sql`UPDATE ${ident(schemas.app, 'public_forms')} SET created_by = ${actor.userId} WHERE id = ${existing.id}
          RETURNING id, org_id, database_id, view_id, created_by, created_at, submissions`,
      );
      await audit(db, schemas, actor.orgId, actor.userId, 'data.form.shareTakenOver', {
        ...target,
        previousSharerId: existing.created_by,
      });
      return { ...taken.rows[0]!, sharer_suspended: false };
    }
    const created = await query<FormRow>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'public_forms')} (id, org_id, database_id, view_id, created_by)
        VALUES (${newPublicFormId()}, ${actor.orgId}, ${target.databaseId}, ${target.viewId}, ${actor.userId})
        ON CONFLICT (view_id) WHERE stopped_at IS NULL DO NOTHING
        RETURNING id, org_id, database_id, view_id, created_by, created_at, submissions`,
    );
    const row = created.rows[0];
    if (row) {
      await audit(db, schemas, actor.orgId, actor.userId, 'data.form.shared', target);
      return row;
    }
  }
  throw new AppError('conflict', 'errors.conflict');
}

export async function stopSharing(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  target: { databaseId: string; tableId: string; viewId: string },
): Promise<void> {
  // Submissions hold the database's lock while they write, so none lands after this commits.
  await lock({ db, schemas, actor, databaseId: target.databaseId }, [`database:${target.databaseId}`]);
  const stopped = await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'public_forms')} SET stopped_at = statement_timestamp()
      WHERE view_id = ${target.viewId} AND stopped_at IS NULL`,
  );
  if (stopped.rowCount) await audit(db, schemas, actor.orgId, actor.userId, 'data.form.unshared', target);
}

export function linkOf(row: FormRow, form: FormSettings, fields: readonly StoredField[]): PublicFormLink {
  return {
    formId: row.id,
    viewId: row.view_id,
    path: `/f/${row.id}`,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    submissions: Number(row.submissions),
    omittedFieldIds: publicQuestions(form, fields).omittedFieldIds,
    suspendedSharer:
      row.sharer_suspended && row.created_by ? { id: row.created_by, name: row.sharer_name ?? '' } : null,
  };
}

export async function audit(
  db: Queryable,
  schemas: DataSchemas,
  orgId: string,
  actorId: string | null,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
      VALUES (${orgId}, ${actorId}, ${action}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

/**
 * Counts a submission from one address to one form, unless that address has used up its hour.
 * Returns 0 when the submission may go ahead, or the seconds until it could.
 */
export async function admit(
  ctx: AppContext,
  formId: string,
  address: string,
  limit: number,
): Promise<number> {
  const { pool, schemas } = dataStore(ctx);
  const attempts = ident(schemas.app, 'public_form_attempts');
  return withTransaction(pool, async (db) => {
    await query(
      db,
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${schemas.app}:public-form:${formId}:${address}`}, 0))`,
    );
    await query(
      db,
      sql`DELETE FROM ${attempts} WHERE form_id = ${formId} AND at <= clock_timestamp() - interval '1 hour'`,
    );
    // The limiting attempt is the one whose expiry leaves fewer than the allowed number.
    const limiting = await query<{ seconds: number }>(
      db,
      sql`SELECT GREATEST(1, ceil(extract(epoch FROM (at + interval '1 hour' - clock_timestamp()))))::int AS seconds
        FROM ${attempts} WHERE form_id = ${formId} AND address = ${address}
        ORDER BY at DESC OFFSET ${limit - 1} LIMIT 1`,
    );
    if (limiting.rows[0]) return limiting.rows[0].seconds;
    await query(db, sql`INSERT INTO ${attempts} (form_id, address) VALUES (${formId}, ${address})`);
    return 0;
  });
}

/**
 * What every public submission passes before its answers are read, wherever the form is shown:
 * the ticket its page was given, then its address's allowance for the hour, which the server's
 * operator may set.  A submission that gets as far as the allowance counts, taken or refused, so
 * trying costs a script too.  `address` is what the caller counts visitors by.
 */
export async function admitSubmission(
  ctx: AppContext,
  formId: string,
  ticket: string,
  address: string,
  reply: { header(name: string, value: string): unknown },
): Promise<void> {
  const key = ctx.config.secretKey;
  if (!ticketAccepted(key, formId, ticket)) throw new AppError('forbidden', 'forms.public.ticket');
  const wait = await admit(
    ctx,
    formId,
    addressKey(key, address),
    ctx.config.publicFormHourlyLimit ?? DEFAULT_HOURLY_LIMIT,
  );
  if (wait) {
    reply.header('retry-after', String(wait));
    throw new AppError('rate_limited', 'forms.public.rateLimited');
  }
}

/**
 * Adds the answers as a record through the command bus, as `record.create` with the form's view,
 * so the form's own rules apply.  It's a system change: no person made it, so no person can undo
 * it, and the record belongs to nobody.  Only counts reach the audit log.
 *
 * A form that takes payment works the same way.  The payment service adds only its Pending result
 * values, under a grant for exactly those fields in the new record, and gives back the Stripe
 * Checkout address to send the visitor to.
 */
export async function submitAnswers(
  ctx: AppContext,
  formId: string,
  values: Record<string, unknown>,
  /** The visitor's time zone, for a date question's "today" default */
  timeZone?: string,
  options: {
    allowPayment?: boolean;
    authorize?: (db: Queryable, live: LiveForm) => Promise<void>;
  } = {},
): Promise<{ checkoutUrl?: string; editLink?: { path: string; expiresAt: string } }> {
  const { pool, schemas } = dataStore(ctx);
  const paying = await retry(() =>
    withTransaction(pool, async (db) => {
      const live = await loadLiveForm(db, schemas, formId);
      const nobody = nobodyIn(live.orgId);
      const c: CommandContext = {
        secretKey: ctx.config.secretKey,
        db,
        schemas,
        actor: nobody,
        databaseId: live.databaseId,
        publicForm: true,
        scope: new AccessScope(db, schemas, nobody, {
          publicQuestions: {
            tableId: live.tableId,
            fieldIds: new Set(live.form.questions.map((question) => question.fieldId)),
          },
        }),
      };
      await lock(c, [`database:${live.databaseId}`]);
      // Sharing may have stopped, or the form gone to the trash, while waiting for the lock.
      const current = await loadLiveForm(db, schemas, formId);
      await options.authorize?.(db, current);
      const recordId = newId('record');
      let paying = false;
      if (await pageSettings(db, schemas, live.viewId)) {
        // Recheck under the database lock in case payment was enabled after the site page read.
        if (options.allowPayment === false) throw demoReadOnly();
        await refuseResultValues(c, live.tableId, values);
        c.prepareRecordCreate = async (rows) => {
          const row = rows[0]!;
          const payment = await reservePayment(
            c,
            { id: live.viewId, kind: 'form' },
            live.tableId,
            recordId,
            live.form.title || live.viewName,
            row.values,
          );
          if (payment) {
            paying = true;
            c.managedWrite = payment.grant;
            row.values = payment.values as typeof row.values;
          }
        };
      }
      const command = parseCommand({
        id: newId('command'),
        groupId: newId('action'),
        kind: 'record.create',
        tableId: live.tableId,
        formViewId: live.viewId,
        records: [{ id: recordId, values }],
        ...(timeZone ? { timeZone } : {}),
      });
      const mutation = await applyCommand(c, command);
      await recordChange(c, mutation, {
        commandId: command.id,
        groupId: command.groupId,
        clientId: null,
        system: true,
      });
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'public_forms')} SET submissions = submissions + 1 WHERE id = ${formId}`,
      );
      await audit(db, schemas, live.orgId, null, 'data.form.submitted', {
        databaseId: live.databaseId,
        tableId: live.tableId,
        viewId: live.viewId,
        count: 1,
        answered: Object.keys(values).length,
      });
      const expires = Date.now() + current.form.editLinkDays * EDIT_DAY_MS;
      const token = current.form.allowEdits
        ? issueFormEditToken(ctx.config.secretKey, {
            purpose: 'link',
            formId,
            recordId,
            version: current.editVersion,
            issuedAt: Date.now(),
            expires,
          })
        : undefined;
      return {
        paying: paying ? recordId : null,
        ...(token
          ? { editLink: { path: `/f/${formId}/edit#${token}`, expiresAt: new Date(expires).toISOString() } }
          : {}),
      };
    }),
  );
  return {
    ...('editLink' in paying ? { editLink: paying.editLink } : {}),
    ...(paying.paying ? { checkoutUrl: await startCheckout(ctx, paying.paying, 'form') } : {}),
  };
}

/** No one in particular: a public submission belongs to no person and is named by no rule. */
export function nobodyIn(orgId: string): Actor {
  return { userId: '', orgId, sessionId: '', kind: 'guest', adminRoles: [], csrfToken: '' };
}
