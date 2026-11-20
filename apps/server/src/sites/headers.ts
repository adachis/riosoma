import type { FastifyReply, FastifyRequest } from 'fastify';
import { CHECKOUT_ORIGIN } from '../payments/service.js';

export function siteTransportSecurity(request: FastifyRequest, reply: FastifyReply): void {
  // A custom site's transport policy belongs to that host, regardless of the app's earlier headers.
  if (request.siteDomainSlug) reply.removeHeader('strict-transport-security');
  // Fastify derives the protocol from forwarding headers only for a configured trusted proxy.
  if (request.protocol !== 'https') return;
  reply.header(
    'strict-transport-security',
    request.siteDomainSlug ? 'max-age=31536000' : 'max-age=31536000; includeSubDomains',
  );
}

/**
 * The Content Security Policy of every site response.  Pages load nothing from anywhere else, run
 * no inline script, can't be framed, and submit forms only to the site itself.  `formAction` adds
 * the origins a page's forms may go on to.
 */
export function sitePolicy(formAction: readonly string[] = []): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    "media-src 'self'",
    "connect-src 'self'",
    `form-action ${["'self'", ...formAction].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "worker-src 'none'",
  ].join('; ');
}

const checkouts = new WeakSet<FastifyRequest>();

/**
 * Lets the page answering this request send a form on to Stripe Checkout.  A form that takes
 * payment posts to the site, which answers with a redirect to the checkout, and browsers hold that
 * redirect to the page's `form-action` as well.  So a page with such a form, and only such a page,
 * allows the checkout's origin, and no other, beside the site itself.
 */
export function allowCheckout(request: FastifyRequest): void {
  checkouts.add(request);
}

export function policyFor(request: FastifyRequest): string {
  return checkouts.has(request) ? sitePolicy([CHECKOUT_ORIGIN]) : sitePolicy();
}
