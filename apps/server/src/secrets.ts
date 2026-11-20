import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Instance-local values use individual data keys, wrapped by the instance key
 * The context binds their owner and purpose, including temporary sign-in state
 */
const PREFIX = 'rio1.';
const TAG_LENGTH = 16;

export function seal(key: Buffer, plaintext: string, context: string): string {
  const dataKey = randomBytes(32);
  try {
    const value = encrypt(dataKey, Buffer.from(plaintext, 'utf8'), context);
    const wrapped = encrypt(key, dataKey, JSON.stringify(['wrap', context, value.toString('base64url')]));
    return `${PREFIX}e2.${Buffer.concat([wrapped, value]).toString('base64url')}`;
  } finally {
    dataKey.fill(0);
  }
}

function encrypt(key: Buffer, plaintext: Buffer, context: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function unseal(key: Buffer, sealed: string, context: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error('Not a sealed value');
  if (sealed.startsWith(`${PREFIX}e2.`)) {
    const raw = Buffer.from(sealed.slice(8), 'base64url');
    if (raw.length < 88) throw new Error('credentials.unavailable');
    const value = raw.subarray(60);
    const dataKey = decrypt(
      key,
      raw.subarray(0, 60),
      JSON.stringify(['wrap', context, value.toString('base64url')]),
    );
    try {
      return decrypt(dataKey, value, context).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }
  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  return decrypt(key, raw, context).toString('utf8');
}

function decrypt(key: Buffer, raw: Buffer, context: string): Buffer {
  if (raw.length < 28) throw new Error('credentials.unavailable');
  // Pin the tag length, or a truncated tag would be accepted and weaken the check.
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12), { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(12, 12 + TAG_LENGTH));
  return Buffer.concat([decipher.update(raw.subarray(12 + TAG_LENGTH)), decipher.final()]);
}
