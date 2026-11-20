import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { api, ApiError } from '../../api';
import { errorInfo } from '../setup/useSetup';

/**
 * Passkeys in the browser.  The server hands out options with a challenge bound to this browser,
 * the browser asks the person's device, and the answer goes back to the server to check.
 */

export function passkeysSupported(): boolean {
  return browserSupportsWebAuthn();
}

/** Whether the browser can offer passkeys among the email field's suggestions. */
export function passkeyAutofillSupported(): Promise<boolean> {
  return browserSupportsWebAuthnAutofill().catch(() => false);
}

/** Asks the server for the options, then the device for a new passkey. */
export async function createPasskey(optionsPath: string): Promise<RegistrationResponseJSON> {
  const optionsJSON = await api<PublicKeyCredentialCreationOptionsJSON>(optionsPath, { method: 'POST' });
  return startRegistration({ optionsJSON });
}

/** Asks the server for the options, then the device for a passkey's answer. */
export async function answerWithPasskey(optionsPath: string): Promise<AuthenticationResponseJSON> {
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(optionsPath, { method: 'POST' });
  return startAuthentication({ optionsJSON });
}

/**
 * Offers this server's passkeys among the email field's suggestions and waits for the person to
 * pick one.  Aborting the signal stops the wait, including before the browser was ever asked.
 */
export async function passkeyFromAutofill(
  optionsPath: string,
  signal: AbortSignal,
): Promise<AuthenticationResponseJSON | null> {
  if (!(await passkeyAutofillSupported()) || signal.aborted) return null;
  const optionsJSON = await api<PublicKeyCredentialRequestOptionsJSON>(optionsPath, {
    method: 'POST',
    signal,
  });
  if (signal.aborted) return null;
  return startAuthentication({ optionsJSON, useBrowserAutofill: true });
}

/** Stops a passkey prompt that's still waiting, such as the one behind the email field. */
export function cancelPasskeyPrompt(): void {
  WebAuthnAbortService.cancelCeremony();
}

/** The prompt was closed or replaced: nothing went wrong, so there's nothing to say. */
function interrupted(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

const CLOSED = msg({
  id: 'mfa.prompt.closed',
  message: 'The passkey prompt closed before it finished.  Try again when you’re ready.',
});
const KNOWN = msg({ id: 'mfa.prompt.known', message: 'That device already has a passkey for your account.' });
const FAILED = msg({ id: 'mfa.prompt.failed', message: 'Your browser couldn’t use a passkey just now.' });

/**
 * What to tell the person when a passkey didn't work in the browser.  A server's refusal comes back
 * as an ApiError, which the caller shows as it shows any other.  Null when there's nothing to say.
 */
export function passkeyProblem(error: unknown): MessageDescriptor | null {
  if (!error || error instanceof ApiError || interrupted(error)) return null;
  if (error instanceof Error && error.name === 'NotAllowedError') return CLOSED;
  if (error instanceof Error && error.name === 'InvalidStateError') return KNOWN;
  return FAILED;
}

/** The first of these that the server refused, ready for an ErrorBanner, or null. */
export function serverRefusal(...errors: unknown[]) {
  return errorInfo(errors.find((error) => error instanceof ApiError) ?? null);
}
