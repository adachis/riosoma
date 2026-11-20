import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '@riosoma/contracts';
import { dataStore } from '../../data/context.js';
import { disposition } from '../../data/files/detect.js';
import type { OriginalRow } from '../../data/files/originals.js';
import { fileStorage, redirectDownload, signedDownload, type ByteRange } from '../../data/files/storage.js';

/** Originals use the detected type and attachment download guards while streaming storage bytes. */
export async function downloadOriginal(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  file: OriginalRow & { name: string },
) {
  const length = Number(file.size);
  const etag = `"${file.sha256}"`;
  const attachment = disposition(file.type, file.name);
  reply.headers({
    'content-type': file.type,
    'content-length': length,
    etag,
    'content-disposition': attachment,
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    'cache-control': 'private, max-age=31536000, immutable',
  });
  if (request.headers['if-none-match']?.split(',').some((tag) => tag.trim() === etag)) {
    reply.removeHeader('content-length');
    return reply.code(304).send();
  }
  const { pool, schemas } = dataStore(app.ctx);
  const storage = fileStorage(file.storage, pool, schemas.app, app.ctx.config);
  const location = await signedDownload(storage, file.storage_key, app.ctx.config, {
    type: file.type,
    disposition: attachment,
  });
  if (location) return redirectDownload(reply, location);
  let range: ByteRange | undefined;
  if (file.type.startsWith('audio/') || file.type.startsWith('video/')) {
    reply.header('accept-ranges', 'bytes');
    if (request.headers.range && (!request.headers['if-range'] || request.headers['if-range'] === etag)) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, length - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !length ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= length
      ) {
        reply.removeHeader('content-length');
        reply.header('content-range', `bytes */${length}`);
        return reply
          .code(416)
          .type('application/json')
          .send(new AppError('bad_request', 'data.file.range').toBody());
      }
      range = { start, end };
      reply
        .code(206)
        .header('content-range', `bytes ${start}-${end}/${length}`)
        .header('content-length', end - start + 1);
    }
  }
  // Detected media types retain safe disposition, nosniff, and a sandboxed policy.
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write
  return reply.send(storage.read(file.storage_key, range));
}
