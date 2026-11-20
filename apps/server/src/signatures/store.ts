import { requirePolicy } from '../org-units/policy.js';
import { Readable } from 'node:stream';
import {
  AppError,
  idsOf,
  newId,
  overlappingFields,
  SIGNATURE_TEXT_LIMIT,
  type PublicSignatureRequest,
  type SignatureAnswer,
  type SignatureHistory,
  type SignatureRequestInput,
  type SignatureRequestSummary,
  type SignatureSigner,
  type SignatureSubmission,
} from '@riosoma/contracts';
import { ident, query, sql, withTransaction, type Queryable } from '@riosoma/db';
import type { AppContext } from '../app.js';
import { actorFor } from '../automations/run.js';
import { AccessScope } from '../data/access.js';
import { lock } from '../data/commands/transaction.js';
import { dataStore, type DataSchemas } from '../data/context.js';
import { finishUpload } from '../data/files/finish.js';
import { loadFiles, type FileRow } from '../data/files/metadata.js';
import { checkFileSafety, requireSafeFile } from '../data/files/safety.js';
import { fileStorage, storedInDatabase } from '../data/files/storage.js';
import { loadFields, loadTable } from '../data/metadata.js';
import { writeGuard } from '../data/permissions/enforce.js';
import type { Actor } from '../http/policy.js';
import {
  hasXfa,
  pageSize,
  plainText,
  previewDocument,
  readDocument,
  signatureImage,
  signatureText,
  signingZone,
  stampDocument,
} from './pdf.js';
import { documentHash, signingClaims } from './token.js';

export const DAY = 86_400_000;
export const unavailable = () => new AppError('not_found', 'signatures.unavailable');
export interface RequestRow {
  id: string;
  org_id: string;
  database_id: string;
  table_id: string;
  record_id: string;
  field_id: string;
  source_id: string;
  requester_id: string | null;
  name: string;
  original_hash: string;
  final_hash: string | null;
  signed_file_id: string | null;
  status: 'open' | 'completing' | 'completed' | 'declined' | 'canceled' | 'failed';
  expires_at: Date;
  created_at: Date;
  input: SignatureRequestInput;
  pages: PublicSignatureRequest['pages'];
  signers: SignatureSigner[];
}

/** Where a signer's request came from, for the audit log and the certificate. */
export interface Visit {
  ip: string;
  userAgent: string;
}

export function visitOf(ip: string, userAgent: string): Visit {
  return { ip: plainText(ip).slice(0, 128).trim(), userAgent: plainText(userAgent).slice(0, 200).trim() };
}

async function history(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  action: SignatureHistory['action'],
  signerId: string | null,
  reason: string | null,
) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'signature_history')}
    (request_id, signer_id, action, reason) VALUES (${row.id}, ${signerId}, ${action}, ${reason})`,
  );
}

/** A step the system or the requester took, kept in the request's history and the audit log. */
export async function event(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  action: SignatureHistory['action'],
  signerId: string | null = null,
  reason: string | null = null,
) {
  await history(db, schemas, row, action, signerId, reason);
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
    VALUES (${row.org_id}, ${row.requester_id}, ${`signature.${action}`},
      ${JSON.stringify({
        requestId: row.id,
        recordId: row.record_id,
        signerId,
        ...(action === 'completed' ? { originalHash: row.original_hash, finalHash: row.final_hash } : {}),
      })}::jsonb)`,
  );
}

/**
 * A step a signer took.  Signers have no account, so the audit entry names no person: it carries
 * the signer's ID, where they came from, and for a signature the SHA-256 of the consent wording.
 */
export async function signerEvent(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  action: 'opened' | 'signed' | 'declined',
  signer: SignatureSigner,
  visit: Visit,
  reason: string | null = null,
) {
  await history(db, schemas, row, action, signer.id, reason);
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.audit, 'events')} (org_id, actor_id, action, metadata)
    VALUES (${row.org_id}, NULL, ${`signature.${action}`},
      ${JSON.stringify({
        actorKind: 'signer',
        requestId: row.id,
        recordId: row.record_id,
        signerId: signer.id,
        ip: visit.ip,
        userAgent: visit.userAgent,
        ...(action === 'signed' && signer.consent
          ? { consentSha256: documentHash(Buffer.from(signer.consent)) }
          : {}),
      })}::jsonb)`,
  );
}

export async function save(db: Queryable, schemas: DataSchemas, row: RequestRow) {
  await query(
    db,
    sql`UPDATE ${ident(schemas.app, 'signature_requests')}
    SET status = ${row.status}, signers = ${JSON.stringify(row.signers)}::jsonb,
      signed_file_id = ${row.signed_file_id}, final_hash = ${row.final_hash} WHERE id = ${row.id}`,
  );
}

export async function requestById(db: Queryable, schemas: DataSchemas, id: string) {
  return (
    await query<RequestRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'signature_requests')}
    WHERE id = ${id}`,
    )
  ).rows[0];
}

/** The request's row, locked until the transaction ends.  Nothing else is locked. */
export async function lockedRequest(db: Queryable, schemas: DataSchemas, id: string) {
  return (
    await query<RequestRow>(
      db,
      sql`SELECT * FROM ${ident(schemas.app, 'signature_requests')} WHERE id = ${id} FOR UPDATE`,
    )
  ).rows[0];
}

export async function recordAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  tableId: string,
  recordId: string,
  edit = true,
) {
  const table = await loadTable(db, schemas, tableId);
  if (!table || table.trashed || table.orgId !== actor.orgId) throw unavailable();
  const scope = new AccessScope(db, schemas, actor);
  await scope.require(table.databaseId, edit ? 'editRecords' : 'read');
  const fields = await loadFields(db, schemas, [tableId]);
  const records = await query<Record<string, unknown>>(
    db,
    sql`SELECT * FROM ${ident(schemas.data, tableId)}
    WHERE __id = ${recordId} AND __deleted_at IS NULL AND NOT __source_gone
      AND (${scope.recordPredicate(tableId)})`,
  );
  if (!records.rows[0]) throw unavailable();
  return { table, scope, fields, record: records.rows[0] };
}

export async function sourceAccess(
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  tableId: string,
  recordId: string,
  sourceId: string,
) {
  const access = await recordAccess(db, schemas, actor, tableId, recordId);
  const [file] = await loadFiles(db, schemas.app, [sourceId]);
  const field = file && access.fields.find((candidate) => candidate.id === file.field_id);
  if (
    !file ||
    file.org_id !== actor.orgId ||
    file.table_id !== tableId ||
    !field ||
    field.type !== 'attachment' ||
    !access.scope.canEditField(tableId, field) ||
    access.scope.restrictedForAnyone(tableId, field) ||
    !access.scope.visibleFields(tableId, [field]).length ||
    !idsOf(access.record[field.columnName] as string[]).includes(sourceId)
  )
    throw unavailable();
  for (const use of ['recipient', 'export', 'public'] as const)
    await access.scope.requireUse(access.table.databaseId, use, { fieldIds: [field.id] });
  if (file.type !== 'application/pdf' || file.scan_state !== 'clean')
    throw new AppError('validation_failed', 'signatures.invalidPdf');
  return { ...access, file, field };
}

export async function fileBytes(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  file: FileRow,
  limit = 30 * 1024 * 1024,
) {
  if (file.scan_state !== 'clean') throw unavailable();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of fileStorage(file.storage, db, schemas.app, ctx.config).read(file.storage_key)) {
    const bytes = chunk as Buffer;
    length += bytes.length;
    if (length > limit) throw new AppError('payload_too_large', 'signatures.pdfLimit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/**
 * The requester's live access to the source, checked against the stored file's checksum rather
 * than by reading the file.  The bytes are read, and hashed, only when the metadata has no checksum.
 * Call it outside any lock.
 */
export async function checkedSource(ctx: AppContext, db: Queryable, schemas: DataSchemas, row: RequestRow) {
  const owner = row.requester_id && (await actorFor(db, schemas, row.requester_id, row.org_id));
  if (!owner) throw unavailable();
  try {
    await requirePolicy(db, `"${schemas.app}"`, owner, 'externalSharing');
  } catch {
    throw unavailable();
  }
  const access = await sourceAccess(db, schemas, owner, row.table_id, row.record_id, row.source_id);
  if (access.file.sha256) {
    if (access.file.sha256 !== row.original_hash) throw new AppError('conflict', 'signatures.changed');
  } else if (documentHash(await fileBytes(ctx, db, schemas, access.file)) !== row.original_hash)
    throw new AppError('conflict', 'signatures.changed');
  return { ...access, owner };
}

/** The same check, with the source's bytes, for drawing or stamping it.  Call it outside any lock. */
export async function checkedSourceBytes(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
) {
  const source = await checkedSource(ctx, db, schemas, row);
  return { ...source, bytes: await fileBytes(ctx, db, schemas, source.file) };
}

export async function queueDelivery(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  kind: 'invitation' | 'reminder' | 'completed' | 'failed' | 'undelivered',
  recipient: string,
  signerId: string | null,
) {
  await query(
    db,
    sql`INSERT INTO ${ident(schemas.app, 'signature_deliveries')}
    (request_id, signer_id, recipient, kind) VALUES (${row.id}, ${signerId}, ${recipient}, ${kind})`,
  );
}

/** The requester's address, for notices about their request, or null once they're gone. */
export async function requesterEmail(db: Queryable, schemas: DataSchemas, row: RequestRow) {
  if (!row.requester_id) return null;
  const owner = await query<{ email: string }>(
    db,
    sql`SELECT email FROM ${ident(schemas.app, 'users')} WHERE id = ${row.requester_id}`,
  );
  return owner.rows[0]?.email ?? null;
}

/** Stops a request that can never finish and tells the requester, in the caller's transaction. */
export async function failRequest(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  signerId: string | null,
) {
  row.status = 'failed';
  await save(db, schemas, row);
  await event(db, schemas, row, 'failed', signerId);
  const email = await requesterEmail(db, schemas, row);
  if (email) await queueDelivery(db, schemas, row, 'failed', email, null);
}

export async function inviteReady(db: Queryable, schemas: DataSchemas, row: RequestRow) {
  for (const signer of row.signers) {
    if (signer.status !== 'pending') continue;
    if (!signer.invitedAt) {
      signer.invitedAt = new Date().toISOString();
      await queueDelivery(db, schemas, row, 'invitation', signer.email, signer.id);
    }
    if (row.input.order === 'sequential') break;
  }
  await save(db, schemas, row);
}

/**
 * The status and completion date values, with one refusal for a field that's missing, hidden,
 * locked, or of the wrong type, so the answer never says what a hidden field is.
 */
function completionValues(
  access: Awaited<ReturnType<typeof sourceAccess>>,
  tableId: string,
  input: SignatureRequestInput,
) {
  const usable = (id: string) => {
    const field = access.fields.find((candidate) => candidate.id === id);
    return field &&
      access.scope.visibleFields(tableId, [field]).length &&
      access.scope.canEditField(tableId, field)
      ? field
      : undefined;
  };
  const refused = () => new AppError('validation_failed', 'signatures.invalidField');
  const values: Record<string, unknown> = {};
  if (input.statusFieldId) {
    const field = usable(input.statusFieldId);
    if (
      !field ||
      !['text', 'singleSelect'].includes(field.type) ||
      !input.statusValue ||
      (field.type === 'singleSelect' &&
        !field.options.choices.some((choice) => choice.id === input.statusValue))
    )
      throw refused();
    values[field.id] = input.statusValue;
  }
  if (input.dateFieldId) {
    const field = usable(input.dateFieldId);
    if (!field || field.type !== 'date') throw refused();
    values[field.id] = new Date().toISOString();
  }
  return values;
}

/** Refuses a request past its sender's hourly or daily allowance. */
async function withinLimits(
  ctx: AppContext,
  db: Queryable,
  schemas: DataSchemas,
  actor: Actor,
  signers: number,
) {
  const counts = await query<{ requests: number; signers: number }>(
    db,
    sql`SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS requests,
      COALESCE(sum(jsonb_array_length(signers)), 0)::int AS signers
    FROM ${ident(schemas.app, 'signature_requests')}
    WHERE requester_id = ${actor.userId} AND created_at > now() - interval '1 day'`,
  );
  const { requests, signers: added } = counts.rows[0]!;
  if (requests >= (ctx.config.signatureRequestHourlyLimit ?? 20))
    throw new AppError('rate_limited', 'signatures.requestLimit');
  if (added + signers > (ctx.config.signatureSignerDailyLimit ?? 200))
    throw new AppError('rate_limited', 'signatures.signerLimit');
}

export async function createRequest(
  ctx: AppContext,
  actor: Actor,
  tableId: string,
  recordId: string,
  input: SignatureRequestInput,
) {
  if (!ctx.mailer || !ctx.config.baseUrl) throw new AppError('unavailable', 'signatures.mailUnavailable');
  if (overlappingFields(input.fields)) throw new AppError('validation_failed', 'signatures.overlap');
  const { pool, schemas } = dataStore(ctx);
  await requirePolicy(pool, `"${schemas.app}"`, actor, 'externalSharing');
  // The document is read, hashed, and parsed before any lock is taken.
  const before = await sourceAccess(pool, schemas, actor, tableId, recordId, input.attachmentId);
  if (before.table.source || before.table.joined) throw new AppError('forbidden', 'sources.syncedReadOnly');
  const bytes = await fileBytes(ctx, pool, schemas, before.file);
  const originalHash = documentHash(bytes);
  if (originalHash !== before.file.sha256) throw new AppError('conflict', 'signatures.changed');
  const document = await readDocument(bytes);
  if (hasXfa(document)) throw new AppError('validation_failed', 'signatures.xfa');
  const pages = document.getPages().map(pageSize);
  if (input.fields.some((field) => field.page >= pages.length))
    throw new AppError('validation_failed', 'signatures.invalid');
  const expiresAt = input.dueAt ? new Date(input.dueAt) : new Date(Date.now() + 30 * DAY);
  if (expiresAt.getTime() <= Date.now()) throw new AppError('validation_failed', 'signatures.expired');
  const signers: SignatureSigner[] = input.signers.map((signer) => ({
    name: plainText(signer.name),
    email: signer.email,
    id: newId('signatureSigner'),
    status: 'pending',
    invitedAt: null,
    openedAt: null,
    signedAt: null,
    lastReminder: null,
    automaticReminder: false,
    reason: null,
    consent: null,
    ip: null,
    userAgent: null,
    timeZone: null,
    values: {},
  }));
  if (signers.some((signer) => !signer.name)) throw new AppError('validation_failed', 'signatures.invalid');
  return withTransaction(pool, async (db) => {
    // The database lock keeps a change that removes the source from landing before this request
    // exists to be canceled, and the sender's lock keeps two requests from both fitting the limits.
    await lock({ db, schemas, actor, databaseId: before.table.databaseId }, [
      `database:${before.table.databaseId}`,
      `signature-sender:${actor.userId}`,
    ]);
    const access = await sourceAccess(db, schemas, actor, tableId, recordId, input.attachmentId);
    if (access.file.sha256 !== originalHash) throw new AppError('conflict', 'signatures.changed');
    const values = completionValues(access, tableId, input);
    await writeGuard(db, schemas, access.scope, tableId, access.fields).requireEditable([{ values }]);
    await withinLimits(ctx, db, schemas, actor, signers.length);
    const result = await query<RequestRow>(
      db,
      sql`INSERT INTO ${ident(schemas.app, 'signature_requests')}
      (id, org_id, database_id, table_id, record_id, field_id, source_id, requester_id, name,
        original_hash, expires_at, input, pages, signers)
      VALUES (${newId('signatureRequest')}, ${actor.orgId}, ${access.table.databaseId}, ${tableId}, ${recordId},
        ${access.field.id}, ${access.file.id}, ${actor.userId}, ${access.file.name}, ${originalHash}, ${expiresAt},
        ${JSON.stringify(input)}::jsonb, ${JSON.stringify(pages)}::jsonb, ${JSON.stringify(signers)}::jsonb) RETURNING *`,
    );
    const row = result.rows[0]!;
    await inviteReady(db, schemas, row);
    return row.id;
  });
}

/** Runs work on one request with only its own row locked. */
export async function withRequest<T>(
  ctx: AppContext,
  id: string,
  work: (db: Queryable, schemas: DataSchemas, row: RequestRow) => Promise<T>,
) {
  const { pool, schemas } = dataStore(ctx);
  return withTransaction(pool, async (db) => {
    const row = await lockedRequest(db, schemas, id);
    if (!row) throw unavailable();
    return work(db, schemas, row);
  });
}

export function requireOpen(row: RequestRow) {
  if (row.status !== 'open' || row.expires_at.getTime() <= Date.now()) throw unavailable();
}

type Claims = NonNullable<ReturnType<typeof signingClaims>>;

/** The token's signer, when it's their turn on an open request, or the uniform refusal. */
function signerFor(row: RequestRow | undefined, claims: Claims): SignatureSigner {
  if (!row) throw unavailable();
  requireOpen(row);
  const signer = row.signers.find((signer) => signer.id === claims.signerId);
  if (
    !signer ||
    signer.status !== 'pending' ||
    !signer.invitedAt ||
    row.expires_at.getTime() !== claims.expiresAt ||
    (row.input.order === 'sequential' && row.signers.find((signer) => signer.status === 'pending') !== signer)
  )
    throw unavailable();
  return signer;
}

/** Anything the requester's side refuses reads to the public as the same unavailable link. */
async function uniformly<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError && error.userFault) throw unavailable();
    throw error;
  }
}

/** Checks a signing link without locking anything: the token, the request, and whose turn it is. */
async function opened(ctx: AppContext, token: string) {
  const claims = signingClaims(ctx.config.secretKey, token);
  if (!claims) throw unavailable();
  const { pool, schemas } = dataStore(ctx);
  const row = await requestById(pool, schemas, claims.requestId);
  const signer = signerFor(row, claims);
  return { claims, row: row!, signer, pool, schemas };
}

export async function publicView(
  ctx: AppContext,
  token: string,
  visit: Visit,
): Promise<PublicSignatureRequest> {
  const { claims, row, signer, pool, schemas } = await opened(ctx, token);
  await uniformly(() => checkedSource(ctx, pool, schemas, row));
  if (!signer.openedAt)
    await withTransaction(pool, async (db) => {
      const locked = await lockedRequest(db, schemas, row.id);
      const current = signerFor(locked, claims);
      if (current.openedAt) return;
      current.openedAt = new Date().toISOString();
      await save(db, schemas, locked!);
      await signerEvent(db, schemas, locked!, 'opened', current, visit);
    });
  const mine = (index: number) => row.signers[index]?.id === signer.id;
  return {
    name: row.name,
    message: row.input.message,
    expiresAt: row.expires_at.toISOString(),
    signerName: signer.name,
    consent: signatureText('consent'),
    pages: row.pages,
    fields: row.input.fields.filter((field) => mine(field.signer)),
    otherFields: row.input.fields
      .filter((field) => !mine(field.signer))
      .map(({ page, x, y, width, height, signer: index }) => ({
        page,
        x,
        y,
        width,
        height,
        signerName: row.signers[index]!.name,
      })),
    signers: row.signers.map((signer) => ({ name: signer.name, signed: signer.status === 'signed' })),
  };
}

/** The document as the signer sees it: their fields numbered, and everyone else's outlined with a name. */
export async function publicDocument(ctx: AppContext, token: string) {
  const { row, signer, pool, schemas } = await opened(ctx, token);
  const source = await uniformly(() => checkedSourceBytes(ctx, pool, schemas, row));
  const mine = (field: SignatureRequestInput['fields'][number]) =>
    row.signers[field.signer]?.id === signer.id;
  return previewDocument(
    source.bytes,
    row.input.fields.filter(mine).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x),
    {
      others: row.input.fields
        .filter((field) => !mine(field))
        .map((field) => ({ field, name: row.signers[field.signer]!.name })),
    },
  );
}

export async function declineRequest(ctx: AppContext, token: string, reason: string, visit: Visit) {
  const { claims, row, pool, schemas } = await opened(ctx, token);
  await uniformly(() => checkedSource(ctx, pool, schemas, row));
  const cleaned = plainText(reason).slice(0, 2000);
  if (!cleaned) throw new AppError('validation_failed', 'errors.validationFailed');
  await withTransaction(pool, async (db) => {
    const locked = await lockedRequest(db, schemas, row.id);
    const signer = signerFor(locked, claims);
    signer.status = 'declined';
    signer.reason = cleaned;
    locked!.status = 'declined';
    await save(db, schemas, locked!);
    await signerEvent(db, schemas, locked!, 'declined', signer, visit, cleaned);
  });
}

/** A signer's answers, cleaned and checked, with images made safe, before anything is locked. */
async function answersFor(
  ctx: AppContext,
  row: RequestRow,
  signer: SignatureSigner,
  input: SignatureSubmission,
): Promise<Record<string, SignatureAnswer>> {
  if (!input.consent || input.consentText !== signatureText('consent'))
    throw new AppError('validation_failed', 'signatures.consentRequired');
  const fields = row.input.fields.filter((field) => row.signers[field.signer]?.id === signer.id);
  if (Object.keys(input.values).some((id) => !fields.some((field) => field.id === id)))
    throw new AppError('validation_failed', 'signatures.invalid');
  const values: Record<string, SignatureAnswer> = {};
  for (const field of fields) {
    const answer = input.values[field.id];
    if (field.kind === 'text') {
      const text = plainText(answer?.text ?? '');
      if (!text) throw new AppError('validation_failed', 'signatures.required');
      if (Array.from(text).length > SIGNATURE_TEXT_LIMIT)
        throw new AppError('validation_failed', 'signatures.textTooLong', {
          params: { limit: SIGNATURE_TEXT_LIMIT },
        });
      values[field.id] = { text };
    } else if (field.kind === 'signature' || field.kind === 'initials') {
      if (!answer?.image) throw new AppError('validation_failed', 'signatures.required');
      values[field.id] = { text: plainText(answer.text).slice(0, 200), image: answer.image };
    }
  }
  const { pool, schemas } = dataStore(ctx);
  for (const answer of Object.values(values)) {
    if (!answer.image) continue;
    requireSafeFile(
      await checkFileSafety(
        { db: pool, schema: schemas.app, orgId: row.org_id, config: ctx.config },
        {
          bytes: Buffer.from(answer.image.slice(answer.image.indexOf(',') + 1), 'base64'),
          statedType: 'image/png',
          origin: 'outside',
        },
      ),
      {
        invalid: 'signatures.invalidImage',
        infected: 'signatures.invalidImage',
        unavailable: 'errors.unavailable',
      },
    );
    const image = await signatureImage(answer.image);
    answer.image = `data:image/png;base64,${image.toString('base64')}`;
  }
  return values;
}

const statuses = (row: RequestRow) => [row.status, ...row.signers.map((signer) => signer.status)].join();

/**
 * Records a signature.  Everything slow happens first with nothing locked: the requester's access,
 * the answers, and, for the last signature, stamping the document.  Then only the request's row is
 * locked to record it, and if anyone signed meanwhile the work starts again from what they left.
 * Attaching the signed PDF to the record happens afterward, in the signature worker, since that
 * change goes through the command bus and its database lock.
 */
export async function signRequest(
  ctx: AppContext,
  token: string,
  input: SignatureSubmission,
  visit: Visit,
): Promise<{ status: RequestRow['status'] }> {
  const { pool, schemas } = dataStore(ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { claims, row: first, signer } = await opened(ctx, token);
    await uniformly(() => checkedSource(ctx, pool, schemas, first));
    const signed: SignatureSigner = {
      ...signer,
      values: await answersFor(ctx, first, signer, input),
      status: 'signed',
      signedAt: new Date().toISOString(),
      ip: visit.ip,
      userAgent: visit.userAgent,
      consent: input.consentText,
      timeZone: signingZone(input.timeZone),
    };
    const everyone = first.signers.map((candidate) => (candidate.id === signer.id ? signed : candidate));
    let stamped: Awaited<ReturnType<typeof stampDocument>> | null = null;
    let failed = false;
    if (everyone.every((candidate) => candidate.status === 'signed')) {
      const source = await uniformly(() => checkedSourceBytes(ctx, pool, schemas, first));
      try {
        stamped = await stampDocument(source.bytes, first.original_hash, first.input.fields, everyone);
      } catch {
        // A document that can't be stamped never will be, so the request stops instead of failing each try.
        failed = true;
      }
    }
    const storage = ctx.config.filesStorage ?? 'postgres';
    const fileId = newId('attachment');
    const outcome = await withTransaction(pool, async (db) => {
      const row = (await lockedRequest(db, schemas, first.id))!;
      const current = signerFor(row, claims);
      if (statuses(row) !== statuses(first)) return 'again' as const;
      if (failed) {
        await failRequest(db, schemas, row, current.id);
        return 'failed' as const;
      }
      Object.assign(current, signed);
      await signerEvent(db, schemas, row, 'signed', current, visit);
      if (!stamped) {
        await inviteReady(db, schemas, row);
        return row.status;
      }
      try {
        await finishUpload(
          db,
          schemas.app,
          ctx.config,
          {
            id: fileId,
            orgId: row.org_id,
            userId: row.requester_id!,
            tableId: row.table_id,
            fieldId: row.field_id,
            name: signatureText('filename', { name: plainText(row.name).replace(/\.pdf$/i, '') }),
            storage,
          },
          Readable.from([stamped.bytes]),
        );
      } catch (error) {
        if (!storedInDatabase(storage))
          await fileStorage(storage, db, schemas.app, ctx.config)
            .delete(fileId)
            .catch(() => undefined);
        throw error;
      }
      row.status = 'completing';
      row.signed_file_id = fileId;
      row.final_hash = stamped.finalHash;
      await save(db, schemas, row);
      return row.status;
    });
    if (outcome === 'again') continue;
    if (outcome === 'failed') throw new AppError('conflict', 'signatures.stampFailed');
    return { status: outcome };
  }
  throw new AppError('conflict', 'errors.conflict');
}

export async function remind(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  signerId: string,
  automatic = false,
) {
  requireOpen(row);
  const signer = row.signers.find((signer) => signer.id === signerId);
  if (!signer || signer.status !== 'pending' || !signer.invitedAt) throw unavailable();
  const pending = await query(
    db,
    sql`SELECT 1 FROM ${ident(schemas.app, 'signature_deliveries')}
    WHERE request_id = ${row.id} AND signer_id = ${signerId} AND kind = 'reminder'
      AND sent_at IS NULL AND failed_at IS NULL LIMIT 1`,
  );
  if (pending.rowCount) throw new AppError('rate_limited', 'signatures.reminderLimit');
  if (signer.lastReminder && Date.now() - Date.parse(signer.lastReminder) < DAY)
    throw new AppError('rate_limited', 'signatures.reminderLimit');
  signer.lastReminder = new Date().toISOString();
  signer.automaticReminder ||= automatic;
  await queueDelivery(db, schemas, row, 'reminder', signer.email, signer.id);
  await save(db, schemas, row);
}

export async function summary(
  db: Queryable,
  schemas: DataSchemas,
  row: RequestRow,
  userId: string,
): Promise<SignatureRequestSummary> {
  const events = await query<{
    action: SignatureHistory['action'];
    signer_id: string | null;
    at: Date;
    reason: string | null;
  }>(
    db,
    sql`SELECT action, signer_id, at, reason FROM ${ident(schemas.app, 'signature_history')} WHERE request_id = ${row.id} ORDER BY id`,
  );
  return {
    id: row.id,
    name: row.name,
    status: row.status === 'open' && row.expires_at.getTime() <= Date.now() ? 'expired' : row.status,
    expiresAt: row.expires_at.toISOString(),
    order: row.input.order,
    canManage: row.requester_id === userId,
    originalHash: row.original_hash,
    finalHash: row.final_hash,
    signedAttachmentId: row.status === 'completed' ? row.signed_file_id : null,
    signers: row.signers.map(({ id, name, email, status, signedAt, reason, lastReminder, invitedAt }) => ({
      id,
      name,
      email,
      status,
      signedAt,
      reason,
      lastReminder,
      invitedAt,
    })),
    history: events.rows.map(({ action, signer_id, at, reason }) => ({
      action,
      signerId: signer_id,
      at: at.toISOString(),
      reason,
    })),
  };
}

export async function cancelDetached(
  db: Queryable,
  schemas: DataSchemas,
  tableId: string,
  records: readonly { id: string; values: Record<string, unknown> }[],
  /** Refuses the change instead of canceling, for a writer that may not cancel requests */
  refuse = false,
) {
  if (!records.length) return;
  // Signing locks only a request's row, so this waits for it and rereads the status before canceling.
  const requests = await query<RequestRow>(
    db,
    sql`SELECT * FROM ${ident(schemas.app, 'signature_requests')}
    WHERE table_id = ${tableId} AND record_id = ANY(${records.map((record) => record.id)}::text[]) AND status = 'open'
    FOR UPDATE`,
  );
  for (const row of requests.rows) {
    const record = records.find((record) => record.id === row.record_id)!;
    if (
      Object.hasOwn(record.values, row.field_id) &&
      !idsOf(record.values[row.field_id] as string[]).includes(row.source_id)
    ) {
      if (refuse) throw new AppError('forbidden', 'routines.changes.signatureRequest');
      row.status = 'canceled';
      await save(db, schemas, row);
      await event(db, schemas, row, 'canceled');
    }
  }
}

export interface SignatureSnapshot {
  id: string;
  tableId: string;
  recordId: string;
  status: RequestRow['status'];
  state: string;
  cancels: boolean;
}

/**
 * Keeps request identities and complete state without copying private signer answers into a plan.
 * Callers hold the database lock, which prevents new requests.  Row locks also hold off signing,
 * reminders, and cancellation until the checked record change has finished.  Every request on
 * the affected records is included, so a replacement or an additional request changes the snapshot.
 */
export async function signatureSnapshots(
  db: Queryable,
  schemas: DataSchemas,
  scope: AccessScope,
  tableId: string,
  records: readonly { id: string; values: Record<string, unknown> }[],
): Promise<SignatureSnapshot[]> {
  if (!records.length) return [];
  const values = new Map(records.map((record) => [record.id, record.values]));
  const requests = await query<{
    id: string;
    record_id: string;
    field_id: string;
    source_id: string;
    status: RequestRow['status'];
    state: string;
  }>(
    db,
    sql`SELECT request.id, request.record_id, request.field_id, request.source_id, request.status,
      encode(sha256(convert_to(to_jsonb(request)::text, 'UTF8')), 'hex') AS state
    FROM ${ident(schemas.app, 'signature_requests')} request
    WHERE request.table_id = ${tableId} AND request.org_id = ${scope.actor.orgId}
      AND request.record_id = ANY(${[...values.keys()]}::text[])
      AND request.record_id IN (
        SELECT __id FROM ${ident(schemas.data, tableId)}
        WHERE __deleted_at IS NULL AND (${scope.recordPredicate(tableId)})
      )
    ORDER BY request.id FOR UPDATE`,
  );
  return requests.rows.map((row) => ({
    id: row.id,
    tableId,
    recordId: row.record_id,
    status: row.status,
    state: row.state,
    cancels:
      row.status === 'open' &&
      Object.hasOwn(values.get(row.record_id)!, row.field_id) &&
      !idsOf(values.get(row.record_id)![row.field_id] as string[]).includes(row.source_id),
  }));
}
