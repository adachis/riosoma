import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AppContext } from '../../app.js';
import { seal, unseal } from '../../secrets.js';

/**
 * Short-lived state the browser carries between two requests, sealed with the instance key so it
 * can be neither read nor forged, and HttpOnly so page scripts never see it.  Strict same-site:
 * every request that needs it comes from Riosoma's own pages.
 */
export interface SealedCookie<T> {
  name: string;
  /** Bound as associated data, so a value sealed for one cookie can't be replayed as another */
  context: string;
  schema: z.ZodType<T>;
}

function cookieName(request: FastifyRequest, name: string): string {
  return request.protocol === 'https' ? `__Host-${name}` : name;
}

function cookieOptions(request: FastifyRequest) {
  return {
    httpOnly: true,
    // Match session cookies so local HTTP can carry a challenge in every browser.
    secure: request.protocol === 'https',
    sameSite: 'strict' as const,
    path: '/',
  };
}

export function writeCookie<T>(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  cookie: SealedCookie<T>,
  value: T,
  seconds: number,
): void {
  reply.setCookie(
    cookieName(request, cookie.name),
    seal(ctx.config.secretKey, JSON.stringify(value), cookie.context),
    { ...cookieOptions(request), maxAge: seconds },
  );
}

/** The value, or null when the cookie is missing, altered, or past the expiry sealed inside it. */
export function readCookie<T extends { expires: number }>(
  ctx: AppContext,
  request: FastifyRequest,
  cookie: SealedCookie<T>,
): T | null {
  const sealed = request.cookies[cookieName(request, cookie.name)];
  if (!sealed) return null;
  try {
    const parsed = cookie.schema.safeParse(JSON.parse(unseal(ctx.config.secretKey, sealed, cookie.context)));
    return parsed.success && parsed.data.expires > Date.now() ? parsed.data : null;
  } catch {
    return null;
  }
}

export function clearCookie<T>(
  _ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  cookie: SealedCookie<T>,
): void {
  reply.clearCookie(cookieName(request, cookie.name), cookieOptions(request));
}
