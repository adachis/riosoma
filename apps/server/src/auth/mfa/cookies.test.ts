import { randomBytes } from 'node:crypto';
import cookiePlugin from '@fastify/cookie';
import Fastify from 'fastify';
import { z } from 'zod';
import { expect, it } from 'vitest';
import type { AppContext } from '../../app.js';
import { clearCookie, readCookie, writeCookie } from './cookies.js';

it.each(['http', 'https'])(
  'carries sign-in challenges over %s using the session transport rules',
  async (protocol) => {
    const app = Fastify({ trustProxy: true });
    const ctx = { config: { production: true, secretKey: randomBytes(32) } } as AppContext;
    const challenge = {
      name: 'rio_webauthn',
      context: 'riosoma:webauthn-challenge',
      schema: z.object({ expires: z.number(), challenge: z.string() }),
    };
    const value = { expires: Date.now() + 300_000, challenge: randomBytes(32).toString('base64url') };
    await app.register(cookiePlugin);
    app.post('/challenge', (request, reply) => {
      writeCookie(ctx, request, reply, challenge, value, 300);
      return { ok: true };
    });
    app.get('/challenge', (request) => readCookie(ctx, request, challenge));
    app.delete('/challenge', (request, reply) => {
      clearCookie(ctx, request, reply, challenge);
      return { ok: true };
    });
    try {
      const headers = { 'x-forwarded-proto': protocol };
      const written = await app.inject({ method: 'POST', url: '/challenge', headers });
      const cookie = String(written.headers['set-cookie']);
      const name = protocol === 'https' ? '__Host-rio_webauthn' : 'rio_webauthn';
      expect(cookie.startsWith(`${name}=`)).toBe(true);
      expect(cookie.includes('; Secure')).toBe(protocol === 'https');
      expect(cookie).toContain('; HttpOnly');
      expect(cookie).toContain('; SameSite=Strict');
      const read = await app.inject({
        url: '/challenge',
        headers: { ...headers, cookie: cookie.split(';')[0]! },
      });
      expect(read.json()).toEqual(value);
      const cleared = await app.inject({ method: 'DELETE', url: '/challenge', headers });
      expect(String(cleared.headers['set-cookie']).startsWith(`${name}=`)).toBe(true);
      expect(String(cleared.headers['set-cookie']).includes('; Secure')).toBe(protocol === 'https');
    } finally {
      await app.close();
    }
  },
);
