import { publicFormFiles, formFileAccepted } from './public-form-files.js';
import { fileStorage } from './files/storage.js';
import { disposition } from './files/detect.js';
import { publicLink } from '../custom-domains/store.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  AttachmentId,
  PublicFormId,
  PublicSubmission,
  PublicFormEdit,
  PublicFormEditSession,
  ViewId,
  type DatabaseAction,
  type PublicForm,
  type PublicFormLink,
  type PublicSubmitted,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { parse } from '../http/validate.js';
import { AccessScope } from './access.js';
import { lock, retry } from './commands/transaction.js';
import { admitEdit, openFormEdit, saveFormEdit, undoFormEdit } from './public-form-edits.js';
import { formConfirmationEmail } from '../reports/email.js';
import { dataStore, type DataSchemas } from './context.js';
import { loadFields, loadTable, loadView } from './metadata.js';
import {
  admitSubmission,
  audit,
  linkOf,
  liveLink,
  loadLiveForm,
  notAvailable,
  publicDefinition,
  shareForm,
  stopSharing,
  SUBMISSION_BODY_LIMIT,
  submitAnswers,
} from './public-forms.js';
import { badViewSetting } from './view-settings.js';

const ViewParams = z.object({ viewId: ViewId });

/** Any malformed link reads as a missing one, so the page can say so calmly. */
function formIdOf(params: unknown): string {
  const parsed = z.object({ formId: PublicFormId }).safeParse(params);
  if (!parsed.success) throw notAvailable();
  return parsed.data.formId;
}

/** A form view's public link: who may see and change it, and the open routes that answer it. */
export async function publicFormRoutes(app: FastifyInstance): Promise<void> {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const open = { config: { policy: { kind: 'public' as const } } };
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
  });

  async function formView(
    db: Queryable,
    schemas: DataSchemas,
    scope: AccessScope,
    viewId: string,
    action: DatabaseAction,
  ) {
    const loaded = await loadView(db, schemas, viewId);
    if (!loaded || loaded.trashed) throw new AppError('not_found', 'errors.notFound');
    await scope.require(loaded.databaseId, action);
    const table = await loadTable(db, schemas, loaded.view.tableId);
    if (!table || table.trashed) throw new AppError('not_found', 'errors.notFound');
    const fields = await loadFields(db, schemas, [table.id]);
    return { view: loaded.view, databaseId: loaded.databaseId, table, fields };
  }

  app.get('/api/views/:viewId/public-form', session, async (request): Promise<PublicFormLink | null> => {
    const { viewId } = parse(ViewParams, request.params);
    const { pool, schemas } = dataStore(ctx);
    return withTransaction(pool, async (db) => {
      await query(db, sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const scope = new AccessScope(db, schemas, requireActor(request));
      const { view, fields } = await formView(db, schemas, scope, viewId, 'read');
      const row = view.type === 'form' ? await liveLink(db, schemas, viewId) : undefined;
      return row ? publicLink(ctx, row.org_id, 'forms', linkOf(row, view.config.form, fields), db) : null;
    });
  });

  app.put('/api/views/:viewId/public-form', session, async (request): Promise<PublicFormLink> => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    return retry(() =>
      withTransaction(pool, async (db) => {
        const scope = new AccessScope(db, schemas, actor);
        const { view, databaseId, table, fields } = await formView(db, schemas, scope, viewId, 'editSchema');
        if (view.type !== 'form') badViewSetting('type');
        if (
          view.config.form.questions.some((question) =>
            fields.some(
              (field) =>
                field.id === question.fieldId &&
                (field.type === 'singleSelect' || field.type === 'multipleSelect') &&
                field.options.source,
            ),
          )
        )
          throw new AppError('validation_failed', 'data.select.formSource');
        // A synced table takes records only from its source, and a joined one only from its
        // inputs, so neither can take a form's answers.
        if (table.source || table.joined) throw new AppError('forbidden', 'sources.syncedReadOnly');
        const row = await shareForm(db, schemas, actor, { databaseId, tableId: table.id, viewId });
        return publicLink(ctx, row.org_id, 'forms', linkOf(row, view.config.form, fields), db);
      }),
    );
  });

  app.delete('/api/views/:viewId/public-form', session, async (request, reply) => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await retry(() =>
      withTransaction(pool, async (db) => {
        const scope = new AccessScope(db, schemas, actor);
        const { databaseId, table } = await formView(db, schemas, scope, viewId, 'editSchema');
        await stopSharing(db, schemas, actor, { databaseId, tableId: table.id, viewId });
      }),
    );
    return reply.status(204).send();
  });

  app.get('/api/public/forms/:formId', open, async (request): Promise<PublicForm> => {
    const formId = formIdOf(request.params);
    return publicDefinition(ctx, formId);
  });
  app.post('/api/views/:viewId/public-form/revoke-edits', session, async (request, reply) => {
    const { viewId } = parse(ViewParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    await retry(() =>
      withTransaction(pool, async (db) => {
        const { databaseId, table, view } = await formView(
          db,
          schemas,
          new AccessScope(db, schemas, actor),
          viewId,
          'editSchema',
        );
        if (view.type !== 'form') badViewSetting('type');
        await lock({ db, schemas, actor, databaseId }, [`database:${databaseId}`]);
        await query(
          db,
          sql`UPDATE ${ident(schemas.app, 'public_forms')} SET edit_version = edit_version + 1 WHERE view_id = ${viewId}`,
        );
        await audit(db, schemas, actor.orgId, actor.userId, 'data.form.editsRevoked', {
          databaseId,
          tableId: table.id,
          viewId,
        });
      }),
    );
    return reply.status(204).send();
  });
  app.post('/api/views/:viewId/public-form/edits/:seq/undo', session, async (request) => {
    const { viewId, seq } = parse(
      z.object({ viewId: ViewId, seq: z.coerce.number().int().positive().safe() }),
      request.params,
    );
    return undoFormEdit(ctx, requireActor(request), viewId, seq);
  });
  app.post(
    '/api/public/forms/:formId/edit-session',
    { ...open, bodyLimit: SUBMISSION_BODY_LIMIT },
    async (request, reply) => {
      const formId = formIdOf(request.params);
      const { token } = parse(PublicFormEditSession, request.body);
      const { pool, schemas } = dataStore(ctx);
      await loadLiveForm(pool, schemas, formId);
      await admitEdit(ctx, formId, request.ip, reply);
      return openFormEdit(ctx, formId, token, request.ip);
    },
  );
  app.post(
    '/api/public/forms/:formId/edits',
    { ...open, bodyLimit: SUBMISSION_BODY_LIMIT },
    async (request, reply) => {
      const formId = formIdOf(request.params);
      const input = parse(PublicFormEdit, request.body);
      const { pool, schemas } = dataStore(ctx);
      await loadLiveForm(pool, schemas, formId);
      await admitEdit(ctx, formId, request.ip, reply);
      return saveFormEdit(ctx, formId, input.session, input.values, request.ip, input.baseValues);
    },
  );
  app.get('/api/public/forms/:formId/files/:attachmentId', open, async (request, reply) => {
    const formId = formIdOf(request.params);
    const { attachmentId } = parse(z.object({ attachmentId: AttachmentId }), request.params);
    const signed = parse(
      z.object({ expires: z.coerce.number().int().positive(), signature: z.string().max(100) }),
      request.query,
    );
    const selection = await publicFormFiles(ctx, formId);
    if (
      !formFileAccepted(
        ctx.config.secretKey,
        formId,
        attachmentId,
        signed.expires,
        signed.signature,
        selection.lifetime,
      )
    )
      throw notAvailable();
    const file = selection.files.find((item) => item.id === attachmentId);
    if (!file || file.scan_state !== 'clean') throw notAvailable();
    const { pool, schemas } = dataStore(ctx);
    reply.headers({
      'content-type': file.type,
      'content-length': Number(file.size),
      'content-disposition': disposition(file.type, file.name),
      'cache-control': 'no-store',
      'content-security-policy': "sandbox; default-src 'none'; frame-ancestors 'self'",
      'x-content-type-options': 'nosniff',
    });
    // Detected file types use safe dispositions, nosniff, and a sandboxed CSP.
    // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
    return reply.send(fileStorage(file.storage, pool, schemas.app, ctx.config).read(file.storage_key));
  });

  app.post(
    '/api/public/forms/:formId/submissions',
    { ...open, bodyLimit: SUBMISSION_BODY_LIMIT },
    async (request, reply): Promise<PublicSubmitted> => {
      const formId = formIdOf(request.params);
      const input = parse(PublicSubmission, request.body);
      const { pool, schemas } = dataStore(ctx);
      const live = await loadLiveForm(pool, schemas, formId);
      const answer = { thankYou: live.form.thankYou, allowAnother: live.form.allowAnother };
      // Only scripts fill the hidden field.  Answer as if it worked, and keep nothing.
      if (input.website) {
        request.log.info({ dropped: 1 }, 'public form submission dropped');
        return answer;
      }
      await admitSubmission(ctx, formId, input.ticket, request.ip, reply);
      const submitted = await submitAnswers(ctx, formId, input.values, input.timeZone);
      if (
        submitted.editLink &&
        input.confirmationEmail &&
        live.form.editConfirmationEmail &&
        ctx.mailer &&
        ctx.config.baseUrl
      ) {
        const link = await publicLink(ctx, live.orgId, 'forms', submitted.editLink);
        if ('url' in link && typeof link.url === 'string') {
          await ctx.mailer
            .send(
              formConfirmationEmail(
                input.confirmationEmail,
                live.form.title || live.viewName,
                link.url,
                link.expiresAt,
              ),
            )
            .catch((error: unknown) =>
              request.log.warn({ err: error }, 'Form confirmation email could not be sent'),
            );
        }
      }
      return { ...answer, ...submitted };
    },
  );
}
