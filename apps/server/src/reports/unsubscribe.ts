import { createHmac, timingSafeEqual } from 'node:crypto';
import { REPORT_UNSUBSCRIBE_DAYS } from '@riosoma/contracts';
import { z } from 'zod';

/**
 * The link at the foot of every report email, which stops that one recipient receiving that one
 * report without signing in.  The token names the report and the recipient and says when it
 * stops working, and a signature over all three, keyed from the server's secret, means nobody can
 * make one for somebody else.  An outside address travels only as a keyed digest, so a link that
 * ends up in a proxy's log doesn't give the address away.
 */

export type UnsubscribeRecipient = { kind: 'member'; userId: string } | { kind: 'address'; address: string };

const Claim = z.object({
  /** The report */
  r: z.string().min(1).max(40),
  /** A member's ID */
  u: z.string().min(1).max(40).optional(),
  /** An outside address's digest */
  a: z.string().min(1).max(64).optional(),
  /** When it stops working, in seconds since the epoch */
  e: z.number().int().positive(),
});

export type TokenCheck =
  | {
      ok: true;
      reportId: string;
      recipient: { kind: 'member'; userId: string } | { kind: 'address'; digest: string };
    }
  | { ok: false; reason: 'invalid' | 'expired' };

function subkey(secret: Buffer, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`riosoma.report.${purpose}`).digest();
}

/** The keyed digest an outside address travels as. */
export function addressDigest(secret: Buffer, address: string): string {
  return createHmac('sha256', subkey(secret, 'address')).update(address.toLowerCase()).digest('base64url');
}

function signature(secret: Buffer, payload: string): Buffer {
  return createHmac('sha256', subkey(secret, 'unsubscribe')).update(payload).digest();
}

/** A token for one recipient of one report, working for 90 days from `now`. */
export function unsubscribeToken(
  secret: Buffer,
  reportId: string,
  recipient: UnsubscribeRecipient,
  now = new Date(),
): string {
  const claim = {
    r: reportId,
    ...(recipient.kind === 'member'
      ? { u: recipient.userId }
      : { a: addressDigest(secret, recipient.address) }),
    e: Math.floor(now.getTime() / 1000) + REPORT_UNSUBSCRIBE_DAYS * 86_400,
  };
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${payload}.${signature(secret, payload).toString('base64url')}`;
}

/** Checks a token's signature first, and only then what it says. */
export function checkUnsubscribeToken(secret: Buffer, token: string, now = new Date()): TokenCheck {
  const invalid: TokenCheck = { ok: false, reason: 'invalid' };
  const [payload, signed, ...rest] = token.split('.');
  if (!payload || !signed || rest.length) return invalid;
  const expected = signature(secret, payload);
  const actual = Buffer.from(signed, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return invalid;
  let claim: z.infer<typeof Claim>;
  try {
    claim = Claim.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return invalid;
  }
  if (Boolean(claim.u) === Boolean(claim.a)) return invalid;
  if (claim.e * 1000 <= now.getTime()) return { ok: false, reason: 'expired' };
  return {
    ok: true,
    reportId: claim.r,
    recipient: claim.u ? { kind: 'member', userId: claim.u } : { kind: 'address', digest: claim.a! },
  };
}
