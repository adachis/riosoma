import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AppError,
  AttachmentId,
  RecordId,
  SignatureField,
  SignatureRequestInput,
  SignatureSubmission,
  TableId,
  type PublicSignatureRequest,
} from '@riosoma/contracts';
import { ident, query, sql } from '@riosoma/db';
import { requireActor } from '../auth/sessions.js';
import { dataStore } from '../data/context.js';
import { disposition } from '../data/files/detect.js';
import { loadFiles } from '../data/files/metadata.js';
import { fileStorage } from '../data/files/storage.js';
import { parse } from '../http/validate.js';
import { hasXfa, pageSize, previewDocument, readDocument } from './pdf.js';
import {
  checkedSource,
  createRequest,
  declineRequest,
  event,
  fileBytes,
  publicDocument,
  publicView,
  recordAccess,
  remind,
  requestById,
  requireOpen,
  save,
  signRequest,
  sourceAccess,
  summary,
  unavailable,
  visitOf,
  withRequest,
  type RequestRow,
} from './store.js';
import { downloadClaims } from './token.js';
import { deliverSignatures, installSignatures, kickSignatures, requesterField } from './worker.js';

const RecordParams = z.object({ tableId: TableId, recordId: RecordId });
const TokenQuery = z.object({ token: z.string().max(256) });

/** Public requests one address, and one link, may make in a minute. */
export const PUBLIC_LIMITS = { address: 30, token: 20 } as const;

export async function signatureRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const session = { config: { policy: { kind: 'session' as const } } };
  const open = { config: { policy: { kind: 'public' as const } } };
  installSignatures(app);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
  });
  async function limited(request: FastifyRequest) {
    const { token } = parse(TokenQuery, request.query);
    const { pool, schemas } = dataStore(ctx);
    for (const [kind, value, limit] of [
      ['address', request.ip, PUBLIC_LIMITS.address],
      ['token', token, PUBLIC_LIMITS.token],
    ] as const) {
      const key = createHmac('sha256', ctx.config.secretKey)
        .update(`signature.${kind}\n${value}`)
        .digest('hex');
      const count = await query<{ count: number }>(
        pool,
        sql`INSERT INTO ${ident(schemas.app, 'signature_attempts')}
        (key, starts_at, count) VALUES (${key}, now(), 1) ON CONFLICT (key) DO UPDATE
        SET starts_at = CASE WHEN signature_attempts.starts_at < now() - interval '1 minute' THEN now() ELSE signature_attempts.starts_at END,
          count = CASE WHEN signature_attempts.starts_at < now() - interval '1 minute' THEN 1 ELSE signature_attempts.count + 1 END
        RETURNING count`,
      );
      if (count.rows[0]!.count > limit) throw new AppError('rate_limited', 'signatures.rateLimited');
    }
    return token;
  }
  const visit = (request: FastifyRequest) => visitOf(request.ip, request.headers['user-agent'] ?? '');
  const recordPath = '/api/tables/:tableId/records/:recordId';
  app.get(`${recordPath}/signature-document`, session, async (request) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const { attachmentId } = parse(z.object({ attachmentId: AttachmentId }), request.query);
    const { pool, schemas } = dataStore(ctx);
    const access = await sourceAccess(pool, schemas, requireActor(request), tableId, recordId, attachmentId);
    const document = await readDocument(await fileBytes(ctx, pool, schemas, access.file));
    if (hasXfa(document)) throw new AppError('validation_failed', 'signatures.xfa');
    return { pages: document.getPages().map(pageSize) };
  });
  app.post(`${recordPath}/signature-preview`, { ...session, bodyLimit: 256_000 }, async (request, reply) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const input = parse(
      z.object({
        attachmentId: AttachmentId,
        page: z.number().int().min(0).max(199),
        fields: z.array(SignatureField).max(200),
      }),
      request.body,
    );
    const { pool, schemas } = dataStore(ctx);
    const access = await sourceAccess(
      pool,
      schemas,
      requireActor(request),
      tableId,
      recordId,
      input.attachmentId,
    );
    const bytes = await previewDocument(await fileBytes(ctx, pool, schemas, access.file), input.fields, {
      onlyPage: input.page,
    });
    return reply.type('application/pdf').send(bytes);
  });
  app.post(`${recordPath}/signature-requests`, { ...session, bodyLimit: 256_000 }, async (request) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const id = await createRequest(
      ctx,
      requireActor(request),
      tableId,
      recordId,
      parse(SignatureRequestInput, request.body),
    );
    await deliverSignatures(ctx);
    return { id };
  });
  // Requests carry signers' addresses and answers, so only people who can edit the record see them.
  app.get(`${recordPath}/signature-requests`, session, async (request) => {
    const { tableId, recordId } = parse(RecordParams, request.params);
    const actor = requireActor(request);
    const { pool, schemas } = dataStore(ctx);
    const access = await recordAccess(pool, schemas, actor, tableId, recordId, true);
    const visible = access.scope.visibleFields(tableId, access.fields).map((field) => field.id);
    const requests = await query<RequestRow>(
      pool,
      sql`SELECT * FROM ${ident(schemas.app, 'signature_requests')}
      WHERE table_id = ${tableId} AND record_id = ${recordId} AND field_id = ANY(${visible}::text[])
      ORDER BY created_at DESC LIMIT 100`,
    );
    return {
      requests: await Promise.all(requests.rows.map((row) => summary(pool, schemas, row, actor.userId))),
    };
  });
  for (const action of ['remind', 'cancel'] as const) {
    app.post(`/api/signature-requests/:requestId/${action}`, session, async (request) => {
      const { requestId } = parse(
        z.object({ requestId: z.string().regex(/^sgr[0-9A-Za-z]{14}$/) }),
        request.params,
      );
      const actor = requireActor(request);
      const { pool, schemas } = dataStore(ctx);
      const first = await requestById(pool, schemas, requestId);
      if (!first || first.org_id !== actor.orgId || first.requester_id !== actor.userId) throw unavailable();
      await recordAccess(pool, schemas, actor, first.table_id, first.record_id);
      if (action === 'remind') await checkedSource(ctx, pool, schemas, first);
      await withRequest(ctx, requestId, async (db, schemas, row) => {
        requireOpen(row);
        if (action === 'cancel') {
          row.status = 'canceled';
          await save(db, schemas, row);
          await event(db, schemas, row, 'canceled');
        } else {
          const { signerId } = parse(z.object({ signerId: z.string().max(40) }), request.body);
          await remind(db, schemas, row, signerId);
        }
      });
      await deliverSignatures(ctx);
      return { ok: true };
    });
  }
  app.get('/api/public/signatures', open, async (request): Promise<PublicSignatureRequest> =>
    publicView(ctx, await limited(request), visit(request)),
  );
  app.get('/api/public/signatures/document', open, async (request, reply) => {
    const bytes = await publicDocument(ctx, await limited(request));
    return reply
      .type('application/pdf')
      .header('content-disposition', 'inline')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(bytes);
  });
  app.post('/api/public/signatures/sign', { ...open, bodyLimit: 10_000_000 }, async (request) => {
    const token = await limited(request);
    try {
      return await signRequest(ctx, token, parse(SignatureSubmission, request.body), visit(request));
    } finally {
      // The next invitation, the finished document, or word that it couldn't finish, goes out in the background.
      kickSignatures(ctx, () => app.log.warn('signature delivery failed'));
    }
  });
  app.post('/api/public/signatures/decline', open, async (request) => {
    const token = await limited(request);
    const { reason } = parse(z.object({ reason: z.string().trim().min(1).max(2000) }), request.body);
    await declineRequest(ctx, token, reason, visit(request));
    return { ok: true };
  });
  // The link in a completed request's email when the signed PDF is too large to attach.
  app.get('/api/public/signatures/download', open, async (request, reply) => {
    const claims = downloadClaims(ctx.config.secretKey, await limited(request));
    if (!claims) throw unavailable();
    const { pool, schemas } = dataStore(ctx);
    const row = await requestById(pool, schemas, claims.requestId);
    if (row?.status !== 'completed' || !row.signed_file_id) throw unavailable();
    await requesterField(pool, schemas, row).catch(() => {
      throw unavailable();
    });
    const [file] = await loadFiles(pool, schemas.app, [row.signed_file_id]);
    if (!file || file.scan_state !== 'clean' || file.sha256 !== row.final_hash) throw unavailable();
    return reply
      .type('application/pdf')
      .header('content-length', Number(file.size))
      .header('content-disposition', disposition('application/pdf', file.name))
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(fileStorage(file.storage, pool, schemas.app, ctx.config).read(file.storage_key));
  });
}
