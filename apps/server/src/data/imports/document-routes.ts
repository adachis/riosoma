import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError, DocumentImportRequest, DocumentImportSettings } from '@riosoma/contracts';
import { requireActor } from '../../auth/sessions.js';
import { parse } from '../../http/validate.js';
import { knowledgeSettings } from '../knowledge.js';
import { extractDocument } from './document.js';

const tooLarge = () => new AppError('payload_too_large', 'import.document.tooLarge');

/**
 * Reads the paused upload once its slot is granted.  Stopping leaves the stream unread, so the
 * reply still goes out and the connection closes after it.
 */
async function readUpload(request: FastifyRequest, limit: number, signal: AbortSignal) {
  // A request with no body or content type never reaches the JSON parser that keeps the stream.
  if (!(request.body instanceof Readable)) throw new AppError('validation_failed', 'import.document.invalid');
  const payload = request.body;
  signal.throwIfAborted();
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      payload.off('data', read);
      payload.off('end', end);
      payload.off('error', stop);
      signal.removeEventListener('abort', abort);
    };
    const stop = (error: unknown) => {
      cleanup();
      payload.pause();
      reject(error);
    };
    const read = (chunk: Uint8Array) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) stop(tooLarge());
      else chunks.push(bytes);
    };
    const end = () => {
      cleanup();
      resolve();
    };
    const abort = () => stop(signal.reason);
    payload.on('data', read);
    payload.once('end', end);
    payload.once('error', stop);
    signal.addEventListener('abort', abort, { once: true });
  });
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new AppError('validation_failed', 'import.document.invalid');
  }
  return parse(DocumentImportRequest, body);
}

export async function documentImportRoutes(app: FastifyInstance) {
  // Keep JSON uploads as paused streams until a person's extraction slot is available.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', (_request, payload, done) => done(null, payload));
  for (const prefix of ['/api/imports', '/api/v1/imports']) {
    app.post(
      `${prefix}/document`,
      {
        config: {
          policy: prefix.includes('/v1/')
            ? { kind: 'token', scope: 'data.records:write', beforeBody: true }
            : { kind: 'session', beforeBody: true },
        },
      },
      async (request, reply) => {
        const actor = requireActor(request);
        const settings = await knowledgeSettings(app.ctx, actor);
        const limits = DocumentImportSettings.parse(settings.imports ?? {});
        const limit = 4 * Math.ceil(limits.uploadBytes / 3) + 1024;
        if (Number(request.headers['content-length'] ?? 0) > limit) throw tooLarge();
        const controller = new AbortController();
        const close = () => controller.abort();
        request.raw.once('aborted', close);
        reply.raw.once('close', close);
        try {
          reply.header('cache-control', 'no-store');
          return await extractDocument(
            app.ctx,
            actor,
            (signal) => readUpload(request, limit, signal),
            controller.signal,
          );
        } catch (error) {
          // An upload left unread, from a refusal or a slow sender, closes its connection.
          const body = request.body as Readable | undefined;
          if (body && !body.readableEnded) reply.header('connection', 'close');
          throw error;
        } finally {
          request.raw.removeListener('aborted', close);
          reply.raw.removeListener('close', close);
        }
      },
    );
  }
}
