import { createHash } from 'node:crypto';
import type { FastifyReply } from 'fastify';

// The built shell carries its startup recovery inline, so recovery needs no request of its own.
const RECOVERY = /<script id="rio-startup-recovery">([\s\S]*?)<\/script>/;

/**
 * Sends the app shell and allows its recovery script by hash.  The hash comes from the same read
 * as the body, so a rebuilt shell never pairs with an old policy.  Only the server's own shell
 * gets one, so no other HTML can authorize an inline script this way.
 */
export function sendShell(reply: FastifyReply, html: string): FastifyReply {
  const script = RECOVERY.exec(html)?.[1];
  const policy = reply.getHeader('content-security-policy');
  if (script !== undefined && typeof policy === 'string') {
    // Browsers hash the script text after normalizing its line breaks.
    const hash = createHash('sha256').update(script.replace(/\r\n?/g, '\n')).digest('base64');
    reply.header(
      'content-security-policy',
      policy.replace(/(^|;\s*)(script-src [^;]+)/, `$1$2 'sha256-${hash}'`),
    );
  }
  reply.type('text/html; charset=utf-8');
  // The router trims HEAD answers for its routes, but not for the not-found handler.
  if (reply.request.method === 'HEAD' && reply.request.is404)
    return reply.header('content-length', String(Buffer.byteLength(html))).send();
  return reply.send(html);
}
