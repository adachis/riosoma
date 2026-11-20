import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { unavailable } from './envelope.js';
import { object, string, request, json, urlAt, tokenCache } from './http.js';
import type { ProfileOf } from './settings.js';
import type { CredentialVault } from './vault.js';

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw unavailable();
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) throw unavailable();
  return result;
}

export function encryptField(key: Buffer, value: string): string {
  if (key.length !== 64) throw unavailable();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key.subarray(0, 32), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const mac = createHmac('sha256', key.subarray(32)).update(iv).update(body).digest();
  return `2.${[iv, body, mac].map((part) => part.toString('base64')).join('|')}`;
}

export function decryptField(key: Buffer, value: string): string {
  try {
    if (key.length !== 64 || !value.startsWith('2.')) throw unavailable();
    const parts = value.slice(2).split('|');
    if (parts.length !== 3) throw unavailable();
    const [iv, body, mac] = parts.map(decode) as [Buffer, Buffer, Buffer];
    if (iv.length !== 16 || !body.length || body.length % 16 || mac.length !== 32) throw unavailable();
    const expected = createHmac('sha256', key.subarray(32)).update(iv).update(body).digest();
    if (!timingSafeEqual(mac, expected)) throw unavailable();
    const cipher = createDecipheriv('aes-256-cbc', key.subarray(0, 32), iv);
    return Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8');
  } catch {
    throw unavailable();
  }
}

export function bitwardenAdapter(profile: ProfileOf<'bitwarden'>): CredentialVault {
  let organizationKey: Buffer | undefined;
  const token = tokenCache(async () => {
    const match = /^0\.([0-9a-f-]{36})\.([^.:]+):([^:]+)$/i.exec(profile.accessToken);
    if (!match) throw unavailable();
    const seed = decode(match[3]!);
    if (seed.length !== 16) throw unavailable();
    const key = Buffer.from(hkdfSync('sha256', seed, 'bitwarden-accesstoken', 'sm-access-token', 64));
    seed.fill(0);
    try {
      const answer = await request(urlAt(profile.identityEndpoint, 'connect/token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'api.secrets',
          client_id: match[1]!,
          client_secret: match[2]!,
        }),
      });
      const payload = object(JSON.parse(decryptField(key, string(answer.encrypted_payload))));
      const next = decode(string(payload.encryptionKey));
      if (next.length !== 64) {
        next.fill(0);
        throw unavailable();
      }
      organizationKey?.fill(0);
      organizationKey = next;
      return { token: string(answer.access_token), seconds: Number(answer.expires_in) };
    } finally {
      key.fill(0);
    }
  });
  const headers = async () => ({ authorization: `Bearer ${await token()}` });
  return {
    async put(name, value) {
      const auth = await headers();
      const answer = await request(
        urlAt(profile.endpoint, `organizations/${encodeURIComponent(profile.organizationId)}/secrets`),
        json(
          'POST',
          {
            key: encryptField(organizationKey!, name),
            value: encryptField(organizationKey!, value),
            note: encryptField(organizationKey!, ''),
            projectIds: [profile.projectId],
          },
          auth,
        ),
      );
      return string(answer.id);
    },
    async get(ref) {
      const answer = await request(urlAt(profile.endpoint, `secrets/${encodeURIComponent(ref)}`), {
        headers: await headers(),
      });
      if (answer.organizationId !== profile.organizationId) throw unavailable();
      return decryptField(organizationKey!, string(answer.value));
    },
    async remove(ref) {
      await request(urlAt(profile.endpoint, 'secrets/delete'), json('POST', { ids: [ref] }, await headers()));
    },
  };
}
