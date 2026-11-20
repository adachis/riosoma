import { publicOrigin } from '../custom-domains/store.js';
import type { FastifyInstance } from 'fastify';
import {
  AppError,
  dayIn,
  idsOf,
  newId,
  REPORT_ATTACHMENT_LIMIT,
  type SignatureSigner,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { actorFor } from '../automations/run.js';
import { applyCommand, parseCommand } from '../data/commands/index.js';
import { lock, recordChange, retry } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { loadFiles, type FileRow } from '../data/files/metadata.js';
import type { StoredField } from '../data/types.js';
import type { MailAttachment, MailMessage } from '../mail/index.js';
import { escapeHtml } from '../reports/messages.js';
import { certificateTime, plainText, signatureText } from './pdf.js';
import {
  checkedSource,
  DAY,
  event,
  failRequest,
  fileBytes,
  lockedRequest,
  queueDelivery,
  recordAccess,
  remind,
  requestById,
  requesterEmail,
  save,
  unavailable,
  withRequest,
  type RequestRow,
} from './store.js';
import { documentHash, downloadToken, signingToken } from './token.js';

/** Tries at sending one email before it's marked undelivered and the requester is told. */
export const DELIVERY_ATTEMPTS = 10;

interface Delivery {
  id: string;
  request_id: string;
  signer_id: string | null;
  recipient: string;
  kind: 'invitation' | 'reminder' | 'completed' | 'failed' | 'undelivered';
  attempts: number;
}

/** Whether the requester may still see and change the attachment field the signed PDF goes in. */
export async function requesterField(db: Queryable, schemas: DataSchemas, row: RequestRow) {
  const owner = row.requester_id && (await actorFor(db, schemas, row.requester_id, row.org_id));
  if (!owner) throw unavailable();
  const access = await recordAccess(db, schemas, owner, row.table_id, row.record_id);
  const field = access.fields.find((candidate) => candidate.id === row.field_id);
  if (
    !field ||
    !access.scope.canEditField(row.table_id, field) ||
    !access.scope.visibleFields(row.table_id, [field]).length ||
    access.scope.restrictedForAnyone(row.table_id, field)
  )
    throw unavailable();
  for (const use of ['recipient', 'export', 'public'] as const)
    await access.scope.requireUse(access.table.databaseId, use, { fieldIds: [field.id] });
  return { owner, access, field };
}

/**
 * When a request finished, in the shape its date field stores: the moment itself for a field with
 * a time, and otherwise the day it fell on.  That day is in the field's own time zone, or, for a
 * field that follows each viewer, in the last signer's, so it matches their date signed.
 */
function completionDate(field: StoredField | undefined, last: SignatureSigner): string {
  const signedAt = last.signedAt!;
  if (field?.type !== 'date' || field.options.includeTime) return signedAt;
  const zone = field.options.timeZone === 'client' ? (last.timeZone ?? 'UTC') : field.options.timeZone;
  return dayIn(zone, new Date(signedAt));
}

/**
 * Attaches each fully signed PDF to its record and sets the chosen fields, as the requester would,
 * through the command bus and so in the database's lock.  Signing never takes that lock itself.  A
 * request whose requester can no longer make the change stops, and the requester is told.
 */
export async function completeSignatures(ctx: AppContext) {
  if (!ctx.pool || !ctx.config.database) return;
  const { pool, schemas } = dataStore(ctx);
  const due = await query<{ id: string }>(
    pool,
    sql`SELECT id FROM ${ident(schemas.app, 'signature_requests')}
    WHERE status = 'completing' ORDER BY created_at LIMIT 50`,
  );
  for (const { id } of due.rows) {
    try {
      await retry(() =>
        withTransaction(pool, async (db) => {
          const first = await requestById(db, schemas, id);
          if (first?.status !== 'completing') return;
          const owner = first.requester_id && (await actorFor(db, schemas, first.requester_id, first.org_id));
          if (!owner) throw unavailable();
          const base = {
            db,
            schemas,
            actor: owner,
            databaseId: first.database_id,
            secretKey: ctx.config.secretKey,
          };
          await lock(base, [`database:${first.database_id}`]);
          const row = await lockedRequest(db, schemas, id);
          if (row?.status !== 'completing' || !row.signed_file_id) return;
          const { access, field } = await requesterField(db, schemas, row);
          const last = row.signers.reduce((latest, signer) =>
            signer.signedAt! > latest.signedAt! ? signer : latest,
          );
          const dateField = access.fields.find((candidate) => candidate.id === row.input.dateFieldId);
          const values: Record<string, unknown> = {
            [row.field_id]: [...idsOf(access.record[field.columnName] as string[]), row.signed_file_id],
            ...(row.input.statusFieldId ? { [row.input.statusFieldId]: row.input.statusValue } : {}),
            ...(row.input.dateFieldId ? { [row.input.dateFieldId]: completionDate(dateField, last) } : {}),
          };
          const c = { ...base, scope: access.scope };
          const command = parseCommand({
            id: newId('command'),
            groupId: newId('action'),
            kind: 'record.update',
            tableId: row.table_id,
            records: [{ id: row.record_id, values }],
          });
          const mutation = await applyCommand(c, command);
          await recordChange(c, mutation, {
            commandId: command.id,
            groupId: command.groupId,
            clientId: null,
          });
          row.status = 'completed';
          await save(db, schemas, row);
          await event(db, schemas, row, 'completed');
          const requester = await requesterEmail(db, schemas, row);
          const sent = new Set<string>();
          for (const signer of row.signers) {
            if (sent.has(signer.email.toLowerCase())) continue;
            sent.add(signer.email.toLowerCase());
            await queueDelivery(db, schemas, row, 'completed', signer.email, signer.id);
          }
          if (requester && !sent.has(requester.toLowerCase()))
            await queueDelivery(db, schemas, row, 'completed', requester, null);
        }),
      );
    } catch (error) {
      // A passing fault is tried again on the next run.  A refusal won't change, so the request stops.
      if (!(error instanceof AppError && error.userFault)) continue;
      await withTransaction(pool, async (db) => {
        const row = await lockedRequest(db, schemas, id);
        if (row?.status === 'completing') await failRequest(db, schemas, row, null);
      });
    }
  }
}

type Built = { kind: 'send'; message: MailMessage } | { kind: 'drop' } | { kind: 'wait' };

/** The email for one delivery, read with nothing locked. */
async function build(ctx: AppContext, delivery: Delivery, row: RequestRow): Promise<Built> {
  const { pool, schemas } = dataStore(ctx);
  const baseUrl = await publicOrigin(ctx, row.org_id, 'signing');
  const document = plainText(row.name).slice(0, 120);
  const signer = row.signers.find((signer) => signer.id === delivery.signer_id);
  const paragraphs: string[] = [];
  const links: string[] = [];
  let attachment: MailAttachment | undefined;
  if (delivery.kind === 'completed') {
    if (row.status !== 'completed' || !row.signed_file_id || !row.final_hash) return { kind: 'drop' };
    await requesterField(pool, schemas, row);
    const [file]: Array<FileRow | undefined> = await loadFiles(pool, schemas.app, [row.signed_file_id]);
    if (!file) throw unavailable();
    // The email waits for the file scan to finish.
    if (file.scan_state === 'quarantined' || file.scan_state === 'unavailable') return { kind: 'wait' };
    const limit = ctx.config.signatureAttachmentBytes ?? REPORT_ATTACHMENT_LIMIT;
    if (Number(file.size) <= limit) {
      const bytes = await fileBytes(ctx, pool, schemas, file, limit);
      if (documentHash(bytes) !== row.final_hash) throw new AppError('conflict', 'signatures.changed');
      attachment = { filename: file.name, content: bytes, contentType: 'application/pdf' };
      paragraphs.push(signatureText('attached'));
    } else {
      if (file.scan_state !== 'clean') throw unavailable();
      const token = downloadToken(ctx.config.secretKey, row.id, new Date(Date.now() + 30 * DAY));
      const link = `${baseUrl}/api/public/signatures/download?${new URLSearchParams({ token })}`;
      links.push(link);
      paragraphs.push(signatureText('download', { link }));
    }
    paragraphs.push(signatureText('finalHash', { hash: row.final_hash }));
  } else if (delivery.kind === 'failed') {
    paragraphs.push(signatureText('failedBody', { document }));
  } else if (delivery.kind === 'undelivered') {
    paragraphs.push(signatureText('undeliveredBody', { document }));
  } else {
    if (row.status !== 'open' || row.expires_at.getTime() <= Date.now() || signer?.status !== 'pending')
      return { kind: 'drop' };
    await checkedSource(ctx, pool, schemas, row);
    const token = signingToken(ctx.config.secretKey, row.id, signer.id, row.expires_at);
    const link = `${baseUrl}/signatures#${token}`;
    links.push(link);
    paragraphs.push(
      row.input.message,
      signatureText('link', { link }),
      signatureText('due', { date: certificateTime(row.expires_at.toISOString()) }),
    );
  }
  const shown = paragraphs.filter(Boolean);
  return {
    kind: 'send',
    message: {
      to: delivery.recipient,
      subject: signatureText(delivery.kind, { document }),
      text: shown.join('\n\n'),
      html: shown
        .map((paragraph) => {
          let html = escapeHtml(paragraph);
          for (const link of links) {
            const url = escapeHtml(link);
            html = html.replace(url, `<a href="${url}">${url}</a>`);
          }
          return `<p>${html}</p>`;
        })
        .join(''),
      ...(attachment ? { attachments: [attachment] } : {}),
      headers: {
        'Auto-Submitted': 'auto-generated',
        'Message-ID': `<signature-${row.id}-${delivery.id}@${new URL(baseUrl).hostname}>`,
      },
    },
  };
}

/** Counts a failed try, and after the last one marks the email undelivered and tells the requester. */
async function failedTry(ctx: AppContext, delivery: Delivery) {
  const { pool, schemas } = dataStore(ctx);
  await withTransaction(pool, async (db) => {
    const updated = await query<{ failed_at: Date | null }>(
      db,
      sql`UPDATE ${ident(schemas.app, 'signature_deliveries')}
      SET attempts = attempts + 1, next_at = now() + interval '5 minutes',
        failed_at = CASE WHEN attempts + 1 >= ${DELIVERY_ATTEMPTS} THEN now() END
      WHERE id = ${delivery.id} AND sent_at IS NULL RETURNING failed_at`,
    );
    if (!updated.rows[0]?.failed_at) return;
    const row = await lockedRequest(db, schemas, delivery.request_id);
    if (!row) return;
    await event(db, schemas, row, 'undelivered', delivery.signer_id);
    // A notice that can't be delivered doesn't send another about itself.
    if (delivery.kind === 'failed' || delivery.kind === 'undelivered') return;
    const email = await requesterEmail(db, schemas, row);
    if (email) await queueDelivery(db, schemas, row, 'undelivered', email, delivery.signer_id);
  });
}

/**
 * Sends waiting signature email.  Each delivery is claimed first, the message is built with nothing
 * locked, and the mail goes out with no transaction open, so slow or unreachable mail servers hold
 * up nothing else.  A delivery that fails is tried again five minutes later, 10 times in all.
 */
export async function deliverSignatures(ctx: AppContext) {
  if (!ctx.mailer || !ctx.pool || !ctx.config.database || !ctx.config.baseUrl) return;
  const mailer = ctx.mailer;
  const { pool, schemas } = dataStore(ctx);
  const due = await query<{ id: string }>(
    pool,
    sql`SELECT id FROM ${ident(schemas.app, 'signature_deliveries')}
    WHERE sent_at IS NULL AND failed_at IS NULL AND next_at <= now() ORDER BY next_at, id LIMIT 50`,
  );
  for (const { id } of due.rows) {
    // Claimed for ten minutes, so no other run sends it while this one does.
    const claimed = await query<Delivery>(
      pool,
      sql`UPDATE ${ident(schemas.app, 'signature_deliveries')} SET next_at = now() + interval '10 minutes'
      WHERE id = ${id} AND sent_at IS NULL AND failed_at IS NULL AND next_at <= now() RETURNING *`,
    );
    const delivery = claimed.rows[0];
    if (!delivery) continue;
    let built: Built;
    try {
      const row = await requestById(pool, schemas, delivery.request_id);
      built = row ? await build(ctx, delivery, row) : { kind: 'drop' };
      if (built.kind === 'send') await mailer.send(built.message);
    } catch {
      // Failures keep the job without logging a signer's address or signing link.
      await failedTry(ctx, delivery);
      continue;
    }
    if (built.kind === 'drop') {
      await query(
        pool,
        sql`DELETE FROM ${ident(schemas.app, 'signature_deliveries')} WHERE id = ${delivery.id}`,
      );
      continue;
    }
    if (built.kind === 'wait') {
      await query(
        pool,
        sql`UPDATE ${ident(schemas.app, 'signature_deliveries')} SET next_at = now() WHERE id = ${delivery.id}`,
      );
      continue;
    }
    await withTransaction(pool, async (db) => {
      await query(
        db,
        sql`UPDATE ${ident(schemas.app, 'signature_deliveries')} SET sent_at = now() WHERE id = ${delivery.id}`,
      );
      if (delivery.kind !== 'invitation' && delivery.kind !== 'reminder') return;
      const row = await lockedRequest(db, schemas, delivery.request_id);
      const signer = row?.signers.find((signer) => signer.id === delivery.signer_id);
      if (!row || !signer) return;
      if (delivery.kind === 'reminder') {
        signer.lastReminder = new Date().toISOString();
        await save(db, schemas, row);
        await event(db, schemas, row, 'reminded', signer.id);
      } else await event(db, schemas, row, 'sent', signer.id);
    });
  }
}

export async function signatureReminders(ctx: AppContext) {
  if (!ctx.pool || !ctx.config.database) return;
  const { pool, schemas } = dataStore(ctx);
  const due = await query<{ id: string }>(
    pool,
    sql`SELECT id FROM ${ident(schemas.app, 'signature_requests')}
    WHERE status = 'open' AND expires_at > now() AND expires_at <= now() + interval '3 days'
      AND input->>'dueAt' IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(signers) signer
        WHERE signer->>'status' = 'pending' AND signer->>'invitedAt' IS NOT NULL
          AND signer->>'automaticReminder' = 'false'
          AND (signer->>'lastReminder' IS NULL OR (signer->>'lastReminder')::timestamptz <= now() - interval '1 day'))
      ORDER BY expires_at LIMIT 100`,
  );
  for (const { id } of due.rows) {
    const row = await requestById(pool, schemas, id);
    // The requester's access is checked before the row is locked.
    if (
      !row ||
      !(await checkedSource(ctx, pool, schemas, row).then(
        () => true,
        () => false,
      ))
    )
      continue;
    await withRequest(ctx, id, async (db, schemas, row) => {
      if (row.status !== 'open' || row.expires_at.getTime() <= Date.now()) return;
      for (const signer of row.signers) {
        if (
          signer.status === 'pending' &&
          signer.invitedAt &&
          !signer.automaticReminder &&
          (!signer.lastReminder || Date.now() - Date.parse(signer.lastReminder) >= DAY)
        )
          await remind(db, schemas, row, signer.id, true);
      }
    }).catch(() => undefined);
  }
  await query(
    pool,
    sql`DELETE FROM ${ident(schemas.app, 'signature_attempts')} WHERE starts_at < now() - interval '1 day'`,
  );
}

const running = new WeakMap<AppContext, Promise<void>>();
const again = new WeakSet<AppContext>();

/** Starts completion and delivery now, in the background, or once more after a run under way. */
export function kickSignatures(ctx: AppContext, onError: (error: unknown) => void = () => undefined) {
  if (running.has(ctx)) {
    again.add(ctx);
    return;
  }
  const run = (async () => {
    do {
      again.delete(ctx);
      await completeSignatures(ctx);
      await deliverSignatures(ctx);
    } while (again.has(ctx));
  })()
    .catch(onError)
    .finally(() => running.delete(ctx));
  running.set(ctx, run);
}

/** Waits for background signature work to finish. */
export async function signaturesSettled(ctx: AppContext) {
  for (let run = running.get(ctx); run; run = running.get(ctx)) await run;
}

export function installSignatures(app: FastifyInstance) {
  let reminders: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  const warn = () => app.log.warn('signature delivery failed');
  app.addHook('onReady', async () => {
    timer = setInterval(() => {
      if (reminders) return;
      reminders = signatureReminders(app.ctx)
        .then(() => kickSignatures(app.ctx, warn))
        .catch(warn)
        .finally(() => {
          reminders = undefined;
        });
    }, 60_000);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await reminders;
    await signaturesSettled(app.ctx);
  });
}
