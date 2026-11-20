import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { ConnectorError } from './types.js';

/** What an Oracle wallet's `ewallet.pem` holds: trusted certificates, and a client key and its certificate. */
export interface WalletParts {
  ca: string[];
  cert?: string;
  key?: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]+?-----END \1-----/g;

function certificatesIn(pem: string): string[] {
  return [...pem.matchAll(PEM_BLOCK)].filter((block) => block[1] === 'CERTIFICATE').map((block) => block[0]);
}

/**
 * Splits a PEM wallet into its parts.  A private key, decrypted with the password when it has one,
 * travels with the certificate that matches it, and every other certificate is trusted.
 */
export function walletParts(pem: string, password?: string): WalletParts {
  const certificates = certificatesIn(pem);
  const keyBlock = [...pem.matchAll(PEM_BLOCK)].find((block) => /PRIVATE KEY$/.test(block[1]!))?.[0];
  if (!keyBlock) return { ca: certificates };
  let key;
  try {
    key = createPrivateKey({ key: keyBlock, format: 'pem', passphrase: password });
  } catch (error) {
    throw new ConnectorError(
      'sources.test.tls',
      `The TLS wallet's key could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const cert = certificates.find((certificate) => new X509Certificate(certificate).checkPrivateKey(key));
  if (!cert)
    throw new ConnectorError('sources.test.tls', 'The TLS wallet holds a key without its certificate.');
  return {
    ca: certificates.filter((certificate) => certificate !== cert),
    cert,
    key: String(key.export({ type: 'pkcs8', format: 'pem' })),
  };
}

// A certificate is a little DER: enough of it to wrap a public key and sign it with its own key.
function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const length: number[] = [];
  for (let rest = content.length; rest > 0; rest >>= 8) length.unshift(rest & 0xff);
  const header = content.length < 0x80 ? [content.length] : [0x80 | length.length, ...length];
  return Buffer.concat([Buffer.from([tag, ...header]), content]);
}
function oid(text: string): Buffer {
  const [first = 0, second = 0, ...rest] = text.split('.').map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const encoded = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) encoded.unshift(0x80 | (value & 0x7f));
    bytes.push(...encoded);
  }
  return der(0x06, Buffer.from(bytes));
}
function generalizedTime(date: Date): Buffer {
  return der(0x18, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`));
}

/** A self-signed certificate for `commonName`, valid from a minute ago for ten years, and its key. */
export function selfSigned(commonName: string): { cert: string; key: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = der(0x30, oid('1.2.840.10045.4.3.2'));
  const name = der(0x30, der(0x31, der(0x30, oid('2.5.4.3'), der(0x0c, Buffer.from(commonName)))));
  // DER writes a positive integer without leading zeros, so the first byte is nonzero and below 0x80.
  const serial = randomBytes(8);
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const now = Date.now();
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, serial),
    algorithm,
    name,
    der(0x30, generalizedTime(new Date(now - 60_000)), generalizedTime(new Date(now + 3650 * 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const body = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body
      .toString('base64')
      .match(/.{1,64}/g)!
      .join('\n')}\n-----END CERTIFICATE-----\n`,
    key: String(privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
}

/**
 * The wallet the driver's own TLS reads: a client certificate and key first, the way Node takes a
 * chain, then every trusted certificate.  Undefined when there's nothing to trust but the
 * platform's own authorities and no client key, which the driver then uses.  With
 * `requireAuthority`, for checking a certificate without its name, the platform's authorities
 * aren't enough, since any certificate they sign for any name would pass.
 */
export function walletContent(
  caPem?: string,
  wallet?: string,
  walletPassword?: string,
  requireAuthority = false,
): string | undefined {
  if (caPem?.trim() && !certificatesIn(caPem).length)
    throw new ConnectorError(
      'sources.test.tls',
      'The trusted certificate authorities hold no TLS certificate.',
    );
  const parts = wallet ? walletParts(wallet, walletPassword) : { ca: [] };
  const trusted = [...(caPem ? certificatesIn(caPem) : []), ...parts.ca];
  if (requireAuthority && !trusted.length)
    throw new ConnectorError(
      'sources.test.tls',
      'Checking the TLS certificate without its name needs an authority of your own, from the trusted certificate authorities or a wallet.',
    );
  if (!trusted.length && !parts.key) return undefined;
  // The driver loads a wallet's trusted certificates only alongside a client key, so a wallet of
  // trusted certificates alone carries a throwaway one, made for this connection, which no server
  // trusts.
  const identity =
    parts.cert && parts.key ? { cert: parts.cert, key: parts.key } : selfSigned('Riosoma placeholder');
  return [identity.cert, identity.key, ...trusted].map((block) => `${block.trim()}\n`).join('');
}
