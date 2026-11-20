import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { AppError, type PushSubscriptionInput } from '@riosoma/contracts';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export function createVapidKeys(): VapidKeys {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return {
    publicKey: key.getPublicKey().toString('base64url'),
    privateKey: key.getPrivateKey().toString('base64url'),
  };
}

/** Only browser push services receive subscription requests, including after redirects. */
export function pushEndpointAllowed(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const host = url.hostname;
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (host === 'fcm.googleapis.com' ||
        host === 'updates.push.services.mozilla.com' ||
        host === 'web.push.apple.com' ||
        host.endsWith('.notify.windows.com'))
    );
  } catch {
    return false;
  }
}

export function validatePushSubscription(subscription: PushSubscriptionInput): void {
  if (!pushEndpointAllowed(subscription.endpoint))
    throw new AppError('validation_failed', 'notifications.push.invalid');
  try {
    const key = createECDH('prime256v1');
    key.generateKeys();
    const publicKey = Buffer.from(subscription.keys.p256dh, 'base64url');
    if (
      publicKey.length !== 65 ||
      publicKey[0] !== 4 ||
      Buffer.from(subscription.keys.auth, 'base64url').length !== 16
    )
      throw new Error();
    key.computeSecret(publicKey);
  } catch {
    throw new AppError('validation_failed', 'notifications.push.invalid');
  }
}

/** RFC 8291 uses a fresh ECDH key and salt for each encrypted, single-record message. */
export function encryptPush(subscription: PushSubscriptionInput, payload: PushPayload): Buffer {
  const receiver = Buffer.from(subscription.keys.p256dh, 'base64url');
  const sender = createECDH('prime256v1');
  sender.generateKeys();
  const publicKey = sender.getPublicKey();
  const salt = randomBytes(16);
  const ikm = hkdfSync(
    'sha256',
    sender.computeSecret(receiver),
    Buffer.from(subscription.keys.auth, 'base64url'),
    Buffer.concat([Buffer.from('WebPush: info\0'), receiver, publicKey]),
    32,
  );
  const key = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdfSync('sha256', Buffer.from(ikm), salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.from(JSON.stringify({ title: payload.title, body: payload.body, url: payload.url }));
  if (plain.length > 3993) throw new AppError('validation_failed', 'notifications.push.invalid');
  const cipher = createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(nonce));
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = publicKey.length;
  return Buffer.concat([
    header,
    publicKey,
    cipher.update(Buffer.concat([plain, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export function vapidAuthorization(
  keys: VapidKeys,
  endpoint: string,
  subject: string,
  now = Date.now(),
): string {
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  const privateKey = createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33).toString('base64url'),
    },
  });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: subject })}`;
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`;
}

export async function sendPush(
  subscription: PushSubscriptionInput,
  keys: VapidKeys,
  payload: PushPayload,
  subject: string,
  request: typeof fetch = fetch,
): Promise<'sent' | 'expired'> {
  validatePushSubscription(subscription);
  const response = await request(subscription.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: vapidAuthorization(keys, subscription.endpoint, subject),
      TTL: '3600',
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
    },
    body: new Uint8Array(encryptPush(subscription, payload)),
  });
  await response.body?.cancel();
  if (response.status === 404 || response.status === 410) return 'expired';
  if (!response.ok) throw new AppError('unavailable', 'notifications.delivery.failed');
  return 'sent';
}
