import ssh2, { type ParsedKey } from 'ssh2';

// ssh2 is CommonJS, and Node's ESM loader exposes only its default export.
const { utils } = ssh2;

/**
 * Key material for suites that stand up a real SSH server.  ssh2's ed25519 keygen strips every
 * leading zero byte off the raw public key instead of only the padding byte a DER bit string
 * carries, so about one generated pair in 256 comes back a byte short and neither half parses,
 * with parseKey answering "Malformed OpenSSH public key" for a key it just made.  Which bytes a
 * test key holds changes nothing about what these suites check, so a pair is handed out only after
 * both halves parse, agree, and pass a signature round trip.  The `.test-helpers.ts` name keeps
 * this file out of the published build.  It holds no tests of its own, and importing it from a
 * suite must not add any.
 */

export interface SshKeyPair {
  private: string;
  public: string;
}

export interface SshKeyOptions {
  /** Encrypts the private key, as a key handed to a bastion usually is */
  passphrase?: string;
  /** Cipher for an encrypted private key, `aes256-cbc` by default */
  cipher?: string;
  /** Key derivation rounds for an encrypted private key, kept low so a suite loads fast */
  rounds?: number;
}

// Every candidate pair signs this, and its public half has to verify the signature.
const challenge = Buffer.from('riosoma ssh test key');

function pairHoldsTogether(pair: SshKeyPair, passphrase?: string): boolean {
  const pub = utils.parseKey(pair.public);
  const priv = utils.parseKey(pair.private, passphrase);
  if (pub instanceof Error || priv instanceof Error) return false;
  if (!priv.isPrivateKey()) return false;
  if (!pub.getPublicSSH().equals(priv.getPublicSSH())) return false;
  return pub.verify(challenge, priv.sign(challenge));
}

/** Generates an ed25519 pair that parses, retrying past the rare short key ssh2 can produce. */
export function sshKeyPair(options: SshKeyOptions = {}): SshKeyPair {
  // A short key is one attempt in 256, so the first pair is nearly always the one, and 64 tries
  // would only run out if key generation broke outright rather than drifting.
  for (let attempt = 0; attempt < 64; attempt++) {
    const pair = options.passphrase
      ? utils.generateKeyPairSync('ed25519', {
          passphrase: options.passphrase,
          cipher: options.cipher ?? 'aes256-cbc',
          rounds: options.rounds ?? 16,
        })
      : utils.generateKeyPairSync('ed25519');
    if (pairHoldsTogether(pair, options.passphrase)) return pair;
  }
  throw new Error('SSH key generation kept producing ed25519 keys that do not parse');
}

/** Parses a key these helpers produced, so a suite need not repeat the error check. */
export function parseSshKey(key: string, passphrase?: string): ParsedKey {
  const parsed = utils.parseKey(key, passphrase);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}
