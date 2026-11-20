import { z } from 'zod';
import type { SealedCookie } from './mfa/cookies.js';

export const INVITATION_COOKIE: SealedCookie<{ token: string; expires: number }> = {
  name: 'rio_invitation',
  context: 'riosoma:invitation',
  schema: z.object({ token: z.string().min(20).max(200), expires: z.number() }),
};
