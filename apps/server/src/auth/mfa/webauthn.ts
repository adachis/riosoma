import { createHmac } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { AppError, type PasskeyAssertion, type PasskeyRegistration } from '@riosoma/contracts';
import { z } from 'zod';
import type { AppContext } from '../../app.js';
import { auditEvent, authDatabase } from '../database.js';
import { clearCookie, readCookie, writeCookie, type SealedCookie } from './cookies.js';
import { mfaStore, spend, type PasskeyRow } from './store.js';

/** How long someone has to answer a passkey prompt, and how long its challenge lives. */
export const CHALLENGE_SECONDS = 5 * 60;

/**
 * EdDSA, ES256, and RS256, the keys passkeys use.  Naming them also spares every request the
 * library's probe for newer algorithms, which relies on an experimental runtime feature.
 */
const ALGORITHMS = [-8, -7, -257];

/** Where passkeys belong: the host of the server's public address, and that address's origin. */
export interface RelyingParty {
  id: string;
  origin: string;
  name: string;
}

const LOCAL = /(^|\.)localhost$/;

/**
 * Passkeys need a public address browsers trust with them: https, or plain http on localhost.
 * A relying party is a domain, so an address given as an IP address can't have passkeys either.
 */
export function relyingParty(ctx: AppContext): RelyingParty | null {
  if (!ctx.config.baseUrl) return null;
  let url: URL;
  try {
    url = new URL(ctx.config.baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL.test(host));
  if (!secure || host.startsWith('[') || /^[\d.]+$/.test(host)) return null;
  return { id: host, origin: url.origin, name: 'Riosoma' };
}

export function requireRelyingParty(ctx: AppContext): RelyingParty {
  const rp = relyingParty(ctx);
  if (!rp) throw new AppError('conflict', 'mfa.passkey.unavailable');
  return rp;
}

/**
 * The WebAuthn user handle for a person: the same on every passkey they add, so an authenticator
 * replaces its own older passkey for them rather than keeping two, and nothing personal in it.
 */
export function userHandle(ctx: AppContext, userId: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    createHmac('sha256', ctx.config.secretKey).update(`webauthn-user:${userId}`).digest(),
  );
}

/** What a challenge is for, and whose it is. */
export type ChallengePurpose = 'register' | 'sign-in' | 'second-step' | 'setup' | 'proof';

const Challenge = z.object({
  purpose: z.enum(['register', 'sign-in', 'second-step', 'setup', 'proof']),
  challenge: z.string().min(16).max(200),
  /** The session or the pending sign-in it was issued to, or empty for a passkey sign-in */
  owner: z.string().max(200),
  expires: z.number().int(),
});
type Challenge = z.infer<typeof Challenge>;

const CHALLENGE_COOKIE: SealedCookie<Challenge> = {
  name: 'rio_webauthn',
  context: 'riosoma:webauthn-challenge',
  schema: Challenge,
};

/**
 * Proofs keep a cookie of their own, so a passkey that proves it's you can come with a new
 * passkey's own ceremony, each answering its own challenge.
 */
const PROOF_COOKIE: SealedCookie<Challenge> = {
  name: 'rio_webauthn_proof',
  context: 'riosoma:webauthn-proof',
  schema: Challenge,
};

function cookieFor(purpose: ChallengePurpose): SealedCookie<Challenge> {
  return purpose === 'proof' ? PROOF_COOKIE : CHALLENGE_COOKIE;
}

function challengeFailed(): AppError {
  return new AppError('bad_request', 'mfa.challenge.expired');
}

function remember(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  purpose: ChallengePurpose,
  owner: string,
  challenge: string,
): void {
  const value: Challenge = { purpose, challenge, owner, expires: Date.now() + CHALLENGE_SECONDS * 1000 };
  writeCookie(ctx, request, reply, cookieFor(purpose), value, CHALLENGE_SECONDS);
}

/**
 * The challenge this browser was given for this purpose and owner, used up on the way out: the
 * cookie goes, and the challenge is recorded as spent before anything checks the answer, so a
 * replayed or concurrent answer finds it gone.
 */
export async function takeChallenge(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  purpose: ChallengePurpose,
  owner: string,
): Promise<string> {
  const found = readCookie(ctx, request, cookieFor(purpose));
  clearCookie(ctx, request, reply, cookieFor(purpose));
  const { pool, tables } = mfaStore(ctx);
  // Spent in its own commit, so a refused answer can't take the spending back with it.
  const usable =
    found !== null &&
    found.purpose === purpose &&
    found.owner === owner &&
    (await spend(pool, tables, `challenge:${found.challenge}`, found.expires));
  if (usable) return found.challenge;
  // Missing, expired, meant for something else, or already used: the reason stays vague.
  await auditEvent(pool, authDatabase(ctx).audit, 'auth.passkey.challenge_refused', null, {
    purpose,
    ip: request.ip,
  });
  throw challengeFailed();
}

function descriptors(passkeys: PasskeyRow[]) {
  return passkeys.map((passkey) => ({ id: passkey.credential_id, transports: passkey.transports }));
}

/** Options for adding a passkey.  It must be discoverable and must check who is holding it. */
export async function creationOptions(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  person: { userId: string; email: string; name: string },
  existing: PasskeyRow[],
  purpose: 'register' | 'setup',
  owner: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = requireRelyingParty(ctx);
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.id,
    userName: person.email,
    userDisplayName: person.name || person.email,
    userID: userHandle(ctx, person.userId),
    attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS,
    excludeCredentials: descriptors(existing),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    timeout: CHALLENGE_SECONDS * 1000,
  });
  remember(ctx, request, reply, purpose, owner, options.challenge);
  return options;
}

/** Options for answering with a passkey: any of this server's, or only the ones listed. */
export async function requestOptions(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
  allowed: PasskeyRow[] | null,
  purpose: 'sign-in' | 'second-step' | 'proof',
  owner: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rp = requireRelyingParty(ctx);
  const options = await generateAuthenticationOptions({
    rpID: rp.id,
    ...(allowed ? { allowCredentials: descriptors(allowed) } : {}),
    userVerification: 'required',
    timeout: CHALLENGE_SECONDS * 1000,
  });
  remember(ctx, request, reply, purpose, owner, options.challenge);
  return options;
}

export interface NewPasskey {
  credentialId: string;
  publicKey: Buffer;
  signCount: number;
  transports: string[];
  synced: boolean;
}

/**
 * Checks a new passkey against the challenge, this server's origin and relying party, and the
 * user verification flag.  Null when anything doesn't hold.
 */
export async function verifyNewPasskey(
  rp: RelyingParty,
  response: PasskeyRegistration,
  challenge: string,
): Promise<NewPasskey | null> {
  try {
    const result = await verifyRegistrationResponse({
      response: { ...response, clientExtensionResults: {} },
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    });
    if (!result.verified) return null;
    const { credential, credentialBackedUp } = result.registrationInfo;
    // The ID the browser reported must be the one the authenticator signed for.
    if (credential.id !== response.id) return null;
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      signCount: credential.counter,
      transports: (credential.transports ?? []).slice(0, 10),
      synced: credentialBackedUp,
    };
  } catch {
    return null;
  }
}

/**
 * Checks a passkey's answer: the challenge, the origin, the relying party, user verification, the
 * signature, and a signature counter that has to climb once the authenticator reports one.  The
 * user handle, when the browser sends it, must be the one the passkey was made with.  Answers the
 * counter to store, or null.
 */
export async function verifyPasskeyAnswer(
  rp: RelyingParty,
  response: PasskeyAssertion,
  challenge: string,
  passkey: PasskeyRow,
): Promise<{ signCount: number; synced: boolean } | null> {
  if (response.response.userHandle !== undefined && response.response.userHandle !== passkey.user_handle)
    return null;
  try {
    const result = await verifyAuthenticationResponse({
      response: { ...response, clientExtensionResults: {} },
      expectedChallenge: challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.sign_count),
        transports: passkey.transports,
      },
      requireUserVerification: true,
    });
    if (!result.verified) return null;
    return {
      signCount: result.authenticationInfo.newCounter,
      synced: result.authenticationInfo.credentialBackedUp,
    };
  } catch {
    return null;
  }
}
