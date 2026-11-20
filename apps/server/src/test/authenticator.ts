import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

type Cbor = Parameters<typeof isoCBOR.encode>[0];

/** Authenticator data flags, from the WebAuthn specification. */
export const FLAGS = {
  userPresent: 0x01,
  userVerified: 0x04,
  backupEligible: 0x08,
  backedUp: 0x10,
  attestedCredential: 0x40,
} as const;

export interface CreationOptions {
  challenge: string;
  rp: { id?: string };
  user: { id: string };
}

export interface RequestOptions {
  challenge: string;
  rpId?: string;
}

/** Ways a test can make an answer go wrong. */
export interface Tampering {
  origin?: string;
  rpId?: string;
  challenge?: string;
  flags?: number;
  counter?: number;
  userHandle?: string;
  type?: string;
}

function b64(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64url');
}

function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

/**
 * A software passkey: an ES256 key pair made with `node:crypto`, answering the way a browser and
 * its authenticator would.  Registration returns a `none` attestation and the credential's COSE
 * public key.  Each answer is signed over the authenticator data and the hash of the client data,
 * exactly as the WebAuthn specification lays them out.
 */
export class TestAuthenticator {
  readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly synced: boolean;
  /** The signature counter it reports.  Zero stays zero, as many synced passkeys do. */
  counter: number;
  /** The user handle it was registered with, which it repeats when it signs in */
  userHandle: string | undefined;

  constructor(
    readonly origin: string,
    options: { counter?: number; synced?: boolean } = {},
  ) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
    this.counter = options.counter ?? 0;
    this.synced = options.synced ?? false;
  }

  get id(): string {
    return b64(this.credentialId);
  }

  private flags(base: number): number {
    return base | (this.synced ? FLAGS.backupEligible | FLAGS.backedUp : 0);
  }

  private coseKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: 'jwk' });
    const key = new Map<number, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, 'base64url')],
      [-3, Buffer.from(jwk.y!, 'base64url')],
    ]);
    return isoCBOR.encode(key);
  }

  private clientData(type: string, challenge: string, origin: string): string {
    return b64(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The browser's answer to creation options. */
  register(options: CreationOptions, tamper: Tampering = {}) {
    const rpId = tamper.rpId ?? options.rp.id ?? '';
    this.userHandle = options.user.id;
    const credentialLength = Buffer.alloc(2);
    credentialLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([
        tamper.flags ?? this.flags(FLAGS.userPresent | FLAGS.userVerified | FLAGS.attestedCredential),
      ]),
      uint32(tamper.counter ?? this.counter),
      Buffer.alloc(16),
      credentialLength,
      this.credentialId,
      this.coseKey(),
    ]);
    const attestation = new Map<string, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map<string, Cbor>()],
      ['authData', authData],
    ]);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: this.clientData(
          tamper.type ?? 'webauthn.create',
          tamper.challenge ?? options.challenge,
          tamper.origin ?? this.origin,
        ),
        attestationObject: b64(isoCBOR.encode(attestation)),
        transports: ['internal', 'hybrid'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The browser's answer to request options, counting up first when the counter is running. */
  answer(options: RequestOptions, tamper: Tampering = {}) {
    if (this.counter > 0 && tamper.counter === undefined) this.counter += 1;
    const rpId = tamper.rpId ?? options.rpId ?? '';
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([tamper.flags ?? this.flags(FLAGS.userPresent | FLAGS.userVerified)]),
      uint32(tamper.counter ?? this.counter),
    ]);
    const clientDataJSON = this.clientData(
      tamper.type ?? 'webauthn.get',
      tamper.challenge ?? options.challenge,
      tamper.origin ?? this.origin,
    );
    const signature = sign(
      'sha256',
      Buffer.concat([authData, sha256(Buffer.from(clientDataJSON, 'base64url'))]),
      this.privateKey,
    );
    const userHandle = tamper.userHandle ?? this.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON,
        authenticatorData: b64(authData),
        signature: b64(signature),
        ...(userHandle === undefined ? {} : { userHandle }),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
