import { z } from 'zod';
import type { SessionInfo } from './auth.js';

/**
 * Passkeys and two-step sign-in.
 *
 * A passkey signs someone in on its own, because the device checks who is holding it.  After a
 * password, an emailed link, or an invitation, someone with a second step (a passkey or an
 * authenticator app) gets a short-lived pending state instead of a session, and only the
 * second-step routes accept it until one of their second steps passes.  Recovery codes stand in
 * for a second step that's out of reach, and each one works once.  An organization can require a
 * second step of its admins or of everyone: someone who has none then signs in only to add one.
 * Single sign-on leaves the second step to the identity provider.
 *
 * WebAuthn options travel in their standard JSON forms (`PublicKeyCredentialCreationOptionsJSON`
 * and `PublicKeyCredentialRequestOptionsJSON`).  Every challenge is bound to the browser by a
 * sealed, short-lived cookie, so the options calls take no body.
 *
 * Routes for signing in (public):
 * - `POST /api/auth/passkey/options` → request options for any passkey on this server
 * - `POST /api/auth/passkey` (`PasskeySignIn`) → `SessionInfo`
 * - `GET /api/auth/second-step` → `SecondStepStatus`, the pending state if there is one
 * - `POST /api/auth/second-step/options` → request options for the pending person's passkeys
 * - `POST /api/auth/second-step` (`SecondStepProof`) → `SessionInfo`
 * - `DELETE /api/auth/second-step` → 204, forgetting the pending state
 * - `POST /api/auth/second-step/passkeys/options`, `POST /api/auth/second-step/passkeys`
 *   (`PasskeyCreate`), `POST /api/auth/second-step/authenticator` → `AuthenticatorSetup`, and
 *   `POST /api/auth/second-step/authenticator/confirm` (`AuthenticatorConfirm`) add a first second
 *   step when the organization requires one, and answer `SecondStepSetupDone`
 *
 * Routes for your own second steps (session).  A session alone never adds a way in or takes one
 * away from someone who has a second step: those changes carry a fresh one in `proof`, checked in
 * the same transaction as the change.
 * - `GET /api/me/mfa` → `MfaOverview`
 * - `POST /api/me/mfa/passkeys/options` → creation options for a new passkey
 * - `POST /api/me/mfa/passkeys` (`PasskeyAdd`) → `PasskeyAdded`.  Needs `proof` once the person has
 *   a second step.
 * - `PATCH /api/me/mfa/passkeys/:passkeyId` (`PasskeyRename`) → `Passkey`
 * - `DELETE /api/me/mfa/passkeys/:passkeyId` (`MfaRemoval`) → 204.  Removing the last second step
 *   needs a fresh one in `proof`.
 * - `POST /api/me/mfa/authenticator` → `AuthenticatorSetup`.  With an app already on, this starts
 *   its replacement, and the app that's on keeps working until the new one is confirmed.
 * - `POST /api/me/mfa/authenticator/confirm` (`AuthenticatorTurnOn`) → `AuthenticatorConfirmed`.
 *   Needs `proof` once the person has a second step, replacing an app included.
 * - `DELETE /api/me/mfa/authenticator` (`MfaRemoval`, with `proof`) → 204
 * - `POST /api/me/mfa/recovery-codes` (`FreshProof`, with `proof`) → `RecoveryCodes`, replacing any
 *   earlier set
 * - `POST /api/me/mfa/proof/options` → request options for proving it's you with a passkey
 *
 * Routes for administrators (Security area):
 * - `GET /api/admin/mfa/policy`, `PUT /api/admin/mfa/policy` (`MfaPolicyUpdate`) → `MfaPolicy`
 * - `DELETE /api/admin/mfa/people/:userId` → 204, removing that person's second steps and ending
 *   their sessions
 */

/** Who must use a second step: nobody, owners and admins, or everyone in the organization. */
export const SECOND_STEP_POLICIES = ['off', 'admins', 'everyone'] as const;
export const SecondStepPolicy = z.enum(SECOND_STEP_POLICIES);
export type SecondStepPolicy = z.infer<typeof SecondStepPolicy>;

export const SECOND_STEP_METHODS = ['passkey', 'authenticator', 'recovery'] as const;
export type SecondStepMethod = (typeof SECOND_STEP_METHODS)[number];

/** How many recovery codes each set has. */
export const RECOVERY_CODE_COUNT = 10;

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const CredentialId = Base64Url.max(1400);

/** A new passkey as the browser reports it: `RegistrationResponseJSON`. */
export const PasskeyRegistration = z.object({
  id: CredentialId,
  rawId: CredentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: Base64Url.max(4096),
    attestationObject: Base64Url.max(65_536),
    authenticatorData: Base64Url.max(65_536).optional(),
    transports: z.array(z.string().max(40)).max(10).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: Base64Url.max(4096).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export type PasskeyRegistration = z.infer<typeof PasskeyRegistration>;

/** A passkey's answer to a challenge as the browser reports it: `AuthenticationResponseJSON`. */
export const PasskeyAssertion = z.object({
  id: CredentialId,
  rawId: CredentialId,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: Base64Url.max(4096),
    authenticatorData: Base64Url.max(4096),
    signature: Base64Url.max(4096),
    userHandle: Base64Url.max(128).optional(),
  }),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
});
export type PasskeyAssertion = z.infer<typeof PasskeyAssertion>;

export const PasskeyName = z.string().trim().min(1).max(60);

export const PasskeyCreate = z.object({ name: PasskeyName, response: PasskeyRegistration });
export type PasskeyCreate = z.infer<typeof PasskeyCreate>;

export const PasskeyRename = z.object({ name: PasskeyName });
export type PasskeyRename = z.infer<typeof PasskeyRename>;

export const PasskeySignIn = z.object({ response: PasskeyAssertion });
export type PasskeySignIn = z.infer<typeof PasskeySignIn>;

/** Six digits from an authenticator app.  Spaces don't matter. */
export const AuthenticatorCode = z
  .string()
  .max(20)
  .transform((value) => value.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/));

/** A recovery code as someone types it.  Case, spaces, and hyphens don't matter. */
export const RecoveryCode = z
  .string()
  .max(64)
  .transform((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ''))
  .pipe(z.string().length(10));

/** Something only the person has: a code from their app, a recovery code, or a passkey. */
export const SecondStepProof = z.discriminatedUnion('method', [
  z.object({ method: z.literal('authenticator'), code: AuthenticatorCode }),
  z.object({ method: z.literal('recovery'), code: RecoveryCode }),
  z.object({ method: z.literal('passkey'), response: PasskeyAssertion }),
]);
export type SecondStepProof = z.input<typeof SecondStepProof>;

/** Removing a second step.  A fresh proof is needed to turn off the app or remove the last one. */
export const MfaRemoval = z.object({ proof: SecondStepProof.optional() });
export type MfaRemoval = z.input<typeof MfaRemoval>;

export const AuthenticatorConfirm = z.object({ code: AuthenticatorCode });
export type AuthenticatorConfirm = z.input<typeof AuthenticatorConfirm>;

/** A fresh second step sent with a change, which the change needs once someone has one. */
export const FreshProof = z.object({ proof: SecondStepProof.optional() });
export type FreshProof = z.input<typeof FreshProof>;

/** A new passkey from a session, with a fresh second step when the person already has one. */
export const PasskeyAdd = PasskeyCreate.extend(FreshProof.shape);
export type PasskeyAdd = z.input<typeof PasskeyAdd>;

/** Turning on an app from a session, with a fresh second step when the person already has one. */
export const AuthenticatorTurnOn = AuthenticatorConfirm.extend(FreshProof.shape);
export type AuthenticatorTurnOn = z.input<typeof AuthenticatorTurnOn>;

/** A new authenticator app secret, waiting for its first code. */
export interface AuthenticatorSetup {
  /** The base32 secret, for typing into the app by hand */
  secret: string;
  /** The `otpauth://` address the QR code carries */
  uri: string;
}

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** The passkey syncs between devices, so losing one device doesn't lose it */
  synced: boolean;
}

export interface MfaOverview {
  passkeys: Passkey[];
  authenticator: { enabled: boolean; since: string | null; lastUsedAt: string | null };
  recoveryCodes: { remaining: number; createdAt: string | null };
  /** The organization asks this person for a second step */
  required: boolean;
  /** Passkeys work only when the server's public address is secure: https, or localhost */
  passkeysAvailable: boolean;
}

/** A new set of recovery codes, shown this once. */
export interface RecoveryCodes {
  codes: string[];
}

/** A first second step comes with recovery codes.  Later ones don't. */
export interface PasskeyAdded {
  passkey: Passkey;
  recoveryCodes: string[] | null;
}

export interface AuthenticatorConfirmed {
  recoveryCodes: string[] | null;
}

export interface SecondStep {
  /** `verify` asks for a second step the person has, `setup` for adding a first one */
  stage: 'verify' | 'setup';
  /** How the person can finish, or for `setup`, what they can add */
  methods: SecondStepMethod[];
  /** Who is signing in */
  email: string;
  expiresAt: string;
}

export interface SecondStepRequired {
  secondStep: SecondStep;
}

export interface SecondStepStatus {
  secondStep: SecondStep | null;
}

/** What a password, an emailed link, or an invitation answers. */
export type SignInResult = SessionInfo | SecondStepRequired;

export function needsSecondStep(result: SignInResult): result is SecondStepRequired {
  return 'secondStep' in result;
}

/** Adding a first second step during sign-in finishes signing in. */
export interface SecondStepSetupDone {
  session: SessionInfo;
  recoveryCodes: string[];
}

export const MfaPolicyUpdate = z.object({ policy: SecondStepPolicy });
export type MfaPolicyUpdate = z.infer<typeof MfaPolicyUpdate>;

export interface MfaPolicy {
  policy: SecondStepPolicy;
}
