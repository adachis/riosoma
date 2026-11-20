import { vi } from 'vitest';

/**
 * A browser with passkeys, for tests: `PublicKeyCredential` exists, conditional mediation can be
 * switched on, and `navigator.credentials` answers with credentials made up on the spot.  A
 * conditional request waits until it's aborted, as a real one waits for the person to choose.
 */

function bytes(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function fakeAssertion(id = 'passkey-one') {
  return {
    id: btoa(id).replace(/=+$/, ''),
    rawId: bytes(id),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.get"}'),
      authenticatorData: bytes('authenticator data'),
      signature: bytes('signature'),
      userHandle: bytes('user handle'),
    },
    getClientExtensionResults: () => ({}),
  };
}

export function fakeRegistration(id = 'passkey-new') {
  return {
    id: btoa(id).replace(/=+$/, ''),
    rawId: bytes(id),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: bytes('{"type":"webauthn.create"}'),
      attestationObject: bytes('attestation'),
      getTransports: () => ['internal'],
    },
    getClientExtensionResults: () => ({}),
  };
}

/** Options as the server would send them, enough for the browser library to accept. */
export const REQUEST_OPTIONS = {
  challenge: 'Y2hhbGxlbmdlLWZvci10ZXN0cw',
  rpId: 'riosoma.example.test',
  userVerification: 'required',
  timeout: 300_000,
};

export const CREATION_OPTIONS = {
  challenge: 'Y2hhbGxlbmdlLWZvci10ZXN0cw',
  rp: { name: 'Riosoma', id: 'riosoma.example.test' },
  user: { id: 'dXNlci1oYW5kbGU', name: 'ada@example.com', displayName: 'Ada' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  attestation: 'none',
  timeout: 300_000,
};

export interface FakeWebAuthn {
  get: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  restore(): void;
}

export function fakeWebAuthn(options: { autofill?: boolean } = {}): FakeWebAuthn {
  class FakePublicKeyCredential {
    static isConditionalMediationAvailable = () => Promise.resolve(options.autofill ?? false);
  }
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
  const get = vi.fn((request: CredentialRequestOptions) => {
    if (request.mediation === 'conditional')
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    return Promise.resolve(fakeAssertion());
  });
  const create = vi.fn(() => Promise.resolve(fakeRegistration()));
  const had = Object.getOwnPropertyDescriptor(navigator, 'credentials');
  Object.defineProperty(navigator, 'credentials', { value: { get, create }, configurable: true });
  return {
    get,
    create,
    restore() {
      if (had) Object.defineProperty(navigator, 'credentials', had);
      else Reflect.deleteProperty(navigator, 'credentials');
    },
  };
}
